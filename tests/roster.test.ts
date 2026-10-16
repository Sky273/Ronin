// Tests du récapitulatif de salle du bilan coop (module pur client/ui/roster).
// Lancer : npm run test:roster
import { COOP_CLEARED_TICKS } from '../shared/constants';
import type { PlayerStageStats, World } from '../shared/types';
import { addPlayer, createWorld } from '../shared/world';
import { buildRoster, readyInfo, roomGrade } from '../client/ui/roster';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

function stats(o: Partial<PlayerStageStats>): PlayerStageStats {
  return { kills: 0, parries: 0, deaths: 0, honor: 0, bestCombo: 0, grade: 2, bonus: 0, ready: false, ...o };
}

/** Monde coop de n joueurs, en bilan. */
function room(n: number): World {
  const w = createWorld(11, { mode: 'coop' });
  for (let i = 0; i < n; i++) addPlayer(w, `P${String(i).padStart(2, '0')}`, { color: i % 12 });
  w.stage.state = 'cleared';
  w.stage.t = 0;
  return w;
}

// ─── buildRoster : tri, me, plafond ─────────────────────────────────────────
{
  const w = room(4);
  const [a, b, c, d] = w.players;
  w.stage.byPlayer = {
    [a.id]: stats({ kills: 3, grade: 1 }),
    [b.id]: stats({ kills: 9, grade: 0, ready: true }),
    [c.id]: stats({ kills: 5, grade: 1, deaths: 2, parries: 4, honor: 30 }),
    [d.id]: stats({ kills: 5, grade: 1 }),
  };
  const r = buildRoster(w, c.id);
  check('une ligne par joueur', r.length === 4, `${r.length}`);
  check('tri : note puis kills puis nom', r.map((x) => x.name).join(',') === 'P01,P02,P03,P00', r.map((x) => x.name).join(','));
  check('me marqué (et lui seul)', r.filter((x) => x.me).length === 1 && r.find((x) => x.me)?.id === c.id);
  const rc = r.find((x) => x.id === c.id)!;
  check('stats recopiées', rc.kills === 5 && rc.deaths === 2 && rc.parries === 4 && rc.honor === 30 && rc.grade === 1 && !rc.ready);
  check('ready recopié', r.find((x) => x.id === b.id)?.ready === true);
  check('couleur recopiée', rc.color === c.color);
}
{
  const w = room(14);
  const r = buildRoster(w, w.players[13].id);
  check('12 lignes au plus', r.length === 12, `${r.length}`);
  check('au-delà de 12 : me reste visible', r.some((x) => x.me));
}

// ─── Entrées absentes ───────────────────────────────────────────────────────
{
  const w = room(3);
  const [a, b, c] = w.players;
  w.stage.byPlayer = { [a.id]: stats({ kills: 2, grade: 2 }), [b.id]: stats({ kills: 1, grade: 0 }) };
  let r: ReturnType<typeof buildRoster> = [];
  let ok = true;
  try {
    r = buildRoster(w, c.id);
  } catch {
    ok = false;
  }
  check('arrivant absent de byPlayer : pas d\'exception', ok);
  const rc = r.find((x) => x.id === c.id);
  check('arrivant : zéros et note 2', !!rc && rc.kills === 0 && rc.deaths === 0 && rc.parries === 0 && rc.honor === 0 && rc.grade === 2 && !rc.ready && rc.me);
  check('arrivant trié parmi les 可 (kills 0 après 2)', r.map((x) => x.id).join(',') === `${b.id},${a.id},${c.id}`);
}
{
  const w = room(2);
  w.stage.byPlayer = undefined;
  let ok = true;
  try {
    const r = buildRoster(w, w.players[0].id);
    const info = readyInfo(w);
    ok = r.length === 2 && r.every((x) => x.grade === 2 && x.kills === 0) && info.ready === 0;
  } catch {
    ok = false;
  }
  check('byPlayer absent : aucune exception, valeurs par défaut', ok);
  check('buildRoster sans joueur : tableau vide', buildRoster(createWorld(3, { mode: 'coop' }), 1).length === 0);
}

// ─── readyInfo ──────────────────────────────────────────────────────────────
for (const [n, needed] of [[1, 1], [2, 2], [4, 3], [12, 7]] as const) {
  const w = room(n);
  check(`needed pour ${n} joueur(s) = ${needed}`, readyInfo(w).needed === needed && readyInfo(w).present === n, `${readyInfo(w).needed}`);
}
{
  const w = room(4);
  const [a, b, c] = w.players;
  w.stage.byPlayer = { [a.id]: stats({ ready: true }), [b.id]: stats({ ready: true }), [c.id]: stats({}) };
  check('ready compté (entrée absente = non prêt)', readyInfo(w).ready === 2, `${readyInfo(w).ready}`);
  // Entrée d'un joueur parti : ignorée.
  w.stage.byPlayer[999] = stats({ ready: true });
  check('ready ignore les ids hors salle', readyInfo(w).ready === 2);

  const at = (t: number): number => {
    w.stage.t = t;
    return readyInfo(w).secondsLeft;
  };
  check('secondsLeft au début = 8', at(0) === 8, `${at(0)}`);
  check('secondsLeft à 1 tick = 8 (arrondi supérieur)', at(1) === 8);
  check('secondsLeft à 60 ticks = 7', at(60) === 7);
  check('secondsLeft à 479 = 1', at(COOP_CLEARED_TICKS - 1) === 1);
  check('secondsLeft à 480 = 0', at(COOP_CLEARED_TICKS) === 0);
  check('secondsLeft borné à 0 au-delà', at(COOP_CLEARED_TICKS + 200) === 0);
}

// ─── roomGrade ──────────────────────────────────────────────────────────────
{
  const w = room(3);
  w.stage.grade = 1;
  check('roomGrade = stage.grade', roomGrade(w) === 1);
}

// Absents : marqués, et exclus du vote (seuil et votes).
{
  const w = createWorld(9, { mode: 'coop' });
  const ps = [addPlayer(w, 'A'), addPlayer(w, 'B'), addPlayer(w, 'C'), addPlayer(w, 'D')];
  const stat = (ready: boolean): PlayerStageStats => ({ kills: 0, parries: 0, deaths: 0, honor: 0, bestCombo: 0, grade: 1, bonus: 0, ready });
  w.stage.byPlayer = { [ps[0].id]: stat(true), [ps[1].id]: stat(false), [ps[2].id]: stat(true), [ps[3].id]: stat(false) };
  w.away = [ps[2].id, ps[3].id];
  const info = readyInfo(w);
  check('absents exclus : 2 actifs, 2 nécessaires, 1 vote (celui de l’absent ne compte pas)', info.present === 2 && info.needed === 2 && info.ready === 1, JSON.stringify(info));
  const rows = buildRoster(w, ps[0].id);
  check('absents marqués dans le récapitulatif', rows.filter((r) => r.away).length === 2 && rows.find((r) => r.id === ps[0].id)?.away === false);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
}
console.log('\nroster : tout est vert');
