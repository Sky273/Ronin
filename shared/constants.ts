// Constantes de simulation — partagées client/serveur.
// La simulation tourne à pas fixe : toutes les durées sont exprimées en ticks.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const TILE = 32;

export const PLAYER = {
  W: 18,
  H: 46,
  CROUCH_H: 28,
  SLIDE_H: 22,
  MAX_HP: 100,

  RUN_SPEED: 275,
  CROUCH_SPEED: 105,
  GROUND_ACCEL: 2800,
  GROUND_DECEL: 3200,
  AIR_ACCEL: 1800,
  AIR_DECEL: 900,

  GRAVITY: 2000,
  MAX_FALL: 900,
  FAST_FALL: 1150,
  JUMP_VEL: 640,
  JUMP_CUT: 0.45,
  DOUBLE_JUMP_VEL: 590,
  AIR_JUMPS: 1,

  COYOTE: 6,
  JUMP_BUFFER: 8,
  ATTACK_BUFFER: 8,
  ACTION_BUFFER: 6,

  WALL_SLIDE_MAX: 130,
  WALL_JUMP_VX: 340,
  WALL_JUMP_VY: 610,
  WALL_JUMP_LOCK: 9,

  DASH_SPEED: 720,
  DASH_TICKS: 10,
  DASH_COOLDOWN: 32,

  SLIDE_SPEED: 520,
  SLIDE_TICKS: 26,
  SLIDE_FRICTION: 850,
  SLIDE_MIN_SPEED: 150,

  HURT_TICKS: 18,
  HURT_IFRAMES: 55,
  RESPAWN_TICKS: 150,

  PARRY_ACTIVE: 10,
  PARRY_RECOVERY: 16,
  PARRY_SUCCESS_IFRAMES: 24,

  IAI_MIN_CHARGE: 18,
  IAI_FULL_CHARGE: 50,
  IAI_DIST: 230,
  IAI_DIST_FULL: 330,
  IAI_RECOVERY: 20,
  IAI_DAMAGE: 45,
  IAI_DAMAGE_FULL: 90,

  COMBO_TIMEOUT: 120,
  CHAIN_WINDOW: 14,
} as const;

export const ENEMY = {
  GRAVITY: 2000,
  MAX_FALL: 900,
  MAX_ATTACKERS: 3,
  ARROW_GRAVITY: 380,
  ARROW_LIFE: 240,
  DOOM_TICKS: 24,
  STUN_TICKS: 70,
  ashigaru: {
    w: 20, h: 44, hp: 30, speed: 115, patrolSpeed: 45, sight: 430, range: 82,
    windup: 26, active: 8, recover: 34, cooldown: 45, damage: 14, lunge: 320, arrowSpeed: 0,
  },
  archer: {
    w: 18, h: 42, hp: 20, speed: 95, patrolSpeed: 40, sight: 540, range: 0,
    windup: 46, active: 0, recover: 40, cooldown: 85, damage: 12, lunge: 0, arrowSpeed: 560,
  },
  /** Oni à bouclier : bloque les coups légers de face. */
  oni: {
    w: 28, h: 54, hp: 80, speed: 68, patrolSpeed: 35, sight: 420, range: 74,
    windup: 40, active: 6, recover: 42, cooldown: 50, damage: 22, lunge: 140, arrowSpeed: 0,
  },
  /** Ninja : shurikens bas (à sauter), téléportation dans le dos. */
  ninja: {
    w: 16, h: 40, hp: 22, speed: 190, patrolSpeed: 60, sight: 540, range: 62,
    windup: 12, active: 6, recover: 26, cooldown: 70, damage: 12, lunge: 380, arrowSpeed: 470,
  },
  /** Akaoni, général démon (boss). */
  boss: {
    w: 40, h: 92, hp: 560, speed: 90, patrolSpeed: 0, sight: 3000, range: 135,
    windup: 34, active: 8, recover: 40, cooldown: 40, damage: 25, lunge: 0, arrowSpeed: 0,
  },
} as const;

/** Hitbox de l'estoc de lance (relative aux pieds, orientée selon facing). */
export const SPEAR_HB = { x: 4, y: -40, w: 62, h: 14 } as const;
export const ONI_SMASH_HB = { x: 0, y: -64, w: 80, h: 64 } as const;
export const NINJA_SLASH_HB = { x: 0, y: -40, w: 46, h: 32 } as const;

export const BOSS = {
  SWEEP_HB: { x: -10, y: -60, w: 145, h: 28 }, // passe au-dessus d'un joueur accroupi
  SLAM_W: 150,
  SLAM_H: 22, // onde de choc basse : il faut sauter
  SLAM_DMG: 20,
  CHARGE_SPEED: 560,
  CHARGE_TICKS: 55,
  CHARGE_DMG: 22,
  LEAP_TICKS: 42,
  STAGGER: 95,
  INTRO: 100,
} as const;

export const SPAWN = {
  BASE: 6,
  PER_KILLS: 6,
  MAX: 16,
  MIN_DELAY: 70,
  MAX_DELAY: 130,
} as const;

export const HONOR = {
  ashigaru: 10,
  archer: 12,
  oni: 30,
  ninja: 22,
  boss: 400,
  COMBO_BONUS: 0.05, // +5 % par coup de combo (plafonné à 20)
  DEATH_DROP: 0.5, // part de l'Honneur laissée au sol à la mort
  MAGNET: 90,
  PICKUP: 18,
  ORB_LIFE: 1800,
  LOST_LIFE: 7200,
} as const;

/** Seuil d'Honneur cumulé pour atteindre le niveau n. */
export const honorForLevel = (n: number): number => 10 * n * (n + 3);

export const WAVES = {
  FIRST_CALM: 2100,
  CALM: 1500,
  WARN: 200,
  TIDE_MAX: 3600,
} as const;
