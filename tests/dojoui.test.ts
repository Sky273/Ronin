// Tests de l'interface du dojo (tableau du tournoi, lignes d'état, libellés) : modèle pur, sans Phaser,
// et surcouche du tableau sur une fausse scène (bracket.ts n'utilise Phaser que pour ses types).
// Lancer : npm run test:dojoui
import type Phaser from 'phaser';
import { DOJO, DUEL, DUEL_WHY } from '../shared/constants';
import { duelOf } from '../shared/duel';
import { BTN } from '../shared/input';
import type { DojoEntrant, DojoMatch, Duel, GameEvent, Tournament, World } from '../shared/types';
import { addPlayer, createWorld, stepWorld } from '../shared/world';
import { BracketOverlay } from '../client/ui/bracket';
import {
  autoOpen, BOT_MARK, BracketToggle, bracketView, dojoHudLine, entrantName, outcomeNote, resultBanner, resultToast, roundName, waitingLine,
} from '../client/ui/bracketView';
import { boutView, endToast, isDojoBot, seriesText, whyLabel } from '../client/ui/duelView';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Une partie qui lève compte comme un échec, sans empêcher les suivantes de tourner. */
function section(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    check(`${name} : exception`, false, (e as Error).stack ?? (e as Error).message);
  }
}

type Ev<K extends GameEvent['type']> = Extract<GameEvent, { type: K }>;

/** Joueur scripté : tient l'iai pendant la garde et le relâche `react` ticks après le signal. */
function iaiAt(w: World, pid: number, react: number): number {
  const d = duelOf(w, pid);
  if (!d || (d.phase !== 'kamae' && d.phase !== 'open') || d.sigTick < 0) return 0;
  return w.tick < d.sigTick + react ? BTN.IAI : 0;
}

/** Fait tourner le dojo ; `script(pid)` donne les boutons des humains ; arrêt quand `stop` est vrai. */
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
const has = (type: GameEvent['type']) => (evs: GameEvent[]) => evs.some((e) => e.type === type);

/** Tournoi construit à la main : 8 participants (les pids 1 à 8, bots à partir de `botsFrom`), 7 matchs. */
function handTournament(botsFrom = 3): Tournament {
  const names = ['Luc', 'Aiko', 'Musashi', 'Tomoe', 'Kojirō', 'Jūbei', 'Hanzō', 'Kenshin'];
  const entrants: DojoEntrant[] = names.map((name, i) => ({ pid: i + 1, name, color: i, bot: i + 1 >= botsFrom, gone: false, ready: false }));
  const m = (round: number, a = -1, b = -1): DojoMatch => ({ round, a, b, state: 'pending', winner: -1, why: -1, wa: 0, wb: 0, duel: -1 });
  return {
    n: 3, phase: 'pause', t: 0, startAt: -1, round: 0, entrants,
    matches: [m(0, 1, 2), m(0, 3, 4), m(0, 5, 6), m(0, 7, 8), m(1), m(1), m(2)],
    champion: -1,
  };
}
/** Monde du dojo portant ce tournoi (joueurs présents pour chaque participant non parti). */
function worldWith(t: Tournament): World {
  const w = createWorld(1, { mode: 'dojo' });
  for (const e of t.entrants) if (!e.gone) addPlayer(w, e.name, { color: e.color });
  w.tournament = t;
  return w;
}
const done = (m: DojoMatch, winner: number, why: number, wa: number, wb: number): void => {
  Object.assign(m, { state: 'done', winner, why, wa, wb, duel: -1 });
};

// ─── 1. Libellés des issues du dojo ─────────────────────────────────────────
section('libellés', () => {
  check('libellés des issues du dojo (ABSENT, LOT, SUSPECT)', [DUEL_WHY.ABSENT, DUEL_WHY.LOT, DUEL_WHY.SUSPECT].every((c) => whyLabel(c).kanji !== ''));
  check('whyLabel : 不在 / 抽選 / 反則', whyLabel(DUEL_WHY.ABSENT).kanji === '不在' && whyLabel(DUEL_WHY.LOT).kanji === '抽選' && whyLabel(DUEL_WHY.SUSPECT).kanji === '反則');
  const names = new Map([[1, 'Kenji'], [2, 'Aiko']]);
  const nameOf = (pid: number) => names.get(pid) ?? 'ronin';
  // Kenji (a) l'emporte sur Aiko (b).
  const s = (why: number, me: number, wa = 1, wb = 0) => seriesText(1, 2, 1, wa, wb, why, me, nameOf);
  let v = s(DUEL_WHY.ABSENT, 1);
  check('ABSENT, vainqueur : 勝, l\'adversaire absent', v.title === '勝' && v.red && v.sub.includes('Aiko absent') && v.sub.includes('不在'), v.sub);
  v = s(DUEL_WHY.ABSENT, 2);
  check('ABSENT, perdant : 不在, forfait', v.title === '不在' && !v.red && v.sub === 'absent — forfeit', v.sub);
  v = s(DUEL_WHY.SUSPECT, 1);
  check('SUSPECT, vainqueur : 勝, l\'adversaire disqualifié', v.title === '勝' && v.red && v.sub.includes('Aiko disqualified') && v.sub.includes('反則'), v.sub);
  v = s(DUEL_WHY.SUSPECT, 2);
  check('SUSPECT, perdant : 反則, disqualifié', v.title === '反則' && !v.red && v.sub.includes('disqualified'), v.sub);
  v = s(DUEL_WHY.LOT, 1, 1, 1);
  check('LOT, vainqueur : 勝, le sort lui revient', v.title === '勝' && v.red && v.sub.includes('抽選') && v.sub.includes('1–1'), v.sub);
  v = s(DUEL_WHY.LOT, 2, 1, 1);
  check('LOT, perdant : 抽選, le sort revient à l\'autre', v.title === '抽選' && !v.red && v.sub.includes('Kenji'), v.sub);
  check('LOT : jamais un nul', s(DUEL_WHY.LOT, 1, 1, 1).title !== '引き分け' && s(DUEL_WHY.LOT, 3, 1, 1).title !== '引き分け');
  check('spectateur : kanji de l\'issue (不在 / 反則 / 抽選)', s(DUEL_WHY.ABSENT, 3).title === '不在' && s(DUEL_WHY.SUSPECT, 3).title === '反則' && s(DUEL_WHY.LOT, 3, 1, 1).title === '抽選');
  const toast = (why: number, wa = 1, wb = 0) => endToast({ type: 'duelEnd', id: 1, winner: 1, wa, wb, why }, 1, 2, nameOf);
  check('endToast ABSENT', toast(DUEL_WHY.ABSENT) === 'Kenji wins by forfeit — Aiko absent · 不在', toast(DUEL_WHY.ABSENT));
  check('endToast SUSPECT', toast(DUEL_WHY.SUSPECT) === 'Kenji wins — Aiko disqualified · 反則', toast(DUEL_WHY.SUSPECT));
  check('endToast LOT', toast(DUEL_WHY.LOT, 1, 1) === 'Kenji wins by lot over Aiko 1–1 · 抽選', toast(DUEL_WHY.LOT, 1, 1));
  // Le point de vue du perdant (b vainqueur) : les rôles suivent le vainqueur, pas l'ordre a/b.
  const tb = endToast({ type: 'duelEnd', id: 1, winner: 2, wa: 0, wb: 1, why: DUEL_WHY.ABSENT }, 1, 2, nameOf);
  check('endToast ABSENT, b vainqueur', tb === 'Aiko wins by forfeit — Kenji absent · 不在', tb);
  check('outcomeNote : mentions courtes', outcomeNote(DUEL_WHY.DISCONNECT) === '不戦勝 opponent left' && outcomeNote(DUEL_WHY.ABSENT) === '不在 absent'
    && outcomeNote(DUEL_WHY.LOT) === '抽選 drawn by lot' && outcomeNote(DUEL_WHY.SUSPECT) === '反則 disqualified' && outcomeNote(DUEL_WHY.WIN) === '' && outcomeNote(-1) === '');
});

// ─── 2. Fin de série d'un duel du dojo et nom des bots au-dessus du personnage ─
section('duel du dojo', () => {
  const w = createWorld(2, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc', { color: 0 });
  const bot = addPlayer(w, 'Musashi', { color: 1 });
  w.tournament!.entrants.push(
    { pid: me.id, name: 'Luc', color: 0, bot: false, gone: false, ready: false },
    { pid: bot.id, name: 'Musashi', color: 1, bot: true, gone: false, ready: false },
  );
  const side = (pid: number) => ({ pid, wins: 1, strikeT: -1, parryT: -1, foul: false, react: -1 });
  const d: Duel = {
    id: 4, a: side(me.id), b: side(bot.id), x: 500, y: 300, gap: DUEL.GAP, phase: 'end', t: 0, round: 3, played: 9, sigTick: -1,
    stage: 0, last: DUEL_WHY.LOT, winner: me.id, firstTo: 2, maxRounds: 5, draw: false,
  };
  w.duels = [d];
  const v = boutView(w, d, me.id);
  check('fin de série par tirage au sort (d.last = LOT) : issue LOT, pas « victoire 1–1 »', v.outcome === DUEL_WHY.LOT && v.title === '勝' && v.sub.includes('抽選'), `${v.title} · ${v.sub}`);
  d.last = DUEL_WHY.ABSENT;
  d.winner = bot.id;
  check('fin de série par absence : 不在 pour l\'absent', boutView(w, d, me.id).title === '不在');
  d.last = DUEL_WHY.SUSPECT;
  check('fin de série par disqualification : 反則', boutView(w, d, me.id).title === '反則');
  check('nom d\'un bot dans le duel : suffixé 木人', v.b.name === `Musashi ${BOT_MARK}` && v.a.name === 'Luc', `${v.a.name} / ${v.b.name}`);
  check('isDojoBot : vrai pour le bot seulement', isDojoBot(w, bot.id) && !isDojoBot(w, me.id));
  const coop = createWorld(2, { mode: 'coop' });
  const p = addPlayer(coop, 'Musashi');
  check('hors du dojo : jamais de 木人', !isDojoBot(coop, p.id));
});

// ─── 3. Hors du dojo : pas de tableau ───────────────────────────────────────
section('hors dojo', () => {
  const solo = createWorld(1);
  const coop = createWorld(1, { mode: 'coop' });
  check('solo et coop : bracketView null', bracketView(solo, addPlayer(solo, 'A').id) === null && bracketView(coop, addPlayer(coop, 'B').id) === null);
  const t = new BracketToggle();
  t.toggle(null);
  check('Tab hors du dojo : sans effet', t.update(null) === false);
});

// ─── 4. Attente : présents, prêts, départ anticipé ──────────────────────────
section('attente', () => {
  const w = createWorld(4, { mode: 'dojo' });
  const a = addPlayer(w, 'Luc');
  const b = addPlayer(w, 'Aiko');
  const c = addPlayer(w, 'Sora');
  let m = bracketView(w, a.id)!;
  check('avant le premier pas : attente, personne au tableau', m.phase === 'waiting' && m.entrants.length === 0 && m.stage === `Waiting for challengers 0/${DOJO.SIZE}`, m.stage);
  run(w, 1, () => 0);
  m = bracketView(w, a.id)!;
  check('trois présents : 3/8, 60 s', m.stage === 'Waiting for challengers 3/8 · 60 s', m.stage);
  check('ligne personnelle : G: ready (0/3 ready)', m.status === 'G: ready (0/3 ready)', m.status);
  check('ligne d\'attente complète', waitingLine(w.tournament!, w.tick, a.id) === 'Waiting for challengers 3/8 · 60 s · G: ready (0/3 ready)', waitingLine(w.tournament!, w.tick, a.id));
  check('HUD : 道場 · Tournament 1 · <état>', dojoHudLine(w.tournament!, w.tick) === '道場 · Tournament 1 · Waiting for challengers 3/8 · 60 s', dojoHudLine(w.tournament!, w.tick));
  check('attente : ni matchs ni champion, le joueur participe', m.matches.length === 0 && !m.champion && m.entered && !m.inMatch && !m.eliminated);
  check('attente : le grand tableau ne s\'ouvre pas de lui-même', !autoOpen(m));
  // 18 s plus tard, b et c appuient sur G.
  let k = 0;
  run(w, 18 * 60, (pid) => (pid !== a.id && ++k < 4 ? BTN.DUEL : 0));
  m = bracketView(w, a.id)!;
  check('deux prêts sur trois : (2/3 ready), le compte à rebours continue', m.status === 'G: ready (2/3 ready)' && m.stage === 'Waiting for challengers 3/8 · 42 s', `${m.stage} · ${m.status}`);
  check('ligne d\'attente de l\'énoncé : « … 3/8 · 42 s · G: ready (2/3 ready) »', waitingLine(w.tournament!, w.tick, a.id) === 'Waiting for challengers 3/8 · 42 s · G: ready (2/3 ready)');
  const mb = bracketView(w, b.id)!;
  check('vu par un prêt : ready ✓ (2/3 ready)', mb.status === 'ready ✓ (2/3 ready)', mb.status);
  check('places des prêts marquées', m.entrants.filter((e) => e.ready).map((e) => e.pid).sort().join() === [b.id, c.id].sort().join());
  run(w, 2, (pid) => (pid === a.id ? BTN.DUEL : 0));
  m = bracketView(w, a.id)!;
  check('tous prêts : « The bracket is drawn in 3 s »', m.stage === 'The bracket is drawn in 3 s', m.stage);
});

section('attente : salle pleine', () => {
  const w = createWorld(5, { mode: 'dojo' });
  const ps = Array.from({ length: 9 }, (_, i) => addPlayer(w, `P${i}`, { color: i % 8 }));
  run(w, 1, () => 0);
  const late = bracketView(w, ps[8].id)!;
  check('salle pleine : départ annoncé dans 3 s', late.stage === 'The bracket is drawn in 3 s', late.stage);
  check('9e présent : hors du tableau, il entrera au suivant', !late.entered && late.status.includes('next tournament'), late.status);
});

// ─── 5. Tournoi simulé : un humain rapide contre 7 bots ─────────────────────
section('tournoi simulé', () => {
  const w = createWorld(11, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc', { color: 0 });
  const fast = (pid: number) => (pid === me.id ? iaiAt(w, pid, 11) : 0);
  const toggle = new BracketToggle();
  run(w, DOJO.WAIT_TICKS + 5, fast, has('dojoStart'));
  let m = bracketView(w, me.id)!;
  check('tirage : pause avant les quarts, 8 places, 7 matchs', m.phase === 'pause' && m.round === 0 && m.entrants.length === 8 && m.matches.length === 7);
  check('tirage : « Quarterfinals in 5 s »', m.stage === 'Quarterfinals in 5 s', m.stage);
  const bots = m.entrants.filter((e) => e.bot);
  check('7 bots, chacun suffixé 木人 au tableau', bots.length === 7 && bots.every((e) => e.name.endsWith(` ${BOT_MARK}`)));
  check('le joueur local, sans 木人', m.entrants.find((e) => e.me)?.name === 'Luc');
  const mine = m.matches.find((x) => x.mine)!;
  const opp = mine.a?.me ? mine.b! : mine.a!;
  check('ligne personnelle : « You face <bot> 木人 »', m.status === `You face ${opp.name}` && m.status.endsWith(BOT_MARK), m.status);
  check('quarts : places désignées, demies et finale à venir', m.matches.slice(0, 4).every((x) => x.a && x.b) && m.matches.slice(4).every((x) => !x.a && !x.b));
  check('grand tableau ouvert de lui-même au tirage', toggle.update(m));
  toggle.toggle(m);
  check('Tab le referme…', !toggle.update(m));
  run(w, 60, fast);
  m = bracketView(w, me.id)!;
  check('… pour toute la pause', m.phase === 'pause' && !toggle.update(m));
  toggle.toggle(m);
  check('Tab le rouvre', toggle.update(m));
  // Début des quarts : le duel du joueur local occupe l'écran.
  run(w, DOJO.ROUND_PAUSE, fast, has('dojoMatch'));
  m = bracketView(w, me.id)!;
  check('quarts lancés : « Quarterfinals », son match en cours', m.phase === 'running' && m.stage === 'Quarterfinals' && m.inMatch, `${m.phase} ${m.stage}`);
  check('match en cours : tableau fermé (même ouvert à la demande)', !toggle.update(m));
  toggle.toggle(m);
  check('Tab pendant son match : sans effet', !toggle.update(m));
  check('HUD : 道場 · Tournament 1 · Quarterfinals', dojoHudLine(w.tournament!, w.tick) === '道場 · Tournament 1 · Quarterfinals');
  check('scores en direct : 0–0 au début du match', m.matches.filter((x) => x.state === 'live').every((x) => x.sa === '0' && x.sb === '0'));
  // Fin de son quart.
  const evs = run(w, 60 * 60, fast, (e) => e.some((x) => x.type === 'dojoResult' && (x.match === mine.k)));
  m = bracketView(w, me.id)!;
  const res = evs.find((x): x is Ev<'dojoResult'> => x.type === 'dojoResult' && x.match === mine.k)!;
  check('quart gagné', res.winner === me.id);
  check('après sa victoire : « You advance to the semifinals »', m.status.startsWith('You advance to the semifinals'), m.status);
  check('vainqueur inscrit en demie dès la fin du match', m.matches[4 + (mine.k >> 1)].a?.me === true || m.matches[4 + (mine.k >> 1)].b?.me === true);
  const q = m.matches[mine.k];
  check('score final du quart au tableau', q.state === 'done' && (q.a?.me ? q.sa : q.sb) === '2', `${q.sa}–${q.sb}`);
  // Jusqu'au champion.
  run(w, 60 * 60 * 5, fast, has('dojoChampion'));
  m = bracketView(w, me.id)!;
  check('fin : champion, le joueur local', m.phase === 'done' && m.champion?.me === true);
  check('« 優勝 Champion: Luc »', m.stage === '優勝 Champion: Luc', m.stage);
  check('« 優勝 You are the champion! », délai du tournoi suivant', m.status === '優勝 You are the champion!' && m.detail === 'next tournament in 10 s', `${m.status} · ${m.detail}`);
  check('fin : grand tableau ouvert de lui-même', autoOpen(m) && toggle.update(m));
  check('tous les matchs joués, au sabre (scores affichés)', m.matches.every((x) => x.state === 'done' && x.sa !== '' && x.sb !== ''));
  run(w, DOJO.CHAMPION_TICKS + 5, () => 0, has('dojoReset'));
  run(w, 1, () => 0); // les présents s'inscrivent au pas suivant la remise à zéro
  m = bracketView(w, me.id)!;
  check('tournoi suivant : attente, n° 2', m.phase === 'waiting' && m.n === 2 && m.title === '道場 · Tournament 2' && m.entrants.length === 1);
});

section('éliminé au sabre', () => {
  const w = createWorld(12, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc', { color: 0 });
  // Il tient l'iai et le relâche tard (40 ticks, 667 ms) : les bots frappent avant lui.
  run(w, 60 * 60 * 3, (pid) => (pid === me.id ? iaiAt(w, pid, 40) : 0), (e) => e.some((x) => x.type === 'dojoResult' && w.tournament!.matches[x.match].winner !== me.id
    && (w.tournament!.matches[x.match].a === me.id || w.tournament!.matches[x.match].b === me.id)));
  const m = bracketView(w, me.id)!;
  const lost = m.matches.find((x) => x.mine && x.state === 'done' && x.winner >= 0 && !(x.a?.me && x.winner === x.a.pid) && !(x.b?.me && x.winner === x.b.pid))!;
  const by = lost.a?.pid === lost.winner ? lost.a! : lost.b!;
  check('éliminé : « Eliminated by <bot> 木人 »', m.eliminated && m.status === `Eliminated by ${by.name}`, m.status);
  check('éliminé : tour et score dans la ligne secondaire', m.detail.startsWith(`${['quarterfinal', 'semifinal', 'final'][lost.round]} 0–2`) || m.detail.includes('–2'), m.detail);
});

// ─── 6. Forfaits, partis, tirage au sort (tournoi construit à la main) ──────
section('forfaits', () => {
  const t = handTournament();
  const w = worldWith(t);
  const me = 1;
  // Quarts : Luc bat Aiko au sabre ; Tomoe passe (Musashi parti avant son match) ; tirage au sort ; disqualification.
  t.phase = 'running';
  done(t.matches[0], 1, DUEL_WHY.WIN, 2, 1);
  t.entrants[2].gone = true;
  done(t.matches[1], 4, DUEL_WHY.DISCONNECT, 0, 0);
  done(t.matches[2], 6, DUEL_WHY.LOT, 0, 0);
  done(t.matches[3], 8, DUEL_WHY.SUSPECT, 2, 0);
  t.matches[4].a = 1;
  t.matches[4].b = 4;
  t.matches[5].a = 6;
  t.matches[5].b = 8;
  let m = bracketView(w, me)!;
  const [q0, q1, q2, q3] = m.matches;
  check('victoire au sabre : scores 2 et 1, sans mention', q0.sa === '2' && q0.sb === '1' && q0.mark === '');
  check('adversaire parti sans duel : ni score, 不戦勝', q1.sa === '' && q1.sb === '' && q1.mark === '不戦勝');
  check('parti : signalé au tableau, nom gardé', q1.a?.gone === true && q1.a.name === `Musashi ${BOT_MARK}`);
  check('tirage au sort sans duel : 抽選', q2.sa === '' && q2.mark === '抽選');
  check('disqualification : score gardé, 反則', q3.sa === '2' && q3.mark === '反則');
  check('vainqueur au tour suivant', m.matches[4].a?.me === true && m.matches[4].b?.pid === 4);
  check('le joueur local vainqueur : « You advance to the semifinals »', m.status === 'You advance to the semifinals', m.status);
  // Vu par Aiko (2), éliminée au sabre ; Jūbei (6) perd au tirage ; Hanzō (7) gagne mais est disqualifié.
  check('éliminée : « Eliminated by Luc »', bracketView(w, 2)!.status === 'Eliminated by Luc', bracketView(w, 2)!.status);
  check('éliminé par tirage au sort : mention 抽選', bracketView(w, 5)!.status === `Eliminated by Jūbei ${BOT_MARK} · 抽選 drawn by lot`, bracketView(w, 5)!.status);
  check('disqualifié : mention 反則', bracketView(w, 7)!.status === `Eliminated by Kenshin ${BOT_MARK} · 反則 disqualified`, bracketView(w, 7)!.status);
  check('vainqueur par forfait : mention 不戦勝', bracketView(w, 4)!.status === 'You advance to the semifinals · 不戦勝 opponent left', bracketView(w, 4)!.status);
  // Absence en demie.
  t.round = 1;
  t.phase = 'pause';
  m = bracketView(w, me)!;
  check('pause avant les demies : « Semifinals in 5 s », « You face Tomoe 木人 »', m.stage === 'Semifinals in 5 s' && m.status === `You face Tomoe ${BOT_MARK}`, `${m.stage} · ${m.status}`);
  t.phase = 'running';
  done(t.matches[4], 4, DUEL_WHY.ABSENT, 1, 0);
  m = bracketView(w, me)!;
  check('absent : « Eliminated by Tomoe 木人 · 不在 absent », 1–0 en demie', m.status === `Eliminated by Tomoe ${BOT_MARK} · 不在 absent` && m.detail.startsWith('semifinal 1–0'), `${m.status} · ${m.detail}`);
  check('absent : mention 不在 au tableau', m.matches[4].mark === '不在');
  // Le vainqueur d'une demie, inscrit en finale avant la fin de l'autre demie, n'y « affronte » personne.
  t.matches[6].a = 4;
  const tomoe = bracketView(w, 4)!;
  check('vainqueur de demie, finale à venir : « You advance to the final »', tomoe.status.startsWith('You advance to the final'), tomoe.status);
  // Fin.
  t.round = 2;
  t.phase = 'done';
  t.t = 120;
  t.champion = 4;
  done(t.matches[6], 4, DUEL_WHY.WIN, 2, 0);
  m = bracketView(w, me)!;
  check('fin : « 優勝 Champion: Tomoe 木人 »', m.stage === `優勝 Champion: Tomoe ${BOT_MARK}` && m.champion?.pid === 4, m.stage);
  check('fin, éliminé : délai du tournoi suivant', m.detail === 'semifinal 1–0 · next tournament in 8 s', m.detail);
  check('roundName', roundName(0) === 'Quarterfinals' && roundName(1) === 'Semifinals' && roundName(2) === 'Final' && roundName(-1) === '');
  check('entrantName', entrantName({ name: 'Musashi', bot: true }) === 'Musashi 木人' && entrantName({ name: '', bot: false }) === 'ronin');
});

section('toasts et bannières', () => {
  const t = handTournament();
  t.phase = 'running';
  t.entrants[2].gone = true;
  done(t.matches[1], 4, DUEL_WHY.DISCONNECT, 0, 0);
  done(t.matches[2], 6, DUEL_WHY.LOT, 0, 0);
  const ev = (k: number): Ev<'dojoResult'> => ({ type: 'dojoResult', match: k, winner: t.matches[k].winner, why: t.matches[k].why, wa: 0, wb: 0 });
  check('forfait sans duel d\'autres joueurs : toast 不戦勝', resultToast(ev(1), t, 1, false) === `Tomoe ${BOT_MARK} advances — Musashi ${BOT_MARK} left · 不戦勝`, resultToast(ev(1), t, 1, false));
  check('tirage au sort sans duel : toast 抽選', resultToast(ev(2), t, 1, false).includes('drawn by lot · 抽選'));
  check('match joué en duel : pas de toast (la surcouche des duels l\'a annoncé)', resultToast(ev(1), t, 1, true) === '');
  done(t.matches[3], 8, DUEL_WHY.SUSPECT, 2, 0);
  check('disqualification décidée par le tableau : toast même après un duel', resultToast(ev(3), t, 1, true).includes('disqualified · 反則'));
  check('son propre match : pas de toast', resultToast(ev(1), t, 4, false) === '');
  const win = resultBanner(ev(1), t, 4, false);
  check('bannière du vainqueur par forfait : 不戦勝', win?.kanji === '不戦勝' && win.red && win.title.includes('Musashi') && win.sub === 'on to the semifinals', JSON.stringify(win));
  const lot = resultBanner(ev(2), t, 5, false);
  check('bannière du perdant au tirage : 抽選, éliminé', lot?.kanji === '抽選' && !lot.red && lot.title.startsWith('Eliminated'), JSON.stringify(lot));
  check('bannière : rien après un duel, rien pour les autres', resultBanner(ev(1), t, 4, true) === null && resultBanner(ev(1), t, 1, false) === null);
});

// ─── 7. Surcouche du tableau sur une fausse scène ───────────────────────────

/** Texte, graphisme ou conteneur Phaser factice. */
class FakeObj {
  x: number;
  y: number;
  text: string;
  style: { color: string };
  visible = true;
  alpha = 1;
  children: FakeObj[] = [];
  constructor(x = 0, y = 0, text = '', style: { color?: string } = {}) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.style = { color: style.color ?? '' };
  }
  get width(): number {
    return this.text.length * 9;
  }
  setText(s: string): this {
    this.text = s;
    return this;
  }
  setColor(c: string): this {
    this.style.color = c;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(): this {
    return this;
  }
  clear(): this {
    return this;
  }
  fillStyle(): this {
    return this;
  }
  fillPoints(): this {
    return this;
  }
}

function fakeOverlay(): { ov: BracketOverlay; texts: FakeObj[]; root: () => FakeObj } {
  const texts: FakeObj[] = [];
  let root: FakeObj | null = null;
  const scene = {
    scale: { width: 1280, height: 720 },
    add: {
      text: (x: number, y: number, s: string, style: { color?: string }) => {
        const t = new FakeObj(x, y, s, style);
        texts.push(t);
        return t;
      },
      graphics: () => new FakeObj(),
      container: (x: number, y: number, children: FakeObj[]) => {
        root = new FakeObj(x, y);
        root.children = children;
        return root;
      },
    },
  };
  const ov = new BracketOverlay(scene as unknown as Phaser.Scene, ((o: unknown) => o) as never);
  return { ov, texts, root: () => root! };
}
const shownTexts = (texts: FakeObj[], root: FakeObj) =>
  texts.filter((t) => t.text !== '' && (root.children.includes(t) ? root.visible : t.visible)).map((t) => t.text);

section('surcouche', () => {
  const { ov, texts, root } = fakeOverlay();
  const w = createWorld(11, { mode: 'dojo' });
  const me = addPlayer(w, 'Luc', { color: 0 });
  run(w, 1, () => 0);
  let time = 1000;
  const frame = () => ov.update(bracketView(w, me.id), (time += 16));
  frame();
  let shown = shownTexts(texts, root());
  check('attente : petit panneau « G: ready (0/1 ready) », grand tableau fermé', shown.includes('G: ready (0/1 ready)') && !root().visible, shown.join(' | '));
  const compact = texts[0]; // première ligne du petit panneau (créée en premier)
  check('petit panneau : sa ligne d\'état', compact.visible && compact.text === 'G: ready (0/1 ready)', compact.text);
  ov.tab();
  frame();
  shown = shownTexts(texts, root());
  check('Tab : grand tableau ouvert, petit panneau masqué', root().visible && !compact.visible, shown.join(' | '));
  check('grand tableau : la ligne d\'état au pied', root().children.some((x) => x.text === 'G: ready (0/1 ready)'));
  check('attente au tableau : le présent et les places à venir', shown.includes('Luc') && shown.includes('—') && shown.includes('Tab: close · G: ready'), shown.join(' | '));
  ov.tab();
  frame();
  check('Tab : refermé', !root().visible);
  // Tirage : le tableau s'ouvre de lui-même, avec les noms des bots suffixés 木人.
  const evs = run(w, DOJO.WAIT_TICKS + 5, (pid) => (pid === me.id ? iaiAt(w, pid, 11) : 0), has('dojoStart'));
  for (const e of evs) ov.onEvent(e, w, me.id);
  frame();
  shown = shownTexts(texts, root());
  check('tirage : grand tableau ouvert de lui-même', root().visible);
  check('tableau : 8 noms dont 7 suffixés 木人', shown.filter((s) => s.endsWith(BOT_MARK) && !s.startsWith('You face')).length === 7 && shown.includes('Luc'), shown.join(' | '));
  check('tableau : titre et état', shown.includes('道場 · Tournament 1') && shown.includes('Quarterfinals in 5 s'));
  // Son match : tout se range.
  const evs2 = run(w, DOJO.ROUND_PAUSE + 5, (pid) => (pid === me.id ? iaiAt(w, pid, 11) : 0), has('dojoMatch'));
  for (const e of evs2) ov.onEvent(e, w, me.id);
  frame();
  shown = shownTexts(texts, root());
  check('son match : ni tableau ni petit panneau', !root().visible && !shown.some((s) => s.startsWith('You face')), shown.join(' | '));
  const k = w.tournament!.matches.findIndex((m) => m.a === me.id || m.b === me.id);
  check('matchs lancés : mémorisés comme joués en duel', ov.dueled(k) && ov.dueled(0) && ov.dueled(3));
  // Toast d'un forfait sans duel (événement construit : Musashi a quitté la salle avant son match).
  const t = handTournament();
  const w2 = worldWith(t);
  t.phase = 'running';
  done(t.matches[1], 4, DUEL_WHY.DISCONNECT, 0, 0);
  ov.clear();
  ov.onEvent({ type: 'dojoResult', match: 1, winner: 4, why: DUEL_WHY.DISCONNECT, wa: 0, wb: 0 }, w2, 1);
  ov.update(bracketView(w2, 1), (time += 16));
  shown = shownTexts(texts, root());
  check('toast d\'un forfait sans duel', shown.some((s) => s.includes('advances — Musashi') && s.endsWith('不戦勝')), shown.join(' | '));
  check('busy tant que le toast est affiché', ov.busy);
  ov.hide();
  check('hide : tout masqué', !root().visible && texts.filter((x) => !root().children.includes(x)).every((x) => !x.visible));
});

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log("\nTous les tests de l'interface du dojo passent.");
