import type Phaser from 'phaser';
import { BOSS, ENEMY } from '../../shared/constants';
import type { Enemy, EnemyType } from '../../shared/types';
import { catmull, gBlob, gFill, gStroke, type Pt, type Rand, ringPoints } from './brush';
import {
  add, buildSkeleton, clamp01, easeOut, lerpPose, mix, polar, type Pose, type Prop, SAMURAI,
  type Skeleton, star, V, type Xf,
} from './characters';
import { C } from './palette';

type G = Phaser.GameObjects.Graphics;

// ─── Squelettes ────────────────────────────────────────────────────────────

export const SOLDIER: Prop = { torso: 16, thigh: 12, shin: 12.5, upper: 8.5, fore: 9, headR: 5.6 };
const PROP: Record<EnemyType, Prop> = { ashigaru: SOLDIER, archer: SOLDIER, oni: SOLDIER, ninja: SAMURAI, boss: SAMURAI };
/** Échelle de dessin : les poses sont exprimées à taille humaine puis agrandies. */
export const SCALE: Record<EnemyType, number> = { ashigaru: 1, archer: 1, oni: 1.25, ninja: 0.92, boss: 2.1 };

export function enemySkeleton(type: EnemyType, pose: Pose): Skeleton {
  const sk = buildSkeleton(pose, PROP[type]);
  const k = SCALE[type];
  if (k === 1) return sk;
  const s = (p: Pt): Pt => ({ x: p.x * k, y: p.y * k });
  return {
    ...sk,
    hip: s(sk.hip), neck: s(sk.neck), head: s(sk.head), shoulder: s(sk.shoulder),
    kneeF: s(sk.kneeF), footF: s(sk.footF), kneeB: s(sk.kneeB), footB: s(sk.footB),
    elbowF: s(sk.elbowF), handF: s(sk.handF), elbowB: s(sk.elbowB), handB: s(sk.handB),
    headR: sk.headR * k,
  };
}

function walkPose(base: Pose, phase: number, stride: number): Pose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  return { ...base, hipY: base.hipY + (1 - Math.abs(s)) * 1.2, fF: V(1 + s * stride, -Math.max(0, c) * 6), fB: V(1 - s * stride, -Math.max(0, -c) * 6) };
}

function walking(e: Enemy, idle: Pose, phase: number, stride: number, full = 60): Pose {
  return lerpPose(idle, walkPose(idle, phase, stride), clamp01(Math.abs(e.vx) / full));
}

// ─── Poses ─────────────────────────────────────────────────────────────────

const S_IDLE: Pose = { lean: 0.08, hipX: 0, hipY: 22, fF: V(7, 0), fB: V(-7, 0), arm: 0.3, reach: 11, sword: -1.25 };
const S_GUARD: Pose = { lean: 0.22, hipX: 0, hipY: 21.5, fF: V(9, 0), fB: V(-8, 0), arm: 0.1, reach: 12, sword: -0.1 };
const S_WIND: Pose = { lean: -0.15, hipX: -1, hipY: 21, fF: V(10, 0), fB: V(-11, 0), arm: 0.25, reach: 4, sword: -0.06 };
const S_THRUST: Pose = { lean: 0.5, hipX: 1, hipY: 19, fF: V(16, 0), fB: V(-13, 0), arm: 0.05, reach: 19, sword: 0 };
const S_HIT: Pose = { lean: -0.45, hipX: 0, hipY: 22, fF: V(8, -3), fB: V(-7, 0), arm: 1.2, reach: 10, sword: -2.2 };
const S_STUN: Pose = { lean: 0.55, hipX: 0, hipY: 17, fF: V(9, 0), fB: V(-9, 0), arm: 1.3, reach: 11, sword: 1.0 };
const S_DOOM: Pose = { lean: 0.1, hipX: 0, hipY: 22, fF: V(9, 0), fB: V(-9, 0), arm: 0.4, reach: 12, sword: 0.2 };
const A_IDLE: Pose = { lean: 0.05, hipX: 0, hipY: 22, fF: V(7, 0), fB: V(-7, 0), arm: 0.6, reach: 11, sword: 0.5, pull: 0 };

const O_IDLE: Pose = { lean: 0.15, hipX: 0, hipY: 22, fF: V(9, 0), fB: V(-9, 0), arm: 1.0, reach: 8, sword: -2.3 };
const O_WIND: Pose = { lean: -0.25, hipX: -1, hipY: 21, fF: V(11, 0), fB: V(-11, 0), arm: -1.9, reach: 15, sword: -2.7 };
const O_SMASH: Pose = { lean: 0.6, hipX: 1, hipY: 18, fF: V(16, 0), fB: V(-12, 0), arm: 0.7, reach: 17, sword: 0.95 };
const O_STUN: Pose = { lean: 0.55, hipX: 0, hipY: 17, fF: V(10, 0), fB: V(-10, 0), arm: 1.3, reach: 12, sword: 1.45 };

const N_IDLE: Pose = { lean: 0.35, hipX: 0, hipY: 19, fF: V(10, 0), fB: V(-10, 0), arm: 1.4, reach: 11, sword: 2.7 };
const N_THROW_W: Pose = { lean: -0.1, hipX: 0, hipY: 20, fF: V(9, 0), fB: V(-10, 0), arm: 2.6, reach: 12, sword: 2.7 };
const N_THROW: Pose = { lean: 0.35, hipX: 0, hipY: 20, fF: V(12, 0), fB: V(-10, 0), arm: -0.1, reach: 17, sword: 2.7 };
const N_SLASH_W: Pose = { lean: 0.65, hipX: 0, hipY: 14, fF: V(14, 0), fB: V(-14, 0), arm: 2.4, reach: 12, sword: 3.0 };
const N_SLASH: Pose = { lean: 0.75, hipX: 1, hipY: 15, fF: V(18, 0), fB: V(-15, 0), arm: 0.0, reach: 18, sword: 0.05 };

const B_IDLE: Pose = { lean: 0.12, hipX: 0, hipY: 24, fF: V(9, 0), fB: V(-9, 0), arm: 0.7, reach: 13, sword: -0.75 };
const B_SWEEP_W: Pose = { lean: -0.2, hipX: -1, hipY: 22, fF: V(11, 0), fB: V(-12, 0), arm: 2.5, reach: 12, sword: 3.05 };
const B_SWEEP: Pose = { lean: 0.45, hipX: 1, hipY: 19, fF: V(16, 0), fB: V(-13, 0), arm: 1.2, reach: 15, sword: 0.05 };
const B_CROUCH: Pose = { lean: 0.5, hipX: 0, hipY: 15, fF: V(11, 0), fB: V(-11, 0), arm: 0.4, reach: 12, sword: -1.2 };
const B_AIR: Pose = { lean: 0.1, hipX: 0, hipY: 24, fF: V(8, -9), fB: V(-6, -6), arm: -1.7, reach: 13, sword: -1.75 };
const B_SLAM: Pose = { lean: 0.7, hipX: 0, hipY: 13, fF: V(13, 0), fB: V(-13, 0), arm: 1.3, reach: 15, sword: 1.5 };
const B_CHARGE_W: Pose = { lean: 0.55, hipX: 0, hipY: 19, fF: V(13, 0), fB: V(-14, 0), arm: 2.4, reach: 12, sword: 2.95 };
const B_ROAR: Pose = { lean: -0.35, hipX: 0, hipY: 24, fF: V(10, 0), fB: V(-10, 0), arm: -1.3, reach: 14, sword: -1.45 };
const B_STUN: Pose = { lean: 0.95, hipX: -1, hipY: 12, fF: V(11, 0), fB: V(-12, 0), arm: 1.3, reach: 12, sword: 1.35 };

export function enemyPose(e: Enemy, t: number, phase: number): Pose {
  switch (e.type) {
    case 'ashigaru':
    case 'archer':
      return soldierPose(e, t, phase);
    case 'oni':
      return oniPose(e, t, phase);
    case 'ninja':
      return ninjaPose(e, t, phase);
    case 'boss':
      return bossPose(e, t, phase);
  }
}

function soldierPose(e: Enemy, t: number, phase: number): Pose {
  const d = ENEMY[e.type];
  const archer = e.type === 'archer';
  const idle = archer ? A_IDLE : e.state === 'patrol' ? S_IDLE : S_GUARD;
  switch (e.state) {
    case 'windup':
      if (archer) return { ...A_IDLE, lean: -0.05, fF: V(9, 0), fB: V(-9, 0), arm: e.aimAng, reach: 15, sword: e.aimAng, pull: clamp01(t / (d.windup * 0.6)) };
      return lerpPose(S_GUARD, S_WIND, easeOut(clamp01(t / d.windup)));
    case 'attack':
      return lerpPose(S_WIND, S_THRUST, clamp01(t / 4));
    case 'recover':
      if (archer) return lerpPose({ ...A_IDLE, arm: e.aimAng, reach: 15, sword: e.aimAng, pull: 0 }, A_IDLE, easeOut(clamp01(t / d.recover)));
      return lerpPose(S_THRUST, S_GUARD, easeOut(clamp01((t / d.recover) * 1.6)));
    case 'hitstun':
      return archer ? { ...S_HIT, sword: 1.2 } : S_HIT;
    case 'stunned':
      return S_STUN;
    case 'doomed':
    case 'dead':
      return S_DOOM;
    default:
      return walking(e, idle, phase, 9);
  }
}

function oniPose(e: Enemy, t: number, phase: number): Pose {
  const d = ENEMY.oni;
  switch (e.state) {
    case 'windup': {
      const p = lerpPose(O_IDLE, O_WIND, easeOut(clamp01(t / d.windup)));
      if (t > d.windup * 0.6) p.hipX += Math.sin(t * 2.1) * 0.5;
      return p;
    }
    case 'attack':
      return lerpPose(O_WIND, O_SMASH, clamp01(t / 3));
    case 'recover':
      return t < d.recover * 0.5 ? O_SMASH : lerpPose(O_SMASH, O_IDLE, easeOut((t - d.recover * 0.5) / (d.recover * 0.5)));
    case 'hitstun':
      return { ...S_HIT, sword: -2.4 };
    case 'stunned':
      return O_STUN;
    case 'doomed':
    case 'dead':
      return O_IDLE;
    default:
      return walking(e, O_IDLE, phase, 7, 45);
  }
}

function ninjaPose(e: Enemy, t: number, phase: number): Pose {
  const d = ENEMY.ninja;
  switch (e.state) {
    case 'windup':
      if (e.move === 'throw') return t < d.windup ? lerpPose(N_IDLE, N_THROW_W, easeOut(clamp01(t / 6))) : N_THROW;
      return lerpPose(N_IDLE, N_SLASH_W, easeOut(clamp01(t / d.windup)));
    case 'attack':
      return lerpPose(N_SLASH_W, N_SLASH, clamp01(t / 3));
    case 'recover':
      return lerpPose(e.move === 'slash' ? N_SLASH : N_THROW, N_IDLE, easeOut(clamp01(t / d.recover)));
    case 'hitstun':
      return { ...S_HIT, sword: 2.4 };
    case 'stunned':
      return { ...S_STUN, sword: 2.0 };
    default:
      return walking(e, { ...N_IDLE, lean: 0.35 + clamp01(Math.abs(e.vx) / 190) * 0.25 }, phase * 1.2, 13, 120);
  }
}

function bossPose(e: Enemy, t: number, phase: number): Pose {
  const wind = e.phase2 ? 24 : ENEMY.boss.windup;
  switch (e.state) {
    case 'intro':
      return lerpPose(B_IDLE, B_ROAR, clamp01((t - 18) / 12));
    case 'windup':
      if (e.move === 'sweep') return lerpPose(B_IDLE, B_SWEEP_W, easeOut(clamp01(t / wind)));
      if (e.move === 'leap') return lerpPose(B_IDLE, B_CROUCH, easeOut(clamp01(t / 12)));
      if (e.move === 'charge') return lerpPose(B_IDLE, B_CHARGE_W, easeOut(clamp01(t / 14)));
      return lerpPose(B_IDLE, B_ROAR, clamp01(t / 12));
    case 'attack':
      if (e.move === 'sweep') return lerpPose(B_SWEEP_W, B_SWEEP, clamp01(t / 3));
      if (e.move === 'leap') return B_AIR;
      return walkPose({ ...B_CHARGE_W, lean: 0.85, hipY: 21 }, phase * 1.6, 15);
    case 'recover':
      if (e.move === 'sweep') return lerpPose(B_SWEEP, B_IDLE, easeOut(clamp01(t / 30)));
      if (e.move === 'leap') return lerpPose(B_SLAM, B_IDLE, easeOut(clamp01((t - 12) / 16)));
      if (e.move === 'charge') return lerpPose(B_STUN, B_IDLE, easeOut(clamp01((t - 30) / 20)));
      return lerpPose(B_ROAR, B_IDLE, clamp01(t / 20));
    case 'stunned':
      return B_STUN;
    case 'doomed':
    case 'dead':
      return B_STUN;
    default:
      return walking(e, B_IDLE, phase * 0.8, 10, 90);
  }
}

/** Croissant du balayage du boss (repère local). */
export function bossTrail(e: Enemy, t: number): { tips: Pt[]; inner: Pt[]; alpha: number } | null {
  if (e.type !== 'boss' || e.move !== 'sweep' || (e.state !== 'attack' && !(e.state === 'recover' && t < 8))) return null;
  const k = SCALE.boss;
  const prog = e.state === 'attack' ? clamp01(t / 3) : 1;
  const alpha = e.state === 'recover' ? 1 - t / 8 : 1;
  const tips: Pt[] = [];
  const inner: Pt[] = [];
  for (let i = 0; i <= 10; i++) {
    const u = i / 10;
    const pose = lerpPose(B_SWEEP_W, B_SWEEP, u * prog);
    const sk = buildSkeleton(pose, SAMURAI);
    const tip = add(sk.handF, polar(pose.sword, 46));
    const base = add(sk.handF, polar(pose.sword, 14));
    tips.push({ x: tip.x * k, y: tip.y * k });
    const m = mix(tip, base, 0.8 * Math.pow(u, 1.2));
    inner.push({ x: m.x * k, y: m.y * k });
  }
  return { tips, inner, alpha };
}

// ─── Dessin ────────────────────────────────────────────────────────────────

export interface EnemyStyle {
  alpha: number;
  tint: number | null;
  rand: Rand;
  glint: number;
  parts: 'all' | 'upper' | 'lower';
  doomK?: number;
  guard?: boolean;
  time?: number;
  phase2?: boolean;
}

export function drawEnemy(g: G, type: EnemyType, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  if (type === 'ninja') drawNinja(g, sk, X, st);
  else if (type === 'boss') drawBoss(g, sk, X, st);
  else drawSoldier(g, type, sk, X, st);
}

type Limb = (p0: Pt, p1: Pt, p2: Pt, w0: number, w1: number, col: number, al: number) => void;

function limbFn(g: G, X: Xf, r: Rand, jitter = 0.18): Limb {
  return (p0, p1, p2, w0, w1, col, al) =>
    gStroke(g, catmull([X(p0), X(p1), X(p2)], 3), col, al, { width: 1, widthFn: (t) => w0 + (w1 - w0) * t, taperStart: 0.05, taperEnd: 0.12, jitter }, r);
}

function drawSoldier(g: G, type: EnemyType, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  const a = st.alpha;
  const r = st.rand;
  const k = SCALE[type];
  const upper = st.parts !== 'lower';
  const lower = st.parts !== 'upper';
  const T = (c: number) => st.tint ?? c;
  const limb = limbFn(g, X, r);

  // Deux passes : un lavis large puis un trait d'encre fin = effet « croquis ».
  const body = (mul: number, col: number, al: number) => {
    const m = mul * k;
    if (lower) {
      limb(sk.hip, sk.kneeB, sk.footB, 5 * m, 6.5 * m, col, al * 0.85);
      limb(sk.hip, sk.kneeF, sk.footF, 5 * m, 6.5 * m, col, al);
    }
    if (upper) {
      limb(sk.shoulder, sk.elbowB, sk.handB, 3 * m, 2.8 * m, col, al * 0.85);
      const mid = V((sk.hip.x + sk.neck.x) / 2 + k, (sk.hip.y + sk.neck.y) / 2);
      gStroke(g, catmull([X(sk.hip), X(mid), X(sk.neck)], 3), col, al, { width: 1, widthFn: (t) => (10 - t * 1.5) * m * (type === 'oni' ? 1.25 : 1), taperStart: 0, taperEnd: 0.1, jitter: 0.15 }, r);
    }
  };
  body(1.35, T(type === 'oni' ? C.inkSoft : C.wash), (type === 'oni' ? 0.45 : 0.5) * a);
  body(0.45, T(C.inkSoft), 0.95 * a);

  if (!upper) {
    gStroke(g, [X(add(sk.hip, V(-6 * k, 0))), X(add(sk.hip, V(6 * k, 0)))], C.ink, a, { width: 3 * k, taperStart: 0.2, taperEnd: 0.2 }, r);
    return;
  }
  const hc = X(sk.head);
  const hR = sk.headR;
  if (type === 'oni') {
    // Masque rouge et cornes
    gBlob(g, hc.x, hc.y, hR * 1.1, T(C.red), a * 0.9, r, 0.15);
    for (const s of [-1, 1]) {
      const base = add(sk.head, V(s * hR * 0.5, -hR * 0.8));
      gStroke(g, catmull([X(base), X(add(base, V(s * 3, -5))), X(add(base, V(s * 1, -10)))], 3), T(C.ink), a, { width: 3.2, taperStart: 0, taperEnd: 0.9 }, r);
    }
    const eye = X(add(sk.head, V(hR * 0.45, -1)));
    gBlob(g, eye.x, eye.y, 1.4, C.paper, a, r, 0.1);
    drawShield(g, sk, X, st, k);
    drawClub(g, sk, X, st);
  } else {
    gBlob(g, hc.x, hc.y, hR * 1.15, T(C.wash), a * 0.5, r, 0.2);
    gBlob(g, hc.x, hc.y, hR * 0.78, T(C.inkSoft), a, r, 0.15);
    if (type === 'ashigaru') {
      gFill(g, [X(add(sk.head, V(1, -hR - 6))), X(add(sk.head, V(16, -hR + 3))), X(add(sk.head, V(-14, -hR + 3)))], T(C.ink), a * 0.95);
      gStroke(g, [X(add(sk.head, V(-15, -hR + 3))), X(add(sk.head, V(17, -hR + 3)))], T(C.ink), a, { width: 2, taperStart: 0.2, taperEnd: 0.2 }, r);
      drawSpear(g, sk, X, st);
    } else {
      const dome = ringPoints(0, 0, hR + 3, Math.PI, Math.PI * 2, 10).map((q) => X(add(sk.head, V(q.x, q.y - hR * 0.35))));
      gFill(g, dome, T(C.ink), a * 0.92);
      drawBow(g, sk, X, st);
    }
  }
  limb(sk.shoulder, sk.elbowF, sk.handF, 3.6 * k, 3.2 * k, T(C.wash), a * 0.5);
  limb(sk.shoulder, sk.elbowF, sk.handF, 1.6 * k, 1.5 * k, T(C.inkSoft), a);
  if (st.doomK !== undefined) {
    gStroke(g, [X(add(sk.hip, V(-13 * k, -4))), X(add(sk.hip, V(14 * k, -1)))], C.red, Math.min(1, st.doomK * 1.5) * a, { width: 2.2, taperStart: 0.1, taperEnd: 0.4 }, r);
  }
}

function drawSpear(g: G, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  const a = st.alpha;
  const r = st.rand;
  const butt = add(sk.handF, polar(sk.weapon, -26));
  const tip = add(sk.handF, polar(sk.weapon, 44));
  const point = add(tip, polar(sk.weapon, 12));
  gStroke(g, [X(butt), X(tip)], st.tint ?? C.wood, a, { width: 2.3, taperStart: 0, taperEnd: 0.03, jitter: 0.08 }, r);
  gStroke(g, [X(tip), X(point)], st.tint ?? C.ink, a, { width: 1, widthFn: (t) => Math.sin(Math.PI * Math.max(0.15, t)) * 4.6, taperStart: 0, taperEnd: 0.1 }, r);
  const ts = X(add(tip, polar(sk.weapon, -2)));
  for (let i = 0; i < 3; i++) gStroke(g, [ts, { x: ts.x + (i - 1) * 1.5, y: ts.y + 6 + i }], st.tint ?? C.red, a * 0.9, { width: 1.4, taperStart: 0, taperEnd: 0.8 }, r);
  if (st.glint > 0) {
    const pp = X(point);
    star(g, pp.x, pp.y, 3 + st.glint * 10, C.red, Math.min(1, st.glint * 1.4), r);
  }
}

function drawBow(g: G, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  const a = st.alpha;
  const r = st.rand;
  const aim = sk.weapon;
  const center = add(sk.handF, polar(aim, -6));
  const arc: Pt[] = [];
  for (let i = 0; i <= 10; i++) arc.push(X(add(center, polar(aim - 1.15 + (i / 10) * 2.3, 17))));
  gStroke(g, arc, st.tint ?? C.wood, a, { width: 2.6, taperStart: 0.2, taperEnd: 0.2 }, r);
  const e0 = arc[0];
  const e1 = arc[arc.length - 1];
  const pullPt = sk.pull > 0.02 ? X(sk.handB) : { x: (e0.x + e1.x) / 2, y: (e0.y + e1.y) / 2 };
  gStroke(g, [e0, pullPt], st.tint ?? C.ink, a * 0.8, { width: 0.9, taperStart: 0, taperEnd: 0 }, r);
  gStroke(g, [pullPt, e1], st.tint ?? C.ink, a * 0.8, { width: 0.9, taperStart: 0, taperEnd: 0 }, r);
  if (sk.pull > 0.02) {
    const head = X(add(sk.handB, polar(aim, 30)));
    gStroke(g, [pullPt, head], st.tint ?? C.ink, a, { width: 1.5, taperStart: 0, taperEnd: 0 }, r);
    if (st.glint > 0) star(g, head.x, head.y, 3 + st.glint * 8, C.red, Math.min(1, st.glint * 1.4), r);
  }
}

function drawClub(g: G, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  const a = st.alpha;
  const r = st.rand;
  const butt = add(sk.handF, polar(sk.weapon, -8));
  const tip = add(sk.handF, polar(sk.weapon, 40));
  gStroke(g, [X(butt), X(tip)], st.tint ?? C.ink, a, { width: 1, widthFn: (t) => 3 + t * 5, taperStart: 0, taperEnd: 0.05, jitter: 0.1 }, r);
  const n = V(-Math.sin(sk.weapon), Math.cos(sk.weapon));
  for (let i = 0; i < 4; i++) {
    const p = add(sk.handF, polar(sk.weapon, 20 + i * 5.5));
    for (const s of [-1, 1]) gStroke(g, [X(add(p, V(n.x * s * 3, n.y * s * 3))), X(add(p, V(n.x * s * 6.5, n.y * s * 6.5)))], st.tint ?? C.ink, a, { width: 1.6, taperStart: 0, taperEnd: 0.8 }, r);
  }
  if (st.glint > 0) {
    const pp = X(tip);
    star(g, pp.x, pp.y, 4 + st.glint * 12, C.red, Math.min(1, st.glint * 1.4), r);
  }
}

function drawShield(g: G, sk: Skeleton, X: Xf, st: EnemyStyle, k: number): void {
  const a = st.alpha;
  const r = st.rand;
  const c = add(mix(sk.hip, sk.neck, 0.45), st.guard ? V(13 * k, 0) : V(6 * k, 12 * k));
  const tilt = st.guard ? 0 : 0.9;
  const hw = 5 * k;
  const hh = 17 * k;
  const corner = (x: number, y: number) => X(add(c, V(x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt))));
  const poly = [corner(-hw, -hh), corner(hw, -hh + 1), corner(hw, hh), corner(-hw, hh - 1)];
  gFill(g, poly, st.tint ?? C.wood, a * 0.9);
  gStroke(g, poly.concat([poly[0]]), st.tint ?? C.ink, a, { width: 1.8, taperStart: 0, taperEnd: 0, jitter: 0.2 }, r);
  const mc = X(c);
  gStroke(g, ringPoints(mc.x, mc.y, 3.2 * k, 0, Math.PI * 1.85, 12), st.tint ?? C.red, a, { width: 1.6, taperStart: 0.1, taperEnd: 0.4 }, r);
}

function drawNinja(g: G, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  const a = st.alpha;
  const r = st.rand;
  const k = SCALE.ninja;
  const ink = st.tint ?? C.ink;
  const soft = st.tint ?? C.inkSoft;
  const limb = limbFn(g, X, r, 0.12);
  const upper = st.parts !== 'lower';
  const lower = st.parts !== 'upper';
  if (lower) {
    limb(sk.hip, sk.kneeB, sk.footB, 4.5 * k, 5.5 * k, soft, a);
    limb(sk.hip, sk.kneeF, sk.footF, 5 * k, 6 * k, ink, a);
  }
  if (!upper) return;
  limb(sk.shoulder, sk.elbowB, sk.handB, 2.8, 2.6, soft, a);
  // Écharpe grise flottante
  const time = st.time ?? 0;
  const tail: Pt[] = [];
  for (let i = 0; i < 6; i++) tail.push(X(add(sk.head, V(-3 - i * 6, 2 + i * 1.3 + Math.sin(time * 0.012 + i * 0.9) * 2.2))));
  gStroke(g, tail, st.tint ?? C.washLight, a, { width: 3.2, taperStart: 0, taperEnd: 0.9 }, r, 2);
  const mid = V((sk.hip.x + sk.neck.x) / 2 + 1, (sk.hip.y + sk.neck.y) / 2);
  gStroke(g, catmull([X(sk.hip), X(mid), X(sk.neck)], 3), ink, a, { width: 1, widthFn: (t) => 9 - t * 2, taperStart: 0, taperEnd: 0.1, jitter: 0.1 }, r);
  const hc = X(sk.head);
  gBlob(g, hc.x, hc.y, sk.headR, ink, a, r, 0.12);
  gStroke(g, [X(add(sk.head, V(0.5, -1.2))), X(add(sk.head, V(sk.headR * 0.95, -1.5)))], C.paper, a * 0.9, { width: 1.3, taperStart: 0.2, taperEnd: 0.2 }, r);
  // Ninjato court et droit
  const tsuba = add(sk.handF, polar(sk.weapon, 2));
  const tip = add(sk.handF, polar(sk.weapon, 28));
  gStroke(g, [X(add(sk.handF, polar(sk.weapon, -6))), X(tsuba)], ink, a, { width: 3, taperStart: 0, taperEnd: 0 }, r);
  gStroke(g, [X(tsuba), X(tip)], ink, a, { width: 2, taperStart: 0, taperEnd: 0.2 }, r);
  limb(sk.shoulder, sk.elbowF, sk.handF, 3.2, 2.8, ink, a);
  if (st.glint > 0) {
    const hp = X(sk.handF);
    star(g, hp.x, hp.y, 3 + st.glint * 6, C.red, Math.min(1, st.glint * 1.4), r);
  }
  if (st.doomK !== undefined) {
    gStroke(g, [X(add(sk.hip, V(-12, -3))), X(add(sk.hip, V(12, -1)))], C.red, Math.min(1, st.doomK * 1.5) * a, { width: 2.2 }, r);
  }
}

function drawBoss(g: G, sk: Skeleton, X: Xf, st: EnemyStyle): void {
  const a = st.alpha;
  const r = st.rand;
  const k = SCALE.boss;
  const ink = st.tint ?? C.ink;
  const soft = st.tint ?? C.inkSoft;
  const red = st.tint ?? C.red;
  const limb = limbFn(g, X, r, 0.14);
  const upper = st.parts !== 'lower';
  const lower = st.parts !== 'upper';

  if (lower) {
    limb(sk.hip, sk.kneeB, sk.footB, 7 * k, 10 * k, soft, a);
    limb(sk.hip, sk.kneeF, sk.footF, 7.5 * k, 11 * k, ink, a);
  }
  if (!upper) return;
  limb(sk.shoulder, sk.elbowB, sk.handB, 4 * k, 3.6 * k, soft, a);

  // Crinière
  const time = st.time ?? 0;
  for (let j = 0; j < 3; j++) {
    const hair: Pt[] = [];
    for (let i = 0; i < 6; i++) hair.push(X(add(sk.head, V(-4 - i * 7, -6 + j * 6 + i * 3 + Math.sin(time * 0.006 + i + j) * 2))));
    gStroke(g, hair, st.tint ?? (j === 1 ? C.inkSoft : C.ink), a * 0.9, { width: 6, taperStart: 0, taperEnd: 0.95 }, r, 2);
  }
  // Armure : lavis large + trait sombre
  const mid = V((sk.hip.x + sk.neck.x) / 2 + 2 * k, (sk.hip.y + sk.neck.y) / 2);
  gStroke(g, catmull([X(sk.hip), X(mid), X(sk.neck)], 3), st.tint ?? C.wash, a * 0.6, { width: 1, widthFn: (t) => (16 - t * 2) * k, taperStart: 0, taperEnd: 0.08 }, r);
  gStroke(g, catmull([X(sk.hip), X(mid), X(sk.neck)], 3), ink, a, { width: 1, widthFn: (t) => (11 - t * 2) * k, taperStart: 0, taperEnd: 0.1, jitter: 0.12 }, r);
  // Lamelles de l'armure
  for (let i = 1; i <= 3; i++) {
    const p = mix(sk.hip, sk.neck, i * 0.22);
    gStroke(g, [X(add(p, V(-7 * k, 0))), X(add(p, V(7 * k, 1)))], C.paper, a * 0.35, { width: 1.6, taperStart: 0.2, taperEnd: 0.2 }, r);
  }
  // Ceinture rouge
  const belt = mix(sk.hip, sk.neck, 0.08);
  gStroke(g, [X(add(belt, V(-8 * k, 0))), X(add(belt, V(8 * k, 0)))], red, a, { width: 3.2 * k, taperStart: 0.05, taperEnd: 0.05 }, r);
  // Sode (épaulière)
  const sh = sk.shoulder;
  gFill(g, [X(add(sh, V(-6 * k, -2 * k))), X(add(sh, V(5 * k, -2 * k))), X(add(sh, V(7 * k, 9 * k))), X(add(sh, V(-5 * k, 10 * k)))], ink, a * 0.92);
  for (let i = 1; i <= 2; i++) gStroke(g, [X(add(sh, V(-5 * k, i * 3.3 * k))), X(add(sh, V(6 * k, i * 3.3 * k)))], C.paper, a * 0.35, { width: 1.4 }, r);

  // Tête : masque d'oni
  const hc = X(sk.head);
  const hR = sk.headR;
  gBlob(g, hc.x, hc.y, hR * 1.05, red, a, r, 0.12);
  for (const s of [-1, 1]) {
    const base = add(sk.head, V(s * hR * 0.45 - 2, -hR * 0.75));
    gStroke(g, catmull([X(base), X(add(base, V(s * 6 - 4, -9))), X(add(base, V(s * 2 - 8, -20)))], 3), ink, a, { width: 6, taperStart: 0, taperEnd: 0.95 }, r);
  }
  const eye = X(add(sk.head, V(hR * 0.45, -hR * 0.15)));
  gStroke(g, [{ x: eye.x - 4, y: eye.y - 1 }, { x: eye.x + 4, y: eye.y + 1 }], C.paper, a, { width: 2.6, taperStart: 0.2, taperEnd: 0.2 }, r);
  const mouth = X(add(sk.head, V(hR * 0.4, hR * 0.45)));
  gStroke(g, [{ x: mouth.x - 6, y: mouth.y }, { x: mouth.x + 5, y: mouth.y + 1 }], ink, a, { width: 2.2 }, r);
  for (const s of [-3, 2]) gStroke(g, [{ x: mouth.x + s, y: mouth.y }, { x: mouth.x + s, y: mouth.y + 4 }], C.paper, a, { width: 1.6, taperStart: 0, taperEnd: 0.8 }, r);

  // Nodachi
  const pommel = add(sk.handF, polar(sk.weapon, -15 * k * 0.5));
  const tsuba = add(sk.handF, polar(sk.weapon, 3 * k));
  const tip = add(sk.handF, polar(sk.weapon, 46 * k));
  const nrm = V(-Math.sin(sk.weapon), Math.cos(sk.weapon));
  const bend = add(mix(tsuba, tip, 0.55), V(-nrm.x * 3, -nrm.y * 3));
  gStroke(g, [X(pommel), X(tsuba)], ink, a, { width: 5.5, taperStart: 0, taperEnd: 0 }, r);
  gStroke(g, catmull([X(tsuba), X(bend), X(tip)], 3), ink, a, { width: 1, widthFn: (t) => 5 - t * 3.8, taperStart: 0, taperEnd: 0.12, jitter: 0.05 }, r);
  if (st.phase2) gStroke(g, catmull([X(tsuba), X(bend), X(tip)], 3), C.red, a * 0.85, { width: 1.6, taperStart: 0.1, taperEnd: 0.3 }, r);
  const tp = X(tsuba);
  gBlob(g, tp.x, tp.y, 4.5, ink, a, r);
  limb(sk.shoulder, sk.elbowF, sk.handF, 5 * k, 4.4 * k, ink, a);
  if (st.glint > 0) {
    const pp = X(tip);
    star(g, pp.x, pp.y, 6 + st.glint * 18, C.red, Math.min(1, st.glint * 1.4), r);
  }
}

/** Le boss est-il en garde (pour le bouclier de l'oni) ? */
export function isGuarding(e: Enemy): boolean {
  return e.type === 'oni' && (e.state === 'patrol' || e.state === 'chase' || e.state === 'windup');
}

export function windupLength(e: Enemy): number {
  if (e.type === 'boss') {
    if (e.move === 'sweep') return e.phase2 ? 24 : ENEMY.boss.windup;
    if (e.move === 'horn') return 50;
    if (e.move === 'charge') return 32;
    return 24;
  }
  return ENEMY[e.type].windup + (e.type === 'ninja' ? 4 : 0);
}

export const BOSS_NAME = '赤鬼 · Akaoni, demon general';
export const BOSS_SLAM = BOSS.SLAM_W;
