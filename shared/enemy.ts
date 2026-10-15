import { bodyRect, boxFromFacing } from './combat';
import { BOSS, DT, ENEMY, NINJA_SLASH_HB, ONI_SMASH_HB, SPEAR_HB, TILE } from './constants';
import { enemyCooldownScale, enemyHpScale, guardianRageAt } from './difficulty';
import { damagePlayer, killEnemy, releaseToken, stunEnemy, takeToken } from './interactions';
import { type Level, T_EMPTY, tileAt } from './level';
import { approach, clamp, overlaps, type Rect } from './math';
import { fitsAt, groundAhead, moveBody, touchingWall } from './physics';
import type { Enemy, EnemyMove, EnemyState, EnemyType, Player, World } from './types';

// IA côté serveur : machines à états simples et peu coûteuses, conçues pour
// être lisibles (préparations télégraphiées) et pour supporter des hordes.

export function createEnemy(id: number, type: EnemyType, x: number, y: number, hpMult = 1): Enemy {
  const d = ENEMY[type];
  const hp = Math.round(d.hp * hpMult);
  return {
    id, type, x, y, vx: 0, vy: 0, w: d.w, h: d.h, onGround: false,
    facing: -1, hp, maxHp: hp, state: 'patrol', stateT: 0, move: 'none', freeze: 0, flash: 0,
    token: false, cd: 30, patrolDir: -1, hitDone: false, stunLen: 20, doomBy: 0, aimAng: 0,
    aux: 0, tx: x, dodgeCd: 0, phase2: false, hornStage: 0,
  };
}

export function spawnEnemy(w: World, type: EnemyType, x: number, y: number, announce: boolean, hpMult = 1): Enemy {
  const e = createEnemy(w.nextId++, type, x, y, hpMult);
  e.patrolDir = w.rng.next() < 0.5 ? -1 : 1;
  e.facing = e.patrolDir;
  w.enemies.push(e);
  if (announce) w.events.push({ type: 'spawn', x, y, enemyType: type });
  return e;
}

/** Sol libre (deux tuiles de vide au-dessus) dans la colonne x, en partant de près de nearY. */
export function findGround(l: Level, x: number, nearY: number, rowsAbove = 7): number | null {
  const c = Math.floor(x / TILE);
  const start = clamp(Math.floor(nearY / TILE) - rowsAbove, 2, l.h - 1);
  for (let r = start; r < l.h; r++) {
    if (tileAt(l, c, r) !== T_EMPTY && tileAt(l, c, r - 1) === T_EMPTY && tileAt(l, c, r - 2) === T_EMPTY) return r * TILE;
  }
  return null;
}

function setState(e: Enemy, s: EnemyState, move: EnemyMove = e.move): void {
  e.state = s;
  e.stateT = 0;
  e.move = move;
}

function nearestPlayer(w: World, e: Enemy): Player | null {
  let best: Player | null = null;
  let bd = Infinity;
  for (const p of w.players) {
    if (p.state === 'dead') continue;
    const d = Math.abs(p.x - e.x) + Math.abs(p.y - e.y) * 1.5;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

function blocked(w: World, e: Enemy, dir: number): boolean {
  return touchingWall(e, w.level, dir) || (e.onGround && !groundAhead(e, w.level, dir));
}

interface Ctx {
  w: World;
  e: Enemy;
  t: Player | null;
  dx: number;
  dy: number;
  adx: number;
  move: number;
  speed: number;
  friction: number;
  gravity: boolean;
}

export function stepEnemy(w: World, e: Enemy): void {
  if (e.state === 'dead') return;
  if (e.freeze > 0) {
    e.freeze--;
    return;
  }
  e.stateT++;
  if (e.flash > 0) e.flash--;
  if (e.cd > 0) e.cd--;
  if (e.dodgeCd > 0) e.dodgeCd--;

  const t = nearestPlayer(w, e);
  const c: Ctx = {
    w, e, t,
    dx: t ? t.x - e.x : 0,
    dy: t ? t.y - e.y : 0,
    adx: t ? Math.abs(t.x - e.x) : 0,
    move: 0, speed: 0, friction: 1400, gravity: true,
  };

  switch (e.state) {
    case 'hitstun':
      c.friction = 1300;
      if (e.stateT >= e.stunLen && e.onGround) setState(e, 'chase', 'none');
      break;
    case 'stunned':
      c.friction = 900;
      if (e.stateT >= e.stunLen) {
        e.cd = 20;
        setState(e, 'chase', 'none');
      }
      break;
    case 'doomed':
      e.vx = 0;
      e.vy = 0;
      if (e.stateT >= ENEMY.DOOM_TICKS) killEnemy(w, e, w.players.find((q) => q.id === e.doomBy) ?? null, 0, true);
      return;
    case 'patrol':
      patrol(c);
      break;
    default:
      switch (e.type) {
        case 'ashigaru': ashigaru(c); break;
        case 'archer': archer(c); break;
        case 'oni': oni(c); break;
        case 'ninja': ninja(c); break;
        case 'boss': boss(c); break;
      }
  }

  if (c.move !== 0) e.vx = approach(e.vx, c.move * c.speed, (e.onGround ? 1400 : 500) * DT);
  else if (e.onGround) e.vx = approach(e.vx, 0, c.friction * DT);
  if (c.gravity) e.vy = Math.min(e.vy + ENEMY.GRAVITY * DT, ENEMY.MAX_FALL);
  else e.vy = 0;
  moveBody(e, w.level, DT, false);
}

function patrol(c: Ctx): void {
  const { w, e, t } = c;
  const d = ENEMY[e.type];
  c.speed = d.patrolSpeed;
  c.move = e.patrolDir;
  if (blocked(w, e, c.move)) {
    e.patrolDir = -e.patrolDir as 1 | -1;
    c.move = 0;
  }
  e.facing = e.patrolDir;
  if (t && c.adx < d.sight && Math.abs(c.dy) < 160) {
    setState(e, 'chase', 'none');
    w.events.push({ type: 'alert', id: e.id, x: e.x, y: e.y - e.h });
  }
}

function startWindup(c: Ctx, move: EnemyMove): void {
  setState(c.e, 'windup', move);
  c.w.events.push({ type: 'windup', id: c.e.id, x: c.e.x, y: c.e.y - c.e.h, enemyType: c.e.type, move });
}

function separate(c: Ctx): void {
  for (const o of c.w.enemies) {
    if (o === c.e || o.state === 'dead') continue;
    const ox = c.e.x - o.x;
    if (Math.abs(ox) < (c.e.w + o.w) * 0.5 && Math.abs(c.e.y - o.y) < 30) c.e.vx += (ox >= 0 ? 1 : -1) * 25;
  }
}

/** Frappe de mêlée : une seule touche par attaque, parade = étourdissement. */
function meleeHit(c: Ctx, box: Rect, dmg: number): void {
  const { w, e } = c;
  if (e.hitDone) return;
  for (const p of w.players) {
    if (p.state === 'dead' || !overlaps(box, bodyRect(p))) continue;
    e.hitDone = true;
    if (damagePlayer(w, p, dmg, e.x) === 'parried') stunEnemy(w, e, -e.facing, e.type === 'oni' ? 90 : undefined);
    return;
  }
}

function lost(c: Ctx): boolean {
  if (!c.t || c.adx > ENEMY[c.e.type].sight * 1.6) {
    setState(c.e, 'patrol', 'none');
    return true;
  }
  return false;
}

function endRecover(c: Ctx): void {
  const d = ENEMY[c.e.type];
  if (c.e.stateT >= d.recover) {
    releaseToken(c.w, c.e);
    c.e.cd = Math.round(d.cooldown * enemyCooldownScale(c.w));
    setState(c.e, 'chase', 'none');
  }
}

// ─── Ashigaru : lancier ─────────────────────────────────────────────────────

function ashigaru(c: Ctx): void {
  const { w, e } = c;
  const d = ENEMY.ashigaru;
  switch (e.state) {
    case 'chase':
      if (lost(c)) return;
      e.facing = c.dx >= 0 ? 1 : -1;
      if (c.adx < d.range && Math.abs(c.dy) < 50 && e.cd <= 0 && takeToken(w, e)) return startWindup(c, 'thrust');
      if (c.adx > d.range * 0.75) {
        c.move = e.facing;
        c.speed = d.speed;
      }
      if (c.move !== 0 && blocked(w, e, c.move)) c.move = 0;
      separate(c);
      break;
    case 'windup':
      if (e.stateT >= d.windup) {
        setState(e, 'attack');
        e.vx = e.facing * d.lunge;
        e.hitDone = false;
      }
      break;
    case 'attack':
      c.friction = 1600;
      meleeHit(c, boxFromFacing(e.x, e.y, e.facing, SPEAR_HB), d.damage);
      if (e.state === 'attack' && e.stateT >= d.active) setState(e, 'recover');
      break;
    case 'recover':
      endRecover(c);
      break;
  }
}

// ─── Archer : garde ses distances, vise la poitrine (s'accroupir esquive) ───

function archer(c: Ctx): void {
  const { w, e, t } = c;
  const d = ENEMY.archer;
  switch (e.state) {
    case 'chase':
      if (lost(c)) return;
      e.facing = c.dx >= 0 ? 1 : -1;
      if (c.adx < 170) {
        c.move = -e.facing;
        c.speed = d.speed;
      } else if (c.adx > 400) {
        c.move = e.facing;
        c.speed = d.speed;
      }
      if (c.move !== 0 && blocked(w, e, c.move)) c.move = 0;
      if (e.cd <= 0 && c.adx < d.sight && Math.abs(c.dy) < 260 && takeToken(w, e)) return startWindup(c, 'shoot');
      separate(c);
      break;
    case 'windup':
      if (t) {
        e.facing = c.dx >= 0 ? 1 : -1;
        e.aimAng = clamp(Math.atan2(t.y - 34 - (e.y - 32), Math.max(40, c.adx)), -0.8, 0.8);
      }
      if (e.stateT >= d.windup) {
        const sx = e.x + e.facing * 12;
        const sy = e.y - 32;
        const spd = d.arrowSpeed;
        let vx = e.facing * spd;
        let vy = -40;
        if (t) {
          const ddx = t.x - sx;
          const time = clamp(Math.abs(ddx) / spd, 0.15, 1.2);
          vx = ddx / time;
          vy = (t.y - 34 - sy) / time - 0.5 * ENEMY.ARROW_GRAVITY * time;
        }
        fire(w, e, 'arrow', sx, sy, vx, vy, d.damage);
        w.events.push({ type: 'arrowFire', x: sx, y: sy });
        releaseToken(w, e);
        setState(e, 'recover');
      }
      break;
    case 'recover':
      endRecover(c);
      break;
  }
}

function fire(w: World, e: Enemy, kind: 'arrow' | 'shuriken', x: number, y: number, vx: number, vy: number, damage: number): void {
  w.projectiles.push({ id: w.nextId++, kind, x, y, vx, vy, owner: 'enemy', ownerId: e.id, damage, life: ENEMY.ARROW_LIFE, hits: [], dead: false });
}

// ─── Oni : bouclier frontal, se retourne lentement, massue écrasante ────────

function oni(c: Ctx): void {
  const { w, e } = c;
  const d = ENEMY.oni;
  switch (e.state) {
    case 'chase': {
      if (lost(c)) return;
      const behind = Math.sign(c.dx) !== e.facing && c.adx > 4;
      // Il met du temps à se retourner : la fenêtre pour frapper dans le dos.
      if (behind) {
        if (++e.aux > 30) {
          e.facing = -e.facing as 1 | -1;
          e.aux = 0;
        }
      } else e.aux = 0;
      if (!behind && c.adx < d.range && Math.abs(c.dy) < 60 && e.cd <= 0 && takeToken(w, e)) return startWindup(c, 'smash');
      if (!behind && c.adx > d.range * 0.7) {
        c.move = e.facing;
        c.speed = d.speed;
      }
      if (c.move !== 0 && blocked(w, e, c.move)) c.move = 0;
      separate(c);
      break;
    }
    case 'windup':
      if (e.stateT >= d.windup) {
        setState(e, 'attack');
        e.vx = e.facing * d.lunge;
        e.hitDone = false;
        w.events.push({ type: 'slam', x: e.x + e.facing * 46, y: e.y, w: 50 });
      }
      break;
    case 'attack':
      c.friction = 2000;
      meleeHit(c, boxFromFacing(e.x, e.y, e.facing, ONI_SMASH_HB), d.damage);
      if (e.state === 'attack' && e.stateT >= d.active) setState(e, 'recover');
      break;
    case 'recover':
      endRecover(c);
      break;
  }
}

// ─── Ninja : shurikens bas, disparition, réapparition dans le dos ───────────

function ninja(c: Ctx): void {
  const { w, e, t } = c;
  const d = ENEMY.ninja;
  switch (e.state) {
    case 'chase': {
      if (lost(c) || !t) return;
      e.facing = c.dx >= 0 ? 1 : -1;
      const threatened = t.state === 'attack' && c.adx < 80;
      if (e.dodgeCd <= 0 && (c.adx < 110 || (threatened && w.rng.next() < 0.35))) return vanish(c);
      if (e.cd <= 0 && c.adx < 430 && Math.abs(c.dy) < 40 && takeToken(w, e)) {
        e.aux = 2;
        return startWindup(c, 'throw');
      }
      if (c.adx > 260) {
        c.move = e.facing;
        c.speed = d.speed;
      } else if (c.adx < 170) {
        c.move = -e.facing;
        c.speed = d.speed * 0.8;
      }
      if (c.move !== 0 && blocked(w, e, c.move)) c.move = 0;
      separate(c);
      break;
    }
    case 'hidden': {
      c.gravity = false;
      e.vx = 0;
      if (e.stateT >= 16) {
        e.x = e.tx;
        if (t) {
          const gy = findGround(w.level, e.x, t.y, 1);
          if (gy !== null) e.y = gy;
          e.facing = t.x >= e.x ? 1 : -1;
        }
        e.dodgeCd = 200;
        w.events.push({ type: 'appear', id: e.id, x: e.x, y: e.y - e.h / 2 });
        startWindup(c, 'slash');
      }
      break;
    }
    case 'windup': {
      if (t && e.move === 'slash') e.facing = c.dx >= 0 ? 1 : -1;
      if (e.move === 'throw' && e.stateT >= d.windup + 4) {
        const sy = e.y - 14; // vol bas : il faut sauter
        fire(w, e, 'shuriken', e.x + e.facing * 10, sy, e.facing * d.arrowSpeed, 0, 8);
        w.events.push({ type: 'throw', x: e.x, y: sy });
        if (--e.aux > 0) e.stateT = d.windup - 4;
        else {
          releaseToken(w, e);
          setState(e, 'recover');
        }
      } else if (e.move === 'slash' && e.stateT >= d.windup + 2) {
        setState(e, 'attack');
        e.vx = e.facing * d.lunge;
        e.hitDone = false;
      }
      break;
    }
    case 'attack':
      c.friction = 1800;
      meleeHit(c, boxFromFacing(e.x, e.y, e.facing, NINJA_SLASH_HB), d.damage);
      if (e.state === 'attack' && e.stateT >= d.active) setState(e, 'recover');
      break;
    case 'recover':
      endRecover(c);
      break;
  }
}

function vanish(c: Ctx): void {
  const { w, e, t } = c;
  if (!t) return;
  // Derrière le joueur si possible, sinon de l'autre côté.
  const cands = [t.x - t.facing * 56, t.x + t.facing * 56];
  let tx: number | null = null;
  for (const x of cands) {
    const gy = findGround(w.level, x, t.y, 1);
    if (gy !== null && Math.abs(gy - t.y) < 40 && fitsAt(w.level, x, gy, e.w, e.h)) {
      tx = x;
      break;
    }
  }
  if (tx === null) {
    e.dodgeCd = 60;
    return;
  }
  releaseToken(w, e);
  e.tx = tx;
  w.events.push({ type: 'vanish', id: e.id, x: e.x, y: e.y - e.h / 2 });
  setState(e, 'hidden', 'none');
}

// ─── Akaoni : le général démon ─────────────────────────────────────────────

function boss(c: Ctx): void {
  const { w, e, t } = c;
  const d = ENEMY.boss;
  const p2 = e.phase2;
  switch (e.state) {
    case 'intro':
      if (e.stateT === 30) w.events.push({ type: 'roar', id: e.id, x: e.x, y: e.y - e.h });
      if (e.stateT >= (p2 ? 50 : BOSS.INTRO)) setState(e, 'chase', 'none');
      break;
    case 'chase': {
      if (!t) break;
      e.facing = c.dx >= 0 ? 1 : -1;
      if (!p2 && e.hp < e.maxHp * guardianRageAt(w.stage.loop)) {
        e.phase2 = true;
        w.events.push({ type: 'bossPhase', id: e.id, x: e.x, y: e.y - e.h });
        setState(e, 'intro', 'none');
        return;
      }
      if (e.cd <= 0) {
        const hornDue = (e.hornStage === 0 && e.hp < e.maxHp * 0.7) || (e.hornStage === 1 && e.hp < e.maxHp * 0.35);
        if (hornDue) return startWindup(c, 'horn');
        if (c.adx < d.range && Math.abs(c.dy) < 80) return startWindup(c, 'sweep');
        if (c.adx > 220 || c.dy < -80) return startWindup(c, p2 && w.rng.next() < 0.45 && Math.abs(c.dy) < 40 ? 'charge' : 'leap');
      }
      if (c.adx > 100) {
        c.move = e.facing;
        c.speed = d.speed * (p2 ? BOSS.RAGE_SPEED : 1);
      }
      if (c.move !== 0 && touchingWall(e, w.level, c.move)) c.move = 0;
      break;
    }
    case 'windup': {
      const wind = bossWindup(e);
      if (t && e.move !== 'charge') e.facing = c.dx >= 0 ? 1 : -1;
      if (e.stateT < wind) break;
      e.hitDone = false;
      if (e.move === 'sweep') setState(e, 'attack');
      else if (e.move === 'leap' && t) {
        const G = ENEMY.GRAVITY;
        const h = Math.max(0, e.y - t.y) + 90;
        const vy0 = -Math.sqrt(2 * G * h);
        const time = -vy0 / G + Math.sqrt((2 * 90) / G);
        e.vy = vy0;
        e.vx = clamp((t.x - e.x) / time, -900, 900);
        e.onGround = false;
        setState(e, 'attack');
      } else if (e.move === 'charge') {
        setState(e, 'attack');
        w.events.push({ type: 'charge', x: e.x, y: e.y, dir: e.facing });
      } else if (e.move === 'horn') {
        e.hornStage++;
        w.events.push({ type: 'horn', x: e.x, y: e.y - e.h });
        for (const side of [-1, 1, -1].slice(0, BOSS.HORN_ADDS)) {
          const x = clamp(e.x + side * (150 + w.rng.next() * 80), 3 * TILE, (w.level.w - 3) * TILE);
          const gy = findGround(w.level, x, e.y);
          if (gy !== null) spawnEnemy(w, 'ashigaru', x, gy, true, enemyHpScale(w));
        }
        setState(e, 'recover');
      } else setState(e, 'chase', 'none');
      break;
    }
    case 'attack': {
      if (e.move === 'sweep') {
        c.friction = 3000;
        meleeHit(c, boxFromFacing(e.x, e.y, e.facing, BOSS.SWEEP_HB), d.damage);
        if (e.state === 'attack' && e.stateT >= d.active) setState(e, 'recover');
      } else if (e.move === 'leap') {
        c.move = 0;
        if (e.stateT > 4 && e.onGround) {
          e.vx = 0;
          const shock: Rect = { x: e.x - BOSS.SLAM_W, y: e.y - BOSS.SLAM_H, w: BOSS.SLAM_W * 2, h: BOSS.SLAM_H };
          meleeHit(c, shock, BOSS.SLAM_DMG);
          w.events.push({ type: 'slam', x: e.x, y: e.y, w: BOSS.SLAM_W });
          if (e.state === 'attack') setState(e, 'recover');
        } else if (e.stateT > 120) setState(e, 'recover');
      } else if (e.move === 'charge') {
        e.vx = e.facing * BOSS.CHARGE_SPEED;
        c.move = e.facing;
        c.speed = BOSS.CHARGE_SPEED;
        meleeHit(c, bodyRect(e), BOSS.CHARGE_DMG);
        if (e.state === 'attack' && (e.stateT >= BOSS.CHARGE_TICKS || touchingWall(e, w.level, e.facing))) {
          e.vx = 0;
          setState(e, 'recover');
        }
      }
      break;
    }
    case 'recover': {
      c.friction = 2400;
      const rec =
        e.move === 'charge' ? BOSS.CHARGE_RECOVER
        : e.move === 'leap' ? (p2 ? BOSS.LEAP_RECOVER_RAGE : BOSS.LEAP_RECOVER)
        : p2 ? BOSS.SWEEP_RECOVER_RAGE : d.recover;
      if (e.stateT >= rec) {
        e.cd = p2 ? BOSS.COOLDOWN_RAGE : d.cooldown;
        setState(e, 'chase', 'none');
      }
      break;
    }
  }
}


/** Durée de préparation de l'attaque en cours du boss (partagée avec le rendu des télégraphes). */
export function bossWindup(e: Enemy): number {
  switch (e.move) {
    case 'sweep':
      return e.phase2 ? BOSS.SWEEP_WINDUP_RAGE : ENEMY.boss.windup;
    case 'horn':
      return BOSS.HORN_WINDUP;
    case 'charge':
      return BOSS.CHARGE_WINDUP;
    default:
      return BOSS.LEAP_WINDUP;
  }
}
