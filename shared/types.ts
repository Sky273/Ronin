import type { AttackId } from './combat';
import type { DifficultyId } from './difficulty';
import type { NetCompensation } from './lagcomp';
import type { Level } from './level';
import type { Rng } from './math';
import type { UpgradeId, Upgrades } from './upgrades';

export interface Body {
  x: number; // centre horizontal
  y: number; // ligne des pieds
  vx: number;
  vy: number;
  w: number;
  h: number;
  onGround: boolean;
}

export type PlayerState =
  | 'normal'
  | 'dash'
  | 'slide'
  | 'attack'
  | 'parry'
  | 'iaiCharge'
  | 'iaiStrike'
  | 'hurt'
  | 'dead';

export interface Player extends Body {
  id: number;
  name: string;
  facing: 1 | -1;
  state: PlayerState;
  stateT: number;
  hp: number;
  maxHp: number;
  crouch: boolean;
  wallDir: -1 | 0 | 1;

  coyote: number;
  airJumps: number;
  airDash: boolean;
  dashCd: number;

  jumpBuffer: number;
  attackBuffer: number;
  parryBuffer: number;
  dashBuffer: number;
  downBuffer: number;
  jumpHeld: boolean;
  dropT: number;

  iframes: number;
  freeze: number; // hit-stop
  lock: number; // verrou de contrôle horizontal (wall-jump)

  attack: AttackId | null;
  queued: boolean;
  chainNext: AttackId | null;
  chainT: number;
  hitList: number[];
  plungeLanded: boolean;

  iaiCharge: number;
  iaiFrom: number;
  iaiTo: number;
  iaiFull: boolean;

  prevButtons: number;

  kills: number;
  combo: number;
  comboTimer: number;
  bestCombo: number;

  // Progression
  honor: number;
  level: number;
  picks: number;
  offer: UpgradeId[];
  up: Upgrades;
  lostX: number; // Honneur perdu laissé au sol (NaN si aucun)
  lostY: number;

  // Partie (solo) : vies limitées, score cumulé qui ne baisse jamais
  lives: number; // morts restantes avant la fin de la partie
  score: number;
  runKills: number; // ennemis tranchés sur toute la partie (kills est remis à zéro à chaque mort)
  out: boolean; // plus de vie : ne renaîtra pas
  color: number; // index de palette du joueur (0 = vermillon, celui du solo)
  outT: number; // ticks écoulés depuis la sortie

  respawnT: number;
  spawnX: number;
  spawnY: number;
  checkpoint: number;

  doubleJumpTick: number;
  parryTick: number;
}

export type EnemyType = 'ashigaru' | 'archer' | 'oni' | 'ninja' | 'boss';
export type EnemyState =
  | 'patrol'
  | 'chase'
  | 'windup'
  | 'attack'
  | 'recover'
  | 'hitstun'
  | 'stunned'
  | 'doomed'
  | 'hidden'
  | 'intro'
  | 'dead';
export type EnemyMove = 'thrust' | 'shoot' | 'smash' | 'throw' | 'slash' | 'sweep' | 'leap' | 'charge' | 'horn' | 'none';

export interface Enemy extends Body {
  id: number;
  type: EnemyType;
  facing: 1 | -1;
  hp: number;
  maxHp: number;
  state: EnemyState;
  stateT: number;
  move: EnemyMove;
  freeze: number;
  flash: number;
  token: boolean;
  cd: number;
  patrolDir: 1 | -1;
  hitDone: boolean;
  stunLen: number;
  doomBy: number;
  aimAng: number;
  aux: number; // compteur libre (shurikens restants, etc.)
  tx: number; // cible (bond, téléportation)
  dodgeCd: number;
  phase2: boolean;
  hornStage: number;
  horde: boolean; // renfort amené par la horde (peut être retiré), sinon ennemi placé dans le niveau
}

export type ProjectileKind = 'arrow' | 'shuriken' | 'wave';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: 'enemy' | 'player';
  ownerId: number;
  damage: number;
  life: number;
  hits: number[];
  dead: boolean;
}

export interface Orb {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  value: number;
  life: number;
  lost: boolean; // Honneur perdu à la mort
  onGround: boolean;
}

export interface WaveState {
  n: number; // numéro de la dernière Marée lancée
  phase: 'calm' | 'warn' | 'tide';
  t: number;
  kills: number;
  quota: number;
}

/** Statistiques d'un joueur pour l'étape en cours (coop seulement). */
export interface PlayerStageStats {
  kills: number;
  parries: number;
  deaths: number;
  honor: number;
  bestCombo: number;
  grade: number; // 0 = 優, 1 = 良, 2 = 可 (fixée au bilan)
  bonus: number; // Honneur de fin d'étape versé à ce joueur
  ready: boolean; // a voté pour reprendre la route (bilan)
}

/** Déroulé de l'étape : exploration → arène du gardien → porte ouverte → bilan. */
export interface StageState {
  loop: number; // 0 = premier voyage ; chaque boucle est plus difficile
  state: 'playing' | 'arena' | 'gateOpen' | 'cleared';
  t: number; // ticks dans l'état courant
  startTick: number;
  kills: number;
  parries: number;
  deaths: number;
  honor: number;
  bestCombo: number;
  guardianId: number;
  grade: number; // 0 = 優, 1 = 良, 2 = 可
  bonus: number;
  time: number; // durée de l'étape (ticks), figée au bilan
  /**
   * Coop : statistiques par joueur (id → stats). Absent en solo (empreintes inchangées).
   * En ligne, transmis seulement pendant le bilan (`state === 'cleared'`).
   */
  byPlayer?: Record<number, PlayerStageStats>;
}

/** Événements émis par la simulation et consommés par le client (FX, sons). */
export type GameEvent =
  | { type: 'swing'; pid: number; attack: AttackId; x: number; y: number; dir: number }
  // pid (coop seulement) : joueur auteur du coup ; absent en solo (empreintes inchangées).
  | { type: 'hit'; x: number; y: number; dir: number; damage: number; heavy: boolean; targetId: number; pid?: number }
  | {
      type: 'kill';
      id: number;
      enemyType: EnemyType;
      x: number;
      y: number;
      facing: 1 | -1;
      dir: number;
      cutAngle: number;
      byIai: boolean;
      pid: number;
      honor: number;
    }
  | { type: 'doom'; id: number; x: number; y: number }
  | { type: 'parry'; x: number; y: number; pid: number }
  | { type: 'deflect'; x: number; y: number; pid?: number }
  | { type: 'block'; x: number; y: number; dir: number; pid?: number }
  | { type: 'guardBreak'; x: number; y: number; pid?: number }
  | { type: 'playerHit'; x: number; y: number; dir: number; damage: number; pid: number }
  | { type: 'playerDeath'; x: number; y: number; pid: number; lost: number; livesLeft: number }
  | { type: 'gameOver'; pid: number; score: number; loop: number; kills: number; deaths: number }
  | { type: 'respawn'; x: number; y: number; pid: number }
  | { type: 'jump'; x: number; y: number; double: boolean; pid: number }
  | { type: 'wallJump'; x: number; y: number; dir: number; pid: number }
  | { type: 'land'; x: number; y: number; impact: number; pid: number }
  | { type: 'dash'; x: number; y: number; dir: number; pid: number }
  | { type: 'slide'; x: number; y: number; dir: number; pid: number }
  | { type: 'iaiStart'; pid: number }
  | { type: 'iaiReady'; x: number; y: number; pid: number }
  | { type: 'iai'; x0: number; x1: number; y: number; full: boolean; count: number; pid: number }
  | { type: 'plungeLand'; x: number; y: number; pid: number }
  | { type: 'windSlash'; x: number; y: number; dir: number; pid?: number }
  | { type: 'orb'; x: number; y: number; value: number; lost: boolean; pid: number }
  | { type: 'levelUp'; level: number; pid: number }
  | { type: 'pick'; upgrade: UpgradeId; level: number; pid: number }
  | { type: 'checkpoint'; x: number; y: number; index: number; pid: number }
  | { type: 'spawn'; x: number; y: number; enemyType: EnemyType }
  | { type: 'despawn'; x: number; y: number }
  | { type: 'windup'; id: number; x: number; y: number; enemyType: EnemyType; move: EnemyMove }
  | { type: 'arrowFire'; x: number; y: number }
  | { type: 'throw'; x: number; y: number }
  | { type: 'arrowBreak'; x: number; y: number }
  | { type: 'alert'; id: number; x: number; y: number }
  | { type: 'vanish'; id: number; x: number; y: number }
  | { type: 'appear'; id: number; x: number; y: number }
  | { type: 'slam'; x: number; y: number; w: number }
  | { type: 'charge'; x: number; y: number; dir: number }
  | { type: 'horn'; x: number; y: number }
  | { type: 'roar'; id: number; x: number; y: number }
  | { type: 'bossPhase'; id: number; x: number; y: number }
  | { type: 'bossSpawn'; id: number; x: number; y: number }
  | { type: 'tideWarn'; n: number }
  | { type: 'tideStart'; n: number }
  | { type: 'tideEnd'; n: number; bonus: number }
  | { type: 'arenaLock'; x: number }
  | { type: 'arenaReset' }
  | { type: 'gateOpen'; x: number; y: number }
  | { type: 'stageClear'; loop: number; grade: number; bonus: number }
  | { type: 'stageStart'; loop: number };

export type GameMode = 'solo' | 'coop';

export interface World {
  tick: number;
  /** Graine de la partie : détermine aussi les niveaux générés des étapes suivantes. */
  seed: number;
  level: Level;
  players: Player[];
  enemies: Enemy[];
  projectiles: Projectile[];
  orbs: Orb[];
  events: GameEvent[];
  rng: Rng;
  nextId: number;
  spawnTimer: number;
  attackTokens: number;
  totalKills: number;
  wave: WaveState;
  stage: StageState;
  difficulty: DifficultyId;
  /** 'solo' : partie locale historique ; 'coop' : salle en ligne (règles multijoueur). */
  mode: GameMode;
  /** Coop : index du sanctuaire le plus avancé activé par la salle (point de renaissance commun). */
  shrine: number;
  /** Partie terminée (tous les joueurs sans vie) : la simulation est figée. */
  over: boolean;
  overT: number; // ticks écoulés depuis que tous les joueurs sont sortis
  /**
   * Compensation de latence (serveur en ligne seulement, posée par CoopSession).
   * Absente en solo, dans les tests coop purs et côté client : la clé n'apparaît pas dans le JSON.
   */
  net?: NetCompensation;
}
