import Phaser from 'phaser';
import type { BiomeId } from '../../shared/biomes';
import { BIOME_LOOK, type BiomeLook, type MountainLook, type NearKind, type OrbKind, orbKey } from './biomes';
import { cBlob, cDry, cFill, cStroke, type Pt, type Rand, ringPoints, seeded } from './brush';
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

interface MountainOpts extends MountainLook {
  h: number;
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
  const ink = o.ink ?? C.ink;

  ctx.beginPath();
  ctx.moveTo(0, o.h);
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, ridge(x));
  ctx.lineTo(W, o.h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top, 0, o.base + 120);
  g.addColorStop(0, rgba(ink, o.alpha));
  g.addColorStop(0.5, rgba(ink, o.alpha * 0.45));
  g.addColorStop(1, rgba(ink, 0));
  ctx.fillStyle = g;
  ctx.fill();
  // Fumées et lueurs d'incendie derrière les crêtes (tirage séparé).
  if (o.smoke) for (const sx of o.smoke) drawSmokeColumn(ctx, sx, ridge(sx) + 10, o.alpha, seeded(o.seed * 97 + Math.floor(sx)));
  // Neige des cimes, avant le trait de crête.
  if (o.snow) drawRidgeSnow(ctx, ridge, top, o.base, o.snow, seeded(o.seed * 53 + 1));

  // Crête au pinceau sec, par segments interrompus.
  for (let x0 = 0; x0 < W; x0 += 120 + r() * 160) {
    const len = 80 + r() * 200;
    const pts: Pt[] = [];
    for (let x = x0; x <= x0 + len; x += 12) pts.push({ x, y: ridge(x) + 1 });
    cDry(ctx, pts, rgba(ink, Math.min(0.9, o.alpha * 2.2)), 3, r, 3);
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
      cStroke(ctx, pts.map((p) => ({ x: p.x + ox, y: p.y })), rgba(ink, o.alpha * 0.7), { width: 1 + r() * 1.6, taperEnd: 0.8 }, seeded(i * 31 + 7), 3);
    }
  }
  if (o.pines) {
    for (let x = 20; x < W; x += 30 + r() * 90) {
      const y = ridge(x) + 2;
      const hgt = 10 + r() * 18;
      for (const ox of [0, W, -W]) drawTinyPine(ctx, x + ox, y, hgt, o.alpha * 2, seeded(Math.floor(x)), ink, !!o.snow);
    }
  }
  for (const px of o.pagodas) drawPagoda(ctx, px, ridge(px) + 6, 0.9, rgba(ink, Math.min(0.85, o.alpha * 2.4)), r);
  if (o.castles) for (const px of o.castles) drawCastle(ctx, px, ridge(px) + 8, 1, rgba(ink, Math.min(0.85, o.alpha * 2.4)), seeded(o.seed * 7 + px));

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

function drawTinyPine(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, alpha: number, r: Rand, ink: number = C.ink, snowy = false): void {
  const st = rgba(ink, Math.min(0.8, alpha));
  cStroke(ctx, [{ x, y }, { x: x + (r() - 0.5) * 3, y: y - h }], st, { width: 1.6, taperEnd: 0.6 }, r);
  for (let k = 0; k < 4; k++) {
    const yy = y - h * (0.35 + k * 0.18);
    const ww = h * (0.45 - k * 0.08);
    cStroke(ctx, [{ x: x - ww, y: yy + 1 }, { x, y: yy - 1 }, { x: x + ww, y: yy + 1 }], st, { width: 2.4, taperStart: 0.3, taperEnd: 0.3 }, r);
    if (snowy) cStroke(ctx, [{ x: x - ww * 0.7, y: yy - 0.5 }, { x, y: yy - 2.2 }, { x: x + ww * 0.7, y: yy - 0.5 }], rgba(C.snow, 0.8), { width: 1.4, taperStart: 0.3, taperEnd: 0.3 }, r);
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

// ─── Biomes : astres, neige, fumées, donjons ────────────────────────────────

/** Soleil couchant orangé, barré de nuages de papier. */
function makeDusk(scene: Phaser.Scene, key: string): string {
  const s = 280;
  const { tex, ctx } = canvas(scene, key, s, s);
  const r = seeded(13);
  for (let i = 0; i < 6; i++) cBlob(ctx, s / 2 + (r() - 0.5) * 5, s / 2 + (r() - 0.5) * 5, 96 - i * 3, rgba(C.ember, 0.2), r, 0.05);
  cBlob(ctx, s / 2, s / 2, 86, rgba(C.ember, 0.5), r, 0.03);
  for (let k = 0; k < 3; k++) {
    const y = s * (0.56 + k * 0.1);
    const x0 = 20 + r() * 40;
    const x1 = s - 20 - r() * 40;
    cStroke(ctx, [{ x: x0, y }, { x: (x0 + x1) / 2, y: y + (r() - 0.5) * 4 }, { x: x1, y: y + (r() - 0.5) * 3 }], rgba(C.paper, 0.7), { width: 5 + r() * 5, taperStart: 0.3, taperEnd: 0.4, jitter: 0.25 }, r, 3);
  }
  tex.refresh();
  return key;
}

/** Lune pâle : disque de papier clair, halo et mers à peine lavées. */
function makeMoon(scene: Phaser.Scene, key: string): string {
  const s = 220;
  const { tex, ctx } = canvas(scene, key, s, s);
  const r = seeded(17);
  const c = s / 2;
  for (let i = 0; i < 5; i++) cBlob(ctx, c, c, 86 - i * 5, 'rgba(255,255,255,0.08)', r, 0.04);
  cBlob(ctx, c, c, 56, rgba(C.snow, 0.95), r, 0.025);
  for (let i = 0; i < 5; i++) cBlob(ctx, c + (r() - 0.5) * 60, c + (r() - 0.5) * 60, 7 + r() * 10, rgba(C.snowShade, 0.16), r, 0.3);
  cStroke(ctx, ringPoints(c, c, 57, Math.PI * 0.55, Math.PI * 1.6, 18), rgba(C.inkCold, 0.22), { width: 2.2, taperStart: 0.3, taperEnd: 0.4 }, r, 2);
  tex.refresh();
  return key;
}

/** Grand soleil sang, traversé d'une bande de nuage d'encre. */
function makeBloodSun(scene: Phaser.Scene, key: string): string {
  const s = 260;
  const { tex, ctx } = canvas(scene, key, s, s);
  const r = seeded(19);
  for (let i = 0; i < 6; i++) cBlob(ctx, s / 2 + (r() - 0.5) * 4, s / 2 + (r() - 0.5) * 4, 90 - i * 3, rgba(C.redDeep, 0.22), r, 0.05);
  cBlob(ctx, s / 2, s / 2, 82, rgba(C.redDeep, 0.6), r, 0.03);
  cStroke(ctx, [{ x: 16, y: s * 0.62 }, { x: s / 2, y: s * 0.6 }, { x: s - 16, y: s * 0.63 }], rgba(C.ink, 0.2), { width: 6, taperStart: 0.3, taperEnd: 0.4, jitter: 0.3 }, r, 3);
  tex.refresh();
  return key;
}

/** Génère (une seule fois) la texture d'un astre et renvoie sa clé. */
function ensureOrb(scene: Phaser.Scene, kind: OrbKind): string {
  const key = orbKey(kind);
  if (scene.textures.exists(key)) return key;
  switch (kind) {
    case 'sun': return makeSun(scene, key);
    case 'dusk': return makeDusk(scene, key);
    case 'moon': return makeMoon(scene, key);
    case 'blood': return makeBloodSun(scene, key);
  }
}

/** Neige des cimes : traînées claires qui descendent de la crête, plus épaisses sur les sommets. */
function drawRidgeSnow(ctx: CanvasRenderingContext2D, ridge: (x: number) => number, top: number, base: number, amount: number, r: Rand): void {
  const W = LAYER_W;
  const line = top + (base - top) * 0.5 * amount;
  const phase = r() * 1000;
  for (let x = 0; x < W; x += 3) {
    const y0 = ridge(x);
    if (y0 >= line) continue;
    const rr = seeded(Math.floor(x * 7 + phase));
    const d = (line - y0) * (0.35 + rr() * 0.4) + 3;
    const slope = (ridge(x + 6) - ridge(x - 6)) / 12;
    for (const ox of [0, W, -W]) {
      if (x + ox < -20 || x + ox > W + 20) continue;
      cStroke(ctx, [{ x: x + ox, y: y0 + 0.5 }, { x: x + ox + slope * d * 0.4, y: y0 + d }], rgba(C.snow, 0.82), { width: 4.2, taperStart: 0, taperEnd: 0.85, jitter: 0.2 }, seeded(Math.floor(x * 13 + phase)));
    }
  }
}

/** Colonne de fumée au lavis et lueur d'incendie à son pied (tuilable). */
function drawSmokeColumn(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number, r: Rand, scale = 1): void {
  const seed = Math.floor(r() * 1e9);
  const W = LAYER_W;
  for (const ox of [0, W, -W]) {
    const rr = seeded(seed);
    const cx = x + ox;
    if (cx < -300 * scale || cx > W + 300 * scale) continue;
    const glowR = 130 * scale;
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(1, 0.45);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
    g.addColorStop(0, rgba(C.ember, 0.2));
    g.addColorStop(0.5, rgba(C.red, 0.08));
    g.addColorStop(1, rgba(C.red, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2);
    ctx.restore();
    let sx = cx;
    let sy = y;
    const drift = 0.5 + rr() * 0.6;
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const rad = (16 + t * 46 + rr() * 10) * scale;
      cBlob(ctx, sx, sy, rad, rgba(i < 3 ? C.soot : C.wash, Math.min(0.14, alpha * 0.55) * (1 - t * 0.6)), rr, 0.3);
      sx += drift * (6 + t * 10) * scale + (rr() - 0.5) * 6;
      sy -= (18 + rr() * 8) * scale;
    }
  }
}

/** Donjon de château (tenshu) : base de pierre, étages et toits relevés. */
function drawCastle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, style: string, r: Rand): void {
  cFill(ctx, [{ x: x - 38 * s, y }, { x: x + 38 * s, y }, { x: x + 29 * s, y: y - 22 * s }, { x: x - 29 * s, y: y - 22 * s }], style);
  let yy = y - 22 * s;
  const tiers: [number, number][] = [[26, 17], [20, 14], [14, 12]];
  for (const [w0, h0] of tiers) {
    const w = w0 * s;
    const h = h0 * s;
    cFill(ctx, [{ x: x - w, y: yy }, { x: x + w, y: yy }, { x: x + w, y: yy - h }, { x: x - w, y: yy - h }], style);
    const ry = yy - h;
    cStroke(ctx, [{ x: x - w - 11 * s, y: ry - 4 * s }, { x: x - w, y: ry + 1 }, { x: x + w, y: ry + 1 }, { x: x + w + 11 * s, y: ry - 4 * s }], style, { width: 4.5 * s, taperStart: 0.15, taperEnd: 0.15 }, r, 3);
    yy = ry - 3 * s;
  }
  cStroke(ctx, [{ x: x - 9 * s, y: yy - 2 * s }, { x, y: yy - 6 * s }, { x: x + 9 * s, y: yy - 2 * s }], style, { width: 4 * s, taperStart: 0.2, taperEnd: 0.2 }, r, 3);
  for (const sx of [-1, 1]) cBlob(ctx, x + sx * 9 * s, yy - 4 * s, 2 * s, style, r);
}

// ─── Biomes : couches proches ───────────────────────────────────────────────

function nearMist(ctx: CanvasRenderingContext2D, h: number): void {
  const mist = ctx.createLinearGradient(0, h * 0.55, 0, h);
  mist.addColorStop(0, 'rgba(240,231,211,0)');
  mist.addColorStop(1, 'rgba(240,231,211,0.9)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, h * 0.55, LAYER_W, h * 0.45);
}

/** Village en feu : toits en silhouette, fumées et lueurs. */
function makeRoofLayer(scene: Phaser.Scene, key: string, h: number): string {
  const W = LAYER_W;
  const { tex, ctx } = canvas(scene, key, W, h);
  const r = seeded(91);
  for (let cx = 160; cx < W; cx += 430 + r() * 380) drawSmokeColumn(ctx, cx, h * 0.64, 0.2, seeded(Math.floor(cx * 3 + 1)), 1.5);
  for (let cx = 30; cx < W - 30; cx += 70 + r() * 130) {
    const base = h * (0.64 + r() * 0.08);
    const hw = 26 + r() * 30;
    const wh = 20 + r() * 22;
    const rh = 16 + r() * 16;
    const a = 0.1 + r() * 0.12;
    const burning = r() < 0.3;
    const seed = Math.floor(cx * 7 + 3);
    for (const ox of [0, W, -W]) {
      if (cx + ox < -120 || cx + ox > W + 120) continue;
      drawRoofSilhouette(ctx, cx + ox, base, hw, wh, rh, a, burning, h, seeded(seed));
    }
  }
  nearMist(ctx, h);
  tex.refresh();
  return key;
}

function drawRoofSilhouette(ctx: CanvasRenderingContext2D, x: number, base: number, hw: number, wh: number, rh: number, a: number, burning: boolean, h: number, r: Rand): void {
  const top = base - wh;
  cFill(ctx, [{ x: x - hw, y: h }, { x: x + hw, y: h }, { x: x + hw, y: top }, { x: x - hw, y: top }], rgba(C.inkWarm, a * 0.6));
  const ew = hw + 14;
  const rw = hw * 0.55;
  cFill(ctx, [{ x: x - ew, y: top - 4 }, { x: x - rw, y: top - rh }, { x: x + rw, y: top - rh }, { x: x + ew, y: top - 4 }, { x: x + hw, y: top + 1 }, { x: x - hw, y: top + 1 }], rgba(C.inkWarm, a * 1.3));
  cStroke(ctx, [{ x: x - ew - 3, y: top - 7 }, { x: x - hw, y: top + 1 }, { x: x + hw, y: top + 1 }, { x: x + ew + 3, y: top - 7 }], rgba(C.ink, Math.min(0.6, a * 1.8)), { width: 3.2, taperStart: 0.12, taperEnd: 0.12 }, r, 3);
  cStroke(ctx, [{ x: x - rw - 5, y: top - rh - 3 }, { x, y: top - rh }, { x: x + rw + 5, y: top - rh - 3 }], rgba(C.ink, Math.min(0.6, a * 1.8)), { width: 2.6, taperStart: 0.15, taperEnd: 0.15 }, r, 3);
  if (!burning) return;
  for (let f = 0; f < 3; f++) {
    const fx = x + (r() - 0.5) * rw * 1.6;
    const fh = 16 + r() * 26;
    const fy = top - rh + 4 + r() * 6;
    cStroke(ctx, [{ x: fx, y: fy }, { x: fx + (r() - 0.5) * 6, y: fy - fh * 0.5 }, { x: fx + (r() - 0.5) * 8, y: fy - fh }], rgba(C.red, 0.32), { width: 8, taperStart: 0, taperEnd: 0.95, jitter: 0.2 }, r, 3);
  }
  for (let i = 0; i < 6; i++) cBlob(ctx, x + (r() - 0.5) * hw * 2, top - rh - r() * 60, 0.9 + r() * 1.2, rgba(C.ember, 0.5), r, 0.2);
}

/** Col enneigé : grands pins au lavis froid, chargés de neige, et flocons. */
function makeSnowPineLayer(scene: Phaser.Scene, key: string, h: number): string {
  const W = LAYER_W;
  const { tex, ctx } = canvas(scene, key, W, h);
  const r = seeded(83);
  for (let cx = 40; cx < W; cx += 120 + r() * 220) {
    const n = 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const bx = cx + (r() - 0.5) * 80;
      const height = 220 + r() * 300;
      const a = 0.08 + r() * 0.14;
      const seed = Math.floor(bx * 11 + i);
      for (const ox of [0, W, -W]) {
        if (bx + ox < -120 || bx + ox > W + 120) continue;
        drawSnowPine(ctx, bx + ox, h, height, a, seeded(seed));
      }
    }
  }
  for (let i = 0; i < 260; i++) cBlob(ctx, r() * W, r() * h * 0.8, 0.8 + r() * 1.6, rgba(C.snow, 0.85), r, 0.2);
  nearMist(ctx, h);
  tex.refresh();
  return key;
}

function drawSnowPine(ctx: CanvasRenderingContext2D, x: number, h: number, height: number, a: number, r: Rand): void {
  const lean = (r() - 0.5) * 20;
  cStroke(ctx, [{ x, y: h }, { x: x + lean * 0.5, y: h - height * 0.5 }, { x: x + lean, y: h - height }], rgba(C.inkCold, a * 1.2), { width: 7, taperStart: 0, taperEnd: 0.6 }, r, 3);
  const tiers = 6 + Math.floor(height / 70);
  for (let k = 0; k < tiers; k++) {
    const t = 0.25 + (0.75 * k) / tiers;
    const yy = h - height * t;
    const cx = x + lean * t;
    const ww = (1 - t) * 70 + 14 + r() * 10;
    cStroke(ctx, [{ x: cx - ww, y: yy + 7 }, { x: cx, y: yy - 3 }, { x: cx + ww, y: yy + 7 }], rgba(C.inkCold, a), { width: 9, taperStart: 0.3, taperEnd: 0.3, jitter: 0.25 }, r, 3);
    cStroke(ctx, [{ x: cx - ww * 0.8, y: yy + 2 }, { x: cx, y: yy - 6 }, { x: cx + ww * 0.8, y: yy + 2 }], rgba(C.snow, 0.85), { width: 4, taperStart: 0.35, taperEnd: 0.35, jitter: 0.3 }, r, 3);
  }
}

/** Château : longue enceinte (pierre, mur blanc, meurtrières), tourelles et donjon au loin. */
function makeRampartLayer(scene: Phaser.Scene, key: string, h: number): string {
  const W = LAYER_W;
  const { tex, ctx } = canvas(scene, key, W, h);
  const r = seeded(61);
  const gy = h * 0.72;
  const wallTop = gy - 46;
  const plasterTop = wallTop - 22;
  // Donjon derrière l'enceinte.
  for (const ox of [0, W, -W]) drawCastle(ctx, 1150 + ox, wallTop + 4, 2.6, rgba(C.ink, 0.15), seeded(611));
  // Base de pierre jusqu'au bas de la couche (la brume la recouvre).
  cFill(ctx, [{ x: 0, y: h }, { x: W, y: h }, { x: W, y: wallTop }, { x: 0, y: wallTop }], rgba(C.stone, 0.18));
  for (let k = 1; k <= 4; k++) {
    const y = wallTop + k * 11.5;
    for (let x0 = 0; x0 < W; x0 += 200) {
      cDry(ctx, [{ x: x0, y: y + (r() - 0.5) * 2 }, { x: Math.min(W, x0 + 200), y: y + (r() - 0.5) * 2 }], rgba(C.ink, 0.14), 1.6, r, 2);
    }
    for (let jx = (k % 2) * 12 + r() * 10; jx < W; jx += 22 + r() * 16) {
      cStroke(ctx, [{ x: jx, y: y - 10 }, { x: jx + (r() - 0.5) * 2, y: y - 1 }], rgba(C.ink, 0.12), { width: 1.3, taperStart: 0.2, taperEnd: 0.2 }, r);
    }
  }
  // Mur blanc et chaperon de tuiles.
  cFill(ctx, [{ x: 0, y: wallTop }, { x: W, y: wallTop }, { x: W, y: plasterTop }, { x: 0, y: plasterTop }], rgba(C.paper, 0.55));
  for (let x0 = 0; x0 < W; x0 += 256) {
    const x1 = Math.min(W, x0 + 256);
    cStroke(ctx, [{ x: x0 - 2, y: plasterTop }, { x: (x0 + x1) / 2, y: plasterTop + (r() - 0.5) * 1.5 }, { x: x1 + 2, y: plasterTop }], rgba(C.ink, 0.32), { width: 5, taperStart: 0, taperEnd: 0, jitter: 0.15 }, r, 2);
    cDry(ctx, [{ x: x0, y: wallTop }, { x: x1, y: wallTop }], rgba(C.ink, 0.18), 2.4, r, 2);
  }
  for (let tx = 4; tx < W; tx += 8) cStroke(ctx, [{ x: tx, y: plasterTop + 2 }, { x: tx, y: plasterTop + 5 }], rgba(C.ink, 0.16), { width: 1.2, taperStart: 0, taperEnd: 0.4 }, r);
  let n = 0;
  for (let mx = 20; mx < W - 10; mx += 40, n++) {
    const my = (wallTop + plasterTop) / 2 + 1;
    const q = 3.2;
    const st = rgba(C.ink, 0.24);
    if (n % 2 === 0) cFill(ctx, [{ x: mx - q, y: my + q }, { x: mx + q, y: my + q }, { x: mx, y: my - q }], st);
    else cFill(ctx, [{ x: mx - q, y: my - q }, { x: mx + q, y: my - q }, { x: mx + q, y: my + q }, { x: mx - q, y: my + q }], st);
  }
  // Tourelles (yagura) sur l'enceinte.
  for (let tx = 260; tx < W - 60; tx += 520 + r() * 200) {
    const seed = Math.floor(tx * 5 + 2);
    for (const ox of [0, W, -W]) {
      if (tx + ox < -80 || tx + ox > W + 80) continue;
      drawYagura(ctx, tx + ox, plasterTop, seeded(seed));
    }
  }
  nearMist(ctx, h);
  tex.refresh();
  return key;
}

function drawYagura(ctx: CanvasRenderingContext2D, x: number, y: number, r: Rand): void {
  const w = 24 + r() * 8;
  const hgt = 34 + r() * 8;
  cFill(ctx, [{ x: x - w, y }, { x: x + w, y }, { x: x + w, y: y - hgt }, { x: x - w, y: y - hgt }], rgba(C.paper, 0.6));
  for (const sx of [-1, 1]) cStroke(ctx, [{ x: x + sx * w, y }, { x: x + sx * w, y: y - hgt }], rgba(C.ink, 0.22), { width: 2, taperStart: 0, taperEnd: 0 }, r);
  cFill(ctx, [{ x: x - 8, y: y - hgt * 0.35 }, { x: x + 8, y: y - hgt * 0.35 }, { x: x + 8, y: y - hgt * 0.65 }, { x: x - 8, y: y - hgt * 0.65 }], rgba(C.ink, 0.22));
  const ry = y - hgt;
  cStroke(ctx, [{ x: x - w - 14, y: ry - 6 }, { x: x - w, y: ry }, { x: x + w, y: ry }, { x: x + w + 14, y: ry - 6 }], rgba(C.ink, 0.36), { width: 5, taperStart: 0.12, taperEnd: 0.12 }, r, 3);
  cStroke(ctx, [{ x: x - w * 0.5 - 6, y: ry - 14 }, { x, y: ry - 17 }, { x: x + w * 0.5 + 6, y: ry - 14 }], rgba(C.ink, 0.36), { width: 4, taperStart: 0.15, taperEnd: 0.15 }, r, 3);
  cFill(ctx, [{ x: x - w * 0.6, y: ry - 2 }, { x: x + w * 0.6, y: ry - 2 }, { x: x + w * 0.45, y: ry - 14 }, { x: x - w * 0.45, y: ry - 14 }], rgba(C.ink, 0.12));
}

/** Génère (une seule fois) la couche proche d'un biome. */
function makeNearLayer(scene: Phaser.Scene, key: string, kind: NearKind, h: number): string {
  switch (kind) {
    case 'bamboo': return makeBambooLayer(scene, key, h);
    case 'roofs': return makeRoofLayer(scene, key, h);
    case 'snowPines': return makeSnowPineLayer(scene, key, h);
    case 'ramparts': return makeRampartLayer(scene, key, h);
  }
}

const FAR_H = 460;
const MID_H = 460;
const NEAR_H = 620;

/** Génère paresseusement les trois couches d'un biome ; les textures déjà créées sont réutilisées. */
function ensureLayers(scene: Phaser.Scene, look: BiomeLook): BiomeLook['keys'] {
  const k = look.keys;
  if (!scene.textures.exists(k.far)) makeMountains(scene, k.far, { ...look.far, h: FAR_H });
  if (!scene.textures.exists(k.mid)) makeMountains(scene, k.mid, { ...look.mid, h: MID_H });
  if (!scene.textures.exists(k.near)) makeNearLayer(scene, k.near, look.near, NEAR_H);
  return k;
}


interface ParallaxLayer {
  spr: Phaser.GameObjects.TileSprite;
  f: number;
  baseY: number;
}

/** Fond multi-couches rendu par une caméra dédiée (sans zoom). */
export class Backdrop {
  private layers: ParallaxLayer[] = [];
  private paper: Phaser.GameObjects.Image;
  private sun: Phaser.GameObjects.Image;
  private sunBase: Pt;
  private biome: BiomeId = 'bamboo';

  constructor(private scene: Phaser.Scene, put: Put) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    this.paper = put(scene.add.image(0, 0, makePaper(scene, 'paper', W, H)).setOrigin(0), 'bg');

    // Forêt de bambous au départ : mêmes textures et paramètres qu'auparavant.
    const look = BIOME_LOOK.bamboo;
    this.sunBase = { x: W * look.orbPos.x, y: H * look.orbPos.y };
    this.sun = put(scene.add.image(this.sunBase.x, this.sunBase.y, ensureOrb(scene, look.orb)), 'bg');

    const keys = ensureLayers(scene, look);
    const add = (key: string, y: number, h: number, f: number) => {
      const spr = put(scene.add.tileSprite(0, y, W, h, key).setOrigin(0, 0), 'bg');
      this.layers.push({ spr, f, baseY: y });
    };
    add(keys.far, 60, FAR_H, 0.08);
    add(keys.mid, 150, MID_H, 0.2);
    add(keys.near, 120, NEAR_H, 0.42);
  }

  /** Change le paysage de fond (textures générées au premier passage dans le biome). */
  setBiome(id: BiomeId): void {
    if (id === this.biome) return;
    this.biome = id;
    const look = BIOME_LOOK[id];
    const keys = ensureLayers(this.scene, look);
    const [far, mid, near] = this.layers;
    far.spr.setTexture(keys.far);
    mid.spr.setTexture(keys.mid);
    near.spr.setTexture(keys.near);
    this.sun.setTexture(ensureOrb(this.scene, look.orb));
    this.sunBase = { x: this.scene.scale.width * look.orbPos.x, y: this.scene.scale.height * look.orbPos.y };
    this.sun.setPosition(this.sunBase.x, this.sunBase.y);
    // Teinte multiplicative commune au papier et aux couches (la brume reste raccord).
    for (const obj of [this.paper, far.spr, mid.spr, near.spr]) {
      if (look.paperTint === 0xffffff) obj.clearTint();
      else obj.setTint(look.paperTint);
    }
  }

  get currentBiome(): BiomeId {
    return this.biome;
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
