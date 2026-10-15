import type { Rect } from './math';
import type { Body, Player } from './types';
import { reachMult } from './upgrades';

export type AttackId = 'slash1' | 'slash2' | 'slash3' | 'upSlash' | 'airSlash' | 'plunge';

/**
 * Données de frame des attaques (en ticks à 60 Hz).
 * hb : hitbox relative aux pieds — x = bord proche, orienté selon facing.
 */
export interface AttackDef {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  hb: Rect;
  kbx: number;
  kby: number;
  hitstop: number;
  lunge: number;
  cut: number; // angle de la coupe (pour la découpe visuelle)
  next: AttackId | null;
  heavy: boolean;
  air: boolean;
}

export const ATTACKS: Record<AttackId, AttackDef> = {
  slash1: {
    startup: 5, active: 4, recovery: 13, damage: 12, hb: { x: 2, y: -52, w: 54, h: 46 },
    kbx: 110, kby: -120, hitstop: 4, lunge: 170, cut: 0.6, next: 'slash2', heavy: false, air: false,
  },
  slash2: {
    startup: 4, active: 5, recovery: 13, damage: 12, hb: { x: 0, y: -68, w: 52, h: 64 },
    kbx: 120, kby: -380, hitstop: 5, lunge: 150, cut: -0.9, next: 'slash3', heavy: false, air: false,
  },
  slash3: {
    startup: 9, active: 5, recovery: 22, damage: 24, hb: { x: 0, y: -60, w: 72, h: 58 },
    kbx: 520, kby: -220, hitstop: 9, lunge: 420, cut: 1.1, next: null, heavy: true, air: false,
  },
  upSlash: {
    startup: 4, active: 6, recovery: 14, damage: 14, hb: { x: -18, y: -102, w: 58, h: 68 },
    kbx: 60, kby: -560, hitstop: 5, lunge: 40, cut: -1.4, next: null, heavy: false, air: false,
  },
  airSlash: {
    startup: 3, active: 5, recovery: 11, damage: 12, hb: { x: 0, y: -62, w: 58, h: 58 },
    kbx: 200, kby: -180, hitstop: 4, lunge: 0, cut: 0.9, next: null, heavy: false, air: true,
  },
  plunge: {
    startup: 6, active: 999, recovery: 12, damage: 18, hb: { x: -16, y: -14, w: 32, h: 34 },
    kbx: 120, kby: -300, hitstop: 6, lunge: 0, cut: 1.5, next: null, heavy: true, air: true,
  },
};

export function boxFromFacing(x: number, y: number, facing: number, hb: Rect): Rect {
  const left = facing > 0 ? x + hb.x : x - hb.x - hb.w;
  return { x: left, y: y + hb.y, w: hb.w, h: hb.h };
}

export function bodyRect(b: Body): Rect {
  return { x: b.x - b.w / 2, y: b.y - b.h, w: b.w, h: b.h };
}

/** Hitbox active du joueur à ce tick (null hors frames actives). Sert aussi au debug. */
export function activeAttackBox(p: Player): Rect | null {
  if (p.state !== 'attack' || !p.attack) return null;
  const d = ATTACKS[p.attack];
  if (p.attack === 'plunge') {
    return p.stateT > d.startup && !p.plungeLanded ? boxFromFacing(p.x, p.y, p.facing, d.hb) : null;
  }
  if (p.stateT > d.startup && p.stateT <= d.startup + d.active) {
    const k = reachMult(p);
    return boxFromFacing(p.x, p.y, p.facing, { ...d.hb, w: d.hb.w * k });
  }
  return null;
}
