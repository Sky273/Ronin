// Tests des niveaux générés (étapes 2 et suivantes).
// Lancer : npm run test:levelgen
import { BIOME_ORDER, biomeForStage } from '../shared/biomes';
import { stageSeed } from '../shared/math';
import { buildStage } from '../shared/stagebuild';
import { addPlayer, createWorld, nextStage } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Empreinte d'un niveau : tuiles, décors, ennemis, sanctuaires, arène et porte. */
function fingerprint(l: ReturnType<typeof buildStage>): string {
  return JSON.stringify({ w: l.w, t: Array.from(l.tiles), d: l.decos, e: l.enemySpawns, c: l.checkpoints, a: l.arena, g: l.gate, s: l.spawn, b: l.biome });
}

// ─── Fondations ─────────────────────────────────────────────────────────────
check('étape 0 = forêt de bambous historique', buildStage(0, 123).biome === 'bamboo' && buildStage(0, 123).stage === 0 && buildStage(0, 1).w === 224);
check('biomes en cycle', [0, 1, 2, 3, 4, 5].map(biomeForStage).join(',') === 'bamboo,village,snow,castle,bamboo,village');
check('graine d’étape déterministe et variée', stageSeed(7, 3) === stageSeed(7, 3) && stageSeed(7, 3) !== stageSeed(7, 4) && stageSeed(7, 3) !== stageSeed(8, 3));
check('buildStage déterministe', fingerprint(buildStage(3, 42)) === fingerprint(buildStage(3, 42)));
{
  const w = createWorld(5);
  addPlayer(w, 'pilgrim');
  const level = w.level;
  nextStage(w);
  check('nextStage : étape 1 = village, même référence de niveau', w.level === level && w.level.stage === 1 && w.level.biome === 'village');
}
check('4 biomes définis', BIOME_ORDER.length === 4);

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de niveaux passent.');
