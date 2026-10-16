// Session coopérative : la simulation partagée d'une salle, sans aucune dépendance réseau.
// La salle Colyseus ne fait que relayer les messages ; toute la logique testable est ici.
import {
  BUTTON_MASK,
  MAX_REWIND_TICKS,
  NET_TICK,
  PLAYER_COLORS,
  PROTOCOL_VERSION,
  sanitizePlayerName,
  type InputMsg,
  type WelcomeMsg,
} from '../shared/net/protocol';
import type { SnapshotWire } from '../shared/net/codec';
import { makeSnapshot } from '../shared/net/snapshot';
import { createLagComp, forgetPlayer, setLag } from '../shared/lagcomp';
import type { GameEvent, World } from '../shared/types';
import { addPlayer, createWorld, removePlayer, stepWorld } from '../shared/world';
import { Samples } from './stats';

/** Taille maximale de la file d'entrées d'un joueur (au-delà : fusion). */
export const MAX_INPUT_QUEUE = 8;
/** Nombre maximal de pas simulés par appel à update (rattrapage borné). */
export const MAX_STEPS_PER_UPDATE = 5;

// L'accumulateur compte en « millisecondes × NET_TICK » : un pas vaut exactement 1000 unités,
// ce qui évite les erreurs d'arrondi de 1000/60 (10 × 10 ms donnent bien 6 pas).
const STEP_UNITS = 1000;
/** Au-delà de ce nombre de pas sans entrée (0,5 s), les boutons d'un joueur sont relâchés. */
export const IDLE_RELEASE_TICKS = 30;

interface PlayerSlot {
  pid: number;
  color: number;
  /** Entrées reçues, pas encore consommées (séquences croissantes). */
  queue: InputMsg[];
  /** Dernière séquence acceptée (reçue). */
  lastSeq: number;
  /** Dernière séquence consommée par la simulation (renvoyée en `ack`). */
  ack: number;
  /** Boutons tenus : réutilisés quand la file est vide. */
  held: number;
  /** Pas consécutifs sans entrée reçue. */
  starved: number;
  /** Retard de l'entrée consommée (ticks, 0..MAX_REWIND_TICKS) : compensation de latence. */
  lag: number;
}

/** Tick de vue valide : entier ≥ 0 (sinon ignoré). */
const validView = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class CoopSession {
  readonly world: World;
  private readonly slots = new Map<number, PlayerSlot>();
  private readonly usedColors = new Set<number>();
  private readonly inputs = new Map<number, number>();
  /** Événements accumulés depuis le dernier envoi d'instantanés. */
  private events: GameEvent[] = [];
  private acc = 0;
  /** Retards L des entrées consommées (statistiques p50/p95 des journaux). */
  readonly lagStats = new Samples();

  constructor(seed: number) {
    this.world = createWorld(seed, { mode: 'coop', difficulty: 'normal' });
    // Compensation de latence : posée uniquement ici (jamais en solo ni côté client).
    this.world.net = createLagComp();
  }

  get playerCount(): number {
    return this.slots.size;
  }

  /** Ajoute un joueur : première couleur libre, pseudo nettoyé. Lève une erreur si la salle est pleine. */
  join(name: unknown): { pid: number; color: number } {
    let color = 0;
    while (color < PLAYER_COLORS && this.usedColors.has(color)) color++;
    if (color >= PLAYER_COLORS) throw new Error('salle pleine');
    const p = addPlayer(this.world, sanitizePlayerName(name), { color });
    this.usedColors.add(color);
    this.slots.set(p.id, { pid: p.id, color, queue: [], lastSeq: -1, ack: -1, held: 0, starved: 0, lag: 0 });
    return { pid: p.id, color };
  }

  /** Retire un joueur et libère sa couleur. Sans effet si le joueur est inconnu. */
  leave(pid: number): void {
    const slot = this.slots.get(pid);
    if (!slot) return;
    this.slots.delete(pid);
    this.usedColors.delete(slot.color);
    removePlayer(this.world, pid);
    if (this.world.net) forgetPlayer(this.world.net, pid);
  }

  has(pid: number): boolean {
    return this.slots.has(pid);
  }

  /**
   * Reçoit une entrée. Les séquences doivent être strictement croissantes (les autres sont ignorées).
   * `v` (tick de vue) est facultatif : absent ou invalide, l'entrée est jugée sans retard (L = 0).
   * Renvoie false si l'entrée est ignorée.
   */
  pushInput(pid: number, msg: InputMsg): boolean {
    const slot = this.slots.get(pid);
    if (!slot || !Number.isSafeInteger(msg.s) || !Number.isSafeInteger(msg.b)) return false;
    if (msg.s <= slot.lastSeq) return false;
    slot.lastSeq = msg.s;
    const input: InputMsg = { s: msg.s, b: msg.b & BUTTON_MASK };
    if (validView(msg.v)) input.v = msg.v;
    slot.queue.push(input);
    if (slot.queue.length > MAX_INPUT_QUEUE) {
      // File saturée (rafale réseau) : on ne garde que la plus récente, en conservant
      // les appuis des entrées abandonnées pour ne pas perdre un saut ou une attaque.
      let b = 0;
      for (const q of slot.queue) b |= q.b;
      slot.queue = [{ ...input, b }];
    }
    return true;
  }

  /** Taille actuelle de la file d'un joueur (tests, diagnostics). */
  queueLength(pid: number): number {
    return this.slots.get(pid)?.queue.length ?? 0;
  }

  /** Retard courant du joueur (ticks) retenu pour la compensation de latence (0 si inconnu). */
  lagFor(pid: number): number {
    return this.slots.get(pid)?.lag ?? 0;
  }

  /** Dernière séquence consommée pour ce joueur (-1 si aucune). */
  ackFor(pid: number): number {
    return this.slots.get(pid)?.ack ?? -1;
  }

  /**
   * Avance la simulation à pas fixe (1/NET_TICK s) selon le temps écoulé.
   * Au plus MAX_STEPS_PER_UPDATE pas par appel : le retard au-delà est abandonné.
   * Renvoie le nombre de pas simulés.
   */
  update(elapsedMs: number): number {
    // Durées nulles, négatives ou non finies ignorées (Infinity figerait l'accumulateur en NaN).
    if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs * NET_TICK)) return 0;
    this.acc += elapsedMs * NET_TICK;
    let steps = 0;
    while (this.acc >= STEP_UNITS && steps < MAX_STEPS_PER_UPDATE) {
      this.acc -= STEP_UNITS;
      this.step();
      steps++;
    }
    // Rattrapage plafonné : on garde au plus un pas d'avance.
    if (this.acc >= STEP_UNITS) this.acc = this.acc % STEP_UNITS;
    return steps;
  }

  /**
   * Un pas de simulation : au plus une entrée consommée par joueur.
   * Retard de l'entrée consommée au tick S : L = clamp(S − v, 0, MAX_REWIND_TICKS) ; sans `v`,
   * L = 0 ; file vide : le dernier L est conservé.
   */
  private step(): void {
    const w = this.world;
    this.inputs.clear();
    for (const slot of this.slots.values()) {
      const next = slot.queue.shift();
      if (next) {
        slot.held = next.b;
        slot.ack = next.s;
        slot.starved = 0;
        slot.lag = next.v === undefined ? 0 : Math.min(MAX_REWIND_TICKS, Math.max(0, w.tick - next.v));
        this.lagStats.add(slot.lag);
      } else if (++slot.starved > IDLE_RELEASE_TICKS) {
        // Client muet (onglet en arrière-plan, coupure) : on relâche ses boutons plutôt que de les tenir indéfiniment.
        slot.held = 0;
      }
      this.inputs.set(slot.pid, slot.held);
      if (w.net) setLag(w.net, slot.pid, slot.lag);
    }
    stepWorld(w, this.inputs);
    if (w.events.length) {
      for (const ev of w.events) this.events.push(ev);
      w.events.length = 0;
    }
  }

  /** Instantané pour un joueur : événements depuis le dernier envoi et accusé de réception. */
  snapshotFor(pid: number): SnapshotWire {
    return makeSnapshot(this.world, pid, this.events, this.ackFor(pid));
  }

  /** À appeler une fois l'instantané envoyé à tous les joueurs. */
  flushEvents(): void {
    this.events = [];
  }

  /** Événements en attente d'envoi (lecture). */
  get pendingEvents(): readonly GameEvent[] {
    return this.events;
  }

  welcomeFor(pid: number): WelcomeMsg {
    const w = this.world;
    return { pid, seed: w.seed, stage: w.level.stage, tick: w.tick, color: this.slots.get(pid)?.color ?? 0, v: PROTOCOL_VERSION };
  }
}
