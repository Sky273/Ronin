// Récapitulatif de la salle pour le bilan coop : module pur (aucune dépendance à Phaser).
import { COOP_CLEARED_TICKS, TICK_RATE } from '../../shared/constants';
import type { World } from '../../shared/types';

/** Nombre maximal de lignes du tableau (taille d'une salle). */
export const ROSTER_MAX = 12;

/** Une ligne du tableau de la salle. */
export interface RosterRow {
  id: number;
  name: string;
  color: number;
  kills: number;
  deaths: number;
  parries: number;
  honor: number;
  grade: number; // 0 = 優, 1 = 良, 2 = 可
  ready: boolean;
  me: boolean;
}

/**
 * Lignes du tableau : une par joueur du monde (12 au plus), triées par note
 * croissante (優 d'abord), puis kills décroissants, puis nom.
 * Un joueur absent de `byPlayer` (arrivant récent) reçoit des zéros et la note 可.
 */
export function buildRoster(w: World, meId: number): RosterRow[] {
  const by = w.stage.byPlayer;
  const rows: RosterRow[] = w.players.map((p) => {
    const s = by?.[p.id];
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      kills: s?.kills ?? 0,
      deaths: s?.deaths ?? 0,
      parries: s?.parries ?? 0,
      honor: s?.honor ?? 0,
      grade: s?.grade ?? 2,
      ready: s?.ready ?? false,
      me: p.id === meId,
    };
  });
  rows.sort((a, b) => a.grade - b.grade || b.kills - a.kills || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
  const top = rows.slice(0, ROSTER_MAX);
  // Au-delà de 12 (cas anormal), le joueur local reste visible à la dernière ligne.
  const me = rows.findIndex((r) => r.me);
  if (me >= ROSTER_MAX) top[ROSTER_MAX - 1] = rows[me];
  return top;
}

/** État du vote « prêt » et temps restant avant le passage automatique. */
export function readyInfo(w: World): { ready: number; needed: number; present: number; secondsLeft: number } {
  const by = w.stage.byPlayer;
  const present = w.players.length;
  let ready = 0;
  for (const p of w.players) if (by?.[p.id]?.ready) ready++;
  const needed = Math.floor(present / 2) + 1;
  const secondsLeft = Math.max(0, Math.ceil((COOP_CLEARED_TICKS - w.stage.t) / TICK_RATE));
  return { ready, needed, present, secondsLeft };
}

/** Note de la salle (médiane, calculée par la simulation). */
export function roomGrade(w: World): number {
  return w.stage.grade;
}
