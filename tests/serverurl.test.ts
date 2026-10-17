// Tests du choix de l'adresse du serveur (variable Vite, développement, même origine en production).
// Lancer : npm run test:serverurl
import { DEV_SERVER_URL, resolveServerUrl } from '../client/net/serverUrl';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const https = { protocol: 'https:', host: 'ronin.apps.cr1ms0n.cloud' };
const httpsPort = { protocol: 'https:', host: 'ronin.example:8443' };
const http = { protocol: 'http:', host: '192.168.1.10:2567' };

check('serveur local de développement', DEV_SERVER_URL === 'ws://localhost:2567');
check('variable prioritaire et nettoyée (même en production)',
  resolveServerUrl('  wss://autre.example  ', https, false) === 'wss://autre.example' &&
  resolveServerUrl(' ws://lan:2567\n', null, true) === 'ws://lan:2567');
check('variable vide ou blanche : ignorée', resolveServerUrl('   ', https, false) === 'wss://ronin.apps.cr1ms0n.cloud' && resolveServerUrl('', null, true) === DEV_SERVER_URL);
check('dev : localhost même depuis une page https', resolveServerUrl(undefined, https, true) === DEV_SERVER_URL);
check('page https : wss sur la même origine', resolveServerUrl(undefined, https, false) === 'wss://ronin.apps.cr1ms0n.cloud', resolveServerUrl(undefined, https, false));
check('page https avec port : port conservé', resolveServerUrl(undefined, httpsPort, false) === 'wss://ronin.example:8443');
check('page http : ws sur la même origine, port conservé', resolveServerUrl(undefined, http, false) === 'ws://192.168.1.10:2567', resolveServerUrl(undefined, http, false));
check('pas de page (hors navigateur) : localhost', resolveServerUrl(undefined, null, false) === DEV_SERVER_URL);
check('page sans hôte (file:) : localhost', resolveServerUrl(undefined, { protocol: 'file:', host: '' }, false) === DEV_SERVER_URL);

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log("\nTous les tests de l'adresse du serveur passent.");
