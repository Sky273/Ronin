// Protocole réseau du mode en ligne (partagé client/serveur).
// Messages msgpack explicites (pas de synchronisation d'état Colyseus/Schema).
// v2 (M2) : instantanés compacts (voir codec.ts), tick de vue dans les entrées, compensation de latence.
import type { Duel, DuelInvite, Enemy, GameEvent, Orb, Player, Projectile, StageState, WaveState } from '../types';

/** Types de messages (courts : envoyés 20 à 60 fois par seconde). */
export const MSG = {
  input: 'i',
  snap: 's',
  welcome: 'w',
  ping: 'p',
} as const;

/** Fréquence de la simulation serveur (identique au solo). */
export const NET_TICK = 60;
/** Un instantané tous les SNAP_EVERY ticks (20 Hz). */
export const SNAP_EVERY = 3;
/** Rayon d'intérêt : un client ne reçoit que les entités à moins de cette distance (px) de son joueur. */
export const INTEREST_PX = 1500;
/** Nombre de couleurs de joueur (et taille maximale d'une salle). */
export const PLAYER_COLORS = 12;
export const MAX_NAME = 12;
/** Masque des boutons valides (13 bits : déplacements, actions, choix 1/2/3, duel). */
export const BUTTON_MASK = 0x1fff;

/** Version du protocole : client et serveur doivent être identiques (vérifiée à l'accueil). */
export const PROTOCOL_VERSION = 5;
/** Fermeture d'un joueur renvoyé pour absence prolongée (hors des codes réservés par Colyseus, 4000–4099). */
export const AWAY_CLOSE_CODE = 4100;
/** Recul d'affichage des entités distantes (ticks) : ~100 ms, ajusté de 5 à 12 selon la gigue. */
export const INTERP_TICKS = 6;
export const INTERP_MIN_TICKS = 5;
export const INTERP_MAX_TICKS = 12;
/**
 * Compensation de latence : recul maximal du jugement des coups (ticks, 500 ms). Le retard d'un
 * joueur vaut ~ aller-retour + recul d'interpolation (5 à 12 ticks) + attente dans la file du
 * serveur (~1,5 tick) : 30 ticks couvrent ~375 ms d'aller-retour avec le recul nominal (6 ticks),
 * ~280 ms quand une forte gigue porte le recul au maximum.
 */
export const MAX_REWIND_TICKS = 30;
/** Correction de prédiction au-delà de laquelle on se recale d'un coup (px). */
export const CORRECTION_SNAP_PX = 120;
/** Constante de temps du lissage des petites corrections de prédiction (ms). */
export const CORRECTION_TAU_MS = 100;

/**
 * Champs d'un autre joueur transmis (vue d'affichage, quantifiable) : contrat entre le codec,
 * l'interpolation et le rendu. Les champs absents prennent la valeur de `createPlayer`.
 */
export const PLAYER_VIEW_KEYS = [
  'id', 'name', 'color', 'x', 'y', 'vx', 'vy', 'w', 'h', 'onGround', 'facing', 'state', 'stateT',
  'hp', 'maxHp', 'crouch', 'wallDir', 'iframes', 'freeze', 'attack', 'iaiCharge', 'plungeLanded',
  'respawnT', 'out', 'doubleJumpTick', 'parryTick', 'kills', 'score', 'level',
] as const satisfies readonly (keyof Player)[];
export type PlayerView = Pick<Player, (typeof PLAYER_VIEW_KEYS)[number]>;

/** Champs d'un ennemi transmis (vue d'affichage et de prédiction des coups). Le reste vient de `createEnemy`. */
export const ENEMY_VIEW_KEYS = [
  'id', 'type', 'x', 'y', 'vx', 'vy', 'w', 'h', 'onGround', 'facing', 'state', 'stateT', 'move',
  'freeze', 'flash', 'hp', 'maxHp', 'aimAng', 'phase2',
] as const satisfies readonly (keyof Enemy)[];
export type EnemyView = Pick<Enemy, (typeof ENEMY_VIEW_KEYS)[number]>;

/** Client → serveur : boutons tenus à ce tick, avec un numéro de séquence croissant. */
export interface InputMsg {
  s: number;
  b: number;
  /** Tick de vue : tick serveur des entités distantes affichées par le client (compensation de latence). */
  v?: number;
}

/** Ping : le serveur renvoie le message tel quel (mesure de la latence). */
export interface PingMsg {
  t: number;
}

/** Serveur → client, à l'arrivée dans la salle. */
export interface WelcomeMsg {
  pid: number;
  seed: number;
  stage: number;
  tick: number;
  color: number;
  /** PROTOCOL_VERSION du serveur. */
  v: number;
}

/**
 * Instantané décodé : état visible du monde autour d'un joueur (serveur → client).
 * Sur le fil, il circule sous une forme compacte et opaque (`SnapshotWire`, voir codec.ts).
 */
export interface Snapshot {
  t: number; // tick serveur
  ack: number; // dernière séquence d'entrée traitée pour ce client (-1 : aucune)
  stage: number; // numéro d'étape (le client reconstruit le niveau à partir de la graine)
  stageInfo: StageState;
  wave: WaveState;
  shrine: number; // sanctuaire commun
  self: Player | null; // le joueur destinataire, complet et exact (réconciliation)
  others: Player[]; // les autres joueurs de la salle (vues : seuls PLAYER_VIEW_KEYS sont fidèles)
  enemies: Enemy[]; // filtrés par distance (vues : seuls ENEMY_VIEW_KEYS sont fidèles)
  projectiles: Projectile[];
  orbs: Orb[];
  events: GameEvent[]; // depuis le précédent instantané, filtrés par distance quand ils ont une position
  away: number[]; // coop : ids des joueurs absents (ni vote ni force du gardien)
  duels: Duel[]; // duels en cours (coop)
  invites: DuelInvite[]; // défis en attente et délais (coop)
}

/** Pseudo affichable : lettres, chiffres, espace, . _ - ; 12 caractères ; « Ronin » si vide. */
export function sanitizePlayerName(raw: unknown): string {
  // Tronqué d'abord : le nom vient du client et peut être très long (corps HTTP du matchmaking).
  const s = typeof raw === 'string' ? raw.slice(0, 64) : '';
  const cleaned = s
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim();
  const cut = Array.from(cleaned).slice(0, MAX_NAME).join('').trim();
  return cut || 'Ronin';
}
