// Tests de l'horloge serveur estimée et de l'interpolation des entités distantes.
// Lancer : npm run test:interp
export {};
import { pack, unpack } from 'msgpackr';
import { ServerClock } from '../client/net/clock';
import { Interpolator } from '../client/net/interpolator';
import { createEnemy } from '../shared/enemy';
import { BTN } from '../shared/input';
import { Rng } from '../shared/math';
import { decodeSnapshot } from '../shared/net/codec';
import { INTERP_MAX_TICKS, INTERP_MIN_TICKS, NET_TICK, SNAP_EVERY, type Snapshot } from '../shared/net/protocol';
import { makeSnapshot } from '../shared/net/snapshot';
import { createPlayer } from '../shared/player';
import type { Enemy, Player } from '../shared/types';
import { addPlayer, createWorld, stepWorld } from '../shared/world';
import { NetBench } from './net/harness';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const TICK_MS = 1000 / NET_TICK;
const FRAME_MS = 1000 / 60;

// ---------------------------------------------------------------------------
// 1. Simulation : monde serveur à 60 Hz, instantanés à 20 Hz avec latence et gigue, client à 60 images/s.
// ---------------------------------------------------------------------------

interface SimResult {
  frames: number;
  monotone: boolean;
  maxErrAfter2s: number;
  underruns: number;
  maxJumpRatio: number;
  jumpsOver: number;
  delays: number[];
  maxDelayStep: number;
}

function simulate(opts: { seed: number; lagMs: number; jitterMs: number; durationMs: number; stampAtFrame?: boolean }): SimResult {
  const w = createWorld(opts.seed, { mode: 'coop' });
  const players = [0, 1, 2, 3].map((i) => addPlayer(w, `p${i}`, { color: i }));
  const viewer = players[0].id;
  const interp = new Interpolator(() => 0);
  const rng = new Rng(opts.seed * 31 + 7);
  const moves = [0, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.RIGHT | BTN.DASH, BTN.PARRY];
  const held = players.map(() => ({ b: 0, until: 0 }));
  const inputs = new Map<number, number>();
  const inflight: { at: number; s: Snapshot }[] = [];
  let lastArrival = 0;
  let serverTick = 0;
  // Décalage de phase entre les images du client et les pas du serveur.
  let frameT = 5;
  let prevR = -Infinity;
  let monotone = true;
  let maxErr = 0;
  let frames = 0;
  let maxJumpRatio = 0;
  let jumpsOver = 0;
  let vmax = 1;
  let maxDelayStep = 0;
  let prevDelay = NaN;
  const delays: number[] = [];
  let prev = new Map<string, { x: number; y: number }>();

  while (frameT < opts.durationMs) {
    // Serveur : tous les pas jusqu'à l'heure de l'image.
    while ((serverTick + 1) * TICK_MS <= frameT) {
      for (let i = 0; i < players.length; i++) {
        const h = held[i];
        if (serverTick >= h.until) {
          h.b = moves[Math.floor(rng.next() * moves.length)];
          h.until = serverTick + 10 + Math.floor(rng.next() * 50);
        }
        inputs.set(players[i].id, h.b);
      }
      stepWorld(w, inputs);
      w.events.length = 0;
      serverTick++;
      if (w.tick % SNAP_EVERY === 0) {
        // Instantané indépendant du monde (vrai encodage msgpack), livré dans l'ordre (comme TCP).
        const s = decodeSnapshot(unpack(pack(makeSnapshot(w, viewer, [], 0))));
        for (const p of s.others) vmax = Math.max(vmax, Math.hypot(p.vx, p.vy));
        for (const e of s.enemies) vmax = Math.max(vmax, Math.hypot(e.vx, e.vy));
        const at = Math.max(lastArrival, serverTick * TICK_MS + opts.lagMs + rng.next() * opts.jitterMs);
        lastArrival = at;
        inflight.push({ at, s });
      }
    }
    // Client : instantanés arrivés depuis la dernière image, horodatés à leur arrivée réelle
    // (horodatés à l'image, ils seraient retardés en plus d'une fraction d'image : biais constant).
    while (inflight.length && inflight[0].at <= frameT) {
      const m = inflight.shift()!;
      interp.push(m.s, opts.stampAtFrame ? frameT : m.at);
    }
    const r = interp.renderTick(frameT);
    const d = interp.clock.delayTicks();
    if (r < prevR) monotone = false;
    prevR = r;
    if (!Number.isNaN(prevDelay)) maxDelayStep = Math.max(maxDelayStep, Math.abs(d - prevDelay));
    prevDelay = d;
    delays.push(d);
    if (frameT > 2000) {
      const ideal = (frameT - opts.lagMs) / TICK_MS - d;
      maxErr = Math.max(maxErr, Math.abs(r - ideal));
    }
    const smp = interp.sample(r, viewer);
    const cur = new Map<string, { x: number; y: number }>();
    for (const e of [...smp.players.map((p) => ['p', p] as const), ...smp.enemies.map((e) => ['e', e] as const)]) {
      const key = `${e[0]}${e[1].id}`;
      cur.set(key, { x: e[1].x, y: e[1].y });
      const p = prev.get(key);
      if (p && frameT > 1000) {
        const jump = Math.hypot(e[1].x - p.x, e[1].y - p.y);
        if (jump > 120) continue; // téléportation (réapparition, etc.)
        const ratio = jump / (vmax * (FRAME_MS / 1000));
        maxJumpRatio = Math.max(maxJumpRatio, ratio);
        if (ratio > 1.5) jumpsOver++;
      }
    }
    prev = cur;
    frames++;
    frameT += FRAME_MS;
  }
  return { frames, monotone, maxErrAfter2s: maxErr, underruns: interp.underruns, maxJumpRatio, jumpsOver, delays, maxDelayStep };
}

{
  const res = simulate({ seed: 5, lagMs: 40, jitterMs: 30, durationMs: 10_000 });
  check('renderTick monotone sur 10 s', res.monotone);
  check('après 2 s, |r − (tick réel − délai)| < 1 tick', res.maxErrAfter2s < 1, `${res.maxErrAfter2s.toFixed(3)} tick`);
  const pct = (100 * res.underruns) / res.frames;
  check('sous-alimentation sur moins de 1 % des images', pct < 1, `${res.underruns}/${res.frames} = ${pct.toFixed(2)} %`);
  check(
    'aucun saut par image > 1,5 × vmax × dt (autres joueurs, ennemis)',
    res.jumpsOver === 0,
    `${res.jumpsOver} saut(s), max ${res.maxJumpRatio.toFixed(2)} × vmax·dt`,
  );
  const framed = simulate({ seed: 5, lagMs: 40, jitterMs: 30, durationMs: 10_000, stampAtFrame: true });
  check(
    'horodatage à l’image : biais borné à une image, sans sous-alimentation',
    framed.maxErrAfter2s < 1 + 1e-6 && framed.underruns === 0 && framed.monotone,
    `écart ${framed.maxErrAfter2s.toFixed(3)} tick, ${framed.underruns} sous-alimentation(s)`,
  );
  check('délai d’interpolation lissé (pas d’à-coup > 0,1 tick par image)', res.maxDelayStep <= 0.1, `${res.maxDelayStep.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 2. Le délai suit la gigue et reste borné.
// ---------------------------------------------------------------------------
{
  const tail = (xs: number[]): number => xs[xs.length - 1];
  const calm = simulate({ seed: 8, lagMs: 50, jitterMs: 0, durationMs: 6000 });
  const mid = simulate({ seed: 8, lagMs: 50, jitterMs: 60, durationMs: 6000 });
  const wild = simulate({ seed: 8, lagMs: 50, jitterMs: 400, durationMs: 6000 });
  const all = [...calm.delays, ...mid.delays, ...wild.delays];
  check(
    'delayTicks augmente avec la gigue',
    tail(calm.delays) < tail(mid.delays) && tail(mid.delays) < tail(wild.delays),
    `${tail(calm.delays).toFixed(2)} < ${tail(mid.delays).toFixed(2)} < ${tail(wild.delays).toFixed(2)}`,
  );
  check(
    `delayTicks borné à [${INTERP_MIN_TICKS}, ${INTERP_MAX_TICKS}]`,
    all.every((d) => d >= INTERP_MIN_TICKS && d <= INTERP_MAX_TICKS),
    `min ${Math.min(...all).toFixed(2)}, max ${Math.max(...all).toFixed(2)}`,
  );
  check('sans gigue : délai minimal', Math.abs(tail(calm.delays) - INTERP_MIN_TICKS) < 1e-6, tail(calm.delays).toFixed(2));
  check('renderTick monotone même sous forte gigue', wild.monotone);
}

// ---------------------------------------------------------------------------
// 3. Horloge : jamais de recul, recalage borné, saut franc au-delà de 30 ticks.
// ---------------------------------------------------------------------------
{
  const c = new ServerClock();
  check('horloge non synchronisée : tick 0', c.tickAt(100) === 0 && !c.synced);
  c.observe(600, 0);
  check('première mesure : tick estimé direct', Math.abs(c.tickAt(0) - 600) < 1e-9);
  // Le serveur est en réalité 3 ticks plus loin : rattrapage progressif à ≤ +5 %.
  let prevT = c.tickAt(0);
  let ok = true;
  for (let t = 50; t <= 3000; t += 50) {
    c.observe(603 + (t * NET_TICK) / 1000, t);
    for (let f = t - 50 + FRAME_MS; f <= t + 1e-9; f += FRAME_MS) {
      const v = c.tickAt(f);
      if (v < prevT) ok = false;
      prevT = v;
    }
  }
  const final = c.tickAt(3000);
  check('rattrapage d’un écart de 3 ticks en 3 s', Math.abs(final - (603 + 180)) < 0.05, `écart ${(final - 783).toFixed(3)}`);
  check('horloge monotone pendant le rattrapage', ok);
  // Vitesse : sur une image, au plus 1,05 tick par tick local.
  const c2 = new ServerClock();
  c2.observe(0, 0);
  c2.observe(10, 0); // 10 ticks d'avance
  let p = c2.tickAt(0);
  let maxSpeed = 0;
  for (let f = FRAME_MS; f < 500; f += FRAME_MS) {
    const v = c2.tickAt(f);
    maxSpeed = Math.max(maxSpeed, (v - p) / (FRAME_MS / TICK_MS));
    p = v;
  }
  check('ajustement de vitesse borné à +5 %', maxSpeed <= 1.05 + 1e-9 && maxSpeed > 1.01, maxSpeed.toFixed(4));
  // Écart énorme : saut franc vers l'avant.
  const c3 = new ServerClock();
  c3.observe(0, 0);
  c3.tickAt(0);
  c3.observe(200, 10);
  const j = c3.tickAt(20);
  check('écart > 30 ticks : saut franc', Math.abs(j - (200 + 0.6)) < 1e-6, j.toFixed(2));
  // Estimation en avance de beaucoup (serveur « en arrière ») : on ne recule pas.
  const c4 = new ServerClock();
  c4.observe(1000, 0);
  const a4 = c4.tickAt(100);
  for (let t = 150; t < 2500; t += 50) c4.observe(900 + (t * NET_TICK) / 1000, t);
  let mono4 = true;
  let p4 = a4;
  for (let t = 150; t < 2500; t += FRAME_MS) {
    const v = c4.tickAt(t);
    if (v < p4) mono4 = false;
    p4 = v;
  }
  check('estimation qui recule de 100 ticks : l’horloge ne recule jamais', mono4);
}

// ---------------------------------------------------------------------------
// 4. Instantanés fabriqués : apparition, disparition, extrapolation, téléportation, copies.
// ---------------------------------------------------------------------------
{
  const base = createWorld(1, { mode: 'coop' });
  const snap = (t: number, others: Player[], enemies: Enemy[]): Snapshot => ({
    t,
    ack: 0,
    stage: base.level.stage,
    stageInfo: base.stage,
    wave: base.wave,
    shrine: 0,
    self: null,
    others,
    enemies,
    projectiles: [],
    orbs: [],
    events: [],
  });
  const enemy = (id: number, x: number, vx = 0): Enemy => {
    const e = createEnemy(id, 'ashigaru', x, 500);
    e.vx = vx;
    e.state = 'chase';
    e.stateT = 10;
    return e;
  };
  const player = (id: number, x: number): Player => createPlayer(id, `p${id}`, x, 500);

  const a0 = enemy(1, 100, 60);
  a0.aimAng = 3;
  const b0 = enemy(2, 300);
  const t0 = enemy(4, 0); // téléporté
  const s0 = snap(100, [player(10, 50), player(11, 0)], [a0, b0, t0]);
  const a1 = enemy(1, 103, 60);
  a1.aimAng = -3;
  a1.stateT = 13;
  const c1 = enemy(3, 500);
  const t1 = enemy(4, 800);
  const s1 = snap(103, [player(10, 56), player(11, 0)], [a1, c1, t1]);
  const frozen = JSON.stringify([s0, s1]);

  const it = new Interpolator(() => 0);
  it.push(s0, 0);
  it.push(s1, 50);
  const mid = it.sample(101.5, 11);
  const ids = (es: { id: number }[]): string => es.map((e) => e.id).sort().join(',');
  const ma = mid.enemies.find((e) => e.id === 1)!;
  check('interpolation linéaire de x à mi-chemin', Math.abs(ma.x - 101.5) < 1e-9, `${ma.x}`);
  check('aimAng par le plus court chemin', Math.abs(Math.abs(ma.aimAng) - Math.PI) < 0.01, ma.aimAng.toFixed(3));
  check('stateT avancé de r − s0.t', Math.abs(ma.stateT - 11.5) < 1e-9, `${ma.stateT}`);
  check('joueur exclu absent', ids(mid.players) === '10', ids(mid.players));
  check('joueur interpolé', Math.abs(mid.players[0].x - 53) < 1e-9, `${mid.players[0].x}`);
  check('avant s1.t : la sortante est encore là, l’entrante pas encore', ids(mid.enemies) === '1,2,4', ids(mid.enemies));
  check('téléportation non interpolée (position de s0)', mid.enemies.find((e) => e.id === 4)!.x === 0);
  const at1 = it.sample(103, -1);
  check('à r = s1.t : apparition et disparition', ids(at1.enemies) === '1,3,4', ids(at1.enemies));
  check('à r = s1.t : la téléportée a basculé', at1.enemies.find((e) => e.id === 4)!.x === 800);
  check('pas de sous-alimentation tant que r ≤ dernier tick', it.underruns === 0, `${it.underruns}`);

  const ex = it.sample(104.5, -1).enemies.find((e) => e.id === 1)!;
  check('extrapolation par la vitesse', Math.abs(ex.x - (103 + 60 * 1.5 / 60)) < 1e-9, `${ex.x}`);
  const far = it.sample(140, -1).enemies.find((e) => e.id === 1)!;
  check('extrapolation bornée à 3 ticks puis figé', Math.abs(far.x - (103 + 60 * 3 / 60)) < 1e-9, `${far.x}`);
  check('sous-alimentation comptée', it.underruns === 2, `${it.underruns}`);

  // Copies : modifier les objets renvoyés ne touche pas le tampon.
  for (const e of mid.enemies) {
    e.x = -999;
    e.hp = -1;
  }
  for (const p of mid.players) {
    p.x = -999;
    p.hitList.push(42);
  }
  const ea = it.enemiesAt(101);
  for (const e of ea) e.state = 'dead';
  check('tampon intact après mutation des copies', JSON.stringify([s0, s1]) === frozen);
  const again = it.sample(101.5, 11);
  check('nouvel échantillon identique', again.enemies.find((e) => e.id === 1)!.x === 101.5 && again.players[0].hitList.length === 0);
  check('enemiesAt : ennemis interpolés au tick v', Math.abs(it.enemiesAt(101).find((e) => e.id === 1)!.x - 101) < 1e-9);
  check('enemiesAt : copies distinctes à chaque appel', it.enemiesAt(101)[0] !== it.enemiesAt(101)[0]);

  // Figé (freeze) : stateT non avancé.
  const f0 = enemy(5, 0);
  f0.freeze = 4;
  const f1 = enemy(5, 3);
  const it2 = new Interpolator(() => 0);
  it2.push(snap(200, [], [f0]), 0);
  it2.push(snap(203, [], [f1]), 50);
  check('hit-stop : stateT non avancé', it2.sample(201, -1).enemies[0].stateT === 10);
  // État différent : stateT de s0, non avancé.
  const g0 = enemy(6, 0);
  const g1 = enemy(6, 3);
  g1.state = 'windup';
  g1.stateT = 1;
  const it3 = new Interpolator(() => 0);
  it3.push(snap(300, [], [g0]), 0);
  it3.push(snap(303, [], [g1]), 50);
  const g = it3.sample(302, -1).enemies[0];
  check('changement d’état : champs discrets de s0', g.state === 'chase' && g.stateT === 10);

  // Doublon ignoré, reset.
  it.push(s1, 60);
  it.reset();
  check('reset : vide', it.sample(101, -1).enemies.length === 0 && it.renderTick(1000) === 0 && it.underruns === 0);
}

// ---------------------------------------------------------------------------
// 5. Mesure sur le banc réseau (75 ms par sens + 20 ms de gigue, 6 joueurs).
// ---------------------------------------------------------------------------
{
  const bench = new NetBench({ seed: 11, lagMs: 75, jitterMs: 20 });
  for (let i = 0; i < 6; i++) bench.addClient(`p${i}`);
  const rng = new Rng(99);
  const held = Array.from({ length: 6 }, () => ({ b: 0, until: 0 }));
  const MOVES = [0, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.RIGHT | BTN.DASH];
  const input = (i: number, frame: number): number => {
    const h = held[i];
    if (frame >= h.until) {
      h.b = MOVES[Math.floor(rng.next() * MOVES.length)];
      h.until = frame + 10 + Math.floor(rng.next() * 50);
    }
    return h.b;
  };
  bench.run(1500, input);
  const c = bench.clients[0];
  const prev = new Map<number, { x: number; y: number }>();
  let frames = 0;
  let over = 0;
  let pairs = 0;
  let maxRatio = 0;
  const VMAX = 720; // vitesse de ruée (px/s)
  bench.run(10_000, input, () => {
    frames++;
    for (const p of c.src.world.players) {
      if (p.id === c.pid) continue;
      const q = prev.get(p.id);
      if (q) {
        const jump = Math.hypot(p.x - q.x, p.y - q.y);
        if (jump <= 120) {
          pairs++;
          const ratio = jump / (VMAX * (bench.frameMs / 1000));
          maxRatio = Math.max(maxRatio, ratio);
          if (ratio > 1.5) over++;
        }
      }
      prev.set(p.id, { x: p.x, y: p.y });
    }
  });
  const under = c.src.interp.underruns;
  console.log(
    `· banc : ${over} saut(s) sur ${pairs} (${frames} images, 5 autres joueurs) avec un saut > 1,5 × v·dt (max ${maxRatio.toFixed(2)}) ; ` +
      `sous-alimentation ${under} ; délai ${c.src.interp.clock.delayTicks().toFixed(2)} ticks`,
  );
  check('banc : moins de 1 % d’images avec un saut d’un autre joueur', pairs > 0 && over < pairs * 0.01, `${over}/${pairs}`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests d’interpolation passent.');
