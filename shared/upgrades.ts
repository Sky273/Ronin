import { PLAYER as P } from './constants';
import type { Rng } from './math';
import type { Player } from './types';

// Améliorations choisies à chaque montée de niveau (1 parmi 3).
// Seuls les identifiants transitent : les textes vivent côté client.

export type UpgradeId = 'edge' | 'reach' | 'swift' | 'vital' | 'leech' | 'iai' | 'parry' | 'air' | 'magnet' | 'storm';

export const UPGRADE_MAX: Record<UpgradeId, number> = {
  edge: 5,
  reach: 3,
  swift: 3,
  vital: 4,
  leech: 3,
  iai: 3,
  parry: 3,
  air: 2,
  magnet: 2,
  storm: 3,
};

export const UPGRADE_IDS = Object.keys(UPGRADE_MAX) as UpgradeId[];

export type Upgrades = Record<UpgradeId, number>;

export function emptyUpgrades(): Upgrades {
  const u = {} as Upgrades;
  for (const id of UPGRADE_IDS) u[id] = 0;
  return u;
}

export function rollOffer(rng: Rng, up: Upgrades): UpgradeId[] {
  const pool = UPGRADE_IDS.filter((id) => up[id] < UPGRADE_MAX[id]);
  const out: UpgradeId[] = [];
  while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return out;
}

export function applyUpgrade(p: Player, id: UpgradeId): void {
  p.up[id]++;
  if (id === 'vital') {
    p.maxHp += 25;
    p.hp = Math.min(p.maxHp, p.hp + 40);
  }
}

// ─── Effets ─────────────────────────────────────────────────────────────────
export const dmgMult = (p: Player): number => 1 + 0.2 * p.up.edge;
export const reachMult = (p: Player): number => 1 + 0.15 * p.up.reach;
export const runSpeed = (p: Player): number => P.RUN_SPEED * (1 + 0.08 * p.up.swift);
export const dashCooldown = (p: Player): number => Math.round(P.DASH_COOLDOWN * (1 - 0.18 * p.up.swift));
export const airJumps = (p: Player): number => P.AIR_JUMPS + p.up.air;
export const parryWindow = (p: Player): number => P.PARRY_ACTIVE + 3 * p.up.parry;
export const iaiRate = (p: Player): number => 1 + 0.3 * p.up.iai;
export const iaiDistMult = (p: Player): number => 1 + 0.15 * p.up.iai;
export const magnetRadius = (p: Player): number => 90 * (1 + 0.7 * p.up.magnet);
export const leechHeal = (p: Player): number => 2 * p.up.leech;
