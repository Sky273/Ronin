// Qualité de la connexion en ligne affichée dans le HUD (module pur, sans Phaser).

/** État de la connexion en ligne affiché dans le HUD. */
export interface NetInfo {
  /** Aller-retour lissé (ms, 0 tant qu'aucune mesure). */
  rtt: number;
  /** Gigue mesurée sur les instantanés (ms). */
  jitter: number;
  /** Joueurs dans la salle. */
  players: number;
}

/** Seuils d'aller-retour (ms) et de gigue (ms) de chaque qualité, et couleur d'encre associée. */
const NET_GOOD = { rtt: 100, jitter: 40, color: '#3d6b4f' }; // jade
const NET_FAIR = { rtt: 200, jitter: 90, color: '#a8742a' }; // ocre
const NET_POOR_COLOR = '#b8321f'; // vermillon
/** Pas encore de mesure : encre neutre. */
export const NET_UNKNOWN_COLOR = '#4a433b';

/** Couleur de la qualité de connexion (neutre tant qu'aucun aller-retour n'a été mesuré). */
export function netQualityColor(n: Pick<NetInfo, 'rtt' | 'jitter'>): string {
  if (!(n.rtt > 0)) return NET_UNKNOWN_COLOR;
  // Gigue inconnue (NaN) ou négative : ignorée ; infinie : connexion mauvaise.
  const jitter = n.jitter > 0 ? n.jitter : 0;
  if (n.rtt <= NET_GOOD.rtt && jitter <= NET_GOOD.jitter) return NET_GOOD.color;
  if (n.rtt <= NET_FAIR.rtt && jitter <= NET_FAIR.jitter) return NET_FAIR.color;
  return NET_POOR_COLOR;
}

/** Texte affiché : « N ronin · ● X ms » (« … ms » avant la première mesure). */
export function netLabel(n: NetInfo): string {
  const ping = n.rtt > 0 ? `${Math.round(n.rtt)} ms` : '… ms';
  return `${n.players} ronin · ● ${ping}`;
}
