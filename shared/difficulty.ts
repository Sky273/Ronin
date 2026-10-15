// Difficulté croissante à chaque boucle du voyage (周). loop = 0 au premier passage.
// Les télégraphes (durées de préparation) ne changent jamais : le jeu reste lisible,
// il devient seulement plus dense et plus punitif.

export const enemyHpMult = (loop: number): number => 1 + 0.35 * loop;
export const enemyDmgMult = (loop: number): number => 1 + 0.2 * loop;
export const enemyCooldownMult = (loop: number): number => Math.max(0.6, 1 - 0.12 * loop);
export const guardianHpMult = (loop: number): number => 1 + 0.4 * loop;
/** Seuil de PV sous lequel le gardien entre en rage. */
export const guardianRageAt = (loop: number): number => Math.min(0.7, 0.5 + 0.1 * loop);
export const extraEnemies = (loop: number): number => 2 * loop;
export const firstCalmMult = (loop: number): number => Math.max(0.5, 1 - 0.2 * loop);
export const clearBonus = (grade: number, loop: number): number => Math.round([150, 80, 30][grade] * (1 + 0.5 * loop));
