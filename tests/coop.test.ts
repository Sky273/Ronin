// Tests des règles du mode coopératif (simulation, sans réseau).
// Lancer : npm run test:coop
import { COOP, COOP_CLEARED_TICKS, ENEMY, PLAYER, TICK_RATE, TILE } from '../shared/constants';
import { findGround, spawnEnemy, targetPlayer } from '../shared/enemy';
import { BTN } from '../shared/input';
import { damagePlayer, doomEnemy, killEnemy, takeToken } from '../shared/interactions';
import { Rng } from '../shared/math';
import type { GameEvent, Player, World } from '../shared/types';
import { clearBonus, type DifficultyId, guardianHpScale } from '../shared/difficulty';
import { emptyUpgrades } from '../shared/upgrades';
import { T_KEKKAI } from '../shared/level';
import { addPlayer, createWorld, nextStage, removePlayer, resetWorld, stepWorld, warpToArena } from '../shared/world';

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

// ─── 4. Arène : kekkai à sens unique, renaissance à l'entrée pendant le combat ─
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
  const bx0 = b.x;
  check('arène : B (vivant, resté dehors) n\'est pas déplacé', b.x === bx0 && b.x < limit, `x=${(b.x / TILE).toFixed(1)} col=${w.level.arena.col}`);
  check('arène : la barrière est un kekkai (tuile à sens unique)', w.level.tiles[10 * w.level.w + w.level.arena.col] === T_KEKKAI);
  check('arène : C (mort) reste là où il est tombé', c.x < limit && pState(c) === 'dead');
  const rsp = run(w, 200).concat(evs).find((ev) => ev.type === 'respawn' && ev.pid === c.id);
  check('arène : C renaît à l\'entrée de l\'arène', !!rsp && rsp.type === 'respawn' && rsp.x > limit && rsp.x < limit + 3 * TILE && stateOf(w) === 'arena', rsp && 'x' in rsp ? `x=${(rsp.x / TILE).toFixed(1)}` : 'pas de renaissance');
  check('arène : le point de renaissance (sanctuaire) n\'est pas modifié', c.spawnX < limit);
  // B rejoint le combat quand il veut : il traverse le kekkai vers l'intérieur…
  b.x = limit - 2 * TILE;
  b.y = findGround(w.level, b.x, b.y) ?? b.y;
  b.vx = b.vy = 0;
  let entered = -1;
  for (let i = 0; i < 60 && entered < 0; i++) {
    run(w, 1, (_t, id) => (id === b.id ? BTN.RIGHT : 0));
    if (b.x - b.w / 2 > limit) entered = i;
  }
  check('arène : B entre en traversant le kekkai', entered >= 0, `${entered} ticks`);
  // … mais n'en ressort plus.
  let minLeft = Infinity;
  for (let i = 0; i < 120; i++) {
    run(w, 1, (_t, id) => (id === b.id ? (i % 30 < 20 ? BTN.LEFT : BTN.LEFT | BTN.DASH) : 0));
    minLeft = Math.min(minLeft, b.x - b.w / 2);
  }
  check('arène : impossible d\'en ressortir (course et dash vers la gauche)', minLeft >= limit - 0.5, `bord gauche ${(minLeft - limit).toFixed(2)} px du kekkai`);

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

  /** Monde coop de n joueurs placé directement au bilan (st.t = 0). */
  const atClear = (n: number) => {
    const w = createWorld(1234, { mode: 'coop' });
    const ps = Array.from({ length: n }, (_, i) => addPlayer(w, `p${i}`));
    w.stage.state = 'cleared';
    w.stage.t = 0;
    return { w, ps };
  };
  /** Un tick où seuls les joueurs listés appuient sur JUMP. */
  const press = (w: World, who: Player[]) => run(w, 1, (_t, id) => (who.some((p) => p.id === id) ? BTN.JUMP : 0));

  // Seul : son appui suffit (après 90 ticks).
  {
    const { w } = atClear(1);
    run(w, 95);
    run(w, 1, () => BTN.JUMP);
    check('bilan : un appui fait repartir avant le délai', stateOf(w) === 'playing' && w.level.stage === 1);
  }
  // À 4 joueurs : il faut une majorité stricte (3 votes).
  {
    const { w, ps } = atClear(4);
    run(w, 95);
    press(w, [ps[0]]);
    const after1 = stateOf(w);
    const ready0 = w.stage.byPlayer?.[ps[0].id]?.ready === true;
    press(w, [ps[0], ps[1]]);
    const after2 = stateOf(w);
    const evs = press(w, [ps[0], ps[1], ps[2]]);
    check('bilan à 4 : 1 vote ne suffit pas (et il est enregistré)', after1 === 'cleared' && ready0, after1);
    check('bilan à 4 : 2 votes ne suffisent pas', after2 === 'cleared', after2);
    check('bilan à 4 : le 3e vote fait passer au tick même', stateOf(w) === 'playing' && w.level.stage === 1 && evs.some((ev) => ev.type === 'stageStart'));
  }
  // À 4 joueurs, le vote est définitif : relâcher puis rappuyer ne l'annule pas.
  {
    const { w, ps } = atClear(4);
    run(w, 95);
    press(w, [ps[0]]);
    run(w, 3);
    press(w, [ps[1]]);
    run(w, 3);
    press(w, [ps[2]]);
    check('bilan à 4 : votes successifs cumulés (non annulés)', stateOf(w) === 'playing');
  }
  // Un appui avant t = 90 est ignoré (front montant seulement : le tenir ensuite ne compte pas).
  {
    const { w, ps } = atClear(1);
    run(w, 50);
    run(w, 70, () => BTN.JUMP); // appui à t = 51, tenu jusqu'à t = 120
    check('bilan : un appui avant 90 ticks est ignoré', stateOf(w) === 'cleared' && w.stage.byPlayer?.[ps[0].id]?.ready === false, `t=${w.stage.t}`);
    run(w, 1);
    press(w, ps);
    check('bilan : un nouvel appui après 90 ticks fait repartir', stateOf(w) === 'playing');
  }
  // Sans appui : passage à 480 ticks exactement.
  {
    const { w } = atClear(3);
    run(w, COOP_CLEARED_TICKS - 1);
    const before = stateOf(w);
    run(w, 1);
    check('bilan sans appui : encore affiché à 479, passage à 480', before === 'cleared' && stateOf(w) === 'playing', `${before} → ${stateOf(w)}`);
  }
  // Un arrivant pendant le bilan compte dans les joueurs présents.
  {
    const { w, ps } = atClear(2);
    run(w, 95);
    press(w, [ps[0]]);
    const c = addPlayer(w, 'C');
    const d = addPlayer(w, 'D');
    press(w, [ps[0], ps[1]]);
    const with4 = stateOf(w);
    check('bilan : un arrivant a sa fiche (non prêt)', w.stage.byPlayer?.[c.id]?.ready === false);
    press(w, [ps[0], ps[1], d]);
    check('bilan : les arrivants comptent (2 votes sur 4 ne suffisent pas, 3 oui)', with4 === 'cleared' && stateOf(w) === 'playing', with4);
  }
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
      // Le gardien (PV × 2,5 à 4 joueurs) est ramené à ses PV de base : ce test porte sur les
      // renforts, il faut que l'arène se termine pour que la horde reprenne à l'étape suivante.
      if (e.type === 'boss') e.hp = e.maxHp = Math.round(e.maxHp / (1 + COOP.GUARDIAN_HP_PER_PLAYER * (w.players.length - 1)));
      if (!e.horde) continue;
      spawned++;
      const near = w.players.filter((p) => p.state !== 'dead' && Math.abs(p.x - e.x) < COOP.SPAWN_SAFE);
      if (near.length) bad.push(`t=${w.tick} ${e.type}#${e.id} à ${Math.abs(near[0].x - e.x).toFixed(0)} px de p#${near[0].id}`);
    }
  });
  // Des renforts apparaissent (l'arène, où il n'y en a pas, peut occuper une partie de la simulation).
  check('renforts apparus pendant la simulation', spawned > 5, `${spawned}`);
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

// ─── 8. Toute la salle meurt d'un coup hors arène : pas de fin, tous renaissent ─
{
  const w = createWorld(31, { mode: 'coop' });
  const ps = [0, 1, 2].map((i) => addPlayer(w, `p${i}`, { color: i }));
  const cp = w.level.checkpoints[1];
  w.shrine = 1;
  for (const p of ps) {
    p.checkpoint = 1;
    p.spawnX = cp.x;
    p.spawnY = cp.y;
  }
  ps.forEach((p, i) => place(w, p, cp.x + 1500 + i * 40, cp.y));
  w.wave = { n: 1, phase: 'tide', t: 0, kills: 0, quota: 1000 };
  const nearShrine = spawnEnemy(w, 'ashigaru', cp.x + 150, groundY(w, cp.x + 150, cp.y), false);
  nearShrine.state = 'patrol';
  for (const p of ps) kill(w, p);
  const seen = new Set(w.enemies.map((e) => e.id));
  let spawnedWhileDead = 0;
  let err = '';
  let evs: GameEvent[] = [];
  try {
    evs = run(w, 200, () => 0, (w) => {
      const anyAlive = w.players.some((p) => p.state !== 'dead');
      for (const e of w.enemies) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (e.horde && !anyAlive) spawnedWhileDead++;
      }
    });
  } catch (x) {
    err = String(x);
  }
  const rsp = evs.filter((ev) => ev.type === 'respawn');
  check('salle entière morte hors arène : aucune exception, jamais over', err === '' && !w.over && !evs.some((ev) => ev.type === 'gameOver'), err);
  check('salle entière morte : les trois joueurs renaissent', rsp.length === 3 && ps.every((p) => pState(p) !== 'dead'), `${rsp.length} renaissances`);
  check('salle entière morte : renaissance au sanctuaire commun', ps.every((p) => Math.abs(p.x - cp.x) < 40), ps.map((p) => (p.x - cp.x).toFixed(0)).join(','));
  check('salle entière morte : la Marée continue', w.wave.phase === 'tide' && !evs.some((ev) => ev.type === 'tideEnd'), w.wave.phase);
  check('salle entière morte : aucun renfort pendant que personne ne vit', spawnedWhileDead === 0, `${spawnedWhileDead}`);
  check('salle entière morte : l\'ennemi près du sanctuaire (loin de tout vivant) est dissipé', !w.enemies.some((e) => e.id === nearShrine.id));
  check('salle entière morte : vies intactes, personne sorti', ps.every((p) => p.lives === 5 && !p.out));
}

// ─── 9. Le dernier joueur part pendant l'arène ; salle vide longtemps ; un nouveau arrive ─
{
  const w = createWorld(808, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  for (const p of [a, b]) p.iframes = 1e6;
  warpToArena(w, a.id);
  run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  const gid = w.stage.guardianId;
  check('arène fermée avant le départ', stateOf(w) === 'arena' && gid > 0);
  removePlayer(w, b.id);
  removePlayer(w, a.id);
  let err = '';
  try {
    run(w, 900);
  } catch (x) {
    err = String(x);
  }
  const g = w.enemies.find((e) => e.id === gid);
  check('salle vide 900 ticks pendant l\'arène : aucune exception, arène toujours fermée', err === '' && stateOf(w) === 'arena', err || stateOf(w));
  check('salle vide : le gardien attend, valeurs finies', !!g && nonFinite(w).length === 0, nonFinite(w).slice(0, 3).join(' ; '));
  check('salle vide : aucun renfort, Marée figée', w.enemies.every((e) => !e.horde || e.id === gid) && w.wave.phase === 'calm');
  const d = addPlayer(w, 'D', { color: 3 });
  const limit = (w.level.arena.col + 1) * TILE;
  check('nouvel arrivant : à l\'entrée de l\'arène, son sanctuaire reste dehors', d.x > limit && d.spawnX < limit && d.iframes === COOP.JOIN_IFRAMES);
  if (g) killEnemy(w, g, d, 0, false);
  const evs = run(w, 60);
  check('le nouvel arrivant peut finir le combat : porte ouverte', stateOf(w) === 'gateOpen' && evs.some((ev) => ev.type === 'gateOpen'), stateOf(w));
  // Salle vide pendant la porte ouverte : toujours sans erreur.
  removePlayer(w, d.id);
  err = '';
  try {
    run(w, 300);
    const e = addPlayer(w, 'E');
    run(w, 30);
    removePlayer(w, e.id);
    run(w, 30);
  } catch (x) {
    err = String(x);
  }
  check('salle vide pendant la porte ouverte : aucune exception, porte toujours ouverte', err === '' && stateOf(w) === 'gateOpen', err || stateOf(w));
}

// ─── 10. Sanctuaire commun et changement d'étape ────────────────────────────
{
  const w = createWorld(55, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  a.iframes = 1e6;
  const cps0 = w.level.checkpoints;
  const hi = cps0.length - 1;
  a.x = cps0[hi].x;
  a.y = cps0[hi].y;
  a.vx = 0;
  a.vy = 0;
  run(w, 2);
  check('étape 0 : sanctuaire le plus avancé activé', w.shrine === hi, `${w.shrine}`);
  kill(w, b); // B est mort au moment du changement d'étape
  nextStage(w);
  w.events.length = 0;
  const L = w.level;
  check('nouvelle étape : sanctuaire commun remis à 0, renaissance au départ du nouveau niveau', w.shrine === 0 && [a, b].every((p) => p.checkpoint === 0 && p.spawnX === L.spawn.x && p.spawnY === L.spawn.y));
  check('nouvelle étape : le joueur mort au changement d\'étape repart vivant', pState(b) !== 'dead' && b.hp === b.maxHp && b.x === L.spawn.x, pState(b));
  const c = addPlayer(w, 'C');
  check('arrivée après le changement : départ du nouveau niveau', c.x === L.spawn.x && c.y === L.spawn.y && c.checkpoint === 0);
  // Le sanctuaire 1 du nouveau niveau s'active, alors que l'ancien index était plus élevé.
  a.iframes = 1e6;
  place(w, a, L.checkpoints[1].x, L.checkpoints[1].y);
  const evs = run(w, 2);
  check('nouvelle étape : le sanctuaire 1 s\'active pour toute la salle', w.shrine === 1 && evs.some((ev) => ev.type === 'checkpoint' && ev.index === 1) && [a, b, c].every((p) => p.spawnX === L.checkpoints[1].x), `shrine=${w.shrine}`);
  // Mort après le changement : on renaît au sanctuaire du NOUVEAU niveau.
  kill(w, b);
  const rsp = run(w, 200).find((ev) => ev.type === 'respawn' && ev.pid === b.id);
  check('mort après le changement : renaissance au sanctuaire du nouveau niveau', !!rsp && Math.abs(b.x - L.checkpoints[1].x) < 40, `x=${b.x.toFixed(0)}`);
}

// ─── 11. Arrivée pendant le bilan, joueur mort pendant le bilan ─────────────
{
  const w = createWorld(1234, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  a.iframes = 1e6;
  w.shrine = 2;
  for (const p of [a, b]) {
    p.checkpoint = 2;
    p.spawnX = w.level.checkpoints[2].x;
    p.spawnY = w.level.checkpoints[2].y;
  }
  warpToArena(w, a.id);
  run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (g) killEnemy(w, g, a, 0, false);
  run(w, 2);
  a.x = w.level.gate.x - 60;
  a.y = w.level.gate.y;
  a.vx = 0;
  a.vy = 0;
  // Chacun a progressé : A (vivant) doit tout garder, B (mort au passage) doit tout perdre.
  for (const p of [a, b]) {
    p.up.parry = 2;
    p.maxHp = 140;
    p.kills = 7;
  }
  b.honor = 900;
  b.level = 4;
  b.picks = 2;
  b.offer = ['parry'];
  const aUp = JSON.stringify(a.up);
  kill(w, b); // B meurt juste avant la victoire
  for (let i = 0; i < 200 && stateOf(w) !== 'cleared'; i++) run(w, 1, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  check('bilan atteint (B mort)', stateOf(w) === 'cleared' && pState(b) === 'dead', `${stateOf(w)} ${pState(b)}`);
  run(w, 100);
  const tBefore = w.stage.t;
  let err = '';
  let c: Player | null = null;
  try {
    c = addPlayer(w, 'C', { color: 5 });
  } catch (x) {
    err = String(x);
  }
  const cp2 = w.level.checkpoints[2];
  check('arrivée pendant le bilan : au sanctuaire commun, invulnérable', err === '' && !!c && c.x === cp2.x && c.y === cp2.y && c.iframes === COOP.JOIN_IFRAMES, err);
  check('arrivée pendant le bilan : le compte à rebours n\'est pas relancé', w.stage.t === tBefore);
  const evs = run(w, COOP_CLEARED_TICKS - tBefore + 2, (_t, id) => (c && id === c.id ? BTN.PICK1 : 0));
  const L = w.level;
  check('bilan : passage seul malgré un mort et un arrivant', stateOf(w) === 'playing' && L.stage === 1 && evs.filter((ev) => ev.type === 'stageStart').length === 1, `${stateOf(w)} étape=${L.stage}`);
  check('après le bilan : tout le monde au départ, vivant (B compris)', [a, b, c!].every((p) => p.x === L.spawn.x && pState(p) !== 'dead' && p.hp === p.maxHp), [a, b, c!].map((p) => pState(p)).join(','));
  check('après le bilan : aucune valeur non finie', nonFinite(w).length === 0, nonFinite(w).slice(0, 3).join(' ; '));
  check(
    'mort au passage d’étape : B repart comme après une renaissance',
    JSON.stringify(b.up) === JSON.stringify(emptyUpgrades()) && b.honor === 0 && b.level === 0 && b.picks === 0 && b.offer.length === 0 && b.maxHp === PLAYER.MAX_HP && b.hp === PLAYER.MAX_HP && b.kills === 0,
    `up.parry=${b.up.parry} honneur=${b.honor} niveau=${b.level} picks=${b.picks} offre=${b.offer.length} maxHp=${b.maxHp} kills=${b.kills}`,
  );
  check('passage d’étape : A (vivant) garde ses améliorations', JSON.stringify(a.up) === aUp && a.maxHp === 140 && a.hp === 140 && a.kills >= 7, `maxHp=${a.maxHp} kills=${a.kills}`);
}

// ─── 12. Honneur perdu ramassé par un autre joueur : le repère du mort disparaît ─
{
  const w = createWorld(31, { mode: 'coop' });
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  w.enemies = [];
  const cp = w.level.checkpoints[1];
  a.spawnX = w.level.spawn.x; // A renaîtra loin du lieu de sa mort
  a.spawnY = w.level.spawn.y;
  place(w, a, cp.x + 300, cp.y);
  place(w, b, cp.x + 300, cp.y);
  b.iframes = 1e9;
  a.honor = 200;
  w.spawnTimer = 1e9; // pas de renfort pendant le test
  kill(w, a);
  const dropped = w.orbs.filter((o) => o.lost).length;
  check('mort en coop : Honneur laissé au sol, repère posé', dropped > 0 && Number.isFinite(a.lostX), `${dropped} orbes`);
  run(w, 400, () => 0, (w) => {
    b.iframes = 1e9;
    w.spawnTimer = 1e9;
  });
  const left = w.orbs.filter((o) => o.lost).length;
  check('B a ramassé tout l\'Honneur perdu de A', left === 0 && pState(a) !== 'dead', `${left} restantes`);
  check('plus aucun Honneur au sol : le repère de A disparaît (lostX = NaN)', Number.isNaN(a.lostX), `lostX=${a.lostX}`);
}

// ─── 13. Solo : empreintes de référence calculées avec la simulation de 60fb237 ─
// Toute modification de la simulation solo change ces empreintes : c'est voulu (le solo
// doit rester strictement identique tant qu'on ne le modifie pas exprès).
{
  const soloFingerprint = (seed: number, difficulty: DifficultyId, nPlayers: number, ticks: number): string => {
    const w = createWorld(seed, { difficulty });
    for (let i = 0; i < nPlayers; i++) addPlayer(w, 'p' + i, { color: i });
    let s = (seed * 31 + nPlayers) >>> 0 || 1;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const moves = [0, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT | BTN.ATTACK, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.DASH | BTN.RIGHT, BTN.PARRY, BTN.IAI, BTN.DOWN, BTN.PICK1, BTN.PICK2, BTN.UP | BTN.ATTACK, BTN.JUMP | BTN.ATTACK];
    const held = new Map<number, [number, number]>();
    const m = new Map<number, number>();
    let h = 0x811c9dc5;
    const feed = (str: string) => {
      for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    };
    // w.shrine (champ coop) est exclu : il n'existait pas dans la version de référence.
    const state = () => JSON.stringify({ ...w, shrine: undefined });
    for (let t = 0; t < ticks; t++) {
      if (t % 2300 === 350) for (const p of w.players) if (p.state !== 'dead') kill(w, p);
      if (t % 3000 === 1500) warpToArena(w);
      if (t % 3000 === 1700 && stateOf(w) === 'arena') {
        const g = w.enemies.find((e) => e.id === w.stage.guardianId);
        if (g) killEnemy(w, g, w.players[0], 0, false);
      }
      if (t % 3000 === 1760 && w.players[0]) {
        w.players[0].x = w.level.gate.x - 40;
        w.players[0].y = w.level.gate.y;
      }
      if (t % 60 === 0) for (const p of w.players) if (p.state !== 'dead') p.hp = p.maxHp;
      if (t % 3000 === 600 || t % 3000 === 1100) {
        const cps = w.level.checkpoints;
        const c = cps[1 + (((t / 500) | 0) % Math.max(1, cps.length - 1))] ?? cps[0];
        const p = w.players[w.players.length - 1];
        if (p && p.state !== 'dead' && stateOf(w) === 'playing') {
          p.x = c.x;
          p.y = c.y;
        }
      }
      m.clear();
      for (const p of w.players) {
        let k = held.get(p.id);
        if (!k || t >= k[1]) {
          k = [moves[Math.floor(rnd() * moves.length)], t + 3 + Math.floor(rnd() * 25)];
          held.set(p.id, k);
        }
        m.set(p.id, stateOf(w) === 'cleared' && t % 200 === 0 ? BTN.JUMP : k[0]);
      }
      stepWorld(w, m);
      if (w.events.length) feed(t + JSON.stringify(w.events));
      w.events.length = 0;
      if (t % 500 === 0) feed(state());
    }
    feed(state());
    return `${h.toString(16)} étape=${w.level.stage} over=${w.over}`;
  };
  const golden: [number, DifficultyId, number, number, string][] = [
    [4242, 'normal', 1, 9000, 'f54fa7a9 étape=2 over=false'],
    [7, 'veryEasy', 2, 9000, 'e4940a1b étape=3 over=false'],
    [99991, 'hard', 1, 6000, 'e2e14bbb étape=2 over=true'],
  ];
  for (const [seed, diff, n, ticks, want] of golden) {
    const got = soloFingerprint(seed, diff, n, ticks);
    check(`solo identique à 60fb237 (graine ${seed}, ${diff}, ${n} joueur(s), ${ticks} ticks)`, got === want, `obtenu ${got}, attendu ${want}`);
  }
}

// ─── 14. Auteur des événements de combat : pid en coop, clé absente en solo ──
{
  const COMBAT = new Set(['hit', 'block', 'deflect', 'guardBreak', 'windSlash']);
  const collect = (mode: 'solo' | 'coop'): { out: GameEvent[]; ids: Set<number> } => {
    const w = createWorld(11, { mode, difficulty: 'veryEasy' });
    const n = mode === 'coop' ? 3 : 1;
    for (let i = 0; i < n; i++) addPlayer(w, `p${i}`, { color: i });
    const input = scripted(99);
    const m = new Map<number, number>();
    const out: GameEvent[] = [];
    for (let t = 0; t < 6000; t++) {
      for (const p of w.players) m.set(p.id, input(t, p.id));
      stepWorld(w, m);
      for (const ev of w.events) if (COMBAT.has(ev.type)) out.push(ev);
      w.events.length = 0;
    }
    return { out, ids: new Set(w.players.map((p) => p.id)) };
  };
  const coop = collect('coop');
  const solo = collect('solo');
  const pidOf = (ev: GameEvent): unknown => (ev as { pid?: unknown }).pid;
  check(
    'coop : chaque événement de combat porte le pid de son auteur',
    coop.out.length > 0 && coop.out.every((ev) => typeof pidOf(ev) === 'number' && coop.ids.has(pidOf(ev) as number)),
    `${coop.out.length} événements`,
  );
  check('solo : aucun événement de combat ne porte de clé pid', solo.out.length > 0 && solo.out.every((ev) => !('pid' in ev)), `${solo.out.length} événements`);
}

// ─── 15. Kekkai à sens unique (coop) ─────────────────────────────────────────
{
  /** Monde coop avec l'arène fermée par `a` (gardien figé loin), renforts coupés. */
  const sealed = (seed: number) => {
    const w = createWorld(seed, { mode: 'coop' });
    w.spawnTimer = 1e9;
    w.wave.t = -1e9;
    const a = addPlayer(w, 'A');
    const b = addPlayer(w, 'B');
    a.iframes = b.iframes = 1e9;
    warpToArena(w, a.id);
    run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
    const g = w.enemies.find((e) => e.id === w.stage.guardianId);
    if (g) g.freeze = 1e9; // le gardien ne gêne pas les mesures
    return { w, a, b, g, limit: (w.level.arena.col + 1) * TILE };
  };

  // K1. Entrées aléatoires (course, dash, saut, iai, glissade…) depuis l'intérieur : jamais dehors.
  {
    let worst = Infinity;
    let sealedOk = true;
    for (let seed = 1; seed <= 20; seed++) {
      const { w, a, limit } = sealed(500 + seed);
      sealedOk &&= stateOf(w) === 'arena';
      const input = scripted(seed);
      const moves = [BTN.LEFT, BTN.LEFT | BTN.DASH, BTN.LEFT | BTN.JUMP, BTN.IAI, BTN.LEFT | BTN.DOWN, BTN.LEFT | BTN.ATTACK];
      run(w, 3000, (t, id) => (id === a.id ? (t % 90 < 45 ? moves[(t / 90) % moves.length | 0] : input(t, id)) : 0), (w) => {
        if (stateOf(w) === 'arena') worst = Math.min(worst, a.x - a.w / 2 - limit);
      });
    }
    check('kekkai : arène fermée dans les 20 parties', sealedOk);
    check('kekkai : 20 × 3000 ticks d’entrées aléatoires depuis l’intérieur, jamais ressorti', worst >= -0.5, `marge minimale ${worst.toFixed(2)} px`);
  }

  // K3. Un ennemi resté dehors ne franchit pas le kekkai, même en poursuivant quelqu'un à l'intérieur.
  {
    const { w, a, b, limit } = sealed(77);
    removePlayer(w, b.id);
    a.x = limit + 2 * TILE;
    const e = spawnEnemy(w, 'ashigaru', limit - 3 * TILE, a.y, false);
    let maxRight = -Infinity;
    run(w, 600, () => 0, () => (maxRight = Math.max(maxRight, e.x + e.w / 2)));
    check('kekkai : un ennemi resté dehors ne le franchit pas', maxRight <= limit - TILE + 0.5, `bord droit ${(maxRight - (limit - TILE)).toFixed(1)} px de la barrière`);
  }

  // K4. Une flèche tirée sur la barrière s'y brise, des deux côtés.
  {
    for (const side of [-1, 1] as const) {
      const { w, limit } = sealed(91);
      const col = w.level.arena.col;
      const x = side < 0 ? (col - 2) * TILE : (col + 3) * TILE;
      w.projectiles.push({ id: w.nextId++, kind: 'arrow', x, y: 10 * TILE, vx: -side * 600, vy: 0, owner: 'enemy', ownerId: 0, damage: 10, life: 200, hits: [], dead: false });
      const evs = run(w, 30);
      const a0 = w.projectiles.find((q) => q.kind === 'arrow');
      check(`kekkai : flèche venue ${side < 0 ? 'de dehors' : 'de dedans'} brisée sur la barrière`, !a0 && evs.some((ev) => ev.type === 'arrowBreak' && Math.abs(ev.x - (col + 0.5) * TILE) < TILE * 1.5), `${limit}`);
    }
  }

  // K5 et A2. Plus personne vivant dedans alors que B attend dehors : l'arène se rouvre, tuiles d'origine.
  {
    const { w, a, b } = sealed(123);
    const col = w.level.arena.col;
    const backup = w.level.arena.backup;
    kill(w, a);
    const evs = run(w, 2);
    check('arène : plus personne vivant dedans → elle se rouvre (B dehors n’est pas touché)', stateOf(w) === 'playing' && evs.some((ev) => ev.type === 'arenaReset') && pState(b) !== 'dead');
    check('arène : le gardien est retiré', !w.enemies.some((e) => e.type === 'boss'));
    let same = true;
    for (let r = 0; r < w.level.arena.rows; r++) same &&= w.level.tiles[r * w.level.w + col] === backup[r];
    check('kekkai : tuiles d’origine restaurées à la réouverture', same);
  }

  // A4. Le gardien ne vise jamais un joueur resté dehors.
  {
    const { w, a, b, g } = sealed(321);
    check('gardien : vise le joueur de l’arène', !!g && targetPlayer(w, g)?.id === a.id);
    kill(w, a);
    // Avant la réouverture (même pas) : avec a mort, personne dedans à viser.
    check('gardien : ne vise pas B resté dehors', !!g && targetPlayer(w, g) === null && b.x < (w.level.arena.col + 1) * TILE);
  }

  // Solo : la barrière reste un mur plein.
  {
    const w = createWorld(808);
    const p = addPlayer(w, 'solo');
    warpToArena(w, p.id);
    run(w, 30, () => BTN.RIGHT);
    check('solo : barrière pleine (T_SOLID), pas de kekkai', stateOf(w) === 'arena' && w.level.tiles[10 * w.level.w + w.level.arena.col] !== T_KEKKAI);
  }
}

// ─── 16. Statistiques par joueur : la somme des fiches égale les compteurs de l'étape ─
{
  const w = createWorld(4242, { mode: 'coop' });
  const ps = [0, 1, 2, 3].map((i) => addPlayer(w, `p${i}`, { color: i }));
  ps.forEach((p, i) => place(w, p, w.level.spawn.x + i * 60));
  const input = scripted(17);
  let parried = 0;
  let stage0 = true;
  for (let t = 0; t < 4000 && stage0; t++) {
    if (t % 300 === 120) kill(w, ps[t % 4]);
    // Parade forcée de temps en temps (face à l'attaque, dans la fenêtre).
    if (t % 400 === 50) {
      const p = ps[(t / 400) % 4 | 0];
      if (p.state !== 'dead') {
        p.state = 'parry';
        p.stateT = 0;
        if (damagePlayer(w, p, 10, p.x + p.facing * 20) === 'parried') parried++;
      }
    }
    run(w, 1, input);
    stage0 = w.level.stage === 0;
  }
  const st = w.stage;
  const by = st.byPlayer ?? {};
  const sum = (k: 'kills' | 'deaths' | 'parries' | 'honor') => Object.values(by).reduce((s, x) => s + x[k], 0);
  const info = (['kills', 'deaths', 'parries', 'honor'] as const).map((k) => `${k} ${sum(k)}/${st[k]}`).join(' ');
  check('S1 : une fiche par joueur présent', Object.keys(by).length === 4 && ps.every((p) => !!by[p.id]));
  check('S1 : partie significative (éliminations, morts, parades, Honneur)', st.kills > 0 && st.deaths > 0 && parried > 0 && st.honor > 0, info);
  check('S1 : Σ fiches = compteurs de l\'étape (kills, deaths, parries, honor)', (['kills', 'deaths', 'parries', 'honor'] as const).every((k) => sum(k) === st[k]), info);
  check('S1 : meilleur combo global = max des fiches', Math.max(...Object.values(by).map((x) => x.bestCombo)) === st.bestCombo, `${st.bestCombo}`);
}

// ─── 17. Note individuelle, note médiane de la salle et bonus de chacun ─────
{
  /** Coop à n joueurs, porte ouverte ; deaths[i] morts pour le joueur i ; renvoie le monde au bilan. */
  const clearWith = (deaths: number[], slow = false) => {
    const w = createWorld(1234, { mode: 'coop' });
    const ps = deaths.map((_, i) => addPlayer(w, `p${i}`));
    w.enemies = [];
    w.spawnTimer = 1e9;
    w.stage.state = 'gateOpen';
    if (slow) w.stage.startTick = w.tick - 6 * 60 * TICK_RATE;
    ps.forEach((p, i) => {
      const s = w.stage.byPlayer![p.id];
      s.deaths = deaths[i];
      w.stage.deaths += deaths[i];
      p.iframes = 1e9;
    });
    const a = ps[0];
    a.x = w.level.gate.x - 60;
    a.y = w.level.gate.y;
    a.vx = a.vy = 0;
    let before = ps.map((p) => [p.honor, p.score]);
    let evs: GameEvent[] = [];
    for (let i = 0; i < 200 && stateOf(w) !== 'cleared'; i++) {
      before = ps.map((p) => [p.honor, p.score]);
      evs = run(w, 1, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
    }
    return { w, ps, before, clear: evs.find((ev) => ev.type === 'stageClear') };
  };
  const expected = (d: number, slow: boolean) => (d === 0 && !slow ? 0 : d <= 1 ? 1 : 2);
  const cases: [number[], boolean, number][] = [
    [[0, 1, 2], false, 1],
    [[0, 0, 2, 2], false, 0], // nombre pair : la meilleure des deux notes centrales
    [[2, 2, 0, 1, 2], false, 2],
    [[0], false, 0],
    [[0, 0, 1], true, 1], // plus de 6 min : aucun 優
  ];
  for (const [deaths, slow, median] of cases) {
    const { w, ps, before, clear } = clearWith(deaths, slow);
    const by = w.stage.byPlayer!;
    const label = `[${deaths.join(',')}]${slow ? ' lent' : ''}`;
    check(`S2 ${label} : bilan atteint`, stateOf(w) === 'cleared' && !!clear, stateOf(w));
    check(`S2 ${label} : note individuelle = formule`, ps.every((p, i) => by[p.id].grade === expected(deaths[i], slow)), ps.map((p) => by[p.id].grade).join(','));
    check(
      `S2 ${label} : note de la salle = médiane (st et stageClear)`,
      w.stage.grade === median && w.stage.bonus === clearBonus(median, 0) && !!clear && clear.type === 'stageClear' && clear.grade === median && clear.bonus === w.stage.bonus,
      `${w.stage.grade}`,
    );
    check(
      `S3 ${label} : chacun reçoit son bonus, en Honneur et en score`,
      ps.every((p, i) => {
        const b = clearBonus(expected(deaths[i], slow), 0);
        return by[p.id].bonus === b && p.honor - before[i][0] === b && p.score - before[i][1] === b && by[p.id].honor === b;
      }),
      ps.map((p, i) => `${p.honor - before[i][0]}/${by[p.id].bonus}`).join(' '),
    );
  }
}

// ─── 18. Points de vie du gardien selon les joueurs présents ────────────────
{
  const guardianAt = (n: number, deadOne: boolean) => {
    const w = createWorld(808, { mode: 'coop' });
    const ps = Array.from({ length: n }, (_, i) => addPlayer(w, `p${i}`));
    for (const p of ps) p.iframes = 1e9;
    if (deadOne && n > 1) kill(w, ps[n - 1]);
    warpToArena(w, ps[0].id);
    run(w, 30, (_t, id) => (id === ps[0].id ? BTN.RIGHT : 0));
    return { w, g: w.enemies.find((e) => e.id === w.stage.guardianId) };
  };
  const base = (w: World) => ENEMY.boss.hp * guardianHpScale(w);
  const one = guardianAt(1, false);
  check('S6 : à 1 joueur, PV de base du gardien', !!one.g && one.g.maxHp === Math.round(base(one.w)), `${one.g?.maxHp}`);
  const four = guardianAt(4, true);
  const want = Math.round(base(four.w) * (1 + 0.5 * 3));
  check('S6 : à 4 joueurs (un mort compris), PV × 2,5', stateOf(four.w) === 'arena' && !!four.g && four.g.maxHp === want, `${four.g?.maxHp} attendu ${want}`);
  const hp0 = four.g?.hp;
  addPlayer(four.w, 'E');
  run(four.w, 10);
  check('S6 : un 5e arrivant pendant le combat ne change rien', !!four.g && four.g.maxHp === want && four.g.hp === hp0, `${four.g?.maxHp}`);
}

// ─── 19. Cycle de vie des fiches ; solo sans fiche ──────────────────────────
{
  const w = createWorld(55, { mode: 'coop' });
  check('S7 : création coop → byPlayer vide', JSON.stringify(w.stage.byPlayer) === '{}');
  const ps = [0, 1, 2].map((i) => addPlayer(w, `p${i}`));
  const by0 = w.stage.byPlayer!;
  for (const p of ps) Object.assign(by0[p.id], { kills: 5, parries: 2, deaths: 1, honor: 40, bestCombo: 9, grade: 0, bonus: 150, ready: true });
  nextStage(w);
  const fresh = JSON.stringify({ kills: 0, parries: 0, deaths: 0, honor: 0, bestCombo: 0, grade: 2, bonus: 0, ready: false });
  const by = w.stage.byPlayer ?? {};
  check('S7 : après nextStage, une fiche vierge par joueur présent', Object.keys(by).length === 3 && ps.every((p) => JSON.stringify(by[p.id]) === fresh), JSON.stringify(by));
  removePlayer(w, ps[1].id);
  check('S7 : removePlayer retire la fiche', !(ps[1].id in by) && Object.keys(by).length === 2);
  resetWorld(w, 9, { mode: 'coop' });
  check('S7 : resetWorld coop → byPlayer vide', JSON.stringify(w.stage.byPlayer) === '{}' && w.players.length === 0);

  // Solo : la clé n'existe jamais (création, partie, étape suivante, arrivée, départ).
  const s = createWorld(77);
  const a = addPlayer(s, 'solo');
  let absent = !('byPlayer' in s.stage);
  run(s, 600, scripted(3), (s) => (absent &&= !('byPlayer' in s.stage)));
  nextStage(s);
  absent &&= !('byPlayer' in s.stage);
  const b = addPlayer(s, 'deux');
  removePlayer(s, b.id);
  absent &&= !('byPlayer' in s.stage) && s.players[0] === a;
  check('solo : byPlayer absent (\'byPlayer\' in w.stage === false)', absent);
}

// ─── 20. Kekkai : cas limites (à cheval, recul, iai, mur, ninja, gardien, orbes, cor) ─
{
  /** Monde coop, arène fermée par A, gardien figé ; renforts coupés. */
  const sealed = (seed: number) => {
    const w = createWorld(seed, { mode: 'coop' });
    w.spawnTimer = 1e9;
    w.wave.t = -1e9;
    const a = addPlayer(w, 'A');
    const b = addPlayer(w, 'B');
    a.iframes = b.iframes = 1e9;
    warpToArena(w, a.id);
    run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
    const g = w.enemies.find((e) => e.id === w.stage.guardianId)!;
    g.freeze = 1e9;
    const col = w.level.arena.col;
    return { w, a, b, g, col, limit: (col + 1) * TILE };
  };
  const putAt = (w: World, p: Player, x: number) => place(w, p, x, w.level.arena.guardianY);

  // K6. À cheval sur la colonne à la fermeture : B peut finir d'entrer, puis ne ressort plus.
  {
    let ok = true;
    const info: string[] = [];
    for (const off of [-12, 0, 12, 24]) {
      const w = createWorld(808, { mode: 'coop' });
      w.spawnTimer = 1e9;
      w.wave.t = -1e9;
      const a = addPlayer(w, 'A');
      const b = addPlayer(w, 'B');
      a.iframes = b.iframes = 1e9;
      const col = w.level.arena.col;
      const limit = (col + 1) * TILE;
      warpToArena(w, a.id);
      for (let i = 0; i < 40 && stateOf(w) !== 'arena'; i++) {
        putAt(w, b, col * TILE + 16 + off);
        run(w, 1, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
      }
      const locked = stateOf(w) === 'arena';
      run(w, 90, (_t, id) => (id === b.id ? BTN.RIGHT : 0));
      let minLeft = Infinity;
      run(w, 180, (t, id) => (id === b.id ? (t % 40 < 30 ? BTN.LEFT : BTN.LEFT | BTN.DASH) : 0), () => (minLeft = Math.min(minLeft, b.x - b.w / 2)));
      ok &&= locked && minLeft >= limit - 0.5;
      info.push(`${off}:${locked ? '' : 'non fermée '}${(minLeft - limit).toFixed(1)}`);
    }
    check('kekkai : à cheval à la fermeture, on finit d’entrer puis on ne ressort plus', ok, info.join(' '));
  }

  // K7. Recul d'un coup venu de l'intérieur (projeté vers la sortie) : on reste dedans.
  {
    let worst = Infinity;
    for (const dmg of [5, 25, 60]) {
      const { w, a, limit } = sealed(808);
      putAt(w, a, limit + a.w / 2 + 1);
      for (let i = 0; i < 5; i++) {
        a.iframes = 0;
        a.hp = a.maxHp;
        if (a.state !== 'dead') {
          a.state = 'normal';
          damagePlayer(w, a, dmg, a.x + 30);
        }
        run(w, 20, () => BTN.LEFT, () => (worst = Math.min(worst, a.x - a.w / 2 - limit)));
      }
    }
    check('kekkai : recul vers la sortie (5, 25, 60 dégâts), on reste dedans', worst >= -0.5, `marge ${worst.toFixed(2)} px`);
  }

  // K8. Iai chargé vers la gauche, à toutes les distances de la barrière (0 à 200 px).
  {
    let worst = Infinity;
    for (let d = 0; d <= 200; d += 5) {
      const { w, a, limit } = sealed(808);
      putAt(w, a, limit + a.w / 2 + 0.01 + d);
      a.facing = -1;
      run(w, 100, (t) => (t % 50 < 40 ? BTN.IAI | BTN.LEFT : BTN.LEFT), () => (worst = Math.min(worst, a.x - a.w / 2 - limit)));
    }
    check('kekkai : iai chargé vers la gauche, jamais dehors', worst >= -0.5, `marge ${worst.toFixed(2)} px`);
  }

  // K9. Saut mural, plongeon, dash et glissade contre la barrière depuis l'intérieur ; de dehors, pas de mur.
  {
    const { w, a, b, limit } = sealed(808);
    putAt(w, a, limit + 40);
    let worst = Infinity;
    let slid = false;
    const seq = [BTN.LEFT | BTN.JUMP, BTN.LEFT, BTN.LEFT | BTN.JUMP, BTN.RIGHT | BTN.JUMP, BTN.LEFT | BTN.DOWN | BTN.ATTACK, BTN.DOWN | BTN.ATTACK, BTN.LEFT | BTN.DASH, BTN.LEFT | BTN.DOWN];
    run(w, 2400, (t, id) => (id === a.id ? seq[((t / 7) | 0) % seq.length] : 0), () => {
      worst = Math.min(worst, a.x - a.w / 2 - limit);
      slid ||= a.wallDir === -1 && a.x < limit + 2 * TILE;
    });
    check('kekkai : saut mural, plongeon, dash, glissade depuis l’intérieur, jamais dehors', worst >= -0.5, `marge ${worst.toFixed(2)} px`);
    check('kekkai : depuis l’intérieur, la barrière sert de mur (glissade murale)', slid);
    putAt(w, b, limit - TILE - 60);
    let wallOut = false;
    run(w, 120, (t, id) => (id === b.id ? (t % 20 < 3 ? BTN.RIGHT | BTN.JUMP : BTN.RIGHT) : 0), () => (wallOut ||= b.wallDir === 1 && b.x < limit));
    check('kekkai : de dehors, aucune glissade murale dessus, B entre en sautant', !wallOut && b.x - b.w / 2 > limit, `x−limite ${(b.x - limit).toFixed(0)}`);
  }

  // K10. Ninja resté dehors, sa cible dehors juste devant la barrière : sa disparition ne le fait pas
  // réapparaître dans l'arène (le point « dans le dos » de la cible est de l'autre côté du kekkai).
  {
    const crossed: string[] = [];
    let tried = 0;
    for (const dx of [8, 12, 20]) {
      for (const facing of [-1, 1] as const) {
        const { w, b, col } = sealed(808);
        putAt(w, b, col * TILE - dx);
        b.facing = facing;
        const n = spawnEnemy(w, 'ninja', b.x - 90, b.y, false);
        n.state = 'chase';
        n.dodgeCd = 0;
        tried++;
        let maxRight = -Infinity;
        run(w, 120, () => 0, () => {
          b.facing = facing;
          if (w.enemies.includes(n)) maxRight = Math.max(maxRight, n.x + n.w / 2);
        });
        if (maxRight > col * TILE + 0.5) crossed.push(`dx ${dx} face ${facing} → x−limite ${(n.x - (col + 1) * TILE).toFixed(0)}, vise ${targetPlayer(w, n)?.name ?? '-'}`);
      }
    }
    check('kekkai : un ninja de dehors ne se téléporte jamais dans l’arène', crossed.length === 0, `${crossed.length}/${tried} : ${crossed.slice(0, 2).join(' ; ')}`);
  }

  // K11. Le gardien qui charge ou bondit vers la barrière ne la franchit jamais.
  {
    let worst = Infinity;
    for (let s = 0; s < 6; s++) {
      const { w, a, g, limit } = sealed(808 + s);
      g.freeze = 0;
      g.state = 'chase';
      putAt(w, a, limit + 30);
      run(w, 3000, (t, id) => (id === a.id ? (t % 120 < 60 ? BTN.LEFT : BTN.LEFT | BTN.JUMP) : 0), () => {
        if (w.enemies.includes(g)) worst = Math.min(worst, g.x - g.w / 2 - limit);
        a.hp = a.maxHp;
      });
    }
    check('kekkai : le gardien (charge, bond) reste dans l’arène', worst >= -0.5, `marge ${worst.toFixed(2)} px`);
  }

  // K12. Orbes : une orbe lancée vers la sortie s'arrête ; une orbe de l'arène n'est pas aspirée à travers.
  {
    const { w, a, b, limit } = sealed(808);
    putAt(w, a, limit + 600);
    putAt(w, b, limit - 600);
    w.orbs.push({ id: w.nextId++, x: limit + 10, y: a.y - 40, vx: -500, vy: -100, value: 3, life: 600, lost: false, onGround: false });
    let minX = Infinity;
    run(w, 60, () => 0, () => w.orbs.forEach((o) => (minX = Math.min(minX, o.x))));
    check('kekkai : une orbe lancée vers la sortie s’y arrête', minX >= limit - 3.5, `x−limite ${(minX - limit).toFixed(1)}`);

    const s2 = sealed(808);
    putAt(s2.w, s2.b, s2.col * TILE - 10);
    putAt(s2.w, s2.a, s2.limit + 400);
    s2.w.orbs.push({ id: s2.w.nextId++, x: s2.limit + 30, y: s2.b.y - 20, vx: 0, vy: 0, value: 7, life: 600, lost: false, onGround: false });
    const h0 = s2.b.honor;
    run(s2.w, 120);
    check('kekkai : une orbe de l’arène n’est pas aspirée par un joueur resté dehors', s2.b.honor === h0, `Honneur de B ${h0} → ${s2.b.honor}`);
  }

  // K13. Renforts du cor, gardien collé à la barrière : tous dans l'arène.
  {
    let worst = Infinity;
    let adds = 0;
    for (let s = 0; s < 30; s++) {
      const { w, g, limit } = sealed(900 + s);
      g.x = limit + 60 + (s % 5) * 10;
      g.freeze = 0;
      g.hp = Math.floor(g.maxHp * 0.3);
      const seen = new Set(w.enemies.map((e) => e.id));
      run(w, 600, () => 0, () => {
        for (const e of w.enemies) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          adds++;
          worst = Math.min(worst, e.x - e.w / 2 - limit);
        }
      });
    }
    check('cor : renforts tous entièrement dans l’arène', adds > 0 && worst >= 0, `${adds} renforts, marge ${worst.toFixed(1)} px`);
  }
}

// K14. Ninja déjà disparu (destination dans l'arène choisie avant la fermeture) : il ne doit pas
// réapparaître dedans une fois le kekkai fermé.
{
  const w = createWorld(808, { mode: 'coop' });
  w.spawnTimer = 1e9;
  w.wave.t = -1e9;
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  a.iframes = b.iframes = 1e9;
  const col = w.level.arena.col;
  const limit = (col + 1) * TILE;
  place(w, b, col * TILE - 10, w.level.arena.guardianY);
  const n = spawnEnemy(w, 'ninja', b.x - 80, b.y, false);
  n.state = 'hidden';
  n.stateT = 0;
  n.tx = b.x + 56; // « dans le dos » de B, de l'autre côté de la barrière
  warpToArena(w, a.id);
  run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  const alive = w.enemies.includes(n);
  check('kekkai : un ninja disparu avant la fermeture ne réapparaît pas dans l’arène', stateOf(w) === 'arena' && (!alive || n.x + n.w / 2 <= col * TILE + 0.5), alive ? `x−limite ${(n.x - limit).toFixed(0)}, état ${n.state}` : 'retiré');
}

// K15. Les sabres ne traversent pas le kekkai (gardien → joueur dehors, joueur dehors → gardien).
// B reste dehors, collé à la barrière, et attaque ; le gardien, collé de l'autre côté, balaie vers lui.
// Témoin en solo (même scène, barrière pleine) : les coups portent, le test discrimine.
{
  const duel = (mode: 'solo' | 'coop') => {
    const w = createWorld(808, { mode });
    w.spawnTimer = 1e9;
    w.wave.t = -1e9;
    const a = addPlayer(w, 'A');
    const b = addPlayer(w, 'B');
    a.iframes = 1e9;
    warpToArena(w, a.id);
    run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
    const locked = stateOf(w) === 'arena';
    const col = w.level.arena.col;
    const limit = (col + 1) * TILE;
    const g = w.enemies.find((e) => e.id === w.stage.guardianId)!;
    w.enemies = [g]; // seul le gardien : aucun ennemi du dehors ne vient toucher B
    place(w, a, w.level.pxW - 4 * TILE, w.level.arena.guardianY); // A loin, au fond
    const bx = col * TILE - 10;
    place(w, b, bx, w.level.arena.guardianY);
    g.x = limit + g.w / 2 + 2;
    g.vx = 0;
    g.state = 'chase';
    const hp0 = b.hp;
    const ghp0 = g.hp;
    let bHurt = false;
    run(w, 600, (t, id) => (id === b.id ? (t % 12 < 2 ? BTN.ATTACK : 0) : 0), (w) => {
      // B ne doit pas entrer (l'élan de son attaque le porterait dedans) ; le gardien balaie vers la gauche.
      b.x = Math.min(b.x, bx);
      b.facing = 1;
      g.x = Math.min(g.x, limit + g.w / 2 + 2);
      g.facing = -1;
      if (w.tick % 70 === 0 && g.state !== 'attack') {
        g.state = 'windup';
        g.move = 'sweep';
        g.stateT = 0;
      }
      b.iframes = 0;
      bHurt ||= b.hp < hp0;
      if (b.state === 'dead') b.hp = b.maxHp;
    });
    return { locked, bHurt, hp: `${hp0} → ${b.hp}`, gHurt: g.hp < ghp0, ghp: `${ghp0} → ${g.hp}`, arena: stateOf(w) === 'arena' };
  };
  const solo = duel('solo');
  const coop = duel('coop');
  check('témoin solo : gardien et B se touchent à travers la barrière pleine (le test discrimine)', solo.locked && solo.bHurt && solo.gHurt, `PV B ${solo.hp}, gardien ${solo.ghp}`);
  check('kekkai : le gardien collé à la barrière ne touche pas B dehors', coop.locked && coop.arena && !coop.bHurt, `PV B ${coop.hp}`);
  check('kekkai : B dehors ne touche pas le gardien à travers la barrière', coop.locked && !coop.gHurt, `PV gardien ${coop.ghp}`);
}

// ─── 21. Vote du bilan : départs, seul, 12 joueurs, morts, choix d'amélioration ─
{
  const atClear = (n: number) => {
    const w = createWorld(1234, { mode: 'coop' });
    const ps = Array.from({ length: n }, (_, i) => addPlayer(w, `p${i}`));
    w.stage.state = 'cleared';
    w.stage.t = 0;
    return { w, ps };
  };
  const press = (w: World, who: Player[], btn = BTN.JUMP) => run(w, 1, (_t, id) => (who.some((p) => p.id === id) ? btn : 0));

  // Départ d'un non-votant : 2 prêts sur 4 → il en reste 3, la majorité est atteinte au tick suivant.
  {
    const { w, ps } = atClear(4);
    run(w, 95);
    press(w, [ps[0], ps[1]]);
    const before = stateOf(w);
    removePlayer(w, ps[3].id);
    run(w, 1);
    check('vote : le départ d’un non-votant (2/4 → 2/3) fait passer', before === 'cleared' && stateOf(w) === 'playing' && w.level.stage === 1, `${before} → ${stateOf(w)}`);
  }
  // Départ d'un votant : son vote part avec lui (2/4 → 1/3, on reste).
  {
    const { w, ps } = atClear(4);
    run(w, 95);
    press(w, [ps[0], ps[1]]);
    removePlayer(w, ps[0].id);
    run(w, 5);
    const stay = stateOf(w);
    press(w, [ps[2]]);
    check('vote : le départ d’un votant retire son vote (1/3 reste, 2/3 passe)', stay === 'cleared' && stateOf(w) === 'playing', `${stay} → ${stateOf(w)}`);
  }
  // Tout le monde part pendant le bilan : pas d'exception, passage au délai, étape suivante vide.
  {
    const { w, ps } = atClear(3);
    run(w, 95);
    press(w, [ps[0]]);
    for (const p of ps) removePlayer(w, p.id);
    let err = '';
    try {
      run(w, COOP_CLEARED_TICKS);
    } catch (x) {
      err = String(x);
    }
    check('vote : salle vidée pendant le bilan, passage au délai sans erreur', err === '' && stateOf(w) === 'playing' && w.level.stage === 1 && JSON.stringify(w.stage.byPlayer) === '{}', err || stateOf(w));
  }
  // 12 joueurs : 6 votes ne suffisent pas, le 7e fait passer.
  {
    const { w, ps } = atClear(12);
    run(w, 95);
    press(w, ps.slice(0, 6));
    run(w, 3);
    const six = stateOf(w);
    press(w, [ps[6]]);
    check('vote à 12 : 6 votes ne suffisent pas, 7 oui', six === 'cleared' && stateOf(w) === 'playing', `${six} → ${stateOf(w)}`);
  }
  // Les morts votent ; à la sortie du bilan ils sont vivants au départ, la pénalité appliquée.
  {
    const { w, ps } = atClear(3);
    for (const p of ps.slice(0, 2)) {
      p.honor = 500;
      p.up.parry = 2;
      kill(w, p);
      p.respawnT = 1e6; // encore morts au passage
    }
    run(w, 95);
    press(w, ps.slice(0, 2));
    check(
      'vote : deux morts sur 3 votent et font passer ; ils repartent vivants, pénalité appliquée',
      stateOf(w) === 'playing' && ps.every((p) => pState(p) !== 'dead' && p.x === w.level.spawn.x) && ps.slice(0, 2).every((p) => p.honor === 0 && p.up.parry === 0),
      ps.map((p) => `${pState(p)}/${p.honor}`).join(' '),
    );
  }
  // Choisir une amélioration pendant le bilan ne vaut pas vote ; JUMP sert de vote même avec un choix en attente.
  {
    const { w, ps } = atClear(1);
    const p = ps[0];
    p.picks = 1;
    p.offer = ['parry', 'magnet', 'leech'] as typeof p.offer;
    run(w, 95);
    press(w, [p], BTN.PICK1);
    const picked = p.picks === 0 && p.up.parry === 1;
    const still = stateOf(w);
    run(w, 1);
    press(w, [p], BTN.ATTACK);
    check('bilan : PICK1 applique l’amélioration sans voter ; ATTACK vote ensuite', picked && still === 'cleared' && stateOf(w) === 'playing' && p.up.parry === 1, `picks=${p.picks} parry=${p.up.parry} ${still}`);
  }
}

// ─── 22. Statistiques sur une longue partie à plusieurs, arrivées et départs compris ─
// Invariant : Σ fiches présentes + Σ fiches des partis (relevées au départ) = compteurs de l'étape.
{
  const w = createWorld(31337, { mode: 'coop', difficulty: 'easy' });
  const input = scripted(2024);
  for (let i = 0; i < 5; i++) addPlayer(w, `p${i}`, { color: i });
  type K = 'kills' | 'deaths' | 'parries' | 'honor';
  const KS: K[] = ['kills', 'deaths', 'parries', 'honor'];
  let gone: Record<K, number> = { kills: 0, deaths: 0, parries: 0, honor: 0 };
  let stage = w.level.stage;
  let checks = 0;
  let bad = '';
  let stages = 0;
  let joins = 0;
  let leaves = 0;
  let next = 6;
  for (let t = 0; t < 24000; t++) {
    if (w.level.stage !== stage) {
      stage = w.level.stage;
      gone = { kills: 0, deaths: 0, parries: 0, honor: 0 };
      stages++;
    }
    if (t % 700 === 350 && w.players.length > 2) {
      const p = w.players[(t / 700) % w.players.length | 0];
      const s = w.stage.byPlayer?.[p.id];
      if (s) for (const k of KS) gone[k] += s[k];
      removePlayer(w, p.id);
      leaves++;
    }
    if (t % 900 === 100 && w.players.length < 8) {
      addPlayer(w, `p${next++}`);
      joins++;
    }
    if (t % 500 === 250) for (const p of w.players) if (p.state !== 'dead' && (p.id + t) % 3 === 0) kill(w, p);
    if (t % 3000 === 1500 && stateOf(w) === 'playing') warpToArena(w);
    if (t % 3000 === 2000 && stateOf(w) === 'arena') {
      const g = w.enemies.find((e) => e.id === w.stage.guardianId);
      if (g && w.players[0]) killEnemy(w, g, w.players[0], 0, false);
    }
    if (t % 3000 === 2100 && stateOf(w) === 'gateOpen') {
      const p = w.players.find((q) => q.state !== 'dead');
      if (p) place(w, p, w.level.gate.x - 4, w.level.gate.y);
    }
    run(w, 1, input);
    if (t % 50 === 0 || stateOf(w) === 'cleared') {
      const by = w.stage.byPlayer ?? {};
      checks++;
      const ids = Object.keys(by).map(Number).sort((a, b) => a - b).join();
      const pids = w.players.map((p) => p.id).sort((a, b) => a - b).join();
      if (ids !== pids) bad ||= `t=${t} fiches ${ids} ≠ joueurs ${pids}`;
      for (const k of KS) {
        const sum = Object.values(by).reduce((s, x) => s + x[k], 0) + gone[k];
        if (sum !== w.stage[k]) bad ||= `t=${t} ${k} Σ ${sum} ≠ ${w.stage[k]} (étape ${w.level.stage}, ${w.stage.state})`;
      }
      const best = Math.max(0, ...Object.values(by).map((x) => x.bestCombo));
      if (best > w.stage.bestCombo) bad ||= `t=${t} bestCombo fiche ${best} > étape ${w.stage.bestCombo}`;
    }
  }
  check('S8 : partie longue significative (étapes, arrivées, départs)', stages >= 2 && joins >= 5 && leaves >= 5, `${stages} étapes, ${joins} arrivées, ${leaves} départs`);
  check('S8 : Σ fiches (+ partis) = compteurs de l’étape à chaque relevé, une fiche par présent', bad === '', bad || `${checks} relevés`);
}

// ─── 23. Mort dehors pendant l'arène, puis réouverture : renaissance au sanctuaire ─
{
  const w = createWorld(808, { mode: 'coop' });
  w.spawnTimer = 1e9;
  const a = addPlayer(w, 'A');
  const b = addPlayer(w, 'B');
  a.iframes = 1e9;
  const limit = (w.level.arena.col + 1) * TILE;
  warpToArena(w, a.id);
  run(w, 30, (_t, id) => (id === a.id ? BTN.RIGHT : 0));
  const locked = stateOf(w) === 'arena';
  kill(w, b); // B meurt dehors
  run(w, 10);
  kill(w, a); // plus personne dedans : réouverture
  run(w, 2);
  const reopened = stateOf(w) === 'playing';
  const evs = run(w, PLAYER.RESPAWN_TICKS + 10);
  const rb = evs.find((ev) => ev.type === 'respawn' && ev.pid === b.id);
  const ra = evs.find((ev) => ev.type === 'respawn' && ev.pid === a.id);
  check('arène rouverte avant la renaissance : B (mort dehors) renaît au sanctuaire', locked && reopened && !!rb && rb.type === 'respawn' && rb.x === b.spawnX && rb.x < limit, rb && rb.type === 'respawn' ? `x=${(rb.x / TILE).toFixed(1)}` : 'pas de renaissance');
  check('arène rouverte : A (mort dedans) renaît aussi au sanctuaire', !!ra && ra.type === 'respawn' && ra.x === a.spawnX && ra.x < limit);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests coop passent.');
