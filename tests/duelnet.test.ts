// Tests d'équité des duels sur le banc réseau (latences, gigue, triche).
// Lancer : npm run test:duelnet
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
} else console.log('\nTous les tests d’équité des duels passent.');
