import { bodyRect } from './combat';
import { DT, ENEMY, HONOR, PLAYER, SPAWN, TILE, WAVES } from './constants';
import { findGround, spawnEnemy, stepEnemy } from './enemy';
import { addScore, damagePlayer, gainHonor, hitEnemy, spawnOrbs } from './interactions';
import { DIFFICULTIES, type DifficultyId, enemyHpScale, extraEnemiesFor, firstCalmMult } from './difficulty';
import { approach, clamp, overlaps, Rng } from './math';
import { moveBody, solidAt } from './physics';
import { createPlayer, stepPlayer } from './player';
import { buildStage } from './stagebuild';
import { newStageState, populateStage, stepCleared, stepStage } from './stage';
import type { Body, Enemy, EnemyType, Player, World } from './types';
import { magnetRadius } from './upgrades';

export { spawnEnemy };
export { nextStage, warpToArena } from './stage';

export interface WorldOptions {
  difficulty?: DifficultyId;
}

export function createWorld(seed = 7, opts: WorldOptions = {}): World {
  const level = buildStage(0, seed);
  const w: World = {
    tick: 0,
    seed,
    level,
    players: [],
    enemies: [],
    projectiles: [],
    orbs: [],
    events: [],
    rng: new Rng(seed),
    nextId: 1,
    spawnTimer: 240,
    attackTokens: 0,
    totalKills: 0,
    wave: { n: 0, phase: 'calm', t: 0, kills: 0, quota: 0 },
    stage: newStageState(0, 0),
    difficulty: opts.difficulty ?? 'normal',
    over: false,
    overT: 0,
  };
  populateStage(w);
  return w;
}

/**
 * Réinitialise le monde sur place (nouvelle partie) en conservant la référence
 * w.level (le rendu du client la garde). Aucun joueur : rappeler addPlayer ensuite.
 */
export function resetWorld(w: World, seed: number, opts: WorldOptions = {}): void {
  const fresh = createWorld(seed, opts);
  Object.assign(w.level, fresh.level);
  Object.assign(w, { ...fresh, level: w.level });
}

export function addPlayer(w: World, name: string): Player {
  const p = createPlayer(w.nextId++, name, w.level.spawn.x, w.level.spawn.y);
  p.lives = DIFFICULTIES[w.difficulty].lives;
  w.players.push(p);
  return p;
}

/** Un pas de simulation (1/60 s). inputs : masque de boutons par id de joueur. */
export function stepWorld(w: World, inputs: Map<number, number>): void {
  // Partie terminée : le monde est figé.
  if (w.over) {
    w.tick++;
    return;
  }
  if (w.stage.state === 'cleared') {
    stepCleared(w, inputs);
    w.tick++;
    return;
  }
  for (const p of w.players) stepPlayer(w, p, inputs.get(p.id) ?? 0);
  for (const e of w.enemies) stepEnemy(w, e);
  stepProjectiles(w);
  stepOrbs(w);
  w.enemies = w.enemies.filter((e) => e.state !== 'dead');
  w.projectiles = w.projectiles.filter((a) => !a.dead);
  stepStage(w);
  if (w.stage.state === 'playing') {
    stepWaves(w);
    spawner(w);
  }
  stepGameOver(w);
  w.tick++;
}

/** Tous les joueurs sont sortis : la simulation continue un instant, puis la partie se termine. */
function stepGameOver(w: World): void {
  if (!w.players.length || !w.players.every((p) => p.out)) return;
  if (++w.overT < PLAYER.GAME_OVER_DELAY) return;
  w.over = true;
  const p = w.players[0];
  w.events.push({
    type: 'gameOver', pid: p.id, score: p.score, loop: w.stage.loop, kills: p.runKills,
    deaths: DIFFICULTIES[w.difficulty].lives - p.lives,
  });
}

// ─── Projectiles ────────────────────────────────────────────────────────────

function stepProjectiles(w: World): void {
  for (const a of w.projectiles) {
    if (a.dead) continue;
    if (--a.life <= 0) {
      a.dead = true;
      continue;
    }
    if (a.kind === 'arrow') a.vy += ENEMY.ARROW_GRAVITY * DT;
    a.x += a.vx * DT;
    a.y += a.vy * DT;
    if (solidAt(w.level, a.x, a.y)) {
      a.dead = true;
      w.events.push({ type: 'arrowBreak', x: a.x, y: a.y });
      continue;
    }
    const r = a.kind === 'wave' ? { x: a.x - 14, y: a.y - 26, w: 28, h: 52 } : { x: a.x - 6, y: a.y - 3, w: 12, h: 6 };
    if (a.owner === 'enemy') {
      for (const p of w.players) {
        if (p.state === 'dead' || !overlaps(r, bodyRect(p))) continue;
        const res = damagePlayer(w, p, a.damage, a.x - Math.sign(a.vx) * 40);
        if (res === 'parried') {
          a.owner = 'player';
          a.ownerId = p.id;
          a.vx = -a.vx * 1.3;
          a.vy = -60;
          a.life = 120;
          a.damage = 30;
        } else if (res === 'hit') a.dead = true;
        break;
      }
    } else {
      const p = w.players.find((q) => q.id === a.ownerId);
      for (const e of w.enemies) {
        if (e.state === 'dead' || e.state === 'doomed' || a.hits.includes(e.id) || !overlaps(r, bodyRect(e))) continue;
        a.hits.push(e.id);
        if (p) {
          hitEnemy(w, p, e, {
            dmg: a.damage, kbx: Math.sign(a.vx) * 220, kby: -160, hitstop: 4, cut: 0.2,
            heavy: false, fromX: a.x - Math.sign(a.vx) * 30, fromY: a.y,
          });
        }
        if (a.kind !== 'wave') {
          a.dead = true; // la vague de vent transperce
          break;
        }
      }
    }
  }
}

// ─── Orbes d'Honneur ────────────────────────────────────────────────────────

const ORB_SIZE = 6;

function stepOrbs(w: World): void {
  const keep = [];
  for (const o of w.orbs) {
    if (--o.life <= 0) continue;
    const age = (o.lost ? HONOR.LOST_LIFE : HONOR.ORB_LIFE) - o.life;
    let target: Player | null = null;
    let best = Infinity;
    if (age > 18) {
      for (const p of w.players) {
        if (p.state === 'dead') continue;
        const d = Math.hypot(p.x - o.x, p.y - 22 - o.y);
        if (d < magnetRadius(p) * (o.lost ? 1.6 : 1) && d < best) {
          best = d;
          target = p;
        }
      }
    }
    if (target) {
      if (best < HONOR.PICKUP) {
        gainHonor(w, target, o.value);
        w.events.push({ type: 'orb', x: o.x, y: o.y, value: o.value, lost: o.lost, pid: target.id });
        if (o.lost && !w.orbs.some((q) => q !== o && q.lost && q.life > 0)) target.lostX = NaN;
        continue;
      }
      const dx = (target.x - o.x) / best;
      const dy = (target.y - 22 - o.y) / best;
      o.vx += dx * 2600 * DT;
      o.vy += dy * 2600 * DT;
      const sp = Math.hypot(o.vx, o.vy);
      if (sp > 720) {
        o.vx *= 720 / sp;
        o.vy *= 720 / sp;
      }
      o.x += o.vx * DT;
      o.y += o.vy * DT;
      o.onGround = false;
    } else {
      const b = { x: o.x, y: o.y + ORB_SIZE / 2, vx: o.vx, vy: o.vy + 900 * DT, w: ORB_SIZE, h: ORB_SIZE, onGround: o.onGround } as Body;
      moveBody(b, w.level, DT, false);
      o.x = b.x;
      o.y = b.y - ORB_SIZE / 2;
      o.vy = Math.min(b.vy, 600);
      o.onGround = b.onGround;
      o.vx = b.onGround ? approach(b.vx, 0, 900 * DT) : b.vx;
    }
    keep.push(o);
  }
  w.orbs = keep;
}

// ─── La Marée ───────────────────────────────────────────────────────────────

function stepWaves(w: World): void {
  const wv = w.wave;
  wv.t++;
  const alive = w.players.some((p) => p.state !== 'dead');
  switch (wv.phase) {
    case 'calm':
      if (alive && wv.t >= calmLength(w)) {
        wv.phase = 'warn';
        wv.t = 0;
        w.events.push({ type: 'tideWarn', n: wv.n + 1 });
      }
      break;
    case 'warn':
      if (wv.t >= WAVES.WARN) {
        wv.n++;
        wv.phase = 'tide';
        wv.t = 0;
        wv.kills = 0;
        wv.quota = 10 + 4 * wv.n;
        w.spawnTimer = 0;
        w.events.push({ type: 'tideStart', n: wv.n });
      }
      break;
    case 'tide': {
      const done = wv.kills >= wv.quota || wv.t >= WAVES.TIDE_MAX;
      if (done) {
        const bonus = 25 * wv.n;
        const p = w.players.find((q) => q.state !== 'dead');
        if (p) spawnOrbs(w, p.x, p.y - 60, bonus, false);
        for (const q of w.players) if (!q.out) addScore(w, q, bonus);
        w.events.push({ type: 'tideEnd', n: wv.n, bonus });
        wv.phase = 'calm';
        wv.t = 0;
      }
      break;
    }
  }
}

/** Durée de l'accalmie en cours (la première est plus longue, raccourcie à chaque boucle). */
export function calmLength(w: World): number {
  return w.wave.n === 0 ? Math.round(WAVES.FIRST_CALM * firstCalmMult(w.stage.loop)) : WAVES.CALM;
}

/** Force la phase suivante de la Marée (outil de debug). */
export function skipWavePhase(w: World): void {
  const wv = w.wave;
  if (wv.phase === 'tide') wv.kills = wv.quota;
  else wv.t = 1e6;
}

const hpMult = (w: World) => (1 + 0.12 * Math.max(0, w.wave.n - 1)) * enemyHpScale(w);

function pickType(w: World): EnemyType {
  const n = w.wave.n + w.stage.loop;
  const tide = w.wave.phase === 'tide';
  const k = w.totalKills + 40 * w.stage.loop;
  const weights: [EnemyType, number][] = [
    ['ashigaru', 5],
    ['archer', 2.4],
    ['ninja', tide && n >= 1 ? 1.4 + 0.5 * n : k > 15 ? 0.8 : 0],
    ['oni', tide && n >= 2 ? 1 + 0.4 * n : k > 30 ? 0.6 : 0],
  ];
  let total = 0;
  for (const [, v] of weights) total += v;
  let r = w.rng.next() * total;
  for (const [t, v] of weights) {
    if ((r -= v) <= 0) return t;
  }
  return 'ashigaru';
}

/** La horde : maintient un nombre d'ennemis croissant, hors de l'écran du joueur. */
function spawner(w: World): void {
  if (w.spawnTimer > 0) {
    w.spawnTimer--;
    return;
  }
  const wv = w.wave;
  const tide = wv.phase === 'tide';
  w.spawnTimer = Math.floor(tide ? w.rng.range(26, 52) : w.rng.range(SPAWN.MIN_DELAY, SPAWN.MAX_DELAY));
  const alive = w.players.filter((p) => p.state !== 'dead');
  if (!alive.length) return;
  const extra = extraEnemiesFor(w);
  // Plancher : même en très facile, la horde garde au moins 2 ennemis.
  const target = Math.max(2, tide
    ? Math.min(26 + extra, 10 + 3 * wv.n + extra)
    : Math.min(SPAWN.MAX + extra, SPAWN.BASE + extra + Math.floor(w.stage.kills / SPAWN.PER_KILLS)));
  if (w.enemies.length >= target) {
    if (!tide) trimHorde(w, alive, target);
    return;
  }
  const p = alive[Math.floor(w.rng.next() * alive.length)];
  for (let attempt = 0; attempt < 6; attempt++) {
    const side = w.rng.next() < 0.5 ? -1 : 1;
    // Jamais dans l'arène du gardien.
    const x = clamp(p.x + side * w.rng.range(tide ? 500 : 560, 900), 3 * TILE, (w.level.arena.col - 3) * TILE);
    const gy = findGround(w.level, x, p.y);
    if (gy === null) continue;
    // Pas de renfort perché à plus de 4 tuiles au-dessus du joueur (ex. sommet d'un bloc de tunnel).
    if (gy < p.y - 4 * TILE) continue;
    const e = spawnEnemy(w, pickType(w), x, gy, true, hpMult(w));
    e.horde = true;
    if (tide) e.state = 'chase'; // la Marée vient droit sur vous
    return;
  }
}

/**
 * Accalmie après une Marée : la population redescend vers sa cible. On retire un seul
 * renfort par passage du spawner, le plus éloigné, et seulement s'il patrouille loin de tous
 * les joueurs (jamais un ennemi placé dans le niveau, jamais à l'écran).
 */
function trimHorde(w: World, alive: Player[], target: number): void {
  if (w.enemies.length <= target) return;
  let pick: Enemy | null = null;
  let best: number = SPAWN.TRIM_DISTANCE;
  for (const e of w.enemies) {
    if (!e.horde || e.state !== 'patrol') continue;
    const d = Math.min(...alive.map((p) => Math.abs(p.x - e.x)));
    if (d > best) {
      best = d;
      pick = e;
    }
  }
  if (pick) w.enemies = w.enemies.filter((e) => e !== pick);
}
