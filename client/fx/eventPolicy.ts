// Politique d'effets des événements de simulation : à qui s'adresse un tremblement d'écran ?
// Module pur (sans Phaser), testé par tests/policy.test.ts.
import type { GameEvent } from '../../shared/types';

/** Distances (px) de décroissance du tremblement d'une onde de choc en coop : plein en deçà, nul au-delà. */
export const SLAM_FULL_PX = 300;
export const SLAM_NONE_PX = 700;

/**
 * L'événement concerne-t-il le joueur local ? Sans `pid` (solo, événements de la salle) : oui.
 * En coop, les événements de combat portent l'auteur du coup.
 */
export function isMine(ev: GameEvent, meId: number): boolean {
  const pid = (ev as { pid?: number }).pid;
  return pid === undefined || pid === meId;
}

/**
 * Intensité du tremblement d'écran provoqué par un événement de combat (0 : aucun).
 * Seuls les coups du joueur local font trembler son écran ; en coop, l'onde de choc d'un
 * ennemi s'atténue avec la distance au joueur local (en solo, elle tremble toujours pleinement).
 */
export function shakeFor(ev: GameEvent, meId: number, me: { x: number; y: number }, coop: boolean): number {
  switch (ev.type) {
    case 'hit':
      return isMine(ev, meId) ? (ev.heavy ? 9 : 4) : 0;
    case 'block':
      return isMine(ev, meId) ? 3 : 0;
    case 'guardBreak':
      return isMine(ev, meId) ? 8 : 0;
    case 'slam': {
      const full = ev.w > 100 ? 14 : 5;
      if (!coop) return full;
      const d = Math.abs(ev.x - me.x);
      if (d <= SLAM_FULL_PX) return full;
      if (d >= SLAM_NONE_PX) return 0;
      return full * (1 - (d - SLAM_FULL_PX) / (SLAM_NONE_PX - SLAM_FULL_PX));
    }
    default:
      return 0;
  }
}
