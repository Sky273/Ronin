// Tests de la prédiction du joueur local et de la réconciliation (sans réseau réel).
// Lancer : npm run test:predict
import { clonePlayer, type PredictionContext, Predictor } from '../client/net/predictor';
import { createEnemy, findGround } from '../shared/enemy';
import { BTN } from '../shared/input';
import { Rng } from '../shared/math';
import type { Enemy, GameEvent, Player, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, spawnEnemy, stepWorld, warpToArena } from '../shared/world';
import { type BenchClient, NetBench, percentile } from './net/harness';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Relevé des corrections à chaque réconciliation d'un client du banc. */
interface CorrectionLog {
  px: number[];
  snapped: boolean[];
}
function logCorrections(c: BenchClient): CorrectionLog {
  const log: CorrectionLog = { px: [], snapped: [] };
  const pred = c.src.predictor;
  const orig = pred.reconcile.bind(pred);
  pred.reconcile = (self, ack, ctx, enemiesAt) => {
    const s0 = pred.snaps;
    orig(self, ack, ctx, enemiesAt);
    log.px.push(pred.lastCorrectionPx);
    log.snapped.push(pred.snaps !== s0);
  };
  return log;
}

/** Monde serveur sans ennemis (déplacement seul) et joueurs invulnérables. */
function calm(w: World): void {
  w.enemies = [];
  w.projectiles = [];
  w.spawnTimer = 1e6;
}

// 1. Réaction immédiate : vx affiché > 0 dès l'image où RIGHT est échantillonné.
{
  const bench = new NetBench({ seed: 5, lagMs: 75, jitterMs: 0 });
  const c = bench.addClient('a');
  let b = 0;
  bench.run(1500, () => b, () => calm(bench.session.world));
  check('client prêt, prédicteur créé', c.src.ready && c.src.predictor.meId === c.pid);
  let reacted = -1;
  const start = bench.metrics.frames;
  b = BTN.RIGHT;
  bench.run(300, () => b, (frame) => {
    calm(bench.session.world);
    const me = bench.shownPlayer(c);
    if (reacted < 0 && me && me.vx > 0) reacted = frame - start;
  });
  check('réaction locale en 0 image après l’appui (75 ms par sens)', reacted === 0, `${reacted} image(s)`);
  const me = bench.shownPlayer(c)!;
  const sv = bench.serverPlayer(c.pid)!;
  check('le joueur prédit est en avance sur le serveur', me.x > sv.x, `${me.x.toFixed(1)} > ${sv.x.toFixed(1)}`);
  check('tick prédit = tick serveur + entrées en attente', c.src.predictor.tick === c.src.world.tick && c.src.predictor.pending.length > 0, `${c.src.predictor.pending.length} en attente`);
}

// 2. Latence fixe, déplacement seul : corrections nulles, rejeu identique au serveur.
{
  const bench = new NetBench({ seed: 7, lagMs: 75, jitterMs: 0 });
  const c = bench.addClient('a');
  bench.run(1500, () => 0, () => calm(bench.session.world));
  const log = logCorrections(c);
  // Scénario : droite, gauche, sauts, dash, glissade, double saut, accroupi.
  const script: [number, number][] = [
    [40, BTN.RIGHT], [20, 0], [30, BTN.LEFT], [10, BTN.LEFT | BTN.JUMP], [30, BTN.LEFT], [15, BTN.RIGHT],
    [3, BTN.RIGHT | BTN.DASH], [30, BTN.RIGHT], [3, BTN.RIGHT | BTN.DOWN], [40, BTN.RIGHT], [8, BTN.JUMP],
    [4, 0], [8, BTN.JUMP], [30, BTN.RIGHT], [20, BTN.DOWN], [40, BTN.LEFT], [3, BTN.LEFT | BTN.DASH | BTN.JUMP],
    [60, 0],
  ];
  const seq: number[] = [];
  for (const [n, bb] of script) for (let i = 0; i < n; i++) seq.push(bb);
  const f0 = bench.metrics.frames;
  const predicted = new Map<number, Player>();
  const server = new Map<number, Player>();
  let lastAck = -1;
  const seen = new Set<string>();
  bench.run((seq.length + 40) * bench.frameMs, (_i, frame) => seq[frame - f0] ?? 0, () => {
    calm(bench.session.world);
    const ack = bench.session.ackFor(c.pid);
    if (ack !== lastAck) {
      lastAck = ack;
      server.set(ack, clonePlayer(bench.serverPlayer(c.pid)!));
    }
    const p = c.src.predictor.predicted;
    if (p) {
      predicted.set(c.src.inputSeq, clonePlayer(p as Player));
      seen.add(p.state);
    }
  });
  const max = Math.max(...log.px);
  check('latence fixe, déplacement seul : corrections exactement 0 px', log.px.length > 30 && max === 0, `${log.px.length} réconciliations, max ${max} px`);
  check('aucun recalage net', !log.snapped.some((s) => s));
  check('scénario couvrant dash, glissade et saut', seen.has('dash') && seen.has('slide'), [...seen].join(','));
  let compared = 0;
  let diff = 0;
  for (const [s, sp] of server) {
    const pp = predicted.get(s);
    if (!pp) continue;
    compared++;
    if (pp.x !== sp.x || pp.y !== sp.y || pp.vx !== sp.vx || pp.vy !== sp.vy || pp.state !== sp.state) diff++;
  }
  check('état prédit = état serveur aux mêmes entrées (x, y, vx, vy, état)', compared > 200 && diff === 0, `${compared} comparés, ${diff} différents`);
}

// 3. Combat contre des ennemis, avec gigue.
/** Le joueur avance vers les ennemis en frappant ; par moments il saute et pique (pogo), puis recule. */
const combatInput = (frame: number): number => {
  const k = frame % 240;
  if (k < 120) return (k % 30 < 10 ? BTN.RIGHT : 0) | (k % 10 === 0 ? BTN.ATTACK : 0);
  if (k < 140) return BTN.JUMP | (k === 135 ? BTN.DOWN | BTN.ATTACK : 0);
  if (k < 200) return k % 12 === 0 ? BTN.ATTACK : 0;
  return k % 8 === 0 ? BTN.ATTACK : BTN.LEFT;
};
/** Tous les types (le ninja et l'archer lancent des projectiles, que l'on peut renvoyer). */
const FOES = ['ashigaru', 'oni', 'ashigaru', 'ninja', 'archer'] as const;
/** Corps à corps seulement : les projectiles renvoyés ne sont pas prédits (voir 3b). */
const MELEE = ['ashigaru', 'oni', 'ashigaru'] as const;
/**
 * Côté serveur : joueur invulnérable (les coups reçus ne sont pas prédictibles, hors sujet ici)
 * et toujours de quoi frapper (des ennemis apparaissent devant lui).
 */
function feedFoes(w: World, p: Player, n: { spawned: number }, types: readonly Enemy['type'][]): void {
  p.iframes = 600;
  if (w.enemies.filter((e) => Math.abs(e.x - p.x) < 260).length < 2) {
    const x = p.x + p.facing * 70;
    const gy = findGround(w.level, x, p.y);
    if (gy !== null) spawnEnemy(w, types[n.spawned++ % types.length], x, gy, true);
  }
}
const isHit = (ev: GameEvent): boolean => ev.type === 'hit' || ev.type === 'block' || ev.type === 'guardBreak';

// 3a. Banc réseau complet (75 ms + gigue 20 ms) : interpolation au tick de vue et compensation de
// latence côté serveur. Tous les types d'ennemis : les projectiles renvoyés ne sont pas prédits et
// l'interpolation linéaire entre instantanés diffère un peu des positions exactes jugées par le
// serveur (coups en limite de portée) ; d'où des seuils un peu plus larges qu'en 3b.
{
  const bench = new NetBench({ seed: 11, lagMs: 75, jitterMs: 20 });
  const c = bench.addClient('a');
  const n = { spawned: 0 };
  const feed = (): void => {
    const p = bench.serverPlayer(c.pid);
    if (p) feedFoes(bench.session.world, p, n, FOES);
  };
  bench.run(1500, () => 0, feed);
  const log = logCorrections(c);
  let hits = 0;
  const pred = c.src.predictor;
  const origStep = pred.step.bind(pred);
  pred.step = (s, b, v, enemies, ctx) => {
    const evs = origStep(s, b, v, enemies, ctx);
    hits += evs.filter(isHit).length;
    return evs;
  };
  bench.run(40_000, (_i, frame) => combatInput(frame), feed);
  const px = log.px.filter((_, i) => !log.snapped[i]);
  const nz = px.filter((x) => x > 0).length;
  check('banc + combat : des coups prédits', hits > 20, `${hits} coups prédits`);
  check(
    'banc + combat : corrections p99 ≤ 6 px, max < 48 px, rares',
    percentile(px, 99) <= 6 && Math.max(...px) < 48 && nz / px.length < 0.05,
    `p99 ${percentile(px, 99).toFixed(2)} px, max ${Math.max(...px).toFixed(2)} px, ${nz}/${px.length} non nulles`,
  );
}

// 3b. Même combat, prédicteur alimenté avec les ennemis tels que le serveur les juge pour chaque
// entrée (ce que donneront l'interpolation au tick de vue et la compensation de latence) :
// liens simulés à 75 ms par sens, avec et sans gigue de 20 ms. Ennemis de corps à corps
// (hit-stop, garde de l'oni, brise-garde, pogo) : un projectile renvoyé qui frappe un oni en garde
// repousse le joueur côté serveur, et les projectiles ne sont pas prédits.
function combatDirect(jitterMs: number, seed: number): { px: number[]; snapped: number; hits: number; srvHits: number } {
  const DT_MS = 1000 / 60;
  const FRAMES = 2400;
  const rng = new Rng(seed);
  const w = createWorld(seed, { mode: 'coop' });
  const p = addPlayer(w, 'a');
  calm(w);
  const n = { spawned: 0 };
  // Entrée s envoyée à l'image s, arrivée après latence et gigue (ordre conservé).
  const arrive: number[] = [];
  let last = 0;
  for (let s = 1; s <= FRAMES; s++) arrive[s] = last = Math.max(last, s * DT_MS + 75 + rng.next() * jitterMs);
  // Serveur : un pas par image (décalé d'une demi-image), une entrée consommée par pas, sinon boutons tenus.
  const foes = new Map<number, Enemy[]>();
  const snaps: { at: number; self: Player; ack: number; ctx: PredictionContext }[] = [];
  let next = 1;
  let ack = -1;
  let held = 0;
  let srvHits = 0;
  let lastDown = 0;
  for (let k = 1; k <= FRAMES + 30; k++) {
    const t = k * DT_MS + DT_MS / 2;
    feedFoes(w, p, n, MELEE);
    let consumed = -1;
    if (next <= FRAMES && arrive[next] <= t) {
      held = combatInput(next);
      ack = consumed = next;
      foes.set(next, w.enemies.map((e) => ({ ...e })));
      next++;
    }
    stepWorld(w, new Map([[p.id, held]]));
    if (consumed > 120) srvHits += w.events.filter((ev) => isHit(ev) && 'pid' in ev && ev.pid === p.id).length;
    w.events.length = 0;
    if (k % 3 === 0) {
      lastDown = Math.max(lastDown, t + 75 + rng.next() * jitterMs);
      snaps.push({ at: lastDown, self: clonePlayer(p), ack, ctx: { level: w.level, stage: { ...w.stage }, wave: { ...w.wave }, shrine: w.shrine, serverTick: w.tick } });
    }
  }
  // Client : à chaque image, l'entrée prédite puis les instantanés arrivés (ordre de RemoteSource).
  const pred = new Predictor(p.id);
  const enemiesAt = (v: number): Enemy[] => (foes.get(v) ?? []).map((e) => ({ ...e }));
  const px: number[] = [];
  let snapped = 0;
  let hits = 0;
  let ctx: PredictionContext | null = null;
  let si = 0;
  for (let f = 1; f <= FRAMES; f++) {
    if (ctx) {
      const n = pred.step(f, combatInput(f), f, enemiesAt(f), ctx).filter(isHit).length;
      if (f > 120) hits += n;
    }
    while (si < snaps.length && snaps[si].at <= f * DT_MS) {
      const sn = snaps[si++];
      ctx = sn.ctx;
      const s0 = pred.snaps;
      pred.reconcile(sn.self, sn.ack, ctx, enemiesAt);
      if (pred.snaps !== s0) snapped++;
      else if (f > 120) px.push(pred.lastCorrectionPx);
    }
  }
  return { px, snapped, hits, srvHits };
}
{
  const fixed = combatDirect(0, 31);
  const fmax = Math.max(...fixed.px);
  check('combat sans gigue, ennemis du tick de vue : coups prédits = coups serveur', fixed.hits > 40 && fixed.hits === fixed.srvHits, `${fixed.hits} prédits, ${fixed.srvHits} serveur`);
  check('combat sans gigue : corrections exactement 0 px', fmax === 0 && fixed.snapped === 0, `max ${fmax} px sur ${fixed.px.length}`);
  for (const seed of [33, 35, 37]) {
    const r = combatDirect(20, seed);
    const p99 = percentile(r.px, 99);
    const max = Math.max(...r.px);
    const nz = r.px.filter((x) => x > 0).length;
    check(`gigue 20 ms + combat (graine ${seed}) : correction p99 < 4 px`, r.hits > 40 && p99 < 4, `p99 ${p99.toFixed(2)} px, ${nz}/${r.px.length} non nulles, ${r.hits} coups`);
    check(`gigue 20 ms + combat (graine ${seed}) : correction max < 32 px`, max < 32, `max ${max.toFixed(2)} px, ${r.snapped} recalage(s) net(s)`);
  }
  // Forte gigue (le serveur manque parfois d'entrées et rejoue les boutons tenus) : mesure.
  const big = combatDirect(60, 39);
  console.log(`· gigue 60 ms + combat — mesure : p99 ${percentile(big.px, 99).toFixed(2)} px, max ${Math.max(...big.px).toFixed(2)} px, ${big.px.filter((x) => x > 0).length}/${big.px.length} non nulles`);
}

// 4. Recalage net : aspiration dans l'arène, puis changement d'étape.
{
  const bench = new NetBench({ seed: 13, lagMs: 75, jitterMs: 10 });
  const a = bench.addClient('a');
  const b = bench.addClient('b');
  let bb = 0;
  bench.run(1500, (i) => (i === 1 ? bb : 0), () => calm(bench.session.world));
  const w = bench.session.world;
  const pred = a.src.predictor;
  const snaps0 = pred.snaps;
  warpToArena(w, b.pid); // l'autre joueur part devant : il déclenche l'arène et aspire le joueur a
  bb = BTN.RIGHT;
  let arenaSeen = false;
  bench.run(1500, (i) => (i === 1 ? bb : 0), () => {
    if (w.stage.state === 'arena') arenaSeen = true;
  });
  const me = bench.shownPlayer(a)!;
  const sv = bench.serverPlayer(a.pid)!;
  check('arène verrouillée par l’autre joueur', arenaSeen && w.stage.state === 'arena');
  check('aspiration dans l’arène : recalage net', pred.snaps > snaps0 && Math.abs(me.x - sv.x) < 1, `snaps ${snaps0} → ${pred.snaps}, écart ${Math.abs(me.x - sv.x).toFixed(2)} px`);

  const snaps1 = pred.snaps;
  bb = 0;
  nextStage(w);
  bench.run(800, () => 0);
  const me2 = bench.shownPlayer(a)!;
  const sv2 = bench.serverPlayer(a.pid)!;
  check('changement d’étape : recalage net', pred.snaps > snaps1 && Math.abs(me2.x - sv2.x) < 1 && a.src.world.level.stage === w.level.stage, `snaps ${snaps1} → ${pred.snaps}`);
}

// Banc direct : un monde serveur, un prédicteur, des stepWorld (pas de réseau).
function directSetup(seed: number): { w: World; p: Player; pred: Predictor; ctx: () => PredictionContext } {
  const w = createWorld(seed, { mode: 'coop' });
  const p = addPlayer(w, 'solo');
  calm(w);
  for (let i = 0; i < 60; i++) stepWorld(w, new Map([[p.id, 0]]));
  w.events.length = 0;
  const pred = new Predictor(p.id);
  const ctx = (): PredictionContext => ({ level: w.level, stage: { ...w.stage }, wave: { ...w.wave }, shrine: w.shrine, serverTick: w.tick });
  return { w, p, pred, ctx };
}

// 5. Avant tout instantané, rien n'est prédit ; pendant le bilan, le joueur prédit ne bouge pas.
{
  const { w, p, pred, ctx } = directSetup(21);
  check('avant le premier instantané : rien à afficher, entrées mémorisées', pred.step(1, BTN.RIGHT, 0, [], ctx()).length === 0 && pred.display(0, 16) === null && pred.pending.length === 1);
  w.stage.state = 'cleared';
  pred.reconcile(clonePlayer(p), 0, ctx(), () => []);
  const x0 = p.x;
  const y0 = p.y;
  let moved = false;
  let evs = 0;
  let last = 0;
  for (let s = 2; s < 60; s++) {
    last = BTN.RIGHT | (s % 4 === 0 ? BTN.JUMP | BTN.ATTACK : 0);
    evs += pred.step(s, last, 0, [], ctx()).length;
    const d = pred.display(0.5, 16)!;
    if (d.x !== x0 || d.y !== y0) moved = true;
  }
  check('bilan : le joueur prédit ne bouge pas, aucun effet', !moved && evs === 0 && pred.predicted!.prevButtons === last);
}

// 6. Champs d'interface : toujours ceux du serveur, même quand la prédiction tire une offre ou tue.
{
  const { p, pred, ctx } = directSetup(23);
  p.picks = 2;
  p.offer = ['edge', 'swift', 'vital'];
  pred.reconcile(clonePlayer(p), 0, ctx(), () => []);
  // Un ennemi presque mort juste devant le joueur (vu par le client, pas par le serveur).
  const e: Enemy = createEnemy(9999, 'ashigaru', p.x + 30 * p.facing, p.y);
  e.hp = 1;
  let kills = 0;
  let hits = 0;
  let flicker = false;
  const inputs = [BTN.PICK1, 0, BTN.ATTACK, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  inputs.forEach((b, i) => {
    for (const ev of pred.step(i + 1, b, 0, [e], ctx())) if (ev.type === 'hit') hits++;
    const d = pred.display(0, 16)!;
    if (d.offer.join() !== p.offer.join() || d.picks !== p.picks || d.up.edge !== p.up.edge || d.kills !== p.kills || d.score !== p.score || d.honor !== p.honor || d.level !== p.level || d.hp !== p.hp) flicker = true;
    kills = pred.predicted!.kills;
  });
  const q = pred.predicted!;
  check('la prédiction a tiré une offre et frappé (cas significatif)', q.offer.join() !== p.offer.join() && q.up.edge === 1 && hits > 0 && kills > 0, `offre prédite ${q.offer.join()}, ${hits} coup(s)`);
  check('affichage : offre, choix, améliorations, score, kills, PV du serveur', !flicker);
}

// 7. Petites corrections lissées en exp(-t/τ) ; grand écart : recalage net.
{
  const { p, pred, ctx } = directSetup(25);
  pred.reconcile(clonePlayer(p), 0, ctx(), () => []);
  for (let s = 1; s <= 5; s++) pred.step(s, 0, 0, [], ctx());
  const shown0 = pred.display(1, 0)!.x;
  const moved = clonePlayer(p);
  moved.x += 10; // le serveur a vu le joueur 10 px plus loin
  pred.reconcile(moved, 0, ctx(), () => []);
  const d0 = pred.display(1, 0)!.x;
  check('petite correction : pas de saut à l’écran', Math.abs(d0 - shown0) < 1e-9 && Math.abs(pred.lastCorrectionPx - 10) < 1e-9, `${pred.lastCorrectionPx} px`);
  let x = 0;
  for (let i = 0; i < 6; i++) x = pred.display(1, 50)!.x; // 300 ms = 3 τ
  const target = pred.predicted!.x;
  check('correction absorbée en quelques τ', Math.abs(x - target) < 10 * Math.exp(-3) + 1e-6 && Math.abs(x - target) > 0.1, `reste ${(x - target).toFixed(3)} px`);
  const s0 = pred.snaps;
  const far = clonePlayer(p);
  far.x += 500;
  pred.reconcile(far, 0, ctx(), () => []);
  check('grand écart (> 120 px) : recalage net', pred.snaps === s0 + 1 && Math.abs(pred.display(1, 0)!.x - pred.predicted!.x) < 1e-9);
  const dead = clonePlayer(far);
  dead.state = 'dead';
  dead.respawnT = 120;
  const s1 = pred.snaps;
  pred.reconcile(dead, 5, ctx(), () => []);
  check('mort : recalage net', pred.snaps === s1 + 1);
  check('joueur absent du serveur : tout est vidé', (pred.reconcile(null, 5, ctx(), () => []), pred.display(0, 16) === null && pred.pending.length === 0));
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de prédiction passent.');
