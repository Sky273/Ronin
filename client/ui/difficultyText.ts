import type { DifficultyId } from '../../shared/difficulty';

/** Libellés affichés des niveaux de difficulté (source unique pour tous les écrans). */
export const DIFFICULTY_TEXT: Record<DifficultyId, { kanji: string; name: string; desc: string }> = {
  veryEasy: { kanji: '童', name: 'Very Easy', desc: 'A child’s first steps on the road. The forest forgives.' },
  easy: { kanji: '易', name: 'Easy', desc: 'A gentle wind through the bamboo. Learn the blade.' },
  normal: { kanji: '常', name: 'Normal', desc: 'The road as it is. Steel meets steel.' },
  hard: { kanji: '難', name: 'Hard', desc: 'Every shadow hides a blade. Few return.' },
  veryHard: { kanji: '鬼', name: 'Very Hard', desc: 'The demon’s path. One life, no mercy.' },
};

export const livesLabel = (n: number): string => `${n} ${n === 1 ? 'life' : 'lives'}`;
export const foesLabel = (n: number): string => `${n} ${n === 1 ? 'foe' : 'foes'} slain`;

/** Score avec séparateur de milliers fixe (indépendant de la langue du navigateur). */
export const fmtScore = (n: number): string => String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
