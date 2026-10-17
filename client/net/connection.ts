// Enveloppe du SDK Colyseus : SEUL fichier du client qui dépend du framework réseau.
// Aucune logique de jeu ici. La scène charge ce module par import() dynamique (le solo ne le télécharge pas).
import { Client, MatchMakeError, ServerError, type Room } from '@colyseus/sdk';
import type { SnapshotWire } from '../../shared/net/codec';
import { AWAY_CLOSE_CODE, MSG, PROTOCOL_VERSION, ROOMS, type InputMsg, type RoomName, type WelcomeMsg } from '../../shared/net/protocol';
import type { Transport } from './transport';

/** Nom de la salle coopérative côté serveur. */
/** Salle rejointe par défaut (la route partagée). */
export const ROOM_NAME = ROOMS.coop;
/** Au-delà, la connexion est abandonnée (serveur injoignable ou qui ne répond pas). */
const CONNECT_TIMEOUT_MS = 8000;
/** Lissage exponentiel de la latence mesurée. */
const RTT_SMOOTH = 0.2;
/** Instantanés gardés en attente tant que personne n'est abonné (évite d'en perdre entre `connect` et `onSnapshot`). */
const MAX_PENDING_SNAPS = 8;

export const UNREACHABLE = 'Server unreachable — is it running?';

/** Adresse du serveur : variable d'environnement Vite, sinon serveur local de développement. */
export function defaultServerUrl(): string {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  return env && env.trim() ? env.trim() : 'ws://localhost:2567';
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Message lisible pour une fermeture de salle (codes de fermeture Colyseus / WebSocket). */
function closeReason(code: number, reason?: string): string {
  if (code === 4001) return 'The server is shutting down.';
  if (code === AWAY_CLOSE_CODE) return 'You were away too long — the road went on without you.';
  if (code === 4002) return reason ? `Disconnected: ${reason}` : 'Disconnected after a server error.';
  if (code === 1000 || code === 4000) return reason || 'The room was closed.';
  return reason ? `Connection lost: ${reason}` : 'Connection lost.';
}

/** Connexion à une salle coopérative. */
export class Connection implements Transport {
  private welcomeCb: ((msg: WelcomeMsg) => void) | null = null;
  private snapCb: ((msg: SnapshotWire) => void) | null = null;
  private closeCb: ((reason: string) => void) | null = null;
  private pendingWelcome: WelcomeMsg | null = null;
  private pendingSnaps: SnapshotWire[] = [];
  private pendingClose: string | null = null;
  private left = false;
  private smoothRtt = 0;

  constructor(private room: Room) {
    // Abonnements immédiats : le serveur envoie l'accueil dès l'arrivée, avant que l'appelant ne s'abonne.
    room.onMessage(MSG.welcome, (msg: WelcomeMsg) => {
      // Client et serveur de versions différentes : les instantanés seraient illisibles.
      if (msg?.v !== PROTOCOL_VERSION) {
        this.closed(`Version mismatch (server ${msg?.v ?? 1}, game ${PROTOCOL_VERSION}) — please reload the page.`);
        this.left = true;
        this.room.leave(true).catch(() => undefined);
        return;
      }
      if (this.welcomeCb) this.welcomeCb(msg);
      else this.pendingWelcome = msg;
    });
    room.onMessage(MSG.snap, (msg: SnapshotWire) => {
      if (this.left) return;
      if (this.snapCb) this.snapCb(msg);
      else {
        this.pendingSnaps.push(msg);
        if (this.pendingSnaps.length > MAX_PENDING_SNAPS) this.pendingSnaps.shift();
      }
    });
    room.onMessage(MSG.ping, (msg: { t: number }) => {
      if (!msg || typeof msg.t !== 'number') return;
      const sample = Math.max(0, now() - msg.t);
      this.smoothRtt = this.smoothRtt === 0 ? sample : this.smoothRtt + (sample - this.smoothRtt) * RTT_SMOOTH;
    });
    room.onLeave((code: number, reason?: string) => this.closed(closeReason(code, reason)));
    room.onError((code: number, message?: string) => console.warn(`[net] room error ${code}: ${message ?? ''}`));
  }

  /** Identifiant de session attribué par le serveur. */
  get sessionId(): string {
    return this.room.sessionId;
  }

  get rtt(): number {
    return this.smoothRtt;
  }

  onWelcome(cb: (msg: WelcomeMsg) => void): void {
    this.welcomeCb = cb;
    const w = this.pendingWelcome;
    this.pendingWelcome = null;
    if (w) cb(w);
  }

  onSnapshot(cb: (msg: SnapshotWire) => void): void {
    this.snapCb = cb;
    const queued = this.pendingSnaps;
    this.pendingSnaps = [];
    for (const s of queued) cb(s);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb;
    const r = this.pendingClose;
    this.pendingClose = null;
    if (r !== null) cb(r);
  }

  sendInput(msg: InputMsg): void {
    if (!this.left) this.room.send(MSG.input, msg);
  }

  ping(): void {
    if (!this.left) this.room.send(MSG.ping, { t: now() });
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    this.room.leave(true).catch(() => undefined);
  }

  private closed(reason: string): void {
    if (this.left) return; // départ volontaire : rien à signaler
    this.left = true;
    if (this.closeCb) this.closeCb(reason);
    else this.pendingClose = reason;
  }
}

/**
 * Rejoint (ou crée) une salle coopérative. Rejette avec une erreur au message lisible
 * (affichable tel quel dans le menu en ligne).
 */
export async function connect(url: string, name: string, room: RoomName = ROOM_NAME): Promise<Connection> {
  const client = new Client(url);
  let timedOut = false;
  const join = client.joinOrCreate(room, { name });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(UNREACHABLE));
    }, CONNECT_TIMEOUT_MS);
  });
  // Si la salle répond après l'abandon, on la quitte aussitôt.
  join.then((room) => (timedOut ? room.leave(true).catch(() => undefined) : undefined)).catch(() => undefined);
  try {
    const room = await Promise.race([join, timeout]);
    // M1 : pas de reprise de session côté serveur ; une coupure doit être signalée tout de suite.
    room.reconnection.enabled = false;
    return new Connection(room);
  } catch (e) {
    if (e instanceof MatchMakeError || e instanceof ServerError) throw new Error(`The server refused to seat you: ${e.message}`);
    if (e instanceof Error && e.message === UNREACHABLE) throw e;
    throw new Error(UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}
