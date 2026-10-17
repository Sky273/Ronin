// Tests de la configuration du serveur par variables d'environnement (production).
// Lancer : npm run test:config
import { resolve } from 'node:path';
import { cleanOrigin, NO_GUARD, optionsFromEnv } from '../server/config';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const dev = optionsFromEnv({}, '/app');
check('sans variable : port 2567, pas de statiques, aucun contrôle', dev.port === 2567 && dev.staticDir === undefined && JSON.stringify(dev.guard) === JSON.stringify(NO_GUARD));
check('PORT valide lu, invalide ignoré', optionsFromEnv({ PORT: '8080' }).port === 8080 && optionsFromEnv({ PORT: 'abc' }).port === 2567 && optionsFromEnv({ PORT: '70000' }).port === 2567 && optionsFromEnv({ PORT: '0' }).port === 2567);
check('STATIC_DIR résolu par rapport au dossier courant', optionsFromEnv({ STATIC_DIR: 'dist' }, '/app').staticDir === resolve('/app', 'dist'));
check('STATIC_DIR vide : pas de statiques', optionsFromEnv({ STATIC_DIR: '  ' }).staticDir === undefined);
const prod = optionsFromEnv({ TRUST_PROXY: '1', ALLOWED_ORIGINS: ' https://Ronin.apps.cr1ms0n.cloud/ ,http://localhost:8080', MATCHMAKE_PER_MIN: '20', MATCHMAKE_BURST: '10', MAX_CONN_PER_IP: '8' });
check('production : limites et proxy lus', prod.guard.trustProxy === 1 && prod.guard.matchmakePerMin === 20 && prod.guard.matchmakeBurst === 10 && prod.guard.maxConnPerIp === 8);
check('origines nettoyées (minuscules, sans « / » final ni espaces)', JSON.stringify(prod.guard.allowedOrigins) === JSON.stringify(['https://ronin.apps.cr1ms0n.cloud', 'http://localhost:8080']), prod.guard.allowedOrigins.join(','));
check('rafale par défaut : moitié du débit', optionsFromEnv({ MATCHMAKE_PER_MIN: '21' }).guard.matchmakeBurst === 11);
check('valeurs invalides : défaut', optionsFromEnv({ TRUST_PROXY: '-1', MAX_CONN_PER_IP: '2.5', MATCHMAKE_PER_MIN: 'x' }).guard.trustProxy === 0 &&
  optionsFromEnv({ MAX_CONN_PER_IP: '2.5' }).guard.maxConnPerIp === 0 && optionsFromEnv({ MATCHMAKE_PER_MIN: 'x' }).guard.matchmakePerMin === 0);
check('cleanOrigin', cleanOrigin(' HTTPS://A.B// ') === 'https://a.b');

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de configuration passent.');
