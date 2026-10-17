// Construction du serveur Colyseus (partagée par l'exécutable et les tests).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker, type Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOMS } from '../shared/net/protocol';
import { NO_GUARD, type GuardOptions } from './config';
import { clientIp, ConnCounter, isSecure, originAllowed, RateBuckets, RefusalLog } from './limits';
import { loadStatic, serveStatic, type StaticSite } from './static';
import { CoopRoom } from './rooms/CoopRoom';
import { DojoRoom } from './rooms/DojoRoom';

/** Taille maximale d'un message client (octets) : les entrées font une dizaine d'octets. */
export const MAX_PAYLOAD = 4096;
/** Taille maximale d'un corps HTTP (octets) : les options d'arrivée du matchmaking tiennent en une centaine d'octets. */
export const MAX_HTTP_BODY = 8 * 1024;

export interface StartOptions {
  /** Port d'écoute ; 0 pour un port libre choisi par le système. */
  port: number;
  /** Arrêt propre sur SIGINT/SIGTERM (et sortie du processus). */
  handleSignals?: boolean;
  /** Bannière Colyseus au démarrage. */
  greet?: boolean;
  /** Dossier du client construit (dist/) servi par le serveur (production) ; absent : aucun fichier statique. */
  staticDir?: string;
  /** Durcissement pour Internet (limites par IP, origines) ; absent : aucun contrôle. */
  guard?: GuardOptions;
  /** Méthodes de matchmaking permises (production : joinOrCreate) ; absent : toutes. */
  matchmakeMethods?: string[];
}

export interface RunningServer {
  server: Server;
  port: number;
  /** Fichiers du jeu servis (production), sinon null. */
  site: StaticSite | null;
  /** Arrêt propre sans quitter le processus. */
  stop(): Promise<void>;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
type UpgradeListener = (req: IncomingMessage, socket: Socket, head: Buffer) => void;

/** Ce que les gardes partagent : fichiers du jeu, limites, journal des refus. */
interface GuardContext {
  site: StaticSite | null;
  guard: GuardOptions;
  methods: Set<string> | null;
  rate: RateBuckets;
  conns: ConnCounter;
  refusals: RefusalLog;
}

/** Refus du matchmaking en JSON (le SDK affiche `error`). */
function refuse(res: ServerResponse, status: number, error: string, retryAfter = 0): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) });
  res.end(JSON.stringify({ error }));
}

/** Le chemin de la requête est-il déjà sous sa forme normalisée (celle que verra le framework) ? */
function normalized(url: string | undefined): boolean {
  const raw = (url ?? '/').split(/[?#]/)[0];
  try {
    return new URL(url ?? '/', 'http://x').pathname === raw;
  } catch {
    return false;
  }
}

/** Méthode d'un chemin de matchmaking (`/matchmake/joinOrCreate/coop` → joinOrCreate), sinon null. */
function matchmakeMethod(url: string | undefined): string | null {
  const m = /^\/matchmake\/([^/?#]+)/.exec(url ?? '');
  return m ? m[1] : null;
}

/** Corps refusé : réponse 413, puis connexion fermée sans lire la suite. */
function tooLarge(res: ServerResponse): void {
  res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
  res.end('request body too large');
}

/** Requête refusée avant le framework : réponse 400, puis connexion fermée sans lire la suite. */
function badRequest(res: ServerResponse): void {
  res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
  res.end('bad request');
}

/**
 * Le framework saura-t-il reconstruire la requête ? Il la recrée en Request fetch (better-call, toNodeHandler :
 * `${x-forwarded-proto || 'http'}://${host}${url}`) dans une promesse qu'il ne rattrape pas : un Host ou un
 * X-Forwarded-Proto qui ne forment pas une URL, des identifiants dans Host ou une méthode interdite (TRACE)
 * y lèveraient une erreur qui arrête tout le processus. Même construction ici, sans le corps.
 */
function rebuildable(req: IncomingMessage): boolean {
  const h = req.headers;
  try {
    new Request(`${h['x-forwarded-proto'] || 'http'}://${h[':authority'] || h.host}${req.url}`, { method: req.method, headers: h as Record<string, string> });
    return true;
  } catch {
    return false;
  }
}

/**
 * Borne les corps HTTP (matchmaking) : le framework les lit en entier, sans limite de taille.
 * Longueur annoncée au-delà de MAX_HTTP_BODY : 413 sans rien lire. Sans longueur annoncée (chunked) :
 * corps lu ici, au plus MAX_HTTP_BODY octets, puis transmis déjà lu (req.body), comme le fait
 * prereadRequestBodies de Colyseus. Les gestionnaires du framework passent derrière ce garde,
 * qui refuse aussi (400) les requêtes que le framework ne saurait pas reconstruire.
 */
function guardHttp(http: HttpServer, ctx: GuardContext): void {
  const listeners = http.listeners('request') as RequestListener[];
  const run: RequestListener = (req, res) => {
    for (const listener of listeners) listener.call(http, req, res);
  };
  const g = ctx.guard;
  http.removeAllListeners('request');
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Chemin non normalisé (« .. », « . », %2e%2e) : refusé. Le framework reconstruit la requête par l'analyseur
    // d'URL, qui normalise : sans ce refus, /x/../matchmake/create/… échapperait aux gardes ci-dessous.
    if (!rebuildable(req) || !normalized(req.url)) {
      badRequest(res);
      return;
    }
    res.setHeader('x-content-type-options', 'nosniff');
    // Fichiers du jeu (production) : servis depuis la mémoire, avant le framework (qui répondrait 404).
    if (ctx.site && serveStatic(ctx.site, req, res, isSecure(req, g.trustProxy))) return;
    const method = matchmakeMethod(req.url);
    // Préflight CORS (OPTIONS) : contrôle d'origine seulement, sans consommer de jeton.
    if (method !== null && req.method === 'OPTIONS' && !originAllowed(req.headers.origin, g.allowedOrigins)) {
      ctx.refusals.note('origin');
      refuse(res, 403, 'origin not allowed');
      return;
    }
    // Seul un POST réserve une place : un GET (ex. une image d'une page tierce, sans Origin) ne consomme rien.
    if (method !== null && req.method === 'POST') {
      if (ctx.methods && !ctx.methods.has(method)) {
        ctx.refusals.note('method');
        refuse(res, 404, 'not found');
        return;
      }
      if (!originAllowed(req.headers.origin, g.allowedOrigins)) {
        ctx.refusals.note('origin');
        refuse(res, 403, 'origin not allowed');
        return;
      }
      const ip = clientIp(req, g.trustProxy);
      const wait = g.maxConnPerIp && ctx.conns.count(ip) >= g.maxConnPerIp ? 5 : ctx.rate.take(ip);
      if (wait > 0) {
        ctx.refusals.note('rate');
        refuse(res, 429, 'too many requests from your network, try again shortly', wait);
        return;
      }
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined || req.headers['transfer-encoding'] === undefined) {
      if (Number(declared) > MAX_HTTP_BODY) tooLarge(res);
      else run(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size > MAX_HTTP_BODY) return; // déjà refusé : la suite est ignorée jusqu'à la fermeture
      size += chunk.length;
      if (size <= MAX_HTTP_BODY) chunks.push(chunk);
      else {
        chunks.length = 0;
        tooLarge(res);
      }
    });
    req.on('end', () => {
      if (size > MAX_HTTP_BODY) return;
      (req as IncomingMessage & { body?: string }).body = Buffer.concat(chunks).toString('utf8');
      run(req, res);
    });
  });
}

/**
 * WebSocket : même contrôle d'origine, et au plus maxConnPerIp connexions simultanées par IP (pair TCP, ou adresse
 * ajoutée par le proxy de confiance). Refus : réponse HTTP brute, puis socket fermé (le transport ne le voit pas).
 */
function guardUpgrades(http: HttpServer, ctx: GuardContext): void {
  const listeners = http.listeners('upgrade') as UpgradeListener[];
  const g = ctx.guard;
  http.removeAllListeners('upgrade');
  http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const deny = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!originAllowed(req.headers.origin, g.allowedOrigins)) {
      ctx.refusals.note('origin');
      deny('403 Forbidden');
      return;
    }
    if (!ctx.conns.tryOpen(clientIp(req, g.trustProxy), socket)) {
      ctx.refusals.note('conn');
      deny('429 Too Many Requests');
      return;
    }
    for (const listener of listeners) listener.call(http, req, socket, head);
  });
}

/** Origines WebSocket ajoutées au connect-src de la CSP (https → wss), d'après les origines autorisées. */
function wsOrigins(allowed: string[]): string[] {
  return allowed.map((o) => o.replace(/^http/, 'ws'));
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const guard = opts.guard ?? NO_GUARD;
  // Fichiers du jeu chargés avant l'écoute : un dossier sans index.html arrête le démarrage (image mal construite).
  const site = opts.staticDir ? loadStatic(opts.staticDir, { connectSrc: wsOrigins(guard.allowedOrigins) }) : null;
  const http = createServer();
  // Derrière le proxy (Traefik garde ses connexions vers le serveur jusqu'à 90 s) : délais plus longs que les siens,
  // sinon des 502 sporadiques. Sans proxy de confiance, délais de Node (anti-slowloris).
  if (guard.trustProxy > 0) {
    http.keepAliveTimeout = 95_000;
    http.headersTimeout = 100_000;
  }
  const transport = new WebSocketTransport({ server: http, maxPayload: MAX_PAYLOAD });
  const server = defineServer({
    transport,
    greet: opts.greet ?? false,
    gracefullyShutdown: opts.handleSignals ?? false,
    // Plafond MAX_ROOMS commun aux deux types (onCreate compte toutes les salles du processus) : il borne la charge
    // du processus (une boucle à 60 Hz par salle, quel qu'en soit le type) ; un plafond par type la doublerait.
    rooms: { [ROOMS.coop]: defineRoom(CoopRoom), [ROOMS.dojo]: defineRoom(DojoRoom) },
    routes: createRouter({
      // Sonde de santé : nombre de salles et de joueurs de ce processus.
      health: createEndpoint('/health', { method: 'GET' }, async () => {
        const { roomCount, ccu } = matchMaker.stats.local;
        // Pendant l'arrêt (redéploiement) : 503, le proxy cesse d'envoyer des joueurs ici.
        const ok = matchMaker.state !== matchMaker.MatchMakerState.SHUTTING_DOWN;
        return new Response(JSON.stringify({ ok, rooms: roomCount, players: ccu }), {
          status: ok ? 200 : 503,
          headers: { 'content-type': 'application/json' },
        });
      }),
    }),
  });
  await server.listen(opts.port);
  // Les routes sont branchées au démarrage de l'écoute : les gardes se posent juste après, avant toute requête.
  const refusals = new RefusalLog();
  const ctx: GuardContext = {
    site,
    guard,
    methods: opts.matchmakeMethods ? new Set(opts.matchmakeMethods) : null,
    rate: new RateBuckets(guard.matchmakePerMin, guard.matchmakeBurst),
    conns: new ConnCounter(guard.maxConnPerIp),
    refusals,
  };
  guardHttp(http, ctx);
  guardUpgrades(http, ctx);
  const flush = setInterval(() => refusals.tick(), 60_000);
  flush.unref();
  http.once('close', () => clearInterval(flush));
  const addr = http.address() as AddressInfo | null;
  const port = addr && typeof addr === 'object' ? addr.port : opts.port;
  return { server, port, site, stop: () => server.gracefullyShutdown(false) };
}
