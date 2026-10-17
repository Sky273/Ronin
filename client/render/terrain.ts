import Phaser from 'phaser';
import { DUEL, TILE } from '../../shared/constants';
import type { BiomeId } from '../../shared/biomes';
import { DOJO_FINAL_X, DOJO_TATAMIS } from '../../shared/dojoLevel';
import { type Deco, type Level, T_ONEWAY, T_SOLID, tileAt } from '../../shared/level';
import { cBlob, cDry, cFill, cStroke, hash2, type Pt, type Rand, ringPoints, seeded } from './brush';
import { C, rgba } from './palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;
type Ctx = CanvasRenderingContext2D;

const CHUNK = 2048;
const INK = (a: number) => rgba(C.ink, a);
/** Paille des tatamis (jonc igusa séché) et sa trame, propres au dojo. */
const IGUSA = 0xa59c5e;
const IGUSA_DARK = 0x5d5a2e;

/** Rectangle en pixels de la tranche, bornes entières, x1 et y1 exclus. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Chunk {
  key: string;
  x: number;
  w: number;
  tex: Phaser.Textures.CanvasTexture;
  ctx: Ctx;
  /** Zone salie par les taches depuis le dernier envoi au GPU (null : à jour). */
  dirty: Rect | null;
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/**
 * Le terrain est peint une fois dans des canvas (par tranches de 2048 px),
 * puis sert de « toile » : les éclaboussures d'encre s'y accumulent.
 */
export class Terrain {
  private chunks: Chunk[] = [];
  private images: Phaser.GameObjects.Image[] = [];
  /** Génération des tranches : chaque reconstruction utilise des clés neuves. */
  private gen = 0;
  private builtW = 0;
  private builtH = 0;
  /** Canvas de transit des envois partiels (créé au premier besoin). */
  private scratch: { canvas: HTMLCanvasElement; ctx: Ctx } | null = null;

  constructor(private scene: Phaser.Scene, private level: Level, private put: Put) {
    this.build();
  }

  /** Crée les tranches (CanvasTexture + image) couvrant toute la largeur du niveau. */
  private build(): void {
    const { scene, level } = this;
    for (let x = 0, i = 0; x < level.pxW; x += CHUNK, i++) {
      const w = Math.min(CHUNK, level.pxW - x);
      // La première génération garde les clés historiques `terrain${i}`.
      const key = this.gen === 0 ? `terrain${i}` : `terrain${this.gen}_${i}`;
      const tex = scene.textures.createCanvas(key, w, level.pxH)!;
      const ctx = tex.context;
      const chunk: Chunk = { key, x, w, tex, ctx, dirty: null };
      this.paintChunk(chunk);
      this.images.push(this.put(scene.add.image(x, 0, key).setOrigin(0).setDepth(2), 'world'));
      this.chunks.push(chunk);
    }
    this.builtW = level.pxW;
    this.builtH = level.pxH;
  }

  /** Détruit les images et retire les textures des tranches actuelles. */
  private destroyChunks(): void {
    for (const img of this.images) img.destroy();
    for (const c of this.chunks) this.scene.textures.remove(c.key);
    this.images = [];
    this.chunks = [];
  }

  private paintChunk(c: Chunk): void {
    c.ctx.clearRect(0, 0, c.w, this.level.pxH);
    c.ctx.save();
    c.ctx.translate(-c.x, 0);
    paintTerrain(c.ctx, this.level, c.x - 160, c.x + c.w + 160);
    c.ctx.restore();
    c.tex.refresh();
    c.dirty = null;
  }

  /**
   * Repeint la toile (nouvelle étape) : les taches d'encre accumulées disparaissent.
   * Un nouveau niveau peut être fourni ; si sa taille change, les tranches sont recréées.
   */
  repaint(level?: Level): void {
    if (level) this.level = level;
    if (this.level.pxW !== this.builtW || this.level.pxH !== this.builtH) {
      this.destroyChunks();
      this.gen++;
      this.build();
      return;
    }
    for (const c of this.chunks) this.paintChunk(c);
  }

  /** Libère toutes les tranches (fin de scène). */
  destroy(): void {
    this.destroyChunks();
  }

  /** Tache d'encre écrasée au sol. */
  stain(x: number, y: number, r: number, dir: number, color: number, seed: number): void {
    // Emprise de drawSplat : gouttes satellites jusqu'à ~5,6 r dans le sens du coup, le tout
    // aplati (× 0,42), trait à ±(1,5 + 0,2 r) en hauteur ; marge pour l'anticrénelage.
    const ex = r * 6 * Math.max(1, Math.abs(dir)) + 3;
    const ey = r * 0.8 + 4;
    for (const c of this.chunks) {
      if (x + r * 5 < c.x || x - r * 5 > c.x + c.w) continue;
      c.ctx.save();
      c.ctx.translate(-c.x, 0);
      drawSplat(c.ctx, x, y, r, dir, color, seeded(seed));
      c.ctx.restore();
      this.soil(c, x - c.x - ex, y - ey, x - c.x + ex, y + ey);
    }
  }

  /** Étend la zone salie de la tranche au rectangle donné (arrondi au pixel, rogné à la tranche). */
  private soil(c: Chunk, x0: number, y0: number, x1: number, y1: number): void {
    const r: Rect = {
      x0: Math.max(0, Math.floor(x0)),
      y0: Math.max(0, Math.floor(y0)),
      x1: Math.min(c.w, Math.ceil(x1)),
      y1: Math.min(this.builtH, Math.ceil(y1)),
    };
    if (r.x0 >= r.x1 || r.y0 >= r.y1) return;
    const d = c.dirty;
    if (!d) {
      c.dirty = r;
      return;
    }
    d.x0 = Math.min(d.x0, r.x0);
    d.y0 = Math.min(d.y0, r.y0);
    d.x1 = Math.max(d.x1, r.x1);
    d.y1 = Math.max(d.y1, r.y1);
  }

  /** Envoie au GPU ce que les taches ont changé depuis la dernière image. */
  flush(): void {
    for (const c of this.chunks) {
      if (!c.dirty) continue;
      if (!this.upload(c, c.dirty)) c.tex.refresh();
      c.dirty = null;
    }
  }

  /**
   * WebGL : n'envoie que le rectangle sali, là où refresh() renverrait tout le canvas de la
   * tranche (2048 × 768, 6 Mo). Le rectangle est recopié tel quel (pixels prémultipliés,
   * opérateur « copy ») dans un petit canvas de transit, téléversé par texSubImage2D avec les
   * réglages de Phaser 3.90 (WebGLTextureWrapper._processTexture) : la texture obtenue est celle
   * qu'aurait donnée refresh(). Faux si l'envoi partiel est impossible ou sans intérêt (rendu
   * Canvas, contexte perdu, rectangle presque aussi grand que la tranche) : refresh() s'en charge.
   */
  private upload(c: Chunk, d: Rect): boolean {
    const renderer = this.scene.renderer;
    const gl = 'gl' in renderer ? renderer.gl : null;
    const glt = c.tex.source[0]?.glTexture;
    if (!gl || !glt?.webGLTexture || glt.flipY || gl.isContextLost()) return false;
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    if (w * h > (c.w * this.builtH) / 2) return false;
    const s = this.scratch ?? (this.scratch = makeScratch());
    if (!s) return false;
    if (s.canvas.width !== w || s.canvas.height !== h) {
      s.canvas.width = w;
      s.canvas.height = h;
    }
    s.ctx.globalCompositeOperation = 'copy';
    s.ctx.drawImage(c.tex.canvas, d.x0, d.y0, w, h, 0, 0, w, h);
    // Même séquence que Phaser : unité 0, puis la texture qui y était liée est rétablie
    // (les pipelines gardent en cache la texture liée à chaque unité).
    gl.activeTexture(gl.TEXTURE0);
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, glt.webGLTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, glt.pma);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, glt.mipLevel, d.x0, d.y0, glt.format, gl.UNSIGNED_BYTE, s.canvas);
    if (isPow2(c.w) && isPow2(this.builtH)) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, prev);
    return true;
  }

  get lvl(): Level {
    return this.level;
  }
}

/** Canvas de transit, en lecture fréquente comme les CanvasTexture de Phaser (même chemin d'envoi). */
function makeScratch(): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx ? { canvas, ctx } : null;
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

/** Teinte du terrain par biome (la forêt de bambous garde le rendu historique). */
interface TerrainLook {
  /** Couleur du lavis des masses de terre. */
  wash: number;
  /** Arrêts du dégradé vertical (surface, milieu, profondeur). */
  stops: [number, number, number];
  grass: boolean;
  soot: boolean;
  snow: boolean;
  joints: boolean;
  /** Dojo : plancher de lames de bois, murs de bois, ni herbe ni mousse. */
  boards: boolean;
}

const TERRAIN_LOOK: Record<BiomeId, TerrainLook> = {
  bamboo: { wash: C.ink, stops: [0.24, 0.11, 0.025], grass: true, soot: false, snow: false, joints: false, boards: false },
  village: { wash: C.inkWarm, stops: [0.26, 0.13, 0.035], grass: true, soot: true, snow: false, joints: false, boards: false },
  snow: { wash: C.inkCold, stops: [0.2, 0.085, 0.02], grass: false, soot: false, snow: true, joints: false, boards: false },
  castle: { wash: C.stone, stops: [0.27, 0.17, 0.07], grass: false, soot: false, snow: false, joints: true, boards: false },
  dojo: { wash: C.wood, stops: [0.32, 0.2, 0.1], grass: false, soot: false, snow: false, joints: false, boards: true },
};

function lookOf(l: Level): TerrainLook {
  return TERRAIN_LOOK[l.biome] ?? TERRAIN_LOOK.bamboo;
}

function paintTerrain(ctx: Ctx, l: Level, x0: number, x1: number): void {
  const solid = (tx: number, ty: number) => tileAt(l, tx, ty) === T_SOLID;
  const inRange = (px0: number, px1: number) => px1 >= x0 && px0 <= x1;
  const look = lookOf(l);
  const WASH = (a: number) => rgba(look.wash, a);

  // 1. Décors (derrière le trait de sol)
  l.decos.forEach((d, i) => {
    if (inRange(d.x - 220, d.x + 220)) drawDeco(ctx, d, seeded(hash2(i, 991)), l.biome);
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
      grad.addColorStop(0, WASH(look.stops[0]));
      grad.addColorStop(0.35, WASH(look.stops[1]));
      grad.addColorStop(1, WASH(look.stops[2]));
      ctx.fillStyle = grad;
      ctx.fillRect(tx * TILE, y0, TILE + 0.5, y1 - y0);
    }
    let depth = 0;
    for (let ty = 0; ty < l.h; ty++) {
      if (!solid(tx, ty)) continue;
      depth = ty > 0 && solid(tx, ty - 1) ? depth + 1 : 0;
      const r = seeded(hash2(tx * 131 + 7, ty));
      if (depth <= 2 && !look.boards) {
        for (let k = 0; k < 2; k++) {
          const bx = tx * TILE + r() * TILE;
          const by = ty * TILE + r() * TILE;
          const rad = 10 + r() * 20;
          const rg = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
          rg.addColorStop(0, WASH(0.05 + r() * 0.05));
          rg.addColorStop(1, WASH(0));
          ctx.fillStyle = rg;
          ctx.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
        }
      }
      if (depth <= 1 && !look.boards) {
        for (let k = 0; k < 3; k++) {
          const hx = tx * TILE + r() * TILE;
          const hy = ty * TILE + 6 + r() * (TILE - 8);
          cStroke(ctx, [{ x: hx, y: hy }, { x: hx + 5 + r() * 6, y: hy + 4 + r() * 5 }], WASH(0.14), { width: 1.2, taperEnd: 0.6 }, r);
        }
      }
      // Générateurs à part : le tirage du rendu historique reste inchangé.
      if (look.soot && depth <= 1) soot(ctx, tx, ty, depth, seeded(hash2(tx * 59 + 13, ty + 4099)));
      if (look.joints && (depth <= 3 || !solid(tx - 1, ty) || !solid(tx + 1, ty))) joints(ctx, tx, ty, depth, seeded(hash2(tx * 37 + 3, ty + 8191)));
      // Dojo : les tuiles qui bordent la salle sont des murs de bois (fil vertical continu par colonne).
      if (look.boards && [-2, -1, 1, 2].some((d) => !solid(tx + d, ty))) woodWall(ctx, tx, ty, seeded(hash2(tx * 43 + 5, ty + 12011)));
    }
  }

  // 2 bis. Dojo : lames du plancher sous chaque surface, puis tatamis aux places des duels.
  if (look.boards) {
    for (let ty = 0; ty < l.h; ty++) {
      let run = -1;
      for (let tx = 0; tx <= l.w; tx++) {
        const exposed = tx < l.w && solid(tx, ty) && !solid(tx, ty - 1);
        if (exposed && run < 0) run = tx;
        if (!exposed && run >= 0) {
          if (tx - run >= 4 && inRange(run * TILE, tx * TILE)) floorBoards(ctx, l, run, tx - 1, ty, x0, x1);
          run = -1;
        }
      }
    }
  }
  if (l.biome === 'dojo') dojoTatamis(ctx, l, inRange);

  // 3. Contours : surfaces supérieures (trait principal + herbes)
  for (let ty = 0; ty < l.h; ty++) {
    let run = -1;
    for (let tx = 0; tx <= l.w; tx++) {
      const exposed = tx < l.w && solid(tx, ty) && !solid(tx, ty - 1);
      if (exposed && run < 0) run = tx;
      if (!exposed && run >= 0) {
        if (inRange(run * TILE, tx * TILE)) topRun(ctx, run, tx - 1, ty, seeded(hash2(run * 7 + 1, ty)), look);
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
        if (inRange(run * TILE, tx * TILE)) plank(ctx, run, tx - 1, ty, seeded(hash2(run * 11 + 5, ty)), look.snow);
        run = -1;
      }
    }
  }
}

function topRun(ctx: Ctx, a: number, b: number, ty: number, r: Rand, look: TerrainLook): void {
  const y = ty * TILE + 1;
  const pts: Pt[] = [];
  for (let x = a * TILE - 2; x <= (b + 1) * TILE + 2; x += 10) pts.push({ x, y: y + (r() - 0.5) * 2.4 });
  if (pts.length < 2) pts.push({ x: (b + 1) * TILE + 2, y });
  cStroke(ctx, pts, INK(0.92), { width: 6.5, taperStart: 0.03, taperEnd: 0.05, jitter: 0.22 }, r, 2);
  cDry(ctx, pts.map((p) => ({ x: p.x, y: p.y + 4.5 })), INK(0.35), 3, r, 3);
  if (look.snow) return snowCap(ctx, pts, 1, seeded(hash2(a * 17 + 9, ty + 3001)));
  if (look.boards) return; // plancher ciré : rien ne pousse
  if (!look.grass) return mossRun(ctx, a, b, y, seeded(hash2(a * 23 + 1, ty + 5003)));
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

function plank(ctx: Ctx, a: number, b: number, ty: number, r: Rand, snowy: boolean): void {
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
  if (snowy) {
    const pts: Pt[] = [];
    for (let x = xa + 1; x <= xb - 1; x += 9) pts.push({ x, y: y - 1 + (1 - (((x - mid) / (xb - xa)) * 2) ** 2) * 1.5 });
    if (pts.length >= 2) snowCap(ctx, pts, 0.6, seeded(hash2(a * 29 + 7, ty + 6007)));
  }
}

/**
 * Liseré de neige : épais lavis de papier clair posé sur le trait de surface,
 * congères irrégulières, fine ombre froide dessous et contour d'encre très léger.
 */
function snowCap(ctx: Ctx, pts: Pt[], k: number, r: Rand): void {
  if (pts.length < 2) return;
  const up = pts.map((p) => ({ x: p.x, y: p.y - 2.5 * k - r() * 1.6 * k }));
  cStroke(ctx, pts.map((p) => ({ x: p.x, y: p.y + 2 })), rgba(C.snowShade, 0.32), { width: 5 * k, taperStart: 0.04, taperEnd: 0.04, jitter: 0.3 }, r, 2);
  cStroke(ctx, up, rgba(C.snow, 0.96), { width: 8.5 * k, taperStart: 0.03, taperEnd: 0.03, jitter: 0.18 }, r, 2);
  // Congères : bosses arrondies çà et là.
  const x0 = pts[0].x;
  const x1 = pts[pts.length - 1].x;
  for (let x = x0 + 8; x < x1 - 8; x += 18 + r() * 40) {
    if (r() < 0.45) continue;
    const w = (8 + r() * 16) * k;
    const yy = up[Math.min(up.length - 1, Math.max(0, Math.round(((x - x0) / (x1 - x0)) * (up.length - 1))))].y;
    ctx.save();
    ctx.translate(x, yy - 1);
    ctx.scale(1, 0.32);
    cBlob(ctx, 0, 0, w, rgba(C.snow, 0.94), r, 0.15);
    ctx.restore();
  }
  // Contour supérieur de la neige, à peine posé.
  cDry(ctx, up.map((p) => ({ x: p.x, y: p.y - 3.8 * k })), rgba(C.inkCold, 0.3), 1.6 * k, r, 2);
}

/** Château : quelques touffes de mousse rases au lieu des herbes. */
function mossRun(ctx: Ctx, a: number, b: number, y: number, r: Rand): void {
  for (let x = a * TILE + 6; x < (b + 1) * TILE - 6; x += 14 + r() * 30) {
    if (r() > 0.3) continue;
    for (let k = 0; k < 3; k++) {
      const bx = x + (r() - 0.5) * 6;
      cStroke(ctx, [{ x: bx, y: y - 1 }, { x: bx + (r() - 0.5) * 4, y: y - 3 - r() * 3 }], INK(0.6), { width: 1.5, taperStart: 0, taperEnd: 0.9 }, r);
    }
  }
}

/** Village : taches de suie et rares braises dans la terre de surface. */
function soot(ctx: Ctx, tx: number, ty: number, depth: number, r: Rand): void {
  if (r() < 0.55) return;
  const bx = tx * TILE + r() * TILE;
  const by = ty * TILE + 6 + r() * (TILE - 6);
  const rad = 6 + r() * 14;
  ctx.save();
  ctx.translate(bx, by);
  ctx.scale(1, 0.55);
  cBlob(ctx, 0, 0, rad, rgba(C.soot, 0.13 - depth * 0.04), r, 0.35);
  ctx.restore();
  if (depth === 0 && r() < 0.18) cBlob(ctx, bx + (r() - 0.5) * 8, ty * TILE + 4 + r() * 6, 1.2 + r() * 1.2, rgba(C.ember, 0.7), r, 0.2);
}

/** Château : joints de blocs de pierre en quinconce, qui s'estompent en profondeur. */
function joints(ctx: Ctx, tx: number, ty: number, depth: number, r: Rand): void {
  const a = Math.max(0.08, 0.3 - Math.min(depth, 4) * 0.05);
  const y = ty * TILE;
  const x = tx * TILE;
  // Rangée horizontale (pas sur la surface : le trait de sol y est déjà).
  if (depth > 0) cStroke(ctx, [{ x: x - 1, y: y + (r() - 0.5) * 1.5 }, { x: x + TILE + 1, y: y + (r() - 0.5) * 1.5 }], rgba(C.stone, a), { width: 1.6, taperStart: 0.15, taperEnd: 0.15, jitter: 0.35 }, r);
  // Joint vertical décalé d'une demi-tuile une rangée sur deux.
  const jx = x + (ty % 2 === 0 ? 4 : TILE / 2 + 4) + (r() - 0.5) * 4;
  cStroke(ctx, [{ x: jx, y: y + 3 }, { x: jx + (r() - 0.5) * 2, y: y + TILE - 3 }], rgba(C.stone, a * 0.9), { width: 1.4, taperStart: 0.2, taperEnd: 0.2, jitter: 0.3 }, r);
  // Éclat de lavis sur certains blocs.
  if (r() < 0.25) cDry(ctx, [{ x: x + 6, y: y + TILE * 0.6 }, { x: x + TILE - 8, y: y + TILE * 0.55 }], rgba(C.stone, a * 0.5), 3, r, 2);
}

/** Dojo : mur de bois, veines verticales tirées par colonne pour qu'elles se suivent d'une tuile à l'autre. */
function woodWall(ctx: Ctx, tx: number, ty: number, r: Rand): void {
  const x = tx * TILE;
  const y = ty * TILE;
  // Fond de papier presque opaque : le mur de bout cache le fond (piliers, shōji) qu'il borde.
  const tile = [{ x, y }, { x: x + TILE + 0.5, y }, { x: x + TILE + 0.5, y: y + TILE + 0.5 }, { x, y: y + TILE + 0.5 }];
  cFill(ctx, tile, rgba(C.paper, 0.82));
  cFill(ctx, tile, rgba(C.wood, 0.52));
  const rc = seeded(hash2(tx * 43 + 5, 12011));
  for (let k = 0; k < 3; k++) {
    const gx = x + 4 + rc() * (TILE - 8);
    const a = 0.12 + rc() * 0.12;
    cStroke(ctx, [{ x: gx, y: y - 1 }, { x: gx + (r() - 0.5) * 1.5, y: y + TILE + 1 }], rgba(C.wood, a), { width: 1.3, taperStart: 0, taperEnd: 0, jitter: 0.3 }, r);
  }
  if (r() < 0.06) cBlob(ctx, x + 6 + r() * (TILE - 12), y + 8 + r() * (TILE - 16), 2.2, rgba(C.wood, 0.4), r, 0.3);
}

/** Joints des lames du plancher (px sous la surface), de plus en plus espacés vers le premier plan. */
const BOARD_OFF = [10, 22, 36, 53, 73, 97, 126, 160];

/**
 * Dojo : plancher de lames vu en fuyant. Lignes de joints sous la surface, aboutements décalés
 * d'une rangée à l'autre, veine sèche. Chaque segment a son propre tirage : la peinture d'une
 * tranche ne dépend pas de ce que voient ses voisines.
 */
function floorBoards(ctx: Ctx, l: Level, a: number, b: number, ty: number, x0: number, x1: number): void {
  const top = ty * TILE;
  const xa = a * TILE;
  const xb = (b + 1) * TILE;
  // Profondeur de la masse sous la surface (au milieu de la course).
  const mx = Math.floor((a + b) / 2);
  let end = ty;
  while (end + 1 < l.h && tileAt(l, mx, end + 1) === T_SOLID) end++;
  const bottom = (end + 1) * TILE - 4;
  const SEG = 128;
  BOARD_OFF.forEach((o, k) => {
    const y = top + o;
    if (y >= bottom) return;
    const alpha = 0.3 - k * 0.026;
    for (let sx = xa, i = 0; sx < xb; sx += SEG, i++) {
      const ex = Math.min(xb, sx + SEG);
      if (ex < x0 || sx > x1) continue;
      const r = seeded(hash2(i * 31 + k + a * 1009, ty * 7 + 14009));
      cDry(ctx, [{ x: sx - 1, y: y + (r() - 0.5) * 0.8 }, { x: ex + 1, y: y + (r() - 0.5) * 0.8 }], rgba(C.wood, alpha), 1.8, r, 2);
      // Veine du bois, à peine posée, dans la rangée au-dessus du joint.
      if (r() < 0.6) {
        const gy = top + (k ? BOARD_OFF[k - 1] : 4) + (o - (k ? BOARD_OFF[k - 1] : 4)) * (0.3 + r() * 0.4);
        const gx = sx + r() * SEG * 0.5;
        cDry(ctx, [{ x: gx, y: gy }, { x: Math.min(ex, gx + 30 + r() * 60), y: gy + (r() - 0.5) * 1.2 }], rgba(C.wood, alpha * 0.4), 1.4, r, 2);
      }
    }
    // Aboutements des lames dans la rangée au-dessus du joint (la première est sous le trait de sol).
    if (k === 0) return;
    const yTop = top + BOARD_OFF[k - 1];
    const len = 84 + k * 24;
    const off = seeded(hash2(k, ty * 13 + 14011 + a))() * len;
    for (let jx = xa + off, j = 0; jx < xb - 6; jx += len, j++) {
      if (jx < x0 - 4 || jx > x1 + 4) continue;
      const r = seeded(hash2(j * 17 + k + a * 1013, ty + 14017));
      const x = jx + (r() - 0.5) * 10;
      cStroke(ctx, [{ x, y: yTop + 1.5 }, { x: x + (r() - 0.5) * 1.5, y: y - 1.5 }], rgba(C.wood, alpha * 0.85), { width: 1.4, taperStart: 0.15, taperEnd: 0.15, jitter: 0.2 }, r);
    }
  });
}

/** Demi-longueur d'un tatami (marges de 18 px au-delà des marques de duel). */
const TATAMI_HW = DUEL.GAP / 2 + 18;
/** Élargissement du bord avant du tatami (perspective du plancher). */
const TATAMI_SPREAD = 8;

/** Dojo : tatamis tracés sur le plancher aux places des duels, marques des deux duellistes, centre de la finale. */
function dojoTatamis(ctx: Ctx, l: Level, inRange: (px0: number, px1: number) => boolean): void {
  const half = DUEL.GAP / 2;
  // Surface sous une abscisse : première tuile pleine de la colonne.
  const ground = (x: number) => {
    const tx = Math.floor(x / TILE);
    for (let ty = 0; ty < l.h; ty++) if (tileAt(l, tx, ty) === T_SOLID) return ty * TILE;
    return l.pxH;
  };
  // Biais d'une marque : parallèle à la trame du tatami le plus proche.
  const slant = (x: number) => {
    const c = DOJO_TATAMIS.reduce((best, t) => (Math.abs(t - x) < Math.abs(best - x) ? t : best), DOJO_TATAMIS[0]);
    return ((x - c) / TATAMI_HW) * TATAMI_SPREAD;
  };
  DOJO_TATAMIS.forEach((cx, i) => {
    if (!inRange(cx - TATAMI_HW - 20, cx + TATAMI_HW + 20)) return;
    const y = ground(cx);
    tatami(ctx, cx, y, seeded(hash2(i, 15013)));
    for (const sx of [-1, 1]) duelMark(ctx, cx + sx * half, y, slant(cx + sx * half), INK(0.82), seeded(hash2(i * 2 + (sx > 0 ? 1 : 0), 15017)));
  });
  // Finale, au milieu de la salle : ensō vermillon entre les deux tatamis du centre, marques vermillon.
  const fx = DOJO_FINAL_X;
  if (!inRange(fx - half - 20, fx + half + 20)) return;
  const fy = ground(fx);
  const rf = seeded(15031);
  ctx.save();
  ctx.translate(fx, fy + 18);
  ctx.scale(1, 0.3);
  cBlob(ctx, 0, 0, 25, rgba(C.paper, 0.55), rf, 0.08); // papier ravivé : les joints du plancher s'effacent
  cStroke(ctx, ringPoints(0, 0, 20, -Math.PI * 0.42, Math.PI * 1.42, 22), rgba(C.red, 0.78), { width: 6, taperStart: 0.25, taperEnd: 0.5, jitter: 0.2 }, rf, 2);
  ctx.restore();
  for (const sx of [-1, 1]) duelMark(ctx, fx + sx * half, ground(fx + sx * half), slant(fx + sx * half), rgba(C.red, 0.85), seeded(hash2(sx > 0 ? 1 : 0, 15037)));
}

/** Tatami posé sur le plancher, vu en fuyant : natte claire, trame d'igusa, liserés (heri) sombres. */
function tatami(ctx: Ctx, cx: number, y: number, r: Rand): void {
  const hw = TATAMI_HW;
  const sp = TATAMI_SPREAD;
  const y0 = y + 6;
  const y1 = y + 30;
  const quad = [{ x: cx - hw, y: y0 }, { x: cx + hw, y: y0 }, { x: cx + hw + sp, y: y1 }, { x: cx - hw - sp, y: y1 }];
  // Le papier ravivé efface les lames sous la natte, puis le lavis paille de l'igusa.
  cFill(ctx, quad, rgba(C.paper, 0.6));
  cFill(ctx, quad, rgba(IGUSA, 0.3));
  for (let x = -hw + 5; x < hw - 4; x += 5.5) {
    const t = x / hw;
    cStroke(ctx, [{ x: cx + x, y: y0 + 3 }, { x: cx + x + t * sp, y: y1 - 3 }], rgba(IGUSA_DARK, 0.16 + r() * 0.1), { width: 0.9, taperStart: 0.1, taperEnd: 0.1, jitter: 0.2 }, r);
  }
  cStroke(ctx, [{ x: cx - hw, y: y0 + 1 }, { x: cx + hw, y: y0 + 1 }], rgba(C.inkSoft, 0.72), { width: 3.2, taperStart: 0.02, taperEnd: 0.02, jitter: 0.12 }, r);
  cStroke(ctx, [{ x: cx - hw - sp, y: y1 - 1.5 }, { x: cx + hw + sp, y: y1 - 1.5 }], rgba(C.inkSoft, 0.8), { width: 4.4, taperStart: 0.02, taperEnd: 0.02, jitter: 0.12 }, r);
  // Bouts courts à peine marqués : les marques des duellistes, plus appuyées, ne s'y confondent pas.
  for (const sx of [-1, 1]) cStroke(ctx, [{ x: cx + sx * hw, y: y0 }, { x: cx + sx * (hw + sp), y: y1 }], INK(0.3), { width: 1.5, taperStart: 0.05, taperEnd: 0.05 }, r);
}

/** Marque d'un duelliste sur le tatami : trait court appuyé, en biais avec la trame. */
function duelMark(ctx: Ctx, x: number, y: number, slant: number, style: string, r: Rand): void {
  const y0 = y + 9;
  const y1 = y + 27;
  cStroke(ctx, [{ x: x - slant * 0.1, y: y0 }, { x: x + slant * 0.5, y: (y0 + y1) / 2 }, { x: x + slant, y: y1 }], style, { width: 4, taperStart: 0.08, taperEnd: 0.55, jitter: 0.15 }, r, 2);
  cBlob(ctx, x - slant * 0.1, y0 + 1, 2.4, style, r, 0.25);
}

// ─── Décors ────────────────────────────────────────────────────────────────

function drawDeco(ctx: Ctx, d: Deco, r: Rand, biome: BiomeId): void {
  const snowy = biome === 'snow';
  switch (d.kind) {
    case 'torii': return torii(ctx, d.x, d.y, d.s, r);
    case 'lantern': return lantern(ctx, d.x, d.y, d.s, r);
    case 'bamboo': return bamboo(ctx, d.x, d.y, d.s, r);
    case 'pine': return pine(ctx, d.x, d.y, d.s, r, snowy);
    case 'stone': return stone(ctx, d.x, d.y, d.s, r, snowy);
    case 'banner': return banner(ctx, d.x, d.y, d.s, r);
    case 'shrine': return shrine(ctx, d.x, d.y, d.s, r);
    case 'sakura': return sakura(ctx, d.x, d.y, d.s, r);
    case 'house': return house(ctx, d.x, d.y, d.s, r, biome === 'village');
    case 'rampart': return rampart(ctx, d.x, d.y, d.s, r);
    case 'scroll': return hangingScroll(ctx, d.x, d.y, d.s, r);
    case 'rack': return swordRack(ctx, d.x, d.y, d.s, r);
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

function pine(ctx: Ctx, x: number, y: number, s: number, r: Rand, snowy = false): void {
  const trunk: Pt[] = [{ x, y }];
  let tx = x;
  for (let k = 1; k <= 5; k++) {
    tx += (r() - 0.5) * 16 * s;
    trunk.push({ x: tx, y: y - k * 26 * s });
  }
  cStroke(ctx, trunk, INK(0.85), { width: 1, widthFn: (t) => 10 * s * (1 - t * 0.7), taperStart: 0, taperEnd: 0.1, jitter: 0.15 }, r, 4);
  cDry(ctx, trunk.map((p) => ({ x: p.x + 2, y: p.y })), INK(0.4), 6 * s, r, 3);
  const pads: Pt[] = [];
  for (let k = 0; k < 5; k++) {
    const t = 0.4 + k * 0.14;
    const idx = Math.min(trunk.length - 1, Math.floor(t * (trunk.length - 1)));
    const base = trunk[idx];
    const side = k % 2 === 0 ? 1 : -1;
    const len = (34 + r() * 30) * s;
    const end = { x: base.x + side * len, y: base.y - 6 * s - r() * 10 * s };
    cStroke(ctx, [base, { x: (base.x + end.x) / 2, y: base.y + 2 }, end], INK(0.8), { width: 3.4 * s, taperStart: 0, taperEnd: 0.6 }, r, 3);
    pinePad(ctx, end.x, end.y, (26 + r() * 16) * s, r);
    pads.push(end);
  }
  pinePad(ctx, trunk[trunk.length - 1].x, trunk[trunk.length - 1].y, 30 * s, r);
  if (!snowy) return;
  // Neige posée sur les coussins d'aiguilles (tirage séparé).
  pads.push(trunk[trunk.length - 1]);
  const rs = seeded(hash2(Math.floor(x), 7717));
  for (const p of pads) {
    ctx.save();
    ctx.translate(p.x, p.y - 2);
    ctx.scale(1, 0.3);
    cBlob(ctx, 0, 0, (14 + rs() * 8) * s, rgba(C.snow, 0.92), rs, 0.2);
    ctx.restore();
    cDry(ctx, [{ x: p.x - 12 * s, y: p.y - 4 }, { x: p.x, y: p.y - 6 }, { x: p.x + 12 * s, y: p.y - 4 }], rgba(C.inkCold, 0.22), 1.4, rs, 2);
  }
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

function stone(ctx: Ctx, x: number, y: number, s: number, r: Rand, snowy = false): void {
  const w = (16 + r() * 10) * s;
  const h = (10 + r() * 6) * s;
  ctx.save();
  ctx.translate(x, y - h * 0.5);
  ctx.scale(1, h / w);
  cBlob(ctx, 0, 0, w, rgba(C.wash, 0.35), r, 0.12);
  ctx.restore();
  cStroke(ctx, ringPoints(x, y - h * 0.4, w, Math.PI * 1.05, Math.PI * 1.95, 10).map((p) => ({ x: p.x, y: y - h * 0.4 + (p.y - (y - h * 0.4)) * (h / w) })), INK(0.8), { width: 3, taperStart: 0.2, taperEnd: 0.4 }, r);
  if (!snowy) return;
  const rs = seeded(hash2(Math.floor(x), 7723));
  ctx.save();
  ctx.translate(x, y - h * 0.95);
  ctx.scale(1, 0.3);
  cBlob(ctx, 0, 0, w * 0.75, rgba(C.snow, 0.94), rs, 0.18);
  ctx.restore();
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


/** Maison japonaise : soubassement, murs au lavis, poteaux, shōji et toit courbe. En feu au village. */
function house(ctx: Ctx, x: number, y: number, s: number, r: Rand, burning: boolean): void {
  const W = (52 + r() * 14) * s;
  const wallH = (42 + r() * 10) * s;
  const top = y - 4 - wallH;
  const roofH = (30 + r() * 8) * s;
  const ridge = top - roofH;
  const lean = burning ? (r() - 0.5) * 8 * s : 0; // poutre faîtière affaissée par le feu

  // Colonne de fumée au lavis, derrière la maison.
  if (burning) {
    let sx = x + (r() - 0.5) * W * 0.6;
    let sy = ridge - 6 * s;
    const drift = (r() < 0.5 ? -1 : 1) * (0.4 + r() * 0.5);
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const rad = (12 + t * 30 + r() * 8) * s;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1, 0.8);
      cBlob(ctx, 0, 0, rad, rgba(i < 4 ? C.soot : C.wash, 0.09 - t * 0.05), r, 0.3);
      ctx.restore();
      sx += drift * (4 + t * 6) * s + (r() - 0.5) * 6 * s;
      sy -= (14 + r() * 6) * s;
    }
  }

  // Soubassement de pierre.
  cStroke(ctx, [{ x: x - W - 4 * s, y: y - 2 }, { x: x + W + 4 * s, y: y - 2 }], rgba(C.inkSoft, 0.8), { width: 6 * s, taperStart: 0.04, taperEnd: 0.04, jitter: 0.15 }, r);
  // Murs au lavis.
  cFill(ctx, [{ x: x - W, y: y - 4 }, { x: x + W, y: y - 4 }, { x: x + W, y: top }, { x: x - W, y: top }], rgba(C.wash, 0.24));
  cDry(ctx, [{ x: x - W + 4, y: top + wallH * 0.75 }, { x: x + W - 4, y: top + wallH * 0.72 }], rgba(C.wash, 0.25), 8 * s, r, 3);
  // Travées : shōji clairs entre les poteaux.
  const bays = 3;
  const bw = (2 * W) / bays;
  for (let b = 0; b < bays; b++) {
    const bx0 = x - W + b * bw + 4 * s;
    const bx1 = bx0 + bw - 8 * s;
    const by0 = top + wallH * 0.3;
    const by1 = y - 8 * s;
    if (burning && b === 1) {
      // Ouverture rougeoyante : le feu à l'intérieur.
      cFill(ctx, [{ x: bx0, y: by1 }, { x: bx1, y: by1 }, { x: bx1, y: by0 }, { x: bx0, y: by0 }], rgba(C.red, 0.3));
      cBlob(ctx, (bx0 + bx1) / 2, by1 - 6 * s, 7 * s, rgba(C.ember, 0.45), r, 0.3);
      continue;
    }
    cFill(ctx, [{ x: bx0, y: by1 }, { x: bx1, y: by1 }, { x: bx1, y: by0 }, { x: bx0, y: by0 }], rgba(C.paper, 0.55));
    for (let k = 1; k < 3; k++) {
      const lx = bx0 + ((bx1 - bx0) * k) / 3;
      cStroke(ctx, [{ x: lx, y: by0 }, { x: lx, y: by1 }], INK(0.32), { width: 1.1, taperStart: 0, taperEnd: 0 }, r);
    }
    const ly = (by0 + by1) / 2;
    cStroke(ctx, [{ x: bx0, y: ly }, { x: bx1, y: ly }], INK(0.32), { width: 1.1, taperStart: 0, taperEnd: 0 }, r);
  }
  // Poteaux et poutres.
  for (let b = 0; b <= bays; b++) {
    const px = x - W + b * bw;
    cStroke(ctx, [{ x: px, y: y - 3 }, { x: px + (r() - 0.5) * 1.5, y: top }], rgba(C.wood, 0.9), { width: 4.2 * s, taperStart: 0, taperEnd: 0.03, jitter: 0.1 }, r);
  }
  cStroke(ctx, [{ x: x - W - 3 * s, y: top + 2 }, { x: x + W + 3 * s, y: top + 2 }], rgba(C.wood, 0.9), { width: 4 * s, taperStart: 0.03, taperEnd: 0.03 }, r);
  cStroke(ctx, [{ x: x - W, y: top + wallH * 0.3 }, { x: x + W, y: top + wallH * 0.3 }], rgba(C.wood, 0.75), { width: 2.6 * s, taperStart: 0.03, taperEnd: 0.03 }, r);

  // Toit : masse au lavis, rangs de tuiles, avant-toit et faîte relevés.
  const eaveY = top - 2 * s;
  const ew = W + 22 * s;
  const rw = W * 0.55;
  cFill(ctx, [
    { x: x - ew, y: eaveY - 6 * s },
    { x: x - rw, y: ridge + lean },
    { x: x + rw, y: ridge - lean },
    { x: x + ew, y: eaveY - 6 * s },
    { x: x + W, y: eaveY + 1 },
    { x: x - W, y: eaveY + 1 },
  ], INK(0.42));
  for (let k = -5; k <= 5; k++) {
    const t = k / 5;
    cStroke(ctx, [{ x: x + t * rw, y: ridge + 3 * s - t * lean }, { x: x + t * (W + 12 * s), y: eaveY - 2 * s }], INK(0.35), { width: 1.4 * s, taperStart: 0.1, taperEnd: 0.3 }, r);
  }
  cStroke(ctx, [{ x: x - ew - 4 * s, y: eaveY - 9 * s }, { x: x - W, y: eaveY + 1 }, { x, y: eaveY + 2 }, { x: x + W, y: eaveY + 1 }, { x: x + ew + 4 * s, y: eaveY - 9 * s }], INK(0.92), { width: 7 * s, taperStart: 0.1, taperEnd: 0.1, jitter: 0.12 }, r, 4);
  cStroke(ctx, [{ x: x - rw - 8 * s, y: ridge - 5 * s + lean }, { x: x - rw * 0.4, y: ridge + lean * 0.6 }, { x: x + rw * 0.4, y: ridge - lean * 0.6 }, { x: x + rw + 8 * s, y: ridge - 5 * s - lean }], INK(0.95), { width: 6 * s, taperStart: 0.12, taperEnd: 0.12 }, r, 3);
  for (const sx of [-1, 1]) cBlob(ctx, x + sx * (rw + 8 * s), ridge - 6 * s - sx * lean, 3.2 * s, INK(0.9), r);

  if (!burning) return;
  // Suie sur un pan de toit et flammes vermillon qui lèchent le faîte.
  const side = r() < 0.5 ? -1 : 1;
  cBlob(ctx, x + side * W * 0.5, top - roofH * 0.4, 18 * s, rgba(C.soot, 0.3), r, 0.4);
  const flames = 3 + Math.floor(r() * 3);
  for (let f = 0; f < flames; f++) {
    const fx = x + (r() - 0.5) * rw * 1.8;
    const fy = ridge + (4 + r() * roofH * 0.5);
    const fh = (28 + r() * 40) * s;
    for (let k = 0; k < 3; k++) {
      const col = k === 0 ? rgba(C.redDeep, 0.6) : k === 1 ? rgba(C.red, 0.7) : rgba(C.ember, 0.65);
      const hh = fh * (1 - k * 0.25);
      const ph = r() * Math.PI * 2;
      const pts: Pt[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        pts.push({ x: fx + Math.sin(ph + t * 3.2) * 6 * s * t + (k - 1) * 3 * s, y: fy - t * hh });
      }
      cStroke(ctx, pts, col, { width: (12 - k * 3) * s, taperStart: 0, taperEnd: 0.95, jitter: 0.2 }, r, 3);
    }
  }
  // Braises qui montent.
  for (let i = 0; i < 14; i++) {
    const ex = x + (r() - 0.5) * W * 1.6;
    const ey = ridge - r() * 110 * s;
    cBlob(ctx, ex, ey, (0.9 + r() * 1.4) * s, rgba(r() < 0.5 ? C.ember : C.red, 0.55 + r() * 0.35), r, 0.25);
  }
}

/** Rempart de château : base de pierres à pente courbe, mur blanc percé de meurtrières, chaperon de tuiles. */
function rampart(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const Wb = (70 + r() * 20) * s;
  const h = (38 + r() * 12) * s;
  const inset = 14 * s;
  const Wt = Wb - inset;
  // Profil concave (mushagaeshi) : la pente se redresse vers le haut.
  const edge = (t: number) => Wb - inset * Math.pow(t, 0.6);
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    left.push({ x: x - edge(t), y: y - t * h });
    right.push({ x: x + edge(t), y: y - t * h });
  }
  cFill(ctx, left.concat(right.slice().reverse()), rgba(C.stone, 0.32));
  // Rangs de blocs et joints décalés.
  const rows = Math.max(3, Math.round(h / (10 * s)));
  for (let k = 1; k < rows; k++) {
    const t = k / rows;
    const ry = y - t * h;
    const half = edge(t) - 2;
    cDry(ctx, [{ x: x - half, y: ry }, { x, y: ry + (r() - 0.5) * 2 }, { x: x + half, y: ry }], INK(0.32), 1.6, r, 2);
  }
  for (let k = 0; k < rows; k++) {
    const t = k / rows;
    const ry = y - t * h;
    const half = edge(t) - 2;
    for (let jx = x - half + (k % 2) * 9 * s + r() * 6 * s; jx < x + half - 6 * s; jx += (16 + r() * 12) * s) {
      cStroke(ctx, [{ x: jx, y: ry - 1 }, { x: jx + (r() - 0.5) * 2, y: ry - (h / rows) * 0.9 }], INK(0.28), { width: 1.3, taperStart: 0.2, taperEnd: 0.2 }, r);
    }
  }
  cStroke(ctx, left, INK(0.8), { width: 3 * s, taperStart: 0.05, taperEnd: 0.1, jitter: 0.2 }, r, 3);
  cStroke(ctx, right, INK(0.8), { width: 3 * s, taperStart: 0.05, taperEnd: 0.1, jitter: 0.2 }, r, 3);

  // Mur blanc (plâtre) au-dessus de la pierre.
  const wallH = 20 * s;
  const wy = y - h;
  cFill(ctx, [{ x: x - Wt, y: wy }, { x: x + Wt, y: wy }, { x: x + Wt, y: wy - wallH }, { x: x - Wt, y: wy - wallH }], rgba(C.paper, 0.9));
  cDry(ctx, [{ x: x - Wt, y: wy - 2 }, { x: x + Wt, y: wy - 2 }], rgba(C.wash, 0.4), 3, r, 2);
  // Meurtrières (sama) : triangles et carrés en alternance.
  let n = 0;
  for (let mx = x - Wt + 12 * s; mx < x + Wt - 8 * s; mx += 20 * s, n++) {
    const my = wy - wallH * 0.5;
    const q = 3.4 * s;
    if (n % 2 === 0) cFill(ctx, [{ x: mx - q, y: my + q }, { x: mx + q, y: my + q }, { x: mx, y: my - q }], INK(0.78));
    else cFill(ctx, [{ x: mx - q, y: my - q }, { x: mx + q, y: my - q }, { x: mx + q, y: my + q }, { x: mx - q, y: my + q }], INK(0.78));
  }
  for (const sx of [-1, 1]) cStroke(ctx, [{ x: x + sx * Wt, y: wy }, { x: x + sx * Wt, y: wy - wallH }], INK(0.7), { width: 2 * s, taperStart: 0, taperEnd: 0 }, r);
  // Chaperon de tuiles : trait épais et bouts de tuiles.
  const capY = wy - wallH;
  cStroke(ctx, [{ x: x - Wt - 7 * s, y: capY - 2 * s }, { x, y: capY + 1 }, { x: x + Wt + 7 * s, y: capY - 2 * s }], INK(0.92), { width: 6.5 * s, taperStart: 0.06, taperEnd: 0.06, jitter: 0.12 }, r, 3);
  for (let tx = x - Wt - 4 * s; tx < x + Wt + 4 * s; tx += 6 * s) {
    cStroke(ctx, [{ x: tx, y: capY + 2 * s }, { x: tx, y: capY + 5 * s }], INK(0.55), { width: 1.4 * s, taperStart: 0, taperEnd: 0.4 }, r);
  }

  // Tour basse (yagura) sur une partie des remparts.
  if (r() < 0.45) {
    const tx = x + (r() < 0.5 ? -1 : 1) * Wt * 0.5;
    const tw = 18 * s;
    const th = 26 * s;
    const ty = capY - 1;
    cFill(ctx, [{ x: tx - tw, y: ty }, { x: tx + tw, y: ty }, { x: tx + tw, y: ty - th }, { x: tx - tw, y: ty - th }], rgba(C.paper, 0.92));
    cDry(ctx, [{ x: tx - tw, y: ty - 3 }, { x: tx + tw, y: ty - 3 }], rgba(C.wash, 0.4), 3, r, 2);
    // Fenêtre à barreaux.
    cFill(ctx, [{ x: tx - 7 * s, y: ty - th * 0.35 }, { x: tx + 7 * s, y: ty - th * 0.35 }, { x: tx + 7 * s, y: ty - th * 0.7 }, { x: tx - 7 * s, y: ty - th * 0.7 }], INK(0.6));
    for (let k = -1; k <= 1; k++) cStroke(ctx, [{ x: tx + k * 3.5 * s, y: ty - th * 0.35 }, { x: tx + k * 3.5 * s, y: ty - th * 0.7 }], rgba(C.paper, 0.8), { width: 1.2 * s, taperStart: 0, taperEnd: 0 }, r);
    for (const sx of [-1, 1]) cStroke(ctx, [{ x: tx + sx * tw, y: ty }, { x: tx + sx * tw, y: ty - th }], INK(0.7), { width: 2 * s, taperStart: 0, taperEnd: 0 }, r);
    // Deux rangs de toit relevés.
    const r1 = ty - th;
    cStroke(ctx, [{ x: tx - tw - 12 * s, y: r1 - 6 * s }, { x: tx - tw, y: r1 }, { x: tx + tw, y: r1 }, { x: tx + tw + 12 * s, y: r1 - 6 * s }], INK(0.92), { width: 6 * s, taperStart: 0.12, taperEnd: 0.12 }, r, 3);
    cFill(ctx, [{ x: tx - tw * 0.6, y: r1 - 2 * s }, { x: tx + tw * 0.6, y: r1 - 2 * s }, { x: tx + tw * 0.4, y: r1 - 12 * s }, { x: tx - tw * 0.4, y: r1 - 12 * s }], rgba(C.paper, 0.9));
    const r2 = r1 - 12 * s;
    cStroke(ctx, [{ x: tx - tw * 0.7 - 6 * s, y: r2 - 5 * s }, { x: tx - tw * 0.4, y: r2 }, { x: tx + tw * 0.4, y: r2 }, { x: tx + tw * 0.7 + 6 * s, y: r2 - 5 * s }], INK(0.95), { width: 5.5 * s, taperStart: 0.14, taperEnd: 0.14 }, r, 3);
    for (const sx of [-1, 1]) cBlob(ctx, tx + sx * (tw * 0.4 - 1), r2 - 3 * s, 2.4 * s, INK(0.9), r);
  }
}

// ─── Dojo : rouleau calligraphié et râtelier ───────────────────────────────

/** Trait d'un caractère dans une case unité (x vers la droite, y vers le bas). */
interface GlyphStroke {
  p: [number, number][];
  /** Épaisseur relative. */
  w: number;
  /** Point ou trait jeté : la fin s'effile davantage. */
  flick?: boolean;
  /** Grand trait balayé (le 辶 de 道) : le pinceau s'appuie en avançant. */
  sweep?: boolean;
}

/** 道 : 首 (deux points, barre, 丿, 目) dans la marche 辶 (point, zigzag, grand balayé). */
const GLYPH_DO: GlyphStroke[] = [
  { p: [[0.47, 0.05], [0.54, 0.15]], w: 1.15, flick: true },
  { p: [[0.8, 0.04], [0.72, 0.15]], w: 1.15, flick: true },
  { p: [[0.36, 0.21], [0.64, 0.205], [0.93, 0.19]], w: 1 },
  { p: [[0.64, 0.22], [0.56, 0.31]], w: 0.9, flick: true },
  { p: [[0.45, 0.31], [0.455, 0.71]], w: 0.95 },
  { p: [[0.45, 0.31], [0.84, 0.3], [0.83, 0.71]], w: 1 },
  { p: [[0.47, 0.44], [0.82, 0.435]], w: 0.8 },
  { p: [[0.47, 0.57], [0.82, 0.565]], w: 0.8 },
  { p: [[0.47, 0.7], [0.82, 0.695]], w: 0.85 },
  { p: [[0.13, 0.12], [0.21, 0.21]], w: 1.2, flick: true },
  { p: [[0.05, 0.35], [0.23, 0.345], [0.11, 0.53], [0.21, 0.59]], w: 0.95 },
  { p: [[0.2, 0.59], [0.2, 0.8], [0.32, 0.88], [0.62, 0.9], [0.97, 0.95]], w: 1, sweep: true },
];

/** 場 : 土 à gauche, 昜 à droite (日, longue barre, 勿). */
const GLYPH_JO: GlyphStroke[] = [
  { p: [[0.05, 0.4], [0.3, 0.385]], w: 0.9 },
  { p: [[0.18, 0.16], [0.185, 0.8]], w: 1 },
  { p: [[0.04, 0.86], [0.34, 0.74]], w: 0.9, flick: true },
  { p: [[0.47, 0.05], [0.475, 0.34]], w: 0.85 },
  { p: [[0.47, 0.05], [0.86, 0.045], [0.855, 0.34]], w: 0.9 },
  { p: [[0.49, 0.195], [0.85, 0.19]], w: 0.75 },
  { p: [[0.49, 0.33], [0.85, 0.325]], w: 0.8 },
  { p: [[0.37, 0.45], [0.66, 0.44], [0.97, 0.43]], w: 1 },
  { p: [[0.57, 0.5], [0.5, 0.59], [0.38, 0.67]], w: 0.9, flick: true },
  { p: [[0.5, 0.58], [0.91, 0.575], [0.88, 0.84], [0.82, 0.95], [0.74, 0.9]], w: 0.9 },
  { p: [[0.69, 0.62], [0.62, 0.76], [0.5, 0.87]], w: 0.8, flick: true },
  { p: [[0.83, 0.64], [0.74, 0.82], [0.6, 0.95]], w: 0.8, flick: true },
];

/** Calligraphie d'un caractère dans la case (x, y) – (x + size, y + size), trait par trait. */
function glyph(ctx: Ctx, g: GlyphStroke[], x: number, y: number, size: number, style: string, r: Rand): void {
  for (const st of g) {
    const pts = st.p.map(([u, v]) => ({ x: x + u * size + (r() - 0.5) * size * 0.012, y: y + v * size + (r() - 0.5) * size * 0.012 }));
    const width = size * 0.085 * st.w;
    if (st.sweep) cStroke(ctx, pts, style, { width, widthFn: (t) => 0.6 + t * 0.9, taperStart: 0.06, taperEnd: 0.14, jitter: 0.12 }, r, 3);
    else cStroke(ctx, pts, style, { width, taperStart: st.flick ? 0.05 : 0.12, taperEnd: st.flick ? 0.7 : 0.3, jitter: 0.14 }, r);
  }
}

/**
 * Rouleau suspendu (kakejiku) : cordon montant au plafond, baguette, monture de soie, bandes
 * ichimonji, papier calligraphié 道場, signature et sceau vermillon, rouleau lesté du bas.
 * Il pend au-dessus de la place de la finale, entre les deux duellistes.
 */
function hangingScroll(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const w = 34 * s; // demi-largeur de la monture
  const T = y - 236 * s; // baguette du haut
  const B = y - 56 * s; // rouleau du bas
  const hook = T - 16 * s;
  // Cordon : du crochet jusqu'au plafond, et les deux brins vers la baguette.
  cStroke(ctx, [{ x, y: hook }, { x, y: y - 440 * s }], INK(0.5), { width: 1.4 * s, taperStart: 0, taperEnd: 0 }, r);
  for (const sx of [-1, 1]) cStroke(ctx, [{ x: x + sx * w * 0.6, y: T }, { x, y: hook }], INK(0.7), { width: 1.3 * s, taperStart: 0, taperEnd: 0 }, r);
  cBlob(ctx, x, hook, 2.4 * s, INK(0.85), r, 0.2);
  // Ombre portée sur le mur, puis la monture.
  cFill(ctx, [{ x: x - w + 4 * s, y: T + 4 * s }, { x: x + w + 4 * s, y: T + 4 * s }, { x: x + w + 4 * s, y: B + 3 * s }, { x: x - w + 4 * s, y: B + 3 * s }], INK(0.1));
  cFill(ctx, [{ x: x - w, y: T }, { x: x + w, y: T }, { x: x + w, y: B }, { x: x - w, y: B }], rgba(C.paper, 0.92));
  cFill(ctx, [{ x: x - w, y: T }, { x: x + w, y: T }, { x: x + w, y: B }, { x: x - w, y: B }], rgba(C.wood, 0.5));
  cDry(ctx, [{ x: x - w + 3 * s, y: T + 4 * s }, { x: x - w + 4 * s, y: B - 4 * s }], rgba(C.paper, 0.14), 4 * s, r, 3);
  // Bordure intérieure (chūberi) claire autour du papier.
  const hw = 22 * s;
  const p0 = T + 32 * s;
  const p1 = B - 26 * s;
  cFill(ctx, [{ x: x - hw - 5 * s, y: p0 - 5 * s }, { x: x + hw + 5 * s, y: p0 - 5 * s }, { x: x + hw + 5 * s, y: p1 + 5 * s }, { x: x - hw - 5 * s, y: p1 + 5 * s }], rgba(C.paperDark, 0.85));
  // Bandes ichimonji au-dessus et au-dessous du papier.
  for (const by of [p0 - 3 * s, p1 + 3 * s]) cStroke(ctx, [{ x: x - hw - 5 * s, y: by }, { x: x + hw + 5 * s, y: by }], rgba(C.redDeep, 0.55), { width: 3 * s, taperStart: 0, taperEnd: 0, jitter: 0.08 }, r);
  // Papier (honshi).
  cFill(ctx, [{ x: x - hw, y: p0 }, { x: x + hw, y: p0 }, { x: x + hw, y: p1 }, { x: x - hw, y: p1 }], rgba(C.snow, 0.96));
  // Fūtai : deux bandes qui pendent de la baguette.
  for (const sx of [-1, 1]) {
    const fx = x + sx * w * 0.4;
    cStroke(ctx, [{ x: fx, y: T + 1 }, { x: fx, y: T + 30 * s }], rgba(C.paperDark, 0.75), { width: 4 * s, taperStart: 0, taperEnd: 0 }, r);
    cStroke(ctx, [{ x: fx, y: T + 29 * s }, { x: fx, y: T + 30 * s }], INK(0.45), { width: 4 * s, taperStart: 0, taperEnd: 0 }, r);
  }
  // 道場, de haut en bas.
  const size = 40 * s;
  const ink = INK(0.92);
  glyph(ctx, GLYPH_DO, x - size / 2, p0 + 6 * s, size, ink, r);
  glyph(ctx, GLYPH_JO, x - size / 2, p0 + 50 * s, size, ink, r);
  // Sceau vermillon, en bas à gauche du papier.
  const q = 3.4 * s;
  const sx0 = x - 11.5 * s;
  const sy = p0 + 108 * s;
  cFill(ctx, [{ x: sx0 - q, y: sy - q }, { x: sx0 + q, y: sy - q }, { x: sx0 + q, y: sy + q }, { x: sx0 - q, y: sy + q }], rgba(C.red, 0.82));
  cStroke(ctx, [{ x: sx0 - q * 0.5, y: sy }, { x: sx0 + q * 0.5, y: sy }], rgba(C.snow, 0.7), { width: 0.9 * s, taperStart: 0, taperEnd: 0 }, r);
  // Baguette du haut et rouleau du bas (jiku), embouts sombres.
  cStroke(ctx, [{ x: x - w - 2 * s, y: T }, { x: x + w + 2 * s, y: T }], rgba(C.wood, 0.95), { width: 4 * s, taperStart: 0, taperEnd: 0 }, r);
  cStroke(ctx, [{ x: x - w - 1 * s, y: B }, { x: x + w + 1 * s, y: B }], rgba(C.wood, 0.95), { width: 6.5 * s, taperStart: 0, taperEnd: 0 }, r);
  for (const sx of [-1, 1]) cBlob(ctx, x + sx * (w + 4.5 * s), B, 3.6 * s, INK(0.88), r, 0.15);
}

/**
 * Râtelier (katana-kake) : socle, deux montants à crochets, chapeau. Trois bokken de chêne clair
 * et, en haut, un sabre au fourreau laqué, cordon vermillon pendant.
 */
function swordRack(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const hw = 30 * s; // demi-écart des montants
  const h = 96 * s;
  const wood = rgba(C.wood, 0.9);
  cStroke(ctx, [{ x: x - hw - 14 * s, y: y - 3 }, { x: x + hw + 14 * s, y: y - 3 }], wood, { width: 6 * s, taperStart: 0.04, taperEnd: 0.04, jitter: 0.1 }, r);
  for (const sx of [-1, 1]) {
    const px = x + sx * hw;
    cStroke(ctx, [{ x: px - sx * 8 * s, y: y - 4 }, { x: px + sx * 8 * s, y: y - 4 }], wood, { width: 5 * s, taperStart: 0.1, taperEnd: 0.1 }, r);
    cStroke(ctx, [{ x: px, y: y - 5 }, { x: px + (r() - 0.5) * 1.5, y: y - h }], wood, { width: 5 * s, taperStart: 0, taperEnd: 0.04, jitter: 0.08 }, r);
    cDry(ctx, [{ x: px + 1.2 * s, y: y - 8 }, { x: px + 1.2 * s, y: y - h + 6 }], rgba(C.paper, 0.18), 1.6 * s, r, 2);
  }
  cStroke(ctx, [{ x: x - hw - 9 * s, y: y - h - 1 }, { x, y: y - h + 1 }, { x: x + hw + 9 * s, y: y - h - 1 }], wood, { width: 5 * s, taperStart: 0.1, taperEnd: 0.1, jitter: 0.1 }, r, 2);
  // Étages : crochets relevés sur chaque montant, un sabre posé sur chaque paire.
  const tiers = [22, 42, 62, 82];
  tiers.forEach((t, k) => {
    const yy = y - t * s;
    for (const sx of [-1, 1]) {
      const px = x + sx * hw;
      cStroke(ctx, [{ x: px, y: yy + 2 * s }, { x: px + sx * 6 * s, y: yy + 2 * s }, { x: px + sx * 7.5 * s, y: yy - 2.5 * s }], INK(0.7), { width: 2.2 * s, taperStart: 0, taperEnd: 0.3 }, r);
    }
    if (k === tiers.length - 1) sheathedSword(ctx, x, yy - 1.5 * s, s, r);
    else bokken(ctx, x, yy - 1 * s, s, 0.5 + k * 0.08, r);
  });
}

/** Sabre de bois (bokken) posé à plat, poignée à gauche, pointe à droite légèrement relevée. */
function bokken(ctx: Ctx, x: number, y: number, s: number, a: number, r: Rand): void {
  const L = 48 * s;
  const blade = [{ x: x - L, y }, { x: x - L * 0.2, y: y - 1.6 * s }, { x: x + L * 0.6, y: y - 2.4 * s }, { x: x + L, y: y - 4.2 * s }];
  cStroke(ctx, blade, rgba(C.wood, a), { width: 3.8 * s, taperStart: 0.02, taperEnd: 0.18, jitter: 0.08 }, r, 3);
  cStroke(ctx, [{ x: x - L, y }, { x: x - L * 0.45, y: y - 1 * s }], rgba(C.wood, Math.min(0.95, a + 0.3)), { width: 4.2 * s, taperStart: 0.04, taperEnd: 0 }, r);
  // Garde (tsuba) : bague d'encre au bout de la poignée.
  cStroke(ctx, [{ x: x - L * 0.45, y: y - 4.4 * s }, { x: x - L * 0.45, y: y + 3 * s }], INK(0.8), { width: 2.4 * s, taperStart: 0.1, taperEnd: 0.1 }, r);
  cDry(ctx, [{ x: x - L * 0.35, y: y - 2.6 * s }, { x: x + L * 0.85, y: y - 4.2 * s }], rgba(C.paper, 0.2), 1.2 * s, r, 2);
}

/** Sabre au fourreau (saya) laqué d'encre, tranchant vers le haut ; poignée tressée et cordon (sageo) vermillon. */
function sheathedSword(ctx: Ctx, x: number, y: number, s: number, r: Rand): void {
  const L = 50 * s;
  const saya = [{ x: x - L * 0.4, y: y - 0.6 * s }, { x: x + L * 0.2, y: y - 2.4 * s }, { x: x + L * 0.75, y: y - 3.4 * s }, { x: x + L, y: y - 5.6 * s }];
  cStroke(ctx, saya, INK(0.9), { width: 4.4 * s, taperStart: 0, taperEnd: 0.06, jitter: 0.06 }, r, 3);
  cDry(ctx, saya.map((p) => ({ x: p.x, y: p.y - 1 * s })), rgba(C.paper, 0.22), 1.2 * s, r, 2);
  // Poignée (tsuka) et sa tresse en losanges.
  const g0 = x - L;
  const g1 = x - L * 0.48;
  cStroke(ctx, [{ x: g0, y: y + 1.4 * s }, { x: g1, y }], INK(0.85), { width: 4 * s, taperStart: 0.04, taperEnd: 0 }, r);
  for (let gx = g0 + 3 * s; gx < g1 - 2 * s; gx += 4.2 * s) {
    cStroke(ctx, [{ x: gx - 1.2 * s, y: y - 1.2 * s }, { x: gx + 1.2 * s, y: y + 1.6 * s }], rgba(C.paper, 0.5), { width: 0.8 * s, taperStart: 0, taperEnd: 0 }, r);
  }
  cBlob(ctx, g0 - 0.6 * s, y + 1.4 * s, 2.2 * s, INK(0.9), r, 0.15);
  // Garde ronde et cordon qui pend sous le fourreau.
  cBlob(ctx, g1 + 1 * s, y - 0.4 * s, 3.8 * s, INK(0.9), r, 0.12);
  cStroke(ctx, [{ x: g1 + 8 * s, y: y + 1.5 * s }, { x: g1 + 10 * s, y: y + 9 * s }, { x: g1 + 6 * s, y: y + 15 * s }, { x: g1 + 9 * s, y: y + 19 * s }], rgba(C.red, 0.8), { width: 1.6 * s, taperStart: 0.05, taperEnd: 0.5 }, r, 3);
}
