// Tests du serveur (session pure, puis serveur réel en local avec des clients SDK).
// Lancer : npm run test:server
import { Client, type Room } from '@colyseus/sdk';
import { BTN } from '../shared/input';
import { BUTTON_MASK, MSG, PLAYER_COLORS, type SnapshotMsg, type WelcomeMsg } from '../shared/net/protocol';
import { startServer } from '../server/app';
import { LagLine } from '../server/lag';
import { MAX_INPUT_QUEUE, MAX_STEPS_PER_UPDATE, CoopSession } from '../server/session';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const STEP_MS = 1000 / 60;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// Garde-fou : un test réseau bloqué ne doit pas bloquer npm test.
setTimeout(() => {
  console.log('✘ délai global dépassé (60 s)');
  process.exit(1);
}, 60_000).unref();

// ─── (a) CoopSession seule ──────────────────────────────────────────────────

const player = (s: CoopSession, pid: number) => s.world.players.find((p) => p.id === pid);

// 1. Arrivées, départs, couleurs.
{
  const s = new CoopSession(42);
  check('monde créé en mode coopératif', s.world.mode === 'coop' && s.world.seed === 42 && s.playerCount === 0);
  const a = s.join('Ayame');
  const b = s.join('  Ben<kei>  ');
  const c = s.join(undefined);
  check('couleurs attribuées dans l’ordre (0, 1, 2)', a.color === 0 && b.color === 1 && c.color === 2);
  check('pids distincts et joueurs ajoutés au monde', new Set([a.pid, b.pid, c.pid]).size === 3 && s.world.players.length === 3 && s.playerCount === 3);
  check('pseudos nettoyés', player(s, b.pid)?.name === 'Benkei' && player(s, c.pid)?.name === 'Ronin', `${player(s, b.pid)?.name}`);
  check('couleur portée par le joueur', player(s, b.pid)?.color === 1);
  s.leave(b.pid);
  check('départ : joueur retiré du monde', s.playerCount === 2 && !player(s, b.pid) && s.world.players.length === 2);
  const d = s.join('Daisuke');
  check('couleur libérée réutilisée', d.color === 1 && d.pid !== b.pid);
  s.leave(9999); // inconnu : sans effet
  check('départ d’un pid inconnu sans effet', s.playerCount === 3);
  for (let i = s.playerCount; i < PLAYER_COLORS; i++) s.join(`p${i}`);
  const colors = new Set(s.world.players.map((p) => p.color));
  check('12 joueurs : 12 couleurs uniques', s.playerCount === PLAYER_COLORS && colors.size === PLAYER_COLORS);
  let threw = false;
  try {
    s.join('treizième');
  } catch {
    threw = true;
  }
  check('13e joueur refusé', threw && s.playerCount === PLAYER_COLORS);
  const w = s.welcomeFor(d.pid);
  check('message de bienvenue', w.pid === d.pid && w.seed === 42 && w.color === 1 && w.stage === s.world.level.stage && w.tick === s.world.tick);
}

// 2. Entrées : séquences, masque, file plafonnée.
{
  const s = new CoopSession(1);
  const { pid } = s.join('a');
  check('entrée acceptée', s.pushInput(pid, { s: 5, b: BTN.RIGHT }));
  check('même séquence ignorée', !s.pushInput(pid, { s: 5, b: BTN.LEFT }));
  check('séquence ancienne ignorée', !s.pushInput(pid, { s: 3, b: BTN.LEFT }));
  check('séquence suivante acceptée', s.pushInput(pid, { s: 6, b: BTN.RIGHT }) && s.queueLength(pid) === 2);
  check('entrée d’un pid inconnu ignorée', !s.pushInput(999, { s: 1, b: 0 }));
  check('entrée non entière ignorée', !s.pushInput(pid, { s: 7.5, b: 0 }) && !s.pushInput(pid, { s: 8, b: NaN }));

  const q = new CoopSession(1);
  const p = q.join('q').pid;
  for (let i = 1; i <= MAX_INPUT_QUEUE; i++) q.pushInput(p, { s: i, b: BTN.RIGHT });
  check(`file de ${MAX_INPUT_QUEUE} entrées conservée`, q.queueLength(p) === MAX_INPUT_QUEUE);
  const r = new CoopSession(1);
  const rp = r.join('r').pid;
  r.pushInput(rp, { s: 1, b: BTN.JUMP }); // appui bref, qui serait perdu sans fusion
  for (let i = 2; i <= MAX_INPUT_QUEUE + 1; i++) r.pushInput(rp, { s: i, b: BTN.RIGHT });
  check('file saturée : une seule entrée (la plus récente)', r.queueLength(rp) === 1);
  r.update(STEP_MS);
  check('fusion : les appuis abandonnés sont conservés (OR)', player(r, rp)?.prevButtons === (BTN.RIGHT | BTN.JUMP), `${player(r, rp)?.prevButtons}`);
  check('accusé = séquence la plus récente', r.ackFor(rp) === MAX_INPUT_QUEUE + 1);

  const m = new CoopSession(1);
  const mp = m.join('m').pid;
  m.pushInput(mp, { s: 0, b: 0xffffff });
  m.update(STEP_MS);
  check('boutons masqués (BUTTON_MASK)', player(m, mp)?.prevButtons === BUTTON_MASK);
}

// 3. Pas fixe, consommation des entrées, boutons tenus.
{
  const s = new CoopSession(3);
  const { pid } = s.join('a');
  const t0 = s.world.tick;
  let steps = 0;
  for (let i = 0; i < 10; i++) steps += s.update(10);
  check('100 ms (10 × 10 ms) → 6 pas', steps === 6 && s.world.tick === t0 + 6, `${steps}`);
  const before = s.world.tick;
  check(`rattrapage plafonné à ${MAX_STEPS_PER_UPDATE} pas par appel`, s.update(1000) === MAX_STEPS_PER_UPDATE && s.world.tick === before + MAX_STEPS_PER_UPDATE);
  check('le retard au-delà du plafond est abandonné', s.update(STEP_MS / 2) <= 1);
  check('durées nulles ou invalides ignorées', s.update(0) === 0 && s.update(-5) === 0 && s.update(NaN) === 0);

  const u = new CoopSession(3);
  const up = u.join('u').pid;
  for (let i = 1; i <= 3; i++) u.pushInput(up, { s: i, b: BTN.RIGHT });
  u.update(STEP_MS);
  check('une seule entrée consommée par pas', u.queueLength(up) === 2 && u.ackFor(up) === 1);
  u.update(STEP_MS * 2 + 0.01);
  check('file vidée au rythme de la simulation', u.queueLength(up) === 0 && u.ackFor(up) === 3);
  const x0 = player(u, up)!.x;
  u.update(STEP_MS * 5 + 0.01);
  check('file vide : derniers boutons tenus réutilisés', player(u, up)!.prevButtons === BTN.RIGHT && player(u, up)!.x > x0, `x ${x0.toFixed(1)} → ${player(u, up)!.x.toFixed(1)}`);
  check('accusé inchangé sans nouvelle entrée', u.ackFor(up) === 3);

  // Instantané : ack et événements accumulés.
  const snap = u.snapshotFor(up);
  check('instantané : ack = dernière séquence consommée', snap.ack === 3 && snap.t === u.world.tick && snap.players.some((p) => p.id === up));
  check('pid sans entrée : ack = -1', s.snapshotFor(pid).ack === -1);
  // Attaques répétées pour produire des événements.
  let seq = 10;
  for (let i = 0; i < 120; i++) {
    u.pushInput(up, { s: seq++, b: i % 10 < 2 ? BTN.ATTACK : 0 });
    u.update(STEP_MS + 0.001);
  }
  const pending = u.pendingEvents.length;
  check('événements du monde accumulés puis vidés de w.events', pending > 0 && u.world.events.length === 0, `${pending}`);
  check('instantané : événements depuis le dernier envoi', u.snapshotFor(up).events.length > 0);
  u.flushEvents();
  check('flushEvents : plus d’événements en attente', u.pendingEvents.length === 0 && u.snapshotFor(up).events.length === 0);
}

// 4. Latence simulée.
{
  const off = new LagLine(null);
  let ran = false;
  off.run('c', () => (ran = true));
  check('latence désactivée : exécution immédiate', ran && !off.enabled);
  const on = new LagLine({ lagMs: 30, jitterMs: 20 });
  const t0 = performance.now();
  const order: number[] = [];
  const at: number[] = [];
  for (let i = 0; i < 10; i++)
    on.run('c', () => {
      order.push(i);
      at.push(performance.now() - t0);
    });
  await waitFor(() => order.length === 10, 1000);
  check('latence simulée : délai appliqué, ordre conservé', order.join() === '0,1,2,3,4,5,6,7,8,9' && Math.min(...at) >= 28, `${Math.min(...at).toFixed(0)} à ${Math.max(...at).toFixed(0)} ms`);
  on.clear();
}

// ─── (b) Serveur réel + clients SDK ─────────────────────────────────────────

interface TestClient {
  room: Room;
  welcome: WelcomeMsg | null;
  snaps: SnapshotMsg[];
  snapTimes: number[];
  pings: number[];
  left: boolean;
}

async function connect(url: string, name: string): Promise<TestClient> {
  const room = await new Client(url).joinOrCreate('coop', { name });
  const c: TestClient = { room, welcome: null, snaps: [], snapTimes: [], pings: [], left: false };
  room.onMessage(MSG.welcome, (w: WelcomeMsg) => (c.welcome = w));
  room.onMessage(MSG.snap, (s: SnapshotMsg) => {
    c.snaps.push(s);
    c.snapTimes.push(performance.now());
  });
  room.onMessage(MSG.ping, (t: number) => c.pings.push(t));
  room.onLeave(() => (c.left = true));
  return c;
}

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

{
  const srv = await startServer({ port: 0 });
  const url = `ws://localhost:${srv.port}`;
  check('serveur démarré sur un port libre', srv.port > 0, `${srv.port}`);
  try {
    const health = await fetch(`http://localhost:${srv.port}/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
    check('route /health', health.ok === true, JSON.stringify(health));

    const a = await connect(url, 'Ayame');
    const b = await connect(url, 'Benkei');
    await waitFor(() => !!a.welcome && !!b.welcome, 3000);
    check('welcome reçu par les deux clients', !!a.welcome && !!b.welcome);
    check(
      'welcome : pids et couleurs distincts, même graine',
      !!a.welcome && !!b.welcome && a.welcome.pid !== b.welcome.pid && a.welcome.color !== b.welcome.color && a.welcome.seed === b.welcome.seed,
      `pid ${a.welcome?.pid}/${b.welcome?.pid}, couleur ${a.welcome?.color}/${b.welcome?.color}, graine ${a.welcome?.seed}`,
    );
    check('même salle', a.room.roomId === b.room.roomId);

    // Cadence des instantanés (20 Hz).
    const n0 = b.snaps.length;
    const tStart = performance.now();
    await sleep(1000);
    const times = b.snapTimes.filter((t) => t >= tStart);
    const avg = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : Infinity;
    check('instantanés reçus environ toutes les 50 ms', avg > 35 && avg < 70 && b.snaps.length - n0 >= 14, `${avg.toFixed(1)} ms, ${b.snaps.length - n0} en 1 s`);
    const pidA = a.welcome!.pid;
    const pidB = b.welcome!.pid;
    check('chaque instantané contient les deux joueurs', !!last(b.snaps)?.players.some((p) => p.id === pidA) && !!last(b.snaps)?.players.some((p) => p.id === pidB));

    // A court vers la droite : B le voit avancer.
    const xA0 = last(b.snaps)!.players.find((p) => p.id === pidA)!.x;
    let seq = 0;
    const timer = setInterval(() => a.room.send(MSG.input, { s: seq++, b: BTN.RIGHT }), STEP_MS);
    await sleep(1200);
    clearInterval(timer);
    await sleep(150);
    const xA1 = last(b.snaps)!.players.find((p) => p.id === pidA)!.x;
    check('un joueur qui envoie RIGHT avance chez l’autre', xA1 > xA0 + 50, `x ${xA0.toFixed(1)} → ${xA1.toFixed(1)}`);
    check('accusé de réception reçu par l’émetteur', (last(a.snaps)?.ack ?? -1) >= 0 && (last(a.snaps)?.ack ?? -1) <= seq - 1, `ack ${last(a.snaps)?.ack}, envoyées ${seq}`);
    check('B n’envoie rien : ack = -1', last(b.snaps)?.ack === -1);

    // Entrées malformées : ignorées sans casser la salle.
    a.room.send(MSG.input, { s: 'x', b: 1 });
    a.room.send(MSG.input, null);
    a.room.send(MSG.input, { s: 1e300, b: 2 });
    a.room.send(MSG.input, [1, 2]);
    a.room.send('inconnu', { x: 1 });
    const nb = b.snaps.length;
    await sleep(200);
    check('entrées malformées ignorées, la salle continue', b.snaps.length > nb && !a.left);

    // Ping (mesure de RTT) : écho du même message.
    a.room.send(MSG.ping, 12345.5);
    await waitFor(() => a.pings.length > 0, 2000);
    check('ping renvoyé à l’identique', a.pings[0] === 12345.5);

    // Départ : A disparaît des instantanés de B.
    await a.room.leave();
    const gone = await waitFor(() => {
      const s = last(b.snaps);
      return !!s && !s.players.some((p) => p.id === pidA);
    }, 2000);
    check('le départ d’un client le retire chez l’autre', gone && last(b.snaps)!.players.length === 1);

    // Débit excessif (> 120 messages/s pendant 2 s) : expulsion.
    const c = await connect(url, 'Flood');
    await waitFor(() => !!c.welcome, 2000);
    let fs = 0;
    const flood = setInterval(() => {
      for (let i = 0; i < 4; i++) c.room.send(MSG.input, { s: fs++, b: 0 });
    }, 10);
    const kicked = await waitFor(() => c.left, 5000);
    clearInterval(flood);
    check('client trop bavard expulsé', kicked, `${fs} messages envoyés`);
    check('les autres clients restent connectés', !b.left);

    await b.room.leave();
  } catch (err) {
    check('scénario réseau sans exception', false, String(err));
  }
  await srv.stop();
  check('serveur arrêté proprement', true);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests serveur passent.');
