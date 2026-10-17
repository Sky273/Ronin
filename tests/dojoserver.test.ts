// Tests du serveur du dojo (DojoSession, DojoRoom, vraie salle avec des clients SDK, banc réseau).
// Lancer : npm run test:dojoserver
import { createWorld } from '../shared/world';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

check('monde du dojo (squelette : la salle et la session viennent au lot B)', createWorld(1, { mode: 'dojo' }).mode === 'dojo');

if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
} else console.log('\nTous les tests du serveur du dojo passent.');
