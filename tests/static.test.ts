// Tests du service des fichiers statiques (server/static.ts) : dossier temporaire, serveur HTTP local.
// Lancer : npm run test:static
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { loadStatic, serveStatic, type StaticSite } from '../server/static';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

// Garde-fou : un test réseau bloqué ne doit pas bloquer npm test.
setTimeout(() => {
  console.log('✘ délai global dépassé (30 s)');
  process.exit(1);
}, 30_000).unref();
// Garde-fou : sans bilan atteint (erreur avalée, boucle d'événements vidée), échec.
let reachedEnd = false;
process.on('exit', (code) => {
  if (reachedEnd || code !== 0) return;
  console.log('✘ suite interrompue avant son bilan');
  process.exitCode = 1;
});

// ─── Dossier temporaire : parent/secret.txt et parent/dist/… ────────────────

const SECRET = 'SECRET-NE-JAMAIS-SERVIR-7f3a';
const parent = mkdtempSync(join(tmpdir(), 'ronin-static-'));
const dist = join(parent, 'dist');
mkdirSync(join(dist, 'assets'), { recursive: true });
writeFileSync(join(parent, 'secret.txt'), SECRET);
const INDEX = '<!doctype html><html><head><title>Ronin.io</title></head><body><div id="game"></div></body></html>';
const APP = `// ${'ronin '.repeat(20)}\n` + Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i} * 2; // tranche ${i}`).join('\n');
const CSS = 'body{margin:0}';
writeFileSync(join(dist, 'index.html'), INDEX);
writeFileSync(join(dist, 'assets', 'app-abc123.js'), APP);
writeFileSync(join(dist, 'assets', 's.css'), CSS);
writeFileSync(join(dist, '.hidden'), 'caché');
writeFileSync(join(dist, 'robots.txt'), 'User-agent: *');
writeFileSync(join(dist, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
// Liens symboliques vers le parent (ignorés au chargement). Sous Windows, un lien de fichier peut exiger
// des droits : on tente, et on note ce qui a pu être créé ; la jonction de dossier n'en exige pas.
const links: string[] = [];
try {
  symlinkSync(join(parent, 'secret.txt'), join(dist, 'lien.txt'), 'file');
  links.push('/lien.txt');
} catch {
  /* droits insuffisants : cas non testé */
}
try {
  symlinkSync(parent, join(dist, 'lien'), 'junction');
  links.push('/lien/secret.txt');
} catch {
  /* idem */
}

// ─── (a) Chargement ─────────────────────────────────────────────────────────

const site = loadStatic(dist, { connectSrc: ['wss://ronin.example.test'] });
check('chargement : fichiers comptés (index, js, css, txt, bin ; .hidden ignoré)', site.files === 5, `files ${site.files}`);
check('chargement : taille totale', site.bytes === INDEX.length + Buffer.byteLength(APP) + CSS.length + 13 + 4, `bytes ${site.bytes}`);
check('chargement : « / » et « /index.html » désignent l’index', site.map.get('/') === site.map.get('/index.html') && !!site.map.get('/'));
check('chargement : .hidden absent de la table', !site.map.has('/.hidden'));
check(`chargement : liens symboliques ignorés (${links.length} créé(s))`, links.every((k) => !site.map.has(k)) && [...site.map.keys()].every((k) => !k.startsWith('/lien')), links.join(' '));
check('chargement : clés POSIX', [...site.map.keys()].every((k) => k.startsWith('/') && !k.includes('\\')), [...site.map.keys()].join(' '));
const app = site.map.get('/assets/app-abc123.js')!;
check('chargement : js > 1 Kio compressé (gzip et br)', !!app.gzip && !!app.br, `${app.body.length} o`);
check('chargement : css < 1 Kio non compressé', !site.map.get('/assets/s.css')!.gzip && !site.map.get('/assets/s.css')!.br);
check('chargement : binaire non compressé', !site.map.get('/blob.bin')!.gzip);
check('chargement : ETag sha1 court entre guillemets', /^"[0-9a-f]{8,40}"$/.test(app.etag), app.etag);
check('chargement : CSP avec connect-src supplémentaire', site.csp.includes("connect-src 'self' wss://ronin.example.test"), site.csp);

let threw = false;
const empty = join(parent, 'vide');
mkdirSync(empty);
writeFileSync(join(empty, 'other.html'), 'x');
try {
  loadStatic(empty, { connectSrc: [] });
} catch {
  threw = true;
}
check('chargement : sans index.html, loadStatic lève', threw);

// ─── (b) Serveur HTTP local ─────────────────────────────────────────────────

function serve(s: StaticSite, secure: boolean): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (!serveStatic(s, req, res, secure)) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as AddressInfo).port })));
}

interface Resp {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
/** Requête brute (chemin envoyé tel quel, sans normalisation par le client). */
function raw(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    sock.on('error', reject);
  });
}

try {
  const { server, port } = await serve(site, false);

  const idx = await get(port, '/');
  check('index : 200 et contenu', idx.status === 200 && idx.body.toString() === INDEX, `${idx.status}`);
  check('index : text/html; charset=utf-8', idx.headers['content-type'] === 'text/html; charset=utf-8', String(idx.headers['content-type']));
  check('index : no-cache', idx.headers['cache-control'] === 'no-cache', String(idx.headers['cache-control']));
  const csp = String(idx.headers['content-security-policy'] ?? '');
  check('index : CSP présente', csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes('https://fonts.gstatic.com'), csp);
  const idx2 = await get(port, '/index.html');
  check('index : /index.html identique à /', idx2.status === 200 && idx2.body.equals(idx.body) && idx2.headers.etag === idx.headers.etag);
  check('index : en-têtes de sécurité', idx.headers['x-content-type-options'] === 'nosniff' && idx.headers['x-frame-options'] === 'DENY' && idx.headers['referrer-policy'] === 'strict-origin-when-cross-origin' && idx.headers['cross-origin-opener-policy'] === 'same-origin');
  const pp = String(idx.headers['permissions-policy'] ?? '');
  check('index : Permissions-Policy sans gamepad', pp.includes('camera=()') && pp.includes('microphone=()') && !pp.includes('gamepad'), pp);
  check('sans secure : pas de HSTS', idx.headers['strict-transport-security'] === undefined);

  const js = await get(port, '/assets/app-abc123.js');
  check('js : 200, brut sans Accept-Encoding', js.status === 200 && js.body.toString() === APP && js.headers['content-encoding'] === undefined);
  check('js : text/javascript; charset=utf-8', js.headers['content-type'] === 'text/javascript; charset=utf-8', String(js.headers['content-type']));
  check('js : immutable', js.headers['cache-control'] === 'public, max-age=31536000, immutable', String(js.headers['cache-control']));
  check('js : Vary et Content-Length', js.headers.vary === 'Accept-Encoding' && Number(js.headers['content-length']) === Buffer.byteLength(APP));
  check('js : pas de CSP hors index', js.headers['content-security-policy'] === undefined);

  const br = await get(port, '/assets/app-abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
  check('br : préféré et décompressé = original', br.headers['content-encoding'] === 'br' && brotliDecompressSync(br.body).toString() === APP && Number(br.headers['content-length']) === br.body.length, String(br.headers['content-encoding']));
  const gz = await get(port, '/assets/app-abc123.js', { 'accept-encoding': 'gzip' });
  check('gzip : décompressé = original', gz.headers['content-encoding'] === 'gzip' && gunzipSync(gz.body).toString() === APP && Number(gz.headers['content-length']) === gz.body.length);
  const noBr = await get(port, '/assets/app-abc123.js', { 'accept-encoding': 'br;q=0, gzip' });
  check('Accept-Encoding : br;q=0 refusé, gzip retenu', noBr.headers['content-encoding'] === 'gzip');

  const css = await get(port, '/assets/s.css', { 'accept-encoding': 'br, gzip' });
  check('css : text/css; charset=utf-8, brut (petit)', css.headers['content-type'] === 'text/css; charset=utf-8' && css.headers['content-encoding'] === undefined && css.body.toString() === CSS);
  const txt = await get(port, '/robots.txt');
  check('txt : text/plain; charset=utf-8, max-age=3600', txt.headers['content-type'] === 'text/plain; charset=utf-8' && txt.headers['cache-control'] === 'public, max-age=3600');
  const bin = await get(port, '/blob.bin');
  check('inconnu : application/octet-stream', bin.headers['content-type'] === 'application/octet-stream');

  const etag = String(js.headers.etag);
  const nm = await get(port, '/assets/app-abc123.js', { 'if-none-match': etag });
  check('If-None-Match : 304 sans corps', nm.status === 304 && nm.body.length === 0, `${nm.status}`);
  const nmw = await get(port, '/assets/app-abc123.js', { 'if-none-match': `"zzz", W/${etag}` });
  check('If-None-Match : liste et préfixe faible', nmw.status === 304);
  const nmx = await get(port, '/assets/app-abc123.js', { 'if-none-match': '"autre"' });
  check('If-None-Match : autre ETag → 200', nmx.status === 200);

  const head = await get(port, '/assets/app-abc123.js', { 'accept-encoding': 'br' }, 'HEAD');
  check('HEAD : 200, Content-Length de la version br, sans corps', head.status === 200 && head.body.length === 0 && Number(head.headers['content-length']) === br.body.length, `${head.headers['content-length']}`);
  const post = await get(port, '/', {}, 'POST');
  check('POST : non servi', post.status === 404);

  // Chemins refusés : rien hors de la table, le secret n'apparaît jamais.
  const bad = ['/nope', '/../secret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/.hidden', '/index.html%00', '/%00', '/%E0%A4%A', '/secret.txt', '/..%5c..%5csecret.txt'];
  for (const p of bad) {
    const r = await get(port, p);
    check(`refusé : ${p}`, r.status === 404 && !r.body.toString().includes(SECRET), `${r.status}`);
  }
  for (const p of links) {
    const r = await get(port, p);
    check(`refusé (lien) : ${p}`, r.status === 404 && !r.body.toString().includes(SECRET), `${r.status}`);
  }
  for (const p of ['/assets\\..\\..\\secret.txt', '/../../secret.txt', '/assets/../../secret.txt', '/.hidden']) {
    const r = await raw(port, p);
    check(`refusé (brut) : ${p}`, r.startsWith('HTTP/1.1 404') && !r.includes(SECRET) && !r.includes('caché'), r.split('\r\n')[0]);
  }
  await new Promise<void>((r) => server.close(() => r()));

  // HTTPS (derrière Traefik) : HSTS ajouté.
  const sec = await serve(site, true);
  const s1 = await get(sec.port, '/');
  check('secure : HSTS présent', s1.headers['strict-transport-security'] === 'max-age=15552000', String(s1.headers['strict-transport-security']));
  const s2 = await get(sec.port, '/assets/s.css');
  check('secure : HSTS aussi sur les ressources', s2.headers['strict-transport-security'] === 'max-age=15552000');
  await new Promise<void>((r) => sec.server.close(() => r()));
} catch (err) {
  check('scénario HTTP sans exception', false, String((err as Error)?.stack ?? err).slice(0, 400));
}

rmSync(parent, { recursive: true, force: true });

reachedEnd = true;
if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
} else console.log('\nTous les tests du service statique passent.');
