// Palette sumi-e : encre, lavis, papier de riz et un seul accent vermillon.
export const C = {
  ink: 0x15120e,
  inkSoft: 0x2e2924,
  wash: 0x6b6359,
  washLight: 0x9d9487,
  paper: 0xf0e7d3,
  paperDark: 0xdcd0b5,
  red: 0xb8321f,
  redDeep: 0x8e2416,
  wood: 0x3a2c20,
  blossom: 0xe3a3a0,
  // Teintes des biomes (ajouts) : braises, suie, neige, pierre de château.
  ember: 0xd9642b,
  soot: 0x261c15,
  inkWarm: 0x2b1a10,
  inkCold: 0x1b252e,
  snow: 0xfbf8f1,
  snowShade: 0xb9c0c4,
  stone: 0x3a3936,
};

/**
 * Teintes d'encre des joueurs (index Player.color), toutes lisibles sur le papier.
 * L'index 0 est le vermillon historique du solo (C.red).
 */
export const PLAYER_COLORS: readonly number[] = [
  C.red, // vermillon
  0x2f3f7a, // indigo
  0x2f7d5b, // jade
  0xb07a1e, // ocre
  0x6b2a5a, // prune
  0x1f4e6e, // bleu de Prusse
  0xa8572a, // cuivre
  0x5d6b2a, // mousse
  0x7a5aa6, // glycine
  0x8a3b1c, // rouille
  0x1f7072, // sarcelle
  0x6e4b2e, // sépia
];

/** Teinte d'un joueur d'après son index de couleur (rebouclé sur la palette). */
export function playerColor(index: number): number {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[((Math.floor(index) % n) + n) % n];
}

/** Couleur au format CSS (#rrggbb), pour les textes Phaser. */
export function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function rgba(hex: number, a: number): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
}

export const FONT_BRUSH = '"Yuji Syuku", "Yu Mincho", "Hiragino Mincho ProN", "MS Mincho", serif';
export const FONT_TEXT = '"Shippori Mincho", "Yu Mincho", Georgia, serif';
