import type { DifficultyId } from '../../shared/difficulty';

/** Une entrée du tableau des high scores (stockée côté client uniquement). */
export interface ScoreEntry {
  name: string;
  score: number;
  loop: number; // boucle 周 atteinte (0 = premier voyage)
  kills: number;
  date: number; // horodatage ms, fixé côté client
}

export type ScoreTable = Record<DifficultyId, ScoreEntry[]>;

export const MAX_SCORES = 10;
export const MAX_NAME = 12;
export const DEFAULT_NAME = 'Ronin';
