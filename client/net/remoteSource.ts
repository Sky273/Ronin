// Source de monde du mode en ligne : le serveur simule ; le client envoie ses boutons à 60 Hz,
// prédit son propre joueur (Predictor) et affiche les autres entités avec un léger recul (Interpolator).
// Le monde exposé à la scène est un « monde d'affichage » reconstruit à chaque image.
import { decodeSnapshot, type SnapshotWire } from '../../shared/net/codec';
import { NET_TICK, SNAP_EVERY, type Snapshot, type WelcomeMsg } from '../../shared/net/protocol';
import { applySnapshot } from '../../shared/net/snapshot';
import type { GameEvent, World } from '../../shared/types';
import { createWorld } from '../../shared/world';
import type { WorldSource } from '../world/source';
import { EventGate } from './eventGate';
import { Interpolator } from './interpolator';
import { type PredictionContext, Predictor } from './predictor';
import type { Transport } from './transport';

const INPUT_DT = 1 / NET_TICK;
/** Intervalle entre deux instantanés (ms). */
export const SNAP_INTERVAL_MS = (1000 * SNAP_EVERY) / NET_TICK;
/** Au plus autant d'entrées envoyées par image (retour d'onglet en arrière-plan : on ne rattrape pas). */
const MAX_INPUTS_PER_FRAME = 4;
/** Période des pings de mesure de latence (s). */
const PING_EVERY = 2;
/** File d'instantanés en attente (onglet en arrière-plan : la scène ne tourne plus). */
const MAX_QUEUED = 20;
/** Événements conservés des instantanés abandonnés. */
const MAX_CARRIED_EVENTS = 200;
/** Durée (ticks) du clignotement immédiat d'un ennemi touché par un coup prédit. */
const PREDICTED_FLASH_TICKS = 5;

export interface RemoteSourceOptions {
  /** Horloge en ms (injectable pour les tests). */
  now?: () => number;
}

export class RemoteSource implements WorldSource {
  readonly kind = 'online' as const;
  private w: World;
  private pid = -1;
  private welcomed = false;
  /** Instantanés reçus, avec leur heure de réception (horloge du serveur estimée). */
  private queue: { snap: Snapshot; at: number }[] = [];
  private lastT = -1;
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
  private ctx: PredictionContext | null = null;
  /** Ennemis touchés par un coup prédit : id → tick de fin du clignotement. */
  private flashUntil = new Map<number, number>();
  /** Dernier tick affiché : le monde d'affichage ne recule jamais (pending vidé, changement d'étape). */
  private shownTick = 0;
  private readonly now: () => number;
  /** Prédiction du joueur local (créée à l'accueil, quand son id est connu). */
  predictor: Predictor = new Predictor(-1);
  /** Interpolation des entités distantes. */
  readonly interp: Interpolator;
  /** Aiguillage des événements (doublons prédits, effets différés). */
  gate = new EventGate(-1);

  constructor(private transport: Transport, opts: RemoteSourceOptions = {}) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.interp = new Interpolator(this.now);
    // Monde provisoire jusqu'à l'accueil (lire `world` à chaque image : la référence change à l'accueil).
    this.w = createWorld(0, { mode: 'coop' });
    transport.onWelcome((m) => this.welcome(m));
    transport.onSnapshot((m) => this.receive(m));
    transport.onClose((reason) => this.fail(reason));
  }

  /** Connexion perdue ou inutilisable : signalée une seule fois. */
  private fail(reason: string): void {
    if (this.disposed || this.closeReason !== null) return;
    this.closeReason = reason;
    for (const cb of this.closeCbs) cb(reason);
  }

  /** Monde d'affichage : joueur local prédit, autres entités interpolées. */
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
    this.predictor = new Predictor(msg.pid);
    this.gate = new EventGate(msg.pid);
    this.stageDirty = true;
    this.transport.ping();
  }

  /** Instantané reçu (forme filaire) : décodé et mis en file, appliqué au prochain `advance` (public pour les tests). */
  receive(wire: SnapshotWire): void {
    if (!this.welcomed || this.disposed) return; // avant l'accueil, rien à quoi l'appliquer
    let msg: Snapshot;
    try {
      msg = decodeSnapshot(wire);
    } catch {
      // Instantané illisible (serveur incompatible ou défaillant) : on ferme proprement.
      this.fail('The server sent data this game cannot read — please reload the page.');
      return;
    }
    // Doublon ou retardataire : ignoré dès la réception, pour que la file reste strictement
    // croissante (sinon des événements reportés sur lui seraient écartés avec lui).
    const newest = this.queue.length ? this.queue[this.queue.length - 1].snap.t : this.lastT;
    if (msg.t <= newest) return;
    this.queue.push({ snap: msg, at: this.now() });
    if (this.queue.length > MAX_QUEUED) {
      // Seul l'état le plus récent compte ; les événements des instantanés abandonnés sont reportés (bornés).
      const dropped = this.queue.shift()!.snap;
      const next = this.queue[0].snap;
      next.events = dropped.events.concat(next.events).slice(-MAX_CARRIED_EVENTS);
    }
  }

  advance(dt: number, sample: () => number, _beforeStep: () => void): GameEvent[] {
    const events: GameEvent[] = [];
    if (!this.welcomed || this.disposed || this.closeReason !== null) return events;
    const now = this.now();

    // Entrées à cadence fixe (60 Hz), séquence strictement croissante, avec le tick de vue.
    this.acc += Math.max(0, dt);
    let sent = 0;
    while (this.acc >= INPUT_DT) {
      this.acc -= INPUT_DT;
      if (sent < MAX_INPUTS_PER_FRAME) {
        const b = sample();
        const v = Math.max(0, Math.floor(this.interp.renderTick(now)));
        const s = ++this.seq;
        this.transport.sendInput({ s, b, v });
        // Avant le premier instantané, le prédicteur se contente de mémoriser l'entrée (rejouée ensuite).
        const ctx = this.ctx ?? { level: this.w.level, stage: this.w.stage, wave: this.w.wave, shrine: this.w.shrine, serverTick: this.w.tick };
        const tick = this.predictor.tick;
        for (const ev of this.gate.predicted(this.predictor.step(s, b, v, this.interp.enemiesAt(v), ctx), tick)) {
          events.push(ev);
          if (ev.type === 'hit') this.flashUntil.set(ev.targetId, tick + PREDICTED_FLASH_TICKS);
        }
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

    // Instantanés arrivés depuis la dernière image, dans l'ordre.
    const queued = this.queue;
    this.queue = [];
    const wasReady = this.ready;
    for (const { snap, at } of queued) {
      this.lastT = snap.t;
      // Le niveau, l'étape et la barrière suivent le serveur (les entités sont remplacées plus bas).
      if (applySnapshot(this.w, snap).stageChanged) this.stageDirty = true;
      this.ctx = { level: this.w.level, stage: snap.stageInfo, wave: snap.wave, shrine: snap.shrine, serverTick: snap.t };
      this.interp.push(snap, at);
      this.predictor.reconcile(snap.self, snap.ack, this.ctx, (v) => this.interp.enemiesAt(v));
      this.lastAck = snap.ack;
      this.snapsApplied++;
      for (const ev of this.gate.server(snap.events, snap.t)) events.push(ev);
    }

    // Monde d'affichage : soi prédit, les autres au tick de rendu.
    if (this.snapsApplied > 0) {
      this.compose(now, dt);
      // Effets situés dans le monde : quand leurs entités sont affichées.
      for (const ev of this.gate.release(this.interp.renderTick(now))) events.push(ev);
    }
    if (!wasReady && this.ready) {
      const cbs = this.readyCbs;
      this.readyCbs = [];
      for (const cb of cbs) cb();
    }
    return events;
  }

  /** Recompose les entités du monde d'affichage. */
  private compose(now: number, dt: number): void {
    const w = this.w;
    const r = this.interp.renderTick(now);
    const s = this.interp.sample(r, this.pid);
    const me = this.predictor.display(this.acc / INPUT_DT, dt * 1000);
    this.shownTick = Math.max(this.shownTick, w.tick, this.predictor.tick);
    w.tick = this.shownTick;
    // Les autres joueurs sont affichés au tick r, le monde au tick prédit : leurs ticks d'effets
    // (double saut, parade) sont décalés d'autant pour que le rendu les compare à world.tick.
    const shift = w.tick - r;
    for (const p of s.players) {
      p.doubleJumpTick += shift;
      p.parryTick += shift;
    }
    // Coup prédit : l'ennemi visé clignote tout de suite, sans attendre la confirmation du serveur.
    for (const e of s.enemies) {
      const until = this.flashUntil.get(e.id);
      if (until !== undefined && until > w.tick) e.flash = Math.max(e.flash, until - w.tick);
    }
    for (const [id, until] of this.flashUntil) if (until <= w.tick) this.flashUntil.delete(id);
    w.players = me ? [me, ...s.players] : s.players;
    w.enemies = s.enemies;
    w.projectiles = s.projectiles;
    w.orbs = s.orbs;
  }

  /** En ligne, les positions affichées sont déjà lissées : pas d'interpolation supplémentaire dans la scène. */
  alpha(): number {
    return 1;
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
