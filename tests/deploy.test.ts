// Tests de bout en bout de la mise en ligne (M6) : fichiers du jeu servis avec le WebSocket, limites par IP,
// contrôle d'origine, méthodes de matchmaking, santé, arrêt propre sur SIGTERM.
// Lancer : npm run test:deploy
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@colyseus/sdk';
import { MSG, ROOMS } from '../shared/net/protocol';
import { startServer } from '../server/app';
import { NO_GUARD, type GuardOptions } from '../server/config';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}
setTimeout(() => {
  console.log('✘ délai global dépassé (90 s)');
  process.exit(1);
}, 90_000).unref();
let reachedEnd = false;
process.on('exit', (code) => {
  if (reachedEnd || code !== 0) return;
  console.log('✘ suite interrompue avant son bilan');
  process.exitCode = 1;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end && !cond()) await sleep(20);
  return cond();
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
/** Requête HTTP simple (en-têtes au choix). */
function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
/** Demande d'upgrade WebSocket brute : première ligne de la réponse. */
function upgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const s = netConnect(port, '127.0.0.1', () => {
      const h = Object.entries({ host: `127.0.0.1:${port}`, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers })
        .map(([k, v]) => `${k}: ${v}`).join('\r\n');
      s.write(`GET /x/y HTTP/1.1\r\n${h}\r\n\r\n`);
    });
    let data = '';
    s.on('data', (d) => (data += d.toString()));
    s.on('close', () => resolve(data.split('\r\n')[0]));
    s.on('error', () => resolve(data.split('\r\n')[0] || 'erreur'));
    setTimeout(() => s.destroy(), 1500);
  });
}
const enter = (port: number, name: string) => new Client(`ws://127.0.0.1:${port}`).joinOrCreate(ROOMS.coop, { name });

// Dossier du jeu factice : index, un module haché, et un fichier secret hors du dossier.
const root = mkdtempSync(join(tmpdir(), 'ronin-deploy-'));
const dist = join(root, 'dist');
mkdirSync(join(dist, 'assets'), { recursive: true });
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Ronin.io</title><script type="module" src="/assets/app-abc123.js"></script>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), `console.log(${JSON.stringify('x'.repeat(4000))});`);
writeFileSync(join(root, 'secret.txt'), 'SECRET');

// ─── (a) Fichiers du jeu et WebSocket sur la même origine ──────────────────
{
  const srv = await startServer({ port: 0, staticDir: dist, matchmakeMethods: ['joinOrCreate'] });
  try {
    const index = await http(srv.port, 'GET', '/');
    check('/ : index.html, no-cache, CSP', index.status === 200 && /Ronin\.io/.test(index.body) && index.headers['cache-control'] === 'no-cache' && !!index.headers['content-security-policy']);
    const js = await http(srv.port, 'GET', '/assets/app-abc123.js', { 'accept-encoding': 'br, gzip' });
    check('/assets/… : immutable, compressé', js.status === 200 && /immutable/.test(String(js.headers['cache-control'])) && js.headers['content-encoding'] === 'br');
    const secret = await http(srv.port, 'GET', '/../secret.txt');
    check('traversée de répertoire : refusée (400), rien du secret', (secret.status === 400 || secret.status === 404) && !secret.body.includes('SECRET'));
    const health = await http(srv.port, 'GET', '/health');
    check('/health : 200 ok', health.status === 200 && JSON.parse(health.body).ok === true);
    const mm = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', {}, '{"name":"a"}');
    check('matchmaking joinOrCreate : 200', mm.status === 200, `${mm.status} ${mm.body.slice(0, 80)}`);
    const create = await http(srv.port, 'POST', '/matchmake/create/coop', {}, '{}');
    check('méthode de matchmaking non permise (create) : 404', create.status === 404);
    const sneaky = await Promise.all(['/x/../matchmake/create/coop', '/%2e%2e/matchmake/create/coop', '/./matchmake/create/coop'].map((p) => http(srv.port, 'POST', p, {}, '{}')));
    check('chemins non normalisés (/x/../matchmake…, %2e%2e, /./) : 400, aucune salle créée', sneaky.every((r) => r.status === 400), sneaky.map((r) => r.status).join(','));
    const raw = (path: string) =>
      new Promise<string>((resolve) => {
        const sock = netConnect(srv.port, '127.0.0.1', () =>
          sock.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`),
        );
        let d = '';
        sock.on('data', (x) => (d += x.toString()));
        sock.on('close', () => resolve(d));
        sock.on('error', () => resolve(d));
      });
    const backslash = await Promise.all(['/matchmake\\create/coop', '/matchmake\\joinOrCreate/coop'].map(raw));
    check('antislash dans le chemin (/matchmake\\create…) : refusé, aucune salle', backslash.every((r) => r.startsWith('HTTP/1.1 400') && !r.includes('roomId')), backslash.map((r) => r.split('\r\n')[0]).join(' | '));
    const bad = await http(srv.port, 'GET', '/', { host: 'x:99999' });
    check('requête malformée (Host invalide) : toujours 400', bad.status === 400);
    const room = await enter(srv.port, 'Luc');
    let welcomed = false;
    room.onMessage(MSG.welcome, () => (welcomed = true));
    room.onMessage(MSG.snap, () => undefined);
    check('client SDK : accueil reçu (WebSocket à côté des fichiers du jeu)', await waitFor(() => welcomed, 3000));
    await room.leave(true);
  } finally {
    await srv.stop();
  }
}

// ─── (b) Limites par IP et contrôle d'origine ──────────────────────────────
{
  const guard: GuardOptions = { ...NO_GUARD, trustProxy: 1, allowedOrigins: ['https://ronin.test'], matchmakePerMin: 6, matchmakeBurst: 3, maxConnPerIp: 2 };
  const srv = await startServer({ port: 0, guard });
  try {
    const evil = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', { origin: 'https://evil.test' }, '{}');
    check('origine étrangère : 403 au matchmaking', evil.status === 403);
    check('origine étrangère : 403 à l\'upgrade WebSocket', /403/.test(await upgrade(srv.port, { origin: 'https://evil.test' })));
    const ok = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', { origin: 'https://ronin.test' }, '{}');
    check('origine du jeu : 200', ok.status === 200);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', {}, '{}')).status);
    const limited = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', {}, '{}');
    check('au-delà de la rafale : 429 avec Retry-After', statuses.slice(0, 2).every((s) => s === 200) && limited.status === 429 && !!limited.headers['retry-after'], statuses.join(','));
    const other = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', { 'x-forwarded-for': '203.0.113.9' }, '{}');
    check('derrière le proxy (pair local) : autre IP, autre seau', other.status === 200);
    const forged = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', { 'x-forwarded-for': '203.0.113.9, 127.0.0.1' }, '{}');
    const pre = await http(srv.port, 'OPTIONS', '/matchmake/joinOrCreate/coop', { origin: 'https://ronin.test', 'access-control-request-method': 'POST' });
    check('préflight OPTIONS de la bonne origine : pas refusé par la limite', pre.status !== 429 && pre.status !== 403, `${pre.status}`);
    const preEvil = await http(srv.port, 'OPTIONS', '/matchmake/joinOrCreate/coop', { origin: 'https://evil.test' });
    check("préflight OPTIONS d'une origine étrangère : 403", preEvil.status === 403);
    const v6a = await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', { 'x-forwarded-for': '2001:db8:1:2::a' }, '{}');
    const v6s: number[] = [];
    for (let i = 0; i < 3; i++) v6s.push((await http(srv.port, 'POST', '/matchmake/joinOrCreate/coop', { 'x-forwarded-for': `2001:db8:1:2::${i + 100}` }, '{}')).status);
    check("IPv6 : adresses d'un même /64 partagent la limite", v6a.status === 200 && v6s.includes(429), `${v6a.status} ${v6s.join(',')}`);
    check('X-Forwarded-For falsifié à gauche : seau de l\'adresse ajoutée par le proxy (toujours limité)', forged.status === 429);
  } finally {
    await srv.stop();
  }
  const drain = await startServer({ port: 0, guard: { ...NO_GUARD, matchmakePerMin: 6, matchmakeBurst: 3 } });
  try {
    for (let i = 0; i < 10; i++) await http(drain.port, 'GET', '/matchmake/joinOrCreate/coop');
    const after = await http(drain.port, 'POST', '/matchmake/joinOrCreate/coop', {}, '{}');
    check("des GET (ex. images d'une page tierce) ne vident pas le seau : le POST suivant passe", after.status === 200, `${after.status}`);
  } finally {
    await drain.stop();
  }
  const noTrust = await startServer({ port: 0, guard: { ...guard, trustProxy: 0, allowedOrigins: [] } });
  try {
    for (let i = 0; i < 3; i++) await http(noTrust.port, 'POST', '/matchmake/joinOrCreate/coop', {}, '{}');
    const spoof = await http(noTrust.port, 'POST', '/matchmake/joinOrCreate/coop', { 'x-forwarded-for': '198.51.100.7' }, '{}');
    check('sans proxy de confiance : X-Forwarded-For ignoré (limite non contournée)', spoof.status === 429);
  } finally {
    await noTrust.stop();
  }
  const conn = await startServer({ port: 0, guard: { ...NO_GUARD, maxConnPerIp: 2 } });
  try {
    const a = await enter(conn.port, 'A');
    const b = await enter(conn.port, 'B');
    let third = '';
    try {
      await enter(conn.port, 'C');
      third = 'accepté';
    } catch (e) {
      third = (e as Error).message || 'refusé';
    }
    check('troisième connexion de la même IP : refusée', third !== 'accepté', third);
    await a.leave(true);
    await sleep(200);
    let fourth = false;
    try {
      const d = await enter(conn.port, 'D');
      fourth = true;
      await d.leave(true);
    } catch {
      fourth = false;
    }
    check('après un départ : une place se libère', fourth);
    await b.leave(true);
  } finally {
    await conn.stop();
  }
}

// ─── (c) Arrêt propre sur SIGTERM (processus réel) ─────────────────────────
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = fork(join(process.cwd(), 'tests', 'net', 'shutdownChild.ts'), [], {
    env: { ...process.env, PORT: String(port), STATS_EVERY_MS: '0' },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  child.stdout?.on('data', (d) => (out += d.toString()));
  child.stderr?.on('data', (d) => (out += d.toString()));
  let code: number | null = null;
  child.on('exit', (c) => (code = c ?? -1));
  const up = await waitFor(() => out.includes('en écoute'), 20000);
  check('serveur enfant démarré', up, out.slice(0, 200));
  if (up) {
    const room = await enter(port, 'Luc');
    let left = -1;
    room.onLeave((c) => (left = c));
    room.onMessage('*', () => undefined);
    const t0 = performance.now();
    child.send('term');
    const closed = await waitFor(() => left >= 0, 5000);
    check('SIGTERM : joueur prévenu (code 4001, « server is restarting »)', closed && left === 4001, `code ${left}`);
    const exited = await waitFor(() => code !== null, 10000);
    check('SIGTERM : sortie en code 0 avant le SIGKILL de Docker (10 s)', exited && code === 0 && performance.now() - t0 < 10000, `code ${code}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    check('SIGTERM : journal « arrêté »', out.includes('arrêté'));
  }
  if (code === null) child.kill();
}

rmSync(root, { recursive: true, force: true });
reachedEnd = true;
if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
} else console.log('\nTous les tests de mise en ligne passent.');
