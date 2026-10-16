import { biomeForStage } from './biomes';
import { buildLevel, type Level } from './level';
import { generateLevel } from './levelgen';
import { stageSeed } from './math';

/** Niveau de l'étape `stage` : l'étape 0 est le niveau historique, les suivantes sont générées. */
export function buildStage(stage: number, worldSeed: number): Level {
  if (stage === 0) return buildLevel();
  return generateLevel(stageSeed(worldSeed, stage), stage, biomeForStage(stage));
}
