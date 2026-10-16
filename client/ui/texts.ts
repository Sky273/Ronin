import { BIOMES, type BiomeId } from '../../shared/biomes';
import type { UpgradeId } from '../../shared/upgrades';

/** Titre d'étape affiché (étape comptée à partir de 0) : « Stage 3 · the snowy pass ». */
export function stageTitle(stage: number, biome: BiomeId): string {
  return `Stage ${stage + 1} · ${BIOMES[biome].name}`;
}

export const UPGRADE_TEXT: Record<UpgradeId, { kanji: string; name: string; desc: string }> = {
  edge: { kanji: '刃', name: 'Edge', desc: '+20% damage' },
  reach: { kanji: '伸', name: 'Reach', desc: '+15% blade reach' },
  swift: { kanji: '疾', name: 'Swiftness', desc: '+8% speed,\nfaster dash recovery' },
  vital: { kanji: '命', name: 'Vitality', desc: '+25 max HP,\nheals 40 HP' },
  leech: { kanji: '吸', name: 'Bloodthirst', desc: '+2 HP per hit landed' },
  iai: { kanji: '居', name: 'Iai Master', desc: 'Charges 30% faster,\n+15% distance' },
  parry: { kanji: '弾', name: 'Perfect Counter', desc: 'Parry window +3,\nparries heal' },
  air: { kanji: '翔', name: 'Crane Wings', desc: '+1 air jump' },
  magnet: { kanji: '引', name: 'Honor Magnet', desc: 'Draws honor orbs\nfrom farther away' },
  storm: { kanji: '嵐', name: 'Blade Storm', desc: 'The 3rd combo strike\nunleashes a wind wave' },
};

export const RANKS: { level: number; kanji: string; name: string }[] = [
  { level: 0, kanji: '浪人', name: 'Ronin' },
  { level: 3, kanji: '侍', name: 'Samurai' },
  { level: 6, kanji: '旗本', name: 'Hatamoto' },
  { level: 9, kanji: '大名', name: 'Daimyo' },
  { level: 12, kanji: '将軍', name: 'Shogun' },
];

export function rankOf(level: number): { level: number; kanji: string; name: string } {
  let r = RANKS[0];
  for (const k of RANKS) if (level >= k.level) r = k;
  return r;
}
