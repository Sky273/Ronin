// Duels iaidō : face-à-face immobile, signal 斬 planifié à un tick serveur connu à l'avance,
// premier impact gagnant, parade, fautes, série au meilleur des trois manches.
// Module sans dépendance au mode coop : le dojo-tournoi (M5) le réutilise tel quel.
// Fondations : requêtes seulement (la machine de manches arrive avec le lot simulation).
import type { Duel, World } from './types';

/** Duel du joueur `pid`, s'il en dispute un. */
export function duelOf(w: World, pid: number): Duel | undefined {
  const ds = w.duels;
  if (!ds || !ds.length) return undefined;
  for (const d of ds) if (d.a.pid === pid || d.b.pid === pid) return d;
  return undefined;
}

/** Le joueur `pid` dispute-t-il un duel ? (toujours faux en solo : `w.duels` absent) */
export function isDueling(w: World, pid: number): boolean {
  return duelOf(w, pid) !== undefined;
}

/**
 * Le signal 斬 est-il visible au tick `tick` ? Le client l'affiche à son tick prédit, qui est le
 * tick de consommation serveur de ses entrées : chaque joueur le voit au même tick de jeu.
 */
export function signalShown(d: Duel, tick: number): boolean {
  return d.sigTick >= 0 && tick >= d.sigTick && (d.phase === 'kamae' || d.phase === 'open');
}
