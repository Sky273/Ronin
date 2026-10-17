import { TILE } from './constants';
import { type Level, T_EMPTY, T_KEKKAI, T_ONEWAY, T_SOLID, tileAt } from './level';
import type { Body } from './types';

// Physique AABB maison, résolue axe par axe sur la grille de tuiles.
// Simple, déterministe et précise : idéale pour un platformer en réseau.

export interface MoveResult {
  wall: -1 | 0 | 1;
  ceil: boolean;
}

/**
 * Déplace `b` axe par axe. `kekkaiIn` (joueurs en coop) : le kekkai se traverse vers la droite,
 * et ne bloque vers la gauche qu'un corps déjà entièrement de l'autre côté (à l'intérieur de l'arène).
 * Pour tous les autres corps il est solide. Sur l'axe vertical il est ignoré (barrière pleine hauteur).
 */
export function moveBody(b: Body, l: Level, dt: number, dropThrough: boolean, kekkaiIn = false): MoveResult {
  const res: MoveResult = { wall: 0, ceil: false };
  const hw = b.w / 2;

  // Axe X
  const dx = b.vx * dt;
  if (dx !== 0) {
    let nx = b.x + dx;
    const r0 = Math.floor((b.y - b.h + 0.01) / TILE);
    const r1 = Math.floor((b.y - 0.01) / TILE);
    if (dx > 0) {
      const c = Math.floor((nx + hw) / TILE);
      for (let r = r0; r <= r1; r++) {
        const t = tileAt(l, c, r);
        if (t === T_SOLID || (t === T_KEKKAI && !kekkaiIn)) {
          nx = c * TILE - hw - 0.001;
          b.vx = 0;
          res.wall = 1;
          break;
        }
      }
    } else {
      const c = Math.floor((nx - hw) / TILE);
      for (let r = r0; r <= r1; r++) {
        const t = tileAt(l, c, r);
        if (t === T_SOLID || (t === T_KEKKAI && (!kekkaiIn || insideOf(b.x - hw, c)))) {
          nx = (c + 1) * TILE + hw + 0.001;
          b.vx = 0;
          res.wall = -1;
          break;
        }
      }
    }
    b.x = nx;
  }

  // Axe Y
  const dy = b.vy * dt;
  const c0 = Math.floor((b.x - hw + 0.01) / TILE);
  const c1 = Math.floor((b.x + hw - 0.01) / TILE);
  let ny = b.y + dy;
  b.onGround = false;
  if (dy >= 0) {
    const r = Math.floor(ny / TILE);
    const rowTop = r * TILE;
    // On n'atterrit que si l'on vient d'au-dessus du bord de la rangée.
    if (rowTop >= b.y - 0.5) {
      for (let c = c0; c <= c1; c++) {
        const t = tileAt(l, c, r);
        if (t === T_SOLID || (t === T_ONEWAY && !dropThrough)) {
          ny = rowTop;
          b.vy = 0;
          b.onGround = true;
          break;
        }
      }
    }
  } else {
    const r = Math.floor((ny - b.h) / TILE);
    for (let c = c0; c <= c1; c++) {
      if (tileAt(l, c, r) === T_SOLID) {
        ny = (r + 1) * TILE + b.h + 0.001;
        b.vy = 0;
        res.ceil = true;
        break;
      }
    }
    // Le haut du niveau est un plafond (tileAt est vide au-dessus de la rangée 0) : sans lui, un mur
    // escaladé de saut en saut menait hors de l'écran, par-dessus la barrière de l'arène.
    if (ny - b.h < 0) {
      ny = b.h;
      b.vy = 0;
      res.ceil = true;
    }
  }
  b.y = ny;
  return res;
}

/** Bord gauche `left` entièrement à droite de la colonne `c` (côté intérieur du kekkai) ? */
const insideOf = (left: number, c: number): boolean => left >= (c + 1) * TILE - 0.01;

/** Tuile pleine pour un projectile (le kekkai arrête les flèches dans les deux sens). */
export function solidAt(l: Level, x: number, y: number): boolean {
  const t = tileAt(l, Math.floor(x / TILE), Math.floor(y / TILE));
  return t === T_SOLID || t === T_KEKKAI;
}

export function groundAt(l: Level, x: number, y: number): boolean {
  const t = tileAt(l, Math.floor(x / TILE), Math.floor(y / TILE));
  return t !== T_EMPTY && t !== T_KEKKAI;
}

/** Mur au contact du côté `dir` ? Le kekkai en est un, sauf pour un joueur (`kekkaiIn`) qui va vers l'intérieur. */
export function touchingWall(b: Body, l: Level, dir: number, kekkaiIn = false): boolean {
  const x = dir > 0 ? b.x + b.w / 2 + 1 : b.x - b.w / 2 - 1;
  const c = Math.floor(x / TILE);
  const wall = (t: number) => t === T_SOLID || (t === T_KEKKAI && !(kekkaiIn && dir > 0));
  return wall(tileAt(l, c, Math.floor((b.y - b.h * 0.75) / TILE))) || wall(tileAt(l, c, Math.floor((b.y - b.h * 0.35) / TILE)));
}

/**
 * Un déplacement direct (sans moveBody, ex. l'iai) de `x` vers `nx` ferait-il ressortir du kekkai
 * un corps (`hw` : demi-largeur, pieds en `y`, hauteur `h`) déjà entièrement à l'intérieur ?
 */
export function crossesKekkaiOut(l: Level, x: number, nx: number, y: number, hw: number, h: number): boolean {
  if (nx >= x) return false;
  const c = Math.floor((nx - hw) / TILE);
  if (!insideOf(x - hw, c)) return false;
  const r0 = Math.floor((y - h + 0.01) / TILE);
  const r1 = Math.floor((y - 0.01) / TILE);
  for (let r = r0; r <= r1; r++) if (tileAt(l, c, r) === T_KEKKAI) return true;
  return false;
}

/** Le rectangle (x, y=pieds, w, h) est-il libre de tuiles solides ? */
export function fitsAt(l: Level, x: number, y: number, w: number, h: number): boolean {
  const c0 = Math.floor((x - w / 2 + 0.01) / TILE);
  const c1 = Math.floor((x + w / 2 - 0.01) / TILE);
  const r0 = Math.floor((y - h + 0.01) / TILE);
  const r1 = Math.floor((y - 0.01) / TILE);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (tileAt(l, c, r) === T_SOLID) return false;
  return true;
}

export function canFit(b: Body, l: Level, h: number): boolean {
  return fitsAt(l, b.x, b.y, b.w, h);
}

export function standingOnOneWay(b: Body, l: Level): boolean {
  if (!b.onGround) return false;
  const r = Math.floor((b.y + 0.5) / TILE);
  const c0 = Math.floor((b.x - b.w / 2 + 0.01) / TILE);
  const c1 = Math.floor((b.x + b.w / 2 - 0.01) / TILE);
  let oneway = false;
  for (let c = c0; c <= c1; c++) {
    const t = tileAt(l, c, r);
    if (t === T_SOLID) return false;
    if (t === T_ONEWAY) oneway = true;
  }
  return oneway;
}

export function groundAhead(b: Body, l: Level, dir: number): boolean {
  return groundAt(l, b.x + dir * (b.w / 2 + 4), b.y + 2);
}
