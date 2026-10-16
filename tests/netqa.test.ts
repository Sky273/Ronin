// Recette du mode en ligne sur le banc réseau virtuel : parties longues à plusieurs clients,
// latences de 0 à 150 ms par sens et gigues de 0 à 60 ms, avec morts, renaissances, arène,
// bilan d'étape, étape suivante et onglet en arrière-plan.
// Vérifie : aucune exception, recalages nets rares, nombre de joueurs affichés, tick de rendu
// monotone, événements ni perdus ni dupliqués (un `kill` montré une seule fois), rien de bloqué.
// Lancer : npm run test:netqa
import { PREDICTED_TYPES } from '../client/net/eventGate';
import { BTN } from '../shared/input';
import { damagePlayer, killEnemy } from '../shared/interactions';
import { Rng } from '../shared/math';
import { decodeSnapshot, type SnapshotWire } from '../shared/net/codec';
import { SNAP_EVERY } from '../shared/net/protocol';
import type { GameEvent, World } from '../shared/types';
import { warpToArena } from '../shared/world';
import { type BenchClient, NetBench } from './net/harness';

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

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de recette du banc réseau passent.');
