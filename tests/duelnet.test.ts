// Tests d'équité des duels sur le banc réseau (latences, gigue, parade, avance du signal).
// Lancer : npm run test:duelnet
// Principe : chaque client scripté tient l'iai pendant la garde et le relâche quand son tick prédit
// atteint sigTick + r. Le serveur doit mesurer exactement r, quelle que soit la latence, et le plus
// rapide doit gagner.
import { BTN } from '../shared/input';
import { Rng } from '../shared/math';
import { COOP_DUEL_RULES, duelOf, signalShown, startDuel } from '../shared/duel';
import { DUEL, DUEL_WHY } from '../shared/constants';
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
  const stall = (ms: number, kind: 'réseau' | 'serveur', times = 1): { flood: number; ended: string } => {
    const { bench, cs, w, calm, pa, pb, server } = netScene([50, 50], 30 + ms + times);
    const [, B] = cs;
    const d = startDuel(w, pa, pb, COOP_DUEL_RULES)!;
    bench.run(1000, () => 0, calm);
    if (kind === 'réseau') {
      // Retard ponctuel du lien montant de B (TCP : tout arrive d'un coup ensuite, dans l'ordre).
      const up = B.transport.up as unknown as { opts: { lagMs: number } };
      for (let k = 0; k < times; k++) {
        if (k) bench.run(2000, () => 0, calm);
        up.opts.lagMs = 50 + ms;
        bench.run(ms, () => 0, calm);
        up.opts.lagMs = 50;
      }
    } else {
      // Le serveur ne tourne plus pendant `ms` (pause, machine chargée) ; le temps perdu n'est pas rattrapé.
      const s = bench.session as unknown as { update(ms: number): number };
      const orig = s.update;
      s.update = () => 0;
      bench.run(ms, () => 0, calm);
      s.update = orig;
    }
    bench.run(1500, () => 0, calm);
    const fl = server.filter((e) => e.type === 'duelEnd' && e.why === DUEL_WHY.FLOOD);
    return { flood: fl.length, ended: `${d.phase} ${JSON.stringify(fl)}` };
  };
  for (const kind of ['réseau', 'serveur'] as const) {
    for (const ms of [250, 400, 700, 1000]) {
      const r = stall(ms, kind);
      check(`à-coup ${kind} de ${ms} ms pendant un duel (clients honnêtes à 60 Hz) : pas de forfait FLOOD`, r.flood === 0, r.ended);
    }
  }
  // Deux coupures de 300 ms à 2 s d'intervalle : chacune seule passe, mais la file ne se vide jamais.
  const twice = stall(300, 'réseau', 2);
  check('deux coupures réseau de 300 ms pendant un duel : pas de forfait FLOOD', twice.flood === 0, twice.ended);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests d’équité des duels passent.');
