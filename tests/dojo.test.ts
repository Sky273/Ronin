// Tests du dojo (M5) : niveau, tournoi à élimination directe, forfaits, bots, départage, sans réseau.
// Lancer : npm run test:dojo
import { DOJO, DUEL, DUEL_WHY, TILE } from '../shared/constants';
import { botProfile, botRelease, BOT_NEVER_SUSPECT } from '../shared/dojoBot';
import { buildDojo, DOJO_STAGE, DOJO_TATAMIS, dojoSpot } from '../shared/dojoLevel';
import { duelOf, seriesOutcome } from '../shared/duel';
import { BTN } from '../shared/input';
import { fitsAt } from '../shared/physics';
import { buildStage } from '../shared/stagebuild';
import type { Duel, GameEvent, World } from '../shared/types';
import { addPlayer, createWorld, removePlayer, setBarrier, stepWorld } from '../shared/world';
import { findGround } from '../shared/enemy';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

type Ev<K extends GameEvent['type']> = Extract<GameEvent, { type: K }>;

/** Joueur scripté : tient l'iai pendant la garde et le relâche `react` ticks après le signal. */
function iaiAt(w: World, pid: number, react: number): number {
  const d = duelOf(w, pid);
  if (!d || (d.phase !== 'kamae' && d.phase !== 'open') || d.sigTick < 0) return 0;
  return w.tick < d.sigTick + react ? BTN.IAI : 0;
}

/** Fait tourner le dojo ; `script(pid)` donne les boutons des humains. Renvoie tous les événements. */
function run(w: World, ticks: number, script: (pid: number) => number, stop?: (ev: GameEvent[]) => boolean): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const inputs = new Map<number, number>();
    for (const p of w.players) if (!w.tournament!.entrants.some((e) => e.pid === p.id && e.bot)) inputs.set(p.id, script(p.id));
    stepWorld(w, inputs);
    all.push(...w.events);
    w.events.length = 0;
    if (stop && stop(all)) break;
  }
  return all;
}
const champion = (evs: GameEvent[]) => evs.some((e) => e.type === 'dojoChampion');
const results = (evs: GameEvent[]) => evs.filter((e): e is Ev<'dojoResult'> => e.type === 'dojoResult');

// ─── 1. Niveau ──────────────────────────────────────────────────────────────
{
  const L = buildDojo();
  const floor = L.spawn.y;
  let flat = true;
  for (const [round, n] of [[0, 4], [1, 2], [2, 1]] as const) {
    for (let k = 0; k < n; k++) {
      const s = dojoSpot(round, k);
      for (const x of [s.x - DUEL.GAP / 2, s.x + DUEL.GAP / 2]) {
        if (findGround(L, x, floor, 1) !== floor || !fitsAt(L, x, floor, 22, 46)) flat = false;
      }
    }
  }
  check('dojo : plancher plat et corps libres sur chaque marque de chaque tatami', flat);
  check('dojo : 4 tatamis espacés d\'au moins deux demi-duels', DOJO_TATAMIS.every((x, i) => i === 0 || x - DOJO_TATAMIS[i - 1] > DUEL.GAP + 2 * TILE));
  const w = createWorld(5, { mode: 'dojo' });
  const before = w.level.tiles.slice();
  setBarrier(w, false);
  setBarrier(w, true);
  setBarrier(w, false);
  check('dojo : setBarrier (appelé à chaque instantané) laisse le niveau intact', before.every((v, i) => v === w.level.tiles[i]));
  check('dojo : buildStage(DOJO_STAGE) redonne le dojo', buildStage(DOJO_STAGE, 1).w === L.w && w.level.stage === DOJO_STAGE && w.level.biome === 'dojo');
  check('dojo : ni ennemis ni sanctuaires en plus du point d\'arrivée', w.enemies.length === 0 && w.level.checkpoints.length === 1);
  const solo = createWorld(5);
  const coop = createWorld(5, { mode: 'coop' });
  check('solo et coop : aucune clé tournament', !('tournament' in solo) && !('tournament' in coop));
}

// ─── 2. Tournoi complet : un humain rapide contre 7 bots ─────────────────────
{
  const w = createWorld(11, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc', { color: 0 });
  const evs = run(w, 60 * 60 * 6, (pid) => (pid === me.id ? iaiAt(w, pid, 11) : 0), champion);
  const t = w.tournament!;
  const start = evs.find((e) => e.type === 'dojoStart');
  check('un humain seul : le tournoi part au bout de l\'attente, 7 bots complètent les places', !!start && t.entrants.length === 8 && t.entrants.filter((e) => e.bot).length === 7);
  const res = results(evs);
  check('7 matchs joués, chacun avec un vainqueur', res.length === 7 && res.every((r) => r.winner >= 0), `${res.length} résultats`);
  const quarters = t.matches.slice(0, 4).flatMap((m) => [m.a, m.b]);
  check('chaque participant joue une fois en quart', new Set(quarters).size === 8 && t.entrants.every((e) => quarters.includes(e.pid)));
  const adv = t.matches[4].a === t.matches[0].winner && t.matches[4].b === t.matches[1].winner && t.matches[5].a === t.matches[2].winner &&
    t.matches[5].b === t.matches[3].winner && t.matches[6].a === t.matches[4].winner && t.matches[6].b === t.matches[5].winner;
  check('les vainqueurs passent au bon match', adv);
  check('champion = vainqueur de la finale', t.phase === 'done' && t.champion === t.matches[6].winner);
  check('un humain qui réagit en 11 ticks (183 ms) bat les bots : champion', t.champion === me.id, `champion ${t.entrants.find((e) => e.pid === t.champion)?.name}`);
  check('aucun nul au dojo', res.every((r) => r.why !== DUEL_WHY.DRAW));
  const matchEvs = evs.filter((e): e is Ev<'dojoMatch'> => e.type === 'dojoMatch');
  check('matchs d\'un même tour lancés ensemble (quarts au même tick)', matchEvs.length === 7);
  const ticks = w.tick;
  check('durée d\'un tournoi bornée (moins de 4 min de jeu)', ticks < 4 * 60 * 60, `${(ticks / 60).toFixed(0)} s`);
  // Remise à zéro : les bots partent, le présent attend le tournoi suivant.
  const after = run(w, DOJO.CHAMPION_TICKS + 5, () => 0);
  check('après le champion : retour en attente, bots retirés, tournoi n° 2', w.tournament!.phase === 'waiting' && w.tournament!.n === 2 &&
    w.players.length === 1 && after.some((e) => e.type === 'dojoReset'));
  check('l\'humain est participant du tournoi suivant', w.tournament!.entrants.length === 1 && w.tournament!.entrants[0].pid === me.id);
}

// ─── 3. Déterminisme ────────────────────────────────────────────────────────
{
  const once = (seed: number) => {
    const w = createWorld(seed, { mode: 'dojo' });
    const me = addPlayer(w, 'Luc');
    run(w, 60 * 60 * 6, (pid) => (pid === me.id ? iaiAt(w, pid, 16) : 0), champion);
    return JSON.stringify(w.tournament);
  };
  check('même graine : même tournoi au bit près', once(21) === once(21));
  check('graines différentes : tableaux différents', once(21) !== once(22));
}

// ─── 4. Départs : salle pleine, tous prêts ──────────────────────────────────
{
  const w = createWorld(3, { mode: 'dojo' });
  const ps = Array.from({ length: 8 }, (_, i) => addPlayer(w, `P${i}`, { color: i }));
  const evs = run(w, DOJO.FULL_DELAY + 30, () => 0, (e) => e.some((x) => x.type === 'dojoStart'));
  check('salle pleine : départ après FULL_DELAY, sans bot', evs.some((e) => e.type === 'dojoStart') && w.tick <= DOJO.FULL_DELAY + 2 &&
    w.tournament!.entrants.every((e) => !e.bot) && ps.every((p) => w.tournament!.entrants.some((e) => e.pid === p.id)));
}
{
  const w = createWorld(4, { mode: 'dojo' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  let k = 0;
  const evs = run(w, DOJO.WAIT_TICKS, (pid) => (++k > 20 && k < 40 && (pid === a.id || pid === b.id) ? BTN.DUEL : 0), (e) => e.some((x) => x.type === 'dojoStart'));
  check('tous les présents prêts (G) : départ anticipé, bien avant l\'attente', evs.some((e) => e.type === 'dojoStart') && w.tick < 300, `départ au tick ${w.tick}`);
}
{
  const w = createWorld(4, { mode: 'dojo' });
  addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  run(w, 200, (pid) => (pid === b.id ? BTN.DUEL : 0));
  check('un seul prêt sur deux : pas de départ anticipé', w.tournament!.phase === 'waiting');
}

// ─── 5. Forfaits ────────────────────────────────────────────────────────────
/** Tournoi lancé avec un humain (tableau tiré), jusqu'au début de son premier match. */
function untilMyMatch(seed: number, script: (w: World, me: number) => (pid: number) => number) {
  const w = createWorld(seed, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc');
  const evs = run(w, DOJO.WAIT_TICKS + DOJO.ROUND_PAUSE + 10, script(w, me.id), (e) => e.some((x) => x.type === 'dojoMatch' && (x.a === me.id || x.b === me.id)));
  return { w, me: me.id, evs };
}
{
  const { w, me } = untilMyMatch(30, () => () => 0);
  run(w, 200, () => 0);
  removePlayer(w, me);
  const evs = run(w, 400, () => 0);
  const r = results(evs).find((x) => w.tournament!.matches[x.match].a === me || w.tournament!.matches[x.match].b === me);
  check('départ en plein match : forfait (DISCONNECT), l\'adversaire passe', !!r && r.why === DUEL_WHY.DISCONNECT && r.winner !== me, JSON.stringify(r));
  check('le parti reste au tableau (gone)', w.tournament!.entrants.find((e) => e.pid === me)?.gone === true);
}
{
  const w = createWorld(31, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc');
  run(w, DOJO.WAIT_TICKS + 5, () => 0, (e) => e.some((x) => x.type === 'dojoStart'));
  removePlayer(w, me.id); // parti pendant la pause, avant son match
  const evs = run(w, DOJO.ROUND_PAUSE + 5, () => 0);
  const k = w.tournament!.matches.findIndex((m) => m.a === me.id || m.b === me.id);
  const r = results(evs).find((x) => x.match === k);
  check('parti avant son match : forfait sans duel', !!r && r.why === DUEL_WHY.DISCONNECT && !w.duels!.some((d) => d.a.pid === me.id || d.b.pid === me.id));
}
{
  const w = createWorld(32, { mode: 'dojo' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  run(w, DOJO.WAIT_TICKS + 5, () => 0, (e) => e.some((x) => x.type === 'dojoStart'));
  // Les deux humains face à face ? Sinon on force le tableau : A et B en quart 0.
  const t = w.tournament!;
  const m0 = t.matches[0];
  const others = t.entrants.filter((e) => e.pid !== a.id && e.pid !== b.id).map((e) => e.pid);
  m0.a = a.id;
  m0.b = b.id;
  [t.matches[1], t.matches[2], t.matches[3]].forEach((m, i) => {
    m.a = others[2 * i];
    m.b = others[2 * i + 1];
  });
  removePlayer(w, a.id);
  removePlayer(w, b.id);
  const evs = run(w, DOJO.ROUND_PAUSE + 5, () => 0);
  const r = results(evs).find((x) => x.match === 0);
  check('les deux partis avant leur match : tirage au sort (抽選), un vainqueur', !!r && r.why === DUEL_WHY.LOT && (r.winner === a.id || r.winner === b.id));
}
{
  const { w, me } = untilMyMatch(33, () => () => 0);
  const evs = run(w, 600, (pid) => (pid === me ? BTN.DUEL : 0));
  const r = results(evs).find((x) => x.winner !== me && (w.tournament!.matches[x.match].a === me || w.tournament!.matches[x.match].b === me));
  check('G tenu en match : abandon (FORFEIT)', !!r && r.why === DUEL_WHY.FORFEIT, JSON.stringify(r));
}
{
  // Deux humains inactifs face à face (contre un bot, l'inactif perd simplement la série) : forfait ABSENT
  // au bout de DOJO.ABSENT_TICKS, au lieu de manches rejouées sans fin.
  const w = createWorld(34, { mode: 'dojo' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  run(w, DOJO.WAIT_TICKS + 5, () => 0, (e) => e.some((x) => x.type === 'dojoStart'));
  const t = w.tournament!;
  const others = t.entrants.filter((e) => e.pid !== a.id && e.pid !== b.id).map((e) => e.pid);
  [t.matches[0].a, t.matches[0].b] = [a.id, b.id];
  [t.matches[1], t.matches[2], t.matches[3]].forEach((m, i) => {
    m.a = others[2 * i];
    m.b = others[2 * i + 1];
  });
  const evs = run(w, DOJO.ROUND_PAUSE + DOJO.ABSENT_TICKS + 120, () => 0, (e) => results(e).some((x) => x.match === 0));
  const r = results(evs).find((x) => x.match === 0);
  check('deux humains sans aucun bouton pendant leur match : forfait (ABSENT), un vainqueur', !!r && r.why === DUEL_WHY.ABSENT && (r.winner === a.id || r.winner === b.id), JSON.stringify(r));
}
{
  // Joueur actif (iai à chaque manche) : jamais absent.
  const w = createWorld(35, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc');
  const evs = run(w, 60 * 60 * 6, (pid) => (pid === me.id ? iaiAt(w, pid, 30) : 0), champion);
  check('joueur actif : jamais en forfait ABSENT', !results(evs).some((r) => r.why === DUEL_WHY.ABSENT));
}

// ─── 6. Réactions suspectes : disqualifié ───────────────────────────────────
{
  const w = createWorld(41, { mode: 'dojo' });
  const me = addPlayer(w, 'Cheat');
  // 9 ticks (150 ms) : juste au-dessus du seuil de faute, sous SUSPECT_REACT.
  const evs = run(w, 60 * 60 * 6, (pid) => (pid === me.id ? iaiAt(w, pid, DUEL.ANTICIPATE) : 0), champion);
  const dq = results(evs).find((r) => r.why === DUEL_WHY.SUSPECT);
  check(`réactions de ${DUEL.ANTICIPATE} ticks répétées (${DOJO.SUSPECT_LIMIT} fois) : disqualifié (反則), jamais champion`, !!dq && dq.winner !== me.id && w.tournament!.champion !== me.id, JSON.stringify(dq));
}

{
  // 10 ticks (167 ms) : suspect au dojo aussi (DOJO.SUSPECT_REACT), alors que DUEL.SUSPECT_REACT ne ferait que journaliser.
  const w = createWorld(42, { mode: 'dojo' });
  const me = addPlayer(w, 'Cheat');
  const evs = run(w, 60 * 60 * 6, (pid) => (pid === me.id ? iaiAt(w, pid, DOJO.SUSPECT_REACT - 1) : 0), champion);
  check(`réactions de ${DOJO.SUSPECT_REACT - 1} ticks répétées : disqualifié aussi`, results(evs).some((r) => r.why === DUEL_WHY.SUSPECT) && w.tournament!.champion !== me.id);
  // Disqualifié sur la manche qui lui donne la série : l'issue du duel elle-même est la disqualification.
  const ends = evs.filter((e): e is Ev<'duelEnd'> => e.type === 'duelEnd' && e.why === DUEL_WHY.SUSPECT);
  check('disqualification : l\'issue du duel (duelEnd) le donne perdant, même sur une série décidée', ends.length > 0 && ends.every((e) => e.winner !== me.id));
}
{
  // Huit tricheurs : un disqualifié ne passe jamais au tour suivant (son prochain match est un forfait).
  const w = createWorld(43, { mode: 'dojo' });
  const ps = Array.from({ length: 8 }, (_, i) => addPlayer(w, `C${i}`, { color: i }));
  const ids = new Set(ps.map((p) => p.id));
  const evs = run(w, 60 * 60 * 8, (pid) => (ids.has(pid) ? iaiAt(w, pid, DUEL.ANTICIPATE) : 0), champion);
  const t = w.tournament!;
  const dqByRound = t.matches.filter((m) => m.round > 0 && m.state === 'done' && m.why !== DUEL_WHY.SUSPECT && m.why !== DUEL_WHY.LOT);
  check('tous disqualifiés : le tournoi se termine quand même, sans aucun match joué au-delà d\'une disqualification', champion(evs) && dqByRound.length === 0,
    t.matches.map((m) => `${m.round}:${m.why}`).join(' '));
}

// ─── 6 bis. Sel secret : bots et tirage imprévisibles pour le client ─────────
{
  const bracket = (salt: [number, number]) => {
    const w = createWorld(50, { mode: 'dojo', salt });
    addPlayer(w, 'Luc');
    run(w, DOJO.WAIT_TICKS + 5, () => 0, (e) => e.some((x) => x.type === 'dojoStart'));
    return w.tournament!.entrants.map((e) => e.name).join(',');
  };
  check('même graine, sels différents : tableaux (et bots) différents', bracket([1, 2]) !== bracket([3, 4]));
  check('même sel : même tableau', bracket([7, 8]) === bracket([7, 8]));
  check('les relâchements des bots dépendent du sel, pas seulement de la graine', botRelease([1, 2], 5, 9, 0, 1000) !== botRelease([3, 4], 5, 9, 0, 1000) ||
    botRelease([1, 2], 6, 9, 0, 1000) !== botRelease([3, 4], 6, 9, 0, 1000));
  const w = createWorld(50, { mode: 'dojo', salt: [11, 12] });
  check('le sel n\'est pas dans le monde transmis (JSON du tournoi)', !JSON.stringify(w).includes('"salt"') && !JSON.stringify(w.tournament).includes('11,12'));
}

// ─── 7. Départage : jamais de nul ───────────────────────────────────────────
{
  const d = {
    id: 77, a: { pid: 1, wins: 2, strikeT: -1, parryT: -1, foul: false, react: -1 }, b: { pid: 2, wins: 2, strikeT: -1, parryT: -1, foul: false, react: -1 },
    x: 0, y: 0, gap: 240, phase: 'resolve', t: 0, round: 5, played: DUEL.SUDDEN_MAX, sigTick: 0, stage: DOJO_STAGE, last: -1, winner: -1,
    firstTo: 3, maxRounds: 5, draw: false,
  } as Duel;
  const lot = seriesOutcome(d, [100, 100]);
  check('sommes des réactions égales après la mort subite : tirage au sort, un vainqueur', !!lot && lot.why === DUEL_WHY.LOT && (lot.winner === 1 || lot.winner === 2));
  const sums = seriesOutcome(d, [90, 100]);
  check('sommes différentes : la plus petite gagne', !!sums && sums.why === DUEL_WHY.WIN && sums.winner === 1);
  d.draw = true;
  check('coop (draw) : toujours un nul possible', seriesOutcome(d, [100, 100])?.why === DUEL_WHY.DRAW);
}

// ─── 8. Bots ────────────────────────────────────────────────────────────────
{
  check('les bots ne sont jamais suspects (BOT_REACT_MIN > SUSPECT_REACT)', BOT_NEVER_SUSPECT);
  let fouls = 0;
  let n = 0;
  let minReact = Infinity;
  const means: number[] = [];
  for (let pid = 1; pid <= 40; pid++) {
    let sum = 0;
    let k = 0;
    for (let duel = 1; duel <= 60; duel++) {
      const sig = 1000;
      const r = botRelease([9, 9], pid, duel, duel % 5, sig) - sig;
      n++;
      if (r < 0) fouls++;
      else {
        minReact = Math.min(minReact, r);
        sum += r;
        k++;
      }
    }
    means.push(sum / k);
  }
  check('réaction des bots ≥ BOT_REACT_MIN hors faux départs', minReact >= DOJO.BOT_REACT_MIN, `min ${minReact}`);
  check('faux départs des bots : 1 à 10 % des manches', fouls / n > 0.01 && fouls / n < 0.1, `${((100 * fouls) / n).toFixed(1)} %`);
  check('profils variés (réaction moyenne de 15 à 26 ticks, au moins 6 ticks d\'écart)', Math.min(...means) >= 14.5 && Math.max(...means) <= 26 && Math.max(...means) - Math.min(...means) >= 6,
    `${Math.min(...means).toFixed(1)} à ${Math.max(...means).toFixed(1)}`);
  const p1 = botProfile([9, 9], 1);
  const p2 = botProfile([9, 9], 2);
  check('deux bots ont des profils distincts', p1.react !== p2.react);
}

// ─── 9. Double disqualification : un disqualifié ne rejoue plus et n'est jamais champion ───
{
  // Tournoi n° 2 : lotOf ne dépend que du numéro du tournoi et du match (au n° 2 : le pire cas pour ce scénario).
  const w = createWorld(62, { mode: 'dojo' });
  const [a, b, c, d, e] = ['CheatA', 'CheatB', 'C', 'D', 'E'].map((n) => addPlayer(w, n).id);
  const t = w.tournament!;
  run(w, 60 * 60 * 10, (pid) => iaiAt(w, pid, 20), () => t.n === 2 && t.phase === 'pause');
  const bots = t.entrants.filter((x) => x.bot).map((x) => x.pid);
  [[c, bots[0]], [a, b], [d, bots[1]], [e, bots[2]]].forEach(([x, y], k) => {
    t.matches[k].a = x;
    t.matches[k].b = y;
  });
  let left = false;
  const evs = run(w, 60 * 60 * 8, (pid) => iaiAt(w, pid, pid === a || pid === b ? DUEL.ANTICIPATE : 11), (ev) => {
    if (!left && t.phase === 'pause' && t.round === 1) {
      left = true;
      for (const p of [c, d, e]) removePlayer(w, p);
    }
    return ev.some((x) => x.type === 'dojoChampion');
  });
  const q1 = results(evs).find((r) => r.match === 1);
  const cheat = (pid: number) => pid === a || pid === b;
  check('double disqualification : quart 1 perdu par SUSPECT', !!q1 && q1.why === DUEL_WHY.SUSPECT, JSON.stringify(q1));
  check('un disqualifié ne dispute plus aucun match (aucun duel lancé)', !evs.some((x) => x.type === 'dojoMatch' && x.match >= 4 && (cheat(x.a) || cheat(x.b))));
  check('un disqualifié ne passe aucun tour suivant, même face à un parti', !results(evs).some((r) => r.match >= 4 && cheat(r.winner)), JSON.stringify(results(evs).filter((r) => r.match >= 4)));
  check("un disqualifié n'est jamais champion", t.phase === 'done' && !cheat(t.champion), `champion ${t.champion}`);
}

// ─── 10. Départ anticipé annulé quand sa condition tombe ────────────────────
{
  const w = createWorld(70, { mode: 'dojo' });
  const a = addPlayer(w, 'A');
  let press = true;
  run(w, 30, (pid) => (press && pid === a.id ? BTN.DUEL : 0));
  press = false;
  const quick = w.tournament!.startAt;
  check('seul présent prêt : départ anticipé prévu', quick > 0 && quick <= w.tick + DOJO.FULL_DELAY);
  addPlayer(w, 'B'); // arrivant non prêt
  run(w, 5, () => 0);
  check('un arrivant non prêt : départ anticipé annulé (retour à la fin de l\'attente)', w.tournament!.startAt > quick && w.tournament!.phase === 'waiting', `${quick} → ${w.tournament!.startAt}`);
}
{
  const w = createWorld(71, { mode: 'dojo' });
  const ps = Array.from({ length: 8 }, (_, i) => addPlayer(w, `P${i}`, { color: i }));
  run(w, 10, () => 0);
  const quick = w.tournament!.startAt;
  removePlayer(w, ps[7].id);
  run(w, DOJO.FULL_DELAY + 10, () => 0);
  check('salle pleine puis un départ : départ anticipé annulé', w.tournament!.phase === 'waiting' && w.tournament!.startAt > quick, `${quick} → ${w.tournament!.startAt}`);
}

// ─── 11. Force des bots : un humain ordinaire a ses chances ──────────────────
{
  /** Part des tournois gagnés et des matchs gagnés par un humain qui réagit en `react` ticks, contre 7 bots. */
  const rate = (react: number, seeds: number) => {
    let titles = 0;
    let won = 0;
    let played = 0;
    for (let s = 0; s < seeds; s++) {
      const w = createWorld(900 + s, { mode: 'dojo' });
      const me = addPlayer(w, 'Luc');
      const evs = run(w, 60 * 60 * 6, (pid) => (pid === me.id ? iaiAt(w, pid, react) : 0), champion);
      for (const r of results(evs)) {
        const m = w.tournament!.matches[r.match];
        if (m.a !== me.id && m.b !== me.id) continue;
        played++;
        if (r.winner === me.id) won++;
      }
      if (w.tournament!.champion === me.id) titles++;
    }
    return { titles: titles / seeds, matches: won / played };
  };
  const fast = rate(15, 20);
  const avg = rate(19, 20);
  check('humain à 250 ms (15 ticks) : champion le plus souvent', fast.titles >= 0.5, `${Math.round(100 * fast.titles)} % des tournois`);
  check('humain à 317 ms (19 ticks) : à peu près un match sur deux gagné contre les bots', avg.matches > 0.3 && avg.matches < 0.7, `${Math.round(100 * avg.matches)} % des matchs`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du dojo passent.');
