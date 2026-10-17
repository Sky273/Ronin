// Tests des limites par adresse IP et du contrôle d'origine (M6) : adresse client derrière Traefik, débit,
// connexions simultanées, journal agrégé, sans réseau.
// Lancer : npm run test:limits
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { clientIp, ConnCounter, isSecure, MAX_KEYS, originAllowed, RateBuckets, RefusalLog } from '../server/limits';
import { keyOf } from '../server/limits';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

function req(peer: string | undefined, headers: IncomingHttpHeaders = {}, encrypted = false) {
  return { socket: { remoteAddress: peer, encrypted }, headers };
}

// --- Adresse du client ---
{
  const xff = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' };
  check('trustProxy 0 : X-Forwarded-For ignoré', clientIp(req('10.0.1.5', xff), 0) === '10.0.1.5');
  check('pair public : X-Forwarded-For ignoré', clientIp(req('8.8.8.8', xff), 1) === '8.8.8.8');
  const ip = clientIp(req('10.0.1.5', xff), 1);
  check('pair 10.0.1.5, trustProxy 1 : élément ajouté par Traefik', ip === '2.2.2.2', ip);
  const ip2 = clientIp(req('172.18.0.3', { 'x-forwarded-for': '6.6.6.6, 1.1.1.1, 2.2.2.2' }), 2);
  check('trustProxy 2 : avant-dernier élément', ip2 === '1.1.1.1', ip2);
  const short = clientIp(req('192.168.1.2', { 'x-forwarded-for': '3.3.3.3' }), 2);
  check('chaîne trop courte : élément le plus à gauche', short === '3.3.3.3', short);
  const empty = clientIp(req('10.0.0.2', { 'x-forwarded-for': '1.1.1.1, ' }), 1);
  check('élément vide : le pair', empty === '10.0.0.2', empty);
  check('X-Forwarded-For absent : le pair', clientIp(req('10.0.1.5'), 1) === '10.0.1.5');
  check('IPv6 mappé normalisé (pair public)', clientIp(req('::ffff:8.8.4.4', xff), 1) === '8.8.4.4');
  const mapped = clientIp(req('::ffff:10.0.1.5', { 'x-forwarded-for': '1.1.1.1, ::ffff:9.9.9.9' }), 1);
  check('pair IPv6 mappé privé : de confiance, XFF normalisé', mapped === '9.9.9.9', mapped);
  check('en-têtes multiples joints', clientIp(req('127.0.0.1', { 'x-forwarded-for': ['1.1.1.1', '4.4.4.4'] as unknown as string }), 1) === '4.4.4.4');
  check('boucle locale IPv6 de confiance', clientIp(req('::1', xff), 1) === '2.2.2.2');
  check('ULA fd00::/8 de confiance', clientIp(req('fd12:3456::1', xff), 1) === '2.2.2.2');
  check('lien local fe80::/10 de confiance', clientIp(req('fe80::1', xff), 1) === '2.2.2.2');
  check('100.64/10 de confiance', clientIp(req('100.100.0.1', xff), 1) === '2.2.2.2');
  check('100.128.0.1 hors 100.64/10', clientIp(req('100.128.0.1', xff), 1) === '100.128.0.1');
  check('172.32.0.1 hors RFC 1918', clientIp(req('172.32.0.1', xff), 1) === '172.32.0.1');
  check('IPv6 public non de confiance', clientIp(req('2001:db8::1', xff), 1) === '2001:db8:0:0::/64'); // clé de limite : son /64
  check('pair inconnu : chaîne vide', clientIp(req(undefined, xff), 1) === '');
}

// --- Connexion chiffrée ---
{
  const https = { 'x-forwarded-proto': 'https' };
  check('isSecure : proto https depuis un pair de confiance', isSecure(req('10.0.1.5', https), 1));
  check('isSecure : pair public, en-tête ignoré', !isSecure(req('8.8.8.8', https), 1));
  check('isSecure : trustProxy 0, en-tête ignoré', !isSecure(req('10.0.1.5', https), 0));
  check('isSecure : proto http', !isSecure(req('10.0.1.5', { 'x-forwarded-proto': 'http' }), 1));
  check('isSecure : socket TLS', isSecure(req('8.8.8.8', {}, true), 0));
}

// --- Origine ---
{
  const allowed = ['https://ronin.apps.cr1ms0n.cloud'];
  check('origine autorisée (casse et « / » final nettoyés)', originAllowed('HTTPS://Ronin.apps.cr1ms0n.cloud/', allowed));
  check('origine hors liste refusée', !originAllowed('https://evil.example', allowed));
  check('origine absente acceptée (bots, curl)', originAllowed(undefined, allowed));
  check('liste vide : toute origine acceptée', originAllowed('https://evil.example', []));
}

// --- Débit ---
{
  let t = 0;
  const rb = new RateBuckets(6, 3, () => t); // un jeton toutes les 10 s, rafale de 3
  const burst = [rb.take('a'), rb.take('a'), rb.take('a')];
  check('rafale de 3 permise', burst.every((x) => x === 0), burst.join(','));
  const wait = rb.take('a');
  check('4e refusée : 10 s avant un jeton', wait === 10, String(wait));
  check('autre clé indépendante', rb.take('b') === 0);
  t = 4_000;
  const wait2 = rb.take('a');
  check('après 4 s : encore 6 s', wait2 === 6, String(wait2));
  t = 9_999.5;
  check('arrondi au-dessus, au moins 1 s', rb.take('a') === 1);
  t = 10_000;
  check('rechargée après 10 s : un jeton', rb.take('a') === 0 && rb.take('a') > 0);
  t = 200_000;
  check('rechargée longtemps après : rafale complète', [rb.take('a'), rb.take('a'), rb.take('a')].every((x) => x === 0) && rb.take('a') > 0);
  const free = new RateBuckets(0, 0, () => t);
  let ok = true;
  for (let i = 0; i < 1000; i++) ok = ok && free.take('x') === 0;
  check('perMin 0 : toujours permis, rien de suivi', ok && free.size === 0);
}

// --- Bornes de mémoire ---
{
  let t = 0;
  const rb = new RateBuckets(60, 5, () => t);
  let ok = true;
  for (let i = 0; i < 20_000; i++) ok = ok && rb.take(`k${i}`) === 0;
  check('20 000 clés : toutes servies, plafond respecté', ok && rb.size <= MAX_KEYS, `${rb.size} clés`);
  t = 30_000;
  rb.take('k19999');
  rb.take('k19999');
  t = 61_000; // seaux pleins au bout d'une minute : balayage paresseux
  rb.take('z');
  check('balayage paresseux des seaux pleins', rb.size <= 2, `${rb.size} clés`);
  const spread = new RateBuckets(1, 1, () => t);
  for (let i = 0; i < 20_000; i++) spread.take(`s${i}`);
  check('seaux non pleins (attaque) : éviction, plafond respecté', spread.size <= MAX_KEYS, `${spread.size} clés`);
  check('clé récente conservée après éviction', spread.take('s19999') > 0);
}

// --- Connexions simultanées ---
{
  const cc = new ConnCounter(2);
  const a = new EventEmitter();
  const b = new EventEmitter();
  const c = new EventEmitter();
  check('1re et 2e connexions permises', cc.tryOpen('ip', a) && cc.tryOpen('ip', b) && cc.count('ip') === 2);
  check('3e refusée', !cc.tryOpen('ip', c) && cc.count('ip') === 2);
  check('autre clé indépendante', cc.tryOpen('autre', c) && cc.count('autre') === 1);
  a.on('error', () => {}); // écouteur de test : sans lui, emit('error') lèverait
  a.emit('error', new Error('reset'));
  a.emit('close');
  a.emit('close');
  check('close + error : une seule décrémentation', cc.count('ip') === 1, String(cc.count('ip')));
  check('place rendue : nouvelle connexion permise', cc.tryOpen('ip', new EventEmitter()));
  b.emit('close');
  c.emit('close');
  check('aucune clé à 0 ne survit', cc.count('autre') === 0 && cc.size === 1, `${cc.size} clé(s)`);
  const free = new ConnCounter(0);
  let ok = true;
  for (let i = 0; i < 100; i++) ok = ok && free.tryOpen('x', new EventEmitter());
  check('max 0 : illimité, rien de suivi', ok && free.size === 0);
}

// --- Journal agrégé ---
{
  let t = 0;
  const lines: string[] = [];
  const log = new RefusalLog(() => t, (l) => lines.push(l));
  for (let i = 0; i < 12; i++) log.note('rate');
  log.note('origin');
  log.note('origin');
  log.note('origin');
  check('rien avant une minute', lines.length === 0);
  t = 30_000;
  log.note('method');
  log.tick();
  check('toujours rien à 30 s', lines.length === 0);
  t = 60_000;
  log.tick();
  check('une ligne à 60 s', lines.length === 1, lines[0] ?? '');
  check('ligne agrégée', lines[0] === '[serveur] refus en 60 s : débit 12, origine 3, connexions 0, méthode 1', lines[0] ?? '');
  t = 61_000;
  log.note('conn');
  t = 100_000;
  log.note('conn');
  log.tick();
  check('au plus une ligne par minute', lines.length === 1);
  t = 121_000;
  log.note('rate'); // écrit la fenêtre précédente avant d'en ouvrir une nouvelle
  check('fenêtre suivante écrite au refus suivant', lines.length === 2 && lines[1].includes('connexions 2') && lines[1].includes('débit 0'), lines[1] ?? '');
  t = 500_000;
  log.tick();
  log.tick();
  check('rafale isolée écrite par tick, une seule fois', lines.length === 3 && lines[2].includes('débit 1'));
  check('aucune adresse IP dans le journal', lines.every((l) => !/\d+\.\d+\.\d+\.\d+|::/.test(l)));
  t = 900_000;
  log.tick();
  check('pas de ligne sans refus', lines.length === 3);
}

// IPv6 regroupé par /64 (clé de limite).
check('keyOf : IPv4 inchangée', keyOf('203.0.113.9') === '203.0.113.9');
check('keyOf : IPv6 réduite à son /64, formes équivalentes identiques', keyOf('2001:db8:1:2::a') === '2001:db8:1:2::/64' && keyOf('2001:0db8:0001:0002:ffff:0:0:1') === '2001:db8:1:2::/64' && keyOf('2001:db8::1') === '2001:db8:0:0::/64', keyOf('2001:db8::1'));

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests des limites passent.');
