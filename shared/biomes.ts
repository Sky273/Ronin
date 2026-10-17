import type { DecoKind } from './level';
import type { EnemyType } from './types';

// Biomes successifs du voyage : chaque étape change de paysage (décor, ennemis de départ).
// L'étape 0 est toujours la forêt de bambous historique ; ensuite le cycle se répète.

// 'dojo' : salle du tournoi (hors du voyage, jamais dans BIOME_ORDER).
export type BiomeId = 'bamboo' | 'village' | 'snow' | 'castle' | 'dojo';

export const BIOME_ORDER: BiomeId[] = ['bamboo', 'village', 'snow', 'castle'];

export interface BiomeDef {
  name: string; // affiché (anglais)
  kanji: string;
  subtitle: string;
  /** Décors tirés par le générateur, avec leur poids relatif. */
  decos: [DecoKind, number][];
  /** Ennemis placés au départ, avec leur poids relatif (la horde, elle, ne change pas). */
  enemies: [EnemyType, number][];
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
  bamboo: {
    name: 'the bamboo forest',
    kanji: '竹',
    subtitle: 'wind through the stalks',
    decos: [['bamboo', 5], ['pine', 2], ['stone', 2], ['lantern', 1], ['sakura', 1], ['banner', 1]],
    enemies: [['ashigaru', 5], ['archer', 2], ['ninja', 1], ['oni', 1]],
  },
  village: {
    name: 'the burning village',
    kanji: '炎',
    subtitle: 'ash falls like snow',
    decos: [['house', 5], ['banner', 2], ['lantern', 2], ['stone', 1], ['sakura', 1]],
    enemies: [['ashigaru', 5], ['archer', 3], ['oni', 1], ['ninja', 1]],
  },
  snow: {
    name: 'the snowy pass',
    kanji: '雪',
    subtitle: 'every step leaves a mark',
    decos: [['pine', 5], ['stone', 3], ['shrine', 1], ['lantern', 1]],
    enemies: [['ashigaru', 4], ['ninja', 3], ['archer', 2], ['oni', 1]],
  },
  castle: {
    name: 'the castle',
    kanji: '城',
    subtitle: 'the lord awaits behind the walls',
    decos: [['rampart', 5], ['banner', 3], ['lantern', 2], ['pine', 1]],
    enemies: [['ashigaru', 4], ['oni', 3], ['archer', 2], ['ninja', 1]],
  },
  dojo: {
    name: 'the dojo',
    kanji: '道場',
    subtitle: 'one blade, one breath',
    decos: [['scroll', 1], ['rack', 1], ['lantern', 1]],
    enemies: [],
  },
};

/** Biome d'une étape (0 = forêt de bambous, puis le cycle). */
export function biomeForStage(stage: number): BiomeId {
  return BIOME_ORDER[((stage % BIOME_ORDER.length) + BIOME_ORDER.length) % BIOME_ORDER.length];
}
