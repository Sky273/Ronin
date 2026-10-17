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
import { COOP_AWAY_TICKS, COOP_KICK_TICKS, DUEL, DUEL_WHY } from '../shared/constants';
import { duelOf, forfeit, isDueling, kamaeLength } from '../shared/duel';
import { BTN } from '../shared/input';
import { addPlayer, createWorld, removePlayer, stepWorld } from '../shared/world';
import { Samples } from './stats';

/** Taille maximale de la file d'entrées d'un joueur (au-delà : fusion). */
export const MAX_INPUT_QUEUE = 8;
/** Nombre maximal de pas simulés par appel à update (rattrapage borné). */
export const MAX_STEPS_PER_UPDATE = 5;

// L'accumulateur compte en « millisecondes × NET_TICK » : un pas vaut exactement 1000 unités,
// ce qui évite les erreurs d'arrondi de 1000/60 (10 × 10 ms donnent bien 6 pas).
const STEP_UNITS = 1000;
/** Liste vide partagée (aucune allocation quand personne n'est absent). */
const NO_ONE: number[] = [];
/** Au-delà de ce nombre de pas sans entrée (0,5 s), les boutons d'un joueur sont relâchés (hors duel). */
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
  /** Dernier tick où le joueur a appuyé sur un bouton (un onglet laissé ouvert envoie des entrées vides). */
  lastActive: number;
  /** Heure de la dernière réception (ms, horloge de la session ou de la salle) ; -1 : aucune. */
  lastRecv: number;
  /** Duel : heure de référence de la cadence (-1 : hors duel) et entrées reçues depuis. */
  floodSince: number;
  floodCount: number;
  /** Duel : tick où le client aura rattrapé son tick affiché (monotone), après des entrées retirées de sa file. */
  caughtUp: number;
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
  /** Horloge de la session (ms écoulées, pas abandonnés compris) : cadence des entrées. */
  private clockMs = 0;
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
    this.slots.set(p.id, { pid: p.id, color, queue: [], lastSeq: -1, ack: -1, held: 0, starved: 0, lag: 0, lastActive: this.world.tick, lastRecv: -1, floodSince: -1, floodCount: 0, caughtUp: 0 });
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
  pushInput(pid: number, msg: InputMsg, atMs?: number): boolean {
    const slot = this.slots.get(pid);
    if (!slot || !Number.isSafeInteger(msg.s) || !Number.isSafeInteger(msg.b)) return false;
    if (msg.s <= slot.lastSeq) return false;
    slot.lastSeq = msg.s;
    const input: InputMsg = { s: msg.s, b: msg.b & BUTTON_MASK };
    if (validView(msg.v)) input.v = msg.v;
    slot.queue.push(input);
    // Heure de réception réelle si fournie (salle, banc), sinon horloge de la session.
    const now = atMs ?? this.clockMs;
    const prevRecv = slot.lastRecv;
    slot.lastRecv = now;
    if (isDueling(this.world, pid)) {
      // Duel : file stricte, une entrée par tick, jamais fusionnée. Le tick prédit par le client
      // (tick serveur + entrées en attente) reste ainsi exactement le tick de consommation :
      // envoyer plus vite que 60 Hz ne fait voir le signal en avance qu'au prix d'une file qui
      // s'allonge d'autant. Une cadence soutenue trop rapide (client accéléré) fait perdre le duel.
      // Cadence cumulée depuis la dernière réception d'avant le duel : une rafale après une coupure,
      // même longue, ne fait que rattraper le temps écoulé ; l'avance d'un client accéléré grandit
      // sans cesse et finit par dépasser la marge.
      if (slot.floodSince < 0) {
        slot.floodSince = prevRecv >= 0 ? prevRecv : now;
        slot.floodCount = 0;
      }
      slot.floodCount++;
      const allowed = ((now - slot.floodSince) / 1000) * NET_TICK * DUEL.FLOOD_RATE + DUEL.FLOOD_SLACK;
      if (slot.floodCount > allowed || slot.queue.length > DUEL.QUEUE_MAX) {
        forfeit(this.world, pid, DUEL_WHY.FLOOD);
        slot.queue = [input];
        slot.floodSince = now;
        slot.floodCount = 0;
      }
      return true;
    }
    slot.floodSince = -1;
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
    this.clockMs += elapsedMs;
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
      // Arriéré de duelliste seulement : quelques entrées en file absorbent les à-coups des pas du serveur (les retirer
      // affamerait le client au pas double suivant, ses entrées consommées un tick après son tick prédit).
      if (slot.queue.length > MAX_INPUT_QUEUE) this.trimDuelBacklog(slot);
      const next = slot.queue.shift();
      if (next) {
        slot.held = next.b;
        slot.ack = next.s;
        slot.starved = 0;
        if (next.b !== 0) slot.lastActive = w.tick;
        const raw = next.v === undefined ? 0 : Math.min(MAX_REWIND_TICKS, Math.max(0, w.tick - next.v));
        // Hausse immédiate, baisse d'au plus un tick par pas : un client ne peut pas faire alterner
        // son retard pour que des frappes différées soient jugées en bloc contre un état plus tardif.
        slot.lag = Math.max(raw, slot.lag - 1);
        this.lagStats.add(slot.lag);
      } else if (++slot.starved > IDLE_RELEASE_TICKS) {
        // Client muet (onglet en arrière-plan, coupure) : on relâche ses boutons plutôt que de les tenir indéfiniment.
        // En duel, seul DUEL est relâché : tenu pendant toute la coupure, il ferait d'un appui bref un abandon
        // (FORFEIT_HOLD). Relâcher l'iai y serait une frappe (ou une faute) que le joueur n'a pas faite, et ATTACK
        // ou PARRY relâchés feraient d'un appui encore tenu un nouvel appui à la reprise. Un départ y donne déjà
        // un forfait (DISCONNECT) ; un onglet muet garde son dernier masque sans frapper (TIMEOUT).
        slot.held = isDueling(w, slot.pid) ? slot.held & ~BTN.DUEL : 0;
      }
      this.inputs.set(slot.pid, slot.held);
      if (w.net) setLag(w.net, slot.pid, slot.lag);
    }
    // Absents : aucun bouton depuis COOP_AWAY_TICKS (ni vote ni force du gardien).
    const away: number[] = [];
    for (const slot of this.slots.values()) if (w.tick - slot.lastActive > COOP_AWAY_TICKS) away.push(slot.pid);
    if (away.length || (w.away && w.away.length)) w.away = away;
    stepWorld(w, this.inputs);
    if (w.events.length) {
      for (const ev of w.events) this.events.push(ev);
      w.events.length = 0;
    }
  }

  /**
   * Arriéré d'un duelliste (rafale après une coupure) pendant que ses entrées sont sans effet (mise en place,
   * dénouement, fin de série) : ramené à sa dernière entrée, sinon la file stricte ne se vide jamais et chaque garde
   * suivante commence en retard d'autant (signal connu trop tard, prédiction abandonnée). Seul l'abandon tenu y
   * compte : les entrées avec DUEL restent, chacune précédée d'une entrée sans DUEL (deux appuis ne se soudent pas).
   * Le tick prédit du client recule d'autant d'entrées retirées, son tick affiché (monotone) attend qu'il le rattrape,
   * et le 斬 s'afficherait en avance s'il était connu entre-temps. Retrait borné : rattrapage fini avant la prochaine
   * garde ; ou, si l'arriéré dépasse déjà le signal suivant (affiché dès qu'il sera connu), jusqu'à une garde
   * d'arriéré : le tick prédit l'aura atteint quand il sera connu (vu à temps ou un peu tard, jamais en avance).
   */
  private trimDuelBacklog(slot: PlayerSlot): void {
    const w = this.world;
    const d = duelOf(w, slot.pid);
    if (!d) return;
    // Ticks avant la prochaine garde et durée de celle-ci (fin de série : un nouveau duel, mise en place comprise).
    let idle: number;
    let guard = kamaeLength(d.id, d.played);
    if (d.phase === 'enter') idle = DUEL.ENTER_TICKS - d.t;
    else if (d.phase === 'resolve') idle = DUEL.RESOLVE_TICKS - d.t + DUEL.ENTER_TICKS;
    else if (d.phase === 'end') {
      idle = DUEL.END_TICKS - d.t + DUEL.ENTER_TICKS;
      guard = DUEL.KAMAE_MAX;
    } else return;
    const q = slot.queue;
    let budget = Math.max(w.tick + idle - Math.max(slot.caughtUp, w.tick), q.length - guard);
    if (budget <= 0) return;
    const kept: InputMsg[] = [];
    for (let i = 0; i < q.length; i++) {
      if (budget > 0 && i < q.length - 1 && !((q[i].b | q[i + 1].b) & BTN.DUEL)) {
        budget--;
        if (q[i].b !== 0) slot.lastActive = w.tick;
        continue;
      }
      kept.push(q[i]);
    }
    if (kept.length === q.length) return;
    slot.caughtUp = Math.max(slot.caughtUp, w.tick) + q.length - kept.length;
    slot.queue = kept;
  }

  /** Joueurs absents depuis assez longtemps pour être renvoyés de la salle (COOP_KICK_TICKS). */
  idleOut(): number[] {
    if (!this.world.away || !this.world.away.length) return NO_ONE;
    const out: number[] = [];
    for (const slot of this.slots.values()) if (this.world.tick - slot.lastActive > COOP_KICK_TICKS) out.push(slot.pid);
    return out;
  }

  /** Le joueur est-il absent (aucun bouton depuis COOP_AWAY_TICKS) ? */
  isAway(pid: number): boolean {
    const slot = this.slots.get(pid);
    return !!slot && this.world.tick - slot.lastActive > COOP_AWAY_TICKS;
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
