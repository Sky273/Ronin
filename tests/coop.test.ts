// Tests des règles du mode coopératif (simulation, sans réseau).
// Lancer : npm run test:coop
import { COOP, COOP_CLEARED_TICKS, ENEMY, TILE } from '../shared/constants';
import { findGround, spawnEnemy } from '../shared/enemy';
import { BTN } from '../shared/input';
import { damagePlayer, doomEnemy, killEnemy, takeToken } from '../shared/interactions';
import { Rng } from '../shared/math';
import type { GameEvent, Player, World } from '../shared/types';
import { addPlayer, createWorld, removePlayer, stepWorld, warpToArena } from '../shared/world';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** États lus sans le rétrécissement de type de TypeScript (ils changent pendant stepWorld). */
const stateOf = (w: World): string => w.stage.state;
const pState = (p: Player): string => p.state;

/** Entrées scriptées pseudo-aléatoires et déterministes : un masque tenu quelques ticks par joueur. */
function scripted(seed: number): (t: number, id: number) => number {
  const rng = new Rng(seed);
  const held = new Map<number, { mask: number; until: number }>();
  const moves = [0, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.RIGHT | BTN.ATTACK, BTN.DASH | BTN.RIGHT, BTN.PARRY, BTN.IAI, BTN.DOWN | BTN.RIGHT, BTN.PICK1, BTN.UP | BTN.ATTACK];
  return (t, id) => {
    let h = held.get(id);
    if (!h || t >= h.until) {
      h = { mask: moves[Math.floor(rng.next() * moves.length)], until: t + 4 + Math.floor(rng.next() * 30) };
      held.set(id, h);
    }
    return h.mask;
  };
}

/** Avance de n ticks ; renvoie les événements produits. */
function run(w: World, n: number, input: (t: number, id: number) => number = () => 0, each?: (w: World) => void): GameEvent[] {
  const evs: GameEvent[] = [];
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    m.clear();
    for (const p of w.players) m.set(p.id, input(w.tick, p.id));
    stepWorld(w, m);
    evs.push(...w.events);
    w.events.length = 0;
    each?.(w);
  }
  return evs;
}

/** Tue un joueur à coup sûr (en ignorant parade et invulnérabilité). */
function kill(w: World, p: Player): void {
  if (p.state === 'dead') return;
  p.iframes = 0;
  p.state = 'normal';
  damagePlayer(w, p, 1e6, p.x + 10);
}

/** Pose un joueur (ou un point) au sol à l'abscisse x. */
function groundY(w: World, x: number, nearY: number): number {
  return findGround(w.level, x, nearY, 12) ?? findGround(w.level, x, 0, 0) ?? nearY;
}
function place(w: World, p: Player, x: number, nearY = p.y): void {
  p.x = x;
  p.y = groundY(w, x, nearY);
  p.vx = 0;
  p.vy = 0;
}

/** Valeurs numériques non finies dans l'état (hors lostX/lostY, NaN par convention). */
function nonFinite(w: World): string[] {
  const out: string[] = [];
  const scan = (label: string, o: object, skip: string[] = []) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && !Number.isFinite(v) && !skip.includes(k)) out.push(`${label}.${k}=${v}`);
    }
  };
  for (const p of w.players) scan(`joueur#${p.id}`, p, ['lostX', 'lostY']);
  for (const e of w.enemies) scan(`${e.type}#${e.id}`, e);
  for (const a of w.projectiles) scan(`proj#${a.id}`, a);
  for (const o of w.orbs) scan(`orbe#${o.id}`, o);
  return out;
}

// ─── 1. Quatre joueurs scriptés pendant 3000 ticks : pas de fin, morts et renaissances ─
{
  const w = createWorld(4242, { mode: 'coop' });
  const ps = [0, 1, 2, 3].map((i) => addPlayer(w, `p${i}`, { color: i }));
  ps.forEach((p, i) => place(w, p, w.level.spawn.x + i * 60));
  const input = scripted(99);
  const bad: string[] = [];
  let deaths = 0;
  let respawns = 0;
  const livesLeft = new Set<number>();
  for (let t = 0; t < 3000; t++) {
    // Morts forcées : le joueur 0 meurt bien plus souvent que ses 5 vies, et toute la salle meurt d'un coup une fois.
    if (t % 250 === 100) kill(w, ps[0]);
    if (t === 1800) for (const p of ps) kill(w, p);
    for (const ev of run(w, 1, input)) {
      if (ev.type === 'playerDeath') {
        deaths++;
        livesLeft.add(ev.livesLeft);
      }
      if (ev.type === 'respawn') respawns++;
      if (ev.type === 'gameOver') bad.push(`gameOver t=${t}`);
    }
    if (w.over) bad.push(`over t=${t}`);
    if (bad.length < 5) bad.push(...nonFinite(w).map((s) => `t=${t} ${s}`));
  }
  check('coop 4 joueurs × 3000 ticks : jamais over, aucune valeur non finie', !w.over && bad.length === 0, bad.slice(0, 4).join(' ; '));
  check('morts suivies de renaissances', deaths >= 12 && respawns >= deaths - 4, `morts=${deaths} renaissances=${respawns}`);
  check('playerDeath.livesLeft vaut toujours -1', livesLeft.size === 1 && livesLeft.has(-1), [...livesLeft].join(','));
  check('aucun joueur sorti, vies intactes', ps.every((p) => !p.out && p.lives === 5), ps.map((p) => `${p.lives}/${p.out}`).join(' '));
}

// ─── 2. Mort isolée : la Marée continue, les ennemis qui combattent un autre restent ─
{
  const w = createWorld(31, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  w.enemies = [];
  const cp = w.level.checkpoints[1];
  a.spawnX = cp.x;
  a.spawnY = cp.y;
  place(w, b, cp.x + 400, cp.y);
  b.iframes = 1e6;
  place(w, a, cp.x + 2000, cp.y);
  const mk = (x: number) => {
    const e = spawnEnemy(w, 'ashigaru', x, groundY(w, x, cp.y), false);
    e.state = 'chase';
    return e;
  };
  const nearB = mk(b.x + 100); // près du sanctuaire mais au contact de B : reste
  const nearSpawn = mk(cp.x - 600); // près du sanctuaire, à 1000 px de B : disparaît
  nearSpawn.state = 'patrol'; // hors de vue de B : il ne s'en approche pas
  const nearDeath = mk(a.x + 150); // près du lieu de la mort de A, loin de tous : reste en coop
  w.wave = { n: 1, phase: 'tide', t: 0, kills: 0, quota: 1000 };
  kill(w, a);
  const timer = w.spawnTimer;
  const evs = run(w, 160);
  const ids = new Set(w.enemies.map((e) => e.id));
  const respawned = evs.some((ev) => ev.type === 'respawn' && ev.pid === a.id);
  check('mort isolée : A renaît au sanctuaire', respawned && Math.abs(a.x - cp.x) < 40, `x=${a.x.toFixed(0)} cp=${cp.x}`);
  check('mort isolée : la Marée continue', w.wave.phase === 'tide' && !evs.some((ev) => ev.type === 'tideEnd'), w.wave.phase);
  check('mort isolée : l\'ennemi qui combat B reste', ids.has(nearB.id));
  check('mort isolée : l\'ennemi près du sanctuaire et loin des autres disparaît', !ids.has(nearSpawn.id));
  check('mort isolée : pas de nettoyage autour du lieu de la mort', ids.has(nearDeath.id));
  check('mort isolée : pas de répit imposé au spawner', timer < 180 || w.spawnTimer <= timer, `avant=${timer} après=${w.spawnTimer}`);
}

// ─── 3. Sanctuaire commun, arrivée et départ en cours d'étape ───────────────
{
  const w = createWorld(55, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  check('w.shrine vaut 0 au départ', w.shrine === 0);
  const cps = w.level.checkpoints;
  const cp2 = cps[Math.min(2, cps.length - 1)];
  const i2 = cps.indexOf(cp2);
  a.iframes = 1e6;
  place(w, a, cp2.x, cp2.y);
  const evs = run(w, 2);
  check('sanctuaire activé par A : w.shrine avance', w.shrine === i2 && evs.some((ev) => ev.type === 'checkpoint' && ev.pid === a.id), `shrine=${w.shrine}`);
  check('le point de renaissance de B suit', b.spawnX === cp2.x && b.spawnY === cp2.y && b.checkpoint === i2);
  if (i2 > 1) {
    place(w, a, cps[1].x, cps[1].y);
    run(w, 2);
    check('un sanctuaire déjà dépassé ne recule pas le sanctuaire commun', w.shrine === i2 && a.spawnX === cp2.x);
  }
  const c = addPlayer(w, 'C', { color: 7 });
  check('arrivée en cours d\'étape au sanctuaire commun', c.x === cp2.x && c.y === cp2.y && c.checkpoint === i2 && c.spawnX === cp2.x && c.iframes === 120, `x=${c.x} iframes=${c.iframes}`);
  check('arrivée : couleur transmise', c.color === 7);

  // Départ de B alors qu'il a condamné un ennemi (iai), renvoyé un projectile et qu'un ennemi tient un jeton.
  const ex = b.x + 60;
  const e1 = spawnEnemy(w, 'ashigaru', ex, groundY(w, ex, b.y), false);
  doomEnemy(w, b, e1);
  const e2 = spawnEnemy(w, 'archer', ex + 80, groundY(w, ex + 80, b.y), false);
  takeToken(w, e2);
  w.projectiles.push({ id: w.nextId++, kind: 'arrow', x: b.x, y: b.y - 30, vx: 600, vy: 0, owner: 'player', ownerId: b.id, damage: 30, life: 60, hits: [], dead: false });
  removePlayer(w, b.id);
  let err = '';
  try {
    run(w, 300, scripted(5));
  } catch (x) {
    err = String(x);
  }
  check('départ en cours d\'étape sans erreur', err === '' && !w.players.some((p) => p.id === b.id), err);
  check('l\'ennemi condamné par le joueur parti meurt quand même', !w.enemies.some((e) => e.id === e1.id));
  check('w.shrine reste valide après le départ', w.shrine === i2 && w.shrine < w.level.checkpoints.length);
  check('jetons d\'attaque cohérents', w.attackTokens === w.enemies.filter((e) => e.token).length && w.attackTokens >= 0, `${w.attackTokens}`);
}

// ─── 4. Arène : tout le monde est amené, renaissance à l'entrée pendant le combat ─
{
  const w = createWorld(808, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  const c = addPlayer(w, 'C');
  for (const p of [a, b]) p.iframes = 1e6;
  const limit = (w.level.arena.col + 1) * TILE;
  kill(w, c);
  run(w, 1);
  warpToArena(w, a.id);
  const evs = run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  check('arène fermée', stateOf(w) === 'arena', stateOf(w));
  check('arène : B (vivant, resté au départ) est amené dans l\'arène', b.x > limit && b.vx === 0 && b.onGround, `x=${(b.x / TILE).toFixed(1)} col=${w.level.arena.col}`);
  check('arène : C (mort) reste là où il est tombé', c.x < limit && pState(c) === 'dead');
  const rsp = run(w, 200).concat(evs).find((ev) => ev.type === 'respawn' && ev.pid === c.id);
  check('arène : C renaît à l\'entrée de l\'arène', !!rsp && rsp.type === 'respawn' && rsp.x > limit && rsp.x < limit + 3 * TILE && stateOf(w) === 'arena', rsp && 'x' in rsp ? `x=${(rsp.x / TILE).toFixed(1)}` : 'pas de renaissance');
  check('arène : le point de renaissance (sanctuaire) n\'est pas modifié', c.spawnX < limit);

  // Salle vide pendant le combat : l'arène reste fermée ; un arrivant entre directement dans l'arène.
  for (const p of [...w.players]) removePlayer(w, p.id);
  run(w, 5);
  check('salle vide : l\'arène ne se réinitialise pas', stateOf(w) === 'arena' && w.enemies.some((e) => e.id === w.stage.guardianId));
  const d = addPlayer(w, 'D');
  check('arrivée pendant le combat : à l\'entrée de l\'arène', d.x > limit && d.iframes === 120, `x=${(d.x / TILE).toFixed(1)}`);
  // Toute la salle meurt : l'arène se rouvre (comme en solo).
  kill(w, d);
  run(w, 2);
  check('toute la salle morte dans l\'arène : elle se rouvre', stateOf(w) === 'playing');
}

// ─── 5. Bilan : passage automatique à l'étape suivante sans appui ───────────
{
  const w = createWorld(1234, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  for (const p of [a, b]) p.iframes = 1e6;
  w.shrine = 1;
  warpToArena(w, a.id);
  run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (g) killEnemy(w, g, a, 0, false);
  run(w, 2);
  a.x = w.level.gate.x - 60;
  a.y = w.level.gate.y;
  a.vx = 0;
  a.vy = 0;
  for (let i = 0; i < 200 && stateOf(w) !== 'cleared'; i++) run(w, 1, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  check('bilan atteint', stateOf(w) === 'cleared', stateOf(w));
  run(w, COOP_CLEARED_TICKS - 10);
  check('bilan : toujours affiché avant le délai', stateOf(w) === 'cleared');
  const evs = run(w, 12);
  check('bilan : étape suivante sans appui', stateOf(w) === 'playing' && w.level.stage === 1 && evs.some((ev) => ev.type === 'stageStart'), `état=${stateOf(w)} étape=${w.level.stage}`);
  check('nouvelle étape : sanctuaire commun remis à 0', w.shrine === 0 && w.players.every((p) => p.checkpoint === 0));

  // L'appui d'un joueur reste possible après 90 ticks.
  const w2 = createWorld(1234, { mode: 'coop' });
  addPlayer(w2, 'A');
  w2.stage.state = 'cleared';
  w2.stage.t = 0;
  run(w2, 95);
  run(w2, 1, () => BTN.JUMP);
  check('bilan : un appui fait repartir avant le délai', stateOf(w2) === 'playing' && w2.level.stage === 1);
}

// ─── 6. Aucun renfort n'apparaît à moins de 700 px d'un joueur vivant ───────
{
  const w = createWorld(2024, { mode: 'coop' });
  const ps = [0, 1, 2, 3].map((i) => addPlayer(w, `p${i}`));
  const x0 = w.level.spawn.x + 4 * TILE;
  const x1 = (w.level.arena.col - 6) * TILE;
  ps.forEach((p, i) => {
    place(w, p, x0 + ((x1 - x0) * i) / 3);
    p.iframes = 1e9;
    p.spawnX = p.x;
    p.spawnY = p.y;
  });
  const seen = new Set(w.enemies.map((e) => e.id));
  const bad: string[] = [];
  let spawned = 0;
  let peak = 0;
  const input = scripted(7);
  run(w, 9000, (t, id) => (t % 600 < 300 ? input(t, id) : 0), (w) => {
    for (const p of w.players) p.iframes = 1e9;
    if (w.tick % 2000 === 0 && w.wave.phase === 'calm') w.wave.t = 1e6; // Marées fréquentes
    peak = Math.max(peak, w.enemies.length);
    for (const e of w.enemies) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!e.horde) continue;
      spawned++;
      const near = w.players.filter((p) => p.state !== 'dead' && Math.abs(p.x - e.x) < COOP.SPAWN_SAFE);
      if (near.length) bad.push(`t=${w.tick} ${e.type}#${e.id} à ${Math.abs(near[0].x - e.x).toFixed(0)} px de p#${near[0].id}`);
    }
  });
  check('renforts apparus pendant la simulation', spawned > 10, `${spawned}`);
  check('aucun renfort à moins de 700 px d\'un joueur vivant', bad.length === 0, bad.slice(0, 3).join(' ; '));
  check('population plafonnée', peak <= COOP.POP_CAP + 8, `pic=${peak}`);
  // Jetons : plafond proportionnel aux joueurs vivants.
  let got = 0;
  for (let i = 0; i < 20; i++) {
    const e = spawnEnemy(w, 'ashigaru', ps[0].x, ps[0].y, false);
    if (takeToken(w, e)) got++;
  }
  const alive = w.players.filter((p) => p.state !== 'dead').length;
  check('jetons d\'attaque : plafond × joueurs vivants', w.attackTokens === ENEMY.MAX_ATTACKERS * alive && got > 0, `jetons=${w.attackTokens} vivants=${alive}`);
}

// ─── 7. Solo strictement identique ──────────────────────────────────────────
{
  const mk = (explicit: boolean) => {
    const w = explicit ? createWorld(77, { mode: 'solo' }) : createWorld(77);
    addPlayer(w, 'solo');
    return w;
  };
  const w1 = mk(false);
  const w2 = mk(true);
  const in1 = scripted(3);
  const in2 = scripted(3);
  const e1 = run(w1, 3000, in1);
  const e2 = run(w2, 3000, in2);
  check('solo : mode par défaut = solo', w1.mode === 'solo');
  check('solo : même état après 3000 ticks', JSON.stringify(w1) === JSON.stringify(w2) && JSON.stringify(e1) === JSON.stringify(e2));
  // En solo, les vies comptent toujours.
  const w = mk(false);
  const p = w.players[0];
  kill(w, p);
  check('solo : une mort coûte une vie', p.lives === 4 && w.shrine === 0);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests coop passent.');
