// Tests de la politique d'effets (tremblements par joueur) et du maintien de bouton.
// Lancer : npm run test:policy
import { isMine, shakeFor, SLAM_FULL_PX, SLAM_NONE_PX } from '../client/fx/eventPolicy';
import { HoldTrigger } from '../client/input/hold';
import { NET_UNKNOWN_COLOR, netLabel, netQualityColor } from '../client/ui/netQuality';
import type { GameEvent } from '../shared/types';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const ME = 7;
const at = { x: 1000, y: 500 };
const hit = (pid?: number, heavy = false): GameEvent => ({ type: 'hit', x: 1000, y: 480, dir: 1, damage: 10, heavy, targetId: 3, ...(pid === undefined ? {} : { pid }) });
const slam = (x: number, w: number): GameEvent => ({ type: 'slam', x, y: 500, w });

// 1. Auteur.
check('sans pid (solo, événement de salle) : concerne le joueur local', isMine(hit(), ME) && isMine({ type: 'tideWarn', n: 1 }, ME));
check('pid du joueur local : le concerne', isMine(hit(ME), ME));
check('pid d’un autre joueur : ne le concerne pas', !isMine(hit(ME + 1), ME));

// 2. Tremblements : solo identique à l'ancien comportement.
check('solo : coup léger 4, lourd 9', shakeFor(hit(), ME, at, false) === 4 && shakeFor(hit(undefined, true), ME, at, false) === 9);
check(
  'solo : garde 3, garde brisée 8, onde de choc pleine quelle que soit la distance',
  shakeFor({ type: 'block', x: 0, y: 0, dir: 1 }, ME, at, false) === 3 &&
    shakeFor({ type: 'guardBreak', x: 0, y: 0 }, ME, at, false) === 8 &&
    shakeFor(slam(at.x + 5000, 140), ME, at, false) === 14 &&
    shakeFor(slam(at.x, 60), ME, at, false) === 5,
);

// 3. Coop : seuls les coups du joueur local tremblent.
check('coop : mon coup tremble', shakeFor(hit(ME, true), ME, at, true) === 9);
check(
  'coop : coups, gardes et gardes brisées des autres ne tremblent pas',
  shakeFor(hit(ME + 1, true), ME, at, true) === 0 &&
    shakeFor({ type: 'block', x: 0, y: 0, dir: 1, pid: ME + 1 }, ME, at, true) === 0 &&
    shakeFor({ type: 'guardBreak', x: 0, y: 0, pid: ME + 1 }, ME, at, true) === 0,
);
const near = shakeFor(slam(at.x + SLAM_FULL_PX - 1, 140), ME, at, true);
const mid = shakeFor(slam(at.x - (SLAM_FULL_PX + SLAM_NONE_PX) / 2, 140), ME, at, true);
const far = shakeFor(slam(at.x + SLAM_NONE_PX + 1, 140), ME, at, true);
check('coop : onde de choc pleine de près, atténuée à mi-distance, nulle au loin', near === 14 && mid > 0 && mid < 14 && far === 0, `${near} ${mid.toFixed(1)} ${far}`);
check('événements sans tremblement', shakeFor({ type: 'jump', x: 0, y: 0, double: false, pid: ME }, ME, at, true) === 0);

// 4. Maintien de bouton.
{
  const h = new HoldTrigger(1000);
  const seq: boolean[] = [];
  for (let t = 0; t <= 1500; t += 100) seq.push(h.update(true, t));
  check('déclenche une seule fois après 1 s de maintien', seq.filter(Boolean).length === 1 && seq[10] === true && seq[9] === false);
  check('pas de nouveau déclenchement sans relâcher', !h.update(true, 5000));
  h.update(false, 5100);
  check('relâché puis maintenu : se réarme', !h.update(true, 5200) && h.update(true, 6200));
  const g = new HoldTrigger(1000);
  g.update(true, 0);
  g.update(false, 600);
  check('maintien interrompu : le compte repart de zéro', !g.update(true, 700) && !g.update(true, 1600) && g.update(true, 1700));
  check('progression bornée', g.progress(1800) === 0 && new HoldTrigger(1000).progress(0) === 0);
}

// 5. Qualité de connexion affichée.
{
  const good = netQualityColor({ rtt: 40, jitter: 10 });
  const fair = netQualityColor({ rtt: 150, jitter: 20 });
  const jittery = netQualityColor({ rtt: 40, jitter: 70 });
  const poor = netQualityColor({ rtt: 320, jitter: 10 });
  check('qualité : bonne, moyenne, mauvaise selon latence et gigue', good !== fair && fair !== poor && good !== poor && jittery === fair);
}

// 6. Qualité de connexion : seuils aux bornes exactes, valeurs nulles, négatives ou non finies (QA).
{
  const GOOD = netQualityColor({ rtt: 40, jitter: 10 });
  const FAIR = netQualityColor({ rtt: 150, jitter: 20 });
  const POOR = netQualityColor({ rtt: 320, jitter: 10 });
  const q = (rtt: number, jitter: number): string => {
    const c = netQualityColor({ rtt, jitter });
    return c === GOOD ? 'bonne' : c === FAIR ? 'moyenne' : c === POOR ? 'mauvaise' : c === NET_UNKNOWN_COLOR ? 'inconnue' : c;
  };
  const cases: [number, number, string][] = [
    [100, 40, 'bonne'], [100.001, 40, 'moyenne'], [100, 40.001, 'moyenne'], [1, 0, 'bonne'],
    [200, 90, 'moyenne'], [200.001, 0, 'mauvaise'], [150, 90.001, 'mauvaise'], [40, 1000, 'mauvaise'],
    [0, 0, 'inconnue'], [0, 500, 'inconnue'], [-5, 0, 'inconnue'], [NaN, 0, 'inconnue'],
    [50, NaN, 'bonne'], [50, -10, 'bonne'], [Infinity, 0, 'mauvaise'], [250, NaN, 'mauvaise'],
  ];
  const bad = cases.filter(([r, j, want]) => q(r, j) !== want).map(([r, j, want]) => `(${r}, ${j}) → ${q(r, j)}, attendu ${want}`);
  check('qualité : quatre couleurs distinctes', new Set([GOOD, FAIR, POOR, NET_UNKNOWN_COLOR]).size === 4);
  check('qualité : bornes exactes, 0, négatifs et NaN', bad.length === 0, bad.join(' ; '));
  if (q(50, Infinity) === 'bonne') console.log('· NOTE : une gigue infinie est traitée comme nulle (qualité « bonne »)');
  const labels: [number, string][] = [[0, '… ms'], [-3, '… ms'], [NaN, '… ms'], [0.4, '0 ms'], [99.5, '100 ms'], [304.2, '304 ms']];
  const lbad = labels.filter(([r, want]) => netLabel({ rtt: r, jitter: 0, players: 3 }) !== `3 ronin · ● ${want}`).map(([r]) => `${r} → « ${netLabel({ rtt: r, jitter: 0, players: 3 })} »`);
  check('libellé : « … ms » sans mesure (0, négatif, NaN), arrondi sinon', lbad.length === 0, lbad.join(' ; '));
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de politique d’effets passent.');
