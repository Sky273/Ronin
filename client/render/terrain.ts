import Phaser from 'phaser';
import { TILE } from '../../shared/constants';
import { type Deco, type Level, T_ONEWAY, T_SOLID, tileAt } from '../../shared/level';
import { cBlob, cDry, cFill, cStroke, hash2, type Pt, type Rand, ringPoints, seeded } from './brush';
import { C, rgba } from './palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;
type Ctx = CanvasRenderingContext2D;

const CHUNK = 2048;
const INK = (a: number) => rgba(C.ink, a);

interface Chunk {
  x: number;
  w: number;
  tex: Phaser.Textures.CanvasTexture;
  ctx: Ctx;
  dirty: boolean;
}

/**
 * Le terrain est peint une fois dans des canvas (par tranches de 2048 px),
 * puis sert de « toile » : les éclaboussures d'encre s'y accumulent.
 */
export class Terrain {
  private chunks: Chunk[] = [];

  constructor(scene: Phaser.Scene, private level: Level, put: Put) {
    for (let x = 0, i = 0; x < level.pxW; x += CHUNK, i++) {
      const w = Math.min(CHUNK, level.pxW - x);
      const tex = scene.textures.createCanvas(`terrain${i}`, w, level.pxH)!;
      const ctx = tex.context;
      ctx.save();
      ctx.translate(-x, 0);
      paintTerrain(ctx, level, x - 160, x + w + 160);
      ctx.restore();
      tex.refresh();
      put(scene.add.image(x, 0, `terrain${i}`).setOrigin(0).setDepth(2), 'world');
      this.chunks.push({ x, w, tex, ctx, dirty: false });
    }
  }

  /** Repeint la toile (nouvelle boucle) : les taches d'encre accumulées disparaissent. */
  repaint(): void {
    for (const c of this.chunks) {
      c.ctx.clearRect(0, 0, c.w, this.level.pxH);
      c.ctx.save();
      c.ctx.translate(-c.x, 0);
      paintTerrain(c.ctx, this.level, c.x - 160, c.x + c.w + 160);
      c.ctx.restore();
      c.tex.refresh();
      c.dirty = false;
    }
  }

  /** Tache d'encre écrasée au sol. */
  stain(x: number, y: number, r: number, dir: number, color: number, seed: number): void {
    for (const c of this.chunks) {
      if (x + r * 5 < c.x || x - r * 5 > c.x + c.w) continue;
      c.ctx.save();
      c.ctx.translate(-c.x, 0);
      drawSplat(c.ctx, x, y, r, dir, color, seeded(seed));
      c.ctx.restore();
      c.dirty = true;
    }
  }

  flush(): void {
    for (const c of this.chunks) {
      if (!c.dirty) continue;
      c.tex.refresh();
      c.dirty = false;
    }
  }

  get lvl(): Level {
    return this.level;
  }
}

function drawSplat(ctx: Ctx, x: number, y: number, r: number, dir: number, color: number, rand: Rand): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.42);
  cBlob(ctx, 0, 0, r, rgba(color, 0.78), rand, 0.38);
  const n = 3 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    const d = r * (1.2 + rand() * 2.4);
    cBlob(ctx, dir * d * (0.4 + rand()), (rand() - 0.5) * r * 1.4, r * (0.12 + rand() * 0.28), rgba(color, 0.75), rand, 0.3);
  }
  ctx.restore();
  if (rand() < 0.6) {
    const len = r * (2 + rand() * 3);
    cStroke(ctx, [{ x, y: y + 0.5 }, { x: x + dir * len, y: y + 0.5 + (rand() - 0.5) * 2 }], rgba(color, 0.55), { width: r * 0.35, taperStart: 0.05, taperEnd: 0.9 }, rand);
  }
}

// ─── Peinture du terrain ───────────────────────────────────────────────────

function paintTerrain(ctx: Ctx, l: Level, x0: number, x1: number): void {
  const solid = (tx: number, ty: number) => tileAt(l, tx, ty) === T_SOLID;
  const inRange = (px0: number, px1: number) => px1 >= x0 && px0 <= x1;

  // 1. Décors (derrière le trait de sol)
  l.decos.forEach((d, i) => {
    if (inRange(d.x - 220, d.x + 220)) drawDeco(ctx, d, seeded(hash2(i, 991)));
  });

  // 2. Lavis : plus sombre près de la surface, se dilue en profondeur.
  for (let tx = 0; tx < l.w; tx++) {
    if (!inRange(tx * TILE, (tx + 1) * TILE)) continue;
    // Dégradé continu par masse verticale (évite l'effet de bandes par tuile).
    for (let ty = 0; ty < l.h; ty++) {
      if (!solid(tx, ty) || (ty > 0 && solid(tx, ty - 1))) continue;
      let end = ty;
      while (end + 1 < l.h && solid(tx, end + 1)) end++;
      const y0 = ty * TILE;
      const y1 = (end + 1) * TILE;
      const grad = ctx.createLinearGradient(0, y0, 0, Math.min(y1, y0 + TILE * 5));
      grad.addColorStop(0, INK(0.24));
      grad.addColorStop(0.35, INK(0.11));
      grad.addColorStop(1, INK(0.025));
      ctx.fillStyle = grad;
      ctx.fillRect(tx * TILE, y0, TILE + 0.5, y1 - y0);
    }
    let depth = 0;
    for (let ty = 0; ty < l.h; ty++) {
      if (!solid(tx, ty)) continue;
      depth = ty > 0 && solid(tx, ty - 1) ? depth + 1 : 0;
      const r = seeded(hash2(tx * 131 + 7, ty));
      if (depth <= 2) {
        for (let k = 0; k < 2; k++) {
          const bx = tx * TILE + r() * TILE;
          const by = ty * TILE + r() * TILE;
          const rad = 10 + r() * 20;
          const rg = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
          rg.addColorStop(0, INK(0.05 + r() * 0.05));
          rg.addColorStop(1, INK(0));
          ctx.fillStyle = rg;
          ctx.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
        }
      }
      if (depth <= 1) {
        for (let k = 0; k < 3; k++) {
          const hx = tx * TILE + r() * TILE;
          const hy = ty * TILE + 6 + r() * (TILE - 8);
          cStroke(ctx, [{ x: hx, y: hy }, { x: hx + 5 + r() * 6, y: hy + 4 + r() * 5 }], INK(0.14), { width: 1.2, taperEnd: 0.6 }, r);
        }
      }
    }
  }

  // 3. Contours : surfaces supérieures (trait principal + herbes)
  for (let ty = 0; ty < l.h; ty++) {
    let run = -1;
    for (let tx = 0; tx <= l.w; tx++) {
      const exposed = tx < l.w && solid(tx, ty) && !solid(tx, ty - 1);
      if (exposed && run < 0) run = tx;
      if (!exposed && run >= 0) {
        if (inRange(run * TILE, tx * TILE)) topRun(ctx, run, tx - 1, ty, seeded(hash2(run * 7 + 1, ty)));
        run = -1;
      }
    }
  }
  // Faces latérales
  for (let tx = 0; tx < l.w; tx++) {
    if (!inRange(tx * TILE - 4, (tx + 1) * TILE + 4)) continue;
    for (const side of [-1, 1]) {
      let run = -1;
      for (let ty = 0; ty <= l.h; ty++) {
        const exposed = ty < l.h && solid(tx, ty) && tx + side >= 0 && tx + side < l.w && !solid(tx + side, ty);
        if (exposed && run < 0) run = ty;
        if (!exposed && run >= 0) {
          sideRun(ctx, side > 0 ? (tx + 1) * TILE : tx * TILE, run, ty - 1, side, seeded(hash2(tx * 3 + side, run)));
          run = -1;
        }
      }
    }
  }
  // Dessous (plafonds)
  for (let ty = 0; ty < l.h - 1; ty++) {
    let run = -1;
    for (let tx = 0; tx <= l.w; tx++) {
      const exposed = tx < l.w && solid(tx, ty) && !solid(tx, ty + 1);
      if (exposed && run < 0) run = tx;
      if (!exposed && run >= 0) {
        if (inRange(run * TILE, tx * TILE)) bottomRun(ctx, run, tx - 1, ty, seeded(hash2(run * 5 + 3, ty)));
        run = -1;
      }
    }
  }
  // 4. Plateformes de bois
  for (let ty = 0; ty < l.h; ty++) {
    let run = -1;
    for (let tx = 0; tx <= l.w; tx++) {
      const isPlank = tx < l.w && tileAt(l, tx, ty) === T_ONEWAY;
      if (isPlank && run < 0) run = tx;
      if (!isPlank && run >= 0) {
        if (inRange(run * TILE, tx * TILE)) plank(ctx, run, tx - 1, ty, seeded(hash2(run * 11 + 5, ty)));
        run = -1;
      }
    }
  }
}

function topRun(ctx: Ctx, a: number, b: number, ty: number, r: Rand): void {
  const y = ty * TILE + 1;
  const pts: Pt[] = [];
  for (let x = a * TILE - 2; x <= (b + 1) * TILE + 2; x += 10) pts.push({ x, y: y + (r() - 0.5) * 2.4 });
  if (pts.length < 2) pts.push({ x: (b + 1) * TILE + 2, y });
  cStroke(ctx, pts, INK(0.92), { width: 6.5, taperStart: 0.03, taperEnd: 0.05, jitter: 0.22 }, r, 2);
  cDry(ctx, pts.map((p) => ({ x: p.x, y: p.y + 4.5 })), INK(0.35), 3, r, 3);
  // Herbes
  for (let x = a * TILE + 3; x < (b + 1) * TILE - 3; x += 5 + r() * 9) {
    if (r() > 0.42) continue;
    const blades = 2 + Math.floor(r() * 3);
    for (let k = 0; k < blades; k++) {
      const ang = -Math.PI / 2 + (r() - 0.5) * 1.2;
      const len = 4 + r() * 8;
      const bx = x + (r() - 0.5) * 4;
      cStroke(ctx, [{ x: bx, y: y - 1 }, { x: bx + Math.cos(ang) * len * 0.6, y: y - 1 + Math.sin(ang) * len * 0.6 }, { x: bx + Math.cos(ang) * len, y: y - 1 + Math.sin(ang) * len }], INK(0.8), { width: 1.7, taperStart: 0, taperEnd: 0.9 }, r, 2);
    }
  }
}

function sideRun(ctx: Ctx, x: number, r0: number, r1: number, side: number, r: Rand): void {
  const pts: Pt[] = [];
  for (let y = r0 * TILE + 2; y <= (r1 + 1) * TILE; y += 9) pts.push({ x: x + (r() - 0.5) * 2, y });
  if (pts.length < 2) return;
  cStroke(ctx, pts, INK(0.8), { width: 3.6, taperStart: 0.04, taperEnd: 0.45, jitter: 0.25 }, r, 2);
  for (let y = r0 * TILE + 8; y < (r1 + 1) * TILE - 8; y += 14 + r() * 20) {
    if (r() < 0.5) continue;
    cStroke(ctx, [{ x, y }, { x: x - side * (4 + r() * 8), y: y + 6 + r() * 8 }], INK(0.32), { width: 1.4, taperEnd: 0.7 }, r);
  }
}

function bottomRun(ctx: Ctx, a: number, b: number, ty: number, r: Rand): void {
  const y = (ty + 1) * TILE - 1;
  const pts: Pt[] = [];
  for (let x = a * TILE; x <= (b + 1) * TILE; x += 12) pts.push({ x, y: y + (r() - 0.5) * 2 });
  if (pts.length < 2) return;
  cStroke(ctx, pts, INK(0.55), { width: 2.6, taperStart: 0.05, taperEnd: 0.05, jitter: 0.3 }, r, 2);
  for (let x = a * TILE + 6; x < (b + 1) * TILE - 6; x += 8 + r() * 16) {
    if (r() > 0.25) continue;
    const len = 6 + r() * 14;
    cStroke(ctx, [{ x, y }, { x: x + (r() - 0.5) * 6, y: y + len * 0.6 }, { x: x + (r() - 0.5) * 8, y: y + len }], INK(0.4), { width: 1.3, taperStart: 0, taperEnd: 0.9 }, r, 2);
  }
}

function plank(ctx: Ctx, a: number, b: number, ty: number, r: Rand): void {
  const y = ty * TILE + 4;
  const xa = a * TILE - 3;
  const xb = (b + 1) * TILE + 3;
  const wood = rgba(C.wood, 0.92);
  const mid = (xa + xb) / 2;
  cStroke(ctx, [{ x: xa, y }, { x: mid, y: y + 1.5 }, { x: xb, y }], wood, { width: 7, taperStart: 0.02, taperEnd: 0.02, jitter: 0.12 }, r, 3);
  cDry(ctx, [{ x: xa + 4, y: y + 6 }, { x: xb - 4, y: y + 6 }], rgba(C.wood, 0.45), 2.4, r, 2);
  for (const px of [xa + 8, xb - 8]) {
    cStroke(ctx, [{ x: px, y: y + 3 }, { x: px + (r() - 0.5) * 2, y: y + 24 }], rgba(C.wood, 0.7), { width: 3, taperEnd: 0.6 }, r);
    cStroke(ctx, [{ x: px - 4, y: y + 2 }, { x: px + 4, y: y + 8 }], INK(0.6), { width: 1.4 }, r);
    cStroke(ctx, [{ x: px + 4, y: y + 2 }, { x: px - 4, y: y + 8 }], INK(0.6), { width: 1.4 }, r);
  }
}

// ─── Décors ────────────────────────────────────────────────────────────────

function drawDeco(ctx: Ctx, d: Deco, r: Rand): void {
  switch (d.kind) {
    case 'torii': return torii(ctx, d.x, d.y, d.s, r);
    case 'lantern': return lantern(ctx, d.x, d.y, d.s, r);
    case 'bamboo': return bamboo(ctx, d.x, d.y, d.s, r);
    case 'pine': return pine(ctx, d.x, d.y, d.s, r);
    case 'stone': return stone(ctx, d.x, d.y, d.s, r);
    case 'banner': return banner(ctx, d.x, d.y, d.s, r);
    case 'shrine': return shrine(ctx, d.x, d.y, d.s, r);
    case 'sakura': return sakura(ctx, d.x, d.y, d.s, r);
  }
}

function torii(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const h = 118 * s;
  const half = 38 * s;
  const red = rgba(C.red, 0.9);
  for (const sx of [-1, 1]) {
    const px = x + sx * half;
    cStroke(ctx, [{ x: px + sx * 2, y }, { x: px, y: y - h }], red, { width: 9 * s, taperStart: 0.02, taperEnd: 0.04, jitter: 0.08 }, r);
    cStroke(ctx, [{ x: px + sx * 2, y: y + 1 }, { x: px + sx * 2, y: y - 9 * s }], INK(0.9), { width: 12 * s, taperStart: 0, taperEnd: 0, jitter: 0.05 }, r);
  }
  cStroke(ctx, [{ x: x - half - 14 * s, y: y - h * 0.78 }, { x: x + half + 14 * s, y: y - h * 0.78 }], red, { width: 7 * s, taperStart: 0.03, taperEnd: 0.03 }, r);
  cStroke(ctx, [{ x: x - half - 20 * s, y: y - h + 3 * s }, { x: x + half + 20 * s, y: y - h + 3 * s }], red, { width: 6 * s, taperStart: 0.03, taperEnd: 0.03 }, r);
  cStroke(ctx, [{ x: x - half - 32 * s, y: y - h - 14 * s }, { x: x - half, y: y - h - 5 * s }, { x, y: y - h - 3 * s }, { x: x + half, y: y - h - 5 * s }, { x: x + half + 32 * s, y: y - h - 14 * s }], INK(0.95), { width: 10 * s, taperStart: 0.08, taperEnd: 0.08 }, r, 4);
  cStroke(ctx, [{ x, y: y - h * 0.78 }, { x, y: y - h }], INK(0.85), { width: 5 * s, taperStart: 0, taperEnd: 0 }, r);
}

function lantern(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const st = rgba(C.inkSoft, 0.85);
  cStroke(ctx, [{ x: x - 10 * s, y: y - 2 }, { x: x + 10 * s, y: y - 2 }], st, { width: 6 * s, taperStart: 0.05, taperEnd: 0.05 }, r);
  cStroke(ctx, [{ x, y: y - 4 }, { x, y: y - 22 * s }], st, { width: 5 * s, taperStart: 0, taperEnd: 0.1 }, r);
  cStroke(ctx, [{ x: x - 8 * s, y: y - 24 * s }, { x: x + 8 * s, y: y - 24 * s }], st, { width: 3 * s }, r);
  cStroke(ctx, [{ x: x - 7 * s, y: y - 30 * s }, { x: x + 7 * s, y: y - 30 * s }], rgba(C.wash, 0.55), { width: 11 * s, taperStart: 0, taperEnd: 0 }, r);
  cBlob(ctx, x, y - 30 * s, 3 * s, rgba(C.red, 0.75), r);
  cStroke(ctx, [{ x: x - 14 * s, y: y - 34 * s }, { x, y: y - 41 * s }, { x: x + 14 * s, y: y - 34 * s }], INK(0.9), { width: 5 * s, taperStart: 0.15, taperEnd: 0.15 }, r, 3);
  cBlob(ctx, x, y - 44 * s, 2.6 * s, INK(0.9), r);
}

function bamboo(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const bx = x + (r() - 0.5) * 60 * s;
    const height = (280 + r() * 340) * s;
    const lean = (r() - 0.5) * 0.12;
    const w = (4 + r() * 3) * s;
    const a = 0.45 + r() * 0.45;
    const segH = 26 * s;
    const segs = Math.ceil(height / segH);
    for (let k = 0; k < segs; k++) {
      const yA = y - k * segH;
      const yB = y - (k + 1) * segH + 2;
      const xA = bx + lean * (y - yA);
      const xB = bx + lean * (y - yB);
      cStroke(ctx, [{ x: xA, y: yA }, { x: xB, y: yB }], INK(a), { width: w, taperStart: 0.03, taperEnd: 0.03, jitter: 0.06 }, r);
      cStroke(ctx, [{ x: xB - w * 0.9, y: yB }, { x: xB + w * 0.9, y: yB - 1 }], INK(a), { width: 1.6, taperStart: 0.2, taperEnd: 0.2 }, r);
      if (k > segs * 0.4 && r() < 0.35) {
        const leaves = 3 + Math.floor(r() * 3);
        const side = r() < 0.5 ? -1 : 1;
        for (let j = 0; j < leaves; j++) {
          const ang = Math.PI / 2 - side * (0.9 + r() * 0.9);
          const len = (14 + r() * 14) * s;
          cStroke(ctx, [{ x: xB, y: yB }, { x: xB + Math.cos(ang) * len * 0.5, y: yB + Math.sin(ang) * len * 0.35 }, { x: xB + Math.cos(ang) * len, y: yB + Math.sin(ang) * len * 0.6 + 4 }], INK(a * 0.95), { width: 4.6 * s, taperStart: 0.12, taperEnd: 0.85 }, r, 3);
        }
      }
    }
  }
}

function pine(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const trunk: Pt[] = [{ x, y }];
  let tx = x;
  for (let k = 1; k <= 5; k++) {
    tx += (r() - 0.5) * 16 * s;
    trunk.push({ x: tx, y: y - k * 26 * s });
  }
  cStroke(ctx, trunk, INK(0.85), { width: 1, widthFn: (t) => 10 * s * (1 - t * 0.7), taperStart: 0, taperEnd: 0.1, jitter: 0.15 }, r, 4);
  cDry(ctx, trunk.map((p) => ({ x: p.x + 2, y: p.y })), INK(0.4), 6 * s, r, 3);
  for (let k = 0; k < 5; k++) {
    const t = 0.4 + k * 0.14;
    const idx = Math.min(trunk.length - 1, Math.floor(t * (trunk.length - 1)));
    const base = trunk[idx];
    const side = k % 2 === 0 ? 1 : -1;
    const len = (34 + r() * 30) * s;
    const end = { x: base.x + side * len, y: base.y - 6 * s - r() * 10 * s };
    cStroke(ctx, [base, { x: (base.x + end.x) / 2, y: base.y + 2 }, end], INK(0.8), { width: 3.4 * s, taperStart: 0, taperEnd: 0.6 }, r, 3);
    pinePad(ctx, end.x, end.y, (26 + r() * 16) * s, r);
  }
  pinePad(ctx, trunk[trunk.length - 1].x, trunk[trunk.length - 1].y, 30 * s, r);
}

function pinePad(ctx: Ctx, x: number, y: number, w: number, r: Rand): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.38);
  cBlob(ctx, 0, 0, w * 0.6, INK(0.18), r, 0.25);
  ctx.restore();
  for (let i = 0; i < 16; i++) {
    const px = x + (r() - 0.5) * w * 1.1;
    const ang = -Math.PI / 2 + (r() - 0.5) * 1.4;
    const len = 6 + r() * 9;
    cStroke(ctx, [{ x: px, y: y + 4 }, { x: px + Math.cos(ang) * len, y: y + 4 + Math.sin(ang) * len }], INK(0.7), { width: 1.4, taperStart: 0, taperEnd: 0.9 }, r);
  }
}

function stone(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const w = (16 + r() * 10) * s;
  const h = (10 + r() * 6) * s;
  ctx.save();
  ctx.translate(x, y - h * 0.5);
  ctx.scale(1, h / w);
  cBlob(ctx, 0, 0, w, rgba(C.wash, 0.35), r, 0.12);
  ctx.restore();
  cStroke(ctx, ringPoints(x, y - h * 0.4, w, Math.PI * 1.05, Math.PI * 1.95, 10).map((p) => ({ x: p.x, y: y - h * 0.4 + (p.y - (y - h * 0.4)) * (h / w) })), INK(0.8), { width: 3, taperStart: 0.2, taperEnd: 0.4 }, r);
}

function banner(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const h = 130 * s;
  cStroke(ctx, [{ x, y }, { x, y: y - h }], rgba(C.wood, 0.9), { width: 3.2 * s, taperStart: 0, taperEnd: 0.05 }, r);
  cStroke(ctx, [{ x: x - 2, y: y - h + 6 * s }, { x: x + 26 * s, y: y - h + 6 * s }], rgba(C.wood, 0.9), { width: 2.4 * s, taperStart: 0, taperEnd: 0.2 }, r);
  cStroke(ctx, [{ x: x + 13 * s, y: y - h + 8 * s }, { x: x + 14 * s, y: y - h + 84 * s }], rgba(C.red, 0.85), { width: 22 * s, taperStart: 0, taperEnd: 0.06, jitter: 0.06 }, r);
  cStroke(ctx, ringPoints(x + 13.5 * s, y - h + 34 * s, 6.5 * s, 0, Math.PI * 1.85, 14), INK(0.85), { width: 2.4 * s, taperStart: 0.1, taperEnd: 0.4 }, r);
}

function shrine(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  cStroke(ctx, [{ x: x - 20 * s, y: y - 3 }, { x: x + 20 * s, y: y - 3 }], rgba(C.inkSoft, 0.8), { width: 7 * s, taperStart: 0.05, taperEnd: 0.05 }, r);
  for (const px of [x - 14 * s, x + 14 * s]) cStroke(ctx, [{ x: px, y: y - 6 }, { x: px, y: y - 34 * s }], rgba(C.wood, 0.85), { width: 3.4 * s, taperStart: 0, taperEnd: 0 }, r);
  cFill(ctx, [{ x: x - 12 * s, y: y - 8 }, { x: x + 12 * s, y: y - 8 }, { x: x + 12 * s, y: y - 32 * s }, { x: x - 12 * s, y: y - 32 * s }], rgba(C.red, 0.35));
  cStroke(ctx, [{ x: x - 30 * s, y: y - 34 * s }, { x: x - 10 * s, y: y - 46 * s }, { x, y: y - 50 * s }, { x: x + 10 * s, y: y - 46 * s }, { x: x + 30 * s, y: y - 34 * s }], INK(0.92), { width: 7 * s, taperStart: 0.12, taperEnd: 0.12 }, r, 4);
  cBlob(ctx, x, y - 20 * s, 3 * s, INK(0.7), r);
}

function sakura(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const trunk: Pt[] = [{ x, y }, { x: x - 6 * s, y: y - 30 * s }, { x: x + 4 * s, y: y - 62 * s }, { x: x - 2 * s, y: y - 92 * s }];
  cStroke(ctx, trunk, INK(0.85), { width: 1, widthFn: (t) => 11 * s * (1 - t * 0.6), taperStart: 0, taperEnd: 0.15 }, r, 4);
  const tips: Pt[] = [];
  for (let k = 0; k < 6; k++) {
    const base = trunk[1 + (k % 3)];
    const ang = -Math.PI / 2 + (k % 2 === 0 ? 1 : -1) * (0.5 + r() * 0.8);
    const len = (30 + r() * 34) * s;
    const end = { x: base.x + Math.cos(ang) * len, y: base.y + Math.sin(ang) * len };
    cStroke(ctx, [base, { x: (base.x + end.x) / 2 + (r() - 0.5) * 8, y: (base.y + end.y) / 2 }, end], INK(0.75), { width: 3.2 * s, taperStart: 0, taperEnd: 0.8 }, r, 3);
    tips.push(end);
  }
  for (const t of tips.concat(trunk.slice(2))) {
    for (let i = 0; i < 10; i++) {
      const bx = t.x + (r() - 0.5) * 36 * s;
      const by = t.y + (r() - 0.5) * 24 * s;
      cBlob(ctx, bx, by, (4 + r() * 6) * s, rgba(C.blossom, 0.28), r, 0.3);
    }
    for (let i = 0; i < 7; i++) cBlob(ctx, t.x + (r() - 0.5) * 34 * s, t.y + (r() - 0.5) * 22 * s, 1.6 * s, rgba(C.red, 0.6), r, 0.2);
  }
}

