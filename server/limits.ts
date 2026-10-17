// Limites par adresse IP et contrôle d'origine (M6, mise en ligne derrière Traefik / Coolify).
// Module pur, sans état global : app.ts crée les instances et les branche sur POST /matchmake/* et sur
// les écouteurs 'upgrade' du WebSocket. Valeurs nulles ou vides (NO_GUARD) : aucun contrôle.
import type { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { cleanOrigin } from './config';

/** Ce que l'on lit d'une requête HTTP (IncomingMessage, ou un objet de test). */
export interface ReqLike {
  socket: { remoteAddress?: string; encrypted?: boolean };
  headers: IncomingHttpHeaders;
}

/** Adresse normalisée : minuscules, sans crochets, IPv4 mappée (::ffff:a.b.c.d) ramenée à l'IPv4. */
function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  return mapped ? mapped[1] : ip;
}

/**
 * Pair de confiance : boucle locale, réseaux privés RFC 1918, 100.64.0.0/10, ULA fc00::/7, lien local fe80::/10.
 * 100.64/10 (espace partagé CGNAT, RFC 6598) n'est jamais routé sur Internet : certains réseaux superposés
 * (Docker Swarm, Tailscale, hébergeurs) l'emploient en interne entre le proxy et le conteneur. Un pair dans ces
 * plages ne peut être que le proxy de Coolify ou une machine locale, jamais un client direct venu d'Internet.
 */
function isTrustedPeer(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (ip === '::1') return true;
  // fc00::/7 : fc.. et fd.. ; fe80::/10 : fe8., fe9., fea., feb.
  return /^f[cd][0-9a-f]{0,2}:/.test(ip) || /^fe[89ab][0-9a-f]?:/.test(ip);
}

/** Valeur d'en-tête jointe (les en-têtes répétés arrivent en tableau, ou déjà joints par Node). */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(',') : v;
}

/** Pair TCP normalisé, et s'il est de confiance (proxy local) quand trustProxy > 0. */
function peerOf(req: ReqLike, trustProxy: number): { peer: string; trusted: boolean } {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  return { peer, trusted: trustProxy > 0 && isTrustedPeer(peer) };
}

/**
 * Adresse du client. Contrairement à resolveClientIp de Colyseus (premier élément, falsifiable : le client écrit
 * ce qu'il veut en tête de X-Forwarded-For), on prend l'élément situé à `trustProxy` positions de la fin : celui
 * ajouté par le proxy de confiance le plus éloigné, et seulement si le pair TCP est privé ou local.
 * Chaîne plus courte que prévu (élément manquant) : tous les éléments présents viennent alors de nos proxys
 * (un client ne peut qu'ajouter à gauche), le plus à gauche est donc le plus proche du vrai client.
 * Élément vide (chaîne mal formée) : on garde le pair, choix prudent (tous ces clients partagent le seau du
 * proxy, plus strict) qui ne permet pas de contourner les limites.
 */
export function clientIp(req: ReqLike, trustProxy: number): string {
  const { peer, trusted } = peerOf(req, trustProxy);
  if (!trusted) return peer;
  const xff = headerValue(req.headers['x-forwarded-for']);
  if (xff === undefined || xff.trim() === '') return peer;
  const parts = xff.split(',').map((s) => s.trim());
  const idx = parts.length - trustProxy;
  const pick = idx >= 0 ? parts[idx] : parts.find((s) => s !== '');
  return pick ? normalizeIp(pick) : peer;
}

/** Connexion chiffrée : socket TLS, ou X-Forwarded-Proto « https » posé par un proxy de confiance. */
export function isSecure(req: ReqLike, trustProxy: number): boolean {
  if (req.socket.encrypted) return true;
  if (!peerOf(req, trustProxy).trusted) return false;
  const proto = headerValue(req.headers['x-forwarded-proto']);
  // Plusieurs proxys : le dernier élément est celui du proxy le plus proche (le nôtre).
  return proto !== undefined && proto.split(',').pop()!.trim().toLowerCase() === 'https';
}

/** Origine permise : liste vide (aucun contrôle) ou Origin absent (bots, curl : pas de navigateur à protéger). */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0 || origin === undefined) return true;
  const o = cleanOrigin(origin);
  return allowed.some((a) => cleanOrigin(a) === o);
}

/** Plafond de clés suivies (mémoire bornée même sous une avalanche d'adresses différentes). */
export const MAX_KEYS = 10_000;
/** Après éviction forcée, on redescend à 90 % du plafond (coût amorti, pas un balayage par requête). */
const EVICT_TO = Math.floor(MAX_KEYS * 0.9);
/** Balayage paresseux des seaux pleins au plus une fois par minute. */
const SWEEP_MS = 60_000;

interface Bucket {
  tokens: number;
  /** Instant de la dernière mise à jour (ms). */
  t: number;
}

/**
 * Seaux à jetons par clé (adresse IP) : `burst` jetons au départ, rechargés à `perMin` par minute.
 * Un seau plein équivaut à une clé inconnue : il est oublié au balayage. Au plafond de MAX_KEYS, balayage forcé
 * puis éviction des seaux les moins récemment servis (ordre d'insertion de la Map, rafraîchi à chaque prise) :
 * une clé évincée retrouve une rafale complète, prix acceptable pour une mémoire bornée.
 */
export class RateBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly cap: number;
  /** Jetons par milliseconde. */
  private readonly rate: number;
  private lastSweep: number;

  constructor(
    private readonly perMin: number,
    burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.cap = Math.max(1, burst);
    this.rate = perMin / 60_000;
    this.lastSweep = now();
  }

  /** Nombre de clés suivies (tests, supervision). */
  get size(): number {
    return this.buckets.size;
  }

  /** Prend un jeton : 0 si permis, sinon les secondes (≥ 1, arrondies au-dessus) avant le prochain jeton. */
  take(key: string): number {
    if (this.perMin <= 0) return 0;
    const t = this.now();
    if (t - this.lastSweep >= SWEEP_MS) this.sweep(t);
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.cap, b.tokens + (t - b.t) * this.rate);
      b.t = t;
      this.buckets.delete(key); // réinsertion : la Map reste triée du moins au plus récemment servi
    } else {
      if (this.buckets.size >= MAX_KEYS) this.makeRoom(t);
      b = { tokens: this.cap, t };
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    // Tolérance d'une microseconde : 6,0000000001 s (erreur flottante) doit donner 6, pas 7.
    return Math.max(1, Math.ceil((1 - b.tokens) / this.rate / 1000 - 1e-6));
  }

  /** Oublie les seaux redevenus pleins (identiques à une clé neuve). */
  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (b.tokens + (t - b.t) * this.rate >= this.cap) this.buckets.delete(k);
  }

  /** Plafond atteint : balayage forcé, puis éviction des plus anciens jusqu'à 90 % du plafond si besoin. */
  private makeRoom(t: number): void {
    this.sweep(t);
    if (this.buckets.size < MAX_KEYS) return;
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= EVICT_TO) break;
      this.buckets.delete(k);
    }
  }
}

/**
 * Connexions simultanées par clé (WebSocket par IP). La place est rendue à la fermeture du socket
 * ('close', émis aussi après une erreur), une seule fois. Aucune clé ne reste à 0 : mémoire proportionnelle
 * aux connexions ouvertes. max 0 : illimité, rien n'est suivi.
 */
export class ConnCounter {
  private readonly open = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Réserve une place pour `key` ; false si la limite est atteinte (le socket est alors à refuser). */
  tryOpen(key: string, socket: EventEmitter): boolean {
    if (this.max <= 0) return true;
    const n = this.open.get(key) ?? 0;
    if (n >= this.max) return false;
    this.open.set(key, n + 1);
    let released = false;
    // Pas d'écouteur 'error' : il masquerait les erreurs du socket ; Node émet 'close' après 'error'.
    socket.once('close', () => {
      if (released) return;
      released = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left > 0) this.open.set(key, left);
      else this.open.delete(key);
    });
    return true;
  }

  /** Connexions ouvertes pour `key`. */
  count(key: string): number {
    return this.open.get(key) ?? 0;
  }

  /** Nombre de clés suivies (tests). */
  get size(): number {
    return this.open.size;
  }
}

export type RefusalKind = 'rate' | 'origin' | 'conn' | 'method';

const KIND_LABEL: Record<RefusalKind, string> = { rate: 'débit', origin: 'origine', conn: 'connexions', method: 'méthode' };
const LOG_WINDOW_MS = 60_000;

/**
 * Journal agrégé des refus : au plus une ligne par minute, avec des compteurs seulement (aucune adresse IP,
 * RGPD). La fenêtre s'ouvre au premier refus ; elle est écrite au premier refus ou au premier `tick()` survenant
 * 60 s plus tard. app.ts appelle `tick()` sur une minuterie (unref) pour qu'une rafale isolée soit tout de même écrite.
 */
export class RefusalLog {
  private counts: Record<RefusalKind, number> = { rate: 0, origin: 0, conn: 0, method: 0 };
  /** Début de la fenêtre en cours, ou -1 si aucun refus en attente. */
  private start = -1;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly out: (line: string) => void = (line) => console.log(line),
  ) {}

  note(kind: RefusalKind): void {
    const t = this.now();
    this.tick(t);
    if (this.start < 0) this.start = t;
    this.counts[kind]++;
  }

  /** Écrit la fenêtre en cours si elle a 60 s ou plus. */
  tick(t: number = this.now()): void {
    if (this.start < 0 || t - this.start < LOG_WINDOW_MS) return;
    const c = this.counts;
    const parts = (Object.keys(KIND_LABEL) as RefusalKind[]).map((k) => `${KIND_LABEL[k]} ${c[k]}`);
    this.out(`[serveur] refus en ${LOG_WINDOW_MS / 1000} s : ${parts.join(', ')}`);
    this.counts = { rate: 0, origin: 0, conn: 0, method: 0 };
    this.start = -1;
  }
}
