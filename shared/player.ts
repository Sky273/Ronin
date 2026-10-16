import { ATTACKS, type AttackDef, type AttackId, activeAttackBox, bodyRect } from './combat';
import { DT, PLAYER as P } from './constants';
import { BTN } from './input';
import { calmHordeOnRespawn, doomEnemy, hitEnemy } from './interactions';
import { airJumps, applyUpgrade, dashCooldown, dmgMult, emptyUpgrades, iaiDistMult, iaiRate, rollOffer, runSpeed } from './upgrades';
import { approach, overlaps, type Rect } from './math';
import { canFit, fitsAt, moveBody, type MoveResult, standingOnOneWay, touchingWall } from './physics';
import type { Player, World } from './types';

// Machine à états du samouraï. Fonction pure de (état, entrées) → nouvel état :
// le même code tournera côté serveur (autorité) et côté client (prédiction).

export function createPlayer(id: number, name: string, x: number, y: number): Player {
  return {
    id, name, x, y, vx: 0, vy: 0, w: P.W, h: P.H, onGround: false,
    facing: 1, state: 'normal', stateT: 0, hp: P.MAX_HP, maxHp: P.MAX_HP, crouch: false, wallDir: 0,
    coyote: 0, airJumps: P.AIR_JUMPS, airDash: false, dashCd: 0,
    jumpBuffer: 0, attackBuffer: 0, parryBuffer: 0, dashBuffer: 0, downBuffer: 0, jumpHeld: false, dropT: 0,
    iframes: 0, freeze: 0, lock: 0,
    attack: null, queued: false, chainNext: null, chainT: 0, hitList: [], plungeLanded: false,
    iaiCharge: 0, iaiFrom: x, iaiTo: x, iaiFull: false,
    prevButtons: 0,
    kills: 0, combo: 0, comboTimer: 0, bestCombo: 0,
    honor: 0, level: 0, picks: 0, offer: [], up: emptyUpgrades(), lostX: NaN, lostY: NaN,
    lives: 5, score: 0, runKills: 0, out: false, outT: 0,
    respawnT: 0, spawnX: x, spawnY: y, checkpoint: 0,
    doubleJumpTick: -999, parryTick: -999,
  };
}

const dirOf = (b: number): number => ((b & BTN.RIGHT) ? 1 : 0) - ((b & BTN.LEFT) ? 1 : 0);

export function stepPlayer(w: World, p: Player, buttons: number): void {
  const pressed = buttons & ~p.prevButtons;
  p.prevButtons = buttons;

  // Tampons d'entrée : une pression légèrement anticipée n'est jamais perdue.
  if (pressed & BTN.JUMP) p.jumpBuffer = P.JUMP_BUFFER;
  if (pressed & BTN.ATTACK) {
    p.attackBuffer = P.ATTACK_BUFFER;
    if (p.state === 'attack') p.queued = true;
  }
  if (pressed & BTN.PARRY) p.parryBuffer = P.ACTION_BUFFER;
  if (pressed & BTN.DASH) p.dashBuffer = P.ACTION_BUFFER;
  if (pressed & BTN.DOWN) p.downBuffer = P.ACTION_BUFFER;

  handlePicks(w, p, pressed);
  if (p.state !== 'dead') touchCheckpoints(w, p);

  if (p.freeze > 0) {
    p.freeze--;
    return;
  }

  p.stateT++;
  if (p.iframes > 0) p.iframes--;
  if (p.dashCd > 0) p.dashCd--;
  if (p.lock > 0) p.lock--;
  if (p.dropT > 0) p.dropT--;
  if (p.chainT > 0) p.chainT--;
  else p.chainNext = null;
  if (p.comboTimer > 0 && --p.comboTimer === 0) p.combo = 0;

  switch (p.state) {
    case 'normal': stepNormal(w, p, buttons, pressed); break;
    case 'dash': stepDash(w, p, buttons); break;
    case 'slide': stepSlide(w, p, buttons); break;
    case 'attack': stepAttack(w, p, buttons); break;
    case 'parry': stepParry(w, p); break;
    case 'iaiCharge': stepIaiCharge(w, p, buttons); break;
    case 'iaiStrike': stepIaiStrike(w, p); break;
    case 'hurt': stepHurt(w, p); break;
    case 'dead': stepDead(w, p); break;
  }

  if (p.jumpBuffer > 0) p.jumpBuffer--;
  if (p.attackBuffer > 0) p.attackBuffer--;
  if (p.parryBuffer > 0) p.parryBuffer--;
  if (p.dashBuffer > 0) p.dashBuffer--;
  if (p.downBuffer > 0) p.downBuffer--;
}

function physics(w: World, p: Player): MoveResult {
  const wasGround = p.onGround;
  const vyBefore = p.vy;
  const res = moveBody(p, w.level, DT, p.dropT > 0);
  if (!wasGround && p.onGround) w.events.push({ type: 'land', x: p.x, y: p.y, impact: vyBefore, pid: p.id });
  return res;
}

function gravity(p: Player, scale = 1, maxFall: number = P.MAX_FALL): void {
  p.vy = Math.min(p.vy + P.GRAVITY * DT * scale, maxFall);
}

function toNormal(p: Player): void {
  p.state = 'normal';
  p.stateT = 0;
}

function tryStand(w: World, p: Player): void {
  if (p.h !== P.H && canFit(p, w.level, P.H)) {
    p.h = P.H;
    p.crouch = false;
  }
}

// ─── État normal : course, saut, accroupi, wall-slide ───────────────────────

function stepNormal(w: World, p: Player, b: number, pressed: number): void {
  const L = w.level;
  const dirX = dirOf(b);
  const down = (b & BTN.DOWN) !== 0;

  if (down && p.onGround) {
    if (!p.crouch) {
      p.crouch = true;
      p.h = P.CROUCH_H;
    }
  } else if (p.crouch && canFit(p, L, P.H)) {
    p.crouch = false;
    p.h = P.H;
  }

  // Actions prioritaires
  if (p.dashBuffer > 0 && p.dashCd <= 0 && (p.onGround || !p.airDash) && canFit(p, L, P.H)) {
    startDash(w, p, dirX);
    return;
  }
  if (p.parryBuffer > 0) {
    startParry(w, p);
    return;
  }
  if (pressed & BTN.IAI) {
    startIai(w, p);
    return;
  }
  if (p.attackBuffer > 0) {
    startAttack(w, p, chooseAttack(p, b), dirX);
    return;
  }
  if (p.downBuffer > 0 && p.onGround && dirX !== 0 && Math.abs(p.vx) > P.RUN_SPEED * 0.6) {
    startSlide(w, p);
    return;
  }

  // Déplacement horizontal
  const maxSpd = p.crouch ? P.CROUCH_SPEED : runSpeed(p);
  if (p.lock <= 0) {
    if (dirX !== 0) {
      p.facing = dirX as 1 | -1;
      if (Math.sign(p.vx) === dirX && Math.abs(p.vx) > maxSpd) {
        p.vx = approach(p.vx, dirX * maxSpd, (p.onGround ? P.GROUND_DECEL : P.AIR_DECEL) * 0.5 * DT);
      } else {
        p.vx = approach(p.vx, dirX * maxSpd, (p.onGround ? P.GROUND_ACCEL : P.AIR_ACCEL) * DT);
      }
    } else {
      p.vx = approach(p.vx, 0, (p.onGround ? P.GROUND_DECEL : P.AIR_DECEL) * DT);
    }
  }

  if (p.onGround) {
    p.coyote = P.COYOTE;
    p.airJumps = airJumps(p);
    p.airDash = false;
  } else if (p.coyote > 0) p.coyote--;

  // Glissade contre un mur
  p.wallDir = 0;
  if (!p.onGround && dirX !== 0 && touchingWall(p, L, dirX)) {
    p.wallDir = dirX as 1 | -1;
    p.airJumps = airJumps(p);
    p.airDash = false;
  }

  // Saut (avec coyote time, saut mural, double saut, descente de plateforme)
  if (p.jumpBuffer > 0) {
    const wallSide = p.wallDir || (!p.onGround ? (touchingWall(p, L, 1) ? 1 : touchingWall(p, L, -1) ? -1 : 0) : 0);
    if (p.onGround && down && standingOnOneWay(p, L)) {
      p.dropT = 12;
      p.jumpBuffer = 0;
      p.onGround = false;
      tryStand(w, p);
    } else if (p.coyote > 0 && (!p.crouch || canFit(p, L, P.H))) {
      tryStand(w, p);
      p.vy = -P.JUMP_VEL;
      p.coyote = 0;
      p.jumpBuffer = 0;
      p.jumpHeld = true;
      p.onGround = false;
      w.events.push({ type: 'jump', x: p.x, y: p.y, double: false, pid: p.id });
    } else if (!p.onGround && wallSide !== 0) {
      p.vy = -P.WALL_JUMP_VY;
      p.vx = -wallSide * P.WALL_JUMP_VX;
      p.facing = -wallSide as 1 | -1;
      p.lock = P.WALL_JUMP_LOCK;
      p.jumpBuffer = 0;
      p.jumpHeld = true;
      p.wallDir = 0;
      w.events.push({ type: 'wallJump', x: p.x + wallSide * p.w * 0.5, y: p.y - p.h * 0.5, dir: -wallSide, pid: p.id });
    } else if (!p.onGround && p.airJumps > 0) {
      p.vy = -P.DOUBLE_JUMP_VEL;
      p.airJumps--;
      p.jumpBuffer = 0;
      p.jumpHeld = true;
      p.doubleJumpTick = w.tick;
      w.events.push({ type: 'jump', x: p.x, y: p.y, double: true, pid: p.id });
    }
  }

  // Saut à hauteur variable
  if (p.jumpHeld && !(b & BTN.JUMP)) {
    if (p.vy < 0) p.vy *= P.JUMP_CUT;
    p.jumpHeld = false;
  }
  if (p.vy >= 0) p.jumpHeld = false;

  gravity(p, 1, down && !p.onGround ? P.FAST_FALL : P.MAX_FALL);
  if (p.wallDir !== 0 && p.vy > P.WALL_SLIDE_MAX) p.vy = P.WALL_SLIDE_MAX;
  physics(w, p);
}

// ─── Dash ───────────────────────────────────────────────────────────────────

function startDash(w: World, p: Player, dirX: number): void {
  if (dirX) p.facing = dirX as 1 | -1;
  p.state = 'dash';
  p.stateT = 0;
  p.dashBuffer = 0;
  p.dashCd = dashCooldown(p);
  if (!p.onGround) p.airDash = true;
  p.vx = p.facing * P.DASH_SPEED;
  p.vy = 0;
  p.iframes = Math.max(p.iframes, P.DASH_TICKS);
  p.crouch = false;
  p.h = P.H;
  p.attack = null;
  w.events.push({ type: 'dash', x: p.x, y: p.y, dir: p.facing, pid: p.id });
}

function stepDash(w: World, p: Player, b: number): void {
  p.vx = p.facing * P.DASH_SPEED;
  p.vy = 0;
  physics(w, p);
  if (p.onGround) p.coyote = P.COYOTE;

  if (p.attackBuffer > 0 && p.stateT >= 3) {
    p.vx = p.facing * runSpeed(p);
    startAttack(w, p, chooseAttack(p, b), 0);
    return;
  }
  if (p.jumpBuffer > 0 && p.coyote > 0) {
    toNormal(p);
    p.vx = p.facing * runSpeed(p) * 1.15;
    return;
  }
  if (p.stateT >= P.DASH_TICKS) {
    toNormal(p);
    p.vx = p.facing * runSpeed(p);
  }
}

// ─── Glissade ───────────────────────────────────────────────────────────────

function startSlide(w: World, p: Player): void {
  p.state = 'slide';
  p.stateT = 0;
  p.downBuffer = 0;
  p.h = P.SLIDE_H;
  p.crouch = true;
  p.vx = p.facing * Math.max(P.SLIDE_SPEED, Math.abs(p.vx));
  w.events.push({ type: 'slide', x: p.x, y: p.y, dir: p.facing, pid: p.id });
}

function stepSlide(w: World, p: Player, b: number): void {
  const L = w.level;
  p.vx = approach(p.vx, 0, P.SLIDE_FRICTION * DT);
  gravity(p);
  physics(w, p);

  if (p.jumpBuffer > 0 && canFit(p, L, P.H)) {
    p.h = P.H;
    p.crouch = false;
    p.coyote = P.COYOTE;
    toNormal(p);
    return;
  }
  if (p.attackBuffer > 0 && p.stateT > 4 && canFit(p, L, P.H)) {
    p.h = P.H;
    p.crouch = false;
    startAttack(w, p, 'upSlash', dirOf(b)); // glissade + attaque = lanceur
    return;
  }
  const done = p.stateT >= P.SLIDE_TICKS || Math.abs(p.vx) < P.SLIDE_MIN_SPEED || !p.onGround;
  if (done) {
    if (canFit(p, L, P.H)) {
      p.h = P.H;
      p.crouch = false;
      toNormal(p);
    } else if (canFit(p, L, P.CROUCH_H)) {
      p.h = P.CROUCH_H;
      p.crouch = true;
      toNormal(p);
    } else {
      p.vx = p.facing * P.SLIDE_MIN_SPEED; // toujours coincé sous un plafond : on continue
    }
  }
}

// ─── Attaques au katana ─────────────────────────────────────────────────────

function chooseAttack(p: Player, b: number): AttackId {
  const up = (b & BTN.UP) !== 0;
  const down = (b & BTN.DOWN) !== 0;
  if (!p.onGround) {
    if (down) return 'plunge';
    if (up) return 'upSlash';
    return 'airSlash';
  }
  if (up) return 'upSlash';
  if (p.chainNext) return p.chainNext;
  return 'slash1';
}

function startAttack(w: World, p: Player, id: AttackId, dirX: number): void {
  p.state = 'attack';
  p.stateT = 0;
  p.attack = id;
  p.attackBuffer = 0;
  p.queued = false;
  p.hitList.length = 0;
  p.plungeLanded = false;
  p.chainNext = null;
  p.chainT = 0;
  if (dirX) p.facing = dirX as 1 | -1;
  tryStand(w, p);
  if (!ATTACKS[id].air) p.vx *= 0.3;
}

function endAttack(p: Player, natural: boolean): void {
  const d = p.attack ? ATTACKS[p.attack] : null;
  if (natural && d && d.next && p.onGround) {
    p.chainNext = d.next;
    p.chainT = P.CHAIN_WINDOW;
  }
  p.attack = null;
  p.queued = false;
  toNormal(p);
}

function stepAttack(w: World, p: Player, b: number): void {
  const id = p.attack!;
  const d = ATTACKS[id];
  const t = p.stateT;
  const dirX = dirOf(b);
  const activeStart = d.startup + 1;
  const activeEnd = d.startup + d.active;

  if (id === 'plunge') {
    stepPlunge(w, p, d);
    return;
  }

  if (t === activeStart) {
    if (d.lunge) p.vx = p.onGround ? p.facing * d.lunge : p.facing * Math.max(Math.abs(p.vx), d.lunge * 0.5);
    if (d.air && p.vy > 0) p.vy *= 0.3;
    w.events.push({ type: 'swing', pid: p.id, attack: id, x: p.x, y: p.y, dir: p.facing });
    if (id === 'slash3' && p.up.storm > 0) windSlash(w, p);
  }

  if (p.onGround) p.vx = approach(p.vx, 0, 1800 * DT);
  else if (dirX) p.vx = approach(p.vx, dirX * runSpeed(p) * 0.8, 900 * DT);
  gravity(p, d.air && t <= activeEnd ? 0.35 : 1);
  physics(w, p);

  if (t >= activeStart && t <= activeEnd) doHits(w, p, d);

  // Annulations : dash à tout moment après le début de l'animation active,
  // saut après un coup réussi, enchaînement du combo.
  if (t >= activeStart && p.dashBuffer > 0 && p.dashCd <= 0 && (p.onGround || !p.airDash)) {
    endAttack(p, false);
    startDash(w, p, dirX);
    return;
  }
  if (p.hitList.length > 0 && t > activeEnd && p.jumpBuffer > 0 && (p.onGround || p.airJumps > 0)) {
    endAttack(p, false);
    return;
  }
  if (p.queued && t > activeEnd && d.next && p.onGround) {
    startAttack(w, p, d.next, dirX);
    return;
  }
  if (t >= activeEnd + d.recovery) endAttack(p, true);
}

function doHits(w: World, p: Player, d: AttackDef): void {
  const box = activeAttackBox(p);
  if (!box) return;
  const before = p.hitList.length;
  for (const e of w.enemies) {
    if (e.state === 'dead' || e.state === 'doomed' || p.hitList.includes(e.id)) continue;
    if (overlaps(box, bodyRect(e))) {
      p.hitList.push(e.id);
      const res = hitEnemy(w, p, e, {
        dmg: d.damage * dmgMult(p), kbx: d.kbx * p.facing, kby: d.kby, hitstop: d.hitstop,
        cut: d.cut, heavy: d.heavy, fromX: p.x, fromY: p.y - p.h * 0.5,
      });
      if (res !== 'blocked' && p.freeze < d.hitstop) p.freeze = d.hitstop;
    }
  }
  // Flèches et shurikens peuvent être tranchés et renvoyés.
  for (const a of w.projectiles) {
    if (a.dead || a.owner !== 'enemy') continue;
    if (a.x > box.x && a.x < box.x + box.w && a.y > box.y && a.y < box.y + box.h) {
      a.owner = 'player';
      a.ownerId = p.id;
      a.vx = p.facing * 720;
      a.vy = -40;
      a.life = 120;
      a.damage = 30;
      a.hits = [];
      w.events.push({ type: 'deflect', x: a.x, y: a.y });
    }
  }
  if (p.hitList.length > before) {
    if (p.onGround) p.vx *= 0.5;
    else p.vy = Math.min(p.vy, -160); // petit rebond : les combos aériens restent en l'air
  }
}

function stepPlunge(w: World, p: Player, d: AttackDef): void {
  const t = p.stateT;
  if (p.plungeLanded) {
    p.vx = approach(p.vx, 0, 2400 * DT);
    gravity(p);
    physics(w, p);
    if (t >= d.recovery) endAttack(p, false);
    return;
  }
  if (t <= d.startup) {
    p.vy = -60;
    p.vx *= 0.85;
    physics(w, p);
    return;
  }
  if (t === d.startup + 1) w.events.push({ type: 'swing', pid: p.id, attack: 'plunge', x: p.x, y: p.y, dir: p.facing });
  p.vy = 980;
  p.vx = approach(p.vx, 0, 600 * DT);
  physics(w, p);

  const before = p.hitList.length;
  doHits(w, p, d);
  if (p.hitList.length > before) {
    // Rebond sur l'ennemi (pogo) : restaure double saut et dash aérien.
    p.vy = -620;
    p.airJumps = airJumps(p);
    p.airDash = false;
    endAttack(p, false);
    return;
  }
  if (p.onGround) {
    p.plungeLanded = true;
    p.stateT = 0;
    const shock: Rect = { x: p.x - 50, y: p.y - 28, w: 100, h: 30 };
    for (const e of w.enemies) {
      if (e.state === 'dead' || e.state === 'doomed' || p.hitList.includes(e.id)) continue;
      if (overlaps(shock, bodyRect(e))) {
        p.hitList.push(e.id);
        hitEnemy(w, p, e, {
          dmg: 14 * dmgMult(p), kbx: (e.x >= p.x ? 1 : -1) * 240, kby: -320, hitstop: 5,
          cut: 0, heavy: true, fromX: p.x, fromY: p.y - 200,
        });
      }
    }
    w.events.push({ type: 'plungeLand', x: p.x, y: p.y, pid: p.id });
  }
}

// ─── Parade ─────────────────────────────────────────────────────────────────

function startParry(w: World, p: Player): void {
  p.state = 'parry';
  p.stateT = 0;
  p.parryBuffer = 0;
  p.vx *= 0.4;
  p.parryTick = w.tick;
  tryStand(w, p);
}

function stepParry(w: World, p: Player): void {
  p.vx = approach(p.vx, 0, 2000 * DT);
  gravity(p, p.onGround ? 1 : 0.6);
  physics(w, p);
  if (p.stateT >= P.PARRY_ACTIVE + P.PARRY_RECOVERY) toNormal(p);
}

// ─── Iaijutsu : dégainer-frapper chargé ─────────────────────────────────────

function startIai(w: World, p: Player): void {
  p.state = 'iaiCharge';
  p.stateT = 0;
  p.iaiCharge = 0;
  w.events.push({ type: 'iaiStart', pid: p.id });
}

function stepIaiCharge(w: World, p: Player, b: number): void {
  const dirX = dirOf(b);
  if (dirX) p.facing = dirX as 1 | -1;
  const before = p.iaiCharge;
  p.iaiCharge += iaiRate(p);
  if (before < P.IAI_FULL_CHARGE && p.iaiCharge >= P.IAI_FULL_CHARGE) w.events.push({ type: 'iaiReady', x: p.x, y: p.y - 30, pid: p.id });
  p.vx = approach(p.vx, 0, 2600 * DT);
  if (p.onGround || p.iaiCharge > 70) gravity(p);
  else gravity(p, 0.2, 120); // suspension dans les airs pendant la concentration
  physics(w, p);

  if (p.dashBuffer > 0 && p.dashCd <= 0 && (p.onGround || !p.airDash) && canFit(p, w.level, P.H)) {
    startDash(w, p, dirX);
    return;
  }
  if (!(b & BTN.IAI)) {
    if (p.iaiCharge >= P.IAI_MIN_CHARGE) iaiStrike(w, p);
    else toNormal(p);
  }
}

function iaiStrike(w: World, p: Player): void {
  const L = w.level;
  const full = p.iaiCharge >= P.IAI_FULL_CHARGE;
  const dist = (full ? P.IAI_DIST_FULL : P.IAI_DIST) * iaiDistMult(p);
  const x0 = p.x;
  let x = p.x;
  for (let d = 0; d < dist; d += 4) {
    const nx = x + p.facing * 4;
    if (!fitsAt(L, nx, p.y, p.w, p.h)) break;
    x = nx;
  }
  p.x = x;
  p.iaiFrom = x0;
  p.iaiTo = x;
  p.iaiFull = full;

  const rect: Rect = { x: Math.min(x0, x) - p.w / 2 - 14, y: p.y - p.h - 10, w: Math.abs(x - x0) + p.w + 28, h: p.h + 16 };
  const dmg = (full ? P.IAI_DAMAGE_FULL : P.IAI_DAMAGE) * dmgMult(p);
  let count = 0;
  for (const e of w.enemies) {
    if (e.state === 'dead' || e.state === 'doomed' || e.state === 'hidden' || e.state === 'intro') continue;
    if (!overlaps(rect, bodyRect(e))) continue;
    count++;
    const mult = e.state === 'stunned' ? 1.5 : 1;
    if (e.type !== 'boss' && e.hp - dmg * mult <= 0) doomEnemy(w, p, e);
    else hitEnemy(w, p, e, { dmg, kbx: p.facing * 350, kby: -200, hitstop: 10, cut: 0, heavy: true, fromX: x0, fromY: p.y - p.h * 0.5 });
  }
  for (const a of w.projectiles) {
    if (!a.dead && a.owner === 'enemy' && a.x > rect.x && a.x < rect.x + rect.w && a.y > rect.y && a.y < rect.y + rect.h) {
      a.dead = true;
      w.events.push({ type: 'arrowBreak', x: a.x, y: a.y });
    }
  }

  p.state = 'iaiStrike';
  p.stateT = 0;
  p.vx = p.facing * 80;
  p.vy = 0;
  p.iframes = Math.max(p.iframes, P.IAI_RECOVERY + 4);
  if (count > 0) p.freeze = 6;
  w.events.push({ type: 'iai', x0, x1: x, y: p.y, full, count, pid: p.id });
}

function stepIaiStrike(w: World, p: Player): void {
  p.vx = approach(p.vx, 0, 1200 * DT);
  if (p.stateT < 8) p.vy = 0;
  else gravity(p);
  physics(w, p);
  if (p.stateT >= P.IAI_RECOVERY) toNormal(p);
}

// ─── Touché / mort ──────────────────────────────────────────────────────────

function stepHurt(w: World, p: Player): void {
  p.vx = approach(p.vx, 0, 600 * DT);
  gravity(p);
  physics(w, p);
  if (p.stateT >= P.HURT_TICKS) toNormal(p);
}

function stepDead(w: World, p: Player): void {
  p.vx = approach(p.vx, 0, 900 * DT);
  gravity(p);
  physics(w, p);
  // Plus de vie : le corps reste au sol, plus de renaissance.
  if (p.out) {
    p.outT++;
    return;
  }
  if (--p.respawnT <= 0) {
    calmHordeOnRespawn(w, p, p.x);
    p.x = p.spawnX;
    p.y = p.spawnY;
    p.vx = 0;
    p.vy = 0;
    // Mort = nouvelle vie : améliorations et Honneur repartent de zéro.
    p.up = emptyUpgrades();
    p.maxHp = P.MAX_HP;
    p.hp = P.MAX_HP;
    p.honor = 0;
    p.level = 0;
    p.picks = 0;
    p.offer = [];
    p.h = P.H;
    p.crouch = false;
    p.kills = 0; // comme dans tout bon .io : on repart de zéro
    p.combo = 0;
    p.iframes = 90;
    toNormal(p);
    w.events.push({ type: 'respawn', x: p.x, y: p.y, pid: p.id });
  }
}

// ─── Divers ─────────────────────────────────────────────────────────────────

/** Choix d'amélioration (1/2/3) : sans pause, comme dans tout .io. */
export function handlePicks(w: World, p: Player, pressed: number): void {
  const pick = pressed & BTN.PICK1 ? 0 : pressed & BTN.PICK2 ? 1 : pressed & BTN.PICK3 ? 2 : -1;
  if (pick < 0 || !p.offer[pick] || p.state === 'dead') return;
  const id = p.offer[pick];
  applyUpgrade(p, id);
  p.picks--;
  p.offer = p.picks > 0 ? rollOffer(w.rng, p.up) : [];
  w.events.push({ type: 'pick', upgrade: id, level: p.up[id], pid: p.id });
}

/** Début d'une nouvelle boucle : on garde la progression, on repart du premier sanctuaire. */
export function resetForStage(p: Player, x: number, y: number): void {
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.h = P.H;
  p.crouch = false;
  p.hp = p.maxHp;
  p.state = 'normal';
  p.stateT = 0;
  p.attack = null;
  p.spawnX = x;
  p.spawnY = y;
  p.checkpoint = 0;
  p.lostX = NaN;
  p.lostY = NaN;
  p.combo = 0;
  p.comboTimer = 0;
  p.iframes = 90;
  p.jumpBuffer = 0;
  p.attackBuffer = 0;
  p.dashBuffer = 0;
  p.parryBuffer = 0;
  p.downBuffer = 0;
}

/** Tempête de lames : le 3e coup du combo libère une vague de vent tranchante. */
function windSlash(w: World, p: Player): void {
  const lvl = p.up.storm;
  w.projectiles.push({
    id: w.nextId++, kind: 'wave', x: p.x + p.facing * 30, y: p.y - 26, vx: p.facing * 640, vy: 0,
    owner: 'player', ownerId: p.id, damage: 10 + 7 * lvl, life: 26 + 8 * lvl, hits: [], dead: false,
  });
  w.events.push({ type: 'windSlash', x: p.x + p.facing * 30, y: p.y - 26, dir: p.facing });
}

/** Sanctuaires : point de réapparition + soins complets. */
function touchCheckpoints(w: World, p: Player): void {
  const cps = w.level.checkpoints;
  for (let i = 0; i < cps.length; i++) {
    if (i === p.checkpoint) continue;
    const c = cps[i];
    if (Math.abs(p.x - c.x) < 40 && Math.abs(p.y - c.y) < 50) {
      p.checkpoint = i;
      p.spawnX = c.x;
      p.spawnY = c.y;
      p.hp = p.maxHp;
      w.events.push({ type: 'checkpoint', x: c.x, y: c.y, index: i, pid: p.id });
    }
  }
}
