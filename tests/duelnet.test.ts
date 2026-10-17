// Tests d'équité des duels sur le banc réseau (latences, gigue, parade, avance du signal).
// Lancer : npm run test:duelnet
// Principe : chaque client scripté tient l'iai pendant la garde et le relâche quand son tick prédit
// atteint sigTick + r. Le serveur doit mesurer exactement r, quelle que soit la latence, et le plus
// rapide doit gagner.
import { BTN } from '../shared/input';
import { Rng } from '../shared/math';
import { COOP_DUEL_RULES, duelOf, kamaeLength, signalShown, startDuel } from '../shared/duel';
import { DUEL, DUEL_QUEUE_LIMIT, DUEL_WHY } from '../shared/constants';
import type { GameEvent } from '../shared/types';
import { type BenchClient, NetBench, percentile } from './net/harness';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

type Round = { ra: number; rb: number; winner: number; why: number; wantA: number; wantB: number; aPid: number };

/** Stratégie d'un client pour une manche (clé « duel:manche jouée ») : réaction voulue (ticks) et geste. */
type Plan = (key: string) => { r: number; act: 'iai' | 'parry' };

interface Result {
  rounds: Round[];
  /** Pour chaque client : avance minimale (ticks) entre la réception de sigTick et son atteinte. */
  lead: number[];
}

/**
 * Fait disputer des duels successifs à deux clients (latences données) jusqu'à `want` manches
 * tranchées ou rejouées. `plans[i]` décide de la réaction du client i à chaque manche.
 */
function duelBench(lags: [number, number], jitterMs: number, plans: [Plan, Plan], want: number, seed = 1): Result {
  const bench = new NetBench({ seed, lagMs: 0, jitterMs: 0 });
  const cs: BenchClient[] = [bench.addClient('A', { lagMs: lags[0], jitterMs }), bench.addClient('B', { lagMs: lags[1], jitterMs })];
  const w = bench.session.world;
  const calm = (): void => {
    w.enemies = [];
    w.projectiles = [];
    w.spawnTimer = 1e6;
    for (const p of w.players) p.iframes = 1e6;
  };
  bench.run(1500, () => 0, calm);
  // Les deux joueurs côte à côte sur un sol plat (près du départ).
  const [pa, pb] = cs.map((c) => bench.serverPlayer(c.pid)!);
  pb.x = pa.x + 120;
  pb.y = pa.y;
  bench.run(300, () => 0, calm);

  const rounds: Round[] = [];
  const lead = [Infinity, Infinity];
  const seenSig = [new Set<number>(), new Set<number>()];
  const seen = new Set<GameEvent>();
  bench.onServerStep(() => {
    for (const ev of bench.session.pendingEvents) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      if (ev.type !== 'duelRound') continue;
      const d = w.duels?.find((x) => x.id === ev.id);
      const aPid = d ? d.a.pid : -1;
      rounds.push({ ra: ev.ra, rb: ev.rb, winner: ev.winner, why: ev.why, wantA: -1, wantB: -1, aPid });
    }
  });
  // Réaction voulue par client et par manche (mémorisée pour comparer à la mesure du serveur).
  const wanted: Map<string, number>[] = [new Map(), new Map()];
  let guard = 0;
  while (rounds.length < want && guard++ < 400) {
    if (!duelOf(w, pa.id)) {
      calm();
      if (!startDuel(w, pa, pb, COOP_DUEL_RULES)) break;
    }
    bench.run(500, (i) => {
      const c = cs[i];
      const d = c.src.world.duels?.find((x) => x.a.pid === c.pid || x.b.pid === c.pid);
      if (!d || d.sigTick < 0 || (d.phase !== 'kamae' && d.phase !== 'open')) return 0;
      const t = bench.predictedTick(c);
      // Avance du signal : premier instant où le client connaît ce sigTick.
      if (!seenSig[i].has(d.sigTick)) {
        seenSig[i].add(d.sigTick);
        lead[i] = Math.min(lead[i], d.sigTick - t);
      }
      const key = `${d.id}:${d.played}`;
      const plan = plans[i](key);
      wanted[i].set(key, plan.r);
      const at = d.sigTick + plan.r;
      if (plan.act === 'iai') return t < at ? BTN.IAI : 0; // relâcher l'iai chargé à sigTick + r
      return t === at ? BTN.PARRY : 0;
    }, calm);
  }
  // Associer les réactions voulues (par ordre de manche) aux manches mesurées.
  const order = [...wanted[0].keys()]; // ordre d'apparition = ordre des manches
  rounds.forEach((rd, k) => {
    const played = order[k];
    if (played === undefined) return;
    const aIsFirst = rd.aPid === pa.id;
    const w0 = wanted[0].get(played) ?? -1;
    const w1 = wanted[1].get(played) ?? -1;
    rd.wantA = aIsFirst ? w0 : w1;
    rd.wantB = aIsFirst ? w1 : w0;
  });
  return { rounds, lead };
}

const CONFIGS: [number, number][] = [[0, 0], [75, 75], [150, 150], [0, 150], [150, 0], [75, 150]];

// ─── 1. Mesure exacte des réactions et équité, sans gigue ───────────────────
for (const lags of CONFIGS) {
  const rng = new Rng(lags[0] * 7 + lags[1] * 13 + 1);
  const rA = new Map<string, number>();
  const rB = new Map<string, number>();
  const pick = (m: Map<string, number>) => (key: string) => {
    if (!m.has(key)) m.set(key, 10 + Math.floor(rng.next() * 21));
    return { r: m.get(key)!, act: 'iai' as const };
  };
  const { rounds, lead } = duelBench(lags, 0, [pick(rA), pick(rB)], 30, lags[0] + lags[1] + 3);
  // Réactions enregistrées par le serveur (le perdant n'a parfois pas encore frappé : -1).
  const measured = rounds.filter((r) => r.wantA >= 0);
  const err = measured.flatMap((r) => [...(r.ra >= 0 ? [r.ra - r.wantA] : []), ...(r.rb >= 0 ? [r.rb - r.wantB] : [])]);
  const exact = err.every((e) => e >= 0 && e <= 1);
  const decisive = measured.filter((r) => Math.abs(r.wantA - r.wantB) >= 2);
  const fair = decisive.filter((r) => r.winner >= 0 && (r.winner === r.aPid) === (r.wantA < r.wantB));
  const tag = `${lags[0]}/${lags[1]} ms`;
  check(`${tag} : ${rounds.length} manches jouées`, rounds.length >= 25, `${rounds.length}`);
  check(`${tag} : réaction mesurée par le serveur = réaction scriptée (+0 à 1 tick)`, exact && err.length >= 25, `écarts ${[...new Set(err)].sort((a, b) => a - b).join(',')} sur ${err.length} réactions`);
  check(`${tag} : le plus rapide gagne toujours (écart ≥ 2 ticks)`, decisive.length > 10 && fair.length === decisive.length, `${fair.length}/${decisive.length}`);
  check(`${tag} : signal connu ≥ 60 ticks à l'avance chez les deux clients`, lead.every((l) => l >= 60), lead.join(' / '));
}

// ─── 2. Avec gigue (20 ms) : mesure à ±2 ticks (p95), le plus rapide gagne ≥ 98 % ───
for (const lags of [[75, 75], [0, 150]] as [number, number][]) {
  const rng = new Rng(99 + lags[1]);
  const rA = new Map<string, number>();
  const rB = new Map<string, number>();
  const pick = (m: Map<string, number>) => (key: string) => {
    if (!m.has(key)) m.set(key, 10 + Math.floor(rng.next() * 21));
    return { r: m.get(key)!, act: 'iai' as const };
  };
  const { rounds } = duelBench(lags, 20, [pick(rA), pick(rB)], 40, 7 + lags[1]);
  const measured = rounds.filter((r) => r.wantA >= 0);
  const err = measured.flatMap((r) => [...(r.ra >= 0 ? [Math.abs(r.ra - r.wantA)] : []), ...(r.rb >= 0 ? [Math.abs(r.rb - r.wantB)] : [])]);
  const decisive = measured.filter((r) => Math.abs(r.wantA - r.wantB) >= 2);
  const fair = decisive.filter((r) => r.winner >= 0 && (r.winner === r.aPid) === (r.wantA < r.wantB));
  const tag = `${lags[0]}/${lags[1]} ms + gigue 20 ms`;
  check(`${tag} : écart de mesure p95 ≤ 2 ticks`, err.length >= 30 && percentile(err, 95) <= 2, `p95 ${percentile(err, 95)}, max ${Math.max(...err)} sur ${err.length} réactions`);
  check(`${tag} : le plus rapide gagne ≥ 98 %`, decisive.length > 10 && fair.length / decisive.length >= 0.98, `${fair.length}/${decisive.length}`);
}

// ─── 3. Parade : A frappe à r = 12, B pare k ticks plus tard (k = 0 … 10) ────
{
  for (const lags of [[0, 0], [150, 0], [0, 150]] as [number, number][]) {
    const results: string[] = [];
    let ok = true;
    for (let k = 0; k <= 10; k++) {
      const { rounds } = duelBench(lags, 0, [() => ({ r: 12, act: 'iai' }), () => ({ r: 12 + k, act: 'parry' })], 1, 50 + k);
      const r = rounds[0];
      if (!r) {
        ok = false;
        results.push(`k=${k}:?`);
        continue;
      }
      // Impact de A à S + 12 + STRIKE_TRAVEL ; garde de B sur [S + 12 + k, S + 12 + k + PARRY_ACTIVE].
      const parried = k <= DUEL.STRIKE_TRAVEL;
      const aWins = r.winner === r.aPid;
      const want = parried ? DUEL_WHY.PARRY : DUEL_WHY.IPPON;
      // Le client A est le côté a (à gauche) ou b selon le placement : on compare les gagnants par pid.
      const aClientIsSideA = r.wantA === 12;
      const winnerIsAClient = aClientIsSideA ? aWins : r.winner >= 0 && !aWins;
      const good = r.why === want && winnerIsAClient === !parried;
      ok &&= good;
      results.push(`k=${k}:${good ? 'ok' : `why ${r.why}`}`);
    }
    check(`parade à ${lags[0]}/${lags[1]} ms : parée jusqu'à ${DUEL.STRIKE_TRAVEL} ticks après la frappe, pas au-delà`, ok, results.join(' '));
  }
}

// ─── 4. Client accéléré (boucle doublée, accélérateur) : aucun avantage de réaction ───
// Modèle humain : chaque client voit le 斬 à l'image où signalShown(d, world.tick) devient vrai
// (état affiché en fin d'image) et relâche l'iai R images de temps réel plus tard. Le client F envoie
// ses entrées à `hz` (plusieurs advance(1/60) par image), le client H à 60 Hz. Gain de F = R − réaction
// mesurée par le serveur ; il doit être nul (±1 tick), sinon un client qui envoie trop vite voit le
// signal avant les autres.
interface RateResult {
  /** Réactions mesurées par le serveur pour F et H (-1 : pas de frappe). */
  rounds: { rf: number; rh: number; winner: number; why: number }[];
  /** Fins de série (motif, vainqueur, ticks depuis duelStart). */
  ends: { why: number; winner: number; after: number }[];
  fastPid: number;
}
function rateBench(hz: number, lagMs: number, rf: number, rh: number, want: number, seed: number): RateResult {
  const bench = new NetBench({ seed, lagMs, jitterMs: 0 });
  const fast = bench.addClient('F');
  const honest = bench.addClient('H');
  fast.sendHz = hz;
  const cs = [fast, honest];
  const react = [rf, rh];
  const w = bench.session.world;
  const calm = (): void => {
    w.enemies = [];
    w.projectiles = [];
    w.spawnTimer = 1e6;
    for (const p of w.players) p.iframes = 1e6;
  };
  bench.run(1500, () => 0, calm);
  const [pa, pb] = cs.map((c) => bench.serverPlayer(c.pid)!);
  pb.x = pa.x + 120;
  pb.y = pa.y;
  bench.run(300, () => 0, calm);
  const rounds: RateResult['rounds'] = [];
  const endsOut: RateResult['ends'] = [];
  const seen = new Set<GameEvent>();
  let startedAt = 0;
  bench.onServerStep((t) => {
    for (const ev of bench.session.pendingEvents) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      if (ev.type === 'duelStart') startedAt = t;
      if (ev.type === 'duelEnd') endsOut.push({ why: ev.why, winner: ev.winner, after: t - startedAt });
      if (ev.type !== 'duelRound') continue;
      const d = w.duels?.find((x) => x.id === ev.id);
      const fa = d?.a.pid === fast.pid;
      rounds.push({ rf: fa ? ev.ra : ev.rb, rh: fa ? ev.rb : ev.ra, winner: ev.winner, why: ev.why });
    }
  });
  const seenAt = [new Map<string, number>(), new Map<string, number>()];
  const mine = (c: BenchClient) => c.src.world.duels?.find((x) => x.a.pid === c.pid || x.b.pid === c.pid);
  let guard = 0;
  let duels = 0;
  while (rounds.length < want && guard++ < 400) {
    if (!duelOf(w, pa.id)) {
      calm();
      // Sans manche jouée (forfait), on s'arrête après quelques séries.
      if (rounds.length === 0 && duels >= 3) break;
      if (!startDuel(w, pa, pb, COOP_DUEL_RULES)) break;
      duels++;
    }
    bench.run(500, (i, frame) => {
      const d = mine(cs[i]);
      if (!d || d.sigTick < 0 || (d.phase !== 'kamae' && d.phase !== 'open')) return 0;
      const f = seenAt[i].get(`${d.id}:${d.played}`);
      return f !== undefined && frame >= f + 1 + react[i] ? 0 : BTN.IAI;
    }, (frame) => {
      calm();
      cs.forEach((c, i) => {
        const d = mine(c);
        const key = d ? `${d.id}:${d.played}` : '';
        if (d && !seenAt[i].has(key) && signalShown(d, c.src.world.tick)) seenAt[i].set(key, frame);
      });
    });
  }
  return { rounds, ends: endsOut, fastPid: fast.pid };
}
{
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  for (const lagMs of [0, 75, 150]) {
    for (const hz of [60, 90, 120, 240]) {
      const tag = `${hz} Hz contre 60 Hz à ${lagMs} ms`;
      // Réaction lente (1 s) : aucune faute possible, le gain se lit directement.
      const R = 60;
      const slow = rateBench(hz, lagMs, R, R, 20, 11 + hz + lagMs);
      const gains = slow.rounds.filter((r) => r.rf >= 0).map((r) => R - r.rf);
      const hon = slow.rounds.filter((r) => r.rh >= 0).map((r) => R - r.rh);
      // Étalonnage du modèle humain (60 Hz des deux côtés) ; au-delà, F tranche souvent avant que H frappe.
      if (hz === 60) check(`${tag} : réaction du client honnête mesurée exactement`, hon.length >= 15 && hon.every((g) => g === 0), `écarts ${[...new Set(hon)].join(',')}`);
      // Issue acceptable : aucun gain sur les manches jouées, ou forfait (FLOOD) du client accéléré.
      const flood = slow.ends.filter((e) => e.why === DUEL_WHY.FLOOD);
      const floodOk = flood.every((e) => e.winner !== slow.fastPid);
      const info = `gain moyen ${gains.length ? avg(gains).toFixed(1) : '-'} ticks${gains.length ? `, de ${Math.min(...gains)} à ${Math.max(...gains)}` : ''}, sur ${gains.length} manches ; forfaits FLOOD ${flood.length} (après ${flood.map((e) => e.after).join(',')} ticks)`;
      if (hz === 60) check(`${tag} : client honnête jamais en forfait FLOOD, mesure exacte`, flood.length === 0 && gains.length >= 15 && gains.every((g) => g === 0), info);
      else check(`${tag} : le client accéléré ne gagne pas de temps de réaction (≤ 1 tick) ou perd par forfait`, floodOk && (gains.length > 0 || flood.length > 0) && gains.every((g) => Math.abs(g) <= 1), info);
      // Réactions humaines égales (300 ms) : le client accéléré ne gagne aucune manche.
      const eq = rateBench(hz, lagMs, 18, 18, 20, 3 + hz + lagMs);
      const fw = eq.rounds.filter((r) => r.winner === eq.fastPid).length;
      const ff = eq.rounds.filter((r) => r.why === DUEL_WHY.FOUL && r.winner !== eq.fastPid).length;
      const ef = eq.ends.filter((e) => e.why === DUEL_WHY.FLOOD).length;
      check(`${tag} : à réaction égale (18 ticks), le client accéléré ne gagne aucune manche`, (eq.rounds.length >= 15 || ef > 0) && fw === 0 && (hz > 60 || ff === 0),
        `F gagne ${fw}/${eq.rounds.length}, F en faute ${ff}/${eq.rounds.length}, forfaits FLOOD ${ef}`);
    }
  }
}

// ─── 5. Réseau : déconnexion, arrivée en cours de duel, cohérence entre clients, faux forfaits ───
type DuelEv = Extract<GameEvent, { type: 'duelStart' | 'duelRound' | 'duelEnd' }>;
const isDuelEv = (e: GameEvent): e is DuelEv => e.type === 'duelStart' || e.type === 'duelRound' || e.type === 'duelEnd';
/** Banc à n clients ; les deux premiers côte à côte sur un sol plat, le monde serveur tenu au calme. */
function netScene(lags: number[], seed: number) {
  const bench = new NetBench({ seed, lagMs: 0, jitterMs: 0 });
  const cs = lags.map((l, i) => bench.addClient(`P${i}`, { lagMs: l }));
  const w = bench.session.world;
  const calm = (): void => {
    w.enemies = [];
    w.projectiles = [];
    w.spawnTimer = 1e6;
    w.wave.phase = 'calm';
    w.wave.t = 0;
    for (const p of w.players) p.iframes = 1e6;
  };
  bench.run(1500, () => 0, calm);
  const [pa, pb] = cs.map((c) => bench.serverPlayer(c.pid)!);
  pb.x = pa.x + 120;
  pb.y = pa.y;
  bench.run(300, () => 0, calm);
  // Événements de duel émis par le serveur, dans l'ordre.
  const server: DuelEv[] = [];
  const seen = new Set<GameEvent>();
  bench.onServerStep(() => {
    for (const ev of bench.session.pendingEvents) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      if (isDuelEv(ev)) server.push(ev);
    }
  });
  for (const c of cs) c.events.length = 0;
  return { bench, cs, w, calm, pa, pb, server };
}
/** Script : chaque duelliste tient l'iai et le relâche quand son tick prédit atteint sigTick + r[pid]. */
function releaseAt(bench: NetBench, cs: BenchClient[], r: Map<number, number>) {
  return (i: number): number => {
    const c = cs[i];
    const d = c.src.world.duels?.find((x) => x.a.pid === c.pid || x.b.pid === c.pid);
    const want = r.get(c.pid);
    if (!d || want === undefined || d.sigTick < 0 || (d.phase !== 'kamae' && d.phase !== 'open')) return 0;
    return bench.predictedTick(c) < d.sigTick + want ? BTN.IAI : 0;
  };
}
const duelEvs = (c: BenchClient) => c.events.filter(isDuelEv);
{
  // 5a. Déconnexion en cours de garde : forfait, vu par l'adversaire et par un spectateur.
  const { bench, cs, w, calm, pa, pb, server } = netScene([50, 100, 80], 21);
  const [A, B, C] = cs;
  const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
  bench.run(1200, () => 0, calm); // jusqu'à la garde
  check('déconnexion : duel en garde avant la coupure', d.phase === 'kamae' || d.phase === 'open', d.phase);
  B.transport.leave();
  bench.session.leave(B.pid);
  bench.clients.splice(bench.clients.indexOf(B), 1);
  bench.run(500, () => 0, calm);
  const endA = duelEvs(A).find((e) => e.type === 'duelEnd');
  const endC = duelEvs(C).find((e) => e.type === 'duelEnd');
  check('déconnexion : A et le spectateur reçoivent duelEnd DISCONNECT, A vainqueur', endA?.type === 'duelEnd' && endA.why === DUEL_WHY.DISCONNECT && endA.winner === A.pid && JSON.stringify(endA) === JSON.stringify(endC), `${JSON.stringify(endA)} / ${JSON.stringify(endC)}`);
  check('déconnexion : un seul duelEnd côté serveur', server.filter((e) => e.type === 'duelEnd').length === 1);
  bench.run(3000, () => 0, calm);
  check('déconnexion : duel retiré partout, A libre', !w.duels!.length && !A.src.world.duels?.length && !C.src.world.duels?.length && !duelOf(w, A.pid));
  // A rejoue normalement (prédiction hors duel) : il se déplace.
  const x0 = bench.serverPlayer(A.pid)!.x;
  bench.run(500, (i) => (cs[i] === A ? BTN.RIGHT : 0), calm);
  check('déconnexion : A reprend la main après le duel', bench.serverPlayer(A.pid)!.x > x0 + 50, `${x0} → ${bench.serverPlayer(A.pid)!.x}`);
}
{
  // 5b. Arrivée d'un joueur pendant un duel : il le voit (duelliste, phase, score) puis suit la suite.
  const { bench, cs, w, calm, pa, pb, server } = netScene([40, 90], 22);
  const [A, B] = cs;
  const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
  const r = new Map([[A.pid, 10], [B.pid, 30]]);
  const script = releaseAt(bench, cs, r);
  // Première manche jouée, puis arrivée de D pendant le dénouement ou la manche suivante.
  for (let k = 0; k < 40 && d.a.wins + d.b.wins < 1; k++) bench.run(100, script, calm);
  const D = bench.addClient('D', { lagMs: 120 });
  bench.run(600, (i) => (i < 2 ? script(i) : 0), calm);
  const seenD = D.src.world.duels?.find((x) => x.id === d.id);
  check('arrivée pendant un duel : le nouveau voit le duel (mêmes duellistes, même score)', !!seenD && seenD.a.pid === d.a.pid && seenD.b.pid === d.b.pid && seenD.a.wins + seenD.b.wins === d.a.wins + d.b.wins,
    `${JSON.stringify(seenD && { a: seenD.a, b: seenD.b, phase: seenD.phase })} / serveur ${d.phase} ${d.a.wins}-${d.b.wins}`);
  for (let k = 0; k < 100 && w.duels!.includes(d); k++) bench.run(100, (i) => (i < 2 ? script(i) : 0), calm);
  bench.run(500, () => 0, calm);
  const endD = duelEvs(D).find((e) => e.type === 'duelEnd');
  const endS = server.find((e) => e.type === 'duelEnd');
  check('arrivée pendant un duel : le nouveau reçoit la fin de série, identique au serveur', !!endD && JSON.stringify(endD) === JSON.stringify(endS), `${JSON.stringify(endD)} / ${JSON.stringify(endS)}`);
  check('arrivée pendant un duel : le nouveau voit le duel retiré', !D.src.world.duels?.length);
}
{
  // 5c. Cohérence : deux duellistes et deux spectateurs (latences différentes) reçoivent les mêmes événements de duel que le serveur.
  const { bench, cs, w, calm, pa, pb, server } = netScene([30, 140, 0, 200], 23);
  const [A, B] = cs;
  const r = new Map([[A.pid, 14], [B.pid, 11]]);
  const script = releaseAt(bench, cs, r);
  for (let n = 0; n < 2; n++) {
    calm();
    const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
    for (let k = 0; k < 200 && w.duels!.includes(d); k++) bench.run(100, script, calm);
    bench.run(DUEL.AFTER_COOLDOWN * 20, () => 0, calm); // délai de paire écoulé
  }
  bench.run(1000, () => 0, calm);
  const ref = JSON.stringify(server);
  const same = cs.map((c) => JSON.stringify(duelEvs(c)) === ref);
  const ends = server.filter((e) => e.type === 'duelEnd');
  check('cohérence : deux séries jouées, B (plus rapide) gagne 2–0 à chaque fois', ends.length === 2 && ends.every((e) => e.type === 'duelEnd' && e.winner === B.pid && e.why === DUEL_WHY.WIN), JSON.stringify(ends));
  check('cohérence : chaque client reçoit exactement les événements de duel du serveur, dans l\'ordre, sans doublon', same.every(Boolean) && server.length >= 8, `${same.join(',')} ; ${server.length} événements serveur`);
}
{
  // 5d. Faux forfaits : un client honnête (60 Hz) victime d'une coupure réseau ou d'un à-coup du serveur
  // pendant un duel ne doit pas perdre par FLOOD (sa file se remplit d'un coup, à son insu).
  const stall = (ms: number, kind: 'réseau' | 'coupure' | 'serveur', times = 1): { flood: number; live: boolean; ended: string } => {
    const { bench, cs, w, calm, pa, pb, server } = netScene([50, 50], 30 + ms + times);
    const [, B] = cs;
    const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
    bench.run(1000, () => 0, calm);
    const up = B.transport.up as unknown as { opts: { lagMs: number } };
    if (kind === 'réseau') {
      // Retard du lien montant de B pendant `ms` : un trou de `ms`, puis la rafale de ce qui a été retenu
      // (TCP : tout arrive d'un coup ensuite, dans l'ordre), environ 2 × ms après le début.
      for (let k = 0; k < times; k++) {
        if (k) bench.run(2000, () => 0, calm);
        up.opts.lagMs = 50 + ms;
        bench.run(ms, () => 0, calm);
        up.opts.lagMs = 50;
      }
    } else if (kind === 'coupure') {
      // Lien montant de B figé pendant `ms` : tout ce qui est envoyé pendant la coupure arrive d'un coup, à la fin.
      up.opts.lagMs = 50 + ms;
      bench.run(1000 / 60, () => 0, calm);
      up.opts.lagMs = 50;
    } else {
      // Le serveur ne tourne plus pendant `ms` (pause, machine chargée) ; le temps perdu n'est pas rattrapé.
      const s = bench.session as unknown as { update(ms: number): number };
      const orig = s.update;
      s.update = () => 0;
      bench.run(ms, () => 0, calm);
      s.update = orig;
    }
    // Observation jusqu'à plus de 3 s après l'arrivée de la rafale (le duel est toujours en cours).
    bench.run(ms + 3100, () => 0, calm);
    const fl = server.filter((e) => e.type === 'duelEnd' && e.why === DUEL_WHY.FLOOD);
    return { flood: fl.length, live: w.duels!.includes(d), ended: `${d.phase} ${JSON.stringify(fl)}` };
  };
  for (const kind of ['réseau', 'serveur'] as const) {
    for (const ms of kind === 'réseau' ? [250, 400, 700, 1000, 2000] : [250, 400, 700, 1000]) {
      const r = stall(ms, kind);
      check(`à-coup ${kind} de ${ms} ms pendant un duel (clients honnêtes à 60 Hz) : pas de forfait FLOOD`, r.flood === 0 && r.live, r.ended);
    }
  }
  // Coupures TCP de 1 à 3 s : la rafale de rattrapage ne fait que combler le trou, jamais de forfait FLOOD.
  for (const ms of [1000, 1500, 2000, 3000]) {
    const r = stall(ms, 'coupure');
    check(`coupure TCP de ${ms} ms pendant un duel (clients honnêtes à 60 Hz), observée 3 s après la rafale : pas de forfait FLOOD`, r.flood === 0 && r.live, r.ended);
  }
  // Deux coupures de 300 ms à 2 s d'intervalle : chacune seule passe, mais la file ne se vide jamais.
  const twice = stall(300, 'réseau', 2);
  check('deux coupures réseau de 300 ms pendant un duel : pas de forfait FLOOD', twice.flood === 0 && twice.live, twice.ended);

  // Coupures TCP de 2 et 3 s (mise en place, garde, dénouement) : la série doit rester jouable et équitable ensuite.
  // A (réaction 20) est plus rapide que B (30). Script « prédit » : relâchement quand le tick prédit atteint sig + r ;
  // script « affiché » (modèle humain) : r images après la première image où le 斬 est affiché (world.tick).
  // Attendus : aucune faute, aucun recalage de la prédiction, et A gagne à sa réaction toutes les manches dont la
  // garde commence après la coupure (l'arriéré de la file stricte est vidé tant que les entrées sont sans effet).
  // `when` : phase de la coupure (après la manche 1) et tick de phase ; `id` : id du duel (durées des gardes).
  const fairAfterCut = (ms: number, when: ['enter' | 'kamae' | 'resolve', number], who: 0 | 1, both: boolean, shown: boolean, id = 0) => {
    const { bench, cs, w, calm, pa, pb, server } = netScene([50, 50], 40 + ms / 100 + who * 3 + (both ? 7 : 0) + (shown ? 11 : 0) + when[1]);
    const [A, B] = cs;
    const want = new Map([[A.pid, 20], [B.pid, 30]]);
    const predicted = releaseAt(bench, cs, want);
    const seenAt = [new Map<string, number>(), new Map<string, number>()];
    const mine = (c: BenchClient) => c.src.world.duels?.find((x) => x.a.pid === c.pid || x.b.pid === c.pid);
    const script = (i: number, frame: number): number => {
      if (!shown) return predicted(i);
      const cd = mine(cs[i]);
      if (!cd || cd.sigTick < 0 || (cd.phase !== 'kamae' && cd.phase !== 'open')) return 0;
      const f = seenAt[i].get(`${cd.id}:${cd.played}`);
      return f !== undefined && frame >= f + 1 + want.get(cs[i].pid)! ? 0 : BTN.IAI;
    };
    const onFrame = (frame: number) => {
      calm();
      cs.forEach((c, i) => {
        const cd = mine(c);
        const key = cd ? `${cd.id}:${cd.played}` : '';
        if (cd && !seenAt[i].has(key) && signalShown(cd, c.src.world.tick)) seenAt[i].set(key, frame);
      });
    };
    w.nextId = Math.max(w.nextId, id);
    const d = startDuel(w, pa, pb, { ...COOP_DUEL_RULES, firstTo: 3 })!;
    // Début de garde de chaque manche (tick serveur), associé aux manches dans l'ordre.
    const guards: number[] = [];
    bench.onServerStep((t) => {
      if (d.phase === 'kamae' && d.t === 0) guards.push(t);
    });
    const at = () => d.played >= 1 && d.phase === when[0] && d.t >= when[1];
    for (let k = 0; k < 3000 && !at() && w.duels!.includes(d); k++) bench.run(1000 / 60, script, onFrame);
    const cutAt = w.tick;
    const snaps0 = cs.map((c) => c.src.predictor.snaps);
    // Vraie coupure (rien ne passe pendant `ms`) : le lien descendant est coupé lui aussi, pas seulement ralenti le temps
    // d'une image (qui ne porte un instantané qu'une fois sur SNAP_EVERY).
    const { up, down } = cs[who].transport;
    const held0 = [up.delayed, down.delayed];
    bench.cut(cs[who], ms, both ? 'both' : 'up');
    for (let k = 0; k < 600 && w.duels!.includes(d); k++) bench.run(100, script, onFrame);
    const held = [up.delayed - held0[0], down.delayed - held0[1]];
    const rounds = server.filter((e): e is Extract<DuelEv, { type: 'duelRound' }> => e.type === 'duelRound');
    const resumed = cutAt + (ms * 60) / 1000 + 30; // la rafale est arrivée (lien à 50 ms)
    const after = rounds.filter((_, k) => guards[k] !== undefined && guards[k] > resumed);
    const ra = (e: Extract<DuelEv, { type: 'duelRound' }>) => (d.a.pid === A.pid ? e.ra : e.rb);
    const fouls = rounds.filter((e) => e.why === DUEL_WHY.FOUL || e.why === DUEL_WHY.DOUBLE_FOUL).length;
    const fair = after.every((e) => e.why === DUEL_WHY.IPPON && e.winner === A.pid && ra(e) >= 20 && ra(e) <= 21);
    const resets = cs.map((c, i) => c.src.predictor.snaps - snaps0[i]);
    const ends = server.filter((e) => e.type === 'duelEnd');
    // La coupure a bien retenu des messages dans chaque sens coupé.
    const bit = held[0] > 0 && (!both || held[1] > 0);
    const safe = bit && fouls === 0 && resets.every((n) => n === 0) && !ends.some((e) => e.type === 'duelEnd' && e.why === DUEL_WHY.FLOOD);
    return {
      ok: safe && after.length > 0 && fair,
      safe,
      down: held[1],
      info: `${after.length}/${rounds.length} manches après la coupure : ${rounds.map((e) => `${e.winner === A.pid ? 'A' : e.winner === B.pid ? 'B' : '-'}:${e.why}(${ra(e)})`).join(' ')} ; recalages ${resets.join('/')} ; fin ${ends.map((e) => e.type === 'duelEnd' && e.why).join(',')} ; retenus ${held.join('/')}`,
    };
  };
  const MOMENTS: ['enter' | 'kamae' | 'resolve', number][] = [['enter', 10], ['kamae', 20], ['resolve', 10]];
  const downHeld: number[] = []; // messages descendants retenus, par cas « 2 sens »
  for (const shown of [false, true]) {
    for (const ms of [2000, 3000]) {
      const bad: string[] = [];
      let n = 0;
      for (const when of MOMENTS) {
        for (const who of [0, 1] as const) {
          for (const both of [false, true]) {
            const r = fairAfterCut(ms, when, who, both, shown);
            n++;
            if (both) downHeld.push(r.down);
            if (!r.ok) bad.push(`${when.join('@')} ${who ? 'B' : 'A'} ${both ? '2 sens' : 'montant'} : ${r.info}`);
          }
        }
      }
      check(`coupure TCP de ${ms} ms (mise en place, garde, dénouement ; A ou B ; montant ou 2 sens), script sur le tick ${shown ? 'affiché' : 'prédit'} : ensuite, le plus rapide gagne à sa réaction, sans faute ni recalage`, bad.length === 0, `${n - bad.length}/${n}${bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''}`);
    }
  }
  check('coupures « 2 sens » : le lien descendant est vraiment coupé (instantanés retenus) dans chaque cas', downHeld.length === 24 && downHeld.every((n) => n > 0), `messages descendants retenus : ${downHeld.join(',')}`);
  // Gardes courtes (duels 105 et 110 : gardes de 93 à 118 ticks après la manche 1) : l'arriéré peut dépasser la garde
  // suivante, dont le 斬 est alors affiché dès qu'il est connu (tick affiché monotone, déjà au-delà). Le vidage est
  // borné pour que le tick prédit l'ait atteint : vu un peu tard au pire, jamais en avance (aucune faute fabriquée).
  {
    const bad: string[] = [];
    let n = 0;
    for (const id of [105, 110]) {
      for (const ms of [2000, 3000]) {
        for (const when of [['enter', 10], ['enter', 40], ['kamae', 60], ['resolve', 10], ['resolve', 40], ['resolve', 100]] as ['enter' | 'kamae' | 'resolve', number][]) {
          for (const who of [0, 1] as const) {
            const r = fairAfterCut(ms, when, who, false, true, id);
            n++;
            if (!r.safe) bad.push(`duel ${id} ${ms} ms ${when.join('@')} ${who ? 'B' : 'A'} : ${r.info}`);
          }
        }
      }
    }
    check('coupures de 2 et 3 s, gardes courtes, modèle humain (tick affiché) : aucune faute ni recalage', bad.length === 0, `${n - bad.length}/${n}${bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''}`);
  }
  // Coupure montante de 5,5 s, gel du serveur de 5 ou 8 s, gels de 3 s + 3 s à 500 ms d'écart, pendant une garde d'au
  // moins 230 ticks (à son tick `at`) : la file stricte dépasse DUEL.QUEUE_MAX à cadence honnête. Pas de forfait FLOOD :
  // la file est ramenée à sa borne sans avancer les entrées de la garde en cours (A, le plus rapide, gagne la manche à sa
  // réaction), puis la série se joue jusqu'au bout, sans faute ni recalage de la prédiction.
  const longStall = (kind: 'coupure' | 'gel' | 'gels', ms: number, at: number) => {
    const { bench, cs, w, calm, pa, pb, server } = netScene([50, 50], 120 + ms / 100 + at);
    const [A, B] = cs;
    let id = w.nextId;
    while (kamaeLength(id, 0) < 230) id++;
    w.nextId = id;
    const d = startDuel(w, pa, pb, { ...COOP_DUEL_RULES, firstTo: 3 })!;
    const script = releaseAt(bench, cs, new Map([[A.pid, 20], [B.pid, 30]]));
    // Files à la réception : pleine (déjà QUEUE_MAX entrées) combien de fois, et la plus longue après l'entrée.
    let full = 0;
    let peak = 0;
    const push = bench.session.pushInput.bind(bench.session);
    bench.session.pushInput = (pid, msg, atMs) => {
      if (bench.session.queueLength(pid) >= DUEL.QUEUE_MAX) full++;
      const ok = push(pid, msg, atMs);
      peak = Math.max(peak, bench.session.queueLength(pid));
      return ok;
    };
    for (let k = 0; k < 2000 && !(d.phase === 'kamae' && d.t >= at); k++) bench.run(1000 / 60, script, calm);
    const snaps0 = cs.map((c) => c.src.predictor.snaps);
    if (kind === 'coupure') bench.cut(B, ms);
    else bench.freezeServer(ms, script, calm);
    if (kind === 'gels') {
      bench.run(500, script, calm);
      bench.freezeServer(ms, script, calm);
    }
    for (let k = 0; k < 900 && w.duels!.includes(d); k++) bench.run(100, script, calm);
    const rounds = server.filter((e): e is Extract<DuelEv, { type: 'duelRound' }> => e.type === 'duelRound');
    const ends = server.filter((e): e is Extract<DuelEv, { type: 'duelEnd' }> => e.type === 'duelEnd');
    const ra = (e: Extract<DuelEv, { type: 'duelRound' }>) => (d.a.pid === A.pid ? e.ra : e.rb);
    const first = rounds[0];
    const fouls = rounds.filter((e) => e.why === DUEL_WHY.FOUL || e.why === DUEL_WHY.DOUBLE_FOUL).length;
    const resets = cs.map((c, i) => c.src.predictor.snaps - snaps0[i]);
    const ok = full > 0 && peak <= DUEL_QUEUE_LIMIT && fouls === 0 && resets.every((r) => r === 0) &&
      !!first && first.why === DUEL_WHY.IPPON && first.winner === A.pid && ra(first) === 20 &&
      rounds.length >= 3 && ends.length === 1 && ends[0].why === DUEL_WHY.WIN && !w.duels!.includes(d);
    const info = `file pleine ${full} fois, au plus ${peak} ; ${rounds.map((e) => `${e.winner === A.pid ? 'A' : e.winner === B.pid ? 'B' : '-'}:${e.why}(${ra(e)})`).join(' ')} ; recalages ${resets.join('/')} ; fin ${ends.map((e) => e.why).join(',')}`;
    return { ok, info };
  };
  for (const [kind, ms, at] of [['coupure', 5500, 10], ['gel', 5000, 10], ['gels', 3000, 10], ['gel', 8000, 10], ['gel', 8000, 100]] as ['coupure' | 'gel' | 'gels', number, number][]) {
    const r = longStall(kind, ms, at);
    const what = kind === 'coupure' ? `coupure montante de ${ms / 1000} s` : kind === 'gel' ? `gel du serveur de ${ms / 1000} s` : `gels du serveur de ${ms / 1000} s + ${ms / 1000} s à 500 ms d'écart`;
    check(`${what} pendant une garde (≥ 230 ticks, à son tick ${at}), clients honnêtes : pas de forfait FLOOD, file bornée, manche en cours jugée à son tick, série jouée jusqu'au bout`, r.ok, r.info);
  }
  // Client accéléré (cadence soutenue de 1,5 × ou 2 × 60 Hz) : toujours en forfait FLOOD, et perdant, file longue comprise
  // (après une coupure montante de 5,5 s : la longueur de la file n'est pas un critère, la cadence l'est).
  for (const hz of [90, 120]) {
    for (const cut of [0, 5500]) {
      const { bench, cs, w, calm, pa, pb, server } = netScene([50, 50], 60 + hz);
      const [, B] = cs;
      startDuel(w, pa, pb, COOP_DUEL_RULES);
      bench.run(1000, () => 0, calm);
      B.sendHz = hz;
      if (cut) bench.cut(B, cut);
      bench.run(8000 + cut, () => 0, calm);
      const fl = server.filter((e) => e.type === 'duelEnd' && e.why === DUEL_WHY.FLOOD);
      check(`client accéléré à ${hz} Hz pendant un duel${cut ? `, coupure montante de ${cut / 1000} s` : ''} : forfait FLOOD, l'adversaire gagne`, fl.length === 1 && fl[0].type === 'duelEnd' && fl[0].winner >= 0 && fl[0].winner !== B.pid, JSON.stringify(fl));
    }
  }
}
{
  // 5e. Coupure du lien montant d'un duelliste qui tient l'iai (TCP : tout arrive d'un coup ensuite). Le serveur garde
  // son dernier masque : aucun relâchement fabriqué, donc ni faute pendant la garde, ni frappe à un instant non choisi.
  const holdThroughCut = (ms: number, when: 'garde' | 'signal') => {
    const { bench, cs, w, calm, pa, pb, server } = netScene([40, 40], 70 + ms);
    const [A, B] = cs;
    const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
    // Réactions voulues (tick prédit − sigTick) : A 20 / B 30 si la coupure tombe pendant la garde, B 90 / A 120 sinon.
    const want = when === 'garde' ? new Map([[A.pid, 20], [B.pid, 30]]) : new Map([[A.pid, 120], [B.pid, 90]]);
    let release = -1; // séquence de l'entrée par laquelle B relâche l'iai
    let consumed = -1; // tick serveur où elle est consommée
    const script = (i: number): number => {
      const c = cs[i];
      const cd = c.src.world.duels?.find((x) => x.a.pid === c.pid || x.b.pid === c.pid);
      if (!cd || cd.sigTick < 0 || (cd.phase !== 'kamae' && cd.phase !== 'open')) return 0;
      if (bench.predictedTick(c) < cd.sigTick + want.get(c.pid)!) return BTN.IAI;
      if (c === B && release < 0) release = B.src.inputSeq + 1; // entrée en cours de construction
      return 0;
    };
    bench.onServerStep((t) => {
      if (release >= 0 && consumed < 0 && bench.session.ackFor(B.pid) >= release) consumed = t;
    });
    const start = () => (when === 'garde' ? d.phase === 'kamae' && d.t >= 20 : d.sigTick >= 0 && w.tick >= d.sigTick + 5 && (d.phase === 'kamae' || d.phase === 'open'));
    for (let k = 0; k < 2000 && !start(); k++) bench.run(1000 / 60, script, calm);
    const sig = d.sigTick;
    const up = B.transport.up as unknown as { opts: { lagMs: number } };
    up.opts.lagMs = 40 + ms;
    bench.run(1000 / 60, script, calm);
    up.opts.lagMs = 40;
    for (let k = 0; k < 100 && !server.some((e) => e.type === 'duelRound'); k++) bench.run(100, script, calm);
    const rd = server.find((e) => e.type === 'duelRound');
    return { rd: rd?.type === 'duelRound' ? rd : undefined, sig, consumed, A, B };
  };
  for (const ms of [550, 700, 1000]) {
    const { rd, A } = holdThroughCut(ms, 'garde');
    check(`coupure de ${ms} ms pendant la garde, iai tenu : pas de faux départ, A (le plus rapide) gagne à sa réaction`, !!rd && rd.why === DUEL_WHY.IPPON && rd.winner === A.pid && rd.ra === 20, JSON.stringify(rd));
  }
  for (const ms of [700, 1000]) {
    const { rd, sig, consumed, B } = holdThroughCut(ms, 'signal');
    check(`coupure de ${ms} ms après le signal, iai tenu : B frappe quand son relâchement est consommé, pas avant`, !!rd && rd.winner === B.pid && consumed >= 0 && sig + rd.rb === consumed, `${JSON.stringify(rd)} ; relâchement consommé à sig + ${consumed - sig}`);
  }

  // Appui sur G (DUEL) pendant la garde, lien montant de B coupé (bench.cut) après `cutAfter` entrées : le masque gardé
  // pendant la coupure ne doit pas allonger l'appui jusqu'à l'abandon (FORFEIT_HOLD), un vrai abandon passe. Seules les
  // entrées reçues comptent : les pas affamés ne s'ajoutent pas aux entrées retardées, comptées à leur arrivée.
  const gThroughCut = (hold: number, cutAfter: number, ms: number) => {
    const { bench, cs, w, calm, pa, pb, server } = netScene([40, 40], 90 + hold + ms);
    const [, B] = cs;
    const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
    for (let k = 0; k < 2000 && !(d.phase === 'kamae' && d.t >= 20); k++) bench.run(1000 / 60, () => 0, calm);
    let sent = 0; // entrées de B avec DUEL
    const script = (i: number): number => (cs[i] === B && sent < hold ? (sent++, BTN.DUEL) : 0);
    for (let k = 0; k < 300 && sent < cutAfter; k++) bench.run(1000 / 60, script, calm);
    if (ms > 0) bench.cut(B, ms);
    bench.run(ms + 2000, script, calm);
    const end = server.find((e) => e.type === 'duelEnd');
    return { end, B, forfeit: end?.type === 'duelEnd' && end.why === DUEL_WHY.FORFEIT && end.winner !== B.pid && end.winner >= 0 };
  };
  for (const [hold, cutAfter] of [[20, 10], [5, 3]]) {
    const { end } = gThroughCut(hold, cutAfter, 1000);
    check(`G tenu ${hold} ticks, coupure d'1 s après ${cutAfter} : pas d'abandon fabriqué`, !end, JSON.stringify(end));
  }
  for (const [hold, cutAfter, ms] of [[70, 10, 1000], [70, 0, 0]]) {
    const { end, forfeit } = gThroughCut(hold, cutAfter, ms);
    check(`G tenu ${hold} ticks${ms ? `, coupure d'1 s après ${cutAfter}` : ''} : abandon (FORFEIT), l'adversaire gagne`, forfeit, JSON.stringify(end));
  }
  {
    // G tenu de 35 à 59 entrées, coupure de 200 ms à 1 s au début, au milieu ou à la fin de l'appui : jamais d'abandon
    // (les pas affamés, jusqu'à 30 avant, s'ajoutaient à l'appui). Tenu 62 ou 70 entrées : abandon, coupure comprise.
    const bad: string[] = [];
    const lost: string[] = [];
    let n = 0;
    let m = 0;
    for (const hold of [35, 40, 45, 50, 55, 59, 62, 70]) {
      for (const ms of [200, 400, 600, 1000]) {
        for (const cutAfter of [2, Math.round(hold / 2), hold - 3]) {
          const { end, forfeit } = gThroughCut(hold, cutAfter, ms);
          const tag = `G ${hold}, ${ms} ms après ${cutAfter} : ${JSON.stringify(end)}`;
          if (hold < DUEL.FORFEIT_HOLD) {
            n++;
            if (end) bad.push(tag);
          } else {
            m++;
            if (!forfeit) lost.push(tag);
          }
        }
      }
    }
    check('G tenu 35 à 59 ticks, coupure de 200 ms à 1 s n\'importe où dans l\'appui : pas d\'abandon fabriqué', bad.length === 0, `${n - bad.length}/${n}${bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''}`);
    check('G tenu 62 ou 70 ticks, coupure de 200 ms à 1 s n\'importe où dans l\'appui : abandon (FORFEIT), l\'adversaire gagne', lost.length === 0, `${m - lost.length}/${m}${lost.length ? ' — ' + lost.slice(0, 3).join(' | ') : ''}`);
    // Sans coupure, inchangé : FORFEIT_HOLD entrées tenues.
    const g59 = gThroughCut(59, 0, 0);
    const g62 = gThroughCut(62, 0, 0);
    check('G tenu 59 ticks sans coupure : pas d\'abandon ; 62 ticks : abandon', !g59.end && g62.forfeit, `${JSON.stringify(g59.end)} / ${JSON.stringify(g62.end)}`);
  }
  {
    // G tenu depuis le défi (B défie A, qui accepte), toujours tenu pendant le duel, coupure d'1 s : l'appui commencé
    // avant le duel ne compte pas, et le masque répété pendant la famine garde DUEL (sinon la reprise serait un nouvel
    // appui, compté jusqu'à l'abandon).
    const { bench, cs, w, calm, pb, server } = netScene([40, 40], 98);
    const [, B] = cs;
    pb.facing = -1; // B regarde A
    let accepted = false;
    const script = (i: number): number => {
      if (cs[i] === B) return BTN.DUEL;
      if (!accepted && w.duelInvites?.some((x) => x.from === B.pid && !x.cd)) return (accepted = true), BTN.DUEL;
      return 0;
    };
    for (let k = 0; k < 300 && !w.duels!.length; k++) bench.run(1000 / 60, script, calm);
    const d = w.duels![0];
    bench.run(500, script, calm);
    bench.cut(B, 1000);
    bench.run(5000, script, calm);
    const end = server.find((e) => e.type === 'duelEnd');
    check('G tenu depuis le défi, coupure d\'1 s pendant le duel : pas d\'abandon fabriqué', !!d && (d.a.pid === B.pid || d.b.pid === B.pid) && w.duels!.includes(d) && !end, `${d ? `duel ${d.id} ${d.phase}` : 'pas de duel'} ; ${JSON.stringify(end)}`);
  }
  {
    // ATTACK tenu depuis la mise en place (sans effet), coupure d'1 s pendant la garde : le masque gardé ne le relâche
    // pas, sinon l'appui encore tenu à la reprise serait un nouvel appui, donc une attaque (une faute) fabriquée.
    const { bench, cs, w, calm, pa, pb, server } = netScene([40, 40], 97);
    const [A, B] = cs;
    const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
    const script = (i: number): number => {
      if (cs[i] === B) return BTN.ATTACK;
      const cd = A.src.world.duels?.find((x) => x.id === d.id);
      return cd && cd.sigTick >= 0 && (cd.phase === 'kamae' || cd.phase === 'open') && bench.predictedTick(A) < cd.sigTick + 20 ? BTN.IAI : 0;
    };
    for (let k = 0; k < 2000 && !(d.phase === 'kamae' && d.t >= 20); k++) bench.run(1000 / 60, script, calm);
    const up = B.transport.up as unknown as { opts: { lagMs: number } };
    up.opts.lagMs = 40 + 1000;
    bench.run(1000 / 60, script, calm);
    up.opts.lagMs = 40;
    for (let k = 0; k < 100 && !server.some((e) => e.type === 'duelRound'); k++) bench.run(100, script, calm);
    const rd = server.find((e) => e.type === 'duelRound');
    check('ATTACK tenu à travers une coupure d\'1 s pendant la garde : ni attaque ni faute fabriquée, A gagne à sa réaction', rd?.type === 'duelRound' && rd.why === DUEL_WHY.IPPON && rd.winner === A.pid && (rd.winner === d.a.pid ? rd.ra : rd.rb) === 20, JSON.stringify(rd));
  }
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests d’équité des duels passent.');
