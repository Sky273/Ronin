import { DT } from '../../shared/constants';
import type { GameEvent, Player, World } from '../../shared/types';
import { addPlayer, stepWorld } from '../../shared/world';
import type { WorldSource } from './source';

/** Nombre maximal de pas de simulation rattrapés en une image (au-delà, le retard est abandonné). */
const MAX_STEPS = 4;
/** Ralenti : facteur de vitesse du temps pendant `slowmo`. */
const SLOWMO_SCALE = 0.3;
/** Joueurs « fantômes » de débogage : retard (ticks) entre deux échos successifs, et mémoire des entrées. */
const ECHO_DELAY = 14;
const HISTORY = 256;
const PALETTE_SIZE = 12;

/**
 * Monde simulé dans le navigateur (mode solo) : avance à pas fixe DT avec un accumulateur,
 * et porte le ralenti (qui n'existe qu'en local).
 */
export class LocalSource implements WorldSource {
  readonly kind = 'local' as const;
  /** Temps réel accumulé non encore simulé (s). */
  acc = 0;
  /** Durée de ralenti restante (s, temps réel). Réglée par la scène (parade, iai, mort, gardien). */
  slowmo = 0;
  /** Facteur de temps de la dernière image (0.3 pendant le ralenti, 1 sinon). */
  timeScale = 1;
  /** Tick du monde après le pas qui a produit chaque événement renvoyé par le dernier `advance`. */
  readonly eventTicks: number[] = [];

  private inputs = new Map<number, number>();
  /** Échos de débogage : id du joueur → retard (ticks) sur les entrées du joueur local. */
  private echoes = new Map<number, number>();
  /** Entrées récentes du joueur local (la plus récente en dernier). */
  private history: number[] = [];

  constructor(readonly world: World, public meId: number) {}

  /** Nouvelle partie (le monde a été réinitialisé sur place) : l'état d'avancement repart de zéro. */
  reset(meId: number): void {
    this.meId = meId;
    this.acc = 0;
    this.slowmo = 0;
    this.timeScale = 1;
    this.inputs.clear();
    this.echoes.clear();
    this.history.length = 0;
    this.eventTicks.length = 0;
  }

  advance(dt: number, sample: () => number, beforeStep: () => void): GameEvent[] {
    const w = this.world;
    const out: GameEvent[] = [];
    this.eventTicks.length = 0;
    this.timeScale = 1;
    if (this.slowmo > 0) {
      this.slowmo -= dt;
      this.timeScale = SLOWMO_SCALE;
    }
    this.acc += dt * this.timeScale;
    let n = 0;
    while (this.acc >= DT && n < MAX_STEPS) {
      beforeStep();
      const mask = sample();
      this.inputs.set(this.meId, mask);
      if (this.echoes.size) this.feedEchoes(mask);
      stepWorld(w, this.inputs);
      for (const ev of w.events) {
        out.push(ev);
        this.eventTicks.push(w.tick);
      }
      w.events.length = 0;
      this.acc -= DT;
      n++;
    }
    if (n === MAX_STEPS) this.acc = 0;
    return out;
  }

  alpha(): number {
    return this.acc / DT;
  }

  dispose(): void {
    this.inputs.clear();
    this.echoes.clear();
    this.history.length = 0;
  }

  /**
   * Débogage : ajoute un joueur qui rejoue les entrées du joueur local avec un retard
   * (couleur libre suivante, nom « Kage n »). Sert à vérifier le rendu de N joueurs sans réseau.
   */
  addEcho(): Player | null {
    const w = this.world;
    if (w.players.length >= PALETTE_SIZE) return null;
    const me = w.players.find((p) => p.id === this.meId);
    const used = new Set(w.players.map((p) => p.color));
    let color = 0;
    while (used.has(color)) color++;
    const n = this.echoes.size + 1;
    const p = addPlayer(w, `Kage ${n}`, { color });
    if (me) {
      // Même point de départ et même sanctuaire : le retard sur les entrées suffit à les séparer.
      p.x = me.x;
      p.y = me.y;
      p.facing = me.facing;
      p.checkpoint = me.checkpoint;
      p.spawnX = me.spawnX;
      p.spawnY = me.spawnY;
    }
    this.echoes.set(p.id, ECHO_DELAY * n);
    return p;
  }

  private feedEchoes(mask: number): void {
    const h = this.history;
    h.push(mask);
    if (h.length > HISTORY) h.shift();
    for (const [id, delay] of this.echoes) {
      if (!this.world.players.some((p) => p.id === id)) {
        this.echoes.delete(id);
        this.inputs.delete(id);
        continue;
      }
      const i = h.length - 1 - delay;
      this.inputs.set(id, i >= 0 ? h[i] : 0);
    }
  }
}
