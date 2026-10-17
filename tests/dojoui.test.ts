// Tests de l'interface du dojo (tableau du tournoi, lignes d'état, libellés) : modèle pur, sans Phaser.
// Lancer : npm run test:dojoui
import { DUEL_WHY } from '../shared/constants';
import { whyLabel } from '../client/ui/duelView';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

check('libellés des issues du dojo (ABSENT, LOT, SUSPECT)', [DUEL_WHY.ABSENT, DUEL_WHY.LOT, DUEL_WHY.SUSPECT].every((c) => whyLabel(c).kanji !== ''));

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log("\nTous les tests de l'interface du dojo passent.");
