import type Phaser from 'phaser';
import { ATTACKS, type AttackId } from '../../shared/combat';
import { PLAYER as P } from '../../shared/constants';
import type { Player } from '../../shared/types';
import { catmull, gBlob, gStroke, type Pt, type Rand } from './brush';
import { C } from './palette';

type G = Phaser.GameObjects.Graphics;

// ─── Poses & squelette ─────────────────────────────────────────────────────
// Repère local : personnage tourné vers la droite, pieds en (0,0), y vers le bas.
// Angles : 0 = devant, -π/2 = haut, +π/2 = bas, ±π = derrière.

export interface Pose {
  lean: number;
  hipX: number;
  hipY: number;
  fF: Pt; // pied avant
  fB: Pt; // pied arrière
  arm: number; // angle épaule → main
  reach: number;
  sword: number; // angle de la lame (ou de l'arme)
  sheathed?: boolean;
  pull?: number; // tension de l'arc (0..1)
}

export const V = (x: number, y: number): Pt => ({ x, y });
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const polar = (ang: number, len: number): Pt => ({ x: Math.cos(ang) * len, y: Math.sin(ang) * len });
export const mix = (a: Pt, b: Pt, t: number): Pt => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    lean: lerp(a.lean, b.lean, t),
    hipX: lerp(a.hipX, b.hipX, t),
    hipY: lerp(a.hipY, b.hipY, t),
    fF: mix(a.fF, b.fF, t),
    fB: mix(a.fB, b.fB, t),
    arm: lerp(a.arm, b.arm, t),
    reach: lerp(a.reach, b.reach, t),
    sword: lerp(a.sword, b.sword, t),
    sheathed: t < 0.5 ? a.sheathed : b.sheathed,
    pull: lerp(a.pull ?? 0, b.pull ?? 0, t),
  };
}

export interface Prop {
  torso: number;
  thigh: number;
  shin: number;
  upper: number;
  fore: number;
  headR: number;
}
export const SAMURAI: Prop = { torso: 17, thigh: 13, shin: 13, upper: 9, fore: 9.5, headR: 6 };
export const SOLDIER: Prop = { torso: 16, thigh: 12, shin: 12.5, upper: 8.5, fore: 9, headR: 5.6 };

export interface Skeleton {
  hip: Pt;
  neck: Pt;
  head: Pt;
  headR: number;
  shoulder: Pt;
  kneeF: Pt;
  footF: Pt;
  kneeB: Pt;
  footB: Pt;
  elbowF: Pt;
  handF: Pt;
  elbowB: Pt;
  handB: Pt;
  weapon: number;
  sheathed: boolean;
  pull: number;
}

/** Cinématique inverse à deux segments. bend = -1 : genou vers l'avant ; +1 : coude vers le bas. */
function ik(a: Pt, target: Pt, l1: number, l2: number, bend: number): { joint: Pt; end: Pt } {
  let dx = target.x - a.x;
  let dy = target.y - a.y;
  let d = Math.hypot(dx, dy);
  const maxD = l1 + l2 - 0.01;
  if (d > maxD) {
    dx *= maxD / d;
    dy *= maxD / d;
    d = maxD;
  }
  d = Math.max(d, 0.01);
  const ang = Math.atan2(dy, dx);
  const cos = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const off = Math.acos(Math.max(-1, Math.min(1, cos)));
  const ja = ang + off * bend;
  return { joint: { x: a.x + Math.cos(ja) * l1, y: a.y + Math.sin(ja) * l1 }, end: { x: a.x + dx, y: a.y + dy } };
}

export function buildSkeleton(ps: Pose, pr: Prop): Skeleton {
  const hip = V(ps.hipX, -ps.hipY);
  const sl = Math.sin(ps.lean);
  const cl = Math.cos(ps.lean);
  const neck = V(hip.x + sl * pr.torso, hip.y - cl * pr.torso);
  const head = V(neck.x + sl * (pr.headR + 1.5), neck.y - cl * (pr.headR + 1.5));
  const shoulder = V(neck.x - sl * 2, neck.y + cl * 2);
  const legF = ik(hip, ps.fF, pr.thigh, pr.shin, -1);
  const legB = ik(hip, ps.fB, pr.thigh, pr.shin, -1);
  const handTarget = ps.sheathed ? V(hip.x + 7, hip.y - 3) : add(shoulder, polar(ps.arm, ps.reach));
  const armF = ik(shoulder, handTarget, pr.upper, pr.fore, 1);
  const wd = polar(ps.sword, 1);
  const pull = ps.pull ?? 0;
  const handBTarget = ps.sheathed ? V(hip.x - 1, hip.y - 1) : V(armF.end.x - wd.x * (5 + pull * 17), armF.end.y - wd.y * (5 + pull * 17));
  const armB = ik(shoulder, handBTarget, pr.upper, pr.fore, 1);
  return {
    hip, neck, head, headR: pr.headR, shoulder,
    kneeF: legF.joint, footF: legF.end, kneeB: legB.joint, footB: legB.end,
    elbowF: armF.joint, handF: armF.end, elbowB: armB.joint, handB: armB.end,
    weapon: ps.sword, sheathed: !!ps.sheathed, pull,
  };
}

export type Xf = (p: Pt) => Pt;

/** Local → monde : rotation autour du pivot, miroir selon facing, translation. */
export function makeXf(x: number, y: number, facing: number, rot = 0, pivotY = -22): Xf {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return (p) => {
    const ly = p.y - pivotY;
    const rx = p.x * c - ly * s;
    const ry = p.x * s + ly * c;
    return { x: x + facing * rx, y: y + ry + pivotY };
  };
}

// ─── Poses du samouraï ─────────────────────────────────────────────────────

const IDLE: Pose = { lean: 0.1, hipX: 0, hipY: 24, fF: V(8, 0), fB: V(-8, 0), arm: 0.75, reach: 13, sword: -0.55 };
const CROUCH: Pose = { lean: 0.35, hipX: -1, hipY: 14, fF: V(11, 0), fB: V(-10, 0), arm: 0.5, reach: 13, sword: -0.2 };
const JUMP: Pose = { lean: 0.12, hipX: 0, hipY: 24, fF: V(7, -10), fB: V(-5, -4), arm: -0.1, reach: 12, sword: -1.25 };
const FALL: Pose = { lean: 0.02, hipX: 0, hipY: 25, fF: V(8, -3), fB: V(-7, -8), arm: 0.9, reach: 12, sword: 2.4 };
const TUCK: Pose = { lean: 0.45, hipX: 0, hipY: 19, fF: V(8, -12), fB: V(-2, -10), arm: 0.3, reach: 10, sword: 2.6 };
const WALL: Pose = { lean: -0.15, hipX: -1, hipY: 23, fF: V(9, -14), fB: V(7, -2), arm: 2.2, reach: 12, sword: 2.9 };
const DASH: Pose = { lean: 1.0, hipX: 0, hipY: 19, fF: V(4, -4), fB: V(-18, -8), arm: 2.3, reach: 13, sword: 3.0 };
const SLIDE: Pose = { lean: -0.95, hipX: -2, hipY: 9, fF: V(20, -1), fB: V(-3, 0), arm: 2.6, reach: 12, sword: 3.05 };
const PARRY: Pose = { lean: -0.05, hipX: 0, hipY: 23, fF: V(10, 0), fB: V(-9, 0), arm: 0.2, reach: 12, sword: -1.45 };
const PARRY_HIT: Pose = { lean: -0.25, hipX: -1, hipY: 22, fF: V(9, 0), fB: V(-11, 0), arm: -0.5, reach: 13, sword: -2.0 };
const HURT: Pose = { lean: -0.5, hipX: 0, hipY: 23, fF: V(6, -2), fB: V(-9, 0), arm: 1.4, reach: 11, sword: 2.0 };
const DEAD: Pose = { lean: 0.75, hipX: -2, hipY: 11, fF: V(10, 0), fB: V(-12, 0), arm: 1.2, reach: 12, sword: 1.35 };
const IAI_CHARGE: Pose = { lean: 0.5, hipX: -1, hipY: 16, fF: V(13, 0), fB: V(-12, 0), arm: 0.9, reach: 9, sword: -0.35, sheathed: true };
const IAI_STRIKE: Pose = { lean: 0.65, hipX: 0, hipY: 14, fF: V(16, 0), fB: V(-15, 0), arm: -0.05, reach: 18, sword: 0.05 };

function runPose(phase: number): Pose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  return {
    lean: 0.32, hipX: 0, hipY: 22.5 + (1 - Math.abs(s)) * 1.5,
    fF: V(2 + s * 13, -Math.max(0, c) * 8), fB: V(2 - s * 13, -Math.max(0, -c) * 8),
    arm: 1.9, reach: 12, sword: 2.75,
  };
}

/** Trois poses-clés par attaque : W (fin de préparation), E (fin du coup), R (récupération). */
const ATK: Record<AttackId, { W: Pose; E: Pose; R: Pose }> = {
  slash1: {
    W: { lean: 0.0, hipX: 0, hipY: 23, fF: V(9, 0), fB: V(-9, 0), arm: -1.6, reach: 11, sword: -2.1 },
    E: { lean: 0.5, hipX: 1, hipY: 20, fF: V(15, 0), fB: V(-11, 0), arm: 0.55, reach: 17, sword: 0.95 },
    R: { lean: 0.35, hipX: 1, hipY: 21, fF: V(13, 0), fB: V(-10, 0), arm: 0.75, reach: 15, sword: 1.15 },
  },
  slash2: {
    W: { lean: 0.3, hipX: 0, hipY: 19, fF: V(12, 0), fB: V(-11, 0), arm: 1.6, reach: 12, sword: 2.3 },
    E: { lean: -0.1, hipX: 0, hipY: 24, fF: V(11, 0), fB: V(-9, 0), arm: -1.15, reach: 16, sword: -1.25 },
    R: { lean: -0.05, hipX: 0, hipY: 24, fF: V(10, 0), fB: V(-9, 0), arm: -1.0, reach: 14, sword: -1.5 },
  },
  slash3: {
    W: { lean: -0.25, hipX: -1, hipY: 22, fF: V(8, 0), fB: V(-12, 0), arm: -2.2, reach: 12, sword: -2.9 },
    E: { lean: 0.8, hipX: 2, hipY: 16, fF: V(19, 0), fB: V(-14, 0), arm: 0.9, reach: 18, sword: 1.25 },
    R: { lean: 0.7, hipX: 2, hipY: 16, fF: V(18, 0), fB: V(-14, 0), arm: 1.0, reach: 17, sword: 1.35 },
  },
  upSlash: {
    W: { lean: 0.2, hipX: 0, hipY: 19, fF: V(10, 0), fB: V(-9, 0), arm: 1.0, reach: 12, sword: 0.7 },
    E: { lean: -0.2, hipX: 0, hipY: 25, fF: V(7, -2), fB: V(-7, 0), arm: -1.9, reach: 16, sword: -2.5 },
    R: { lean: -0.15, hipX: 0, hipY: 25, fF: V(7, -1), fB: V(-7, 0), arm: -1.7, reach: 14, sword: -2.6 },
  },
  airSlash: {
    W: { lean: 0.1, hipX: 0, hipY: 24, fF: V(8, -8), fB: V(-6, -4), arm: -1.5, reach: 12, sword: -1.7 },
    E: { lean: 0.45, hipX: 0, hipY: 24, fF: V(9, -6), fB: V(-7, -6), arm: 1.0, reach: 16, sword: 1.6 },
    R: { lean: 0.35, hipX: 0, hipY: 24, fF: V(8, -6), fB: V(-7, -5), arm: 1.0, reach: 15, sword: 1.8 },
  },
  plunge: {
    W: { lean: 0.1, hipX: 0, hipY: 22, fF: V(8, -10), fB: V(-6, -8), arm: -1.3, reach: 12, sword: -1.6 },
    E: { lean: 0.0, hipX: 0, hipY: 26, fF: V(4, -4), fB: V(-5, -2), arm: 1.5, reach: 16, sword: 1.57 },
    R: { lean: 0.6, hipX: 0, hipY: 13, fF: V(12, 0), fB: V(-12, 0), arm: 1.3, reach: 15, sword: 1.5 },
  },
};

function attackPose(id: AttackId, t: number, landed: boolean): Pose {
  const d = ATTACKS[id];
  const kf = ATK[id];
  const base = d.air ? JUMP : IDLE;
  if (id === 'plunge') {
    if (landed) {
      const k = t / d.recovery;
      return k < 0.6 ? kf.R : lerpPose(kf.R, IDLE, (k - 0.6) / 0.4);
    }
    if (t <= d.startup) return lerpPose(JUMP, kf.W, easeOut(clamp01(t / d.startup)));
    return kf.E;
  }
  if (t <= d.startup) return lerpPose(base, kf.W, easeOut(clamp01(t / d.startup)));
  if (t <= d.startup + d.active) return lerpPose(kf.W, kf.E, easeOutCubic(clamp01((t - d.startup) / d.active)));
  const k = clamp01((t - d.startup - d.active) / d.recovery);
  if (k < 0.55) return lerpPose(kf.E, kf.R, k / 0.55);
  return lerpPose(kf.R, base, easeOut((k - 0.55) / 0.45));
}

export interface SamuraiView {
  pose: Pose;
  rot: number;
}

export function samuraiPose(p: Player, t: number, runPhase: number, tick: number, parryAgo: number, time: number): SamuraiView {
  const v = (pose: Pose, rot = 0): SamuraiView => ({ pose, rot });
  switch (p.state) {
    case 'normal': {
      if (parryAgo < 14) return v(PARRY_HIT);
      if (!p.onGround) {
        if (p.wallDir !== 0) return v(WALL);
        const flip = (tick - p.doubleJumpTick + (t % 1)) / 22;
        if (flip >= 0 && flip < 1) return v(TUCK, easeOut(flip) * Math.PI * 2);
        return v(lerpPose(JUMP, FALL, clamp01((p.vy + 250) / 650)));
      }
      const spd = Math.abs(p.vx);
      if (p.crouch) {
        if (spd < 10) return v(CROUCH);
        const s = Math.sin(runPhase * 1.4);
        return v({ ...CROUCH, fF: V(11 + s * 5, -Math.max(0, Math.cos(runPhase * 1.4)) * 3), fB: V(-10 - s * 5, 0) });
      }
      if (spd > 20) return v(lerpPose(IDLE, runPose(runPhase), clamp01(spd / P.RUN_SPEED)));
      const br = Math.sin(time * 0.0025);
      return v({ ...IDLE, hipY: IDLE.hipY + br * 0.5, sword: IDLE.sword + br * 0.04 });
    }
    case 'dash':
      return v(DASH);
    case 'slide':
      return v(SLIDE);
    case 'attack':
      return v(attackPose(p.attack ?? 'slash1', t, p.plungeLanded));
    case 'parry': {
      const total = P.PARRY_ACTIVE + P.PARRY_RECOVERY;
      if (t < 3) return v(lerpPose(IDLE, PARRY, t / 3));
      if (t > total - 8) return v(lerpPose(PARRY, IDLE, (t - (total - 8)) / 8));
      return v(PARRY);
    }
    case 'iaiCharge': {
      const base = lerpPose(IDLE, IAI_CHARGE, clamp01(t / 8));
      if (p.iaiCharge >= P.IAI_FULL_CHARGE) base.hipY += Math.sin(time * 0.08) * 0.4;
      return v(base);
    }
    case 'iaiStrike':
      return v(t < 10 ? IAI_STRIKE : lerpPose(IAI_STRIKE, IDLE, clamp01((t - 10) / 10)));
    case 'hurt':
      return v(HURT);
    case 'dead':
      return v(lerpPose(HURT, DEAD, clamp01(t / 20)));
  }
}

/** Croissant d'encre laissé par la lame (repère local). */
export function slashTrail(p: Player, t: number): { tips: Pt[]; inner: Pt[]; wash: Pt[]; alpha: number; heavy: boolean } | null {
  if (p.state !== 'attack' || !p.attack || p.attack === 'plunge') return null;
  const d = ATTACKS[p.attack];
  if (t < d.startup) return null;
  const end = d.startup + d.active;
  const alpha = t > end ? 1 - (t - end) / 9 : 1;
  if (alpha <= 0) return null;
  const prog = clamp01((t - d.startup) / d.active);
  const kf = ATK[p.attack];
  const n = 12;
  const tips: Pt[] = [];
  const inner: Pt[] = [];
  const wash: Pt[] = [];
  const len = d.heavy ? 48 : 42;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const pose = lerpPose(kf.W, kf.E, easeOutCubic(u * prog));
    const sk = buildSkeleton(pose, SAMURAI);
    const tip = add(sk.handF, polar(pose.sword, len));
    const base = add(sk.handF, polar(pose.sword, 12));
    const th = 0.85 * Math.pow(u, 1.3);
    tips.push(tip);
    inner.push(mix(tip, base, th));
    wash.push(mix(tip, base, Math.min(1, th * 1.35)));
  }
  return { tips, inner, wash, alpha, heavy: d.heavy };
}

// ─── Dessin du samouraï ────────────────────────────────────────────────────

export interface DrawStyle {
  alpha: number;
  tint: number | null;
  rand: Rand;
  glint?: number;
  scarf?: Pt[];
  ghost?: boolean;
  /** Teinte propre au joueur (hachimaki, sageo du fourreau) ; vermillon par défaut. Le tint reste prioritaire. */
  accent?: number;
}

export function drawSamurai(g: G, sk: Skeleton, X: Xf, st: DrawStyle): void {
  const ink = st.tint ?? C.ink;
  const soft = st.tint ?? C.inkSoft;
  const red = st.tint ?? st.accent ?? C.red;
  const a = st.alpha;
  const r = st.rand;
  const limb = (p0: Pt, p1: Pt, p2: Pt, w0: number, w1: number, col: number, al: number) =>
    gStroke(g, catmull([X(p0), X(p1), X(p2)], 3), col, al, { width: 1, widthFn: (t) => w0 + (w1 - w0) * t, taperStart: 0.04, taperEnd: 0.1, jitter: 0.12 }, r);
  const foot = (f: Pt, col: number) => gStroke(g, [X(add(f, V(-2, -1))), X(add(f, V(5, -1)))], col, a, { width: 3, taperStart: 0, taperEnd: 0.5 }, r);

  // Jambe et bras arrière (plus clairs : profondeur)
  limb(sk.hip, sk.kneeB, sk.footB, 6, 9.5, soft, a);
  foot(sk.footB, soft);
  limb(sk.shoulder, sk.elbowB, sk.handB, 3.4, 3, soft, a);

  // Fourreau (saya)
  const sayaA = add(sk.hip, V(-3, -2));
  const sayaB = add(sayaA, polar(2.75, 34));
  gStroke(g, [X(sayaA), X(sayaB)], ink, a, { width: 3.2, taperStart: 0.02, taperEnd: 0.15 }, r);
  if (!st.ghost) gStroke(g, [X(add(sayaA, V(-2, 1))), X(add(sayaA, V(-6, 7)))], red, a * 0.9, { width: 1.6 }, r);

  // Torse
  const mid = V((sk.hip.x + sk.neck.x) / 2 + 1.2, (sk.hip.y + sk.neck.y) / 2);
  gStroke(g, catmull([X(sk.hip), X(mid), X(sk.neck)], 3), ink, a, { width: 1, widthFn: (t) => 11.5 - t * 2, taperStart: 0, taperEnd: 0.12, jitter: 0.1 }, r);
  if (!st.ghost) {
    const collar = add(mix(sk.neck, sk.hip, 0.35), V(2, 0));
    gStroke(g, [X(sk.neck), X(collar)], C.paper, a * 0.55, { width: 1.3, taperStart: 0.1, taperEnd: 0.6 }, r);
  }

  // Hachimaki (bandeau flottant, à la couleur du joueur)
  if (st.scarf && st.scarf.length > 2) {
    gStroke(g, st.scarf, red, a, { width: 3.4, taperStart: 0, taperEnd: 0.95, jitter: 0.15 }, r, 2);
    gStroke(g, st.scarf.slice(0, 5).map((q, i) => ({ x: q.x, y: q.y + 1.5 + i * 0.6 })), red, a * 0.85, { width: 2.2, taperStart: 0, taperEnd: 0.95 }, r, 2);
  }
  // Tête + chignon
  const hc = X(sk.head);
  gBlob(g, hc.x, hc.y, sk.headR, ink, a, r, 0.12);
  gStroke(g, [X(add(sk.head, V(-2, -sk.headR + 1))), X(add(sk.head, V(-6.5, -sk.headR - 3)))], ink, a, { width: 3.4, taperStart: 0, taperEnd: 0.5 }, r);
  gStroke(g, [X(add(sk.head, V(sk.headR * 0.95, -1.5))), X(add(sk.head, V(-sk.headR * 0.95, -2.8)))], red, a, { width: 2.3, taperStart: 0, taperEnd: 0 }, r);

  // Jambe avant
  limb(sk.hip, sk.kneeF, sk.footF, 6.5, 10, ink, a);
  foot(sk.footF, ink);

  // Katana
  if (sk.sheathed) {
    const tsuba = sayaA;
    const tsukaEnd = add(sayaA, polar(2.75 - Math.PI, 12));
    gStroke(g, [X(tsuba), X(tsukaEnd)], ink, a, { width: 3.6, taperStart: 0, taperEnd: 0.1 }, r);
    const tp = X(tsuba);
    gBlob(g, tp.x, tp.y, 2.4, ink, a, r);
    if (st.glint && st.glint > 0) {
      gBlob(g, tp.x, tp.y, 1.4 + st.glint * 2.4, C.red, a * 0.9, r, 0.3);
      if (st.glint >= 1) star(g, tp.x, tp.y, 12, C.red, a, r);
    }
  } else {
    const dir = polar(sk.weapon, 1);
    const nrm = V(-dir.y, dir.x);
    const pommel = add(sk.handF, polar(sk.weapon, -7));
    const tsuba = add(sk.handF, polar(sk.weapon, 3));
    const tip = add(sk.handF, polar(sk.weapon, 41));
    const bend = add(mix(tsuba, tip, 0.55), V(nrm.x * -1.6, nrm.y * -1.6));
    gStroke(g, [X(pommel), X(tsuba)], ink, a, { width: 3.6, taperStart: 0, taperEnd: 0 }, r);
    gStroke(g, catmull([X(tsuba), X(bend), X(tip)], 3), ink, a, { width: 1, widthFn: (t) => 2.7 - t * 2, taperStart: 0, taperEnd: 0.15, jitter: 0.05 }, r);
    const tp = X(tsuba);
    gBlob(g, tp.x, tp.y, 2.3, ink, a, r);
  }

  // Bras avant par-dessus la poignée
  limb(sk.shoulder, sk.elbowF, sk.handF, 3.8, 3.4, ink, a);
  const hp = X(sk.handF);
  gBlob(g, hp.x, hp.y, 2.2, ink, a, r);
}

export function star(g: G, x: number, y: number, size: number, color: number, alpha: number, r: Rand): void {
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
    gStroke(g, [{ x, y }, { x: x + Math.cos(ang) * size, y: y + Math.sin(ang) * size }], color, alpha, { width: 2, taperStart: 0, taperEnd: 0.9 }, r);
  }
}

export function headWorld(sk: Skeleton, X: Xf): Pt {
  return X(sk.head);
}
export function headBackWorld(sk: Skeleton, X: Xf): Pt {
  return X(add(sk.head, V(-sk.headR * 0.9, -2)));
}
