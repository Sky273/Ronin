// Tests du serveur (session pure, puis serveur réel en local avec des clients SDK).
// Lancer : npm run test:server
import { Client, type Room } from '@colyseus/sdk';
import { BTN } from '../shared/input';
import { decodeSnapshot, type SnapshotWire } from '../shared/net/codec';
import { AWAY_CLOSE_CODE, BUTTON_MASK, MAX_REWIND_TICKS, MSG, PLAYER_COLORS, type Snapshot, type WelcomeMsg } from '../shared/net/protocol';
import type { Player } from '../shared/types';
import { CloseCode, matchMaker } from '@colyseus/core';
import { MAX_PAYLOAD, startServer } from '../server/app';
import type { CoopRoom } from '../server/rooms/CoopRoom';
import { LagLine } from '../server/lag';
import { IDLE_RELEASE_TICKS, MAX_INPUT_QUEUE, MAX_STEPS_PER_UPDATE, CoopSession } from '../server/session';
import { COOP_AWAY_TICKS, COOP_CLEARED_TICKS, COOP_KICK_TICKS, COOP_READY_AFTER } from '../shared/constants';
import { pack as packWire, unpack as unpackRaw } from 'msgpackr';
/** Passe un instantané par msgpack (comme sur le fil). */
const unpackWire = (w: SnapshotWire): SnapshotWire => unpackRaw(packWire(w)) as SnapshotWire;

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
  console.log('✘ délai global dépassé (120 s)');
  process.exit(1);
}, 120_000).unref();

// ─── (a) CoopSession seule ──────────────────────────────────────────────────

const player = (s: CoopSession, pid: number) => s.world.players.find((p) => p.id === pid);
/** Instantané décodé, avec la liste de tous les joueurs (soi + les autres). */
type TestSnap = Snapshot & { players: Player[] };
const view = (w: SnapshotWire): TestSnap => {
  const d = decodeSnapshot(w);
  return { ...d, players: d.self ? [d.self, ...d.others] : d.others };
};

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
  for (let i = 0; i < IDLE_RELEASE_TICKS; i++) u.update(STEP_MS + 0.01);
  check('client muet : boutons relâchés après IDLE_RELEASE_TICKS', player(u, up)!.prevButtons === 0);

  // Instantané : ack et événements accumulés.
  const snap = view(u.snapshotFor(up));
  check('instantané : ack = dernière séquence consommée', snap.ack === 3 && snap.t === u.world.tick && snap.players.some((p) => p.id === up));
  check('pid sans entrée : ack = -1', view(s.snapshotFor(pid)).ack === -1);
  // Attaques répétées pour produire des événements.
  let seq = 10;
  for (let i = 0; i < 120; i++) {
    u.pushInput(up, { s: seq++, b: i % 10 < 2 ? BTN.ATTACK : 0 });
    u.update(STEP_MS + 0.001);
  }
  const pending = u.pendingEvents.length;
  check('événements du monde accumulés puis vidés de w.events', pending > 0 && u.world.events.length === 0, `${pending}`);
  check('instantané : événements depuis le dernier envoi', view(u.snapshotFor(up)).events.length > 0);
  u.flushEvents();
  check('flushEvents : plus d’événements en attente', u.pendingEvents.length === 0 && view(u.snapshotFor(up)).events.length === 0);
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

// 5. Session : fuzz d'arrivées, départs, entrées et durées étranges — jamais d'exception, invariants tenus.
{
  // Générateur déterministe (pas de Math.random dans les tests).
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const weirdS = [NaN, Infinity, -Infinity, -1, -0, 0.5, 2 ** 53, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e300];
  const weirdB = [NaN, -1, 2 ** 31, 2 ** 52, -(2 ** 53) + 1, Infinity, 0xffffffff];
  const weirdMs = [0, -1, NaN, 1e-9, 0.001, 16.7, 33, 100, 5000, 1e9];
  const s = new CoopSession(777);
  const seqs = new Map<number, number>();
  const bad: string[] = [];
  let err = '';
  try {
    for (let i = 0; i < 6000; i++) {
      const r = rnd();
      if (r < 0.03 && s.playerCount < PLAYER_COLORS) {
        const { pid } = s.join(pick(['A', '', null, 42, { x: 1 }, 'x'.repeat(500), '\u0000‮💥', undefined]));
        seqs.set(pid, 0);
      } else if (r < 0.05 && s.playerCount > 0) {
        const pid = pick([...seqs.keys()]);
        s.leave(pid);
        s.leave(pid); // double départ
        seqs.delete(pid);
      } else if (r < 0.07) {
        s.leave(Math.floor(rnd() * 1e6)); // inconnu
      }
      for (const [pid, q] of seqs) {
        const k = rnd();
        if (k < 0.1) s.pushInput(pid, { s: pick(weirdS), b: pick(weirdB) });
        else if (k < 0.15) s.pushInput(pid, { s: q - Math.floor(rnd() * 5), b: Math.floor(rnd() * 0xffff) }); // rejouée
        else if (k < 0.95) {
          const n = rnd() < 0.05 ? 20 : 1; // parfois une rafale
          for (let j = 0; j < n; j++) {
            seqs.set(pid, seqs.get(pid)! + 1);
            s.pushInput(pid, { s: seqs.get(pid)!, b: Math.floor(rnd() * 0x1000) });
          }
        }
        if (s.queueLength(pid) > MAX_INPUT_QUEUE) bad.push(`file ${s.queueLength(pid)} pour ${pid}`);
      }
      const steps = s.update(rnd() < 0.05 ? pick(weirdMs) : STEP_MS);
      if (steps > MAX_STEPS_PER_UPDATE) bad.push(`${steps} pas`);
      if (i % 50 === 0) {
        for (const pid of seqs.keys()) s.snapshotFor(pid);
        s.flushEvents();
      }
      const ps = s.world.players;
      if (ps.length !== s.playerCount) bad.push(`monde ${ps.length} ≠ session ${s.playerCount}`);
      if (new Set(ps.map((p) => p.color)).size !== ps.length) bad.push('couleurs en double');
      if (ps.some((p) => p.color < 0 || p.color >= PLAYER_COLORS)) bad.push('couleur hors plage');
      if (ps.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.name.length > 12)) bad.push('joueur invalide');
      if (bad.length) break;
    }
  } catch (x) {
    err = String((x as Error)?.stack ?? x);
  }
  check('fuzz de session (6000 appels) : aucune exception', err === '', err.slice(0, 300));
  check('fuzz de session : invariants (file ≤ 8, couleurs uniques, monde = session)', bad.length === 0, bad.slice(0, 3).join(' ; '));
  check('fuzz de session : la simulation a avancé', s.world.tick > 4000 && !s.world.over, `tick ${s.world.tick}`);
}

// 6. Durée démesurée (horloge folle) : la session ne doit pas rester figée.
{
  const s = new CoopSession(5);
  s.join('a');
  s.update(Infinity);
  const t0 = s.world.tick;
  let steps = 0;
  for (let i = 0; i < 10; i++) steps += s.update(STEP_MS + 0.01);
  check('après update(Infinity), la simulation continue', steps >= 9 && s.world.tick > t0, `${steps} pas sur 10 appels`);
  const u = new CoopSession(5);
  u.join('a');
  u.update(1e308); // 1e308 × 60 déborde en Infinity
  check('après update(1e308), la simulation continue', u.update(STEP_MS + 0.01) === 1);
}

// 7. Séquence géante acceptée : le client se bloque lui-même, sans gêner les autres.
{
  const s = new CoopSession(6);
  const a = s.join('a').pid;
  const b = s.join('b').pid;
  s.pushInput(a, { s: Number.MAX_SAFE_INTEGER, b: 0 });
  check('séquence MAX_SAFE_INTEGER : entrées suivantes de ce client ignorées', !s.pushInput(a, { s: 1, b: BTN.RIGHT }));
  check('… celles des autres clients restent acceptées', s.pushInput(b, { s: 1, b: BTN.RIGHT }));
  s.update(STEP_MS);
  check('… et la simulation avance', s.world.tick === 1 && s.ackFor(b) === 1);
}

// 8. Tick de vue (v) : retard L = clamp(S − v, 0, MAX_REWIND_TICKS) de l'entrée consommée.
{
  const s = new CoopSession(8);
  const a = s.join('a').pid;
  const b = s.join('b').pid;
  check('compensation de latence posée par la session', !!s.world.net && s.lagFor(a) === 0);
  for (let i = 0; i < 40; i++) s.update(STEP_MS + 0.001);
  const S = s.world.tick;
  check('v valide accepté', s.pushInput(a, { s: 1, b: 0, v: S - 12 }) && s.pushInput(b, { s: 1, b: 0 }));
  s.update(STEP_MS + 0.001);
  check('L = S − v pour l’entrée consommée au tick S', s.lagFor(a) === 12 && s.world.net!.lagOf(a) === 12, `L=${s.lagFor(a)}`);
  check('sans v : L = 0', s.lagFor(b) === 0 && s.world.net!.lagOf(b) === 0);
  s.update(STEP_MS * 3 + 0.001);
  check('file vide : le dernier L est conservé', s.lagFor(a) === 12 && s.world.net!.lagOf(a) === 12);
  s.pushInput(a, { s: 2, b: 0, v: 0 });
  s.update(STEP_MS + 0.001);
  check(`L borné à ${MAX_REWIND_TICKS} (S − v = ${s.world.tick - 1})`, s.lagFor(a) === MAX_REWIND_TICKS);
  s.pushInput(a, { s: 3, b: 0, v: s.world.tick + 50 });
  s.update(STEP_MS + 0.001);
  check('v dans le futur : le retard ne baisse que d’un tick par pas', s.lagFor(a) === MAX_REWIND_TICKS - 1, `L=${s.lagFor(a)}`);
  let seqF = 100;
  for (let i = 0; i < MAX_REWIND_TICKS; i++) {
    s.pushInput(a, { s: seqF++, b: 0, v: s.world.tick + 50 });
    s.update(STEP_MS + 0.001);
  }
  check('v dans le futur : L finit à 0', s.lagFor(a) === 0, `L=${s.lagFor(a)}`);
  let ignored = true;
  for (const [i, v] of [-1, 2.5, NaN, Infinity, 2 ** 53].entries()) {
    s.update(STEP_MS + 0.001);
    ignored &&= s.pushInput(a, { s: 200 + i, b: 0, v });
    s.update(STEP_MS + 0.001);
    ignored &&= s.ackFor(a) === 200 + i && s.lagFor(a) === 0;
  }
  check('v invalide ignoré : entrée acceptée, jugée sans retard', ignored, `L=${s.lagFor(a)}`);
  // File saturée : la fusion garde le v de l'entrée la plus récente.
  for (let i = 0; i <= MAX_INPUT_QUEUE; i++) s.pushInput(a, { s: 300 + i, b: 0, v: s.world.tick - 3 });
  s.update(STEP_MS + 0.001);
  check('fusion de la file : v le plus récent conservé', s.queueLength(a) === 0 && s.lagFor(a) === 3, `L=${s.lagFor(a)}`);
  check('statistiques de L alimentées', s.lagStats.count > 0 && s.lagStats.percentile(95) <= MAX_REWIND_TICKS);
  s.leave(a);
  check('départ : retard oublié', s.world.net!.lagOf(a) === 0);
}

// ─── (b) Serveur réel + clients SDK ─────────────────────────────────────────

interface TestClient {
  room: Room;
  welcome: WelcomeMsg | null;
  snaps: TestSnap[];
  snapTimes: number[];
  pings: number[];
  left: boolean;
}

async function connect(url: string, name: string): Promise<TestClient> {
  const room = await new Client(url).joinOrCreate('coop', { name });
  const c: TestClient = { room, welcome: null, snaps: [], snapTimes: [], pings: [], left: false };
  room.onMessage(MSG.welcome, (w: WelcomeMsg) => (c.welcome = w));
  room.onMessage(MSG.snap, (s: SnapshotWire) => {
    c.snaps.push(view(s));
    c.snapTimes.push(performance.now());
  });
  room.onMessage(MSG.ping, (m: { t: number }) => c.pings.push(m.t));
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
    a.room.send(MSG.ping, { t: 12345.5 });
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

// ─── (c) Robustesse du serveur réel : salle pleine, messages malformés, départs rapides ─
{
  const crashes: string[] = [];
  const onCrash = (e: unknown) => crashes.push(String((e as Error)?.stack ?? e).slice(0, 300));
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  const srv = await startServer({ port: 0 });
  const url = `ws://localhost:${srv.port}`;
  const roomOf = (id: string) => matchMaker.getLocalRoomById(id) as unknown as CoopRoom | undefined;
  /** Un client « témoin » reçoit-il encore des instantanés ? */
  const flowing = async (c: TestClient) => {
    const n = c.snaps.length;
    return waitFor(() => c.snaps.length >= n + 3, 2000);
  };
  try {
    // 12 clients en parallèle : même salle, 12 couleurs distinctes.
    const cs = await Promise.all(Array.from({ length: PLAYER_COLORS }, (_, i) => connect(url, `p${i}`)));
    await waitFor(() => cs.every((c) => !!c.welcome), 5000);
    const roomId = cs[0].room.roomId;
    const colors = new Set(cs.map((c) => c.welcome?.color));
    check('12 clients : même salle, 12 couleurs distinctes', cs.every((c) => c.room.roomId === roomId) && colors.size === PLAYER_COLORS && [...colors].every((k) => k! >= 0 && k! < PLAYER_COLORS), [...colors].join(','));
    const room = roomOf(roomId);
    check('12 clients : session à 12 joueurs', room?.coop.playerCount === PLAYER_COLORS, `${room?.coop.playerCount}`);

    // 13e client vers la salle pleine : refusé.
    let refused = false;
    try {
      const r = await new Client(url).joinById(roomId, { name: 'treize' });
      await r.leave();
    } catch {
      refused = true;
    }
    check('13e client (joinById sur la salle pleine) refusé', refused && room?.coop.playerCount === PLAYER_COLORS);
    // 13e client via joinOrCreate (chemin du jeu) : jamais dans la salle pleine.
    const extra = await connect(url, 'treize');
    await waitFor(() => !!extra.welcome, 2000);
    check('13e client (joinOrCreate) placé dans une autre salle', extra.room.roomId !== roomId && !!extra.welcome && room?.coop.playerCount === PLAYER_COLORS, extra.room.roomId);
    await extra.room.leave();
    // On libère 7 places pour la suite (restent les clients 0 à 4).
    for (const c of cs.slice(5)) await c.room.leave();
    await waitFor(() => room?.coop.playerCount === 5, 2000);

    const witness = cs[0];
    const bad = cs[1];
    // Entrées et pings de types inattendus.
    const junk: unknown[] = [
      { s: -5, b: 1 }, { s: 2 ** 53, b: 1 }, { s: '1', b: 1 }, { s: 1, b: 'x' }, { s: 1, b: {} }, { s: NaN, b: NaN },
      { s: Infinity, b: 1 }, { s: 1.5, b: 1 }, 'chaîne', 42, true, [], [[[[]]]], { s: { valueOf: 1 } }, { __proto__: { s: 1 } },
      { s: 1.25, b: 1, extra: 'x'.repeat(2000) }, { s: -1e308, b: -1e308 },
    ];
    for (const m of junk) bad.room.send(MSG.input, m as never);
    for (const m of [null, 'x', 5, [], { t: NaN }, { t: 'x' }, { t: Infinity }, { t: -1 }, { t: { a: 1 } }]) bad.room.send(MSG.ping, m as never);
    await waitFor(() => bad.pings.length >= 9, 2000);
    check('pings malformés : écho t = 0 si non fini, sinon t inchangé', bad.pings.length === 9 && bad.pings.join() === '0,0,0,0,0,0,0,-1,0', bad.pings.join());
    const pidBad = bad.welcome!.pid;
    const slotOk = room?.coop.queueLength(pidBad) === 0 && room?.coop.ackFor(pidBad) === -1;
    check('entrées malformées : aucune acceptée', slotOk, `file=${room?.coop.queueLength(pidBad)} ack=${room?.coop.ackFor(pidBad)}`);
    // Après les entrées malformées, une entrée valide est toujours acceptée.
    bad.room.send(MSG.input, { s: 1000, b: BTN.RIGHT });
    check('après les entrées malformées, une entrée valide est acceptée', await waitFor(() => room?.coop.ackFor(pidBad) === 1000, 1000));
    // Tick de vue : entier ≥ 0, sinon ignoré (l'entrée reste acceptée, sans retard).
    await waitFor(() => (room?.coop.world.tick ?? 0) > MAX_REWIND_TICKS + 5, 3000);
    bad.room.send(MSG.input, { s: 1001, b: 0, v: 0 });
    const lagMax = await waitFor(() => room?.coop.ackFor(pidBad) === 1001, 1000) && room?.coop.lagFor(pidBad) === MAX_REWIND_TICKS;
    check(`salle : v = 0 accepté, L borné à ${MAX_REWIND_TICKS}`, lagMax, `L=${room?.coop.lagFor(pidBad)} tick=${room?.coop.world.tick}`);
    let vIgnored = true;
    for (const [i, v] of ([-3, 1.5, 'x', NaN, null, 2 ** 53] as unknown[]).entries()) {
      bad.room.send(MSG.input, { s: 1002 + i, b: 0, v } as never);
      vIgnored &&= await waitFor(() => room?.coop.ackFor(pidBad) === 1002 + i, 1000);
    }
    // Sans v valide, L = 0 demandé : le retard redescend d'un tick par entrée consommée jusqu'à 0.
    // Espacées : au-delà de 8 entrées en file, le serveur les fusionne.
    for (let i = 0; i < MAX_REWIND_TICKS + 4; i++) {
      bad.room.send(MSG.input, { s: 1100 + i, b: 0 });
      await sleep(STEP_MS * 2);
    }
    vIgnored &&= await waitFor(() => room?.coop.lagFor(pidBad) === 0, 2000);
    check('salle : v invalide ignoré (entrée acceptée, L = 0)', vIgnored, `L=${room?.coop.lagFor(pidBad)}`);

    // Octets bruts : msgpack invalide, tronqué, imbrication profonde, message vide, code de protocole inconnu.
    const raw = [
      new Uint8Array([]),
      new Uint8Array([13]),
      new Uint8Array([13, 0xa1, 0x69, 0xc1]), // type « i » + octet msgpack interdit
      new Uint8Array([13, 0xa1, 0x69, 0xdf, 0xff, 0xff, 0xff, 0xff]), // map annoncée à 4 milliards d'entrées
      new Uint8Array([13, 0xa1, 0x69, 0xdd, 0x7f, 0xff, 0xff, 0xff]), // tableau annoncé à 2 milliards d'éléments
      new Uint8Array([13, 0xa1, 0x69, ...new Array(3500).fill(0x91), 0x00]), // 3500 tableaux imbriqués
      new Uint8Array([13, 0xa1, 0x70, 0xc7, 0x05, 0x7f, 1, 2, 3, 4, 5]), // ping : extension inconnue
      new Uint8Array([99, 1, 2, 3]),
      new Uint8Array([13, 0xff]),
      new Uint8Array([13, 0xd9, 0xff, 0x41]), // type déclaré sur 255 octets, tronqué
    ];
    // Un client neuf par charge utile (le framework coupe le client au premier msgpack invalide).
    // Par lots de 5 dans la même salle que le témoin (joinById).
    let rogueErr = '';
    for (let i0 = 0; i0 < raw.length; i0 += 5) {
      const batch = raw.slice(i0, i0 + 5);
      const rogues = await Promise.all(batch.map(async (_, i) => {
        const rm = await new Client(url).joinById(roomId, { name: `rogue${i0 + i}` });
        const c = { room: rm, left: false };
        rm.onLeave(() => (c.left = true));
        return c;
      })).catch((x) => ((rogueErr = String(x)), []));
      rogues.forEach((r, i) => r.room.connection.send(batch[i]));
      await sleep(300);
      for (const r of rogues) if (!r.left) await r.room.leave().catch(() => undefined);
      await waitFor(() => room?.coop.playerCount === 5, 2000);
    }
    check('octets bruts : clients voyous bien entrés dans la salle du témoin', rogueErr === '', rogueErr);
    check('octets bruts malformés : la salle continue (témoin)', await flowing(witness) && !witness.left);
    const steadyTick = room?.coop.world.tick ?? 0;
    await sleep(200);
    check('octets bruts malformés : la simulation avance', (room?.coop.world.tick ?? 0) > steadyTick + 6);

    // Message trop gros (> MAX_PAYLOAD) : seul l'émetteur est coupé.
    const big = cs[3];
    big.room.send(MSG.input, { s: 1, b: 1, pad: 'x'.repeat(MAX_PAYLOAD * 3) } as never);
    const bigCut = await waitFor(() => big.left, 3000);
    check('message de 12 Kio : l’émetteur est déconnecté', bigCut);
    check('message de 12 Kio : les autres restent', await flowing(witness) && !witness.left && !cs[4].left);
    check('message de 12 Kio : son joueur est retiré de la session', await waitFor(() => !room?.coop.world.players.some((p) => p.id === big.welcome!.pid), 2000));

    // Client légitime à 60 Hz + pings pendant 3 s, avec une rafale de rattrapage : jamais expulsé.
    const legit = cs[4];
    let ls = 1;
    const lt = setInterval(() => legit.room.send(MSG.input, { s: ls++, b: BTN.RIGHT }), STEP_MS);
    const pt = setInterval(() => legit.room.send(MSG.ping, { t: 1 }), 500);
    await sleep(1500);
    for (let i = 0; i < 100; i++) legit.room.send(MSG.input, { s: ls++, b: 0 }); // rafale (réseau qui se débloque)
    await sleep(1500);
    clearInterval(lt);
    clearInterval(pt);
    await sleep(100);
    check('client à 60 Hz avec une rafale ponctuelle : pas expulsé', !legit.left, `${ls} entrées`);

    // Départs et arrivées rapides : 8 clients rejoignent et repartent aussitôt, certains sans attendre l'accueil.
    await waitFor(() => room?.coop.playerCount === 4, 2000); // restent 0, 1, 2 et 4 (3 a été coupé)
    const churn = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const c = await connect(url, `churn${i}`);
        if (i % 2) await waitFor(() => !!c.welcome, 1000);
        await c.room.leave();
        return c;
      }),
    );
    void churn;
    const expected = [cs[0], cs[1], cs[2], cs[4]].filter((c) => !c.left).length;
    const settled = await waitFor(() => room?.coop.playerCount === expected && room.coop.world.players.length === expected, 3000);
    check('départs/arrivées rapides : la session revient au bon nombre de joueurs', settled, `${room?.coop.playerCount} au lieu de ${expected}`);
    const late = await connect(url, 'late');
    await waitFor(() => !!late.welcome, 2000);
    const used = new Set(room?.coop.world.players.filter((p) => p.id !== late.welcome?.pid).map((p) => p.color));
    let lowest = 0;
    while (used.has(lowest)) lowest++;
    check('départs/arrivées rapides : couleurs libérées (le nouveau prend la plus basse libre)', late.room.roomId === roomId && late.welcome?.color === lowest, `couleur ${late.welcome?.color}, attendu ${lowest}`);
    check('départs/arrivées rapides : la salle continue', await flowing(witness));

    // Pseudo démesuré dans les options d'arrivée.
    let hugeErr = '';
    try {
      const h = await connect(url, 'N'.repeat(200_000));
      await waitFor(() => !!h.welcome, 2000);
      const p = room?.coop.world.players.find((q) => q.id === h.welcome?.pid);
      check('pseudo de 200 000 caractères : tronqué à 12', !!p && p.name.length === 12, `${p?.name.length}`);
      await h.room.leave();
    } catch (x) {
      hugeErr = String(x);
    }
    check('pseudo démesuré : pas de plantage du serveur', await flowing(witness), hugeErr);

    for (const c of [...cs, late]) if (!c.left) await c.room.leave().catch(() => undefined);
  } catch (err) {
    check('scénario de robustesse sans exception', false, String((err as Error)?.stack ?? err).slice(0, 400));
  }
  await srv.stop();

  // Latence simulée : départ alors que des messages sont encore en attente dans les deux sens.
  process.env.LAG_MS = '60';
  process.env.JITTER_MS = '20';
  const srv2 = await startServer({ port: 0 });
  delete process.env.LAG_MS;
  delete process.env.JITTER_MS;
  try {
    const url2 = `ws://localhost:${srv2.port}`;
    const w = await connect(url2, 'witness');
    await waitFor(() => !!w.welcome, 3000);
    for (let k = 0; k < 5; k++) {
      const c = await connect(url2, `lag${k}`);
      for (let i = 1; i <= 30; i++) c.room.send(MSG.input, { s: i, b: BTN.RIGHT });
      c.room.send(MSG.ping, { t: 1 });
      await c.room.leave(); // les entrées retardées arrivent après le départ
    }
    await sleep(300);
    const room2 = roomOf(w.room.roomId);
    check('latence simulée + départs : session cohérente', room2?.coop.playerCount === 1 && room2.coop.world.players.length === 1, `${room2?.coop.playerCount}`);
    check('latence simulée + départs : la salle continue', await flowing(w) && !w.left);
    await w.room.leave();
  } catch (err) {
    check('scénario de latence sans exception', false, String(err));
  }
  await srv2.stop();
  check('aucune exception non rattrapée côté serveur', crashes.length === 0, crashes.slice(0, 2).join(' | '));
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
}

// 9. Joueurs absents : aucun bouton depuis 30 s → ni vote ni force du gardien ; renvoyés après 3 min.
{
  const s = new CoopSession(77);
  const a = s.join('active').pid;
  const b = s.join('idle').pid;
  let seqA = 1;
  let seqB = 1;
  const stepBoth = (n: number, bButtons = 0) => {
    for (let i = 0; i < n; i++) {
      s.pushInput(a, { s: seqA++, b: i % 2 ? BTN.RIGHT : 0 });
      s.pushInput(b, { s: seqB++, b: bButtons }); // onglet ouvert, personne au clavier : entrées vides
      s.update(STEP_MS + 0.001);
    }
  };
  stepBoth(COOP_AWAY_TICKS - 60);
  check('absent : pas encore avant 30 s', !s.isAway(b) && !(s.world.away ?? []).includes(b));
  stepBoth(120);
  check('absent : entrées vides depuis 30 s → absent (l’actif ne l’est pas)', s.isAway(b) && !s.isAway(a) && (s.world.away ?? []).includes(b) && !(s.world.away ?? []).includes(a), JSON.stringify(s.world.away));
  const snap = decodeSnapshot(unpackWire(s.snapshotFor(a)));
  check('absent : transmis aux clients dans l’instantané', snap.away.includes(b) && !snap.away.includes(a));
  stepBoth(1, BTN.JUMP);
  stepBoth(1);
  check('absent : un appui le rend de nouveau actif', !s.isAway(b) && !(s.world.away ?? []).includes(b));
  check('absent : personne à renvoyer tant qu’il est revenu', s.idleOut().length === 0);
  // Onglet en arrière-plan : plus aucune entrée du tout.
  for (let i = 0; i < COOP_KICK_TICKS + 30; i++) {
    s.pushInput(a, { s: seqA++, b: BTN.RIGHT });
    s.update(STEP_MS + 0.001);
  }
  check('absent depuis 3 min : désigné pour être renvoyé', s.idleOut().includes(b) && !s.idleOut().includes(a), JSON.stringify(s.idleOut()));
}

// 10. Absents : cas limites de la session (boutons tenus, file fusionnée, bits invalides, bilan).
{
  /** Session à n joueurs ; `step(k, f)` : f(pid, i) donne les boutons (null = aucune entrée envoyée). */
  const rig = (n: number, seed = 91) => {
    const s = new CoopSession(seed);
    const pids = Array.from({ length: n }, (_, i) => s.join(`p${i}`).pid);
    const seq = new Map<number, number>();
    const push = (pid: number, b: number) => {
      const q = (seq.get(pid) ?? 0) + 1;
      seq.set(pid, q);
      return s.pushInput(pid, { s: q, b });
    };
    const step = (k: number, f: (pid: number, i: number) => number | null = () => 0) => {
      for (let i = 0; i < k; i++) {
        for (const pid of [...pids, ...extra]) {
          if (!s.has(pid)) continue;
          const b = f(pid, i);
          if (b !== null) push(pid, b);
        }
        s.update(STEP_MS + 0.001);
      }
    };
    const extra: number[] = [];
    return { s, pids, push, step, extra };
  };
  const away = (s: CoopSession) => [...(s.world.away ?? [])].sort((x, y) => x - y);
  /** Passe la session au bilan (comme les tests coop), votes remis à zéro. */
  const toCleared = (s: CoopSession) => {
    const w = s.world;
    w.stage.state = 'cleared';
    w.stage.t = 0;
    for (const p of w.players) w.stage.byPlayer![p.id] = { ...w.stage.byPlayer![p.id], ready: false };
  };
  const wiggle = (i: number) => (i % 60 < 30 ? BTN.LEFT : BTN.RIGHT);

  // Bouton tenu sans relâcher (RIGHT, ou DOWN qui ne déplace pas) : actif.
  {
    const { s, pids, step } = rig(3);
    const [a, b, c] = pids;
    step(COOP_AWAY_TICKS + 300, (pid) => (pid === a ? BTN.RIGHT : pid === b ? BTN.DOWN : 0));
    check('absents : RIGHT tenu 35 s sans relâcher → actif', !s.isAway(a));
    check('absents : DOWN tenu 35 s → actif (tout bit du masque compte)', !s.isAway(b));
    check('absents : entrées vides 35 s → absent, w.away = [c] seulement', s.isAway(c) && JSON.stringify(away(s)) === JSON.stringify([c]), JSON.stringify(away(s)));
  }

  // File saturée : l'appui d'une entrée fusionnée réveille l'absent ; bits hors masque ignorés.
  {
    const { s, pids, push, step } = rig(2);
    const [a, b] = pids;
    step(COOP_AWAY_TICKS + 10, (pid, i) => (pid === a ? wiggle(i) : 0));
    check('absents (préalable) : b absent', s.isAway(b));
    push(b, BTN.JUMP);
    for (let i = 0; i < MAX_INPUT_QUEUE; i++) push(b, 0);
    check('absents : rafale > MAX_INPUT_QUEUE fusionnée en une entrée', s.queueLength(b) === 1, `${s.queueLength(b)}`);
    step(1, (pid, i) => (pid === a ? wiggle(i) : null));
    check('absents : appui conservé par la fusion de file → de nouveau actif', !s.isAway(b) && !away(s).includes(b), JSON.stringify(away(s)));

    const { s: s2, pids: p2, push: push2, step: step2 } = rig(2);
    step2(COOP_AWAY_TICKS + 10, (pid, i) => (pid === p2[0] ? wiggle(i) : 0));
    for (const bad of [0x1000, 0x10000, 2 ** 40, -4096, 0x7fff000]) {
      push2(p2[1], bad);
      step2(1, (pid, i) => (pid === p2[0] ? wiggle(i) : null));
    }
    check('absents : bits hors BUTTON_MASK (0x1000, 2^40, -4096…) ne rendent pas actif', s2.isAway(p2[1]) && away(s2).includes(p2[1]));
    push2(p2[1], BTN.PICK3);
    step2(1, (pid, i) => (pid === p2[0] ? wiggle(i) : null));
    check('absents : PICK3 seul (sans effet hors bilan) suffit à rester actif — tout bit du masque compte', !s2.isAway(p2[1]));
  }

  // Arrivée pendant le bilan : actif, compte dans le seuil.
  {
    const r = rig(2);
    const [a, b] = r.pids;
    r.step(COOP_AWAY_TICKS + 10, (pid, i) => (pid === a ? wiggle(i) : 0));
    toCleared(r.s);
    const c = r.s.join('late').pid;
    r.extra.push(c);
    r.step(COOP_READY_AFTER + 5, () => 0);
    check('absents : arrivée pendant le bilan → actif, fiche de bilan créée', !r.s.isAway(c) && !!r.s.world.stage.byPlayer?.[c] && r.s.isAway(b));
    r.step(1, (pid) => (pid === a ? BTN.JUMP : 0));
    r.step(1, () => 0);
    check('absents : arrivée pendant le bilan → 1 vote sur 2 actifs (a, nouveau) ne suffit pas', r.s.world.stage.state === 'cleared', r.s.world.stage.state);
    r.step(1, (pid) => (pid === c ? BTN.JUMP : 0));
    check('absents : 2 votes sur 2 actifs → étape suivante', r.s.world.stage.state === 'playing', r.s.world.stage.state);
  }

  // Tous absents sauf un : son vote suffit.
  {
    const r = rig(4);
    const [a] = r.pids;
    r.step(COOP_AWAY_TICKS + 10, (pid, i) => (pid === a ? wiggle(i) : 0));
    toCleared(r.s);
    r.step(COOP_READY_AFTER + 5, (pid) => (pid === a ? BTN.DOWN : 0));
    check('absents : 3 absents sur 4, bilan en attente avant le vote', r.s.world.stage.state === 'cleared' && away(r.s).length === 3);
    r.step(1, (pid) => (pid === a ? BTN.JUMP : 0));
    check('absents : 3 absents sur 4 → le vote du seul actif fait repartir', r.s.world.stage.state === 'playing', r.s.world.stage.state);
  }

  // Tous absents : seul le délai fait repartir.
  {
    const r = rig(3);
    r.step(COOP_AWAY_TICKS + 10, () => 0);
    toCleared(r.s);
    r.step(COOP_CLEARED_TICKS - 1, () => 0);
    const before = r.s.world.stage.state;
    r.step(1, () => 0);
    check('absents : tous absents → bilan tenu jusqu’à COOP_CLEARED_TICKS, puis étape suivante', before === 'cleared' && r.s.world.stage.state === 'playing' && away(r.s).length === 3, `${before} → ${r.s.world.stage.state}`);
  }

  // Absent qui revient pendant le bilan : par JUMP (il vote aussitôt) ou par RIGHT (sans voter).
  {
    const r = rig(4);
    const [a, b, c, d] = r.pids;
    r.step(COOP_AWAY_TICKS + 10, (pid, i) => (pid === a || pid === b ? wiggle(i) : 0));
    toCleared(r.s);
    r.step(COOP_READY_AFTER + 5, (pid) => (pid === a || pid === b ? BTN.DOWN : 0));
    r.step(1, (pid) => (pid === a ? BTN.JUMP : pid === b ? BTN.DOWN : 0));
    r.step(1, (pid) => (pid === b ? BTN.DOWN : 0));
    check('absents : 1 vote sur 2 actifs (c, d absents) → bilan', r.s.world.stage.state === 'cleared');
    r.step(1, (pid) => (pid === c ? BTN.JUMP : pid === b ? BTN.DOWN : 0));
    check('absents : c revient par JUMP pendant le bilan → actif et vote (2 sur 3) → étape suivante', !r.s.isAway(c) && r.s.isAway(d) && r.s.world.stage.state === 'playing', r.s.world.stage.state);

    const q = rig(3);
    const [qa, qb, qc] = q.pids;
    q.step(COOP_AWAY_TICKS + 10, (pid, i) => (pid === qa ? wiggle(i) : 0));
    toCleared(q.s);
    q.step(COOP_READY_AFTER + 5, (pid) => (pid === qa ? BTN.DOWN : 0));
    q.step(1, (pid) => (pid === qb ? BTN.RIGHT : pid === qa ? BTN.DOWN : 0)); // b revient sans voter
    q.step(1, (pid) => (pid === qa ? BTN.JUMP : pid === qb ? BTN.RIGHT : 0));
    check('absents : b revient par RIGHT (sans voter) → 1 vote sur 2 actifs ne suffit pas', !q.s.isAway(qb) && q.s.isAway(qc) && q.s.world.stage.state === 'cleared', q.s.world.stage.state);
  }

  // Vote posé puis absence (forcée : en vrai le bilan dure moins de 30 s) : le vote ne compte plus.
  {
    const r = rig(3);
    const [a, b] = r.pids;
    toCleared(r.s);
    r.step(COOP_READY_AFTER + 5, (pid) => (pid === a || pid === b ? BTN.DOWN : 0));
    r.step(1, (pid) => (pid === b ? BTN.JUMP : pid === a ? BTN.DOWN : 0));
    check('absents (préalable) : vote de b enregistré', r.s.world.stage.byPlayer?.[b]?.ready === true && r.s.world.stage.state === 'cleared');
    const slots = (r.s as unknown as { slots: Map<number, { lastActive: number }> }).slots;
    slots.get(b)!.lastActive = r.s.world.tick - COOP_AWAY_TICKS - 5;
    r.step(1, (pid) => (pid === a ? BTN.JUMP : 0));
    check('absents : le vote d’un joueur devenu absent ne compte plus (1 sur 2 actifs)', r.s.isAway(b) && r.s.world.stage.state === 'cleared', r.s.world.stage.state);
  }

  // Départ d'un absent : retiré de w.away et de idleOut au pas suivant.
  {
    const r = rig(2);
    const [a, b] = r.pids;
    r.step(COOP_AWAY_TICKS + 10, (pid, i) => (pid === a ? wiggle(i) : 0));
    r.s.leave(b);
    r.step(1, (pid, i) => (pid === a ? wiggle(i) : null));
    check('absents : un absent parti disparaît de w.away', !away(r.s).includes(b) && !r.s.isAway(b) && r.s.idleOut().length === 0);
  }
}

// 11. Renvoi des absents sur un vrai serveur (délai raccourci en vieillissant lastActive).
{
  const crashes: string[] = [];
  const onCrash = (e: unknown) => crashes.push(String((e as Error)?.stack ?? e).slice(0, 300));
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  const srv = await startServer({ port: 0 });
  const url = `ws://localhost:${srv.port}`;
  const timers: ReturnType<typeof setInterval>[] = [];
  try {
    const codes = new Map<string, number>();
    const reasons = new Map<string, string>();
    const join = async (name: string) => {
      const c = await connect(url, name);
      c.room.onLeave((code: number, reason?: string) => {
        codes.set(name, code);
        reasons.set(name, String(reason));
      });
      await waitFor(() => !!c.welcome, 3000);
      return c;
    };
    const a = await join('Ayame');
    const b = await join('Benkei');
    const c = await join('Chiyo');
    const room = matchMaker.getLocalRoomById(a.room.roomId) as unknown as CoopRoom | undefined;
    check('renvoi : 3 clients dans la même salle', !!room && b.room.roomId === a.room.roomId && c.room.roomId === a.room.roomId && room.coop.playerCount === 3);
    // a joue, b et c laissent l'onglet ouvert (entrées vides à 60 Hz).
    let sa = 1;
    let sb = 1;
    let sc = 1;
    timers.push(setInterval(() => {
      if (!a.left) a.room.send(MSG.input, { s: sa, b: sa % 60 < 30 ? BTN.LEFT : BTN.RIGHT });
      sa++;
      if (!b.left) b.room.send(MSG.input, { s: sb++, b: 0 });
      if (!c.left) c.room.send(MSG.input, { s: sc++, b: 0 });
    }, STEP_MS));
    const pa = a.welcome!.pid;
    const pb = b.welcome!.pid;
    const pc = c.welcome!.pid;
    const colorB = b.welcome!.color;
    const slots = (room!.coop as unknown as { slots: Map<number, { lastActive: number }> }).slots;
    // Absent (pas encore renvoyé) : vu par les autres dans les instantanés.
    slots.get(pb)!.lastActive = room!.coop.world.tick - COOP_AWAY_TICKS - 30;
    const n0 = a.snaps.length;
    const seen = await waitFor(() => a.snaps.length > n0 && !!last(a.snaps)?.away.includes(pb) && !last(a.snaps)!.away.includes(pa), 2000);
    check('renvoi : absent signalé aux autres clients (instantané msgpack réel)', seen, JSON.stringify(last(a.snaps)?.away));
    check('renvoi : absent mais pas encore renvoyé', !b.left && room!.coop.has(pb));
    // Deux absents renvoyés au même tick.
    const t = room!.coop.world.tick;
    slots.get(pb)!.lastActive = t - COOP_KICK_TICKS - 30;
    slots.get(pc)!.lastActive = t - COOP_KICK_TICKS - 30;
    const gone = await waitFor(() => b.left && c.left, 3000);
    check('renvoi : les deux absents renvoyés au même tick', gone, `b ${b.left}, c ${c.left}`);
    check('renvoi : code AWAY_CLOSE_CODE distinct des codes de fermeture Colyseus (FAILED_TO_RECONNECT = 4003…)', !(Object.values(CloseCode) as number[]).includes(AWAY_CLOSE_CODE), `${AWAY_CLOSE_CODE} / ${JSON.stringify(CloseCode)}`);
    check(`renvoi : code de fermeture AWAY_CLOSE_CODE (${AWAY_CLOSE_CODE}) reçu par le client (onLeave, pas de reconnexion)`, codes.get('Benkei') === AWAY_CLOSE_CODE && codes.get('Chiyo') === AWAY_CLOSE_CODE, `${codes.get('Benkei')} « ${reasons.get('Benkei')} » / ${codes.get('Chiyo')} « ${reasons.get('Chiyo')} »`);
    await sleep(200);
    check('renvoi : joueurs retirés de la session et du monde', !room!.coop.has(pb) && !room!.coop.has(pc) && room!.coop.playerCount === 1 && room!.coop.world.players.length === 1);
    const internals = room as unknown as { pids: Map<string, number>; rates: Map<string, unknown>; clients: unknown[] };
    check('renvoi : onLeave a nettoyé la salle (pids, limite de débit, clients)', internals.pids.size === 1 && internals.rates.size === 1 && internals.clients.length === 1, `pids ${internals.pids.size}, rates ${internals.rates.size}, clients ${internals.clients.length}`);
    check('renvoi : le joueur actif reste connecté et reçoit des instantanés', !a.left && (await waitFor(() => a.snaps.length > n0 + 10, 2000)));
    await waitFor(() => !last(a.snaps)?.away.includes(pb), 1000);
    check('renvoi : les renvoyés ne figurent plus dans away', !last(a.snaps)?.away.includes(pb) && !last(a.snaps)?.away.includes(pc), JSON.stringify(last(a.snaps)?.away));
    const d = await join('Daigo');
    check('renvoi : place libérée, la couleur du renvoyé est réutilisée', d.room.roomId === a.room.roomId && d.welcome?.color === colorB && room!.coop.playerCount === 2, `couleur ${d.welcome?.color}, attendu ${colorB}`);
    check('renvoi : le nouvel arrivant n’est pas absent', !room!.coop.isAway(d.welcome!.pid));
    await d.room.leave();
    await a.room.leave();
  } catch (err) {
    check('scénario de renvoi sans exception', false, String((err as Error)?.stack ?? err).slice(0, 400));
  }
  for (const t of timers) clearInterval(t);
  await srv.stop();
  check('renvoi : aucune exception non rattrapée (double leave sans dommage)', crashes.length === 0, crashes.slice(0, 2).join(' | '));
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests serveur passent.');
