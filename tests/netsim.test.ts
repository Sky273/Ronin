// Mesures du mode en ligne sur le banc réseau virtuel (75 ms par sens + gigue 20 ms, 12 joueurs).
// Lancer : npm run test:netsim
// Les seuils d'acceptation de M2 ne sont appliqués qu'une fois les lots intégrés (ENFORCE).
import { BTN } from '../shared/input';
import { Rng } from '../shared/math';
import { mean, NetBench, percentile } from './net/harness';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}
/** Seuils de M2 actifs ? (faux tant que prédiction, interpolation et codec compact ne sont pas intégrés) */
const ENFORCE = false;
const gate = (name: string, ok: boolean, info: string): void => {
  if (ENFORCE) check(name, ok, info);
  else console.log(`· ${name} — mesure : ${info}${ok ? '' : ' (seuil M2 non atteint)'}`);
};

const bench = new NetBench({ seed: 3, lagMs: 75, jitterMs: 20 });
for (let i = 0; i < 12; i++) bench.addClient(`p${i}`);

// Entrées des 11 autres joueurs : pseudo-aléatoires et déterministes ; le joueur 0 est piloté par le test.
const rng = new Rng(17);
const held = Array.from({ length: 12 }, () => ({ b: 0, until: 0 }));
const MOVES = [0, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.RIGHT | BTN.ATTACK, BTN.PARRY];
let p0 = 0;
const input = (i: number, frame: number): number => {
  if (i === 0) return p0;
  const h = held[i];
  if (frame >= h.until) {
    h.b = MOVES[Math.floor(rng.next() * MOVES.length)];
    h.until = frame + 10 + Math.floor(rng.next() * 50);
  }
  return h.b;
};

// 1. Mise en route : tout le monde reçoit l'accueil et des instantanés.
bench.run(1500, input);
check('12 clients prêts', bench.clients.every((c) => c.src.ready), `${bench.clients.filter((c) => c.src.ready).length}`);
const rtt = bench.clients[0].transport.rtt;
check('latence mesurée cohérente (2 × 75 ms + gigue)', rtt >= 140 && rtt <= 230, `${rtt.toFixed(0)} ms`);

// 2. Réaction locale : images entre l'appui sur RIGHT et le mouvement du joueur affiché.
{
  const c = bench.clients[0];
  p0 = 0;
  bench.run(500, input); // immobile
  const start = bench.metrics.frames;
  let reacted = -1;
  p0 = BTN.RIGHT;
  bench.run(1000, input, (frame) => {
    const me = bench.shownPlayer(c);
    if (reacted < 0 && me && me.vx > 0) reacted = frame - start;
  });
  p0 = 0;
  gate('réaction locale en 0 image après l’appui', reacted === 0, `${reacted} image(s)`);
}

// 3. Bande passante à 12 joueurs.
{
  bench.metrics.snapBytes.length = 0;
  bench.run(30_000, input);
  const avg = mean(bench.metrics.snapBytes);
  const p95 = percentile(bench.metrics.snapBytes, 95);
  gate('instantané moyen < 2 Ko à 12 joueurs', avg < 2048, `${avg.toFixed(0)} o (p95 ${p95} o)`);
  gate('instantané p95 < 3 Ko', p95 < 3072, `${p95} o`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du banc réseau passent.');
