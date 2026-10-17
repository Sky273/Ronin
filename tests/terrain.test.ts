// Tests du téléversement des taches d'encre du terrain : seul le rectangle sali part au GPU.
// Lancer : npm run test:terrain
import type Phaser from 'phaser';
import { buildLevel, type Level } from '../shared/level';
import { Rng } from '../shared/math';
import { DUEL, TILE } from '../shared/constants';
import { buildDojo, DOJO_FINAL_X, DOJO_TATAMIS } from '../shared/dojoLevel';
import { Terrain } from '../client/render/terrain';
import { Backdrop } from '../client/render/backdrop';
import { C, rgba } from '../client/render/palette';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

// ─── Doublures : contexte 2D, CanvasTexture, WebGL ────────────────────────

interface P { x: number; y: number }

/** Contexte 2D factice : suit translate/scale et relève les sommets des tracés (repère de la tranche). */
class FakeCtx {
  fillStyle: unknown = '';
  globalCompositeOperation = 'source-over';
  /** Transformation courante : x' = sx·x + tx, y' = sy·y + ty (seuls translate et scale servent). */
  private m = [1, 1, 0, 0];
  private stack: number[][] = [];
  pts: P[] = [];
  draws: { args: unknown[]; op: string }[] = [];
  save(): void { this.stack.push(this.m.slice()); }
  restore(): void { this.m = this.stack.pop() ?? [1, 1, 0, 0]; }
  translate(x: number, y: number): void { this.m[2] += this.m[0] * x; this.m[3] += this.m[1] * y; }
  scale(x: number, y: number): void { this.m[0] *= x; this.m[1] *= y; }
  moveTo(x: number, y: number): void { this.pts.push({ x: this.m[0] * x + this.m[2], y: this.m[1] * y + this.m[3] }); }
  lineTo(x: number, y: number): void { this.moveTo(x, y); }
  /** Remplissages : style courant et sommets du tracé (depuis beginPath). */
  fills: { style: unknown; pts: P[] }[] = [];
  private start = 0;
  beginPath(): void { this.start = this.pts.length; }
  closePath(): void {}
  fill(): void { this.fills.push({ style: this.fillStyle, pts: this.pts.slice(this.start) }); }
  clearRect(): void {}
  fillRect(): void {}
  createLinearGradient(): { addColorStop(): void } { return { addColorStop() {} }; }
  createRadialGradient(): { addColorStop(): void } { return { addColorStop() {} }; }
  drawImage(...args: unknown[]): void { this.draws.push({ args, op: this.globalCompositeOperation }); }
  // Pour les couches du fond (papier : fibres au trait, grain par getImageData).
  strokeStyle: unknown = '';
  lineWidth = 1;
  lineCap = '';
  quadraticCurveTo(_cx: number, _cy: number, x: number, y: number): void { this.moveTo(x, y); }
  stroke(): void {}
  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } { return { data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(): void {}
}

/** Enveloppe de texture GL telle que Phaser la crée pour une CanvasTexture. */
interface Wrapper { webGLTexture: object | null; mipLevel: number; pma: boolean; flipY: boolean; format: number }

class FakeGL {
  readonly TEXTURE0 = 0x84c0;
  readonly TEXTURE_2D = 0x0de1;
  readonly TEXTURE_BINDING_2D = 0x8069;
  readonly RGBA = 0x1908;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly UNPACK_FLIP_Y_WEBGL = 0x9240;
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
  lost = false;
  active = 0x84c0 + 3;
  bound = new Map<number, object | null>();
  store = new Map<number, unknown>();
  subs: { tex: object | null | undefined; level: number; x: number; y: number; w: number; h: number; format: number; type: number; pma: unknown; flip: unknown; unit: number }[] = [];
  mips = 0;
  isContextLost(): boolean { return this.lost; }
  activeTexture(u: number): void { this.active = u; }
  getParameter(p: number): unknown { return p === this.TEXTURE_BINDING_2D ? this.bound.get(this.active) ?? null : null; }
  bindTexture(_target: number, tex: object | null): void { this.bound.set(this.active, tex); }
  pixelStorei(p: number, v: unknown): void { this.store.set(p, v); }
  texSubImage2D(_target: number, level: number, x: number, y: number, format: number, type: number, src: { width: number; height: number }): void {
    this.subs.push({
      tex: this.bound.get(this.active), level, x, y, w: src.width, h: src.height, format, type,
      pma: this.store.get(this.UNPACK_PREMULTIPLY_ALPHA_WEBGL), flip: this.store.get(this.UNPACK_FLIP_Y_WEBGL), unit: this.active,
    });
  }
  generateMipmap(): void { this.mips++; }
}

class FakeTex {
  /** Téléversements complets (refresh → texImage2D du canvas entier). */
  refreshes = 0;
  readonly canvas: { width: number; height: number };
  readonly context = new FakeCtx();
  readonly source: { glTexture: Wrapper | null }[];
  constructor(readonly key: string, readonly w: number, readonly h: number, glTexture: Wrapper | null) {
    this.canvas = { width: w, height: h };
    this.source = [{ glTexture }];
  }
  refresh(): this { this.refreshes++; return this; }
}

/** Canvas de transit créés par le terrain (document.createElement). */
const scratches: { width: number; height: number; ctx: FakeCtx; opts: unknown }[] = [];
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => {
    const c = { tag, width: 300, height: 150, ctx: new FakeCtx(), opts: undefined as unknown, getContext: (_t: string, o?: unknown) => { c.opts = o; return c.ctx; } };
    scratches.push(c);
    return c;
  },
};

interface Rig {
  terrain: Terrain;
  gl: FakeGL;
  texs: FakeTex[];
  wrappers: Wrapper[];
  /** Téléversements complets depuis la remise à zéro. */
  fulls(): number;
  reset(): void;
}

function rig(opts: { webgl?: boolean; flipY?: boolean; level?: Level } = {}): Rig {
  const webgl = opts.webgl ?? true;
  const gl = new FakeGL();
  const texs: FakeTex[] = [];
  const wrappers: Wrapper[] = [];
  const scene = {
    renderer: webgl ? { gl } : { type: 1 },
    textures: {
      createCanvas: (key: string, w: number, h: number) => {
        const wr: Wrapper | null = webgl ? { webGLTexture: { key }, mipLevel: 0, pma: true, flipY: !!opts.flipY, format: gl.RGBA } : null;
        if (wr) wrappers.push(wr);
        const t = new FakeTex(key, w, h, wr);
        texs.push(t);
        return t;
      },
      remove: () => {},
    },
    add: {
      image: () => {
        const img = { setOrigin: () => img, setDepth: () => img, destroy: () => {} };
        return img;
      },
    },
  };
  const put = <T,>(obj: T) => obj;
  const terrain = new Terrain(scene as unknown as Phaser.Scene, opts.level ?? buildLevel(), put as never);
  let base = 0;
  const total = () => texs.reduce((s, t) => s + t.refreshes, 0);
  const r: Rig = {
    terrain, gl, texs, wrappers,
    fulls: () => total() - base,
    reset: () => {
      base = total();
      gl.subs.length = 0;
      gl.mips = 0;
      for (const t of texs) {
        t.context.pts.length = 0;
        t.context.fills.length = 0;
      }
    },
  };
  r.reset();
  return r;
}

/** Boîte englobante des sommets tracés sur une tranche. */
function bbox(pts: P[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Le rectangle envoyé couvre-t-il tout ce qui a été peint sur la tranche, avec 1 px de marge pour
 * l'anticrénelage (sauf contre les bords de la tranche, où rien n'est peint au-delà) ?
 */
function covers(sub: { x: number; y: number; w: number; h: number }, b: { x0: number; y0: number; x1: number; y1: number }, tw: number, th: number): boolean {
  const need = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return sub.x <= need(Math.floor(b.x0) - 1, 0, tw) && sub.y <= need(Math.floor(b.y0) - 1, 0, th)
    && sub.x + sub.w >= need(Math.ceil(b.x1) + 1, 0, tw) && sub.y + sub.h >= need(Math.ceil(b.y1) + 1, 0, th);
}

const INK = 0x15120e;

// ─── 1. Une tache : seul son rectangle part au GPU ────────────────────────
{
  const R = rig();
  const t0 = R.texs[0];
  check('le niveau historique fait plusieurs tranches de 2048 × 768', R.texs.length >= 3 && t0.w === 2048 && t0.h === 768, `${R.texs.length} tranches`);
  // Le pipeline a laissé une autre unité active et une texture de son lot liée sur l'unité 0.
  R.gl.active = R.gl.TEXTURE0 + 3;
  const before0 = { key: 'liée sur l’unité 0' };
  R.gl.bound.set(R.gl.TEXTURE0, before0);
  R.terrain.stain(600, 500, 3, 1, INK, 7);
  R.terrain.flush();
  const sub = R.gl.subs[0];
  check('une tache ne renvoie pas la tranche entière (pas de refresh)', R.fulls() === 0, `${R.fulls()} refresh`);
  check('une tache = un seul téléversement partiel', R.gl.subs.length === 1, `${R.gl.subs.length}`);
  if (sub) {
    const bytes = sub.w * sub.h * 4;
    check('le rectangle envoyé est petit (< 1 % de la tranche)', bytes < 2048 * 768 * 4 * 0.01, `${sub.w}×${sub.h} = ${bytes} octets au lieu de ${2048 * 768 * 4}`);
    check('le rectangle est envoyé dans la texture de la bonne tranche', sub.tex === R.wrappers[0].webGLTexture);
    check('le rectangle couvre toute la tache peinte (+1 px)', covers(sub, bbox(t0.context.pts), t0.w, t0.h), JSON.stringify({ sub, b: bbox(t0.context.pts) }));
    check('réglages de Phaser : niveau 0, RGBA, UNSIGNED_BYTE', sub.level === 0 && sub.format === R.gl.RGBA && sub.type === R.gl.UNSIGNED_BYTE);
    check('réglages de Phaser : UNPACK_PREMULTIPLY_ALPHA_WEBGL = pma de la texture, UNPACK_FLIP_Y_WEBGL = faux', sub.pma === true && sub.flip === false);
    check('téléversement sur l’unité 0, comme WebGLTextureWrapper', sub.unit === R.gl.TEXTURE0);
    check('la texture liée à l’unité 0 est rétablie (cache des pipelines intact)', R.gl.bound.get(R.gl.TEXTURE0) === before0);
    check('pas de mipmaps pour une tranche non puissance de deux', R.gl.mips === 0);
    // Le canvas de transit reçoit une copie exacte du rectangle (pixels prémultipliés, opérateur « copy »).
    const s = scratches[scratches.length - 1];
    const d = s?.ctx.draws[s.ctx.draws.length - 1];
    check('canvas de transit créé en lecture fréquente, comme les tranches de Phaser', !!s && (s.opts as { willReadFrequently?: boolean } | undefined)?.willReadFrequently === true);
    check('copie exacte du rectangle sali vers le canvas de transit', !!d && d.op === 'copy' && d.args[0] === t0.canvas
      && JSON.stringify(d.args.slice(1)) === JSON.stringify([sub.x, sub.y, sub.w, sub.h, 0, 0, sub.w, sub.h]), JSON.stringify(d?.args.slice(1)));
    check('le canvas de transit a exactement la taille du rectangle', s.width === sub.w && s.height === sub.h);
  }
  R.reset();
  R.terrain.flush();
  check('rien à envoyer sans nouvelle tache', R.gl.subs.length === 0 && R.fulls() === 0);
}

// ─── 2. Plusieurs taches dans la même image : union des rectangles ────────
{
  const R = rig();
  const t0 = R.texs[0];
  R.terrain.stain(600, 500, 3, 1, INK, 1);
  R.terrain.stain(640, 480, 2, -1, INK, 2);
  R.terrain.stain(700, 520, 9, 1, INK, 3);
  R.terrain.flush();
  check('trois taches dans une image : un seul envoi pour la tranche', R.gl.subs.length === 1 && R.fulls() === 0, `${R.gl.subs.length} envois, ${R.fulls()} refresh`);
  const sub = R.gl.subs[0];
  if (sub) check('l’union couvre les trois taches', covers(sub, bbox(t0.context.pts), t0.w, t0.h));
}

// ─── 3. Tache à la jonction de deux tranches ──────────────────────────────
{
  const R = rig();
  R.terrain.stain(2048 - 4, 500, 4, 1, INK, 11);
  R.terrain.flush();
  check('jonction : un envoi partiel par tranche touchée', R.gl.subs.length === 2 && R.fulls() === 0, `${R.gl.subs.length} envois`);
  for (let i = 0; i < 2; i++) {
    const t = R.texs[i];
    const sub = R.gl.subs.find((s) => s.tex === R.wrappers[i].webGLTexture);
    check(`jonction : tranche ${i} servie, rectangle rogné à la tranche`, !!sub && sub.x >= 0 && sub.y >= 0 && sub.x + sub.w <= t.w && sub.y + sub.h <= t.h, JSON.stringify(sub));
    if (sub) check(`jonction : la partie de la tache peinte sur la tranche ${i} est couverte`, covers(sub, bbox(t.context.pts), t.w, t.h));
  }
}

// ─── 4. Taches au hasard : le rectangle couvre toujours la peinture ───────
{
  const R = rig();
  const rng = new Rng(2024);
  let bad = 0;
  let biggest = 0;
  let n = 0;
  const pxW = R.texs.reduce((s, t) => s + t.w, 0);
  for (let k = 0; k < 600; k++) {
    // Rayons des gouttes (1,2 + taille × 1,5) et des cadavres (6 à 11), un peu au-delà par prudence.
    const r = k % 5 === 0 ? 6 + rng.next() * 7 : 1.2 + rng.next() * 6;
    const x = k % 7 === 0 ? 2048 * (1 + Math.floor(rng.next() * 2)) + (rng.next() - 0.5) * 40 : rng.next() * pxW;
    const y = k % 11 === 0 ? (rng.next() < 0.5 ? 2 : 766) : 100 + rng.next() * 600;
    const dir = rng.next() < 0.5 ? -1 : 1;
    R.reset();
    R.terrain.stain(x, y, r, dir, INK, k + 1);
    R.terrain.flush();
    if (R.fulls() !== 0) bad++;
    for (let i = 0; i < R.texs.length; i++) {
      const t = R.texs[i];
      if (!t.context.pts.length) continue;
      n++;
      const sub = R.gl.subs.find((s) => s.tex === R.wrappers[i].webGLTexture);
      if (!sub || !covers(sub, bbox(t.context.pts), t.w, t.h)) bad++;
      else biggest = Math.max(biggest, sub.w * sub.h);
    }
  }
  check('600 taches au hasard : chaque rectangle couvre toute la peinture, jamais de refresh', bad === 0 && n >= 600, `${bad} écart(s) sur ${n} tranches peintes`);
  check('600 taches au hasard : le plus grand rectangle reste petit', biggest > 0 && biggest < 2048 * 768 * 0.02, `${biggest} px`);
}

// ─── 5. Replis sur refresh() ──────────────────────────────────────────────
{
  const R = rig({ webgl: false });
  R.terrain.stain(600, 500, 3, 1, INK, 5);
  R.terrain.stain(2048 - 4, 500, 4, 1, INK, 6);
  R.terrain.flush();
  check('rendu Canvas : repli sur refresh(), une fois par tranche salie', R.fulls() === 2 && R.texs[0].refreshes > 0, `${R.fulls()} refresh`);
  R.reset();
  R.terrain.flush();
  check('rendu Canvas : rien à envoyer sans nouvelle tache', R.fulls() === 0);
}
{
  const R = rig();
  R.gl.lost = true;
  R.terrain.stain(600, 500, 3, 1, INK, 5);
  R.terrain.flush();
  check('contexte WebGL perdu : repli sur refresh() (Phaser re-téléversera au retour)', R.fulls() === 1 && R.gl.subs.length === 0);
}
{
  const R = rig({ flipY: true });
  R.terrain.stain(600, 500, 3, 1, INK, 5);
  R.terrain.flush();
  check('texture retournée (flipY) : repli sur refresh()', R.fulls() === 1 && R.gl.subs.length === 0);
}
{
  const R = rig();
  R.terrain.stain(60, 30, 3, 1, INK, 5);
  R.terrain.stain(1990, 740, 3, 1, INK, 6);
  R.terrain.flush();
  check('union presque aussi grande que la tranche : un seul refresh() plutôt qu’une copie', R.fulls() === 1 && R.gl.subs.length === 0, `${R.fulls()} refresh, ${R.gl.subs.length} envois`);
}

// ─── 6. Tranche puissance de deux : mipmaps régénérées, comme Phaser ──────
{
  const base = buildLevel();
  const w = 64;
  const h = 32;
  const tiles = new Uint8Array(w * h);
  for (let ty = 26; ty < h; ty++) for (let tx = 0; tx < w; tx++) tiles[ty * w + tx] = 1;
  const level: Level = { ...base, w, h, pxW: w * 32, pxH: h * 32, tiles, decos: [] };
  const R = rig({ level });
  R.terrain.stain(600, 830, 3, 1, INK, 5);
  R.terrain.flush();
  check('tranche 2048 × 1024 : envoi partiel puis generateMipmap (comme _processTexture)', R.gl.subs.length === 1 && R.gl.mips === 1 && R.fulls() === 0);
}

// ─── 7. Nouvelle étape : la toile repeinte repart propre ──────────────────
{
  const R = rig();
  R.terrain.stain(600, 500, 3, 1, INK, 5);
  R.terrain.repaint();
  check('repaint : chaque tranche est renvoyée en entier une fois', R.fulls() === R.texs.length);
  R.reset();
  R.terrain.flush();
  check('repaint : la tache d’avant n’est plus en attente', R.gl.subs.length === 0 && R.fulls() === 0);
}

// ─── 8. Dojo : une seule tranche, plancher, tatamis, rouleau et râtelier ──
type Fill = { style: unknown; pts: P[] };
const finite = (pts: P[]) => pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
const inBox = (pts: P[], x0: number, y0: number, x1: number, y1: number) => pts.filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).length;
{
  const dojo = buildDojo();
  const floor = 18 * TILE;
  // Les sommets de la peinture initiale sont relevés avant la remise à zéro du banc : on repeint.
  const R = rig({ level: dojo });
  R.terrain.repaint();
  const t0 = R.texs[0];
  const pts = t0.context.pts.slice();
  check('dojo : 1792 px de large, une seule tranche (< 2048)', R.texs.length === 1 && t0.w === dojo.pxW && t0.w === 1792 && t0.h === dojo.pxH, `${R.texs.length} tranche(s), ${t0.w} × ${t0.h}`);
  check('dojo : repaint peint la tranche et la renvoie une seule fois', pts.length > 1000 && R.fulls() === 1, `${pts.length} sommets, ${R.fulls()} refresh`);
  check('dojo : aucun sommet NaN ou infini', finite(pts));
  // Peinture déterministe : un second repaint trace exactement les mêmes sommets.
  R.reset();
  R.terrain.repaint();
  const again = t0.context.pts;
  check('dojo : repaint déterministe (mêmes sommets)', again.length === pts.length && again.every((p, i) => p.x === pts[i].x && p.y === pts[i].y), `${again.length} contre ${pts.length}`);
  // Remplissages d'un style donné dont le centre tombe dans la boîte.
  const fills = t0.context.fills.slice();
  const center = (f: Fill) => ({ x: f.pts.reduce((s, p) => s + p.x, 0) / f.pts.length, y: f.pts.reduce((s, p) => s + p.y, 0) / f.pts.length });
  const styled = (fs: Fill[], style: string, x0: number, y0: number, x1: number, y1: number) =>
    fs.filter((f) => f.style === style && f.pts.length > 0 && inBox([center(f)], x0, y0, x1, y1) === 1).length;
  // Tatamis des quarts (natte paille) et marques d'encre des duellistes à ± DUEL.GAP / 2, sous le trait de sol.
  const half = DUEL.GAP / 2;
  const igusa = rgba(0xa59c5e, 0.3);
  check('dojo : quatre tatamis, un par quart', styled(fills, igusa, 0, floor, dojo.pxW, floor + 40) === 4, `${styled(fills, igusa, 0, floor, dojo.pxW, floor + 40)}`);
  for (const [i, cx] of DOJO_TATAMIS.entries()) {
    check(`dojo : tatami ${i} centré sur sa place (x = ${cx}), sur le plancher`, styled(fills, igusa, cx - 3, floor + 10, cx + 3, floor + 26) === 1);
    for (const sx of [-1, 1]) {
      const n = styled(fills, rgba(C.ink, 0.82), cx + sx * half - 8, floor + 8, cx + sx * half + 8, floor + 28);
      check(`dojo : marque ${sx < 0 ? 'gauche' : 'droite'} du tatami ${i} (x = ${cx + sx * half})`, n >= 2, `${n}`);
    }
  }
  // Finale : ensō vermillon au centre de la salle, marques vermillon à ± DUEL.GAP / 2.
  check('dojo : ensō vermillon au centre de la finale', styled(fills, rgba(C.red, 0.78), DOJO_FINAL_X - 12, floor + 10, DOJO_FINAL_X + 12, floor + 26) === 1);
  for (const sx of [-1, 1]) {
    const n = styled(fills, rgba(C.red, 0.85), DOJO_FINAL_X + sx * half - 8, floor + 8, DOJO_FINAL_X + sx * half + 8, floor + 28);
    check(`dojo : marque vermillon ${sx < 0 ? 'gauche' : 'droite'} de la finale`, n >= 2, `${n}`);
  }
  // Lames du plancher : des sommets jusqu'en profondeur, sur toute la largeur de la salle.
  check('dojo : lames du plancher peintes en profondeur', inBox(pts, 80, floor + 90, dojo.pxW - 80, floor + 170) > 200);
  check('dojo : ni herbe ni mousse sur le plancher (aucun trait au-dessus du sol hors décors)', (() => {
    const bare = rig({ level: { ...dojo, decos: [] } });
    bare.terrain.repaint();
    return inBox(bare.texs[0].context.pts, 2 * TILE + 4, floor - 40, 54 * TILE - 4, floor - 6) === 0;
  })());
  // Décors : chaque décor seul dans la salle, dessiné sans exception et là où il se tient.
  const only = (kind: string) => {
    const Q = rig({ level: { ...dojo, decos: dojo.decos.filter((d) => d.kind === kind) } });
    Q.terrain.repaint();
    return Q.texs[0].context.fills;
  };
  const bareRig = rig({ level: { ...dojo, decos: [] } });
  bareRig.terrain.repaint();
  const bare = bareRig.texs[0].context.fills;
  let scroll: Fill[] | null = null;
  let rack: Fill[] | null = null;
  let err = '';
  try {
    scroll = only('scroll');
    rack = only('rack');
  } catch (e) {
    err = String(e);
  }
  check('dojo : rouleau et râtelier dessinés sans exception', !err && !!scroll && !!rack, err);
  if (scroll && rack) {
    const inside = (fs: Fill[], x0: number, y0: number, x1: number, y1: number) => fs.filter((f) => f.pts.length > 0 && inBox([center(f)], x0, y0, x1, y1) === 1).length;
    const sd = dojo.decos.find((d) => d.kind === 'scroll')!;
    const s = sd.s;
    const extra = inside(scroll, sd.x - 50, sd.y - 300 * s, sd.x + 50, sd.y - 40 * s) - inside(bare, sd.x - 50, sd.y - 300 * s, sd.x + 50, sd.y - 40 * s);
    check('dojo : le rouleau pend au-dessus de la place de la finale', sd.x === DOJO_FINAL_X && extra > 30, `${extra} remplissages`);
    // Papier du rouleau : de 32 px sous la baguette (y - 236 s) à 26 px au-dessus du rouleau du bas (y - 56 s).
    const ink = styled(scroll, rgba(C.ink, 0.92), sd.x - 22 * s, sd.y - 204 * s, sd.x + 22 * s, sd.y - 82 * s);
    check('dojo : 道場 calligraphié trait par trait sur le papier du rouleau (12 + 12 traits)', ink === 24, `${ink} traits`);
    check('dojo : sceau vermillon sur le rouleau', styled(scroll, rgba(C.red, 0.82), sd.x - 22 * s, sd.y - 204 * s, sd.x, sd.y - 82 * s) === 1);
    for (const d of dojo.decos.filter((dd) => dd.kind === 'rack')) {
      const n = inside(rack, d.x - 60, d.y - 110, d.x + 60, d.y) - inside(bare, d.x - 60, d.y - 110, d.x + 60, d.y);
      check(`dojo : râtelier dessiné à x = ${d.x}, posé sur le sol`, n > 40, `${n} remplissages`);
      check(`dojo : cordon vermillon du sabre au fourreau (x = ${d.x})`, styled(rack, rgba(C.red, 0.8), d.x - 60, d.y - 110, d.x + 60, d.y) === 1);
    }
    check('dojo : décors sans NaN', finite(scroll.flatMap((f) => f.pts)) && finite(rack.flatMap((f) => f.pts)));
  }
  // Envois bornés : taches au milieu et contre les murs, rectangle rogné à la tranche de 1792 px.
  R.reset();
  R.terrain.stain(DOJO_TATAMIS[1], floor + 2, 6, 1, INK, 3);
  R.terrain.flush();
  const sub = R.gl.subs[0];
  check('dojo : une tache = un envoi partiel, pas de refresh', R.gl.subs.length === 1 && R.fulls() === 0 && !!sub);
  if (sub) check('dojo : rectangle petit et couvrant la tache', sub.w * sub.h < 1792 * 768 * 0.01 && covers(sub, bbox(t0.context.pts), t0.w, t0.h), JSON.stringify(sub));
  for (const x of [2, dojo.pxW - 2]) {
    R.reset();
    R.terrain.stain(x, floor + 2, 8, x < 100 ? -1 : 1, INK, 9);
    R.terrain.flush();
    const s = R.gl.subs[0];
    check(`dojo : tache contre le mur (x = ${x}) rognée à la tranche`, R.gl.subs.length === 1 && R.fulls() === 0 && !!s && s.x >= 0 && s.x + s.w <= t0.w && s.y >= 0 && s.y + s.h <= t0.h && covers(s, bbox(t0.context.pts), t0.w, t0.h), JSON.stringify(s));
  }
  // Retour au voyage : la toile reprend la taille du niveau historique, nouvelles tranches.
  R.terrain.repaint(buildLevel());
  check('dojo → voyage : tranches recréées à la largeur du niveau', R.texs.length > 1 && R.texs.slice(1).every((t) => t.h === 768), `${R.texs.length} textures créées`);
}

// ─── 9. Fond du dojo : couche de shōji, montagnes et lune ─────────────────
{
  const made = new Map<string, FakeTex>();
  interface Spr { key: string; x: number; y: number; tilePositionX: number; tint: number | null }
  const sprites: Spr[] = [];
  const sprite = (x: number, y: number, key: string) => {
    const s: Spr & Record<string, unknown> = { key, x, y, tilePositionX: 0, tint: null };
    Object.assign(s, {
      setOrigin: () => s,
      setTexture: (k: string) => { s.key = k; return s; },
      setTint: (t: number) => { s.tint = t; return s; },
      clearTint: () => { s.tint = null; return s; },
      setPosition: (px: number, py: number) => { s.x = px; s.y = py; return s; },
    });
    sprites.push(s);
    return s;
  };
  const scene = {
    scale: { width: 1280, height: 720 },
    textures: {
      exists: (k: string) => made.has(k),
      createCanvas: (key: string, w: number, h: number) => { const t = new FakeTex(key, w, h, null); made.set(key, t); return t; },
    },
    add: {
      image: (x: number, y: number, key: string) => sprite(x, y, key),
      tileSprite: (x: number, y: number, _w: number, _h: number, key: string) => sprite(x, y, key),
    },
  };
  const bd = new Backdrop(scene as unknown as Phaser.Scene, ((o: unknown) => o) as never);
  const bambooKeys = [...made.keys()];
  const [far, mid, near] = sprites.slice(2);
  const cam = { scrollX: 224, scrollY: 151 } as unknown as Phaser.Cameras.Scene2D.Camera; // vue de la finale, au repos
  bd.update(cam);
  const bambooNearY = near.y;
  let err = '';
  try {
    bd.setBiome('dojo');
  } catch (e) {
    err = String(e);
  }
  check('fond du dojo généré sans exception', !err, err);
  check('fond du dojo : clés de texture propres (mFar_dojo, mMid_dojo, near_dojo)', far.key === 'mFar_dojo' && mid.key === 'mMid_dojo' && near.key === 'near_dojo' && ['mFar_dojo', 'mMid_dojo', 'near_dojo'].every((k) => made.has(k)));
  check('fond du dojo : textures historiques de la forêt de bambous intactes', bambooKeys.every((k) => made.has(k)) && ['mFar', 'mMid', 'bamboo', 'sun'].every((k) => bambooKeys.includes(k)));
  const shoji = made.get('near_dojo');
  if (shoji) {
    const sp = shoji.context.pts;
    check('couche de shōji : 2048 px (tuilable) et beaucoup de traits', shoji.w === 2048 && sp.length > 5000, `${shoji.w} px, ${sp.length} sommets`);
    check('couche de shōji : sans NaN', finite(sp));
    // Double travée ouverte (512 – 1024) : pas de papier de shōji entre le linteau et le seuil.
    const papered = (x0: number, x1: number) => inBox(sp, x0, 200, x1, 400);
    check('couche de shōji : la double travée du centre est ouverte (store et garde-corps seulement)', papered(560, 980) < papered(1060, 1480) / 2, `${papered(560, 980)} contre ${papered(1060, 1480)}`);
    // Raccord : le pilier de x = 0 est repeint en x = 2048.
    check('couche de shōji : pilier repeint aux deux bords (raccord du tuilage)', inBox(sp, -12, 100, 0, 400) > 0 && inBox(sp, 2048, 100, 2060, 400) > 0);
  }
  bd.update(cam);
  const lift = near.y - bambooNearY;
  // Double saut : ~190 px ; la couche proche descend de 0,42 × 0,6 de la montée de la caméra.
  check('fond du dojo : le mur couvre le haut de l’écran au repos et pendant un double saut', near.y <= -50 && near.y + 0.42 * 0.6 * 190 < 0, `y = ${near.y.toFixed(1)}`);
  check('fond du dojo : couche proche remontée de 190 px', Math.abs(lift + 190) < 1e-9, `${lift}`);
  const moon = sprites[1];
  check('fond du dojo : lune discrète dans l’ouverture', moon.key === 'orb_moon' && moon.x > 640 && moon.x < 900, `${moon.key} en x = ${moon.x.toFixed(0)}`);
  bd.setBiome('bamboo');
  bd.update(cam);
  check('retour à la forêt de bambous : couche proche à sa place historique, sans teinte', near.y === bambooNearY && near.key === 'bamboo' && near.tint === null);
  bd.setBiome('castle');
  bd.update(cam);
  check('château après le dojo : décalage habituel des couches posées (-130 px)', Math.abs(near.y - bambooNearY + 130) < 1e-9);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du terrain passent.');
