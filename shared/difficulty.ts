// ─── Niveaux de difficulté (choisis avant la partie, solo) ──────────────────
// Normal reproduit exactement le comportement historique (tout à 1 / 0).

export type DifficultyId = 'veryEasy' | 'easy' | 'normal' | 'hard' | 'veryHard';

export const DIFFICULTY_ORDER: DifficultyId[] = ['veryEasy', 'easy', 'normal', 'hard', 'veryHard'];

export interface DifficultyDef {
  lives: number; // nombre de morts avant la fin de la partie
  enemyHp: number;
  enemyDmg: number;
  enemyCooldown: number; // > 1 = ennemis plus lents à relancer une attaque
  extraEnemies: number; // ajouté à la taille de la horde (plancher appliqué à l'usage)
  scoreMult: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyDef> = {
  veryEasy: { lives: 10, enemyHp: 0.6, enemyDmg: 0.5, enemyCooldown: 1.4, extraEnemies: -2, scoreMult: 0.5 },
  easy: { lives: 8, enemyHp: 0.8, enemyDmg: 0.75, enemyCooldown: 1.2, extraEnemies: -1, scoreMult: 0.75 },
  normal: { lives: 5, enemyHp: 1, enemyDmg: 1, enemyCooldown: 1, extraEnemies: 0, scoreMult: 1 },
  hard: { lives: 3, enemyHp: 1.25, enemyDmg: 1.3, enemyCooldown: 0.85, extraEnemies: 1, scoreMult: 1.5 },
  veryHard: { lives: 1, enemyHp: 1.5, enemyDmg: 1.6, enemyCooldown: 0.75, extraEnemies: 2, scoreMult: 2.5 },
};

/** Bonus de score par boucle : avancer rapporte plus que farmer la Marée. */
export const loopScoreMult = (loop: number): number => 1 + 0.25 * loop;

// ─── Difficulté croissante à chaque boucle du voyage (周). loop = 0 au premier passage.
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
