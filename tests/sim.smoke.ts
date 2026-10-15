// Test de fumée headless de la simulation partagée (aucun rendu).
// Lancer : npm run test:sim
import { BOSS, HONOR, PLAYER, TILE } from '../shared/constants';
import { bodyRect, boxFromFacing } from '../shared/combat';
import { damagePlayer, gainHonor } from '../shared/interactions';
import { overlaps } from '../shared/math';
import { createEnemy } from '../shared/enemy';
import { BTN } from '../shared/input';
import { touchingWall } from '../shared/physics';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../shared/difficulty';
import type { GameEvent, Player, World } from '../shared/types';
import { killEnemy } from '../shared/interactions';
import { T_SOLID } from '../shared/level';
import { addPlayer, createWorld, resetWorld, stepWorld, warpToArena } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

function fresh(x: number, y: number): { w: World; p: Player } {
  const w = createWorld(1);
  w.enemies = [];
  w.spawnTimer = 1e9;
  const p = addPlayer(w, 'test');
  p.x = x;
  p.y = y;
  return { w, p };
}

function run(w: World, p: Player, ticks: number, input: (t: number) => number): void {
  const m = new Map<number, number>();
  for (let t = 0; t < ticks; t++) {
    m.set(p.id, input(t));
    stepWorld(w, m);
    w.events.length = 0;
  }
}

// 1. Tunnel bas : il faut glisser (ou ramper) pour passer.
{
  const { w, p } = fresh(70 * TILE, 18 * TILE);
  run(w, p, 30, () => BTN.RIGHT);
  run(w, p, 200, (t) => BTN.RIGHT | (t > 5 ? BTN.DOWN : 0));
  check('glissade sous le tunnel', p.x > 85 * TILE, `x=${(p.x / TILE).toFixed(1)} tuiles`);
}
{
  const { w, p } = fresh(70 * TILE, 18 * TILE);
  run(w, p, 200, () => BTN.RIGHT);
  check('debout, le tunnel bloque', p.x < 76 * TILE, `x=${(p.x / TILE).toFixed(1)}`);
}

// 2. Puits de wall-jump → plateau supérieur.
{
  const { w, p } = fresh(97 * TILE + 16, 15 * TILE);
  let dir = 1;
  let hold = 0;
  let prev = 0;
  let reached = false;
  run(w, p, 600, () => {
    if (p.onGround && Math.abs(p.y - 8 * TILE) < 1 && p.x > 99 * TILE) reached = true;
    if (reached) return 0;
    if (p.y < 8 * TILE - 4) return BTN.RIGHT; // au-dessus du plateau : on s'y pose
    let b = dir > 0 ? BTN.RIGHT : BTN.LEFT;
    if (hold > 0) {
      hold--;
      b |= BTN.JUMP;
    } else if (!(prev & BTN.JUMP) && (p.onGround || touchingWall(p, w.level, dir))) {
      if (!p.onGround) dir = -dir; // le saut mural renvoie de l'autre côté
      hold = 14;
      b = (dir > 0 ? BTN.RIGHT : BTN.LEFT) | BTN.JUMP;
    }
    prev = b;
    return b;
  });
  check('ascension en wall-jump', reached, `x=${(p.x / TILE).toFixed(1)} y=${(p.y / TILE).toFixed(1)}`);
}

// 3. Combo au katana.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  const e = createEnemy(999, 'ashigaru', p.x + 34, p.y);
  e.facing = -1;
  w.enemies.push(e);
  run(w, p, 2, () => 0); // poser le joueur au sol
  run(w, p, 90, (t) => (t % 12 === 0 ? BTN.ATTACK : 0));
  check('combo de 3 coups tue un ashigaru', p.kills === 1, `kills=${p.kills} combo max=${p.bestCombo}`);
}

// 4. Iai chargé : traverse et condamne une ligne d'ennemis.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  for (let i = 0; i < 3; i++) {
    const e = createEnemy(900 + i, 'ashigaru', p.x + 80 + i * 70, p.y);
    e.freeze = 70; // immobiles pendant la charge
    w.enemies.push(e);
  }
  run(w, p, 60, () => BTN.IAI);
  run(w, p, 60, () => 0);
  check('iai complet : 3 ennemis tranchés', p.kills === 3, `kills=${p.kills} x=${(p.x / TILE).toFixed(1)}`);
}

// 5. Parade : renvoie l'estoc et étourdit l'ennemi.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  const e = createEnemy(999, 'ashigaru', p.x + 60, p.y);
  e.cd = 0;
  w.enemies.push(e);
  let parried = false;
  const m = new Map<number, number>();
  for (let t = 0; t < 200 && !parried; t++) {
    const parryNow = e.state === 'windup' && e.stateT === 22;
    m.set(p.id, parryNow ? BTN.PARRY : 0);
    stepWorld(w, m);
    if (w.events.some((ev) => ev.type === 'parry')) parried = true;
    w.events.length = 0;
  }
  check('parade réussie', parried && e.state === 'stunned' && p.hp === 100, `état=${e.state} pv=${p.hp}`);
}

// 6. Robustesse : 20 000 ticks d'entrées aléatoires, horde active.
{
  const w = createWorld(42);
  const p = addPlayer(w, 'bot');
  p.lives = 999; // ce test vise la robustesse, pas la fin de partie
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let b = 0;
  let maxEnemies = 0;
  let ok = true;
  run(w, p, 20000, (t) => {
    if (t % 12 === 0) b = Math.floor(rnd() * 512) & ~BTN.LEFT;
    maxEnemies = Math.max(maxEnemies, w.enemies.length);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.y > w.level.pxH + 1) ok = false;
    return b;
  });
  check('20k ticks aléatoires sans état invalide', ok && w.attackTokens >= 0, `x=${(p.x / TILE).toFixed(0)} kills totaux=${w.totalKills} ennemis max=${maxEnemies} jetons=${w.attackTokens}`);
}

// 7. Honneur : orbes ramassées, montée de niveau, choix d'amélioration.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  const e = createEnemy(999, 'ashigaru', p.x + 34, p.y);
  e.hp = 1;
  w.enemies.push(e);
  run(w, p, 2, () => 0);
  run(w, p, 120, (t) => (t === 0 ? BTN.ATTACK : 0));
  check('orbes d’Honneur ramassées', p.honor >= 10, `honneur=${p.honor} orbes restantes=${w.orbs.length}`);
  gainHonor(w, p, 100);
  const lvl = p.level;
  const offer = p.offer.slice();
  run(w, p, 2, (t) => (t === 0 ? BTN.PICK1 : 0));
  check('niveau + offre de 3 améliorations', lvl === 2 && offer.length === 3 && p.up[offer[0]] === 1 && p.picks === 1 && p.offer.length === 3, `niv=${lvl} choisi=${offer[0]} restants=${p.picks}`);
}

// 8. Mort : la moitié de l'Honneur reste au sol, tout le reste repart de zéro.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  gainHonor(w, p, 200);
  p.up.edge = 3;
  p.hp = 1;
  w.enemies.push(Object.assign(createEnemy(999, 'ashigaru', p.x + 50, p.y), { cd: 0, facing: -1 as const }));
  run(w, p, 400, () => 0);
  const lost = w.orbs.filter((o) => o.lost).reduce((s, o) => s + o.value, 0);
  check('mort : Honneur perdu au sol, progression réinitialisée', lost === 100 && p.honor === 0 && p.up.edge === 0 && p.state !== 'dead', `au sol=${lost} honneur=${p.honor}`);
}

// 9. Oni : bloque de face, garde brisée par un coup lourd, vulnérable de dos.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  const o = createEnemy(999, 'oni', p.x + 40, p.y);
  o.state = 'chase';
  o.facing = -1;
  o.cd = 999;
  w.enemies.push(o);
  run(w, p, 2, () => 0);
  let blocked = 0;
  const m = new Map<number, number>();
  for (let tk = 0; tk < 30; tk++) {
    m.set(p.id, tk === 0 ? BTN.ATTACK : 0);
    stepWorld(w, m);
    blocked += w.events.filter((ev) => ev.type === 'block').length;
    w.events.length = 0;
  }
  check('oni : coup léger bloqué de face', blocked === 1 && o.hp === o.maxHp, `blocages=${blocked} pv=${o.hp}`);
  const { w: w2, p: p2 } = fresh(20 * TILE, 18 * TILE);
  const o2 = createEnemy(998, 'oni', p2.x + 40, p2.y);
  o2.state = 'chase';
  o2.facing = 1; // dos tourné
  o2.cd = 999;
  w2.enemies.push(o2);
  run(w2, p2, 2, () => 0);
  run(w2, p2, 12, (tk) => (tk === 0 ? BTN.ATTACK : 0));
  check('oni : touché dans le dos', o2.hp < o2.maxHp, `pv=${o2.hp}/${o2.maxHp}`);
}

// 10. Ninja : disparaît quand on l'approche et réapparaît près du joueur.
{
  const { w, p } = fresh(20 * TILE, 18 * TILE);
  const n = createEnemy(999, 'ninja', p.x + 90, p.y);
  n.state = 'chase';
  w.enemies.push(n);
  let vanished = false;
  let appearedNear = false;
  const m = new Map<number, number>();
  for (let tk = 0; tk < 60; tk++) {
    m.set(p.id, 0);
    stepWorld(w, m);
    for (const ev of w.events) {
      if (ev.type === 'vanish') vanished = true;
      if (ev.type === 'appear' && Math.abs(ev.x - p.x) < 80) appearedNear = true;
    }
    w.events.length = 0;
  }
  check('ninja : téléportation', vanished && appearedNear);
}

// 11. Boss : le balayage passe au-dessus d'un joueur accroupi.
{
  const { p } = fresh(30 * TILE, 18 * TILE);
  const b = createEnemy(999, 'boss', p.x + 100, p.y);
  b.x = p.x + 100;
  b.y = p.y;
  b.facing = -1;
  const sweep = boxFromFacing(b.x, b.y, b.facing, BOSS.SWEEP_HB);
  const standing = { ...bodyRect(p), x: b.x + b.facing * 60 - 9 };
  const crouched = { ...standing, y: p.y - 28, h: 28 };
  check('boss : balayage esquivé accroupi', overlaps(sweep, standing) && !overlaps(sweep, crouched));
}

// 12. La Marée : vagues successives (joueur immortel et passif), jamais de boss hors de l'arène.
{
  const w = createWorld(3);
  const p = addPlayer(w, 'stoic');
  let bossSeen = false;
  let tides = 0;
  const m = new Map<number, number>();
  for (let tk = 0; tk < 16000; tk++) {
    p.hp = p.maxHp;
    m.set(p.id, 0);
    stepWorld(w, m);
    for (const ev of w.events) {
      if (ev.type === 'tideStart') tides++;
      if (ev.type === 'bossSpawn') bossSeen = true;
    }
    w.events.length = 0;
  }
  check('Marée : vagues successives, pas de boss hors arène', tides >= 3 && !bossSeen, `marées=${tides}`);
}

// 13. Fin d'étape : arène → gardien vaincu → porte → bilan → boucle suivante plus dure.
{
  const w = createWorld(5);
  const p = addPlayer(w, 'pilgrim');
  p.up.edge = 2;
  const m = new Map<number, number>();
  const evs: string[] = [];
  const step = (b: number, n = 1) => {
    for (let i = 0; i < n; i++) {
      m.set(p.id, b);
      stepWorld(w, m);
      for (const ev of w.events) evs.push(ev.type);
      w.events.length = 0;
    }
  };
  warpToArena(w);
  step(BTN.RIGHT, 30);
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  const col = w.level.arena.col;
  const locked = w.stage.state === 'arena' && !!g && w.level.tiles[10 * w.level.w + col] === T_SOLID;
  check('arène : kekkai fermé, gardien présent', locked && evs.includes('arenaLock'), `état=${w.stage.state}`);
  if (g) killEnemy(w, g, p, 0, false);
  step(0, 2);
  const open = w.stage.state === 'gateOpen' && w.level.tiles[10 * w.level.w + col] !== T_SOLID;
  check('gardien vaincu : porte ouverte, barrière levée', open && evs.includes('gateOpen'));
  p.x = w.level.gate.x - 60;
  p.y = w.level.gate.y;
  step(BTN.RIGHT, 40);
  check('porte franchie : bilan', w.stage.state === 'cleared' && evs.includes('stageClear'), `note=${w.stage.grade} bonus=${w.stage.bonus} tués=${w.stage.kills}`);
  const honor = p.honor;
  step(BTN.JUMP, 1);
  step(0, 1);
  check('pas de saut de bilan trop tôt', w.stage.state === 'cleared');
  step(0, 100);
  step(BTN.JUMP, 1);
  const ash = w.enemies.find((e) => e.type === 'ashigaru');
  check(
    'boucle 2 : retour au départ, progression gardée, ennemis renforcés',
    w.stage.loop === 1 && w.stage.state === 'playing' && Math.abs(p.x - w.level.spawn.x) < 1 && p.up.edge === 2 && p.honor === honor && !!ash && ash.maxHp > 30,
    `boucle=${w.stage.loop} pv ashigaru=${ash?.maxHp}`,
  );
}

// 14. Mort dans l'arène : elle se rouvre et le gardien disparaît.
{
  const w = createWorld(6);
  const p = addPlayer(w, 'fallen');
  const m = new Map<number, number>();
  warpToArena(w);
  for (let i = 0; i < 30; i++) {
    m.set(p.id, BTN.RIGHT);
    stepWorld(w, m);
    w.events.length = 0;
  }
  p.hp = 1;
  p.iframes = 0;
  for (let i = 0; i < 900 && w.stage.state === 'arena'; i++) {
    m.set(p.id, 0);
    stepWorld(w, m);
    w.events.length = 0;
  }
  check('mort dans l’arène : réinitialisation', w.stage.state === 'playing' && !w.enemies.some((e) => e.type === 'boss'), `état=${w.stage.state} morts=${w.stage.deaths}`);
}

// 15. Difficulté : PV des ennemis et dégâts subis croissent de Très facile à Très difficile.
{
  const hpOf = (d: DifficultyId) => createWorld(1, { difficulty: d }).enemies.find((e) => e.type === 'ashigaru')?.maxHp ?? 0;
  const dmgOf = (d: DifficultyId) => {
    const w = createWorld(1, { difficulty: d });
    const p = addPlayer(w, 'cible');
    p.iframes = 0;
    damagePlayer(w, p, 10, p.x + 1);
    return p.maxHp - p.hp;
  };
  const hp = DIFFICULTY_ORDER.map(hpOf);
  const dmg = DIFFICULTY_ORDER.map(dmgOf);
  check('difficulté : PV ashigaru veryEasy < normal < veryHard', hp[0] < hp[2] && hp[2] < hp[4] && hp[2] === 30, `pv=${hp.join('/')}`);
  check('difficulté : dégâts subis veryEasy < normal < veryHard', dmg[0] < dmg[2] && dmg[2] < dmg[4] && dmg[2] === 10, `dégâts=${dmg.join('/')}`);
}

// 16. Vies : fin de partie exactement à la N-ième mort, un seul gameOver, monde figé ensuite.
for (const d of DIFFICULTY_ORDER) {
  const w = createWorld(1, { difficulty: d });
  const p = addPlayer(w, 'mortel');
  const n = DIFFICULTIES[d].lives;
  const m = new Map<number, number>();
  const evs: GameEvent[] = [];
  const step = (ticks: number) => {
    for (let t = 0; t < ticks; t++) {
      if (p.state !== 'dead') p.hp = p.maxHp; // seules nos morts forcées comptent
      m.set(p.id, 0);
      stepWorld(w, m);
      evs.push(...w.events);
      w.events.length = 0;
    }
  };
  let earlyOut = false;
  for (let k = 1; k <= n; k++) {
    p.iframes = 0;
    damagePlayer(w, p, 9999, p.x + 1);
    if (k < n && p.out) earlyOut = true;
    step(PLAYER.RESPAWN_TICKS + 5);
    if (k < n && (p.state === 'dead' || p.out)) earlyOut = true;
  }
  const deaths = evs.filter((e) => e.type === 'playerDeath').length;
  const lastDeath = evs.filter((e) => e.type === 'playerDeath').pop();
  step(PLAYER.GAME_OVER_DELAY);
  const overs = evs.filter((e) => e.type === 'gameOver');
  const pos = w.enemies.map((e) => `${e.x},${e.y}`).join(';');
  const tick = w.tick;
  step(100);
  const frozen = w.enemies.length > 0 && w.enemies.map((e) => `${e.x},${e.y}`).join(';') === pos && w.tick === tick + 100;
  const go = overs[0];
  check(
    `vies (${d}) : game over à la ${n}e mort, sans renaissance, monde figé`,
    !earlyOut && deaths === n && p.out && p.lives === 0 && p.state === 'dead' && w.over && overs.length === 1 &&
      !evs.some((e) => e.type === 'respawn' && evs.indexOf(e) > evs.indexOf(lastDeath as GameEvent)) &&
      !!go && go.type === 'gameOver' && go.deaths === n && go.score === p.score && frozen &&
      lastDeath?.type === 'playerDeath' && lastDeath.livesLeft === 0 && lastDeath.lost === 0,
    `morts=${deaths} gameOver=${overs.length} figé=${frozen}`,
  );
}

// 17. Score : jamais décroissant, déterministe, pondéré par la difficulté.
{
  const play = (seed: number) => {
    const w = createWorld(seed);
    const p = addPlayer(w, 'bot');
    p.lives = 999;
    let s = 11;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let b = 0;
    let monotone = true;
    let prev = 0;
    run(w, p, 12000, (t) => {
      if (t % 12 === 0) b = Math.floor(rnd() * 512) & ~BTN.LEFT;
      if (p.score < prev) monotone = false;
      prev = p.score;
      return b | (t % 9 === 0 ? BTN.ATTACK : 0);
    });
    return { score: p.score, monotone, kills: p.runKills };
  };
  const a = play(9);
  const b = play(9);
  check('score : monotone sur une partie aléatoire', a.monotone, `score=${a.score} tués=${a.kills}`);
  check('score : déterministe (même seed, mêmes entrées)', a.score === b.score && a.kills === b.kills, `${a.score} / ${b.score}`);

  const killScore = (d: DifficultyId) => {
    const w = createWorld(1, { difficulty: d });
    const p = addPlayer(w, 'lame');
    killEnemy(w, w.enemies[0], p, 0, false);
    return p.score;
  };
  const sn = killScore('normal');
  const sv = killScore('veryHard');
  check('score : même kill en veryHard = 2,5 × normal', sn > 0 && sv === sn * 2.5, `normal=${sn} veryHard=${sv}`);

  const { w, p } = fresh(20 * TILE, 18 * TILE);
  run(w, p, 2, () => 0);
  w.orbs.push({ id: 5000, x: p.x, y: p.y - 22, vx: 0, vy: 0, value: 50, life: HONOR.LOST_LIFE - 30, lost: true, onGround: false });
  run(w, p, 10, () => 0);
  check('score : l’Honneur perdu ramassé ne compte pas', p.honor === 50 && p.score === 0, `honneur=${p.honor} score=${p.score}`);
}

// 18. resetWorld après game over : nouvelle partie sur place, même niveau.
{
  const w = createWorld(4, { difficulty: 'veryHard' });
  const p = addPlayer(w, 'phénix');
  const level = w.level;
  p.iframes = 0;
  damagePlayer(w, p, 9999, p.x + 1);
  run(w, p, PLAYER.GAME_OVER_DELAY + 5, () => 0);
  const wasOver = w.over;
  resetWorld(w, 4, { difficulty: 'hard' });
  const ok = wasOver && !w.over && w.overT === 0 && w.stage.loop === 0 && w.players.length === 0 && w.enemies.length > 0 && w.level === level && w.difficulty === 'hard';
  const q = addPlayer(w, 'phénix');
  check('resetWorld : partie neuve, même niveau, 3 vies en difficile', ok && q.lives === 3 && q.score === 0, `ennemis=${w.enemies.length} vies=${q.lives}`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests passent.');
