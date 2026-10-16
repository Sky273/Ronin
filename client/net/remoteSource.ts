// Source de monde du mode en ligne : le serveur simule, le client envoie ses boutons à 60 Hz
// et applique les instantanés reçus (~20 Hz). M1 : ni prédiction ni interpolation fine.
import { NET_TICK, SNAP_EVERY, type SnapshotMsg, type WelcomeMsg } from '../../shared/net/protocol';
import { applySnapshot } from '../../shared/net/snapshot';
import type { GameEvent, World } from '../../shared/types';
import { createWorld } from '../../shared/world';
import type { WorldSource } from '../world/source';
import type { Transport } from './transport';

const INPUT_DT = 1 / NET_TICK;
/** Intervalle entre deux instantanés (ms). */
export const SNAP_INTERVAL_MS = (1000 * SNAP_EVERY) / NET_TICK;
/** Au plus autant d'entrées envoyées par image (retour d'onglet en arrière-plan : on ne rattrape pas). */
const MAX_INPUTS_PER_FRAME = 4;
/** Période des pings de mesure de latence (s). */
const PING_EVERY = 2;

export interface RemoteSourceOptions {
  /** Horloge en ms (injectable pour les tests). */
  now?: () => number;
}

export class RemoteSource implements WorldSource {
  readonly kind = 'online' as const;
  private w: World;
  private pid = -1;
  private welcomed = false;
  private queue: SnapshotMsg[] = [];
  private lastT = -1;
  private lastSnapAt = -Infinity;
  private snapsApplied = 0;
  private stageDirty = false;
  private acc = 0;
  private seq = 0;
  private pingT = 0;
  private disposed = false;
  private closeReason: string | null = null;
  private closeCbs: ((reason: string) => void)[] = [];
  private readyCbs: (() => void)[] = [];
  private lastAck = 0;
  private readonly now: () => number;

  constructor(private transport: Transport, opts: RemoteSourceOptions = {}) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // Monde provisoire jusqu'à l'accueil (lire `world` à chaque image : la référence change à l'accueil).
    this.w = createWorld(0, { mode: 'coop' });
    transport.onWelcome((m) => this.welcome(m));
    transport.onSnapshot((m) => this.receive(m));
    transport.onClose((reason) => {
      if (this.disposed || this.closeReason !== null) return;
      this.closeReason = reason;
      for (const cb of this.closeCbs) cb(reason);
    });
  }

  get world(): World {
    return this.w;
  }

  /** Id du joueur local (-1 avant l'accueil). */
  get meId(): number {
    return this.pid;
  }

  /** Accueil reçu et au moins un instantané appliqué : le monde est affichable. */
  get ready(): boolean {
    return this.welcomed && this.snapsApplied > 0;
  }

  /** Latence aller-retour lissée (ms, 0 tant qu'aucune mesure). */
  get rtt(): number {
    return this.transport.rtt;
  }

  /** Dernière séquence d'entrée traitée par le serveur. */
  get ack(): number {
    return this.lastAck;
  }

  /** Dernière séquence d'entrée envoyée. */
  get inputSeq(): number {
    return this.seq;
  }

  /** Raison de la perte de connexion (null tant que la connexion tient). */
  get closed(): string | null {
    return this.closeReason;
  }

  /** Connexion perdue ou refermée par le serveur (pas après `dispose()`). */
  onClose(cb: (reason: string) => void): void {
    this.closeCbs.push(cb);
    if (this.closeReason !== null) cb(this.closeReason);
  }

  /** Appelé une fois, au premier instantané appliqué (niveau de l'étape courante reconstruit). */
  onReady(cb: () => void): void {
    if (this.ready) cb();
    else this.readyCbs.push(cb);
  }

  /**
   * Le niveau a changé depuis le dernier appel (accueil ou nouvelle étape) :
   * la scène doit repeindre le terrain, la caméra et le fond. Remet le drapeau à zéro.
   */
  consumeStageChanged(): boolean {
    const d = this.stageDirty;
    this.stageDirty = false;
    return d;
  }

  /** Message d'accueil : crée le monde local à partir de la graine de la salle (public pour les tests). */
  welcome(msg: WelcomeMsg): void {
    if (this.welcomed || this.disposed) return;
    this.welcomed = true;
    this.pid = msg.pid;
    this.w = createWorld(msg.seed, { mode: 'coop' });
    this.w.tick = msg.tick;
    this.stageDirty = true;
    this.transport.ping();
  }

  /** Instantané reçu : mis en file, appliqué au prochain `advance` (public pour les tests). */
  receive(msg: SnapshotMsg): void {
    if (!this.welcomed || this.disposed) return; // avant l'accueil, rien à quoi l'appliquer
    this.queue.push(msg);
  }

  advance(dt: number, sample: () => number, beforeStep: () => void): GameEvent[] {
    const events: GameEvent[] = [];
    if (!this.welcomed || this.disposed || this.closeReason !== null) return events;

    // Entrées à cadence fixe (60 Hz), séquence strictement croissante.
    this.acc += Math.max(0, dt);
    let sent = 0;
    while (this.acc >= INPUT_DT) {
      this.acc -= INPUT_DT;
      if (sent < MAX_INPUTS_PER_FRAME) {
        this.transport.sendInput({ s: ++this.seq, b: sample() });
        sent++;
      }
    }
    if (sent >= MAX_INPUTS_PER_FRAME) this.acc = Math.min(this.acc, INPUT_DT);

    // Mesure périodique de la latence.
    this.pingT += dt;
    if (this.pingT >= PING_EVERY) {
      this.pingT = 0;
      this.transport.ping();
    }

    // Instantanés arrivés depuis la dernière image, dans l'ordre (doublons et retardataires ignorés).
    const queued = this.queue;
    this.queue = [];
    const wasReady = this.ready;
    for (const snap of queued) {
      if (snap.t <= this.lastT) continue;
      this.lastT = snap.t;
      beforeStep();
      const r = applySnapshot(this.w, snap);
      if (r.stageChanged) this.stageDirty = true;
      this.lastAck = snap.ack;
      this.lastSnapAt = this.now();
      this.snapsApplied++;
      for (const ev of snap.events) events.push(ev);
    }
    if (!wasReady && this.ready) {
      const cbs = this.readyCbs;
      this.readyCbs = [];
      for (const cb of cbs) cb();
    }
    return events;
  }

  /** Interpolation naïve : fraction de l'intervalle entre instantanés écoulée depuis le dernier (0..1). */
  alpha(): number {
    const a = (this.now() - this.lastSnapAt) / SNAP_INTERVAL_MS;
    return a >= 1 || !Number.isFinite(a) ? 1 : a <= 0 ? 0 : a;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.closeCbs = [];
    this.readyCbs = [];
    this.transport.leave();
  }
}
