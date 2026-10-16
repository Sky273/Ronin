// Prédiction du joueur local en ligne : il réagit tout de suite à ses entrées, puis se recale
// sur l'état exact envoyé par le serveur (réconciliation à partir de l'accusé `ack`).
//
// Seul le joueur local est prédit, avec `stepPlayer`, dans un « monde de prédiction » jetable
// reconstruit à chaque pas (niveau partagé en lecture seule, ennemis clonés, RNG jetable) :
// hit-stop, rebond sur la garde de l'oni, pogo et `hitList` sont prédits, et toutes les
// mutations du monde sont jetées. Le reste du monde n'est jamais re-simulé côté client.
import { CORRECTION_SNAP_PX, CORRECTION_TAU_MS } from '../../shared/net/protocol';
import { Rng } from '../../shared/math';
import { stepPlayer } from '../../shared/player';
import type { Enemy, GameEvent, Player, StageState, WaveState, World } from '../../shared/types';

/** Ce que la prédiction sait du monde, d'après le dernier instantané appliqué. */
export interface PredictionContext {
  level: World['level'];
  stage: StageState;
  wave: WaveState;
  shrine: number;
  /** Tick serveur du dernier instantané. */
  serverTick: number;
}

/** Entrée envoyée, en attente d'accusé de réception. */
export interface PendingInput {
  seq: number;
  b: number;
  /** Tick de vue au moment de l'envoi. */
  v: number;
}

/** Au-delà de ce nombre d'entrées non acquittées, on abandonne la prédiction et on se recale. */
export const MAX_PENDING = 120;

/** Événements du joueur local prédits (effets immédiats) ; les autres viennent du serveur. */
export const PREDICTED_EVENTS: ReadonlySet<GameEvent['type']> = new Set<GameEvent['type']>([
  'swing', 'jump', 'wallJump', 'land', 'dash', 'slide', 'iaiStart', 'iaiReady', 'iai', 'plungeLand',
  'hit', 'block', 'deflect', 'guardBreak', 'windSlash',
]);

/** Champs d'interface : toujours ceux du serveur (la prédiction ne fait pas clignoter le HUD). */
const SERVER_FIELDS = [
  'honor', 'level', 'picks', 'offer', 'up', 'score', 'kills', 'runKills', 'hp', 'maxHp', 'lostX', 'lostY',
  'lives', 'combo', 'bestCombo', 'checkpoint', 'spawnX', 'spawnY',
] as const satisfies readonly (keyof Player)[];

/** Copie profonde d'un joueur (tableaux et améliorations compris). */
export function clonePlayer(p: Player): Player {
  return { ...p, hitList: p.hitList.slice(), offer: p.offer.slice(), up: { ...p.up } };
}

/** Recopie les champs d'interface de `src` dans `dst`. */
function copyServerFields(dst: Player, src: Player): void {
  for (const k of SERVER_FIELDS) (dst as unknown as Record<string, unknown>)[k] = k === 'offer' ? src.offer.slice() : k === 'up' ? { ...src.up } : src[k];
}

/** Changement brusque qu'on ne lisse pas : mort ou renaissance. */
function lifeChanged(a: Player, b: Player): boolean {
  return (a.state === 'dead') !== (b.state === 'dead');
}

export class Predictor {
  /** Dernier état exact reçu du serveur. */
  private server: Player | null = null;
  private serverTick = 0;
  /** État prédit courant (après la dernière entrée envoyée) et précédent (interpolation). */
  private cur: Player | null = null;
  private prev: Player | null = null;
  /** Décalage de correction affiché (px), décroît vers 0. */
  private offX = 0;
  private offY = 0;
  /** Étape du dernier instantané (détection des recalages nets). */
  private lastStage = -1;
  /** Entrées envoyées et pas encore acquittées (à rejouer après chaque instantané). */
  readonly pending: PendingInput[] = [];

  // Compteurs de débogage (lecture).
  /** Écart (px) entre l'ancienne et la nouvelle prédiction à la dernière réconciliation. */
  lastCorrectionPx = 0;
  /** Nombre de recalages nets (sans lissage). */
  snaps = 0;
  /** Entrées rejouées à la dernière réconciliation. */
  replayed = 0;

  constructor(readonly meId: number) {}

  /** État prédit courant (référence interne, à ne pas modifier ; null avant le premier instantané). */
  get predicted(): Readonly<Player> | null {
    return this.cur;
  }

  /**
   * Un pas prédit pour l'entrée qui vient d'être envoyée. `enemies` : ennemis tels que le client
   * les affiche au tick de vue `v`. Renvoie les événements prédits du joueur local (effets immédiats).
   */
  step(seq: number, b: number, v: number, enemies: Enemy[], ctx: PredictionContext): GameEvent[] {
    const tick = this.tick;
    this.pending.push({ seq, b, v });
    if (!this.cur) {
      // Aucun instantané encore : on se contente de mémoriser (borné).
      if (this.pending.length > MAX_PENDING) this.pending.shift();
      return [];
    }
    if (this.pending.length > MAX_PENDING) {
      // Le serveur ne répond plus à nos entrées : on abandonne la prédiction.
      this.pending.length = 0;
      if (this.server) this.hardSet(clonePlayer(this.server));
      this.snaps++;
      return [];
    }
    const next = clonePlayer(this.cur);
    const events = simulate(next, b, enemies, ctx, tick);
    this.prev = this.cur;
    this.cur = next;
    // Téléportation (renaissance, saut de plus de CORRECTION_SNAP_PX) : pas de glissade entre les deux.
    const dx = next.x - this.prev.x;
    const dy = next.y - this.prev.y;
    if (lifeChanged(this.prev, next) || dx * dx + dy * dy > CORRECTION_SNAP_PX * CORRECTION_SNAP_PX) {
      this.prev = next;
      this.offX = this.offY = 0;
    }
    const out: GameEvent[] = [];
    for (const ev of events) {
      if (PREDICTED_EVENTS.has(ev.type) && 'pid' in ev && ev.pid === this.meId) out.push(ev);
    }
    return out;
  }

  /**
   * Nouvel instantané : `self` est l'état exact du joueur au tick serveur, après l'entrée `ack`.
   * `enemiesAt(v)` donne les ennemis affichés au tick de vue `v` (pour rejouer les entrées).
   */
  reconcile(self: Player | null, ack: number, ctx: PredictionContext, enemiesAt: (v: number) => Enemy[]): void {
    const stageChanged = this.lastStage !== -1 && ctx.level.stage !== this.lastStage;
    this.lastStage = ctx.level.stage;
    this.serverTick = ctx.serverTick;
    this.replayed = 0;
    if (!self) {
      // Plus de joueur côté serveur : rien à prédire.
      this.server = null;
      this.cur = this.prev = null;
      this.pending.length = 0;
      this.offX = this.offY = 0;
      return;
    }
    this.server = clonePlayer(self);
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    if (stageChanged) this.pending.length = 0;

    // Rejeu des entrées non acquittées, sans effets, depuis l'état exact du serveur.
    let state = clonePlayer(self);
    let before = state;
    for (let i = 0; i < this.pending.length; i++) {
      const inp = this.pending[i];
      before = state;
      state = clonePlayer(state);
      simulate(state, inp.b, enemiesAt(inp.v), ctx, ctx.serverTick + i);
    }
    this.replayed = this.pending.length;

    const old = this.cur;
    if (!old) {
      // Premier instantané : point de départ, pas de correction.
      this.cur = state;
      this.prev = before;
      this.lastCorrectionPx = 0;
      return;
    }
    const dx = old.x - state.x;
    const dy = old.y - state.y;
    this.lastCorrectionPx = Math.sqrt(dx * dx + dy * dy);
    const sx = old.x - state.x + this.offX;
    const sy = old.y - state.y + this.offY;
    // Recalage net : changement d'étape, mort ou renaissance, grand écart.
    const snap =
      stageChanged || lifeChanged(old, state) ||
      (old.state === 'dead' && state.state === 'dead' && old.respawnT !== state.respawnT) ||
      this.lastCorrectionPx > CORRECTION_SNAP_PX || sx * sx + sy * sy > CORRECTION_SNAP_PX * CORRECTION_SNAP_PX;
    this.cur = state;
    if (snap) {
      this.prev = state;
      this.offX = this.offY = 0;
      this.snaps++;
    } else {
      // L'ancienne image reste à l'écran : l'écart est absorbé par le décalage, qui s'estompe.
      this.prev = before;
      this.offX = sx;
      this.offY = sy;
    }
  }

  /**
   * Joueur local à afficher. `frac` : fraction du pas d'entrée en cours (0..1) ;
   * `dtMs` : durée de l'image (lissage des corrections).
   */
  display(frac: number, dtMs: number): Player | null {
    const cur = this.cur;
    const server = this.server;
    if (!cur || !server) return null;
    if (dtMs > 0) {
      const k = Math.exp(-dtMs / CORRECTION_TAU_MS);
      this.offX *= k;
      this.offY *= k;
      if (Math.abs(this.offX) < 0.01) this.offX = 0;
      if (Math.abs(this.offY) < 0.01) this.offY = 0;
    }
    const prev = this.prev ?? cur;
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const out = clonePlayer(cur);
    out.x = prev.x + (cur.x - prev.x) * f + this.offX;
    out.y = prev.y + (cur.y - prev.y) * f + this.offY;
    copyServerFields(out, server);
    return out;
  }

  /** Tick prédit (tick du monde affiché). */
  get tick(): number {
    return this.serverTick + this.pending.length;
  }

  reset(): void {
    this.server = null;
    this.serverTick = 0;
    this.cur = this.prev = null;
    this.offX = this.offY = 0;
    this.lastStage = -1;
    this.pending.length = 0;
    this.lastCorrectionPx = 0;
    this.replayed = 0;
  }

  /** Recalage net sur `p`. */
  private hardSet(p: Player): void {
    this.cur = p;
    this.prev = p;
    this.offX = this.offY = 0;
  }
}

/**
 * Un pas du joueur `p` (modifié sur place) dans un monde jetable : niveau partagé (lecture seule),
 * étape et Marée copiées, ennemis clonés, aucun projectile ni orbe, RNG jetable.
 * Renvoie les événements émis pendant ce pas.
 */
function simulate(p: Player, b: number, enemies: Enemy[], ctx: PredictionContext, tick: number): GameEvent[] {
  if (ctx.stage.state === 'cleared') {
    // Bilan : le joueur ne bouge pas (voir stepCleared) ; les choix d'amélioration viennent du serveur.
    p.prevButtons = b;
    return [];
  }
  const w: World = {
    tick,
    seed: 0,
    level: ctx.level,
    players: [p],
    enemies: enemies.map((e) => ({ ...e })),
    projectiles: [],
    orbs: [],
    events: [],
    rng: new Rng(0),
    nextId: 1e9,
    spawnTimer: 240,
    attackTokens: 0,
    totalKills: 0,
    wave: { ...ctx.wave },
    // Sans les statistiques par joueur : la prédiction ne doit pas modifier celles du serveur.
    stage: { ...ctx.stage, byPlayer: undefined },
    difficulty: 'normal',
    mode: 'coop',
    shrine: ctx.shrine,
    over: false,
    overT: 0,
  };
  stepPlayer(w, p, b);
  return w.events;
}
