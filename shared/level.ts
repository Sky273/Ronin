import { TILE } from './constants';
import type { BiomeId } from './biomes';
import type { EnemyType } from './types';

export const T_EMPTY = 0;
export const T_SOLID = 1;
export const T_ONEWAY = 2; // plateforme traversable par le dessous
/**
 * Kekkai à sens unique (coop) : barrière de l'arène qu'un joueur traverse vers l'intérieur (la droite)
 * mais ne peut plus repasser ; solide pour les ennemis, les orbes et les projectiles.
 */
export const T_KEKKAI = 3;

export type DecoKind = 'torii' | 'lantern' | 'bamboo' | 'pine' | 'stone' | 'banner' | 'shrine' | 'sakura' | 'house' | 'rampart';

export interface Deco {
  kind: DecoKind;
  x: number;
  y: number; // niveau du sol
  s: number; // échelle
}

export interface Level {
  /** Numéro d'étape (0 = forêt de bambous historique) et biome : toujours définis (Object.assign). */
  stage: number;
  biome: BiomeId;
  w: number;
  h: number;
  pxW: number;
  pxH: number;
  tiles: Uint8Array;
  spawn: { x: number; y: number };
  decos: Deco[];
  enemySpawns: { x: number; y: number; type: EnemyType }[];
  /** Sanctuaires : points de réapparition activés au passage. */
  checkpoints: { x: number; y: number }[];
  /** Arène du gardien : une barrière (colonne de tuiles) se referme derrière le joueur. */
  arena: { col: number; rows: number; trigger: number; guardianX: number; guardianY: number; backup: number[] };
  /** Porte de fin d'étape (torii scellé). */
  gate: { x: number; y: number };
}

/**
 * Arène fermée : `x1` et `x2` sont-ils de part et d'autre de la barrière (kekkai en coop, mur plein
 * en solo) ? Les sabres ne la traversent pas (ni ceux des joueurs, ni ceux des ennemis), pas plus
 * que les téléportations.
 */
export function kekkaiSplits(w: { stage: { state: string }; level: Level }, x1: number, x2: number): boolean {
  return w.stage.state === 'arena' && arenaInside(w.level, x1) !== arenaInside(w.level, x2);
}

/** `x` est-il dans l'arène du gardien (à droite de la barrière) ? */
export function arenaInside(l: Level, x: number): boolean {
  return x > (l.arena.col + 1) * TILE;
}

export function tileAt(l: Level, tx: number, ty: number): number {
  if (tx < 0 || tx >= l.w) return T_SOLID;
  if (ty < 0) return T_EMPTY;
  if (ty >= l.h) return T_SOLID;
  return l.tiles[ty * l.w + tx];
}

/**
 * Niveau de démonstration de la phase 1 : une longue bande horizontale qui
 * enseigne chaque mouvement (plateformes, fosse, tunnel à glissade, puits de
 * wall-jump, plateau supérieur, arènes).
 */
export function buildLevel(): Level {
  const w = 224;
  const h = 24;
  const G = 18; // première rangée du sol
  const tiles = new Uint8Array(w * h);

  const fill = (x0: number, y0: number, x1: number, y1: number, t: number = T_SOLID) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (x >= 0 && x < w && y >= 0 && y < h) tiles[y * w + x] = t;
  };
  const plat = (x0: number, x1: number, y: number) => fill(x0, y, x1, y, T_ONEWAY);

  fill(0, G, w - 1, h - 1);
  fill(0, 0, 1, h - 1);
  fill(w - 2, 0, w - 1, h - 1);

  // Zone 1 — sanctuaire et entraînement
  plat(17, 22, 15);
  plat(25, 30, 12);
  plat(33, 37, 15);
  // Zone 2 — marches, plateau, fosse peu profonde
  fill(42, 16, 45, 17);
  fill(46, 15, 60, 17);
  plat(50, 55, 11);
  fill(61, 18, 67, 20, T_EMPTY);
  // Zone 3 — tunnel bas : glissade (ou marche accroupie) obligatoire
  fill(76, 9, 84, 16);
  // Zone 4 — puits de wall-jump et plateau supérieur (route basse dessous)
  fill(94, 4, 95, 12);
  plat(96, 98, 15);
  fill(99, 8, 128, 12);
  plat(104, 108, 5);
  plat(114, 119, 4);
  fill(112, 16, 114, 17);
  // Zone 5 — arène à plateformes puis escaliers de pagode
  plat(136, 141, 14);
  plat(146, 152, 11);
  plat(156, 161, 14);
  fill(165, 16, 168, 17);
  fill(169, 14, 172, 17);
  fill(173, 12, 184, 17);
  plat(186, 188, 15);
  // Zone 6 — grande arène finale
  plat(192, 198, 14);
  plat(198, 204, 10);
  plat(205, 211, 14);

  const surface = (tx: number, fromRow: number, oneway: boolean): number => {
    for (let y = fromRow; y < h; y++) {
      const t = tiles[y * w + tx];
      if (t === T_SOLID || (oneway && t === T_ONEWAY)) return y * TILE;
    }
    return h * TILE;
  };

  const decos: Deco[] = [];
  const deco = (kind: DecoKind, tx: number, s = 1, fromRow = 0) =>
    decos.push({ kind, x: tx * TILE + TILE / 2, y: surface(tx, fromRow, false), s });

  deco('shrine', 3);
  deco('lantern', 8);
  deco('torii', 11);
  deco('lantern', 14);
  deco('bamboo', 21);
  deco('stone', 28, 0.8);
  deco('sakura', 32, 0.9);
  deco('bamboo', 39, 0.9);
  deco('banner', 44);
  deco('pine', 52, 0.9);
  deco('stone', 64, 1);
  deco('bamboo', 71, 1.1);
  deco('lantern', 74);
  deco('bamboo', 88);
  deco('pine', 104, 1);
  deco('pine', 122, 0.85);
  deco('stone', 118, 0.7, 13);
  deco('lantern', 126, 1, 13);
  deco('bamboo', 133, 1.1);
  deco('banner', 145);
  deco('stone', 154);
  deco('pine', 163, 1.1);
  deco('sakura', 179, 0.9);
  deco('lantern', 183);
  deco('bamboo', 190);
  deco('stone', 201, 0.9);
  deco('bamboo', 208, 1.2);
  deco('banner', 214);
  deco('torii', 218, 0.9);

  const enemySpawns: Level['enemySpawns'] = [];
  const es = (type: EnemyType, tx: number, fromRow = 0) =>
    enemySpawns.push({ type, x: tx * TILE + TILE / 2, y: surface(tx, fromRow, true) });

  es('ashigaru', 36, 16);
  es('ashigaru', 53, 12);
  es('archer', 58);
  es('ashigaru', 72);
  es('ashigaru', 88);
  es('archer', 110);
  es('archer', 124);
  es('ashigaru', 118, 13);
  es('oni', 140, 15);
  es('archer', 149);
  es('ninja', 158);
  es('oni', 175);
  es('archer', 181);
  es('ashigaru', 167);
  es('ninja', 178);

  const checkpoints = [6, 69, 131, 160].map((tx) => ({ x: tx * TILE + TILE / 2, y: surface(tx, 13, false) }));
  for (const c of checkpoints) decos.push({ kind: 'lantern', x: c.x, y: c.y, s: 1.35 });

  // Arène finale : la barrière tombe en colonne 186, le gardien attend au fond.
  const arenaCol = 186;
  const arena = {
    col: arenaCol,
    rows: G,
    trigger: 189 * TILE,
    guardianX: 211 * TILE + TILE / 2,
    guardianY: G * TILE,
    backup: Array.from({ length: G }, (_, r) => tiles[r * w + arenaCol]),
  };
  const gate = { x: 218 * TILE + TILE / 2, y: G * TILE };

  return {
    stage: 0,
    biome: 'bamboo',
    w,
    h,
    checkpoints,
    arena,
    gate,
    pxW: w * TILE,
    pxH: h * TILE,
    tiles,
    spawn: { x: 6 * TILE + TILE / 2, y: G * TILE },
    decos,
    enemySpawns,
  };
}
