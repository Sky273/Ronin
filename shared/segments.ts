import { type DecoKind, T_EMPTY, T_ONEWAY, T_SOLID } from './level';
import type { Rng } from './math';

// Catalogue de segments de niveau conçus à la main. Le générateur (levelgen.ts) les
// enchaîne de gauche à droite ; chacun respecte le même contrat de raccord :
// il commence et finit par au moins 2 tuiles plates sur la rangée du sol G, avec au
// moins 3 tuiles libres au-dessus. Coordonnées en tuiles, relatives au segment.
//
// Limites physiques respectées (voir constants.ts) : marche ≤ 3 tuiles en simple
// saut (le plus souvent 2), trou ≤ 4 tuiles, passage bas ≥ 1 tuile, aucun piège :
// on peut toujours se laisser tomber ou remonter par une marche.

/** Première rangée du sol. */
export const G = 18;
/** Hauteur des niveaux, en tuiles. */
export const LEVEL_H = 24;

export type SegmentId =
  | 'flat' | 'shallowPit' | 'steps' | 'onewayCluster' | 'plateau'
  | 'slideTunnel' | 'wallShaft' | 'doubleRoute' | 'pagodaStairs' | 'sanctuary';

/** Emplacement (colonne absolue, rangée de départ de la recherche du sol). */
export interface Slot {
  tx: number;
  fromRow: number;
}

export interface FixedDeco {
  kind: DecoKind;
  tx: number;
  s: number;
  fromRow: number;
}

/** Toile de tuiles d'un niveau en construction, plus les emplacements déclarés par les segments. */
export class Canvas {
  readonly w: number;
  readonly h: number;
  readonly tiles: Uint8Array;
  readonly enemySlots: Slot[] = [];
  readonly decoSlots: Slot[] = [];
  readonly fixedDecos: FixedDeco[] = [];
  /** Colonnes des sanctuaires. */
  readonly checkpoints: number[] = [];
  spawnTx = -1;
  arena: { col: number; triggerTx: number; guardianTx: number; gateTx: number } | null = null;

  constructor(w: number, h = LEVEL_H) {
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h);
    this.fill(0, G, w - 1, h - 1);
  }

  fill(x0: number, y0: number, x1: number, y1: number, t: number = T_SOLID): void {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.tiles[y * this.w + x] = t;
  }

  /** Première rangée « sol » de la colonne à partir de fromRow (solide, ou traversable si oneway). */
  surface(tx: number, fromRow: number, oneway: boolean): number {
    for (let y = Math.max(0, fromRow); y < this.h; y++) {
      const t = this.tiles[y * this.w + tx];
      if (t === T_SOLID || (oneway && t === T_ONEWAY)) return y;
    }
    return this.h;
  }
}

/** Vue d'un segment posé en colonne x0 : toutes les coordonnées sont relatives. */
export class SegView {
  readonly c: Canvas;
  readonly x0: number;
  constructor(c: Canvas, x0: number) {
    this.c = c;
    this.x0 = x0;
  }
  fill(a: number, y0: number, b: number, y1: number, t: number = T_SOLID): void {
    this.c.fill(this.x0 + a, y0, this.x0 + b, y1, t);
  }
  /** Plateforme traversable par le dessous. */
  plat(a: number, b: number, y: number): void {
    this.fill(a, y, b, y, T_ONEWAY);
  }
  /** Bloc posé sur le sol, de `height` tuiles de haut. */
  block(a: number, b: number, height: number): void {
    if (height > 0) this.fill(a, G - height, b, G - 1);
  }
  /** Fosse creusée dans le sol. */
  dig(a: number, b: number, depth: number): void {
    this.fill(a, G, b, G + depth - 1, T_EMPTY);
  }
  enemy(a: number, fromRow = 0): void {
    this.c.enemySlots.push({ tx: this.x0 + a, fromRow });
  }
  deco(a: number, fromRow = 0): void {
    this.c.decoSlots.push({ tx: this.x0 + a, fromRow });
  }
  decoRange(a: number, b: number, fromRow = 0): void {
    for (let x = a; x <= b; x++) this.deco(x, fromRow);
  }
  fixed(kind: DecoKind, a: number, s = 1, fromRow = 0): void {
    this.c.fixedDecos.push({ kind, tx: this.x0 + a, s, fromRow });
  }
  checkpoint(a: number): void {
    this.c.checkpoints.push(this.x0 + a);
  }
}

/** Segment instancié (paramètres tirés) : largeur connue, construction différée. */
export interface SegmentPiece {
  id: SegmentId | 'start' | 'finalArena';
  w: number;
  build(v: SegView): void;
}

export interface SegmentDef {
  id: SegmentId;
  /** 0 = facile, 2 = exigeant (tunnels, puits) : pondéré à la hausse avec l'étape. */
  tier: 0 | 1 | 2;
  /** Poids de base du tirage. */
  weight: number;
  make(rng: Rng, stage: number): SegmentPiece;
}

/** Entier uniforme dans [a, b]. */
export const randInt = (rng: Rng, a: number, b: number): number => a + Math.floor(rng.next() * (b - a + 1));

// ─── Segments tirés au hasard ───────────────────────────────────────────────

/** Sol plat (largeur 4-10, ou imposée) : respiration entre deux obstacles. */
export function flatPiece(width: number): SegmentPiece {
  const w = Math.max(4, width);
  return {
    id: 'flat',
    w,
    build(v) {
      v.decoRange(1, w - 2);
      if (w >= 6) v.enemy(Math.floor(w / 2));
    },
  };
}

const flat: SegmentDef = {
  id: 'flat',
  tier: 0,
  weight: 1.2,
  make: (rng) => flatPiece(randInt(rng, 4, 10)),
};

/** Fosse peu profonde : 2-4 tuiles de large, 2-3 de profondeur, on en ressort d'un saut. */
const shallowPit: SegmentDef = {
  id: 'shallowPit',
  tier: 1,
  weight: 1,
  make(rng, stage) {
    const pw = randInt(rng, 2, stage >= 3 ? 4 : 3);
    const depth = randInt(rng, 2, stage >= 2 ? 3 : 2);
    const m0 = randInt(rng, 3, 5);
    const m1 = randInt(rng, 3, 5);
    const w = m0 + pw + m1;
    return {
      id: 'shallowPit',
      w,
      build(v) {
        v.dig(m0, m0 + pw - 1, depth);
        v.enemy(1);
        v.enemy(w - 2);
        v.decoRange(1, m0 - 2);
        v.deco(m0 + (pw >> 1));
        v.decoRange(m0 + pw + 1, w - 2);
      },
    };
  },
};

/** Marches : montée puis descente, contremarches de 1-2 tuiles (sommet ≤ 5). */
const steps: SegmentDef = {
  id: 'steps',
  tier: 0,
  weight: 1.1,
  make(rng, stage) {
    const ups = randInt(rng, 1, stage >= 3 ? 3 : 2);
    const heights: number[] = [];
    let hgt = 0;
    for (let i = 0; i < ups; i++) {
      hgt = Math.min(5, hgt + randInt(rng, 1, 2));
      heights.push(hgt);
    }
    const treads = heights.map(() => randInt(rng, 2, 4));
    const top = randInt(rng, 2, 6);
    treads[treads.length - 1] += top;
    // Descente : soit d'un seul tenant, soit en marches symétriques.
    const sheer = rng.next() < 0.4;
    const downs = sheer ? [] : heights.slice(0, -1).reverse();
    const downTreads = downs.map(() => randInt(rng, 2, 3));
    const m0 = 2;
    const m1 = randInt(rng, 2, 4);
    const w = m0 + treads.reduce((a, b) => a + b, 0) + downTreads.reduce((a, b) => a + b, 0) + m1;
    return {
      id: 'steps',
      w,
      build(v) {
        let x = m0;
        heights.forEach((h, i) => {
          v.block(x, x + treads[i] - 1, h);
          v.decoRange(x, x + treads[i] - 1, G - h - 3);
          x += treads[i];
        });
        v.enemy(x - 2, G - hgt - 2);
        downs.forEach((h, i) => {
          v.block(x, x + downTreads[i] - 1, h);
          x += downTreads[i];
        });
        v.enemy(w - 2);
        v.deco(w - 2);
      },
    };
  },
};

/** Grappe de plateformes traversables au-dessus d'un sol plat (route haute facultative). */
const onewayCluster: SegmentDef = {
  id: 'onewayCluster',
  tier: 0,
  weight: 1,
  make(rng) {
    const n = randInt(rng, 2, 4);
    const plats: [number, number, number][] = [];
    let x = 2 + randInt(rng, 0, 2);
    let row = rng.next() < 0.5 ? 15 : 14;
    for (let i = 0; i < n; i++) {
      const len = randInt(rng, 3, 6);
      plats.push([x, x + len - 1, row]);
      x += len + randInt(rng, 1, 3);
      // Alternance haut / bas : chaque plateforme reste à ≤ 3 tuiles de la précédente.
      row = row >= 14 ? row - 3 : row + 3;
    }
    const w = x + 2;
    return {
      id: 'onewayCluster',
      w,
      build(v) {
        for (const [a, b, r] of plats) {
          v.plat(a, b, r);
          v.enemy((a + b) >> 1, r - 1);
        }
        v.enemy(1);
        v.decoRange(1, w - 2);
      },
    };
  },
};

/** Plateau plein (2-3 tuiles de haut), parfois précédé d'une demi-marche, avec une plateforme au-dessus. */
const plateau: SegmentDef = {
  id: 'plateau',
  tier: 1,
  weight: 1,
  make(rng, stage) {
    const hgt = stage >= 2 && rng.next() < 0.5 ? 3 : 2;
    const pre = hgt === 3 && rng.next() < 0.5 ? randInt(rng, 2, 3) : 0;
    const len = randInt(rng, 5, 12);
    const withPlat = len >= 7 && rng.next() < 0.6;
    const m0 = 2;
    const m1 = randInt(rng, 2, 4);
    const w = m0 + pre + len + m1;
    return {
      id: 'plateau',
      w,
      build(v) {
        if (pre) v.block(m0, m0 + pre - 1, 2);
        const a = m0 + pre;
        const b = a + len - 1;
        v.block(a, b, hgt);
        const top = G - hgt;
        if (withPlat) {
          v.plat(a + 2, Math.min(b - 1, a + 6), top - 4);
          v.enemy(a + 4, top - 5);
        }
        v.enemy(a + 1, top - 2);
        v.enemy(b - 1, top - 2);
        v.decoRange(a, b, top);
        v.deco(w - 2);
      },
    };
  },
};

/** Tunnel bas : passage d'1 tuile de haut sur 6-10 tuiles, glissade ou marche accroupie. */
const slideTunnel: SegmentDef = {
  id: 'slideTunnel',
  tier: 2,
  weight: 0.9,
  make(rng) {
    const len = randInt(rng, 6, 10);
    const top = randInt(rng, 8, 10); // bloc de 7 à 9 tuiles : trop haut, même en double saut
    const m0 = 3;
    const m1 = 3;
    const w = m0 + len + m1;
    return {
      id: 'slideTunnel',
      w,
      build(v) {
        v.fill(m0, top, m0 + len - 1, G - 2);
        // Ni ennemi ni décor dans le tunnel ; le bloc porte un décor à son sommet.
        v.enemy(1);
        v.enemy(w - 2);
        v.deco(1);
        v.deco(w - 1);
        v.deco(m0 + (len >> 1), top - 3);
      },
    };
  },
};

/**
 * Puits de wall-jump vers un plateau haut (comme les colonnes 94-128 historiques),
 * avec une route basse praticable dessous (5 tuiles de dégagement, une marche de 2).
 */
const wallShaft: SegmentDef = {
  id: 'wallShaft',
  tier: 2,
  weight: 0.8,
  make(rng) {
    const len = randInt(rng, 16, 28); // longueur du plateau haut
    const step = randInt(rng, 6, len - 6); // marche sous le plateau
    const m1 = 3;
    const w = 3 + 2 + 3 + len + m1;
    return {
      id: 'wallShaft',
      w,
      build(v) {
        const p0 = 8;
        const p1 = p0 + len - 1;
        v.fill(3, 4, 4, 12); // mur gauche du puits
        v.plat(5, 7, 15); // tremplin
        v.fill(p0, 8, p1, 12); // plateau haut
        v.plat(p0 + 5, p0 + 9, 5);
        if (len >= 22) v.plat(p0 + 15, p0 + 20, 4);
        v.fill(p0 + step, 16, p0 + step + 2, 17); // marche de la route basse
        v.enemy(1);
        v.enemy(p0 + 3, 13);
        v.enemy(p0 + step + 1, 13);
        v.enemy(p0 + 11, 6);
        v.enemy(p1 - 2, 6);
        v.decoRange(p0 + 1, p1 - 1, 6);
        v.deco(1);
        v.deco(w - 2);
      },
    };
  },
};

/** Double route : un obstacle au sol (bosse) et un pont de plateformes au-dessus. */
const doubleRoute: SegmentDef = {
  id: 'doubleRoute',
  tier: 1,
  weight: 0.9,
  make(rng) {
    const bridge = randInt(rng, 8, 14);
    const bump = randInt(rng, 3, 5);
    const w = 2 + 4 + bridge + 4 + 2;
    return {
      id: 'doubleRoute',
      w,
      build(v) {
        const b0 = 6;
        const b1 = b0 + bridge - 1;
        v.plat(2, 5, 15); // montée vers le pont
        v.plat(b0, b1, 12); // pont
        v.plat(b1 + 1, b1 + 4, 15); // descente
        const k0 = b0 + ((bridge - bump) >> 1);
        v.block(k0, k0 + bump - 1, 2); // bosse de la route basse (3 tuiles libres sous le pont)
        v.enemy(b0 + 2, 11);
        v.enemy(b1 - 2, 11);
        v.enemy(b0 + 1, 13);
        v.enemy(k0 + bump + 1, 13);
        v.deco(1);
        v.deco(w - 2);
      },
    };
  },
};

/** Escaliers de pagode : 2-3 paliers de 2 tuiles, terrasse, puis chute ou redescente. */
const pagodaStairs: SegmentDef = {
  id: 'pagodaStairs',
  tier: 1,
  weight: 0.9,
  make(rng) {
    const tiers = randInt(rng, 2, 3);
    const treads = Array.from({ length: tiers }, () => randInt(rng, 3, 5));
    const terrace = randInt(rng, 5, 12);
    const back = rng.next() < 0.5; // redescente par paliers plutôt qu'une chute
    const m1 = randInt(rng, 2, 4);
    const w = 2 + treads.reduce((a, b) => a + b, 0) + terrace + (back ? 2 * (tiers - 1) : 0) + m1;
    return {
      id: 'pagodaStairs',
      w,
      build(v) {
        let x = 2;
        for (let i = 0; i < tiers; i++) {
          const last = i === tiers - 1;
          const len = treads[i] + (last ? terrace : 0);
          v.block(x, x + len - 1, 2 * (i + 1));
          if (!last) v.enemy(x + 1, G - 2 * (i + 1) - 2);
          x += len;
        }
        const top = G - 2 * tiers;
        v.enemy(x - 3, top - 2);
        v.enemy(x - terrace + 1, top - 2);
        v.decoRange(x - terrace, x - 1, top - 1);
        if (back) {
          for (let i = tiers - 1; i >= 1; i--) {
            v.block(x, x + 1, 2 * i);
            x += 2;
          }
        }
        v.deco(w - 2);
      },
    };
  },
};

/** Sanctuaire : terrain plat et sûr (≥ 9 tuiles), point de réapparition au centre. */
const sanctuary: SegmentDef = {
  id: 'sanctuary',
  tier: 0,
  weight: 0,
  make(rng) {
    const w = randInt(rng, 9, 11);
    return {
      id: 'sanctuary',
      w,
      build(v) {
        v.checkpoint(4);
        v.fixed('shrine', 2, 0.8);
      },
    };
  },
};

/** Catalogue complet (le sanctuaire, de poids nul, n'est posé que par l'assembleur). */
export const SEGMENTS: Record<SegmentId, SegmentDef> = {
  flat, shallowPit, steps, onewayCluster, plateau, slideTunnel, wallShaft, doubleRoute, pagodaStairs, sanctuary,
};

// ─── Segments fixes ─────────────────────────────────────────────────────────

/** Départ : copie des colonnes 0-16 historiques (mur gauche, sanctuaire, torii, lanternes). */
export function startPiece(): SegmentPiece {
  return {
    id: 'start',
    w: 17,
    build(v) {
      v.fill(0, 0, 1, LEVEL_H - 1);
      v.c.spawnTx = v.x0 + 6;
      v.checkpoint(6);
      v.fixed('shrine', 3);
      v.fixed('lantern', 8);
      v.fixed('torii', 11);
      v.fixed('lantern', 14);
    },
  };
}

/**
 * Arène finale : sanctuaire d'approche sur 8 tuiles plates, puis copie relative exacte
 * des colonnes 163-223 historiques (escaliers de pagode, barrière en 186, arène à
 * plateformes, gardien en 211, porte en 218, mur droit). Relatif = historique - 155.
 */
export function finalArenaPiece(): SegmentPiece {
  const H = (hist: number) => hist - 155;
  return {
    id: 'finalArena',
    w: H(223) + 1,
    build(v) {
      v.checkpoint(4); // 27 tuiles avant la barrière (historique : 26)
      v.fill(H(165), 16, H(168), 17);
      v.fill(H(169), 14, H(172), 17);
      v.fill(H(173), 12, H(184), 17);
      v.plat(H(186), H(188), 15);
      v.plat(H(192), H(198), 14);
      v.plat(H(198), H(204), 10);
      v.plat(H(205), H(211), 14);
      v.fill(H(222), 0, H(223), LEVEL_H - 1);
      v.enemy(H(167), 15);
      v.enemy(H(175), 10);
      v.enemy(H(178), 10);
      v.enemy(H(181), 10);
      v.deco(H(163));
      v.deco(H(179), 10);
      v.deco(H(183), 10);
      v.fixed('torii', H(218), 0.9);
      v.c.arena = { col: v.x0 + H(186), triggerTx: v.x0 + H(189), guardianTx: v.x0 + H(211), gateTx: v.x0 + H(218) };
    },
  };
}
