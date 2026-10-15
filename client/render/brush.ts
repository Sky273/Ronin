import type Phaser from 'phaser';

// Moteur de « coups de pinceau » : chaque trait est un polygone dont la largeur
// varie le long du tracé (pression), s'effile aux extrémités et tremble un peu.
// Le même générateur alimente Phaser (temps réel) et Canvas2D (décors pré-rendus).

export interface Pt {
  x: number;
  y: number;
}
export type Rand = () => number;

export function seeded(seed: number): Rand {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Lissage Catmull-Rom. */
export function catmull(pts: Pt[], steps = 4): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export interface StrokeOpts {
  width: number;
  taperStart?: number;
  taperEnd?: number;
  jitter?: number;
  minWidth?: number;
  widthFn?: (t: number) => number;
}

/** Subdivise un tracé trop court pour que l'effilement ait des sommets sur lesquels agir. */
function resample(pts: Pt[], min: number): Pt[] {
  if (pts.length >= min) return pts;
  const per = Math.ceil((min - 1) / (pts.length - 1));
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    for (let k = 0; k < per; k++) out.push({ x: a.x + ((b.x - a.x) * k) / per, y: a.y + ((b.y - a.y) * k) / per });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function strokeShape(input: Pt[], o: StrokeOpts, rand: Rand): Pt[] {
  if (input.length < 2) return [];
  const pts = resample(input, 9);
  const n = pts.length;
  const ts = o.taperStart ?? 0.2;
  const te = o.taperEnd ?? 0.35;
  const jit = o.jitter ?? 0.15;
  const minW = o.minWidth ?? 0.4;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    let w = o.widthFn ? o.widthFn(t) * o.width : o.width;
    if (ts > 0) w *= Math.pow(Math.min(1, t / ts), 0.6);
    if (te > 0) w *= Math.pow(Math.min(1, (1 - t) / te), 0.8);
    w = Math.max(minW, w * (1 + (rand() - 0.5) * 2 * jit));
    const hw = w / 2;
    const p = pts[i];
    left.push({ x: p.x - ty * hw, y: p.y + tx * hw });
    right.push({ x: p.x + ty * hw, y: p.y - tx * hw });
  }
  return left.concat(right.reverse());
}

export function blobShape(x: number, y: number, r: number, rand: Rand, n = 12, irregular = 0.18): Pt[] {
  const out: Pt[] = [];
  const off = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = off + (i / n) * Math.PI * 2;
    const rr = r * (1 + (rand() - 0.5) * 2 * irregular);
    out.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr });
  }
  return out;
}

export function ringPoints(x: number, y: number, r: number, a0: number, a1: number, n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
  }
  return out;
}

// ─── Phaser ─────────────────────────────────────────────────────────────────

type G = Phaser.GameObjects.Graphics;

export function gFill(g: G, poly: Pt[], color: number, alpha: number): void {
  if (poly.length < 3 || alpha <= 0) return;
  g.fillStyle(color, alpha);
  g.fillPoints(poly, true);
}

export function gStroke(g: G, pts: Pt[], color: number, alpha: number, o: StrokeOpts, rand: Rand, smooth = 0): void {
  gFill(g, strokeShape(smooth > 0 ? catmull(pts, smooth) : pts, o, rand), color, alpha);
}

export function gBlob(g: G, x: number, y: number, r: number, color: number, alpha: number, rand: Rand, irregular = 0.18): void {
  gFill(g, blobShape(x, y, r, rand, Math.max(8, Math.min(20, Math.round(r * 1.5))), irregular), color, alpha);
}

// ─── Canvas2D ───────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;

export function cFill(ctx: Ctx, poly: Pt[], style: string): void {
  if (poly.length < 3) return;
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fill();
}

export function cStroke(ctx: Ctx, pts: Pt[], style: string, o: StrokeOpts, rand: Rand, smooth = 0): void {
  cFill(ctx, strokeShape(smooth > 0 ? catmull(pts, smooth) : pts, o, rand), style);
}

export function cBlob(ctx: Ctx, x: number, y: number, r: number, style: string, rand: Rand, irregular = 0.18): void {
  cFill(ctx, blobShape(x, y, r, rand, Math.max(8, Math.min(24, Math.round(r * 1.2))), irregular), style);
}

/** Pinceau sec : plusieurs poils fins, interrompus aléatoirement. */
export function cDry(ctx: Ctx, pts: Pt[], style: string, width: number, rand: Rand, bristles = 4): void {
  const sm = catmull(pts, 3);
  for (let i = 0; i < bristles; i++) {
    const off = (i / Math.max(1, bristles - 1) - 0.5) * width;
    const a = Math.floor(rand() * sm.length * 0.25);
    const b = sm.length - Math.floor(rand() * sm.length * 0.35);
    if (b - a < 2) continue;
    const seg: Pt[] = [];
    for (let k = a; k < b; k++) {
      const p = sm[k];
      const q = sm[Math.min(sm.length - 1, k + 1)];
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      seg.push({ x: p.x - ((q.y - p.y) / d) * off, y: p.y + ((q.x - p.x) / d) * off });
    }
    cStroke(ctx, seg, style, { width: (width / bristles) * 1.1, taperStart: 0.1, taperEnd: 0.4, jitter: 0.3 }, rand);
  }
}
