// Tests de la source de monde distante (instantanés injectés, sans réseau).
// Lancer : npm run test:remote
export {}; // module isolé (déclarations locales au fichier)
import { pack, unpack } from 'msgpackr';
import { EventGate, HIT_MATCH_TICKS, PREDICTED_TYPES } from '../client/net/eventGate';
import { RemoteSource, SNAP_INTERVAL_MS } from '../client/net/remoteSource';
import type { Transport } from '../client/net/transport';
import { BTN } from '../shared/input';
import { decodeSnapshot, encodeSnapshot, type SnapshotWire } from '../shared/net/codec';
import { PROTOCOL_VERSION, type InputMsg, type WelcomeMsg } from '../shared/net/protocol';
import { makeSnapshot } from '../shared/net/snapshot';
import type { GameEvent, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, stepWorld } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Passe un message par le vrai encodage réseau (msgpack). */
const wire = <T>(m: T): T => unpack(pack(m)) as T;

/** Faux transport : enregistre les envois, permet de pousser des messages et de simuler une coupure. */
class FakeTransport implements Transport {
  inputs: InputMsg[] = [];
  pings = 0;
  left = 0;
  rtt = 0;
  welcomeCb: ((m: WelcomeMsg) => void) | null = null;
  snapCb: ((m: SnapshotWire) => void) | null = null;
  closeCb: ((r: string) => void) | null = null;
  onWelcome(cb: (m: WelcomeMsg) => void): void {
    this.welcomeCb = cb;
  }
  onSnapshot(cb: (m: SnapshotWire) => void): void {
    this.snapCb = cb;
  }
  onClose(cb: (r: string) => void): void {
    this.closeCb = cb;
  }
  sendInput(msg: InputMsg): void {
    this.inputs.push(msg);
  }
  ping(): void {
    this.pings++;
  }
  leave(): void {
    this.left++;
  }
}

/** Fait avancer le monde serveur en collectant ses événements. */
function run(w: World, ticks: number, input: (t: number, id: number) => number): GameEvent[] {
  const evs: GameEvent[] = [];
  const m = new Map<number, number>();
  for (let t = 0; t < ticks; t++) {
    for (const p of w.players) m.set(p.id, input(t, p.id));
    stepWorld(w, m);
    evs.push(...w.events);
    w.events.length = 0;
  }
  return evs;
}

const SEED = 4242;
/** Fait tourner la source ~2 s sans nouvel instantané : les événements différés sont libérés. */
function drain(src: RemoteSource): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < 120; i++) {
    clock += 1000 / 60;
    out.push(...src.advance(1 / 60, () => 0, () => undefined));
  }
  return out;
}
/** Événements du serveur que le client doit montrer : tous, sauf les doublons de ses actions prédites. */
const expectedFor = (evs: GameEvent[], me: number): GameEvent[] =>
  evs.filter((ev) => !((ev as { pid?: number }).pid === me && PREDICTED_TYPES.has(ev.type) && !['hit', 'block', 'deflect', 'guardBreak'].includes(ev.type)));
/** Comparaison sans tenir compte de l'ordre (événements immédiats puis différés). */
const sameBag = (a: GameEvent[], b: GameEvent[]): boolean => {
  const k = (xs: GameEvent[]) => xs.map((x) => JSON.stringify(x)).sort().join('|');
  return a.length === b.length && k(a) === k(b);
};
/** Message d'accueil du protocole courant. */
const hello = (pid: number, seed: number, stage: number, tick: number, color = 0): WelcomeMsg => ({ pid, seed, stage, tick, color, v: PROTOCOL_VERSION });
let clock = 0;
const now = (): number => clock;

// 1. Reproduction de l'état du serveur, événements transmis une seule fois.
{
  const server = createWorld(SEED, { mode: 'coop' });
  const a = addPlayer(server, 'Ayame', { color: 2 });
  const b = addPlayer(server, 'Benkei', { color: 7 });
  const c = addPlayer(server, 'Chiyo', { color: 9 });
  b.x += 150;
  c.x += 300;
  const t = new FakeTransport();
  const src = new RemoteSource(t, { now });

  // Instantané reçu avant l'accueil : ignoré.
  const early = run(server, 5, () => 0);
  t.snapCb!(wire(makeSnapshot(server, a.id, early, 0)));
  let before = 0;
  const evEarly = src.advance(1 / 60, () => 0, () => before++);
  check('instantané avant l’accueil ignoré (rien appliqué, rien envoyé)', evEarly.length === 0 && before === 0 && t.inputs.length === 0 && !src.ready && src.meId === -1);

  t.welcomeCb!(wire<WelcomeMsg>(hello(a.id, SEED, server.level.stage, server.tick, 2)));
  check('accueil : id du joueur, graine, niveau signalé à repeindre', src.meId === a.id && src.world.seed === SEED && src.world.mode === 'coop' && src.consumeStageChanged() && !src.consumeStageChanged());

  const evs1 = run(server, 300, (tk, id) => (id === a.id ? BTN.RIGHT | (tk % 40 === 0 ? BTN.ATTACK : 0) : tk % 25 === 0 ? BTN.JUMP : 0));
  const raw1 = wire(makeSnapshot(server, a.id, evs1, 12));
  const snap1 = decodeSnapshot(raw1);
  src.receive(raw1);
  let readyCalls = 0;
  src.onReady(() => readyCalls++);
  before = 0;
  const got1 = src.advance(1 / 60, () => 0, () => before++);
  const w = src.world;
  const samePlayers =
    w.players.length === 3 &&
    server.players.every((p) => {
      const q = w.players.find((x) => x.id === p.id);
      return !!q && q.x === p.x && q.y === p.y && q.vx === p.vx && q.state === p.state && q.hp === p.hp && q.name === p.name && q.color === p.color;
    });
  check('joueurs reproduits à l’identique', samePlayers, `${w.players.length} joueurs`);
  const sameEnemies = w.enemies.length === snap1.enemies.length && w.enemies.every((e, i) => e.id === snap1.enemies[i].id && e.x === snap1.enemies[i].x && e.y === snap1.enemies[i].y && e.hp === snap1.enemies[i].hp);
  check('ennemis, projectiles et orbes reproduits', sameEnemies && w.projectiles.length === snap1.projectiles.length && w.orbs.length === snap1.orbs.length, `${w.enemies.length} ennemis`);
  check('tick, étape et Marée reproduits', w.tick === server.tick && w.stage.state === server.stage.state && w.wave.phase === server.wave.phase);
  const all1 = got1.concat(drain(src));
  const want1 = expectedFor(snap1.events, a.id);
  check('événements de l’instantané montrés une fois (doublons des actions prédites écartés)', sameBag(all1, want1), `${all1.length}/${want1.length} événements, ${snap1.events.length} reçus`);
  check('en ligne, pas d’interpolation de scène : beforeStep jamais appelé, alpha = 1', before === 0 && src.alpha() === 1);
  check('prêt après le premier instantané (onReady une fois), accusé mémorisé', src.ready && readyCalls === 1 && src.ack === 12);
  check('pas de changement d’étape signalé', !src.consumeStageChanged());

  const got2 = src.advance(1 / 60, () => 0, () => before++);
  check('événements transmis une seule fois (rien sans nouvel instantané)', got2.length === 0);

  // Doublon (même tick) ignoré.
  src.receive(wire(raw1));
  const got3 = src.advance(1 / 60, () => 0, () => before++).concat(drain(src));
  check('instantané dupliqué ignoré', got3.length === 0);

  // Plusieurs instantanés entre deux images : tous appliqués dans l'ordre, événements concaténés.
  const e2 = run(server, 3, () => BTN.ATTACK);
  const s2 = decodeSnapshot(wire(makeSnapshot(server, a.id, [...e2, { type: 'tideWarn', n: 1 }], 13)));
  const e3 = run(server, 3, () => 0);
  const s3 = decodeSnapshot(wire(makeSnapshot(server, a.id, [...e3, { type: 'tideWarn', n: 2 }], 14)));
  src.receive(wire(encodeSnapshot(s2)));
  src.receive(wire(encodeSnapshot(s3)));
  const got4 = src.advance(0, () => 0, () => before++);
  const stateOk = src.world.tick >= server.tick && src.ack === 14;
  const all4 = got4.concat(drain(src));
  const want4 = expectedFor([...s2.events, ...s3.events], a.id);
  check('deux instantanés en attente : événements des deux, état du dernier', stateOk && sameBag(all4, want4), `${all4.length}/${want4.length} événements`);
  src.dispose();
  check('dispose quitte la salle une seule fois', t.left === 1 && (src.dispose(), t.left === 1));
}

// 2. Changement d'étape : niveau reconstruit depuis la graine, même référence de niveau.
{
  const server = createWorld(SEED + 1, { mode: 'coop' });
  const a = addPlayer(server, 'a');
  addPlayer(server, 'b');
  run(server, 10, () => 0);
  const t = new FakeTransport();
  const src = new RemoteSource(t, { now });
  src.welcome(hello(a.id, SEED + 1, server.level.stage, server.tick));
  src.consumeStageChanged();
  src.receive(wire(makeSnapshot(server, a.id, [], 0)));
  src.advance(0, () => 0, () => undefined);
  const levelRef = src.world.level;
  const stage0 = levelRef.stage;
  nextStage(server);
  const evs = [...server.events];
  server.events.length = 0;
  run(server, 2, () => 0);
  src.receive(wire(makeSnapshot(server, a.id, evs, 0)));
  src.advance(0, () => 0, () => undefined);
  const L = src.world.level;
  const same = L.stage === server.level.stage && L.w === server.level.w && L.biome === server.level.biome && L.tiles.every((x, i) => x === server.level.tiles[i]);
  check('nouvelle étape : stageChanged signalé une fois', src.consumeStageChanged() && !src.consumeStageChanged(), `${stage0} → ${L.stage}`);
  check('niveau reconstruit identique au serveur, même référence', same && L === levelRef, L.biome);
  src.dispose();
}

// 2 bis. Accueil en cours de partie (étape > 1) : le premier instantané reconstruit l'étape.
{
  const server = createWorld(SEED + 2, { mode: 'coop' });
  const a = addPlayer(server, 'late');
  run(server, 2, () => 0);
  nextStage(server);
  server.events.length = 0;
  const t = new FakeTransport();
  const src = new RemoteSource(t, { now });
  src.welcome(hello(a.id, SEED + 2, server.level.stage, server.tick));
  src.receive(wire(makeSnapshot(server, a.id, [], 0)));
  src.advance(0, () => 0, () => undefined);
  const L = src.world.level;
  check('arrivée en étape avancée : niveau de l’étape reconstruit', src.consumeStageChanged() && L.stage === server.level.stage && L.tiles.every((x, i) => x === server.level.tiles[i]));
  src.dispose();
}

// 3. Entrées : 60 Hz, séquences croissantes, boutons échantillonnés ; pings périodiques.
{
  const t = new FakeTransport();
  const src = new RemoteSource(t, { now });
  src.welcome(hello(1, 1, 1, 0));
  const pings0 = t.pings;
  let b = 0;
  const sample = () => ++b;
  // 1 s d'images irrégulières (16 ms, 17 ms, 33 ms…).
  const frames = [0.016, 0.017, 0.033, 0.008, 0.026];
  let total = 0;
  while (total < 1 - 1e-9) {
    const dt = Math.min(frames[Math.floor(total * 1000) % frames.length], 1 - total);
    total += dt;
    src.advance(dt, sample, () => undefined);
  }
  const n = t.inputs.length;
  const increasing = t.inputs.every((m, i) => m.s === i + 1);
  check('≈60 entrées par seconde', n >= 59 && n <= 60, `${n}`);
  check('séquences strictement croissantes depuis 1', increasing && src.inputSeq === n);
  check('boutons échantillonnés à chaque envoi', t.inputs.every((m, i) => m.b === i + 1));
  // Image très longue (onglet en arrière-plan) : pas de rafale.
  const before = t.inputs.length;
  src.advance(5, sample, () => undefined);
  check('pas de rafale après une longue pause', t.inputs.length - before <= 4, `${t.inputs.length - before}`);
  check('ping à l’accueil puis toutes les 2 s', t.pings - pings0 >= 1 && pings0 === 1, `${t.pings}`);
  src.dispose();
}

// 4. alpha() borné, coupure relayée, plus rien après la coupure.
{
  const server = createWorld(SEED + 3, { mode: 'coop' });
  const a = addPlayer(server, 'a');
  const t = new FakeTransport();
  const src = new RemoteSource(t, { now });
  clock = 1000;
  check('alpha = 1 avant tout instantané', src.alpha() === 1);
  src.welcome(hello(a.id, SEED + 3, 1, 0));
  run(server, 3, () => 0);
  src.receive(wire(makeSnapshot(server, a.id, [], 0)));
  src.advance(0, () => 0, () => undefined);
  const a0 = src.alpha();
  clock += SNAP_INTERVAL_MS / 2;
  const aHalf = src.alpha();
  check('alpha toujours 1 en ligne (positions déjà lissées par la source)', a0 === 1 && aHalf === 1);

  const reasons: string[] = [];
  src.onClose((r) => reasons.push(r));
  t.closeCb!('Connection lost.');
  t.closeCb!('again');
  const sentBefore = t.inputs.length;
  run(server, 3, () => 0);
  src.receive(wire(makeSnapshot(server, a.id, [{ type: 'tideWarn', n: 3 }], 0)));
  const after = src.advance(0.1, () => 0, () => undefined);
  check('coupure relayée une seule fois', reasons.length === 1 && reasons[0] === 'Connection lost.' && src.closed === 'Connection lost.');
  check('après la coupure : ni entrées ni événements', t.inputs.length === sentBefore && after.length === 0);
  const late: string[] = [];
  src.onClose((r) => late.push(r));
  check('abonnement tardif à la coupure : rappel immédiat', late.length === 1);
  src.dispose();
}

// 5. File d'instantanés saturée (onglet en arrière-plan) : ordre, report des événements, doublons.
{
  const server = createWorld(SEED + 4, { mode: 'coop' });
  const a = addPlayer(server, 'a');
  run(server, 2, () => 0);
  const base = decodeSnapshot(wire(makeSnapshot(server, a.id, [], 0)));
  /** Instantané au tick t portant des événements marqueurs (tideWarn n = identifiant unique). */
  const mk = (t: number, ids: number[]): SnapshotWire => wire(encodeSnapshot({ ...base, t, ack: t, events: ids.map((n) => ({ type: 'tideWarn' as const, n })) }));
  const ids = (evs: GameEvent[]): number[] => evs.filter((e) => e.type === 'tideWarn').map((e) => (e as { n: number }).n);
  const fresh = () => {
    const t = new FakeTransport();
    const src = new RemoteSource(t, { now });
    src.welcome(hello(a.id, SEED + 4, server.level.stage, 0));
    return src;
  };
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  // 5a. 30 instantanés sans image : file plafonnée, aucun événement perdu ni dupliqué, ordre conservé.
  {
    const src = fresh();
    for (let t = 1; t <= 30; t++) src.receive(mk(t, [t]));
    const got = ids(src.advance(0, () => 0, () => undefined));
    check('file saturée : événements de tous les instantanés, une fois, dans l’ordre', got.join() === range(1, 30).join(), got.join());
    check('file saturée : état du dernier instantané', src.world.tick === 30 && src.ack === 30, `tick=${src.world.tick}`);
    check('file saturée : plus rien ensuite', src.advance(0, () => 0, () => undefined).length === 0);
    src.dispose();
  }

  // 5b. Débordement massif : report borné, mais jamais de doublon ni de désordre, les plus récents gardés.
  {
    const src = fresh();
    let n = 0;
    for (let t = 1; t <= 60; t++) src.receive(mk(t, range(n + 1, (n += 15))));
    const got = ids(src.advance(0, () => 0, () => undefined));
    const sorted = got.every((v, i) => i === 0 || v > got[i - 1]);
    check('débordement massif : aucun doublon, ordre croissant', sorted && new Set(got).size === got.length, `${got.length} événements`);
    check('débordement massif : les événements les plus récents sont tous là', got.slice(-15 * 19).join() === range(n - 15 * 19 + 1, n).join());
    src.dispose();
  }

  // 5c. Doublon (même tick) en tête de file au moment du débordement : ses événements ne doivent pas sortir deux fois.
  {
    const src = fresh();
    const dup = mk(1, [1]);
    src.receive(dup);
    src.receive(wire(dup)); // même instantané reçu deux fois
    for (let t = 2; t <= 21; t++) src.receive(mk(t, [t]));
    const got = ids(src.advance(0, () => 0, () => undefined));
    check('doublon puis débordement : chaque événement une seule fois', got.join() === range(1, 21).join(), got.join());
    src.dispose();
  }

  // 5d. Retardataire (tick déjà appliqué) derrière l'instantané abandonné : les événements reportés ne doivent pas se perdre.
  {
    const src = fresh();
    src.receive(mk(100, [100]));
    src.advance(0, () => 0, () => undefined);
    src.receive(mk(120, [120])); // sera abandonné (débordement)…
    src.receive(mk(90, [90])); // … et reporté sur ce retardataire, qui est ignoré
    for (let t = 121; t <= 139; t++) src.receive(mk(t, [t]));
    const got = ids(src.advance(0, () => 0, () => undefined));
    check('retardataire derrière un instantané abandonné : événements reportés non perdus', got.includes(120) && got.filter((v) => v === 120).length === 1, got.slice(0, 5).join());
    src.dispose();
  }

  // 5e. Changement d'étape pendant le débordement : niveau reconstruit, stageStart transmis une fois.
  {
    const w2 = createWorld(SEED + 5, { mode: 'coop' });
    const p = addPlayer(w2, 'p');
    const t = new FakeTransport();
    const src = new RemoteSource(t, { now });
    src.welcome(hello(p.id, SEED + 5, w2.level.stage, w2.tick));
    src.receive(wire(makeSnapshot(w2, p.id, run(w2, 3, () => 0), 0)));
    src.advance(0, () => 0, () => undefined);
    src.consumeStageChanged();
    const levelRef = src.world.level;
    const snaps: SnapshotWire[] = [];
    for (let i = 0; i < 30; i++) {
      let evs = run(w2, 3, () => 0);
      if (i === 2 || i === 6) {
        nextStage(w2); // deux changements d'étape, tous deux dans des instantanés abandonnés
        evs = evs.concat(w2.events);
        w2.events.length = 0;
      }
      snaps.push(wire(makeSnapshot(w2, p.id, evs, i)));
    }
    for (const s of snaps) src.receive(s);
    const got = src.advance(0, () => 0, () => undefined);
    const L = src.world.level;
    const starts = got.filter((e) => e.type === 'stageStart');
    check('débordement + changements d’étape : stageChanged signalé', src.consumeStageChanged());
    check('débordement + changements d’étape : niveau final identique au serveur, même référence', L === levelRef && L.stage === w2.level.stage && L.tiles.every((x, i) => x === w2.level.tiles[i]), `${L.stage} / ${w2.level.stage}`);
    check('débordement + changements d’étape : deux stageStart, une fois chacun, dans l’ordre', starts.length === 2 && (starts[0] as { loop: number }).loop < (starts[1] as { loop: number }).loop, `${starts.length}`);
    check('débordement + changements d’étape : état final du serveur', src.world.tick === w2.tick && src.world.stage.loop === w2.stage.loop);
    src.dispose();
  }
}

// 6. Aiguillage des événements (module pur).
{
  const ME = 5;
  const OTHER = 9;
  const g = new EventGate(ME);
  const swing: GameEvent = { type: 'swing', x: 100, y: 0, dir: 1, attack: 'slash1', pid: ME };
  const hit = (target: number, pid: number): GameEvent => ({ type: 'hit', x: 100, y: 0, dir: 1, damage: 10, heavy: false, targetId: target, pid });
  // Coup prédit sur la cible 42 au tick 100.
  check('événements prédits : sortent tels quels', g.predicted([swing, hit(42, ME)], 100).length === 2);
  const now1 = g.server([swing, hit(42, ME), hit(43, ME)], 104);
  check('doublons des actions prédites écartés ; coup non prédit montré', now1.length === 1 && now1[0].type === 'hit' && (now1[0] as { targetId: number }).targetId === 43);
  const late = g.server([hit(42, ME)], 104 + HIT_MATCH_TICKS + 50);
  check('second coup sur la même cible, sans prédiction correspondante : montré', late.length === 1);
  const parry: GameEvent = { type: 'parry', x: 100, y: 0, pid: ME };
  const otherSwing: GameEvent = { type: 'swing', x: 300, y: 0, dir: 1, attack: 'slash1', pid: OTHER };
  const kill: GameEvent = { type: 'kill', id: 42, x: 100, y: 0, dir: 1, facing: 1, enemyType: 'ashigaru', cutAngle: 0, byIai: false, honor: 1, pid: ME } as GameEvent;
  const tide: GameEvent = { type: 'tideWarn', n: 2 };
  const now2 = g.server([parry, otherSwing, kill, tide], 200);
  check('événements à moi non prédits et de salle : tout de suite', now2.length === 2 && now2.some((e) => e.type === 'parry') && now2.some((e) => e.type === 'tideWarn'));
  check('rien n’est libéré avant le tick de rendu', g.release(199.5).length === 0 && g.pending === 2);
  const rel = g.release(200);
  check('autres joueurs et corps tranchés : libérés au tick de rendu, dans l’ordre', rel.length === 2 && rel[0].type === 'swing' && rel[1].type === 'kill' && g.pending === 0);
  g.reset();
  check('reset : plus rien en attente', g.pending === 0 && g.release(1e9).length === 0);
  // Flèche tranchée : la prédiction ne simule pas les projectiles ; l'étincelle du serveur est montrée.
  const g2 = new EventGate(ME);
  const deflect = (x: number): GameEvent => ({ type: 'deflect', x, y: 0, pid: ME });
  check('flèche tranchée non prédite : montrée', g2.server([deflect(500)], 50).length === 1);
  g2.predicted([deflect(500)], 60);
  check('flèche tranchée prédite : doublon du serveur écarté, une autre plus loin montrée', g2.server([deflect(510)], 62).length === 0 && g2.server([deflect(900)], 62).length === 1);
}

// QA. Instantanés malformés (tronqués, mal typés) : le client ne plante jamais.
// Attendu : ni receive ni advance ne lèvent d'exception ; soit la connexion est fermée avec une raison,
// soit le monde affiché reste fini (aucune position NaN).
{
  const server = createWorld(SEED + 5, { mode: 'coop' });
  const me = addPlayer(server, 'Q', { color: 1 });
  addPlayer(server, 'R', { color: 2 });
  const evs = run(server, 120, (tk) => (tk % 20 === 0 ? BTN.ATTACK | BTN.RIGHT : BTN.RIGHT));
  const good = wire(makeSnapshot(server, me.id, evs, 3)) as unknown as unknown[];
  run(server, 3, () => 0);
  const next = wire(makeSnapshot(server, me.id, [], 4)) as unknown as unknown[];
  const variants: [string, unknown][] = [];
  for (let k = 0; k < next.length; k++) variants.push([`tronqué à ${k} élément(s)`, next.slice(0, k)]);
  for (let k = 0; k < next.length; k++) {
    const v = next.slice();
    v[k] = null;
    variants.push([`élément ${k} = null`, v]);
  }
  for (let k = 3; k < next.length; k++) {
    const v = next.slice();
    v[k] = Array.isArray(v[k]) ? [] : 'x';
    variants.push([`élément ${k} vidé ou mal typé`, v]);
  }
  for (const k of [6, 7, 8, 9, 10, 11]) {
    const v = next.slice();
    const arr = v[k];
    if (Array.isArray(arr) && arr.length) {
      v[k] = k === 6 ? arr.slice(0, 3) : arr.map((x) => (Array.isArray(x) ? x.slice(0, 2) : x));
      variants.push([`tuples de l’élément ${k} tronqués`, v]);
    }
  }
  variants.push(['événement d’index inconnu', [...next.slice(0, 11), [[999, 1, 2], [null], null, 'z']]]);
  variants.push(['tick non numérique', ['abc', ...next.slice(1)]]);
  variants.push(['null', null], ['nombre', 42], ['chaîne', 'snap'], ['objet', { t: 1 }]);
  const bad: string[] = [];
  const nan: string[] = [];
  const notRecovered: string[] = [];
  const behaviour: string[] = [];
  for (const [name, v] of variants) {
    const t = new FakeTransport();
    const src = new RemoteSource(t, { now });
    t.welcomeCb!(wire<WelcomeMsg>(hello(me.id, SEED + 5, server.level.stage, server.tick - 3, 1)));
    src.receive(good as unknown as SnapshotWire);
    src.advance(1 / 60, () => 0, () => undefined);
    let err = '';
    try {
      src.receive(v as SnapshotWire);
      for (let i = 0; i < 30; i++) {
        clock += 1000 / 60;
        src.advance(1 / 60, () => BTN.RIGHT, () => undefined);
      }
    } catch (x) {
      err = String((x as Error)?.message ?? x).slice(0, 80);
    }
    const finiteNow = (): boolean =>
      src.world.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) && src.world.enemies.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y));
    const finite = finiteNow();
    if (!err && !src.closed && !finite) nan.push(name);
    // Reprise : des instantanés valides plus récents rétablissent un affichage correct.
    if (!err && !src.closed) {
      let recovered = false;
      try {
        for (let i = 0; i < 10; i++) {
          run(server, 3, () => 0);
          src.receive(wire(makeSnapshot(server, me.id, [], 5 + i)));
          clock += 50;
          src.advance(0.05, () => 0, () => undefined);
        }
        clock += 500;
        src.advance(0.5, () => 0, () => undefined);
        recovered = finiteNow() && src.world.players.length === 2 && Number.isFinite(src.interp.renderTick(clock));
      } catch (x) {
        err = String((x as Error)?.message ?? x).slice(0, 80);
      }
      if (!recovered) notRecovered.push(name);
    }
    if (err) bad.push(`${name} → ${err}`);
    behaviour.push(`${name}: ${err ? 'exception' : src.closed ? 'fermé' : finite ? 'ignoré/appliqué' : 'appliqué avec NaN'}`);
  }
  check('instantanés malformés : aucune exception (receive, advance)', bad.length === 0, bad.slice(0, 4).join(' ; '));
  check('… non fermé : le client reprend avec les instantanés valides suivants', notRecovered.length === 0, notRecovered.join(' ; '));
  if (nan.length) console.log(`· NOTE : appliqués sans fermeture, avec des positions NaN : ${nan.join(' ; ')}`);
  console.log(`· comportements : ${behaviour.join(' | ')}`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de la source distante passent.');
