// Construction du serveur Colyseus (partagée par l'exécutable et les tests).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker, type Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { CoopRoom } from './rooms/CoopRoom';

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
}

export interface RunningServer {
  server: Server;
  port: number;
  /** Arrêt propre sans quitter le processus. */
  stop(): Promise<void>;
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/** Corps refusé : réponse 413, puis connexion fermée sans lire la suite. */
function tooLarge(res: ServerResponse): void {
  res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
  res.end('request body too large');
}

/**
 * Borne les corps HTTP (matchmaking) : le framework les lit en entier, sans limite de taille.
 * Longueur annoncée au-delà de MAX_HTTP_BODY : 413 sans rien lire. Sans longueur annoncée (chunked) :
 * corps lu ici, au plus MAX_HTTP_BODY octets, puis transmis déjà lu (req.body), comme le fait
 * prereadRequestBodies de Colyseus. Les gestionnaires du framework passent derrière ce garde.
 */
function limitBodies(http: HttpServer): void {
  const listeners = http.listeners('request') as RequestListener[];
  const run: RequestListener = (req, res) => {
    for (const listener of listeners) listener.call(http, req, res);
  };
  http.removeAllListeners('request');
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
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

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const http = createServer();
  const transport = new WebSocketTransport({ server: http, maxPayload: MAX_PAYLOAD });
  const server = defineServer({
    transport,
    greet: opts.greet ?? false,
    gracefullyShutdown: opts.handleSignals ?? false,
    rooms: { coop: defineRoom(CoopRoom) },
    routes: createRouter({
      // Sonde de santé : nombre de salles et de joueurs de ce processus.
      health: createEndpoint('/health', { method: 'GET' }, async () => {
        const { roomCount, ccu } = matchMaker.stats.local;
        return new Response(JSON.stringify({ ok: true, rooms: roomCount, players: ccu }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    }),
  });
  await server.listen(opts.port);
  // Les routes sont branchées au démarrage de l'écoute : le garde se pose juste après, avant toute requête.
  limitBodies(http);
  const addr = http.address() as AddressInfo | null;
  const port = addr && typeof addr === 'object' ? addr.port : opts.port;
  return { server, port, stop: () => server.gracefullyShutdown(false) };
}
