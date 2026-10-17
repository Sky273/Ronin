// Le dojo (道場) : salle plate et close où se joue le tournoi. Quatre tatamis pour les quarts,
// les deux du centre pour les demies, la finale au milieu de la salle.
import { TILE } from './constants';
import { type Deco, type Level, T_SOLID } from './level';

/** Numéro d'étape du dojo (hors du voyage : jamais une étape de la route). */
export const DOJO_STAGE = -1;

const W = 56; // largeur (tuiles)
const H = 24;
const G = 18; // première rangée du plancher
const TATAMI0 = 10; // colonne du premier tatami
const TATAMI_GAP = 11; // écart entre deux tatamis (tuiles)

/** Centres (px) des quatre tatamis, de gauche à droite. */
export const DOJO_TATAMIS: readonly number[] = [0, 1, 2, 3].map((i) => (TATAMI0 + TATAMI_GAP * i) * TILE + TILE / 2);
/** Centre (px) du tatami de la finale, au milieu de la salle. */
export const DOJO_FINAL_X = (DOJO_TATAMIS[1] + DOJO_TATAMIS[2]) / 2;

export function buildDojo(): Level {
  const tiles = new Uint8Array(W * H);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles[y * W + x] = T_SOLID;
  };
  fill(0, G, W - 1, H - 1); // plancher
  fill(0, 0, 1, H - 1); // murs
  fill(W - 2, 0, W - 1, H - 1);

  const floor = G * TILE;
  const decos: Deco[] = [
    { kind: 'lantern', x: 3 * TILE, y: floor, s: 1.1 },
    { kind: 'rack', x: 6 * TILE, y: floor, s: 1 },
    { kind: 'banner', x: 16 * TILE, y: floor, s: 1 },
    { kind: 'scroll', x: DOJO_FINAL_X, y: floor, s: 1.2 },
    { kind: 'banner', x: 38 * TILE, y: floor, s: 1 },
    { kind: 'rack', x: 50 * TILE, y: floor, s: 1 },
    { kind: 'lantern', x: 53 * TILE, y: floor, s: 1.1 },
  ];
  const spawn = { x: 4 * TILE + TILE / 2, y: floor };
  // Pas d'arène : la colonne de la « barrière » est le mur de droite, inchangée (setBarrier la remet à
  // l'identique à chaque instantané), et son déclencheur est hors d'atteinte.
  const col = W - 2;
  return {
    stage: DOJO_STAGE,
    biome: 'dojo',
    w: W,
    h: H,
    pxW: W * TILE,
    pxH: H * TILE,
    tiles,
    spawn,
    decos,
    enemySpawns: [],
    checkpoints: [spawn],
    arena: {
      col,
      rows: G,
      trigger: (W + 100) * TILE,
      guardianX: (W - 1) * TILE,
      guardianY: floor,
      backup: Array.from({ length: G }, (_, r) => tiles[r * W + col]),
    },
    gate: { x: (W + 100) * TILE, y: floor },
  };
}

/**
 * Centre au sol du duel d'un match : quart `k` sur le tatami k, demie `k` sur les tatamis du centre,
 * finale au milieu de la salle.
 */
export function dojoSpot(round: number, k: number): { x: number; y: number } {
  const x = round === 0 ? DOJO_TATAMIS[k] : round === 1 ? DOJO_TATAMIS[1 + k] : DOJO_FINAL_X;
  return { x, y: G * TILE };
}

/** Place d'arrivée dans le dojo : étalée près de l'entrée (hachage de l'id, sans w.rng). */
export function dojoArrival(id: number): { x: number; y: number } {
  return { x: (3 + ((id * 7) % 6)) * TILE + TILE / 2, y: G * TILE };
}
