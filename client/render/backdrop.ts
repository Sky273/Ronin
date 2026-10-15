import Phaser from 'phaser';
import { cBlob, cDry, cStroke, type Pt, type Rand, seeded } from './brush';
import { C, rgba } from './palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

const LAYER_W = 2048;

function canvas(scene: Phaser.Scene, key: string, w: number, h: number) {
  const tex = scene.textures.createCanvas(key, w, h)!;
  return { tex, ctx: tex.context };
}

/** Papier de riz : teinte chaude, marbrures, fibres et grain. */
export function makePaper(scene: Phaser.Scene, key: string, w: number, h: number): string {
  const { tex, ctx } = canvas(scene, key, w, h);
  const r = seeded(11);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f3ebd9');
  g.addColorStop(1, '#e9dec5');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = 60 + r() * 220;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const dark = r() < 0.5;
    rg.addColorStop(0, dark ? 'rgba(120,95,60,0.05)' : 'rgba(255,252,240,0.08)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 500; i++) {
    const x = r() * w;
    const y = r() * h;
    const len = 6 + r() * 26;
    const a = r() * Math.PI;
    ctx.strokeStyle = `rgba(110,90,60,${0.03 + r() * 0.05})`;
    ctx.lineWidth = 0.6 + r() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (r() - 0.5) * 6, y + Math.sin(a) * len * 0.5 + (r() - 0.5) * 6, x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  addGrain(ctx, w, h, 7, r);
  tex.refresh();
  return key;
}

function addGrain(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, r: Rand): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Texture de grain à superposer en mode multiplication sur toute la scène. */
export function makeGrainOverlay(scene: Phaser.Scene, key: string): string {
  const size = 256;
  const { tex, ctx } = canvas(scene, key, size, size);
  const r = seeded(5);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 255 - r() * r() * 34;
    d[i] = v;
    d[i + 1] = v - 2;
    d[i + 2] = v - 6;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineCap = 'round';
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(150,120,80,${0.08 + r() * 0.08})`;
    ctx.lineWidth = 0.7;
    const x = r() * size;
    const y = r() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30);
    ctx.stroke();
  }
  tex.refresh();
  return key;
}

export function makeVignette(scene: Phaser.Scene, key: string, w: number, h: number): string {
  const { tex, ctx } = canvas(scene, key, w, h);
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95);
  g.addColorStop(0, 'rgba(80,55,30,0)');
  g.addColorStop(1, 'rgba(80,55,30,0.32)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  tex.refresh();
  return key;
}

/** Soleil vermillon peint en plusieurs passes. */
function makeSun(scene: Phaser.Scene, key: string): string {
  const s = 220;
  const { tex, ctx } = canvas(scene, key, s, s);
  const r = seeded(3);
  for (let i = 0; i < 6; i++) cBlob(ctx, s / 2 + (r() - 0.5) * 4, s / 2 + (r() - 0.5) * 4, 72 - i * 3, rgba(C.red, 0.22), r, 0.05);
  cBlob(ctx, s / 2, s / 2, 66, rgba(C.red, 0.55), r, 0.03);
  tex.refresh();
  return key;
}

// ─── Montagnes ──────────────────────────────────────────────────────────────

interface MountainOpts {
  seed: number;
  h: number;
  base: number;
  amp: number;
  alpha: number;
  pines: boolean;
  pagodas: number[];
}

function makeMountains(scene: Phaser.Scene, key: string, o: MountainOpts): string {
  const W = LAYER_W;
  const { tex, ctx } = canvas(scene, key, W, o.h);
  const r = seeded(o.seed);
  // Somme d'harmoniques entières → profil parfaitement périodique (tuilable).
  const harm = [1, 2, 3, 5, 8, 13, 21].map((f, i) => ({ f, a: o.amp * [0.42, 0.3, 0.24, 0.15, 0.09, 0.05, 0.03][i], p: r() * Math.PI * 2 }));
  const ridge = (x: number) => {
    let y = 0;
    for (const hm of harm) y += hm.a * Math.pow(0.5 + 0.5 * Math.sin((x / W) * Math.PI * 2 * hm.f + hm.p), 1.4);
    return o.base - y;
  };
  const top = Math.min(...Array.from({ length: 64 }, (_, i) => ridge((i / 64) * W)));

  ctx.beginPath();
  ctx.moveTo(0, o.h);
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, ridge(x));
  ctx.lineTo(W, o.h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top, 0, o.base + 120);
  g.addColorStop(0, rgba(C.ink, o.alpha));
  g.addColorStop(0.5, rgba(C.ink, o.alpha * 0.45));
  g.addColorStop(1, rgba(C.ink, 0));
  ctx.fillStyle = g;
  ctx.fill();

  // Crête au pinceau sec, par segments interrompus.
  for (let x0 = 0; x0 < W; x0 += 120 + r() * 160) {
    const len = 80 + r() * 200;
    const pts: Pt[] = [];
    for (let x = x0; x <= x0 + len; x += 12) pts.push({ x, y: ridge(x) + 1 });
    cDry(ctx, pts, rgba(C.ink, Math.min(0.9, o.alpha * 2.2)), 3, r, 3);
  }
  // Rides (« cun ») qui suivent la pente.
  for (let i = 0; i < 220; i++) {
    const x = r() * W;
    const y = ridge(x) + r() * 70;
    const slope = (ridge(x + 6) - ridge(x - 6)) / 12;
    const len = 8 + r() * 24;
    const dir = slope > 0 ? 1 : -1;
    const pts = [
      { x, y },
      { x: x + dir * len * 0.5, y: y + len * 0.6 },
      { x: x + dir * len * 0.7, y: y + len },
    ];
    for (const ox of [0, W, -W]) {
      cStroke(ctx, pts.map((p) => ({ x: p.x + ox, y: p.y })), rgba(C.ink, o.alpha * 0.7), { width: 1 + r() * 1.6, taperEnd: 0.8 }, seeded(i * 31 + 7), 3);
    }
  }
  if (o.pines) {
    for (let x = 20; x < W; x += 30 + r() * 90) {
      const y = ridge(x) + 2;
      const hgt = 10 + r() * 18;
      for (const ox of [0, W, -W]) drawTinyPine(ctx, x + ox, y, hgt, o.alpha * 2, seeded(Math.floor(x)));
    }
  }
  for (const px of o.pagodas) drawPagoda(ctx, px, ridge(px) + 6, 0.9, rgba(C.ink, Math.min(0.85, o.alpha * 2.4)), r);

  // Brume au pied des montagnes.
  const mist = ctx.createLinearGradient(0, o.base - 30, 0, o.h);
  mist.addColorStop(0, 'rgba(240,231,211,0)');
  mist.addColorStop(0.6, 'rgba(240,231,211,0.75)');
  mist.addColorStop(1, 'rgba(240,231,211,0.95)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, o.base - 30, W, o.h - o.base + 30);

  tex.refresh();
  return key;
}

function drawTinyPine(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, alpha: number, r: Rand): void {
  const st = rgba(C.ink, Math.min(0.8, alpha));
  cStroke(ctx, [{ x, y }, { x: x + (r() - 0.5) * 3, y: y - h }], st, { width: 1.6, taperEnd: 0.6 }, r);
  for (let k = 0; k < 4; k++) {
    const yy = y - h * (0.35 + k * 0.18);
    const ww = h * (0.45 - k * 0.08);
    cStroke(ctx, [{ x: x - ww, y: yy + 1 }, { x, y: yy - 1 }, { x: x + ww, y: yy + 1 }], st, { width: 2.4, taperStart: 0.3, taperEnd: 0.3 }, r);
  }
}

function drawPagoda(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, style: string, r: Rand): void {
  const tiers = 5;
  let yy = y;
  for (let i = 0; i < tiers; i++) {
    const w = (34 - i * 5) * s;
    const h = (16 - i) * s;
    cStroke(ctx, [{ x, y: yy }, { x, y: yy - h }], style, { width: w * 0.55, taperStart: 0, taperEnd: 0, jitter: 0.05 }, r);
    yy -= h;
    cStroke(ctx, [{ x: x - w - 6 * s, y: yy - 4 * s }, { x: x - w * 0.5, y: yy + 1 }, { x: x + w * 0.5, y: yy + 1 }, { x: x + w + 6 * s, y: yy - 4 * s }], style, { width: 4 * s, taperStart: 0.15, taperEnd: 0.15 }, r, 3);
  }
  cStroke(ctx, [{ x, y: yy }, { x, y: yy - 22 * s }], style, { width: 1.6 * s, taperEnd: 0.5 }, r);
}

/** Forêt de bambous lointaine, silhouettes au lavis. */
function makeBambooLayer(scene: Phaser.Scene, key: string, h: number): string {
  const W = LAYER_W;
  const { tex, ctx } = canvas(scene, key, W, h);
  const r = seeded(77);
  for (let cx = 40; cx < W; cx += 140 + r() * 260) {
    const n = 3 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const bx = cx + (r() - 0.5) * 120;
      const a = 0.08 + r() * 0.16;
      const wdt = 4 + r() * 6;
      const lean = (r() - 0.5) * 0.08;
      for (const ox of [0, W, -W]) {
        const rr = seeded(Math.floor(bx * 13 + i));
        const x0 = bx + ox;
        for (let y = h; y > -20; y -= 30) {
          const xa = x0 + lean * (h - y);
          const xb = x0 + lean * (h - y + 28);
          cStroke(ctx, [{ x: xa, y }, { x: xb, y: y - 28 }], rgba(C.ink, a), { width: wdt, taperStart: 0.05, taperEnd: 0.05, jitter: 0.06 }, rr);
          if (y < h * 0.65 && rr() < 0.3) {
            for (let k = 0; k < 3; k++) {
              const ang = (rr() < 0.5 ? -1 : 1) * (0.4 + rr() * 0.8) + Math.PI / 2;
              const len = 16 + rr() * 22;
              cStroke(ctx, [{ x: xb, y: y - 28 }, { x: xb + Math.cos(ang) * len * 0.6, y: y - 28 + Math.sin(ang) * len * 0.3 }, { x: xb + Math.cos(ang) * len, y: y - 28 + Math.sin(ang) * len * 0.55 }], rgba(C.ink, a * 1.1), { width: 4.5, taperStart: 0.15, taperEnd: 0.85 }, rr, 3);
            }
          }
        }
      }
    }
  }
  const mist = ctx.createLinearGradient(0, h * 0.55, 0, h);
  mist.addColorStop(0, 'rgba(240,231,211,0)');
  mist.addColorStop(1, 'rgba(240,231,211,0.9)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, h * 0.55, W, h * 0.45);
  tex.refresh();
  return key;
}

interface ParallaxLayer {
  spr: Phaser.GameObjects.TileSprite;
  f: number;
  baseY: number;
}

/** Fond multi-couches rendu par une caméra dédiée (sans zoom). */
export class Backdrop {
  private layers: ParallaxLayer[] = [];
  private sun: Phaser.GameObjects.Image;
  private sunBase: Pt;

  constructor(scene: Phaser.Scene, put: Put) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    put(scene.add.image(0, 0, makePaper(scene, 'paper', W, H)).setOrigin(0), 'bg');

    this.sunBase = { x: W * 0.72, y: H * 0.22 };
    this.sun = put(scene.add.image(this.sunBase.x, this.sunBase.y, makeSun(scene, 'sun')), 'bg');

    const far = makeMountains(scene, 'mFar', { seed: 21, h: 460, base: 330, amp: 230, alpha: 0.16, pines: false, pagodas: [] });
    const mid = makeMountains(scene, 'mMid', { seed: 42, h: 460, base: 360, amp: 170, alpha: 0.26, pines: true, pagodas: [620, 1710] });
    const bam = makeBambooLayer(scene, 'bamboo', 620);

    const add = (key: string, y: number, h: number, f: number) => {
      const spr = put(scene.add.tileSprite(0, y, W, h, key).setOrigin(0, 0), 'bg');
      this.layers.push({ spr, f, baseY: y });
    };
    add(far, 60, 460, 0.08);
    add(mid, 150, 460, 0.2);
    add(bam, 120, 620, 0.42);
  }

  update(cam: Phaser.Cameras.Scene2D.Camera): void {
    const sx = cam.scrollX;
    const sy = cam.scrollY;
    for (const l of this.layers) {
      l.spr.tilePositionX = sx * l.f;
      l.spr.y = l.baseY - (sy - 200) * l.f * 0.6;
    }
    this.sun.x = this.sunBase.x - sx * 0.015;
    this.sun.y = this.sunBase.y - (sy - 200) * 0.02;
  }
}
