import type { BiomeId } from './biomes';
import { buildLevel, type Level } from './level';

/**
 * Génère le niveau d'une étape à partir de segments conçus à la main (déterministe :
 * même graine → même niveau). Bouchon des fondations : géométrie historique, biome demandé.
 */
export function generateLevel(seed: number, stage: number, biome: BiomeId): Level {
  void seed;
  return { ...buildLevel(), stage, biome };
}
