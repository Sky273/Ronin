import type { BiomeId } from '../../shared/biomes';
import { C } from './palette';

// Apparence du fond (Backdrop) pour chaque biome : teinte du papier, astre,
// chaînes de montagnes et couche proche. La forêt de bambous reprend exactement
// les paramètres historiques (mêmes clés de texture, mêmes graines).

/** Astre peint derrière les montagnes. */
export type OrbKind = 'sun' | 'dusk' | 'moon' | 'blood';

/** Couche proche, en parallaxe devant les montagnes. */
export type NearKind = 'bamboo' | 'roofs' | 'snowPines' | 'ramparts';

export interface MountainLook {
  seed: number;
  base: number;
  amp: number;
  alpha: number;
  pines: boolean;
  /** Abscisses (0..2048) des pagodes posées sur la crête. */
  pagodas: number[];
  /** Couleur d'encre de la chaîne (C.ink par défaut). */
  ink?: number;
  /** Neige sur les crêtes : épaisseur relative (0 = aucune). */
  snow?: number;
  /** Abscisses des donjons de château sur la crête. */
  castles?: number[];
  /** Abscisses des colonnes de fumée (village en feu), avec lueur à leur pied. */
  smoke?: number[];
}

export interface BiomeLook {
  /** Teinte multiplicative du papier et des couches (0xffffff = aucune). */
  paperTint: number;
  orb: OrbKind;
  /** Position de l'astre en fraction de l'écran. */
  orbPos: { x: number; y: number };
  far: MountainLook;
  mid: MountainLook;
  near: NearKind;
  /** Clés de texture des trois couches (distinctes par biome). */
  keys: { far: string; mid: string; near: string };
}

export const BIOME_LOOK: Record<BiomeId, BiomeLook> = {
  // Rendu historique : ne pas modifier.
  bamboo: {
    paperTint: 0xffffff,
    orb: 'sun',
    orbPos: { x: 0.72, y: 0.22 },
    far: { seed: 21, base: 330, amp: 230, alpha: 0.16, pines: false, pagodas: [] },
    mid: { seed: 42, base: 360, amp: 170, alpha: 0.26, pines: true, pagodas: [620, 1710] },
    near: 'bamboo',
    keys: { far: 'mFar', mid: 'mMid', near: 'bamboo' },
  },
  // Soleil couchant orangé et bas, collines basses, fumées et lueurs d'incendie.
  village: {
    paperTint: 0xf7e6d2,
    orb: 'dusk',
    orbPos: { x: 0.3, y: 0.4 },
    far: { seed: 23, base: 340, amp: 170, alpha: 0.15, pines: false, pagodas: [], ink: C.inkWarm, smoke: [380, 1450] },
    mid: { seed: 57, base: 370, amp: 120, alpha: 0.24, pines: true, pagodas: [1180], ink: C.inkWarm, smoke: [860, 1900] },
    near: 'roofs',
    keys: { far: 'mFar_village', mid: 'mMid_village', near: 'near_village' },
  },
  // Lune pâle, hautes cimes enneigées, pins chargés de neige.
  snow: {
    paperTint: 0xe9ecec,
    orb: 'moon',
    orbPos: { x: 0.78, y: 0.18 },
    far: { seed: 31, base: 330, amp: 270, alpha: 0.15, pines: false, pagodas: [], ink: C.inkCold, snow: 1 },
    mid: { seed: 64, base: 365, amp: 190, alpha: 0.24, pines: true, pagodas: [], ink: C.inkCold, snow: 0.6 },
    near: 'snowPines',
    keys: { far: 'mFar_snow', mid: 'mMid_snow', near: 'near_snow' },
  },
  // Grand soleil sang, donjons sur les crêtes, remparts au premier plan.
  castle: {
    paperTint: 0xefe7dc,
    orb: 'blood',
    orbPos: { x: 0.64, y: 0.2 },
    far: { seed: 27, base: 335, amp: 200, alpha: 0.15, pines: false, pagodas: [], castles: [1500] },
    mid: { seed: 71, base: 360, amp: 140, alpha: 0.25, pines: true, pagodas: [], castles: [700] },
    near: 'ramparts',
    keys: { far: 'mFar_castle', mid: 'mMid_castle', near: 'near_castle' },
  },
};

/** Clé de texture d'un astre (le soleil historique garde la clé `sun`). */
export function orbKey(kind: OrbKind): string {
  return kind === 'sun' ? 'sun' : `orb_${kind}`;
}
