// Tests du serveur du dojo (DojoSession, DojoRoom, vraie salle avec des clients SDK, banc réseau).
// Lancer : npm run test:dojoserver
import { Client, type Room } from '@colyseus/sdk';
import { matchMaker } from '@colyseus/core';
import { BTN } from '../shared/input';
import { DOJO, DUEL, DUEL_WHY } from '../shared/constants';
import { duelOf } from '../shared/duel';
import { Rng } from '../shared/math';
import { decodeSnapshot, type SnapshotWire } from '../shared/net/codec';
import { MSG, PROTOCOL_VERSION, ROOMS, SNAP_EVERY, type RoomName, type Snapshot, type WelcomeMsg } from '../shared/net/protocol';
import type { GameEvent, Player, World } from '../shared/types';
import { startServer } from '../server/app';
import { DojoSession } from '../server/dojoSession';
import { CoopSession } from '../server/session';
import type { CoopRoom } from '../server/rooms/CoopRoom';
import { DojoRoom, MAX_DOJO_ROOMS } from '../server/rooms/DojoRoom';
import { type BenchClient, NetBench } from './net/harness';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

type Ev<K extends GameEvent['type']> = Extract<GameEvent, { type: K }>;
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
  console.log('✘ délai global dépassé (240 s)');
  process.exit(1);
}, 240_000).unref();
// Garde-fou : les écouteurs uncaughtException de la section (b) avaleraient une erreur de premier niveau,
// et la suite sortirait en code 0 sans bilan. Sans bilan atteint : échec.
let reachedEnd = false;
process.on('exit', (code) => {
  if (reachedEnd || code !== 0) return;
  console.log('✘ suite interrompue avant son bilan');
  process.exitCode = 1;
});

/** Instantané décodé, avec la liste de tous les joueurs (soi + les autres). */
type TestSnap = Snapshot & { players: Player[] };
const view = (w: SnapshotWire): TestSnap => {
  const d = decodeSnapshot(w);
  return { ...d, players: d.self ? [d.self, ...d.others] : d.others };
};

// ─── (a) DojoSession seule ──────────────────────────────────────────────────

/** Humain scripté : iai tenu pendant la garde, relâché `react` ticks après le signal (entrée consommée au tick courant). */
function iaiAt(w: World, pid: number, react: number): number {
  const d = duelOf(w, pid);
  if (!d || (d.phase !== 'kamae' && d.phase !== 'open') || d.sigTick < 0) return 0;
  return w.tick < d.sigTick + react ? BTN.IAI : 0;
}

/**
 * Pilote d'une session : à chaque pas, chaque humain scripté pousse une entrée (pushInput, séquences croissantes)
 * consommée au pas qui suit ; les événements sont relevés puis vidés, comme après un envoi d'instantanés.
 */
class Driver {
  readonly events: GameEvent[] = [];
  private seqs = new Map<number, number>();
  constructor(readonly s: CoopSession) {}

  push(pid: number, b: number, atMs?: number): boolean {
    const seq = (this.seqs.get(pid) ?? 0) + 1;
    this.seqs.set(pid, seq);
    return this.s.pushInput(pid, { s: seq, b }, atMs);
  }

  /** Au plus `steps` pas ; `script(pid)` : boutons d'un humain (undefined : aucune entrée envoyée). Arrêt dès `stop`. */
  run(steps: number, script: (pid: number) => number | undefined, stop?: () => boolean): number {
    let i = 0;
    for (; i < steps; i++) {
      for (const pid of this.humans()) {
        const b = script(pid);
        if (b !== undefined) this.push(pid, b);
      }
      this.s.update(STEP_MS);
      for (const ev of this.s.pendingEvents) this.events.push(ev);
      this.s.flushEvents();
      if (stop?.()) return i + 1;
    }
    return i;
  }

  /** Joueurs de la session (les bots n'ont pas de place : ils ne poussent rien). */
  humans(): number[] {
    const t = this.s.world.tournament;
    return this.s.world.players.filter((p) => !t?.entrants.some((e) => e.pid === p.id && e.bot) && this.s.has(p.id)).map((p) => p.id);
  }

  of<K extends GameEvent['type']>(type: K): Ev<K>[] {
    return this.events.filter((e): e is Ev<K> => e.type === type);
  }
}

// 1. Monde, places, couleurs, accueil, instantané.
{
  const s = new DojoSession(5);
  check('session du dojo : monde en mode dojo, tournoi en attente', s.world.mode === 'dojo' && s.tournament.phase === 'waiting' && s.tournament.n === 1);
  check('session du dojo : pas de compensation de latence (aucun ennemi, duels jugés sans retour en arrière)', s.world.net === undefined);
  const js = Array.from({ length: DOJO.SIZE }, (_, i) => s.join(`P${i}`));
  check(`${DOJO.SIZE} places : couleurs distinctes 0 à ${DOJO.SIZE - 1}`, new Set(js.map((j) => j.color)).size === DOJO.SIZE && js.every((j, i) => j.color === i), js.map((j) => j.color).join(','));
  let threw = false;
  try {
    s.join('neuvième');
  } catch {
    threw = true;
  }
  check(`${DOJO.SIZE + 1}e joueur refusé par la session`, threw && s.playerCount === DOJO.SIZE);
  const w = s.welcomeFor(js[3].pid);
  check('accueil : mode dojo, protocole v7, couleur du joueur, graine non transmise (bots et tirage imprévisibles)', w.mode === 'dojo' && w.v === PROTOCOL_VERSION && PROTOCOL_VERSION === 7 && w.color === 3 && w.stage === s.world.level.stage && w.seed === 0);
  check('accueil de la route : sans mode (coop)', new CoopSession(5).welcomeFor(0).mode === undefined);
  new Driver(s).run(1, () => 0);
  const snap = view(s.snapshotFor(js[0].pid));
  check('instantané : tournoi transmis (attente, 8 participants, aucun bot)', !!snap.tournament && snap.tournament.phase === 'waiting' && snap.tournament.entrants.length === DOJO.SIZE &&
    snap.tournament.entrants.every((e) => !e.bot) && snap.players.length === DOJO.SIZE);
  s.leave(js[2].pid);
  check('départ en attente : place et couleur libérées', s.join('Hachi').color === 2 && s.playerCount === DOJO.SIZE);
}

// 2. Un humain, des bots, un arrivant pendant le tournoi ; tournoi complet joué par pushInput.
{
  const s = new DojoSession(11);
  const dr = new Driver(s);
  const me = s.join('Luc').pid;
  dr.run(DOJO.WAIT_TICKS + 10, () => 0, () => dr.of('dojoStart').length > 0);
  const t = s.tournament;
  check('un humain seul : départ au bout de l\'attente, 7 bots', dr.of('dojoStart').length === 1 && t.entrants.length === DOJO.SIZE && t.entrants.filter((e) => e.bot).length === DOJO.SIZE - 1);
  check('bots sans place dans la session (une seule place prise)', s.playerCount === 1 && s.world.players.length === DOJO.SIZE);
  check('couleurs distinctes, bots compris', new Set(s.world.players.map((p) => p.color)).size === DOJO.SIZE);
  // Arrivant pendant le tournoi (place réservée juste avant le verrou) : accepté, spectateur.
  let lateErr = '';
  let late = -1;
  try {
    const j = s.join('Tard');
    late = j.pid;
    check('arrivant pendant le tournoi : couleur libre parmi tous les joueurs, bots compris', !s.world.players.some((p) => p.id !== late && p.color === j.color), `couleur ${j.color}`);
  } catch (e) {
    lateErr = String(e);
  }
  check('arrivant pendant le tournoi : accepté sans erreur', lateErr === '' && late >= 0, lateErr);
  const lw = s.welcomeFor(late);
  check('arrivant : accueil en mode dojo', lw.mode === 'dojo' && lw.pid === late);
  dr.run(60 * 60 * 6, (pid) => (pid === me ? iaiAt(s.world, pid, 11) : 0), () => dr.of('dojoChampion').length > 0);
  const res = dr.of('dojoResult');
  check('tournoi complet : 7 matchs, champion désigné', res.length === 7 && t.phase === 'done' && t.champion === t.matches[6].winner, `${res.length} résultats`);
  check('entrées poussées par pushInput (11 ticks, 183 ms) : l\'humain est champion', t.champion === me, `champion ${t.entrants.find((e) => e.pid === t.champion)?.name}`);
  check('l\'humain a passé chaque tour (3 matchs gagnés)', res.filter((r) => r.winner === me).length === 3);
  check('arrivant : spectateur, ni participant ni joué', !t.entrants.some((e) => e.pid === late) && !t.matches.some((m) => m.a === late || m.b === late));
  const snap = view(s.snapshotFor(late));
  check('arrivant : son instantané porte le tournoi (champion)', snap.tournament?.phase === 'done' && snap.tournament.champion === me && !!snap.self && snap.self.id === late);
  dr.run(DOJO.CHAMPION_TICKS + 5, () => 0, () => dr.of('dojoReset').length > 0);
  dr.run(2, () => 0);
  check('remise à zéro : tournoi n° 2 en attente, bots retirés', s.tournament.n === 2 && s.tournament.phase === 'waiting' && s.world.players.length === 2);
  check('remise à zéro : l\'arrivant participe au tournoi suivant', s.tournament.entrants.some((e) => e.pid === late) && s.tournament.entrants.some((e) => e.pid === me));
}

/** Session du dojo avec un humain (`me`), jusqu'au début de son premier match (duel en garde). */
function untilMyMatch(seed: number): { s: DojoSession; dr: Driver; me: number } {
  const s = new DojoSession(seed);
  const dr = new Driver(s);
  const me = s.join('Luc').pid;
  dr.run(DOJO.WAIT_TICKS + DOJO.ROUND_PAUSE + 600, () => 0, () => duelOf(s.world, me)?.phase === 'kamae');
  return { s, dr, me };
}
const myResult = (s: DojoSession, dr: Driver, me: number) =>
  dr.of('dojoResult').find((r) => s.tournament.matches[r.match].a === me || s.tournament.matches[r.match].b === me);

// 3. FLOOD : un client accéléré (deux entrées par pas) en match perd par forfait.
{
  const { s, dr, me } = untilMyMatch(12);
  check('FLOOD : match engagé', !!duelOf(s.world, me));
  let n = 0;
  const steps = dr.run(600, (pid) => {
    if (pid !== me) return 0;
    dr.push(pid, BTN.IAI); // entrée supplémentaire à chaque pas (cadence doublée)
    n++;
    return BTN.IAI;
  }, () => !!myResult(s, dr, me));
  const r = myResult(s, dr, me);
  check('client accéléré en match : forfait FLOOD, l\'adversaire passe', !!r && r.why === DUEL_WHY.FLOOD && r.winner !== me, `${JSON.stringify(r)} après ${steps} pas`);
  check('FLOOD : jugé sur la cadence cumulée (quelques dizaines de pas)', steps > 20 && steps < 200, `${steps} pas, ${2 * n} entrées`);
}

// 4. Départ en plein match : forfait, le parti reste au tableau.
{
  const { s, dr, me } = untilMyMatch(13);
  dr.run(30, (pid) => (pid === me ? BTN.IAI : 0));
  const live = s.tournament.matches.findIndex((m) => m.state === 'live' && (m.a === me || m.b === me));
  s.leave(me);
  dr.run(400, () => 0, () => !!myResult(s, dr, me));
  const r = myResult(s, dr, me);
  check('départ en plein match : forfait (DISCONNECT), l\'adversaire passe', live >= 0 && !!r && r.match === live && r.why === DUEL_WHY.DISCONNECT && r.winner !== me, JSON.stringify(r));
  check('départ en plein match : le parti reste au tableau (gone), sans place', s.tournament.entrants.find((e) => e.pid === me)?.gone === true && !s.has(me) && s.playerCount === 0);
}

// 5. Plus de joueurs que de couleurs (bots + arrivants réservés avant le verrou) : couleur la moins portée.
{
  const s = new DojoSession(14);
  const dr = new Driver(s);
  s.join('Seul');
  dr.run(DOJO.WAIT_TICKS + 10, () => 0, () => dr.of('dojoStart').length > 0);
  const colors: number[] = [];
  for (let i = 0; i < DOJO.SIZE - 1; i++) colors.push(s.join(`R${i}`).color);
  const worn = new Map<number, number>();
  for (const p of s.world.players) worn.set(p.color, (worn.get(p.color) ?? 0) + 1);
  check('15 joueurs pour 12 couleurs : aucune couleur portée plus de deux fois', s.world.players.length === 15 && [...worn.values()].every((n) => n <= 2) && worn.size === 12, colors.join(','));
}

// ─── (b) Vraie salle : clients SDK, verrou pendant le tournoi, coop indépendante ─

interface TestClient {
  room: Room;
  welcome: WelcomeMsg | null;
  snaps: TestSnap[];
  left: boolean;
}

function track(room: Room): TestClient {
  const c: TestClient = { room, welcome: null, snaps: [], left: false };
  room.onMessage(MSG.welcome, (w: WelcomeMsg) => (c.welcome = w));
  room.onMessage(MSG.snap, (s: SnapshotWire) => {
    c.snaps.push(view(s));
    if (c.snaps.length > 50) c.snaps.shift();
  });
  room.onMessage(MSG.ping, () => undefined);
  room.onLeave(() => (c.left = true));
  return c;
}
async function connect(url: string, name: string, room: RoomName = ROOMS.dojo): Promise<TestClient> {
  return track(await new Client(url).joinOrCreate(room, { name }));
}
const last = <T>(a: T[]): T | undefined => a[a.length - 1];

{
  const crashes: string[] = [];
  const onCrash = (e: unknown) => crashes.push(String((e as Error)?.stack ?? e).slice(0, 300));
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  const srv = await startServer({ port: 0 });
  const url = `ws://localhost:${srv.port}`;
  const timers: ReturnType<typeof setInterval>[] = [];
  const all: TestClient[] = [];
  // Journal du serveur (lignes relevées, toujours affichées).
  const logs: string[] = [];
  const consoleLog = console.log;
  const consoleWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    consoleLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    consoleWarn(...args);
  };
  try {
    // Route partagée, en parallèle du dojo : un joueur qui court à droite tout du long.
    const coop = await connect(url, 'Roadie', ROOMS.coop);
    all.push(coop);
    let cs = 0;
    timers.push(setInterval(() => coop.room.send(MSG.input, { s: ++cs, b: BTN.RIGHT }), STEP_MS));

    const a = await connect(url, 'Ayame');
    const b = await connect(url, 'Benkei');
    all.push(a, b);
    await waitFor(() => !!a.welcome && !!b.welcome && !!coop.welcome && b.snaps.length > 2, 3000);
    check('dojo : joinOrCreate(\'dojo\'), même salle, distincte de la coop', a.room.roomId === b.room.roomId && a.room.roomId !== coop.room.roomId);
    check('dojo : accueil en mode dojo, protocole v7, couleurs distinctes', a.welcome?.mode === 'dojo' && a.welcome.v === PROTOCOL_VERSION && b.welcome?.mode === 'dojo' && a.welcome.color !== b.welcome.color);
    check('coop : accueil sans mode (route partagée)', !!coop.welcome && coop.welcome.mode === undefined);
    const sb = last(b.snaps);
    check('dojo : instantanés décodés avec le tournoi (attente, deux participants)', !!sb?.tournament && sb.tournament.phase === 'waiting' && sb.tournament.entrants.length === 2 &&
      sb.tournament.entrants.every((e) => !e.bot) && sb.players.length === 2, JSON.stringify(sb?.tournament?.entrants.map((e) => e.name)));
    check('coop : instantanés sans tournoi', coop.snaps.length > 0 && coop.snaps.every((s) => s.tournament === null));

    const room = matchMaker.getLocalRoomById(a.room.roomId) as unknown as DojoRoom;
    const s = room.dojo;
    check('salle du dojo : session DojoSession, 8 places', s instanceof DojoSession && room.maxClients === DOJO.SIZE);
    // Événements relevés à chaque envoi (et pendant les avances rapides).
    const events: GameEvent[] = [];
    const flush = s.flushEvents.bind(s);
    s.flushEvents = () => {
      for (const ev of s.pendingEvents) events.push(ev);
      flush();
    };
    /**
     * Avance la session du dojo hors du temps réel (pas synchrones, entrées des clients consommées s'il y en a). Les
     * événements sont journalisés par la salle puis vidés tous les SNAP_EVERY pas, comme à chaque envoi d'instantanés.
     */
    const logRoom = () => (room as unknown as { logDuels(): void }).logDuels();
    const fastForward = (max: number, stop: () => boolean): number => {
      let i = 0;
      while (i < max && !stop()) {
        s.update(STEP_MS);
        if (++i % SNAP_EVERY === 0) {
          logRoom();
          s.flushEvents();
        }
      }
      logRoom();
      s.flushEvents();
      return i;
    };
    const has = (type: GameEvent['type']) => events.some((e) => e.type === type);

    // Une place réservée (arrivant qui ne s'est pas encore connecté), puis 5 clients : la salle est pleine.
    const reservation = await matchMaker.joinById(room.roomId, { name: 'Réservé' });
    const more = await Promise.all(Array.from({ length: 5 }, (_, i) => connect(url, `P${i + 3}`)));
    all.push(...more);
    await waitFor(() => more.every((c) => !!c.welcome), 3000);
    check('7 clients + 1 place réservée : même salle', more.every((c) => c.room.roomId === room.roomId) && s.playerCount === 7);
    await waitFor(() => room.locked, 1000);
    check('salle pleine (places réservées comprises) : verrouillée', room.locked);
    const ninth = await connect(url, 'Neuvième');
    check('9e client (joinOrCreate) placé dans une autre salle du dojo', ninth.room.roomId !== room.roomId && (await waitFor(() => ninth.welcome?.mode === 'dojo', 2000)));
    const ninthRoom = ninth.room.roomId;
    await ninth.room.leave();
    await waitFor(() => !matchMaker.getLocalRoomById(ninthRoom), 2000);

    // Un départ en attente : la salle se rouvre.
    const gone = more.pop()!;
    await gone.room.leave();
    check('départ en attente : salle déverrouillée (place libre)', await waitFor(() => !room.locked && s.playerCount === 6, 2000));

    // Fin de l'attente (avance rapide) : des bots complètent, la salle se verrouille.
    fastForward(DOJO.WAIT_TICKS + 60, () => s.tournament.phase !== 'waiting');
    const t1 = s.tournament;
    check('fin de l\'attente : tournoi n° 1 tiré, 6 humains et 2 bots', t1.phase === 'pause' && t1.entrants.length === DOJO.SIZE && t1.entrants.filter((e) => e.bot).length === 2);
    check('tournoi en cours : salle verrouillée', await waitFor(() => room.locked, 1000));

    // La place réservée juste avant le verrou : l'arrivant entre, regarde.
    const spec = track(await new Client(url).consumeSeatReservation(reservation as never));
    all.push(spec);
    await waitFor(() => !!spec.welcome && spec.snaps.length > 0, 3000);
    const specPid = spec.welcome?.pid ?? -1;
    check('place réservée avant le verrou : arrivée acceptée pendant le tournoi (mode dojo)', spec.room.roomId === room.roomId && spec.welcome?.mode === 'dojo' && s.has(specPid));
    check('arrivant : couleur libre parmi tous les joueurs, bots compris', !s.world.players.some((p) => p.id !== specPid && p.color === spec.welcome?.color), `couleur ${spec.welcome?.color}`);
    check('arrivant : spectateur (hors du tableau), tournoi dans ses instantanés', !s.tournament.entrants.some((e) => e.pid === specPid) && last(spec.snaps)?.tournament?.n === 1);
    const late = await connect(url, 'Retard');
    all.push(late);
    check('tournoi en cours : un arrivant (joinOrCreate) va dans une nouvelle salle', late.room.roomId !== room.roomId);
    const lateRoom = late.room.roomId;
    await late.room.leave();
    await waitFor(() => !matchMaker.getLocalRoomById(lateRoom), 2000);

    // Départ en plein match : forfait, et la salle reste verrouillée malgré la place libérée.
    fastForward(DOJO.ROUND_PAUSE + 60, () => s.tournament.phase === 'running');
    const humans = [a, b, ...more];
    const leaver = humans.find((c) => s.tournament.matches.some((m) => m.state === 'live' && (m.a === c.welcome?.pid || m.b === c.welcome?.pid)));
    const lpid = leaver?.welcome?.pid ?? -1;
    const k = s.tournament.matches.findIndex((m) => m.state === 'live' && (m.a === lpid || m.b === lpid));
    if (leaver) await leaver.room.leave();
    const forfeitR = await waitFor(() => events.some((e) => e.type === 'dojoResult' && e.match === k), 2000);
    const r = events.find((e): e is Ev<'dojoResult'> => e.type === 'dojoResult' && e.match === k);
    check('déconnexion en plein match : forfait (DISCONNECT), l\'adversaire passe', !!leaver && forfeitR && !!r && r.why === DUEL_WHY.DISCONNECT && r.winner !== lpid, JSON.stringify(r));
    await sleep(200);
    check('départ pendant le tournoi : la salle reste verrouillée (verrou explicite)', room.locked && s.playerCount === 6);
    const late2 = await connect(url, 'Retard2');
    all.push(late2);
    check('départ pendant le tournoi : un arrivant va toujours ailleurs', late2.room.roomId !== room.roomId);
    const late2Room = late2.room.roomId;
    await late2.room.leave();
    await waitFor(() => !matchMaker.getLocalRoomById(late2Room), 2000);
    // Journal d'une disqualification : résultat SUSPECT glissé dans les événements en attente (la simulation la teste).
    if (r) (s.pendingEvents as GameEvent[]).push({ ...r, why: DUEL_WHY.SUSPECT });

    // Fin du tournoi (avance rapide : les humains inactifs perdent par forfait ABSENT) puis remise à zéro.
    // Un appui de chacun avant l'avance rapide : personne n'est renvoyé comme absent à la remise à zéro.
    const stay = [...humans.filter((c) => c !== leaver), spec];
    stay.forEach((c, i) => c.room.send(MSG.input, { s: 1, b: i % 2 ? BTN.LEFT : BTN.RIGHT }));
    await waitFor(() => stay.every((c) => s.ackFor(c.welcome!.pid) === 1), 2000);
    const ff = fastForward(60 * 60 * 6, () => s.tournament.n === 2);
    await waitFor(() => has('dojoReset'), 1000);
    check('tournoi jusqu\'au bout : champion, puis remise à zéro (tournoi n° 2)', s.tournament.n === 2 && has('dojoChampion') && has('dojoReset'), `${ff} pas`);
    check('après la remise à zéro : salle déverrouillée', await waitFor(() => !room.locked, 2000));
    await waitFor(() => s.tournament.entrants.some((e) => e.pid === specPid), 1000);
    check('le spectateur participe au tournoi suivant', s.tournament.entrants.some((e) => e.pid === specPid) && !s.world.players.some((p) => t1.entrants.some((e) => e.bot && e.pid === p.id)));
    const next = await connect(url, 'Suivant');
    all.push(next);
    await waitFor(() => !!next.welcome, 2000);
    check('salle rouverte : un arrivant (joinOrCreate) la rejoint', next.room.roomId === room.roomId && next.welcome?.mode === 'dojo');
    check('les clients restés reçoivent toujours des instantanés (tournoi n° 2)', (await waitFor(() => stay.every((c) => last(c.snaps)?.tournament?.n === 2), 2000)) && stay.every((c) => !c.left));
    // Journal de la salle : verrou, début, résultats, disqualification, champion, réouverture.
    const mine = logs.filter((l) => l.startsWith(`[dojo ${room.roomId}]`));
    const want = ['salle verrouillée (tournoi n° 1)', 'tournoi n° 1 : début, 6 humain(s), 2 bot(s)', 'quart (match', 'demie (match', 'finale (match', 'disqualifié', 'tournoi n° 1 : champion', 'retour en attente (tournoi n° 2)', 'salle ouverte (attente du tournoi n° 2)'];
    const missing = want.filter((x) => !mine.some((l) => l.includes(x)));
    check('journal du dojo : verrou, début, résultats, disqualification, champion, réouverture', missing.length === 0, missing.length ? `manque ${missing.join(' ; ')}` : `${mine.length} lignes`);

    // La route partagée a tourné pendant tout ce temps.
    const n0 = coop.snaps.length;
    const x0 = last(coop.snaps)?.self?.x ?? 0;
    await sleep(500);
    const x1 = last(coop.snaps)?.self?.x ?? 0;
    const coopRoom = matchMaker.getLocalRoomById(coop.room.roomId) as unknown as CoopRoom;
    check('coop indépendante : instantanés, le joueur avance, monde de la route', coop.snaps.length > n0 + 5 && x1 > x0 + 20 && coopRoom.coop.world.mode === 'coop' && !coop.left, `x ${x0.toFixed(0)} → ${x1.toFixed(0)}`);
  } catch (err) {
    check('scénario de la vraie salle sans exception', false, String((err as Error)?.stack ?? err).slice(0, 400));
  }
  for (const t of timers) clearInterval(t);
  for (const c of all) if (!c.left) await c.room.leave().catch(() => undefined);
  await srv.stop();
  console.log = consoleLog;
  console.warn = consoleWarn;
  check('vraie salle : aucune exception non rattrapée', crashes.length === 0, crashes.slice(0, 2).join(' | '));
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
}

// ─── (c) Banc réseau : équité des matchs du dojo, de 0 à 150 ms par sens ────
// Deux humains forcés face à face en quart (tableau réécrit pendant la pause du premier tour), puis contre les bots.
// Chacun tient l'iai pendant la garde et le relâche quand son tick prédit atteint sigTick + r (r tiré par manche, de
// DUEL.SUSPECT_REACT à 30 ticks : jamais suspect). Le serveur doit mesurer r, et le plus rapide gagner la manche.

type Link = Parameters<NetBench['addClient']>[1];
interface DojoRound {
  /** Réaction voulue par chaque côté (a, b) : -1 pour un bot. */
  want: [number, number];
  /** Réaction mesurée par le serveur (-1 : pas de frappe). */
  got: [number, number];
  pids: [number, number];
  winner: number;
  why: number;
}

function dojoBench(links: [Link, Link], jitterMs: number, tournaments: number, seed: number) {
  const bench = new NetBench({ seed, lagMs: 0, jitterMs, mode: 'dojo' });
  const cs: BenchClient[] = [bench.addClient('A', links[0]), bench.addClient('B', links[1])];
  const w = bench.session.world;
  const rng = new Rng(seed * 31 + 7);
  const want = new Map<string, number>(); // « pid:duel:sigTick » → réaction voulue
  const rounds: DojoRound[] = [];
  const seen = new Set<GameEvent>();
  const forced = new Set<number>();
  let champions = 0;
  let lead = Infinity;
  let faced = 0; // manches A contre B
  bench.onServerStep(() => {
    const t = w.tournament!;
    if (t.phase === 'pause' && t.round === 0 && !forced.has(t.n)) {
      forced.add(t.n);
      const [pa, pb] = cs.map((c) => c.pid);
      const others = t.entrants.filter((e) => e.pid !== pa && e.pid !== pb).map((e) => e.pid);
      [t.matches[0].a, t.matches[0].b] = [pa, pb];
      for (let i = 0; i < 3; i++) [t.matches[1 + i].a, t.matches[1 + i].b] = [others[2 * i], others[2 * i + 1]];
    }
    for (const ev of bench.session.pendingEvents) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      if (ev.type === 'dojoChampion') champions++;
      if (ev.type !== 'duelRound') continue;
      const d = w.duels?.find((x) => x.id === ev.id);
      if (!d) continue;
      const pids: [number, number] = [d.a.pid, d.b.pid];
      const wa = want.get(`${pids[0]}:${d.id}:${d.sigTick}`) ?? -1;
      const wb = want.get(`${pids[1]}:${d.id}:${d.sigTick}`) ?? -1;
      if (wa >= 0 && wb >= 0) faced++;
      if (wa < 0 && wb < 0) continue; // bot contre bot
      rounds.push({ want: [wa, wb], got: [ev.ra, ev.rb], pids, winner: ev.winner, why: ev.why });
    }
  });
  const input = (i: number, frame: number): number => {
    const c = cs[i];
    const cw = c.src.world;
    if (cw.tournament?.phase === 'waiting') return frame % 90 < 3 ? BTN.DUEL : 0; // prêt (G)
    const d = cw.duels?.find((x) => x.a.pid === c.pid || x.b.pid === c.pid);
    if (!d || d.sigTick < 0 || (d.phase !== 'kamae' && d.phase !== 'open')) return 0;
    const tick = bench.predictedTick(c);
    const key = `${c.pid}:${d.id}:${d.sigTick}`;
    let r = want.get(key);
    if (r === undefined) {
      lead = Math.min(lead, d.sigTick - tick); // avance du signal : premier instant où le client le connaît
      r = DUEL.SUSPECT_REACT + Math.floor(rng.next() * (31 - DUEL.SUSPECT_REACT));
      want.set(key, r);
    }
    return tick < d.sigTick + r ? BTN.IAI : 0;
  };
  for (let guard = 0; champions < tournaments && guard < 60 * tournaments; guard++) bench.run(5000, input);
  return { rounds, champions, lead, faced, flood: rounds.some((r) => r.why === DUEL_WHY.FLOOD) };
}

/** Réaction d'un côté : voulue (humain) ou mesurée (bot). */
const reactOf = (r: DojoRound, j: 0 | 1): number => (r.want[j] >= 0 ? r.want[j] : r.got[j]);

function judge(tag: string, res: ReturnType<typeof dojoBench>): void {
  const err = res.rounds.flatMap((r) => ([0, 1] as const).filter((j) => r.want[j] >= 0 && r.got[j] >= 0).map((j) => r.got[j] - r.want[j]));
  const errs = [...new Set(err)].sort((x, y) => x - y).join(',');
  check(`${tag} : réaction mesurée par le serveur = réaction voulue, exactement`, err.length >= 20 && err.every((e) => e === 0), `écarts ${errs} sur ${err.length} réactions`);
  const decisive = res.rounds.filter((r) => r.why !== DUEL_WHY.FOUL && r.why !== DUEL_WHY.DOUBLE_FOUL && reactOf(r, 0) >= 0 && reactOf(r, 1) >= 0 && Math.abs(reactOf(r, 0) - reactOf(r, 1)) >= 2);
  const fair = decisive.filter((r) => r.winner === (reactOf(r, 0) < reactOf(r, 1) ? r.pids[0] : r.pids[1]));
  check(`${tag} : le plus rapide gagne ses manches (écart ≥ 2 ticks)`, decisive.length >= 8 && fair.length === decisive.length, `${fair.length}/${decisive.length}, dont ${res.faced} manches A–B`);
  check(`${tag} : ${res.champions} tournois menés au bout, A et B face à face, aucun FLOOD`, res.faced >= 2 * res.champions && !res.flood, `${res.faced} manches A–B`);
  check(`${tag} : signal connu ≥ 60 ticks à l'avance`, res.lead >= 60, `${res.lead}`);
}

{
  const t0 = performance.now();
  // [libellé, liens de A et B, gigue par défaut des liens (ms)]
  const configs: [string, [Link, Link], number][] = [
    ['0/0 ms', [{ lagMs: 0 }, { lagMs: 0 }], 0],
    ['150/150 ms', [{ lagMs: 150 }, { lagMs: 150 }], 0],
    ['75/150 ms', [{ lagMs: 75 }, { lagMs: 150 }], 0],
    ['A ↑0 ↓150, B ↑150 ↓0 ms', [{ up: { lagMs: 0 }, down: { lagMs: 150 } }, { up: { lagMs: 150 }, down: { lagMs: 0 } }], 0],
    ['75/75 ms + gigue 20 ms', [{ lagMs: 75 }, { lagMs: 75 }], 20],
    ['0/150 ms + gigue 30 ms', [{ lagMs: 0 }, { lagMs: 150 }], 30],
    ['150/150 ms + gigue 40 ms', [{ lagMs: 150 }, { lagMs: 150 }], 40],
    ['A ↑150 ↓0, B ↑0 ↓150 ms + gigue 30 ms', [{ up: { lagMs: 150 }, down: { lagMs: 0 } }, { up: { lagMs: 0 }, down: { lagMs: 150 } }], 30],
  ];
  configs.forEach(([tag, links, jitter], i) => judge(`dojo ${tag}`, dojoBench(links, jitter, 4, 100 + i)));
  console.log(`  (banc du dojo : ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

// ─── (d) Sous-plafond des salles dojo : la coop peut toujours ouvrir des salles ─
{
  const srv = await startServer({ port: 0 });
  const made: string[] = [];
  let refused = '';
  try {
    for (let i = 0; i < MAX_DOJO_ROOMS + 1; i++) {
      try {
        made.push((await matchMaker.createRoom(ROOMS.dojo, {})).roomId);
      } catch (e) {
        refused = (e as Error).message;
        break;
      }
    }
    check(`sous-plafond : au plus MAX_DOJO_ROOMS (${MAX_DOJO_ROOMS}) salles dojo, la suivante refusée (« server full »)`, made.length === MAX_DOJO_ROOMS && /server full/.test(refused) && DojoRoom.open === MAX_DOJO_ROOMS,
      `${made.length} créées, ${DojoRoom.open} ouvertes, refus « ${refused} »`);
    let coopOk = false;
    try {
      coopOk = !!(await matchMaker.createRoom(ROOMS.coop, {})).roomId;
    } catch {
      coopOk = false;
    }
    check('dojos au sous-plafond : une salle coop se crée encore', coopOk);
  } finally {
    await srv.stop();
  }
  check('arrêt du serveur : aucune salle dojo comptée ouverte', DojoRoom.open === 0, `${DojoRoom.open}`);
}

reachedEnd = true;
if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du serveur du dojo passent.');
