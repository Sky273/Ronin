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
};

export function rgba(hex: number, a: number): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
}

export const FONT_BRUSH = '"Yuji Syuku", "Yu Mincho", "Hiragino Mincho ProN", "MS Mincho", serif';
export const FONT_TEXT = '"Shippori Mincho", "Yu Mincho", Georgia, serif';
