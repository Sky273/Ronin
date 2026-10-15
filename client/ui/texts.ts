import type { UpgradeId } from '../../shared/upgrades';

export const UPGRADE_TEXT: Record<UpgradeId, { kanji: string; name: string; desc: string }> = {
  edge: { kanji: '刃', name: 'Tranchant', desc: '+20 % de dégâts' },
  reach: { kanji: '伸', name: 'Allonge', desc: '+15 % de portée du sabre' },
  swift: { kanji: '疾', name: 'Célérité', desc: '+8 % de vitesse,\ndash plus fréquent' },
  vital: { kanji: '命', name: 'Vitalité', desc: '+25 PV max,\nsoigne 40 PV' },
  leech: { kanji: '吸', name: 'Soif de sang', desc: '+2 PV par coup porté' },
  iai: { kanji: '居', name: 'Maître iai', desc: 'Charge 30 % plus vite,\n+15 % de distance' },
  parry: { kanji: '弾', name: 'Contre parfait', desc: 'Fenêtre de parade +3,\nla parade soigne' },
  air: { kanji: '翔', name: 'Ailes de grue', desc: '+1 saut aérien' },
  magnet: { kanji: '引', name: 'Aimant d’honneur', desc: 'Attire les orbes\nde plus loin' },
  storm: { kanji: '嵐', name: 'Tempête de lames', desc: 'Le 3e coup du combo\nlibère une vague de vent' },
};

export const RANKS: { level: number; kanji: string; name: string }[] = [
  { level: 0, kanji: '浪人', name: 'Ronin' },
  { level: 3, kanji: '侍', name: 'Samouraï' },
  { level: 6, kanji: '旗本', name: 'Hatamoto' },
  { level: 9, kanji: '大名', name: 'Daimyo' },
  { level: 12, kanji: '将軍', name: 'Shogun' },
];

export function rankOf(level: number): { level: number; kanji: string; name: string } {
  let r = RANKS[0];
  for (const k of RANKS) if (level >= k.level) r = k;
  return r;
}
