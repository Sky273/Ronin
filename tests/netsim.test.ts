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
/** Seuils de M2 actifs (prédiction, interpolation, codec compact et compensation de latence intégrés). */
const ENFORCE = true;
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

// 4. Latences par client (M4, équité des duels) : A à 0 ms, B à 150 ms par sens, sans gigue.
//    Retard compensé L par client, et propriété d'équité : l'entrée envoyée quand le tick prédit
//    du client vaut T est consommée au tick serveur T, quelle que soit la latence.
{
  const duo = new NetBench({ seed: 11, lagMs: 0, jitterMs: 0 });
  const a = duo.addClient('A');
  const b = duo.addClient('B', { up: { lagMs: 150 }, down: { lagMs: 150 } });
  const w = duo.session.world;
  const calm = (): void => {
    w.enemies = [];
    w.projectiles = [];
    w.spawnTimer = 1e6;
  };
  duo.run(3000, () => 0, calm);
  const lags: number[][] = [[], []];
  duo.run(2000, () => 0, () => {
    calm();
    lags[0].push(duo.session.lagFor(a.pid));
    lags[1].push(duo.session.lagFor(b.pid));
  });
  const la = mean(lags[0]);
  const lb = mean(lags[1]);
  check('L de A (0 ms) ≈ 6 ± 2 ticks', Math.abs(la - 6) <= 2, `${la.toFixed(2)}`);
  check('L de B (150 ms par sens) ≈ 24 ± 3 ticks', Math.abs(lb - 24) <= 3, `${lb.toFixed(2)}`);

  // Marque : un bouton sans effet hors du bilan, envoyé une image sur 30.
  const MARK = BTN.PICK3;
  const sentAt: number[][] = [[], []];
  const usedAt: number[][] = [[], []];
  const marked = [false, false];
  const pair = [a, b];
  duo.onServerStep((tick) => {
    pair.forEach((c, i) => {
      const on = ((duo.serverPlayer(c.pid)?.prevButtons ?? 0) & MARK) !== 0;
      if (on && !marked[i]) usedAt[i].push(tick); // front montant : tick de consommation
      marked[i] = on;
    });
  });
  duo.run(12_000, (i, frame) => {
    if (frame % 30 !== 0) return 0;
    sentAt[i].push(duo.predictedTick(pair[i]));
    return MARK;
  }, calm);
  duo.run(1000, () => 0, calm); // les dernières marques arrivent au serveur
  pair.forEach((c, i) => {
    const n = Math.min(sentAt[i].length, usedAt[i].length);
    const gaps = Array.from({ length: n }, (_, k) => usedAt[i][k] - sentAt[i][k]);
    const worst = Math.max(0, ...gaps.map(Math.abs));
    check(
      `équité ${c === a ? 'A (0 ms)' : 'B (150 ms)'} : entrée envoyée au tick prédit T consommée au tick serveur T (± 1)`,
      n >= 20 && sentAt[i].length === usedAt[i].length && worst <= 1,
      `${n} marques, écart moyen ${mean(gaps).toFixed(2)}, max |écart| ${worst}`,
    );
  });

  // Rafale (outil des tests anti-triche) : plusieurs entrées arrivent au serveur dans le même lien.
  const q0 = duo.session.queueLength(a.pid);
  const sent = duo.burst(a, [BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT]);
  duo.run(duo.frameMs, () => 0, calm);
  const q1 = duo.session.queueLength(a.pid);
  check('rafale : séquences consécutives, entrées en file au serveur', sent.every((m, k) => k === 0 || m.s === sent[k - 1].s + 1) && q1 >= q0 + 4, `file ${q0} → ${q1}`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du banc réseau passent.');
