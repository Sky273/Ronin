// Tests de la politique d'effets (tremblements par joueur) et du maintien de bouton.
// Lancer : npm run test:policy
import { isMine, shakeFor, SLAM_FULL_PX, SLAM_NONE_PX } from '../client/fx/eventPolicy';
import { HoldTrigger } from '../client/input/hold';
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

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de politique d’effets passent.');
