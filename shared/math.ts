export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Rapproche v de target d'au plus delta. */
export function approach(v: number, target: number, delta: number): number {
  return v < target ? Math.min(v + delta, target) : Math.max(v - delta, target);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** PRNG déterministe (mulberry32) — indispensable pour une simulation rejouable côté serveur. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/** Graine d'une étape : hachage pur de la graine du monde et du numéro d'étape
 *  (indépendant du déroulé de la partie, donc reproductible côté serveur). */
export function stageSeed(seed: number, stage: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((stage | 0) + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0 || 1;
}
