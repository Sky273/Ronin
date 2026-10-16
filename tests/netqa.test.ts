// Recette du mode en ligne sur le banc réseau virtuel : parties longues à plusieurs clients,
// latences de 0 à 150 ms par sens et gigues de 0 à 60 ms, avec morts, renaissances, arène,
// bilan d'étape, étape suivante et onglet en arrière-plan.
// Vérifie : aucune exception, recalages nets rares, nombre de joueurs affichés, tick de rendu
// monotone, événements ni perdus ni dupliqués (un `kill` montré une seule fois), rien de bloqué.
// Lancer : npm run test:netqa
import { PREDICTED_TYPES } from '../client/net/eventGate';
import { buildRoster, readyInfo } from '../client/ui/roster';
import { BTN } from '../shared/input';
import { damagePlayer, killEnemy } from '../shared/interactions';
import { Rng } from '../shared/math';
import { decodeSnapshot, type SnapshotWire } from '../shared/net/codec';
import { COOP_READY_AFTER } from '../shared/constants';
import { MAX_REWIND_TICKS, SNAP_EVERY } from '../shared/net/protocol';
import { CoopSession } from '../server/session';
import { findGround, spawnEnemy } from '../shared/enemy';
import type { GameEvent, World } from '../shared/types';
import { warpToArena } from '../shared/world';
import { type BenchClient, NetBench, percentile } from './net/harness';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Relevés d'un client pendant la partie. */
interface ClientLog {
  /** Événements reçus du serveur (forme décodée, avec le tick de l'instantané). */
  received: { t: number; key: string; ev: GameEvent }[];
  /** Événements rendus par advance (tous). */
  out: GameEvent[];
  reconciles: number;
  bigCorrections: number; // corrections > 32 px hors recalage net
  renderBackwards: number;
  lastRender: number;
  playersMismatch: number;
  readyFrames: number;
}

const mineServerSide = (c: BenchClient, ev: GameEvent): boolean => (ev as { pid?: number }).pid === c.pid && PREDICTED_TYPES.has(ev.type);
const key = (ev: GameEvent): string => JSON.stringify(ev);

function instrument(c: BenchClient): ClientLog {
  const log: ClientLog = { received: [], out: [], reconciles: 0, bigCorrections: 0, renderBackwards: 0, lastRender: -Infinity, playersMismatch: 0, readyFrames: 0 };
  const src = c.src;
  const origReceive = src.receive.bind(src);
  // Copie décodée de chaque instantané reçu (avant toute mutation par le client).
  src.receive = (wire: SnapshotWire) => {
    const snap = decodeSnapshot(wire);
    for (const ev of snap.events) log.received.push({ t: snap.t, key: key(ev), ev });
    origReceive(wire);
  };
  return log;
}

/** Comme NetBench.run, mais récupère les événements de chaque client et permet de suspendre un client (onglet en arrière-plan). */
function runQA(
  bench: NetBench,
  state: { since: number },
  logs: ClientLog[],
  ms: number,
  input: (i: number, frame: number) => number,
  opts: { paused?: (i: number, frame: number) => boolean; onFrame?: (frame: number) => void } = {},
): void {
  const end = bench.clock.t + ms;
  const owed = bench.clients.map(() => 0);
  while (bench.clock.t < end) {
    bench.clock.advance(bench.frameMs);
    for (const c of bench.clients) c.transport.up.flush();
    state.since += bench.session.update(bench.frameMs);
    if (state.since >= SNAP_EVERY) {
      state.since %= SNAP_EVERY;
      for (const c of bench.clients) c.transport.deliverSnapshot(bench.session.snapshotFor(c.pid));
      bench.session.flushEvents();
    }
    for (const c of bench.clients) c.transport.down.flush();
    const frame = bench.metrics.frames++;
    bench.clients.forEach((c, i) => {
      if (opts.paused?.(i, frame)) {
        owed[i] += bench.frameMs; // la scène ne tourne plus : le temps s'accumule
        return;
      }
      const dt = (bench.frameMs + owed[i]) / 1000;
      owed[i] = 0;
      const log = logs[i];
      const pred = c.src.predictor;
      const s0 = pred.snaps;
      for (const ev of c.src.advance(dt, () => (c.lastButtons = input(i, frame)), () => undefined)) log.out.push(ev);
      if (pred.lastCorrectionPx > 32 && pred.snaps === s0) log.bigCorrections++;
      const r = c.src.interp.renderTick(bench.clock.t);
      if (r < log.lastRender) log.renderBackwards++;
      log.lastRender = r;
      if (c.src.ready) {
        log.readyFrames++;
        if (c.src.world.players.length !== bench.session.world.players.length) log.playersMismatch++;
      }
    });
    opts.onFrame?.(frame);
  }
}

/** Entrées pseudo-aléatoires couvrant tous les états du joueur. */
function scripted(seed: number): (i: number, frame: number) => number {
  const rng = new Rng(seed);
  const MOVES = [
    BTN.RIGHT, BTN.RIGHT, BTN.RIGHT | BTN.JUMP, BTN.JUMP, 0, BTN.LEFT, BTN.LEFT | BTN.JUMP, // sauts, double saut, saut mural
    BTN.ATTACK, BTN.RIGHT | BTN.ATTACK, BTN.UP | BTN.ATTACK, BTN.DOWN | BTN.ATTACK | BTN.JUMP, // combos, plongeon
    BTN.DASH | BTN.RIGHT, BTN.DASH | BTN.LEFT, BTN.DOWN | BTN.RIGHT, BTN.DOWN, // dash, glissade, accroupi
    BTN.PARRY, BTN.IAI, BTN.IAI, BTN.PICK1, BTN.PICK2, BTN.PICK3,
  ];
  const held: { b: number; until: number }[] = [];
  return (i, frame) => {
    const h = (held[i] ??= { b: 0, until: 0 });
    if (frame >= h.until) {
      h.b = MOVES[Math.floor(rng.next() * MOVES.length)];
      // L'iai doit être tenu longtemps pour se charger.
      h.until = frame + (h.b === BTN.IAI ? 50 + Math.floor(rng.next() * 40) : 3 + Math.floor(rng.next() * 30));
    }
    return h.b;
  };
}

const stateOf = (w: World): string => w.stage.state;

/** Une partie complète sur le banc ; renvoie les relevés et les compteurs de recalage. */
function game(lagMs: number, jitterMs: number, seed: number, background: boolean): {
  logs: ClientLog[];
  bench: NetBench;
  err: string;
  forced: Record<string, number>;
  snaps: number[];
} {
  const bench = new NetBench({ seed, lagMs, jitterMs });
  const n = 3;
  for (let i = 0; i < n; i++) bench.addClient(`p${i}`);
  const logs = bench.clients.map(instrument);
  const state = { since: 0 };
  const input = scripted(seed * 31 + lagMs + jitterMs);
  const w = bench.session.world;
  const forced: Record<string, number> = { deaths: 0, arena: 0, cleared: 0, stage: 0 };
  const stage0 = w.level.stage;
  let err = '';
  try {
    runQA(bench, state, logs, 2000, input);
    let phase = 0;
    const frame0 = bench.metrics.frames;
    runQA(bench, state, logs, 40_000, input, {
      // Client 2 : onglet en arrière-plan 6 s, en plein milieu de la partie.
      paused: (i, frame) => background && i === 2 && frame - frame0 > 900 && frame - frame0 < 900 + 360,
      onFrame: (frame) => {
        const f = frame - frame0;
        const p0 = w.players.find((p) => p.id === bench.clients[0].pid);
        // Mort forcée du joueur 0 toutes les 7 s (renaissance 2,5 s plus tard).
        if (f % 420 === 200 && p0 && p0.state !== 'dead') {
          p0.iframes = 0;
          p0.state = 'normal';
          damagePlayer(w, p0, 1e6, p0.x + 10);
          forced.deaths++;
        }
        // Arène, gardien vaincu, porte franchie : bilan, puis étape suivante (automatique en coop).
        if (phase === 0 && f > 1500 && stateOf(w) === 'playing') {
          warpToArena(w, bench.clients[1].pid);
          phase = 1;
        } else if (phase === 1 && stateOf(w) === 'arena') {
          forced.arena++;
          phase = 2;
        } else if (phase === 2 && f % 60 === 0) {
          const g = w.enemies.find((e) => e.id === w.stage.guardianId);
          if (g && g.state !== 'intro') killEnemy(w, g, w.players[0], 0, false);
          if (stateOf(w) === 'gateOpen') {
            const p1 = w.players.find((p) => p.id === bench.clients[1].pid);
            if (p1 && p1.state !== 'dead') {
              p1.x = w.level.gate.x - 4;
              p1.y = w.level.gate.y;
            }
          }
          if (stateOf(w) === 'cleared') {
            forced.cleared++;
            phase = 3;
          }
        } else if (phase === 3 && w.level.stage !== stage0 && stateOf(w) === 'playing') {
          forced.stage++;
          phase = 0; // nouvelle boucle arène → bilan → étape, tant que la partie dure
        }
      },
    });
    // Fin : plus d'entrées, on laisse les files se vider.
    runQA(bench, state, logs, 3000, () => 0);
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 400);
  }
  return { logs, bench, err, forced, snaps: bench.clients.map((c) => c.src.predictor.snaps) };
}

/** Compare reçus et rendus : chaque événement reçu (hors événements prédits du joueur local), au tick atteint par le rendu, sort exactement une fois. */
function integrity(c: BenchClient, log: ClientLog): { lost: number; extra: number; killDup: number; pendingStale: number; sample: string } {
  const counts = new Map<string, number>();
  const r = log.lastRender;
  for (const x of log.received) {
    if (mineServerSide(c, x.ev)) continue;
    // Un événement différé dont le tick n'est pas encore atteint peut légitimement attendre.
    if (x.t > r) continue;
    counts.set(x.key, (counts.get(x.key) ?? 0) + 1);
  }
  const allowed = new Map<string, number>();
  for (const x of log.received) if (!mineServerSide(c, x.ev)) allowed.set(x.key, (allowed.get(x.key) ?? 0) + 1);
  let extra = 0;
  let sample = '';
  const seen = new Map<string, number>();
  for (const ev of log.out) {
    if (mineServerSide(c, ev)) continue; // événements prédits (et coups confirmés non prédits)
    const k = key(ev);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    const a = allowed.get(k) ?? 0;
    if (n > a) {
      extra += n - a;
      sample ||= `en trop : ${k.slice(0, 120)}`;
    }
  }
  let lost = 0;
  for (const [k, n] of counts) {
    const s = seen.get(k) ?? 0;
    if (s < n) {
      lost += n - s;
      sample ||= `perdu : ${k.slice(0, 120)}`;
    }
  }
  const kills = new Map<number, number>();
  for (const ev of log.out) if (ev.type === 'kill') kills.set(ev.id, (kills.get(ev.id) ?? 0) + 1);
  let killDup = 0;
  for (const n of kills.values()) if (n > 1) killDup++;
  return { lost, extra, killDup, pendingStale: c.src.gate.pending, sample };
}

// ─── 1. Matrice latence × gigue ─────────────────────────────────────────────
const LATS = [0, 30, 75, 150];
const JITS = [0, 20, 60];
for (const lag of LATS) {
  for (const jit of JITS) {
    const g = game(lag, jit, 3 + lag + jit, lag === 75 && jit === 20);
    const tag = `${lag} ms + gigue ${jit} ms`;
    check(`${tag} : aucune exception`, !g.err, g.err);
    if (g.err) continue;
    check(
      `${tag} : scénario complet (morts forcées, arène, bilan, étape suivante)`,
      g.forced.deaths >= 4 && g.forced.arena >= 1 && g.forced.cleared >= 1 && g.forced.stage >= 1,
      JSON.stringify(g.forced),
    );
    const mism = g.logs.map((l) => `${l.playersMismatch}/${l.readyFrames}`).join(' ');
    check(`${tag} : nombre de joueurs affichés = joueurs de la salle`, g.logs.every((l) => l.readyFrames > 0 && l.playersMismatch === 0), mism);
    check(`${tag} : tick de rendu monotone`, g.logs.every((l) => l.renderBackwards === 0), g.logs.map((l) => l.renderBackwards).join(' '));
    // Recalages nets attendus : mort et renaissance (2 par mort), arène, étape ; le reste doit être rare.
    const expected = (i: number): number => (i === 0 ? 2 * g.forced.deaths : 0) + 2 * (g.forced.arena + g.forced.stage) + 10;
    check(
      `${tag} : recalages nets rares`,
      g.snaps.every((s, i) => s <= expected(i) + 2 * g.forced.deaths),
      `recalages ${g.snaps.join('/')}, corrections > 32 px ${g.logs.map((l) => l.bigCorrections).join('/')}, morts forcées ${g.forced.deaths}`,
    );
    const res = g.bench.clients.map((c, i) => integrity(c, g.logs[i]));
    check(
      `${tag} : aucun événement perdu ni dupliqué, chaque kill montré une fois`,
      res.every((r) => r.lost === 0 && r.extra === 0 && r.killDup === 0),
      res.map((r) => `perdus ${r.lost}, en trop ${r.extra}, kills doublés ${r.killDup}`).join(' | ') + (res.find((r) => r.sample)?.sample ? ` — ${res.find((r) => r.sample)!.sample}` : ''),
    );
    check(`${tag} : aucun événement bloqué en attente en fin de partie`, res.every((r) => r.pendingStale <= 5), res.map((r) => r.pendingStale).join('/'));
  }
}

// ─── 2. Onglet en arrière-plan prolongé : instantanés en rafale (file plafonnée à 20) ──
{
  const bench = new NetBench({ seed: 77, lagMs: 75, jitterMs: 20 });
  for (let i = 0; i < 2; i++) bench.addClient(`p${i}`);
  const logs = bench.clients.map(instrument);
  const state = { since: 0 };
  const input = scripted(5);
  let err = '';
  let start = 0;
  try {
    runQA(bench, state, logs, 2000, input);
    start = bench.metrics.frames;
    // 30 s sans image pour le client 1, avec beaucoup de combats (renforts au contact).
    runQA(bench, state, logs, 30_000, input, { paused: (i) => i === 1 });
    runQA(bench, state, logs, 3000, input);
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 400);
  }
  void start;
  const c = bench.clients[1];
  const l = logs[1];
  check('arrière-plan 30 s : aucune exception', !err, err);
  const lagTicks = bench.session.world.tick - l.lastRender;
  check('… le rendu rattrape le serveur après le retour', lagTicks > 0 && lagTicks < 40, `${lagTicks.toFixed(1)} ticks de recul`);
  check('… tick de rendu monotone', l.renderBackwards === 0);
  const r = integrity(c, l);
  check('… aucun kill montré deux fois', r.killDup === 0, `${r.killDup}`);
  check('… aucun événement en double', r.extra === 0, r.sample);
  check('… file d’attente vidée', r.pendingStale <= 5, `${r.pendingStale}`);
  console.log(`· arrière-plan 30 s : ${r.lost} événement(s) des instantanés abandonnés non montrés (plafonds : 20 instantanés, 200 événements reportés)`);
}

// ─── 3. Compensation de latence à 150 ms par sens (plafond MAX_REWIND_TICKS) ──
{
  // 3a. Règle du retard côté session : L = clamp(S − v, 0, MAX), hausse immédiate, baisse d'un tick par pas.
  const s = new CoopSession(3);
  const { pid } = s.join('a');
  const w = s.world;
  let seq = 0;
  for (let i = 0; i < 60; i++) {
    s.pushInput(pid, { s: ++seq, b: 0 });
    s.update(1000 / 60);
  }
  const seen: number[] = [];
  const asked: number[] = [];
  for (let i = 0; i < 400; i++) {
    // Retards demandés : 0 / plafond + 10 en alternance brutale, puis dents de scie, puis 0.
    const want = i < 120 ? (((i / 9) | 0) % 2 ? MAX_REWIND_TICKS + 10 : 0) : i < 300 ? 40 - (i % 41) : 0;
    asked.push(want);
    s.pushInput(pid, { s: ++seq, b: 0, v: w.tick - want });
    s.update(1000 / 60);
    seen.push(s.lagFor(pid));
  }
  let bad = '';
  for (let i = 0; i < seen.length && !bad; i++) {
    const raw = Math.min(MAX_REWIND_TICKS, asked[i]);
    const prev = i ? seen[i - 1] : 0; // 60 pas sans tick de vue : L = 0 au départ
    const want = Math.max(raw, prev - 1);
    if (seen[i] !== want || seen[i] > MAX_REWIND_TICKS || seen[i] < 0) bad = `pas ${i} : L = ${seen[i]}, attendu ${want} (demandé ${asked[i]})`;
  }
  check(`session : L borné à ${MAX_REWIND_TICKS}, hausse immédiate, baisse d’un tick par pas`, !bad && Math.max(...seen) === MAX_REWIND_TICKS && seen[seen.length - 1] === 0, bad);
  check('… retard posé dans la compensation du monde identique', (w.net?.lagOf(pid) ?? -1) === s.lagFor(pid));
}
{
  // 3b. Coût CPU : 12 joueurs en combat, L = 0 contre L = plafond (mesure, horloge réelle).
  const bench = (L: number): { ms: number; strikes: number; hits: number } => {
    const s = new CoopSession(9);
    const pids: number[] = [];
    for (let i = 0; i < 12; i++) pids.push(s.join('p' + i).pid);
    const w = s.world;
    const input = scripted(17);
    let seq = 0;
    let strikes = 0;
    let hits = 0;
    const t0 = performance.now();
    for (let t = 0; t < 3000; t++) {
      if (t % 60 === 0) for (const p of w.players) if (p.state !== 'dead') p.hp = p.maxHp;
      if (t % 120 === 30) {
        w.players.forEach((p, i) => {
          if (p.state === 'dead' || w.enemies.length > 40) return;
          const x = p.x + (i % 2 ? -1 : 1) * 90;
          const gy = findGround(w.level, x, p.y, 2);
          if (gy === null || Math.abs(gy - p.y) > 40) return;
          const e = spawnEnemy(w, (['ashigaru', 'oni', 'ninja', 'archer'] as const)[(t + i) % 4], x, gy, false);
          e.state = 'chase';
          e.cd = 0;
        });
      }
      seq++;
      pids.forEach((pid, i) => s.pushInput(pid, { s: seq, b: input(i, t), v: Math.max(0, w.tick - L) }));
      s.update(1000 / 60);
      strikes = Math.max(strikes, w.net!.strikes.length);
      hits += s.pendingEvents.filter((ev) => ev.type === 'hit' || ev.type === 'playerHit').length;
      s.flushEvents();
    }
    return { ms: performance.now() - t0, strikes, hits };
  };
  bench(0); // échauffement du JIT
  const r0: number[] = [];
  const r30: number[] = [];
  let last0 = { ms: 0, strikes: 0, hits: 0 };
  let last30 = last0;
  for (let k = 0; k < 3; k++) {
    last0 = bench(0);
    last30 = bench(MAX_REWIND_TICKS);
    r0.push(last0.ms);
    r30.push(last30.ms);
  }
  const m0 = Math.min(...r0) / 3000;
  const m30 = Math.min(...r30) / 3000;
  check('micro-banc : combats effectifs dans les deux cas', last0.hits > 100 && last30.hits > 100, `${last0.hits} / ${last30.hits} coups`);
  console.log(
    `· CPU CoopSession 12 joueurs : L = 0 → ${(m0 * 1000).toFixed(0)} µs/pas, L = ${MAX_REWIND_TICKS} → ${(m30 * 1000).toFixed(0)} µs/pas (× ${(m30 / m0).toFixed(2)}), ` +
      `frappes en attente max ${last30.strikes} (budget d’un pas : ${(1000 / 60).toFixed(1)} ms)`,
  );
  check('micro-banc : un pas à L = plafond reste très en dessous du budget (< 4 ms)', m30 < 4, `${m30.toFixed(3)} ms/pas`);
}
{
  // 3c. Banc réseau 150 ms par sens : retard mesuré non saturé, corrections faibles en combat.
  const isHit = (ev: GameEvent): boolean => ev.type === 'hit' || ev.type === 'block' || ev.type === 'guardBreak';
  const combatInput = (frame: number): number => {
    const k = frame % 240;
    if (k < 120) return (k % 30 < 10 ? BTN.RIGHT : 0) | (k % 10 === 0 ? BTN.ATTACK : 0);
    if (k < 140) return BTN.JUMP | (k === 135 ? BTN.DOWN | BTN.ATTACK : 0);
    if (k < 200) return k % 12 === 0 ? BTN.ATTACK : 0;
    return k % 8 === 0 ? BTN.ATTACK : BTN.LEFT;
  };
  const FOES = ['ashigaru', 'oni', 'ashigaru', 'ninja', 'archer'] as const;
  // Corrections de prédiction : mesurées sur plusieurs graines (une seule graine est trop
  // dépendante du hasard des rencontres), comparées au banc de référence 75 ms (section 3a de
  // tests/predict.test.ts). Les rares grandes corrections (projectiles renvoyés, coups en limite
  // de portée) existent déjà à 75 ms : le maximum est relevé, pas exigé.
  const SEEDS = [11, 12, 13, 14];
  const one = (seed: number, lagMs: number, jit: number): { px: number[]; lags: number[]; hits: number; snaps: number; rtt: number } => {
    const bench = new NetBench({ seed, lagMs, jitterMs: jit });
    const c = bench.addClient('a');
    const w = bench.session.world;
    let spawned = 0;
    const feed = (): void => {
      const p = bench.serverPlayer(c.pid);
      if (!p) return;
      p.iframes = 600;
      if (w.enemies.filter((e) => Math.abs(e.x - p.x) < 260).length < 2) {
        const x = p.x + p.facing * 70;
        const gy = findGround(w.level, x, p.y);
        if (gy !== null) spawnEnemy(w, FOES[spawned++ % FOES.length], x, gy, true);
      }
    };
    bench.run(2000, () => 0, feed);
    const pred = c.src.predictor;
    const px: number[] = [];
    const origRec = pred.reconcile.bind(pred);
    pred.reconcile = (self, ack, ctx, enemiesAt) => {
      const s0 = pred.snaps;
      origRec(self, ack, ctx, enemiesAt);
      if (pred.snaps === s0) px.push(pred.lastCorrectionPx);
    };
    let hits = 0;
    const origStep = pred.step.bind(pred);
    pred.step = (s, b, v, enemies, ctx) => {
      const evs = origStep(s, b, v, enemies, ctx);
      hits += evs.filter(isHit).length;
      return evs;
    };
    const lags: number[] = [];
    const snaps0 = pred.snaps;
    bench.run(30_000, (_i, frame) => combatInput(frame), () => {
      feed();
      lags.push(bench.session.lagFor(c.pid));
    });
    return { px, lags, hits, snaps: pred.snaps - snaps0, rtt: c.transport.rtt };
  };
  const pooled = (lagMs: number, jit: number) => {
    const px: number[] = [];
    const lags: number[] = [];
    let hits = 0;
    let snaps = 0;
    let rtt = 0;
    for (const seed of SEEDS) {
      const r = one(seed, lagMs, jit);
      for (const x of r.px) px.push(x);
      for (const l of r.lags) lags.push(l);
      hits += r.hits;
      snaps += r.snaps;
      rtt = Math.max(rtt, r.rtt);
    }
    const nz = px.filter((x) => x > 0).length / px.length;
    return { px, lags, hits, snaps, rtt, nz, p99: percentile(px, 99), max: Math.max(...px), big: px.filter((x) => x > 16).length };
  };
  const fmt = (r: ReturnType<typeof pooled>): string =>
    `p99 ${r.p99.toFixed(2)} px, max ${r.max.toFixed(2)} px, ${(100 * r.nz).toFixed(1)} % non nulles, ${r.big} > 16 px, ${r.snaps} recalage(s), ${r.hits} coups prédits`;
  for (const jit of [0, 40]) {
    const ref = pooled(75, jit);
    const r = pooled(150, jit);
    const sat = r.lags.filter((l) => l >= MAX_REWIND_TICKS).length;
    const tag = `150 ms + gigue ${jit} ms`;
    check(
      `${tag} : retard L mesuré par le serveur non saturé (< ${MAX_REWIND_TICKS})`,
      sat === 0 && Math.max(...r.lags) < MAX_REWIND_TICKS,
      `L p50 ${percentile(r.lags, 50)}, p95 ${percentile(r.lags, 95)}, max ${Math.max(...r.lags)}, ${sat}/${r.lags.length} images saturées, rtt ${r.rtt.toFixed(0)} ms`,
    );
    console.log(`· 75 ms + gigue ${jit} ms (référence, ${SEEDS.length} graines) : ${fmt(ref)}`);
    check(
      `${tag} : combat, corrections faibles (${SEEDS.length} graines : p99 ≤ 6 px ou ≤ réf. 75 ms + 4 px, < 5 % non nulles, aucun recalage)`,
      r.hits > 80 && (r.p99 <= 6 || r.p99 <= ref.p99 + 4) && r.nz < 0.05 && r.snaps === 0,
      fmt(r),
    );
  }
}
{
  // 3d. Parade vue à l'heure à l'écran, 150 ms par sens : le client pare quand le lancier AFFICHÉ
  // arrive à 3 ticks de la fin de sa préparation. Avec compensation : parade réussie ;
  // témoin sans compensation (w.net retiré) : la même parade arrive trop tard.
  const parryBench = (jit: number, comp: boolean): { attacks: number; parries: number; hurt: number; lag: number } => {
    const bench = new NetBench({ seed: 21, lagMs: 150, jitterMs: jit });
    const c = bench.addClient('a');
    const w = bench.session.world;
    w.enemies = [];
    w.spawnTimer = 1e9;
    w.wave.t = -1e9;
    bench.run(2000, () => 0, () => {
      w.enemies = [];
      w.projectiles = [];
    });
    if (!comp) w.net = undefined;
    const p = bench.serverPlayer(c.pid)!;
    p.facing = 1;
    const x0 = p.x;
    const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
    e.hp = e.maxHp = 1e7;
    const ex = e.x;
    let attacks = 0;
    let prev = '';
    let parries = 0;
    let hurt = 0;
    let shownT = -1;
    let press = false;
    // Le banc vide les événements après chaque instantané : on les relève avant.
    const session = bench.session;
    const flush = session.flushEvents.bind(session);
    session.flushEvents = () => {
      for (const ev of session.pendingEvents) {
        if (ev.type === 'parry' && ev.pid === c.pid) parries++;
        if (ev.type === 'playerHit' && ev.pid === c.pid) hurt++;
      }
      flush();
    };
    bench.run(
      40_000,
      () => {
        const b = press ? BTN.PARRY : 0;
        press = false;
        return b;
      },
      () => {
        // Côté serveur : joueur et lancier maintenus en place, PV rechargés.
        p.hp = p.maxHp;
        if (p.state !== 'parry') {
          p.x = x0;
          p.vx = 0;
        }
        if (e.state === 'chase' || e.state === 'patrol' || e.state === 'recover') {
          e.x = ex;
          e.vx = 0;
          e.facing = -1;
          if (e.state === 'patrol') e.state = 'chase';
        }
        if (e.state === 'attack' && prev !== 'attack') attacks++;
        prev = e.state;
        session.flushEvents();
        // Côté client : la parade est lancée d'après le lancier affiché à l'écran.
        const shown = c.src.world.enemies.find((q) => q.id === e.id);
        const t = shown && shown.state === 'windup' ? shown.stateT : -1;
        if (t >= 23 && shownT < 23) press = true;
        shownT = t;
      },
    );
    return { attacks, parries, hurt, lag: bench.session.lagFor(c.pid) };
  };
  for (const jit of [0, 40]) {
    const r = parryBench(jit, true);
    check(
      `150 ms + gigue ${jit} ms : parade vue à l’heure à l’écran → réussie`,
      r.attacks > 10 && r.parries >= r.attacks - 1 && r.hurt <= 1,
      `${r.attacks} attaques, ${r.parries} parades, ${r.hurt} touche(s), L = ${r.lag}`,
    );
  }
  const ctl = parryBench(0, false);
  check('témoin sans compensation : la même parade échoue (le test discrimine)', ctl.attacks > 10 && ctl.hurt > ctl.attacks / 2, `${ctl.attacks} attaques, ${ctl.parries} parades, ${ctl.hurt} touche(s)`);
}

// ─── 4. M3 : bilan coop en ligne (3 clients, 75 ms + gigue 20 ms) ───────────
{
  const bench = new NetBench({ seed: 33, lagMs: 75, jitterMs: 20 });
  const cs = [bench.addClient('Ayame'), bench.addClient('Benkei'), bench.addClient('Chiyo')];
  const w = bench.session.world;
  const calm = (): void => {
    w.spawnTimer = 1e6;
    for (const p of w.players) p.iframes = 1e6;
  };
  bench.run(1000, () => 0, calm);
  // Le premier joueur ferme l'arène et le gardien tombe ; il franchit la porte : bilan.
  const a = bench.serverPlayer(cs[0].pid)!;
  warpToArena(w, a.id);
  bench.run(600, (i) => (i === 0 ? BTN.RIGHT : 0), calm);
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (g) killEnemy(w, g, a, 0, false);
  bench.run(200, () => 0, calm);
  a.x = w.level.gate.x - 40;
  a.y = w.level.gate.y;
  a.vx = a.vy = 0;
  let clearedAt = -1;
  bench.run(1500, (i) => (i === 0 ? BTN.RIGHT : 0), () => {
    calm();
    if (clearedAt < 0 && w.stage.state === 'cleared') clearedAt = bench.metrics.frames;
  });
  check('bilan coop atteint en ligne', w.stage.state === 'cleared', w.stage.state);
  // Attendre que les votes comptent, puis voir le récapitulatif chez chaque client.
  bench.run(((COOP_READY_AFTER + 20) * 1000) / 60, () => 0, calm);
  const rows = cs.map((c) => buildRoster(c.src.world, c.pid));
  check('chaque client voit le récapitulatif des 3 joueurs (statistiques transmises)', rows.every((r) => r.length === 3 && r.filter((x) => x.me).length === 1) && cs.every((c) => !!c.src.world.stage.byPlayer), rows.map((r) => r.length).join());
  check('readyInfo : 2 votes nécessaires sur 3', readyInfo(cs[0].src.world).needed === 2);
  const level0 = w.level.stage;
  // Un seul vote (A) : on reste au bilan.
  bench.run(300, (i, f) => (i === 0 && f % 20 < 3 ? BTN.JUMP : 0), calm);
  // Laisser le temps au vote d'arriver chez les autres clients (latence + recul d'affichage).
  bench.run(400, () => 0, calm);
  const oneVote = w.stage.state === 'cleared';
  const shownReady = readyInfo(cs[1].src.world).ready;
  // Deuxième vote (B) : on repart.
  bench.run(400, (i, f) => (i === 1 && f % 20 < 3 ? BTN.JUMP : 0), calm);
  bench.run(600, () => 0, calm);
  check('un seul vote sur 3 : le bilan reste affiché ; le vote est vu par les autres clients', oneVote && shownReady === 1, `prêts vus par B : ${shownReady}`);
  check('deux votes sur 3 : étape suivante', w.level.stage === level0 + 1 && w.stage.state === 'playing', `${w.stage.state} étape ${w.level.stage}`);
  check('hors bilan : statistiques par joueur plus transmises', cs.every((c) => c.src.world.stage.byPlayer === undefined));
}

// ─── 5. M3 : partie complète à 4 clients (75 ms + gigue 20 ms) ──────────────
// A ferme l'arène, D (resté dehors) la rejoint en traversant le kekkai puis pousse vers la sortie ;
// gardien vaincu, bilan voté (3 votes sur 4), étape suivante. Tailles d'instantané hors bilan / bilan.
{
  const bench = new NetBench({ seed: 45, lagMs: 75, jitterMs: 20 });
  const cs = ['Ayame', 'Benkei', 'Chiyo', 'Daisuke'].map((n) => bench.addClient(n));
  const logs = bench.clients.map(instrument);
  const state = { since: 0 };
  const w = bench.session.world;
  const limit = (w.level.arena.col + 1) * 32;
  const sp = (i: number) => bench.serverPlayer(cs[i].pid)!;
  /** Corrections > 32 px sans recalage net, relevées à chaque réconciliation (client:état:px). */
  const big: string[] = [];
  const corr = cs.map((c) => {
    const log = { px: [] as number[], snapped: [] as boolean[] };
    const pred = c.src.predictor;
    const orig = pred.reconcile.bind(pred);
    pred.reconcile = (self, ack, ctx, enemiesAt) => {
      const s0 = pred.snaps;
      orig(self, ack, ctx, enemiesAt);
      log.px.push(pred.lastCorrectionPx);
      log.snapped.push(pred.snaps !== s0);
      if (pred.snaps === s0 && pred.lastCorrectionPx > 32) big.push(`${c.src.world.players.find((p) => p.id === c.pid)?.name}:${w.stage.state}:${pred.lastCorrectionPx.toFixed(0)}px`);
    };
    return log;
  });
  const clear = (i: number) => (corr[i].px.length = corr[i].snapped.length = 0);
  const freezeGuardian = (on: boolean) => {
    w.spawnTimer = 1e6;
    for (const p of w.players) p.iframes = 1e6;
    w.enemies = w.enemies.filter((e) => e.type === 'boss' || (w.stage.state === 'arena' && e.x > limit));
    for (const e of w.enemies) e.freeze = on ? 1e9 : 0;
  };
  const bytes: { playing: number[]; arena: number[]; cleared: number[] } = { playing: [], arena: [], cleared: [] };
  let err = '';
  let dEntered = false;
  let dShownMin = Infinity;
  let bShownMax = -Infinity;
  let pDuring = '';
  let rosterOk = false;
  let rosterInfo = '';
  let needed = -1;
  const level0 = w.level.stage;
  try {
    runQA(bench, state, logs, 1500, () => 0, { onFrame: () => freezeGuardian(true) });
    // B, C, D attendent à 6 tuiles de la barrière ; A ferme l'arène.
    for (const i of [1, 2, 3]) {
      const p = sp(i);
      p.x = limit - (6 + i) * 32;
      p.y = findGround(w.level, p.x, w.level.arena.guardianY, 12) ?? p.y;
      p.vx = p.vy = 0;
    }
    warpToArena(w, cs[0].pid);
    runQA(bench, state, logs, 1500, (i) => (i === 0 ? BTN.RIGHT : 0), { onFrame: () => freezeGuardian(true) });
    pDuring = stateOf(w);
    /** runQA en relevant la taille de chaque instantané, classée selon l'état de l'étape au serveur. */
    const sizes = (ms: number, input: (i: number, f: number) => number, onFrame: () => void) => {
      const origDeliver = cs.map((c) => c.transport.deliverSnapshot.bind(c.transport));
      cs.forEach((c, i) => (c.transport.deliverSnapshot = (m) => {
        const b = origDeliver[i](m);
        bytes[stateOf(w) as keyof typeof bytes]?.push(b);
        return b;
      }));
      runQA(bench, state, logs, ms, input, { onFrame });
      cs.forEach((c, i) => (c.transport.deliverSnapshot = origDeliver[i]));
    };
    // D court vers l'arène et y entre.
    clear(3);
    sizes(3000, (i) => (i === 3 ? BTN.RIGHT : 0), () => {
      freezeGuardian(true);
      if (sp(3).x - sp(3).w / 2 > limit) dEntered = true;
    });
    const enterCorr = corr[3].px.filter((_, k) => !corr[3].snapped[k]);
    const enterSnaps = corr[3].snapped.filter(Boolean).length;
    check('4 clients : arène fermée par A, D dehors la rejoint en traversant le kekkai', pDuring === 'arena' && dEntered && stateOf(w) === 'arena', `${pDuring} x(D)-limite=${(sp(3).x - limit).toFixed(0)}`);
    check('traversée du kekkai : aucune correction notable chez D (max < 4 px, aucun recalage net)', Math.max(0, ...enterCorr) < 4 && enterSnaps === 0, `max ${Math.max(0, ...enterCorr).toFixed(2)} px, ${enterSnaps} recalage(s)`);
    // D pousse vers la sortie (course, dash, saut, iai) : jamais affiché dehors.
    clear(3);
    const outMoves = [BTN.LEFT, BTN.LEFT | BTN.DASH, BTN.LEFT | BTN.JUMP, BTN.IAI | BTN.LEFT, BTN.LEFT | BTN.DOWN];
    sizes(4000, (i, f) => (i === 3 ? outMoves[((f / 40) | 0) % outMoves.length] : 0), () => {
      freezeGuardian(true);
      const p = bench.shownPlayer(cs[3]);
      if (p) dShownMin = Math.min(dShownMin, p.x - p.w / 2);
    });
    const outCorr = corr[3].px.filter((_, k) => !corr[3].snapped[k]);
    check('kekkai : D affiché ne ressort jamais (course, dash, saut, iai)', dShownMin >= limit - 0.5 && sp(3).x - sp(3).w / 2 >= limit - 0.5, `marge ${(dShownMin - limit).toFixed(2)} px`);
    check('kekkai : pousser vers la sortie, corrections p99 < 1 px', percentile(outCorr, 99) < 1 && !corr[3].snapped.some(Boolean), `p99 ${percentile(outCorr, 99).toFixed(2)} px`);
    // B et C, dehors, s'agitent : ils ne sont jamais affichés dedans chez A.
    sizes(2000, (i, f) => (i === 1 || i === 2 ? [BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK][((f / 30) | 0) % 3] : 0), () => {
      freezeGuardian(true);
      const p = bench.shownPlayer(cs[0], cs[1].pid);
      if (p) bShownMax = Math.max(bShownMax, p.x);
    });
    // Gardien vaincu, A franchit la porte : bilan.
    const g = w.enemies.find((e) => e.id === w.stage.guardianId);
    if (g) killEnemy(w, g, sp(0), 0, false);
    runQA(bench, state, logs, 400, () => 0, { onFrame: () => freezeGuardian(false) });
    const a = sp(0);
    a.x = w.level.gate.x - 40;
    a.y = w.level.gate.y;
    a.vx = a.vy = 0;
    sizes(2500, (i) => (i === 0 ? BTN.RIGHT : 0), () => freezeGuardian(false));
    // Récapitulatif chez chaque client, comparé aux fiches du serveur.
    const by = w.stage.byPlayer ?? {};
    const rows = cs.map((c) => buildRoster(c.src.world, c.pid));
    rosterOk = stateOf(w) === 'cleared' && rows.every((r) => r.length === 4 && r.filter((x) => x.me).length === 1 &&
      r.every((x) => !!by[x.id] && x.kills === by[x.id].kills && x.deaths === by[x.id].deaths && x.parries === by[x.id].parries && x.honor === by[x.id].honor && x.grade === by[x.id].grade));
    rosterInfo = rows.map((r) => r.map((x) => `${x.name}:${x.kills}/${x.honor}/${x.grade}`).join(' ')).join(' | ');
    needed = readyInfo(cs[2].src.world).needed;
    // Votes : A et B (2/4) ne suffisent pas ; C fait passer.
    sizes(800, (i, f) => ((i === 0 || i === 1) && f % 20 < 3 ? BTN.JUMP : 0), () => freezeGuardian(false));
    const twoVotes = stateOf(w);
    const seenReady = readyInfo(cs[3].src.world).ready;
    sizes(800, (i, f) => (i === 2 && f % 20 < 3 ? BTN.JUMP : 0), () => freezeGuardian(false));
    runQA(bench, state, logs, 1500, () => 0);
    check('bilan à 4 : 2 votes ne suffisent pas, vus par D ; le 3e fait passer', twoVotes === 'cleared' && seenReady === 2 && w.level.stage === level0 + 1 && stateOf(w) === 'playing', `${twoVotes}, prêts vus par D ${seenReady}, étape ${w.level.stage}`);
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 400);
  }
  check('4 clients M3 : aucune exception', err === '', err);
  check('buildRoster chez chaque client = fiches du serveur (4 lignes, une « moi »)', rosterOk, rosterInfo);
  check('readyInfo : 3 votes nécessaires sur 4', needed === 3, `${needed}`);
  check('B (dehors) jamais affiché dans l’arène chez A', bShownMax <= limit, `x max - limite = ${(bShownMax - limit).toFixed(1)}`);
  check('4 clients M3 : aucune correction > 32 px hors recalage net pendant l’arène (kekkai)', !big.some((s) => s.includes(':arena:')), big.join(' ') || 'aucune');
  console.log(`  · corrections > 32 px hors recalage net (toutes phases) : ${big.join(' ') || 'aucune'}`);
  check('4 clients M3 : nombre de joueurs affichés toujours juste, rendu monotone', logs.every((l) => l.playersMismatch === 0 && l.renderBackwards === 0), logs.map((l) => `${l.playersMismatch}/${l.renderBackwards}`).join(','));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  console.log(`  · tailles d'instantané à 4 joueurs : arène ${avg(bytes.arena).toFixed(0)} o (${bytes.arena.length}), bilan ${avg(bytes.cleared).toFixed(0)} o (${bytes.cleared.length}, max ${Math.max(0, ...bytes.cleared)} o)`);
  check('bilan à 4 : instantané < 2 Ko (statistiques par joueur comprises)', bytes.cleared.length > 0 && Math.max(...bytes.cleared) < 2048, `max ${Math.max(0, ...bytes.cleared)} o`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de recette du banc réseau passent.');
