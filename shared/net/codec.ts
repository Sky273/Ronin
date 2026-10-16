// Codec des instantanés : forme décodée (Snapshot) ↔ forme transmise (SnapshotWire, opaque).
// Seul ce module connaît la forme filaire ; tout le reste passe par encodeSnapshot / decodeSnapshot.
// Version de référence : objets restreints aux champs de vue (la forme compacte viendra ici).
import { createEnemy } from '../enemy';
import { createPlayer } from '../player';
import type { Enemy, Player } from '../types';
import { ENEMY_VIEW_KEYS, PLAYER_VIEW_KEYS, type EnemyView, type PlayerView, type Snapshot } from './protocol';

/** Instantané tel qu'il circule (msgpack). Opaque hors de ce module. */
export interface SnapshotWire {
  readonly __snapshotWire?: never;
}

/** Forme filaire de référence. */
interface RefWire {
  t: number;
  ack: number;
  stage: number;
  stageInfo: Snapshot['stageInfo'];
  wave: Snapshot['wave'];
  shrine: number;
  self: Player | null;
  others: PlayerView[];
  enemies: EnemyView[];
  projectiles: Snapshot['projectiles'];
  orbs: Snapshot['orbs'];
  events: Snapshot['events'];
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const r = {} as Pick<T, K>;
  for (const k of keys) r[k] = o[k];
  return r;
}

/**
 * Encode un instantané. `self` est transmis exactement ; les autres joueurs et les ennemis
 * sont réduits à leurs champs de vue (PLAYER_VIEW_KEYS, ENEMY_VIEW_KEYS).
 */
export function encodeSnapshot(s: Snapshot): SnapshotWire {
  const wire: RefWire = {
    t: s.t,
    ack: s.ack,
    stage: s.stage,
    stageInfo: s.stageInfo,
    wave: s.wave,
    shrine: s.shrine,
    self: s.self,
    others: s.others.map((p) => pick(p, PLAYER_VIEW_KEYS)),
    enemies: s.enemies.map((e) => pick(e, ENEMY_VIEW_KEYS)),
    projectiles: s.projectiles,
    orbs: s.orbs,
    events: s.events,
  };
  return wire as SnapshotWire;
}

/** Joueur complet à partir de sa vue (champs hors vue : valeurs de départ de createPlayer). */
export function playerFromView(v: PlayerView): Player {
  return { ...createPlayer(v.id, v.name, v.x, v.y), ...v };
}

/** Ennemi complet à partir de sa vue (champs hors vue : valeurs de createEnemy). */
export function enemyFromView(v: EnemyView): Enemy {
  return { ...createEnemy(v.id, v.type, v.x, v.y), ...v };
}

/** Décode un instantané reçu : objets indépendants, prêts à être placés dans un monde. */
export function decodeSnapshot(wire: SnapshotWire): Snapshot {
  const w = wire as RefWire;
  return {
    t: w.t,
    ack: w.ack,
    stage: w.stage,
    stageInfo: w.stageInfo,
    wave: w.wave,
    shrine: w.shrine,
    self: w.self,
    others: w.others.map(playerFromView),
    enemies: w.enemies.map(enemyFromView),
    projectiles: w.projectiles,
    orbs: w.orbs,
    events: w.events,
  };
}
