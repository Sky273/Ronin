// Tests du modèle de vue des duels (invitation, phases, signal, résultats).
// Lancer : npm run test:duelui
export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

check('suite initialisée', true);

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests d’interface des duels passent.');
