import { TILE } from './constants';
import { type Level, T_EMPTY, T_ONEWAY, T_SOLID, tileAt } from './level';

// Vérifications statiques d'un niveau : cohérence des champs (validateLevel) et
// franchissabilité prudente (reachable), sans double saut ni saut mural.

const isSolid = (l: Level, x: number, y: number) => tileAt(l, x, y) === T_SOLID;
const isFloor = (l: Level, x: number, y: number) => tileAt(l, x, y) !== T_EMPTY;
const isFree = (l: Level, x: number, y: number) => !isSolid(l, x, y);

/** Toutes les rangées y0..y1 (incluses, y0 ≤ y1) de la colonne x sont-elles sans tuile solide ? */
function clearCol(l: Level, x: number, y0: number, y1: number): boolean {
  for (let y = y0; y <= y1; y++) if (isSolid(l, x, y)) return false;
  return true;
}

/** Liste des incohérences du niveau (vide = niveau valide). */
export function validateLevel(l: Level): string[] {
  const err: string[] = [];
  if (l.h !== 24) err.push(`hauteur ${l.h} ≠ 24`);
  if (l.tiles.length !== l.w * l.h) err.push('taille des tuiles incohérente');
  if (l.pxW !== l.w * TILE || l.pxH !== l.h * TILE) err.push('pxW/pxH incohérents');
  for (let y = 0; y < l.h; y++) {
    for (const x of [0, 1, l.w - 2, l.w - 1]) if (!isSolid(l, x, y)) {
      err.push(`mur de bord ouvert en (${x}, ${y})`);
      y = l.h;
      break;
    }
  }

  /** (x, y) en pixels est-il posé sur du sol, avec 2 tuiles vides au-dessus ? */
  const onFloor = (what: string, x: number, y: number, oneway: boolean) => {
    const tx = Math.floor(x / TILE);
    const ty = y / TILE;
    if (!Number.isInteger(ty)) return err.push(`${what} : y=${y} hors grille`);
    const t = tileAt(l, tx, ty);
    if (!(t === T_SOLID || (oneway && t === T_ONEWAY))) return err.push(`${what} : pas de sol en (${tx}, ${ty})`);
    if (tileAt(l, tx, ty - 1) !== T_EMPTY || tileAt(l, tx, ty - 2) !== T_EMPTY) err.push(`${what} : pas de place au-dessus de (${tx}, ${ty})`);
    return 0;
  };

  onFloor('départ', l.spawn.x, l.spawn.y, false);
  const a = l.arena;
  const cps = l.checkpoints;
  if (!cps.length) err.push('aucun sanctuaire');
  else if (cps[0].x !== l.spawn.x || cps[0].y !== l.spawn.y) err.push('le premier sanctuaire n’est pas le départ');
  cps.forEach((c, i) => {
    onFloor(`sanctuaire ${i}`, c.x, c.y, false);
    if (i > 0 && c.x <= cps[i - 1].x) err.push(`sanctuaires non triés (${i})`);
    if (i > 0 && c.x - cps[i - 1].x > 70 * TILE) err.push(`sanctuaires ${i - 1}→${i} trop éloignés (${Math.round((c.x - cps[i - 1].x) / TILE)} tuiles)`);
    if (c.x >= a.col * TILE) err.push(`sanctuaire ${i} dans l’arène`);
  });

  if (!l.enemySpawns.some((e) => e.type === 'ashigaru')) err.push('aucun ashigaru');
  l.enemySpawns.forEach((e, i) => {
    onFloor(`ennemi ${i} (${e.type})`, e.x, e.y, true);
    if (e.x >= (a.col - 3) * TILE) err.push(`ennemi ${i} trop près de l’arène`);
    if (Math.abs(e.x - l.spawn.x) < 10 * TILE) err.push(`ennemi ${i} trop près du départ`);
  });

  // Arène : barrière, sol plat jusqu'après la porte, déclencheur, gardien, porte.
  const gy = a.rows;
  const gateTx = Math.floor(l.gate.x / TILE);
  if (a.backup.length !== a.rows) err.push('sauvegarde de barrière incomplète');
  else if (a.backup.some((t, r) => t !== l.tiles[r * l.w + a.col])) err.push('sauvegarde de barrière ≠ tuiles');
  if (!clearCol(l, a.col, 0, gy - 1) || !isSolid(l, a.col, gy)) err.push('colonne de barrière obstruée ou sans sol');
  for (let x = a.col + 1; x <= gateTx + 2; x++) {
    if (!isSolid(l, x, gy) || !clearCol(l, x, 0, gy - 1)) {
      err.push(`arène non plate en colonne ${x}`);
      break;
    }
  }
  if (gateTx - a.col < 30) err.push(`arène trop étroite (${gateTx - a.col})`);
  if (gateTx + 2 >= l.w - 2) err.push('porte collée au mur droit');
  if (a.trigger <= (a.col + 1) * TILE || a.trigger >= a.guardianX) err.push('déclencheur d’arène mal placé');
  onFloor('gardien', a.guardianX, a.guardianY, false);
  onFloor('porte', l.gate.x, l.gate.y, false);
  if (a.guardianY !== gy * TILE || l.gate.y !== gy * TILE) err.push('gardien ou porte hors du sol de l’arène');
  return err;
}

/**
 * Franchissabilité prudente. Graphe des cases où l'on peut se tenir (debout ou accroupi),
 * mouvements : marcher, tomber, monter ≤ 3 tuiles, sauter un trou ≤ 4 tuiles, traverser
 * une plateforme par le dessous, descendre d'une plateforme, couloir d'1 tuile accroupi.
 * Garantit (i) porte atteignable depuis le départ, (ii) aucune impasse depuis une case
 * atteignable, (iii) aucune case du niveau d'où la porte serait inaccessible (même
 * celles qu'on n'atteint qu'en double saut ou saut mural).
 */
export function reachable(l: Level): { ok: boolean; reason?: string } {
  const { w, h } = l;
  const node = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h && isFloor(l, x, y) && isFree(l, x, y - 1);
  const stand = (x: number, y: number) => node(x, y) && isFree(l, x, y - 2);
  const id = (x: number, y: number) => y * w + x;
  const adj: number[][] = [];
  const radj: number[][] = [];
  const edge = (a: number, b: number) => {
    (adj[a] ??= []).push(b);
    (radj[b] ??= []).push(a);
  };
  /** Première rangée de sol strictement sous y dans la colonne x (h si aucune). */
  const landing = (x: number, y: number) => {
    for (let r = y + 1; r < h; r++) if (isFloor(l, x, r)) return r;
    return h;
  };
  const nodes: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!node(x, y)) continue;
      const from = id(x, y);
      nodes.push(from);
      const up = stand(x, y);
      for (const s of [-1, 1]) {
        const nx = x + s;
        // Marcher (debout ou accroupi).
        if (node(nx, y)) edge(from, id(nx, y));
        // Se laisser tomber du bord.
        else if (nx >= 0 && nx < w && tileAt(l, nx, y) === T_EMPTY && isFree(l, nx, y - 1)) {
          const r = landing(nx, y);
          if (r < h && node(nx, r)) edge(from, id(nx, r));
        }
      }
      // Descendre d'une plateforme traversable (↓ + saut).
      if (tileAt(l, x, y) === T_ONEWAY) {
        const r = landing(x, y);
        if (r < h && node(x, r)) edge(from, id(x, r));
      }
      if (!up) continue;
      // Sauter vers le haut (≤ 3 tuiles), sur place (à travers une plateforme) ou d'une colonne.
      for (let k = 1; k <= 3; k++) {
        if (!clearCol(l, x, y - k - 2, y - 1)) break;
        for (const d of [-1, 0, 1]) if (stand(x + d, y - k)) edge(from, id(x + d, y - k));
      }
      // Sauter par-dessus un trou (≤ 4 tuiles), atterrissage de 1 plus haut à 2 plus bas.
      if (!clearCol(l, x, y - 5, y - 1)) continue;
      for (const s of [-1, 1]) {
        for (let d = 1; d <= 5; d++) {
          const nx = x + s * d;
          if (nx < 0 || nx >= w) break;
          if (d >= 2) {
            for (let ty = y - 1; ty <= y + 2; ty++) {
              if (ty === y - 1 && d > 4) continue;
              if (stand(nx, ty) && clearCol(l, nx, y - 5, ty - 1)) edge(from, id(nx, ty));
            }
          }
          if (!clearCol(l, nx, y - 5, y - 1)) break; // un mur coupe la trajectoire
        }
      }
    }
  }

  const sx = Math.floor(l.spawn.x / TILE);
  const sy = Math.round(l.spawn.y / TILE);
  const gx = Math.floor(l.gate.x / TILE);
  const gy = Math.round(l.gate.y / TILE);
  if (!node(sx, sy)) return { ok: false, reason: `départ hors sol (${sx}, ${sy})` };
  if (!node(gx, gy)) return { ok: false, reason: `porte hors sol (${gx}, ${gy})` };

  const bfs = (start: number, g: number[][]) => {
    const seen = new Uint8Array(w * h);
    const queue = [start];
    seen[start] = 1;
    for (let i = 0; i < queue.length; i++) {
      for (const n of g[queue[i]] ?? []) if (!seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
    return seen;
  };
  const fwd = bfs(id(sx, sy), adj);
  if (!fwd[id(gx, gy)]) {
    let far = sx;
    for (const n of nodes) if (fwd[n]) far = Math.max(far, n % w);
    return { ok: false, reason: `porte inaccessible (progression bloquée vers la colonne ${far})` };
  }
  const back = bfs(id(gx, gy), radj);
  for (const n of nodes) {
    if (!back[n]) {
      const where = `(${n % w}, ${Math.floor(n / w)})`;
      return { ok: false, reason: fwd[n] ? `impasse atteignable en ${where}` : `piège en ${where}` };
    }
  }
  return { ok: true };
}
