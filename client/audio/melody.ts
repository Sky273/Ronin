// Générateur de mélodies pour le shinobue (flûte traversière japonaise).
// Fonctions pures et déterministes : une même section produit toujours la même
// phrase, l'oreille retrouve donc les motifs d'un cycle à l'autre.
//
// Forme d'une section de 8 mesures (4 phrases de 2 mesures) :
//   A  : le motif ;  A' : le motif transposé, fin altérée ;
//   B  : contraste (autre rythme, registre plus aigu) ;  A" : retour, cadence sur la tonique.

export type MelodyMood = 'calm' | 'tide' | 'boss' | 'rest';
export type Ornament = 'none' | 'grace' | 'trill' | 'slide' | 'fall';

export interface MelodyNote {
  start: number; // en doubles-croches depuis le début de la phrase (0..31)
  len: number; // durée en doubles-croches
  deg: number; // degré de la gamme In (0 = ré grave du moteur ; 5 = une octave au-dessus)
  orn: Ornament;
}

/** Longueur d'une phrase : 2 mesures de 16 doubles-croches. */
export const PHRASE_STEPS = 32;

/** Rythmes en doubles-croches ; une valeur négative est un silence. Chaque motif fait 32. */
const RHYTHMS: Record<MelodyMood, number[][]> = {
  calm: [
    [8, 4, 4, 12, -4],
    [6, 2, 8, 8, -8],
    [4, 4, 8, 4, -12],
    [12, 4, 8, -8],
  ],
  rest: [
    [12, 4, -16],
    [8, 8, -16],
    [16, -16],
  ],
  tide: [
    [2, 2, 4, 2, 2, 4, 4, 4, -8],
    [3, 1, 2, 2, 4, 4, 2, 2, 4, -8],
    [4, 2, 2, 4, 4, 2, 2, 8, -4],
    [2, 2, 2, 2, 4, 4, 8, -8],
  ],
  boss: [
    [12, 4, 8, -8],
    [16, 8, -8],
    [4, 4, 4, 4, 16],
  ],
};

const MOOD_SEED: Record<MelodyMood, number> = { calm: 11, rest: 23, tide: 37, boss: 53 };

/** Registre du shinobue (degrés) : aigu et brillant, sans monter dans le criard. */
export const DEG_MIN = 3;
export const DEG_MAX = 13;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod5 = (n: number) => ((n % 5) + 5) % 5;
const clampDeg = (d: number) => Math.max(DEG_MIN, Math.min(DEG_MAX, d));

/** Notes d'appui de l'accord (fondamentale, et les degrés 2 et 3 au-dessus). */
function isChordTone(deg: number, chord: number): boolean {
  const k = mod5(deg - chord);
  return k === 0 || k === 2 || k === 3;
}

function snapToChord(deg: number, chord: number): number {
  for (const d of [0, 1, -1, 2, -2]) if (isChordTone(deg + d, chord)) return clampDeg(deg + d);
  return clampDeg(deg);
}

/** Contour mélodique : surtout par mouvements conjoints, appuis forts sur les notes de l'accord. */
function contour(r: () => number, rhythm: number[], start: number, chord: number): MelodyNote[] {
  const STEPS = [-2, -1, -1, 0, 1, 1, 2];
  const notes: MelodyNote[] = [];
  let at = 0;
  let deg = start;
  let prev = start;
  for (const v of rhythm) {
    const len = Math.abs(v);
    if (v > 0) {
      if (notes.length > 0) deg = clampDeg(deg + STEPS[Math.floor(r() * STEPS.length)]);
      if (at % 8 === 0) deg = snapToChord(deg, chord);
      notes.push({ start: at, len, deg, orn: Math.abs(deg - prev) >= 2 ? 'grace' : 'none' });
      prev = deg;
    }
    at += len;
  }
  return notes;
}

function ornament(notes: MelodyNote[], mood: MelodyMood, r: () => number, cadence: boolean): MelodyNote[] {
  return notes.map((n, i) => {
    const last = i === notes.length - 1;
    let orn = n.orn;
    if (mood === 'boss' && n.len >= 8) orn = last ? 'fall' : 'slide';
    else if ((mood === 'calm' || mood === 'rest') && n.len >= 8) orn = r() < 0.35 ? 'trill' : orn;
    else if (mood === 'tide' && n.len >= 4 && r() < 0.25) orn = 'grace';
    if (cadence && last) orn = mood === 'boss' ? 'fall' : 'trill';
    return { ...n, orn };
  });
}

/**
 * Phrase de 2 mesures pour la section `section`, emplacement `slot` (0..3 : A, A', B, A"),
 * sur l'accord `chord` (degré de la fondamentale).
 */
export function phraseFor(section: number, slot: number, mood: MelodyMood, chord: number): MelodyNote[] {
  const seed = section * 131 + MOOD_SEED[mood];
  const pool = RHYTHMS[mood];
  const rA = rng(seed);
  const rhythmA = pool[Math.floor(rA() * pool.length)];
  const startA = 5 + chord + [0, 2, 3][Math.floor(rA() * 3)];

  if (slot === 2) {
    // B : contraste — un autre rythme, deux degrés plus haut.
    const rB = rng(seed + 7919);
    const others = pool.filter((p) => p !== rhythmA);
    const rhythmB = (others.length ? others : pool)[Math.floor(rB() * (others.length || pool.length))];
    return ornament(contour(rB, rhythmB, clampDeg(startA + 2), chord), mood, rB, false);
  }

  // A, A' et A" partagent le même matériau (même tirage) : c'est ce qui fait le motif.
  const notes = contour(rng(seed + 1), rhythmA, startA, chord);
  const rO = rng(seed + slot * 97 + 3);
  if (slot === 1) {
    // A' : transposé d'un degré, dernière note déplacée.
    const t = notes.map((n) => ({ ...n, deg: clampDeg(n.deg + 1) }));
    const last = t[t.length - 1];
    last.deg = snapToChord(last.deg + (rO() < 0.5 ? 1 : -1), chord);
    return ornament(t, mood, rO, false);
  }
  if (slot === 3) {
    // A" : retour du motif, cadence sur la fondamentale.
    const t = notes.map((n) => ({ ...n }));
    const last = t[t.length - 1];
    const root = 5 + chord;
    last.deg = clampDeg(Math.abs(last.deg - root) <= Math.abs(last.deg - (root + 5)) ? root : root + 5);
    return ornament(t, mood, rO, true);
  }
  return ornament(notes, mood, rO, false);
}
