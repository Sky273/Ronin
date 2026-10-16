// Aiguillage des événements en ligne : quand les montrer, et lesquels écarter.
// - Les événements prédits du joueur local sortent tout de suite (prédicteur) ; leurs
//   doublons venus du serveur sont écartés (sauf un coup, une garde ou une flèche tranchée
//   que la prédiction avait manqués).
// - Les autres événements du joueur local sortent à réception (il est affiché en avance).
// - Les événements situés dans le monde (avec une position) attendent que les entités
//   distantes affichées aient atteint leur tick : l'effet coïncide avec ce que l'on voit.
// - Les événements de salle (sans position : étape, Marée…) sortent à réception.
// Module pur (sans Phaser), testé par tests/remote.test.ts.
import type { GameEvent } from '../../shared/types';
import { PREDICTED_EVENTS } from './predictor';

/** Types d'événements du joueur local produits par la prédiction (liste unique, celle du prédicteur). */
export const PREDICTED_TYPES = PREDICTED_EVENTS;
/**
 * Événements prédits que la prédiction peut manquer (projectiles et vague de vent ne sont pas
 * simulés côté client) : ceux du serveur sont montrés s'ils n'ont pas de correspondant prédit.
 */
const MATCHED: ReadonlySet<GameEvent['type']> = new Set<GameEvent['type']>(['hit', 'block', 'deflect', 'guardBreak']);
/** Distance (px) en deçà de laquelle un événement prédit sans cible correspond à celui du serveur. */
const MATCH_PX = 80;
/** Toujours différés jusqu'au tick de rendu, même pour le joueur local (corps tranché, condamnation). */
const WORLD_BOUND: ReadonlySet<GameEvent['type']> = new Set<GameEvent['type']>(['kill', 'doom']);
/** Fenêtre (ticks) pour rapprocher un événement prédit de sa confirmation par le serveur. */
export const HIT_MATCH_TICKS = 30;
/** Au plus autant d'événements en attente (onglet en arrière-plan). */
const MAX_DEFERRED = 400;

const pidOf = (ev: GameEvent): number | undefined => (ev as { pid?: number }).pid;
const located = (ev: GameEvent): boolean => ('x' in ev && typeof ev.x === 'number') || ev.type === 'iai';

export class EventGate {
  private deferred: { t: number; ev: GameEvent }[] = [];
  /** Événements prédits (coups, gardes, flèches tranchées) pas encore confirmés par le serveur. */
  private predictedHits: { type: GameEvent['type']; target: number; x: number; tick: number }[] = [];

  constructor(readonly meId: number) {}

  /** Événements prédits au tick `tick` : sortent tels quels ; ceux à rapprocher du serveur sont mémorisés. */
  predicted(evs: GameEvent[], tick: number): GameEvent[] {
    for (const ev of evs) {
      if (!MATCHED.has(ev.type)) continue;
      const target = ev.type === 'hit' ? ev.targetId : -1;
      this.predictedHits.push({ type: ev.type, target, x: (ev as { x: number }).x, tick });
    }
    return evs;
  }

  /** Événements d'un instantané du tick serveur `t` : renvoie ceux à montrer tout de suite. */
  server(evs: GameEvent[], t: number): GameEvent[] {
    const now: GameEvent[] = [];
    for (const ev of evs) {
      const mine = pidOf(ev) === this.meId;
      if (mine && PREDICTED_TYPES.has(ev.type)) {
        // Déjà montré par la prédiction ; un coup, une garde ou une flèche tranchée sans
        // correspondant prédit (projectile, vague de vent, divergence) est montré.
        if (MATCHED.has(ev.type) && !this.consume(ev, t)) now.push(ev);
        continue;
      }
      if (WORLD_BOUND.has(ev.type) || (!mine && located(ev))) this.deferred.push({ t, ev });
      else now.push(ev);
    }
    if (this.deferred.length > MAX_DEFERRED) this.deferred.splice(0, this.deferred.length - MAX_DEFERRED);
    this.prune(t);
    return now;
  }

  /** Événements différés dont le tick est atteint par le rendu des entités distantes (`r`). */
  release(r: number): GameEvent[] {
    let n = 0;
    while (n < this.deferred.length && this.deferred[n].t <= r) n++;
    return n ? this.deferred.splice(0, n).map((d) => d.ev) : [];
  }

  /** Nombre d'événements en attente (tests, diagnostics). */
  get pending(): number {
    return this.deferred.length;
  }

  reset(): void {
    this.deferred = [];
    this.predictedHits = [];
  }

  private consume(ev: GameEvent, t: number): boolean {
    const target = ev.type === 'hit' ? ev.targetId : -1;
    const x = (ev as { x: number }).x;
    const i = this.predictedHits.findIndex(
      (h) => h.type === ev.type && Math.abs(h.tick - t) <= HIT_MATCH_TICKS && (target >= 0 ? h.target === target : Math.abs(h.x - x) <= MATCH_PX),
    );
    if (i < 0) return false;
    this.predictedHits.splice(i, 1);
    return true;
  }

  /** Oublie les événements prédits trop anciens pour être confirmés. */
  private prune(t: number): void {
    if (this.predictedHits.length) this.predictedHits = this.predictedHits.filter((h) => h.tick >= t - HIT_MATCH_TICKS);
  }
}
