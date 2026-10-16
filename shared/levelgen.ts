import { BIOMES, type BiomeId } from './biomes';
import { TILE } from './constants';
import type { Deco, DecoKind, Level } from './level';
import { Rng } from './math';
import {
  Canvas, finalArenaPiece, flatPiece, G, randInt, SEGMENTS, type SegmentDef, type SegmentId,
  type SegmentPiece, SegView, startPiece,
} from './segments';
import type { EnemyType } from './types';

// Assembleur de niveaux : enchaîne des segments faits main (segments.ts) de façon
// strictement déterministe (une seule source de hasard : new Rng(seed)).
// Départ → segments tirés (pondérés par difficulté) entrecoupés de sanctuaires → arène.

/** Largeur des segments fixes. */
const START_W = 17;
const FINAL_W = 69;
/** Plafond des segments exigeants par niveau. */
const MAX_OF: Partial<Record<SegmentId, number>> = { slideTunnel: 2, wallShaft: 2 };
const MAX_HARD = 3;
/** Écart maximal (en tuiles) entre deux sanctuaires consécutifs. */
const MAX_CP_GAP = 62;
/** Écart minimal entre deux sanctuaires tirés. */
const MIN_CP_GAP = 35;

/** Tirage pondéré dans une liste [valeur, poids]. */
export function pickWeighted<T>(rng: Rng, list: [T, number][]): T {
  let total = 0;
  for (const [, v] of list) total += v;
  let r = rng.next() * total;
  for (const [t, v] of list) {
    if ((r -= v) <= 0) return t;
  }
  return list[list.length - 1][0];
}

/** Poids d'un segment à une étape donnée : les tiers difficiles montent avec l'étape. */
function segWeight(d: SegmentDef, stage: number): number {
  const s = Math.min(stage, 8);
  const f = d.tier === 0 ? 1 : d.tier === 1 ? 0.6 + 0.15 * s : 0.25 + 0.15 * s;
  return d.weight * f;
}

/** Largeur visée d'une étape (tuiles). L'assemblage peut dépasser de quelques tuiles
 *  (dernier segment toléré à +4, fusion des plats) : largeurs réelles ≈ 200-262. */
export function targetWidth(rng: Rng, stage: number): number {
  const base = 190 + 10 * Math.min(Math.max(stage, 1), 6);
  return Math.max(208, Math.min(258, base + randInt(rng, -6, 12)));
}

/**
 * Plan d'une étape : la liste ordonnée des segments (départ, segments, sanctuaires, arène).
 * Consomme le hasard de `rng` ; deux appels avec des Rng identiques donnent le même plan.
 */
export function planSegments(rng: Rng, stage: number): SegmentPiece[] {
  const wTarget = targetWidth(rng, stage);
  const middleEnd = wTarget - FINAL_W; // colonne où commence l'arène finale
  // Sanctuaires prévus : intervalles réguliers (≥ 3) entre le départ et l'arène.
  const span = middleEnd + 4 - 6;
  const n = Math.max(3, Math.round(span / 52));
  const planned: number[] = [];
  for (let i = 1; i < n; i++) planned.push(Math.round(6 + (span * i) / n) + randInt(rng, -3, 3));

  const pieces: SegmentPiece[] = [startPiece()];
  const counts: Partial<Record<SegmentId, number>> = {};
  let hard = 0;
  let cursor = START_W;
  let lastCp = 6;
  let last: string = 'start';
  let next = 0;
  const pool = (Object.values(SEGMENTS) as SegmentDef[]).filter((d) => d.weight > 0);

  while (cursor < middleEnd) {
    const remaining = middleEnd - cursor;
    // Tirage d'un segment admissible : pas deux fois le même d'affilée, plafonds, largeur.
    const choices: [SegmentDef, number][] = pool
      .filter((d) => d.id !== last && (counts[d.id] ?? 0) < (MAX_OF[d.id] ?? 99) && (d.tier < 2 || hard < MAX_HARD))
      .map((d) => [d, segWeight(d, stage)]);
    let piece: SegmentPiece | null = null;
    for (let attempt = 0; attempt < 4 && !piece; attempt++) {
      const p = pickWeighted(rng, choices).make(rng, stage);
      if (p.w <= remaining + 4) piece = p;
    }
    // Repli : un plat qui comble le reste (fusionné avec le précédent s'il en sortait déjà un).
    if (!piece) {
      const fill = Math.max(4, Math.min(10, remaining));
      if (last === 'flat') {
        const prev = pieces.pop() as SegmentPiece;
        cursor -= prev.w;
        piece = flatPiece(prev.w + fill);
      } else piece = flatPiece(fill);
    }

    // Sanctuaire dû avant ce segment ?
    const since = cursor + 4 - lastCp;
    const due = (since >= MIN_CP_GAP && next < planned.length && cursor + piece.w + 4 > planned[next]) || cursor + piece.w + 4 - lastCp > MAX_CP_GAP;
    if (due) {
      if (remaining < 12) break; // le sanctuaire d'approche de l'arène fera l'affaire
      const s = SEGMENTS.sanctuary.make(rng, stage);
      pieces.push(s);
      lastCp = cursor + 4;
      cursor += s.w;
      last = 'sanctuary';
      while (next < planned.length && planned[next] < lastCp + MIN_CP_GAP) next++;
      continue;
    }
    pieces.push(piece);
    counts[piece.id as SegmentId] = (counts[piece.id as SegmentId] ?? 0) + 1;
    if (piece.id === 'slideTunnel' || piece.id === 'wallShaft') hard++;
    cursor += piece.w;
    last = piece.id;
  }
  pieces.push(finalArenaPiece());
  return pieces;
}

/** Nombre d'ennemis de départ visé (densité comparable au niveau historique : 15). */
function enemyCount(rng: Rng, stage: number): number {
  return 14 + randInt(rng, 0, 4) + (stage >= 4 ? 1 : 0) + (stage >= 7 ? 1 : 0);
}

/**
 * Construit le niveau complet à partir d'un plan : tuiles, sanctuaires, arène, puis
 * décors et ennemis tirés dans les emplacements déclarés par les segments.
 */
export function assembleLevel(pieces: SegmentPiece[], rng: Rng, stage: number, biome: BiomeId): Level {
  const w = pieces.reduce((a, p) => a + p.w, 0);
  const c = new Canvas(w);
  let x = 0;
  for (const p of pieces) {
    p.build(new SegView(c, x));
    x += p.w;
  }
  // Murs de bord (déjà posés par le départ et l'arène, réaffirmés par sûreté).
  c.fill(0, 0, 1, c.h - 1);
  c.fill(w - 2, 0, w - 1, c.h - 1);
  if (!c.arena || c.spawnTx < 0) throw new Error('plan sans départ ni arène');
  const ar = c.arena;
  const h = c.h;
  const center = (tx: number) => tx * TILE + TILE / 2;

  // Sanctuaires (triés) + leur lanterne.
  const cps = [...c.checkpoints].sort((a, b) => a - b);
  const checkpoints = cps.map((tx) => ({ x: center(tx), y: c.surface(tx, 0, false) * TILE }));
  const decos: Deco[] = checkpoints.map((cp) => ({ kind: 'lantern' as DecoKind, x: cp.x, y: cp.y, s: 1.35 }));
  for (const f of c.fixedDecos) decos.push({ kind: f.kind, x: center(f.tx), y: c.surface(f.tx, f.fromRow, false) * TILE, s: f.s });

  // Décors du biome : au sol, espacés, jamais sur un sanctuaire ni dans l'arène.
  const decoList = BIOMES[biome].decos;
  const slots = [...c.decoSlots].sort((a, b) => a.tx - b.tx || a.fromRow - b.fromRow);
  // Maisons et remparts sont larges (jusqu'à ~7 tuiles) : plus d'espace, et un sol plat dessous.
  const WIDE: DecoKind[] = ['house', 'rampart'];
  let lastDeco = -99;
  let lastWide = false;
  for (const s of slots) {
    if (s.tx >= ar.col || s.tx - lastDeco < 3) continue;
    if (cps.some((cp) => Math.abs(cp - s.tx) <= 2)) continue;
    if (rng.next() > 0.42) continue;
    const kind: DecoKind = pickWeighted(rng, decoList);
    const scale = Math.round((0.8 + rng.next() * 0.4) * 100) / 100;
    const wide = WIDE.includes(kind);
    if ((wide || lastWide) && s.tx - lastDeco < 7) continue;
    const row = c.surface(s.tx, s.fromRow, false);
    if (wide) {
      let flat = s.tx + 3 < ar.col;
      for (let d = -3; d <= 3 && flat; d++) if (c.surface(s.tx + d, s.fromRow, false) !== row) flat = false;
      if (!flat) continue;
    }
    decos.push({ kind, x: center(s.tx), y: row * TILE, s: scale });
    lastDeco = s.tx;
    lastWide = wide;
  }

  // Ennemis : emplacements admissibles (loin du départ, avant l'arène, un seul par colonne et rangée).
  const seen = new Set<number>();
  const eligible: { tx: number; row: number }[] = [];
  for (const s of c.enemySlots) {
    const row = c.surface(s.tx, s.fromRow, true);
    const key = row * w + s.tx;
    if (row >= h || seen.has(key)) continue;
    if (s.tx - c.spawnTx < 10 || s.tx >= ar.col - 3) continue;
    seen.add(key);
    eligible.push({ tx: s.tx, row });
  }
  // Mélange de Fisher-Yates, puis tri par abscisse des élus.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const chosen = eligible.slice(0, Math.min(eligible.length, enemyCount(rng, stage)));
  chosen.sort((a, b) => a.tx - b.tx || a.row - b.row);
  const enemyList = BIOMES[biome].enemies;
  const enemySpawns: Level['enemySpawns'] = chosen.map((e) => ({ x: center(e.tx), y: e.row * TILE, type: pickWeighted<EnemyType>(rng, enemyList) }));
  // Toujours au moins un ashigaru (et c'est lui qui ouvre le bal).
  if (enemySpawns.length && !enemySpawns.some((e) => e.type === 'ashigaru')) enemySpawns[0].type = 'ashigaru';

  const arena = {
    col: ar.col,
    rows: G,
    trigger: ar.triggerTx * TILE,
    guardianX: center(ar.guardianTx),
    guardianY: G * TILE,
    backup: Array.from({ length: G }, (_, r) => c.tiles[r * w + ar.col]),
  };

  return {
    stage,
    biome,
    w,
    h,
    pxW: w * TILE,
    pxH: h * TILE,
    tiles: c.tiles,
    spawn: { x: center(c.spawnTx), y: c.surface(c.spawnTx, 0, false) * TILE },
    decos,
    enemySpawns,
    checkpoints,
    arena,
    gate: { x: center(ar.gateTx), y: G * TILE },
  };
}

/**
 * Génère le niveau d'une étape à partir de segments conçus à la main (déterministe :
 * même graine → même niveau, et franchissable sans double saut ni saut mural).
 */
export function generateLevel(seed: number, stage: number, biome: BiomeId): Level {
  const rng = new Rng(seed);
  return assembleLevel(planSegments(rng, stage), rng, stage, biome);
}
