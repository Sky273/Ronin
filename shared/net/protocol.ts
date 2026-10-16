// Protocole réseau du mode en ligne (partagé client/serveur).
// M1 : messages msgpack explicites (pas de synchronisation d'état Colyseus/Schema).
import type { Enemy, GameEvent, Orb, Player, Projectile, StageState, WaveState } from '../types';

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
/** Masque des boutons valides (12 bits : déplacements, actions, choix 1/2/3). */
export const BUTTON_MASK = 0xfff;

/** Client → serveur : boutons tenus à ce tick, avec un numéro de séquence croissant. */
export interface InputMsg {
  s: number;
  b: number;
}

/** Client → serveur → client : mesure de la latence (le serveur renvoie le message tel quel). */
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
}

/** Serveur → client : état visible du monde autour du joueur. */
export interface SnapshotMsg {
  t: number; // tick serveur
  ack: number; // dernière séquence d'entrée traitée pour ce client
  stage: number; // numéro d'étape (le client reconstruit le niveau à partir de la graine)
  stageInfo: StageState;
  wave: WaveState;
  players: Player[]; // tous les joueurs de la salle
  enemies: Enemy[]; // filtrés par distance
  projectiles: Projectile[];
  orbs: Orb[];
  events: GameEvent[]; // depuis le précédent instantané, filtrés par distance quand ils ont une position
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
