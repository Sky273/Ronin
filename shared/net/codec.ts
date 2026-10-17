// Codec des instantanés : forme décodée (Snapshot) ↔ forme transmise (SnapshotWire, opaque).
// Seul ce module connaît la forme filaire ; tout le reste passe par encodeSnapshot / decodeSnapshot.
//
// Forme compacte (M2) : tout est en tableaux à positions fixes (aucun nom de clé sur le fil).
// - `self` : exact et sans perte, dans l'ordre de SELF_KEYS (`up`, `offer`, `hitList` imbriqués).
// - autres joueurs, ennemis, projectiles, orbes : vues quantifiées (positions et vitesses au
//   demi-pixel, angles au 1/200 rad), énumérations en index de tables, booléens en champ de bits.
// - événements : [index du type, valeurs dans l'ordre de EVENT_KEYS] ; x, y, x0 et x1 au demi-pixel.
// Les valeurs d'énumération inconnues passent telles quelles (chaîne) : le décodage les reconnaît.
import type { AttackId } from '../combat';
import { createEnemy } from '../enemy';
import { createPlayer } from '../player';
import type {
  Duel,
  DuelInvite,
  DuelPhase,
  DojoEntrant,
  DojoMatch,
  DuelSide,
  Enemy,
  EnemyMove,
  EnemyState,
  EnemyType,
  GameEvent,
  Orb,
  Player,
  PlayerStageStats,
  PlayerState,
  Projectile,
  ProjectileKind,
  StageState,
  Tournament,
  TournamentPhase,
  WaveState,
} from '../types';
import type { UpgradeId, Upgrades } from '../upgrades';
import type { EnemyView, PlayerView, Snapshot } from './protocol';

/** Instantané tel qu'il circule (msgpack). Opaque hors de ce module. */
export interface SnapshotWire {
  readonly __snapshotWire?: never;
}

// ─── Tables d'énumérations ──────────────────────────────────────────────────

/**
 * Table d'index d'une union de chaînes : la compilation échoue si une valeur de l'union manque
 * (le type d'erreur nomme la valeur oubliée dans `__missing`).
 */
function enumTable<U extends string>() {
  return <const L extends readonly U[]>(list: L & ([Exclude<U, L[number]>] extends [never] ? unknown : { __missing: Exclude<U, L[number]> })): L => list;
}

export const PLAYER_STATES = enumTable<PlayerState>()(['normal', 'dash', 'slide', 'attack', 'parry', 'iaiCharge', 'iaiStrike', 'hurt', 'dead']);
export const ATTACK_IDS = enumTable<AttackId>()(['slash1', 'slash2', 'slash3', 'upSlash', 'airSlash', 'plunge']);
export const ENEMY_TYPES = enumTable<EnemyType>()(['ashigaru', 'archer', 'oni', 'ninja', 'boss']);
export const ENEMY_STATES = enumTable<EnemyState>()([
  'patrol', 'chase', 'windup', 'attack', 'recover', 'hitstun', 'stunned', 'doomed', 'hidden', 'intro', 'dead',
]);
export const ENEMY_MOVES = enumTable<EnemyMove>()(['none', 'thrust', 'shoot', 'smash', 'throw', 'slash', 'sweep', 'leap', 'charge', 'horn']);
export const PROJECTILE_KINDS = enumTable<ProjectileKind>()(['arrow', 'shuriken', 'wave']);
export const UPGRADE_TABLE = enumTable<UpgradeId>()(['edge', 'reach', 'swift', 'vital', 'leech', 'iai', 'parry', 'air', 'magnet', 'storm']);
export const STAGE_STATES = enumTable<StageState['state']>()(['playing', 'arena', 'gateOpen', 'cleared']);
export const WAVE_PHASES = enumTable<WaveState['phase']>()(['calm', 'warn', 'tide']);

/** Index dans la table, ou la valeur elle-même (chaîne) si elle est inconnue. */
function encEnum(table: readonly string[], v: string): number | string {
  const i = table.indexOf(v);
  return i >= 0 ? i : v;
}
function decEnum<T extends string>(table: readonly T[], x: unknown): T {
  return (typeof x === 'number' ? table[x] : x) as T;
}
/** Variante nullable : null ↔ -1. */
function encEnumOrNull(table: readonly string[], v: string | null): number | string {
  return v === null ? -1 : encEnum(table, v);
}
function decEnumOrNull<T extends string>(table: readonly T[], x: unknown): T | null {
  return x === -1 || x === null ? null : decEnum(table, x);
}

// ─── Quantification ─────────────────────────────────────────────────────────

/** Positions et vitesses au demi-pixel : erreur ≤ 0,25 px (ou px/s). */
export const POS_SCALE = 2;
/** Angles au 1/200 rad : erreur ≤ 0,0025 rad. */
export const ANGLE_SCALE = 200;
/** Ancienneté maximale transmise pour doubleJumpTick / parryTick (ticks) ; au-delà : « jamais » (-999). */
export const AGE_MAX = 120;
const NEVER_TICK = -999;

const qPos = (v: number): number => Math.round(v * POS_SCALE);
// Valeur absente ou d'un autre type : NaN (l'entité sera écartée au décodage).
const dqPos = (q: number): number => (typeof q === 'number' ? q / POS_SCALE : NaN);
const qAge = (t: number, v: number): number => {
  const a = t - v;
  return a >= 0 && a < AGE_MAX ? a : AGE_MAX;
};
const dqAge = (t: number, a: number): number => (a >= AGE_MAX ? NEVER_TICK : t - a);

// ─── Soi : exact ────────────────────────────────────────────────────────────

/** Tous les champs de Player, dans un ordre fixe (forme filaire de `self`). */
export const SELF_KEYS = [
  'id', 'name', 'x', 'y', 'vx', 'vy', 'w', 'h', 'onGround',
  'facing', 'state', 'stateT', 'hp', 'maxHp', 'crouch', 'wallDir',
  'coyote', 'airJumps', 'airDash', 'dashCd',
  'jumpBuffer', 'attackBuffer', 'parryBuffer', 'dashBuffer', 'downBuffer', 'jumpHeld', 'dropT',
  'iframes', 'freeze', 'lock',
  'attack', 'queued', 'chainNext', 'chainT', 'hitList', 'plungeLanded',
  'iaiCharge', 'iaiFrom', 'iaiTo', 'iaiFull',
  'prevButtons',
  'kills', 'combo', 'comboTimer', 'bestCombo',
  'honor', 'level', 'picks', 'offer', 'up', 'lostX', 'lostY',
  'lives', 'score', 'runKills', 'out', 'outT', 'color',
  'respawnT', 'spawnX', 'spawnY', 'checkpoint',
  'doubleJumpTick', 'parryTick',
] as const satisfies readonly (keyof Player)[];

/** Vérification de compilation : SELF_KEYS couvre tous les champs de Player. */
export const SELF_KEYS_COMPLETE: [Exclude<keyof Player, (typeof SELF_KEYS)[number]>] extends [never] ? true : never = true;

function encodeSelf(p: Player): unknown[] {
  const r: unknown[] = new Array(SELF_KEYS.length);
  for (let i = 0; i < SELF_KEYS.length; i++) {
    const k = SELF_KEYS[i];
    switch (k) {
      case 'state': r[i] = encEnum(PLAYER_STATES, p.state); break;
      case 'attack': r[i] = encEnumOrNull(ATTACK_IDS, p.attack); break;
      case 'chainNext': r[i] = encEnumOrNull(ATTACK_IDS, p.chainNext); break;
      case 'hitList': r[i] = p.hitList.slice(); break;
      case 'offer': r[i] = p.offer.map((u) => encEnum(UPGRADE_TABLE, u)); break;
      case 'up': r[i] = UPGRADE_TABLE.map((u) => p.up[u]); break;
      default: r[i] = p[k];
    }
  }
  return r;
}

function decodeSelf(a: unknown[]): Player {
  if (a.length !== SELF_KEYS.length) throw new Error('instantané illisible : joueur local tronqué');
  const p = {} as Record<string, unknown>;
  for (let i = 0; i < SELF_KEYS.length; i++) {
    const k = SELF_KEYS[i];
    const x = a[i];
    switch (k) {
      case 'state': p[k] = decEnum(PLAYER_STATES, x); break;
      case 'attack':
      case 'chainNext': p[k] = decEnumOrNull(ATTACK_IDS, x); break;
      case 'hitList': p[k] = (x as number[]).slice(); break;
      case 'offer': p[k] = (x as unknown[]).map((u) => decEnum(UPGRADE_TABLE, u)); break;
      case 'up': {
        const up = {} as Upgrades;
        UPGRADE_TABLE.forEach((u, j) => (up[u] = (x as number[])[j]));
        p[k] = up;
        break;
      }
      default: p[k] = x;
    }
  }
  return p as unknown as Player;
}

// ─── Vues quantifiées ───────────────────────────────────────────────────────

/** Bits des booléens d'un autre joueur. */
const PB_GROUND = 1, PB_FACING = 2, PB_CROUCH = 4, PB_PLUNGE = 8, PB_OUT = 16;

/** Vue d'un autre joueur : tuple (les âges des ticks sont relatifs au tick `t` de l'instantané). */
export function encodeOther(p: Player, t: number): unknown[] {
  const bits =
    (p.onGround ? PB_GROUND : 0) | (p.facing === 1 ? PB_FACING : 0) | (p.crouch ? PB_CROUCH : 0) | (p.plungeLanded ? PB_PLUNGE : 0) | (p.out ? PB_OUT : 0);
  return [
    p.id, p.name, p.color, qPos(p.x), qPos(p.y), qPos(p.vx), qPos(p.vy), p.w, p.h, bits,
    encEnum(PLAYER_STATES, p.state), p.stateT, p.hp, p.maxHp, p.wallDir, p.iframes, p.freeze,
    encEnumOrNull(ATTACK_IDS, p.attack), p.iaiCharge, p.respawnT,
    qAge(t, p.doubleJumpTick), qAge(t, p.parryTick), p.kills, p.score, p.level,
  ];
}

function decodeOtherView(a: unknown[], t: number): PlayerView {
  const n = a as number[];
  const bits = n[9];
  return {
    id: n[0], name: a[1] as string, color: n[2], x: dqPos(n[3]), y: dqPos(n[4]), vx: dqPos(n[5]), vy: dqPos(n[6]), w: n[7], h: n[8],
    onGround: (bits & PB_GROUND) !== 0, facing: bits & PB_FACING ? 1 : -1, crouch: (bits & PB_CROUCH) !== 0,
    plungeLanded: (bits & PB_PLUNGE) !== 0, out: (bits & PB_OUT) !== 0,
    state: decEnum(PLAYER_STATES, a[10]), stateT: n[11], hp: n[12], maxHp: n[13], wallDir: n[14] as Player['wallDir'],
    iframes: n[15], freeze: n[16], attack: decEnumOrNull(ATTACK_IDS, a[17]), iaiCharge: n[18], respawnT: n[19],
    doubleJumpTick: dqAge(t, n[20]), parryTick: dqAge(t, n[21]), kills: n[22], score: n[23], level: n[24],
  };
}

const EB_GROUND = 1, EB_FACING = 2, EB_PHASE2 = 4;

/** Vue d'un ennemi : tuple. */
export function encodeEnemy(e: Enemy): unknown[] {
  const bits = (e.onGround ? EB_GROUND : 0) | (e.facing === 1 ? EB_FACING : 0) | (e.phase2 ? EB_PHASE2 : 0);
  return [
    e.id, encEnum(ENEMY_TYPES, e.type), qPos(e.x), qPos(e.y), qPos(e.vx), qPos(e.vy), e.w, e.h, bits,
    encEnum(ENEMY_STATES, e.state), e.stateT, encEnum(ENEMY_MOVES, e.move), e.freeze, e.flash, e.hp, e.maxHp,
    Math.round(e.aimAng * ANGLE_SCALE),
  ];
}

function decodeEnemyView(a: unknown[]): EnemyView {
  const n = a as number[];
  const bits = n[8];
  return {
    id: n[0], type: decEnum(ENEMY_TYPES, a[1]), x: dqPos(n[2]), y: dqPos(n[3]), vx: dqPos(n[4]), vy: dqPos(n[5]), w: n[6], h: n[7],
    onGround: (bits & EB_GROUND) !== 0, facing: bits & EB_FACING ? 1 : -1, phase2: (bits & EB_PHASE2) !== 0,
    state: decEnum(ENEMY_STATES, a[9]), stateT: n[10], move: decEnum(ENEMY_MOVES, a[11]), freeze: n[12], flash: n[13],
    hp: n[14], maxHp: n[15], aimAng: n[16] / ANGLE_SCALE,
  };
}

const AB_PLAYER = 1, AB_DEAD = 2;

/** Projectile : tuple (tous les champs, positions et vitesses quantifiées). */
export function encodeProjectile(a: Projectile): unknown[] {
  const bits = (a.owner === 'player' ? AB_PLAYER : 0) | (a.dead ? AB_DEAD : 0);
  return [a.id, encEnum(PROJECTILE_KINDS, a.kind), qPos(a.x), qPos(a.y), qPos(a.vx), qPos(a.vy), bits, a.ownerId, a.damage, a.life, a.hits.slice()];
}

function decodeProjectile(a: unknown[]): Projectile {
  const n = a as number[];
  return {
    id: n[0], kind: decEnum(PROJECTILE_KINDS, a[1]), x: dqPos(n[2]), y: dqPos(n[3]), vx: dqPos(n[4]), vy: dqPos(n[5]),
    owner: n[6] & AB_PLAYER ? 'player' : 'enemy', dead: (n[6] & AB_DEAD) !== 0, ownerId: n[7], damage: n[8], life: n[9],
    hits: (a[10] as number[]).slice(),
  };
}

const OB_LOST = 1, OB_GROUND = 2;

/** Orbe : tuple. */
export function encodeOrb(o: Orb): unknown[] {
  return [o.id, qPos(o.x), qPos(o.y), qPos(o.vx), qPos(o.vy), o.value, o.life, (o.lost ? OB_LOST : 0) | (o.onGround ? OB_GROUND : 0)];
}

function decodeOrb(a: unknown[]): Orb {
  const n = a as number[];
  return {
    id: n[0], x: dqPos(n[1]), y: dqPos(n[2]), vx: dqPos(n[3]), vy: dqPos(n[4]), value: n[5], life: n[6],
    lost: (n[7] & OB_LOST) !== 0, onGround: (n[7] & OB_GROUND) !== 0,
  };
}

// ─── Étape et Marée ─────────────────────────────────────────────────────────

const STAGE_KEYS = [
  'loop', 'state', 't', 'startTick', 'kills', 'parries', 'deaths', 'honor', 'bestCombo', 'guardianId', 'grade', 'bonus', 'time',
  'byPlayer',
] as const satisfies readonly (keyof StageState)[];
/** Statistiques d'un joueur (coop) : [pid, …PLAYER_STAGE_KEYS], `ready` en 0/1. */
const PLAYER_STAGE_KEYS = ['kills', 'parries', 'deaths', 'honor', 'bestCombo', 'grade', 'bonus', 'ready'] as const satisfies readonly (keyof PlayerStageStats)[];
export const PLAYER_STAGE_KEYS_COMPLETE: [Exclude<keyof PlayerStageStats, (typeof PLAYER_STAGE_KEYS)[number]>] extends [never] ? true : never = true;

/** Statistiques par joueur : transmises seulement pendant le bilan (inutiles en jeu, coût nul). */
function encodeByPlayer(s: StageState): unknown {
  if (!s.byPlayer || s.state !== 'cleared') return null;
  return Object.entries(s.byPlayer).map(([pid, st]) => [Number(pid), ...PLAYER_STAGE_KEYS.map((k) => (k === 'ready' ? (st.ready ? 1 : 0) : st[k]))]);
}
function decodeByPlayer(x: unknown): Record<number, PlayerStageStats> | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: Record<number, PlayerStageStats> = {};
  for (const row of x) {
    if (!Array.isArray(row) || row.length !== PLAYER_STAGE_KEYS.length + 1 || !Number.isFinite(row[0])) continue;
    const st = {} as Record<string, unknown>;
    let ok = true;
    PLAYER_STAGE_KEYS.forEach((k, i) => {
      const v = row[i + 1];
      if (k === 'ready') st[k] = v === 1 || v === true;
      else if (typeof v === 'number' && Number.isFinite(v)) st[k] = v;
      else ok = false;
    });
    if (ok) out[row[0] as number] = st as unknown as PlayerStageStats;
  }
  return out;
}
export const STAGE_KEYS_COMPLETE: [Exclude<keyof StageState, (typeof STAGE_KEYS)[number]>] extends [never] ? true : never = true;
const WAVE_KEYS = ['n', 'phase', 't', 'kills', 'quota'] as const satisfies readonly (keyof WaveState)[];
export const WAVE_KEYS_COMPLETE: [Exclude<keyof WaveState, (typeof WAVE_KEYS)[number]>] extends [never] ? true : never = true;

function encodeStage(s: StageState): unknown[] {
  return STAGE_KEYS.map((k) => (k === 'state' ? encEnum(STAGE_STATES, s.state) : k === 'byPlayer' ? encodeByPlayer(s) : s[k]));
}
function decodeStage(a: unknown[]): StageState {
  const r = {} as Record<string, unknown>;
  STAGE_KEYS.forEach((k, i) => {
    if (k === 'byPlayer') {
      const bp = decodeByPlayer(a[i]);
      if (bp) r[k] = bp; // absent hors bilan
    } else r[k] = k === 'state' ? decEnum(STAGE_STATES, a[i]) : a[i];
  });
  return r as unknown as StageState;
}
function encodeWave(s: WaveState): unknown[] {
  return WAVE_KEYS.map((k) => (k === 'phase' ? encEnum(WAVE_PHASES, s.phase) : s[k]));
}
function decodeWave(a: unknown[]): WaveState {
  const r = {} as Record<string, unknown>;
  WAVE_KEYS.forEach((k, i) => (r[k] = k === 'phase' ? decEnum(WAVE_PHASES, a[i]) : a[i]));
  return r as unknown as WaveState;
}

// ─── Événements ─────────────────────────────────────────────────────────────

type EventType = GameEvent['type'];
type EventOf<K extends EventType> = Extract<GameEvent, { type: K }>;
type EventFields<K extends EventType> = Exclude<keyof EventOf<K>, 'type'>;

/**
 * Champs de chaque type d'événement, dans l'ordre filaire (sans `type`). Les champs optionnels
 * (`pid?`) sont en dernier : absents, ils ne sont pas transmis.
 */
export const EVENT_KEYS = {
  swing: ['pid', 'attack', 'x', 'y', 'dir'],
  hit: ['x', 'y', 'dir', 'damage', 'heavy', 'targetId', 'pid'],
  kill: ['id', 'enemyType', 'x', 'y', 'facing', 'dir', 'cutAngle', 'byIai', 'pid', 'honor'],
  doom: ['id', 'x', 'y'],
  parry: ['x', 'y', 'pid'],
  deflect: ['x', 'y', 'pid'],
  block: ['x', 'y', 'dir', 'pid'],
  guardBreak: ['x', 'y', 'pid'],
  playerHit: ['x', 'y', 'dir', 'damage', 'pid'],
  playerDeath: ['x', 'y', 'pid', 'lost', 'livesLeft'],
  gameOver: ['pid', 'score', 'loop', 'kills', 'deaths'],
  respawn: ['x', 'y', 'pid'],
  jump: ['x', 'y', 'double', 'pid'],
  wallJump: ['x', 'y', 'dir', 'pid'],
  land: ['x', 'y', 'impact', 'pid'],
  dash: ['x', 'y', 'dir', 'pid'],
  slide: ['x', 'y', 'dir', 'pid'],
  iaiStart: ['pid'],
  iaiReady: ['x', 'y', 'pid'],
  iai: ['x0', 'x1', 'y', 'full', 'count', 'pid'],
  plungeLand: ['x', 'y', 'pid'],
  windSlash: ['x', 'y', 'dir', 'pid'],
  orb: ['x', 'y', 'value', 'lost', 'pid'],
  levelUp: ['level', 'pid'],
  pick: ['upgrade', 'level', 'pid'],
  checkpoint: ['x', 'y', 'index', 'pid'],
  spawn: ['x', 'y', 'enemyType'],
  despawn: ['x', 'y'],
  windup: ['id', 'x', 'y', 'enemyType', 'move'],
  arrowFire: ['x', 'y'],
  throw: ['x', 'y'],
  arrowBreak: ['x', 'y'],
  alert: ['id', 'x', 'y'],
  vanish: ['id', 'x', 'y'],
  appear: ['id', 'x', 'y'],
  slam: ['x', 'y', 'w'],
  charge: ['x', 'y', 'dir'],
  horn: ['x', 'y'],
  roar: ['id', 'x', 'y'],
  bossPhase: ['id', 'x', 'y'],
  bossSpawn: ['id', 'x', 'y'],
  tideWarn: ['n'],
  tideStart: ['n'],
  tideEnd: ['n', 'bonus'],
  arenaLock: ['x'],
  arenaReset: [],
  gateOpen: ['x', 'y'],
  stageClear: ['loop', 'grade', 'bonus'],
  stageStart: ['loop'],
  duelInvite: ['from', 'to'],
  duelCancel: ['from', 'to', 'why'],
  duelStart: ['id', 'a', 'b'],
  duelRound: ['id', 'round', 'winner', 'why', 'ra', 'rb', 'wa', 'wb'],
  duelEnd: ['id', 'winner', 'wa', 'wb', 'why'],
  dojoStart: ['n'],
  dojoMatch: ['match', 'a', 'b'],
  dojoResult: ['match', 'winner', 'why', 'wa', 'wb'],
  dojoChampion: ['pid', 'n'],
  dojoReset: ['n'],
} as const satisfies { [K in EventType]: readonly EventFields<K>[] };

type MissingEventKeys = { [K in EventType]: Exclude<EventFields<K>, (typeof EVENT_KEYS)[K][number]> }[EventType];
/** Vérification de compilation : chaque liste couvre tous les champs de son type d'événement. */
export const EVENT_KEYS_COMPLETE: [MissingEventKeys] extends [never] ? true : never = true;

/** Types d'événements, dans l'ordre des index filaires. */
export const EVENT_TYPES = Object.keys(EVENT_KEYS) as EventType[];
const EVENT_INDEX = new Map<string, number>(EVENT_TYPES.map((t, i) => [t, i]));
const POS_FIELDS = new Set(['x', 'y', 'x0', 'x1']);
const ENUM_FIELDS: Record<string, readonly string[]> = { attack: ATTACK_IDS, enemyType: ENEMY_TYPES, move: ENEMY_MOVES, upgrade: UPGRADE_TABLE };

/**
 * Événement : [index du type, valeurs…] ; positions (x, y, x0, x1) au demi-pixel, énumérations
 * en index, le reste tel quel. Champs absents en fin de tuple omis (null au milieu). Type inconnu : objet copié.
 */
export function encodeEvent(ev: GameEvent): unknown {
  const ti = EVENT_INDEX.get(ev.type);
  if (ti === undefined) return { ...ev };
  const keys = EVENT_KEYS[ev.type] as readonly string[];
  const src = ev as unknown as Record<string, unknown>;
  const r: unknown[] = [ti];
  let last = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = src[k];
    if (v === undefined) {
      r.push(null);
      continue;
    }
    const table = ENUM_FIELDS[k];
    r.push(POS_FIELDS.has(k) ? qPos(v as number) : table ? encEnum(table, v as string) : v);
    last = r.length;
  }
  r.length = last || 1;
  return r;
}

/** Décode un événement ; null si son type est inconnu (serveur d'une autre version) : il est ignoré. */
function decodeEvent(x: unknown): GameEvent | null {
  if (!Array.isArray(x)) return x && typeof x === 'object' ? { ...(x as GameEvent) } : null;
  const type = EVENT_TYPES[x[0] as number];
  const keys = type === undefined ? undefined : (EVENT_KEYS[type] as readonly string[] | undefined);
  if (!keys) return null;
  const ev: Record<string, unknown> = { type };
  for (let i = 0; i < keys.length; i++) {
    const v = x[i + 1];
    if (v === undefined || v === null) continue;
    const k = keys[i];
    const table = ENUM_FIELDS[k];
    ev[k] = POS_FIELDS.has(k) ? dqPos(v as number) : table ? decEnum(table, v) : v;
  }
  return ev as unknown as GameEvent;
}

// ─── Instantané ─────────────────────────────────────────────────────────────

/** Encodeurs des parties partagées entre clients (remplaçables par une version en cache). */
export interface ViewEncoder {
  other(p: Player, t: number): unknown;
  enemy(e: Enemy): unknown;
  projectile(a: Projectile): unknown;
  orb(o: Orb): unknown;
  event(ev: GameEvent): unknown;
}

/** Encodeur direct (sans cache). */
export const DIRECT_ENCODER: ViewEncoder = {
  other: encodeOther,
  enemy: encodeEnemy,
  projectile: encodeProjectile,
  orb: encodeOrb,
  event: encodeEvent,
};

// ─── Duels ──────────────────────────────────────────────────────────────────

const DUEL_PHASES = enumTable<DuelPhase>()(['enter', 'kamae', 'open', 'resolve', 'end']);
const DUEL_SIDE_KEYS = ['pid', 'wins', 'strikeT', 'parryT', 'foul', 'react'] as const satisfies readonly (keyof DuelSide)[];
export const DUEL_SIDE_KEYS_COMPLETE: [Exclude<keyof DuelSide, (typeof DUEL_SIDE_KEYS)[number]>] extends [never] ? true : never = true;
const DUEL_KEYS = [
  'id', 'a', 'b', 'x', 'y', 'gap', 'phase', 't', 'round', 'played', 'sigTick', 'stage', 'last', 'winner', 'firstTo', 'maxRounds', 'draw',
] as const satisfies readonly (keyof Duel)[];
export const DUEL_KEYS_COMPLETE: [Exclude<keyof Duel, (typeof DUEL_KEYS)[number]>] extends [never] ? true : never = true;
const INVITE_KEYS = ['from', 'to', 'until', 'cd'] as const satisfies readonly (keyof DuelInvite)[];
export const INVITE_KEYS_COMPLETE: [Exclude<keyof DuelInvite, (typeof INVITE_KEYS)[number]>] extends [never] ? true : never = true;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const bool = (v: unknown): boolean => v === 1 || v === true;

function encodeSide(s: DuelSide): unknown[] {
  return DUEL_SIDE_KEYS.map((k) => (k === 'foul' ? (s.foul ? 1 : 0) : s[k]));
}
function decodeSide(a: unknown): DuelSide | null {
  if (!Array.isArray(a) || a.length !== DUEL_SIDE_KEYS.length) return null;
  const s = {} as Record<string, unknown>;
  DUEL_SIDE_KEYS.forEach((k, i) => (s[k] = k === 'foul' ? bool(a[i]) : num(a[i])));
  return Object.values(s).some((v) => typeof v === 'number' && Number.isNaN(v)) ? null : (s as unknown as DuelSide);
}
export function encodeDuel(d: Duel): unknown[] {
  return DUEL_KEYS.map((k) => {
    if (k === 'a' || k === 'b') return encodeSide(d[k]);
    if (k === 'phase') return encEnum(DUEL_PHASES, d.phase);
    if (k === 'draw') return d.draw ? 1 : 0;
    return d[k];
  });
}
/** Duel décodé, ou null s'il est mal formé (il est alors ignoré). */
export function decodeDuel(a: unknown): Duel | null {
  if (!Array.isArray(a) || a.length !== DUEL_KEYS.length) return null;
  const d = {} as Record<string, unknown>;
  for (let i = 0; i < DUEL_KEYS.length; i++) {
    const k = DUEL_KEYS[i];
    const v = a[i];
    if (k === 'a' || k === 'b') {
      const side = decodeSide(v);
      if (!side) return null;
      d[k] = side;
    } else if (k === 'phase') {
      const ph = decEnum(DUEL_PHASES, v);
      if (!(DUEL_PHASES as readonly string[]).includes(ph)) return null;
      d[k] = ph;
    } else if (k === 'draw') d[k] = bool(v);
    else {
      const n = num(v);
      if (Number.isNaN(n)) return null;
      d[k] = n;
    }
  }
  return d as unknown as Duel;
}
function encodeInvite(v: DuelInvite): unknown[] {
  return [v.from, v.to, v.until, v.cd ? 1 : 0];
}
function decodeInvite(a: unknown): DuelInvite | null {
  if (!Array.isArray(a) || a.length !== INVITE_KEYS.length) return null;
  const from = num(a[0]), to = num(a[1]), until = num(a[2]);
  if ([from, to, until].some(Number.isNaN)) return null;
  return { from, to, until, cd: bool(a[3]) };
}
const listOf = <T>(x: unknown, dec: (a: unknown) => T | null): T[] =>
  Array.isArray(x) ? x.map(dec).filter((v): v is T => v !== null) : [];

// ─── Tournoi (dojo) ─────────────────────────────────────────────────────────

const TOURNAMENT_PHASES = enumTable<TournamentPhase>()(['waiting', 'pause', 'running', 'done']);
const MATCH_STATES = enumTable<DojoMatch['state']>()(['pending', 'live', 'done']);
const TOURNAMENT_KEYS = ['n', 'phase', 't', 'startAt', 'round', 'champion', 'entrants', 'matches'] as const satisfies readonly (keyof Tournament)[];
export const TOURNAMENT_KEYS_COMPLETE: [Exclude<keyof Tournament, (typeof TOURNAMENT_KEYS)[number]>] extends [never] ? true : never = true;
/** Participant : [pid, nom, couleur, bits] (bot 1, parti 2, prêt 4). */
const ENTRANT_KEYS = ['pid', 'name', 'color', 'bot', 'gone', 'ready'] as const satisfies readonly (keyof DojoEntrant)[];
export const ENTRANT_KEYS_COMPLETE: [Exclude<keyof DojoEntrant, (typeof ENTRANT_KEYS)[number]>] extends [never] ? true : never = true;
const MATCH_KEYS = ['round', 'a', 'b', 'state', 'winner', 'why', 'wa', 'wb', 'duel'] as const satisfies readonly (keyof DojoMatch)[];
export const MATCH_KEYS_COMPLETE: [Exclude<keyof DojoMatch, (typeof MATCH_KEYS)[number]>] extends [never] ? true : never = true;
const EN_BOT = 1, EN_GONE = 2, EN_READY = 4;

export function encodeTournament(t: Tournament): unknown[] {
  return [
    t.n, encEnum(TOURNAMENT_PHASES, t.phase), t.t, t.startAt, t.round, t.champion,
    t.entrants.map((e) => [e.pid, e.name, e.color, (e.bot ? EN_BOT : 0) | (e.gone ? EN_GONE : 0) | (e.ready ? EN_READY : 0)]),
    t.matches.map((m) => [m.round, m.a, m.b, encEnum(MATCH_STATES, m.state), m.winner, m.why, m.wa, m.wb, m.duel]),
  ];
}
function decodeEntrant(a: unknown): DojoEntrant | null {
  if (!Array.isArray(a) || a.length !== 4 || typeof a[1] !== 'string') return null;
  const pid = num(a[0]), color = num(a[2]), bits = num(a[3]);
  if ([pid, color, bits].some(Number.isNaN)) return null;
  return { pid, name: a[1], color, bot: (bits & EN_BOT) !== 0, gone: (bits & EN_GONE) !== 0, ready: (bits & EN_READY) !== 0 };
}
function decodeMatch(a: unknown): DojoMatch | null {
  if (!Array.isArray(a) || a.length !== MATCH_KEYS.length) return null;
  const state = decEnum(MATCH_STATES, a[3]);
  if (!(MATCH_STATES as readonly string[]).includes(state)) return null;
  const n = [0, 1, 2, 4, 5, 6, 7, 8].map((i) => num(a[i]));
  if (n.some(Number.isNaN)) return null;
  return { round: n[0], a: n[1], b: n[2], state, winner: n[3], why: n[4], wa: n[5], wb: n[6], duel: n[7] };
}
/** Tournoi décodé, ou null s'il est absent ou mal formé (il est alors ignoré). */
export function decodeTournament(a: unknown): Tournament | null {
  if (!Array.isArray(a) || a.length !== TOURNAMENT_KEYS.length) return null;
  const phase = decEnum(TOURNAMENT_PHASES, a[1]);
  if (!(TOURNAMENT_PHASES as readonly string[]).includes(phase)) return null;
  const n = [0, 2, 3, 4, 5].map((i) => num(a[i]));
  if (n.some(Number.isNaN) || !Array.isArray(a[6]) || !Array.isArray(a[7])) return null;
  const entrants = listOf(a[6], decodeEntrant);
  const matches = listOf(a[7], decodeMatch);
  if (entrants.length !== a[6].length || matches.length !== a[7].length) return null;
  return { n: n[0], phase, t: n[1], startAt: n[2], round: n[3], entrants, matches, champion: n[4] };
}

/**
 * Forme filaire : tuple [t, ack, stage, stageInfo, wave, shrine, self, others, enemies, projectiles, orbs, events, away,
 * duels, invites, tournament].
 */
type Wire = [number, number, number, unknown[], unknown[], number, unknown[] | null, unknown[], unknown[], unknown[], unknown[], unknown[], number[], unknown[], unknown[], unknown[] | null];

/** Encode avec des encodeurs de vues donnés (snapshot.ts les met en cache par tick). */
export function encodeSnapshotWith(s: Snapshot, enc: ViewEncoder): SnapshotWire {
  const t = s.t;
  const wire: Wire = [
    t,
    s.ack,
    s.stage,
    encodeStage(s.stageInfo),
    encodeWave(s.wave),
    s.shrine,
    s.self ? encodeSelf(s.self) : null,
    s.others.map((p) => enc.other(p, t)),
    s.enemies.map((e) => enc.enemy(e)),
    s.projectiles.map((a) => enc.projectile(a)),
    s.orbs.map((o) => enc.orb(o)),
    s.events.map((ev) => enc.event(ev)),
    s.away,
    s.duels.map(encodeDuel),
    s.invites.map(encodeInvite),
    s.tournament ? encodeTournament(s.tournament) : null,
  ];
  return wire as unknown as SnapshotWire;
}

/**
 * Encode un instantané. `self` est transmis exactement ; les autres joueurs et les ennemis
 * sont réduits à leurs champs de vue (PLAYER_VIEW_KEYS, ENEMY_VIEW_KEYS), quantifiés.
 */
export function encodeSnapshot(s: Snapshot): SnapshotWire {
  return encodeSnapshotWith(s, DIRECT_ENCODER);
}

/** Joueur complet à partir de sa vue (champs hors vue : valeurs de départ de createPlayer). */
export function playerFromView(v: PlayerView): Player {
  return { ...createPlayer(v.id, v.name, v.x, v.y), ...v };
}

/**
 * Ennemi complet à partir de sa vue (champs hors vue : valeurs de createEnemy).
 * Type inconnu (repli du codec) : gabarit d'ashigaru, le type reçu est conservé.
 */
export function enemyFromView(v: EnemyView): Enemy {
  const base = (ENEMY_TYPES as readonly string[]).includes(v.type) ? v.type : 'ashigaru';
  return { ...createEnemy(v.id, base, v.x, v.y), ...v };
}

// ─── Robustesse au décodage ──────────────────────────────────────────────────
// Le client fait confiance au serveur, mais un instantané tronqué ou d'une autre version ne doit
// ni planter le jeu ni placer des entités en NaN : les entités (et événements) mal formés sont
// ignorés ; un joueur local mal formé ou une enveloppe illisible rendent l'instantané illisible
// (la source ferme alors la connexion avec un message).

/** Liste de tuples : tout ce qui n'est pas un tableau est écarté. */
const tuples = (x: unknown): unknown[][] => (Array.isArray(x) ? x.filter((a): a is unknown[] => Array.isArray(a)) : []);
/** Entité placée à une position finie. */
const placed = (o: { id: number; x: number; y: number; vx: number; vy: number }): boolean =>
  Number.isFinite(o.id) && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.vx) && Number.isFinite(o.vy);
/** Décodage d'une entité : null si elle est mal formée (elle est alors ignorée). */
function safe<T>(fn: (a: unknown[]) => T): (a: unknown[]) => T | null {
  return (a) => {
    try {
      return fn(a);
    } catch {
      return null;
    }
  };
}
const kept = <T extends { id: number; x: number; y: number; vx: number; vy: number }>(o: T | null): o is T => o !== null && placed(o);
/** Modèle des types attendus pour chaque champ du joueur local. */
const SELF_TEMPLATE = createPlayer(0, '', 0, 0) as unknown as Record<string, unknown>;
/** Champs du joueur local qui peuvent légitimement valoir NaN (Honneur perdu : aucun). */
const NAN_OK: ReadonlySet<string> = new Set(['lostX', 'lostY']);

/** Joueur local : chaque champ du type attendu, nombres finis (sauf lostX/lostY) — sinon illisible. */
function checkedSelf(p: Player): Player {
  const r = p as unknown as Record<string, unknown>;
  for (const k of SELF_KEYS) {
    const want = SELF_TEMPLATE[k];
    const v = r[k];
    // attack / chainNext : null ou chaîne ; tableaux : tableaux ; objets : objets.
    if (want === null) {
      if (v !== null && typeof v !== 'string') throw new Error(`instantané illisible : ${k}`);
    } else if (Array.isArray(want)) {
      if (!Array.isArray(v)) throw new Error(`instantané illisible : ${k}`);
    } else if (typeof v !== typeof want) {
      throw new Error(`instantané illisible : ${k}`);
    } else if (typeof v === 'number' && !Number.isFinite(v) && !NAN_OK.has(k)) {
      throw new Error(`instantané illisible : ${k}`);
    }
  }
  return p;
}

/** Décode un instantané reçu : objets indépendants, prêts à être placés dans un monde. */
export function decodeSnapshot(wire: SnapshotWire): Snapshot {
  const w = wire as unknown as Wire;
  const t = w[0];
  return {
    t,
    ack: w[1],
    stage: w[2],
    stageInfo: decodeStage(w[3]),
    wave: decodeWave(w[4]),
    shrine: w[5],
    self: w[6] ? checkedSelf(decodeSelf(w[6])) : null,
    others: tuples(w[7]).map(safe((a) => playerFromView(decodeOtherView(a, t)))).filter(kept),
    enemies: tuples(w[8]).map(safe((a) => enemyFromView(decodeEnemyView(a)))).filter(kept),
    projectiles: tuples(w[9]).map(safe(decodeProjectile)).filter(kept),
    orbs: tuples(w[10]).map(safe(decodeOrb)).filter(kept),
    events: (Array.isArray(w[11]) ? (w[11] as unknown[]) : []).map(decodeEvent).filter((ev): ev is GameEvent => ev !== null),
    away: Array.isArray(w[12]) ? (w[12] as unknown[]).filter((id): id is number => Number.isFinite(id)) : [],
    duels: listOf(w[13], decodeDuel),
    invites: listOf(w[14], decodeInvite),
    tournament: decodeTournament(w[15]),
  };
}

