// Les entrées sont un simple masque de bits : c'est exactement ce qui transitera
// sur le réseau en phase 2 (le client n'envoie jamais sa position).
export const BTN = {
  LEFT: 1 << 0,
  RIGHT: 1 << 1,
  UP: 1 << 2,
  DOWN: 1 << 3,
  JUMP: 1 << 4,
  ATTACK: 1 << 5,
  PARRY: 1 << 6,
  IAI: 1 << 7,
  DASH: 1 << 8,
  PICK1: 1 << 9,
  PICK2: 1 << 10,
  PICK3: 1 << 11,
} as const;

export type Buttons = number;
