import type Phaser from 'phaser';
import { TILE } from '../../shared/constants';
import type { Level } from '../../shared/level';
import { groundAt } from '../../shared/physics';
import type { EnemyType } from '../../shared/types';
import { gBlob, gStroke, type Pt, ringPoints, seeded } from '../render/brush';
import { buildSkeleton, drawSamurai, makeXf, type Pose, SAMURAI } from '../render/characters';
import { drawEnemy, enemySkeleton, SCALE } from '../render/enemies';
import { C } from '../render/palette';
import type { Terrain } from '../render/terrain';

type G = Phaser.GameObjects.Graphics;
type Kind = 'drop' | 'mist' | 'spark' | 'petal';

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  color: number;
  alpha: number;
  grav: number;
  stain: boolean;
  seed: number;
  front: boolean;
}

interface Corpse {
  type: EnemyType;
  pose: Pose;
  part: 'upper' | 'lower';
  facing: number;
  x: number; // pivot (hanche) en coordonnées monde
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  life: number;
  grounded: boolean;
  spray: number;
  seed: number;
}

interface Ghost {
  pose: Pose;
  x: number;
  y: number;
  facing: number;
  rot: number;
  life: number;
  max: number;
  color: number;
  alpha: number;
}

interface Line {
  pts: Pt[];
  width: number;
  color: number;
  alpha: number;
  life: number;
  max: number;
  seed: number;
  grow: boolean;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  max: number;
  color: number;
  width: number;
  seed: number;
}

const rnd = Math.random;
const MAX_PARTICLES = 700;

export class Fx {
  private particles: Particle[] = [];
  private corpses: Corpse[] = [];
  private ghosts: Ghost[] = [];
  private lines: Line[] = [];
  private rings: Ring[] = [];
  private seedN = 1;

  constructor(private level: Level, private terrain: Terrain) {}

  private push(p: Partial<Particle> & { kind: Kind; x: number; y: number }): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({
      vx: 0, vy: 0, life: 1, max: 1, size: 2, grow: 0, color: C.ink, alpha: 1, grav: 0,
      stain: false, seed: this.seedN++, front: true, ...p,
    });
  }

  /** Projection d'encre (sang stylisé) : les gouttes tachent le sol en retombant. */
  inkBurst(x: number, y: number, dir: number, count: number, speed: number, color: number = C.ink, spread = 0.9): void {
    for (let i = 0; i < count; i++) {
      const ang = (dir > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 2 * spread - dir * 0.35;
      const s = speed * (0.3 + rnd() * 0.9);
      const life = 0.6 + rnd() * 0.8;
      this.push({
        kind: 'drop', x: x + (rnd() - 0.5) * 6, y: y + (rnd() - 0.5) * 6,
        vx: Math.cos(ang) * s, vy: Math.sin(ang) * s - 160 * rnd(),
        life, max: life, size: 1 + rnd() * rnd() * 3.6, color, grav: 1100, stain: rnd() < 0.75,
      });
    }
  }

  mist(x: number, y: number, count: number, opts: { color?: number; size?: number; alpha?: number; vx?: number; vy?: number; spread?: number; life?: number; front?: boolean } = {}): void {
    for (let i = 0; i < count; i++) {
      const life = (opts.life ?? 0.5) * (0.7 + rnd() * 0.6);
      this.push({
        kind: 'mist', x: x + (rnd() - 0.5) * (opts.spread ?? 10), y: y + (rnd() - 0.5) * (opts.spread ?? 10) * 0.5,
        vx: (opts.vx ?? 0) + (rnd() - 0.5) * 40, vy: (opts.vy ?? -15) + (rnd() - 0.5) * 20,
        life, max: life, size: (opts.size ?? 8) * (0.6 + rnd() * 0.8), grow: 18,
        color: opts.color ?? C.wash, alpha: opts.alpha ?? 0.2, front: opts.front ?? false,
      });
    }
  }

  dust(x: number, y: number, dir: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const life = 0.35 + rnd() * 0.35;
      this.push({
        kind: 'mist', x: x + (rnd() - 0.5) * 8, y: y - 2,
        vx: dir * (40 + rnd() * 120) + (rnd() - 0.5) * 30, vy: -10 - rnd() * 40,
        life, max: life, size: 3 + rnd() * 4, grow: 14, color: C.washLight, alpha: 0.35, front: false,
      });
    }
  }

  sparks(x: number, y: number, count: number, color: number, speed = 420): void {
    for (let i = 0; i < count; i++) {
      const ang = rnd() * Math.PI * 2;
      const s = speed * (0.4 + rnd() * 0.8);
      const life = 0.15 + rnd() * 0.2;
      this.push({ kind: 'spark', x, y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s, life, max: life, size: 1.6, color, grav: 500 });
    }
  }

  petal(x: number, y: number): void {
    const life = 5 + rnd() * 4;
    this.push({
      kind: 'petal', x, y, vx: -20 - rnd() * 30, vy: 18 + rnd() * 22, life, max: life,
      size: 1.8 + rnd() * 1.4, color: rnd() < 0.7 ? C.blossom : C.red, alpha: 0.75, front: true,
    });
  }

  ring(x: number, y: number, r0: number, r1: number, dur: number, color: number, width: number): void {
    this.rings.push({ x, y, r0, r1, life: dur, max: dur, color, width, seed: this.seedN++ });
  }

  line(pts: Pt[], width: number, color: number, alpha: number, dur: number, grow = false): void {
    this.lines.push({ pts, width, color, alpha, life: dur, max: dur, seed: this.seedN++, grow });
  }

  ghost(pose: Pose, x: number, y: number, facing: number, rot: number, dur: number, color: number = C.washLight, alpha = 0.5): void {
    this.ghosts.push({ pose, x, y, facing, rot, life: dur, max: dur, color, alpha });
  }

  /** Découpe : le fantassin se sépare en deux moitiés qui retombent. */
  corpse(type: EnemyType, pose: Pose, x: number, y: number, facing: number, dir: number, cut: number, big: boolean): void {
    const hipY = y - pose.hipY * SCALE[type];
    const k = (big ? 1.4 : 1) / Math.sqrt(SCALE[type]);
    this.corpses.push({
      type, pose, part: 'upper', facing, x, y: hipY,
      vx: dir * (90 + rnd() * 90) * k + Math.cos(cut) * 40, vy: (-260 - rnd() * 160) * k,
      rot: 0, vr: dir * facing * (5 + rnd() * 5), life: 3.2, grounded: false, spray: 0.45, seed: this.seedN++,
    });
    this.corpses.push({
      type, pose, part: 'lower', facing, x, y: hipY,
      vx: dir * (20 + rnd() * 30), vy: -60, rot: 0, vr: -dir * facing * (1.5 + rnd() * 2),
      life: 3.2, grounded: false, spray: 0.25, seed: this.seedN++,
    });
  }

  update(dt: number): void {
    const l = this.level;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'mist') {
        p.vx *= 1 - 3 * dt;
        p.size += p.grow * dt;
      } else if (p.kind === 'petal') {
        p.x += Math.sin(p.life * 2.3 + p.seed) * 30 * dt;
      } else if (p.kind === 'drop' && p.vy > 0 && groundAt(l, p.x, p.y)) {
        if (p.stain) {
          const top = Math.floor(p.y / TILE) * TILE + 1;
          this.terrain.stain(p.x, top, 1.2 + p.size * 1.5, Math.sign(p.vx) || 1, p.color, p.seed);
        }
        p.life = 0;
      }
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.life -= dt;
      if (!c.grounded) {
        c.vy += 1500 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.vr * dt;
        if (c.vy > 0 && groundAt(l, c.x, c.y + 6)) {
          c.y = Math.floor((c.y + 6) / TILE) * TILE - 6;
          c.grounded = true;
          this.terrain.stain(c.x, c.y + 7, 6 + rnd() * 5, Math.sign(c.vx) || 1, C.ink, c.seed);
          this.mist(c.x, c.y + 4, 3, { color: C.washLight, size: 5, alpha: 0.3 });
        }
      } else {
        // Se couche à plat
        const flat = Math.round((c.rot - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        c.rot += (flat - c.rot) * Math.min(1, dt * 10);
      }
      if (c.spray > 0) {
        c.spray -= dt;
        if (rnd() < 0.6) this.inkBurst(c.x, c.y, c.vx >= 0 ? 1 : -1, 1, 180, C.ink, 1.4);
      }
      if (c.life <= 0) this.corpses.splice(i, 1);
    }

    for (const arr of [this.ghosts, this.lines, this.rings] as { life: number }[][]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        arr[i].life -= dt;
        if (arr[i].life <= 0) arr.splice(i, 1);
      }
    }
  }

  draw(back: G, front: G, boil: number): void {
    for (const gh of this.ghosts) {
      const k = gh.life / gh.max;
      const sk = buildSkeleton(gh.pose, SAMURAI);
      drawSamurai(back, sk, makeXf(gh.x, gh.y, gh.facing, gh.rot), { alpha: gh.alpha * k, tint: gh.color, rand: seeded(boil * 7 + 3), ghost: true });
    }

    for (const p of this.particles) {
      const k = Math.max(0, p.life / p.max);
      const g = p.front ? front : back;
      switch (p.kind) {
        case 'drop': {
          if (p.size > 2.2) {
            gStroke(g, [{ x: p.x - p.vx * 0.018, y: p.y - p.vy * 0.018 }, { x: p.x, y: p.y }], p.color, 0.9, { width: p.size * 1.6, taperStart: 0.9, taperEnd: 0.1 }, seeded(p.seed));
          } else {
            g.fillStyle(p.color, 0.9);
            g.fillCircle(p.x, p.y, p.size);
          }
          break;
        }
        case 'mist':
          gBlob(g, p.x, p.y, p.size, p.color, p.alpha * k, seeded(p.seed), 0.25);
          break;
        case 'spark':
          gStroke(g, [{ x: p.x - p.vx * 0.035, y: p.y - p.vy * 0.035 }, { x: p.x, y: p.y }], p.color, k, { width: p.size, taperStart: 0.8, taperEnd: 0.1 }, seeded(p.seed));
          break;
        case 'petal':
          gBlob(g, p.x, p.y, p.size, p.color, p.alpha * Math.min(1, k * 4), seeded(p.seed), 0.45);
          break;
      }
    }

    for (const c of this.corpses) {
      const fade = Math.min(1, c.life / 0.8);
      const hy = c.pose.hipY * SCALE[c.type];
      const sk = enemySkeleton(c.type, c.pose);
      const X = makeXf(c.x, c.y + hy, c.facing, c.rot, -hy);
      drawEnemy(back, c.type, sk, X, { alpha: fade, tint: null, rand: seeded(c.seed * 13 + boil), glint: 0, parts: c.part });
    }

    for (const ln of this.lines) {
      const k = ln.life / ln.max;
      const pts = ln.grow ? ln.pts.slice(0, Math.max(2, Math.ceil(ln.pts.length * Math.min(1, (1 - k) * 6)))) : ln.pts;
      gStroke(front, pts, ln.color, ln.alpha * Math.min(1, k * 2), { width: ln.width, taperStart: 0.08, taperEnd: 0.5, jitter: 0.25 }, seeded(ln.seed), 0);
    }

    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 2));
      const rr = seeded(r.seed);
      const a0 = rr() * Math.PI * 2;
      gStroke(front, ringPoints(r.x, r.y, rad, a0, a0 + Math.PI * 1.75, 22), r.color, (1 - k) * 0.85, { width: r.width * (1 - k * 0.6), taperStart: 0.2, taperEnd: 0.5, jitter: 0.2 }, rr);
    }
  }
}
