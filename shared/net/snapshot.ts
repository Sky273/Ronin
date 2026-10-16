// Instantanés du mode en ligne : construits par le serveur, appliqués par le client.
// Le niveau n'est jamais transmis : il se reconstruit à partir de la graine et du numéro d'étape.
import { setBarrier } from '../stage';
import { buildStage } from '../stagebuild';
import type { Enemy, GameEvent, Orb, Player, Projectile, World } from '../types';
import { encodeEnemy, encodeEvent, encodeOrb, encodeOther, encodeProjectile, encodeSnapshotWith, type SnapshotWire, type ViewEncoder } from './codec';
import { INTEREST_PX, type Snapshot } from './protocol';

const near = (x: number, cx: number) => Math.abs(x - cx) <= INTEREST_PX;

/** Événements situés mais qui concernent toute la salle (sanctuaire commun, arène, porte). */
const ROOM_WIDE: ReadonlySet<GameEvent['type']> = new Set<GameEvent['type']>(['checkpoint', 'arenaLock', 'gateOpen']);

/** Un événement est-il visible depuis `cx` ? (les événements sans position concernent toute la salle) */
function eventVisible(ev: GameEvent, cx: number): boolean {
  if (ROOM_WIDE.has(ev.type)) return true;
  if ('x' in ev && typeof ev.x === 'number') return near(ev.x, cx);
  if (ev.type === 'iai') return near(ev.x0, cx) || near(ev.x1, cx);
  return true;
}

/** Contenu d'un instantané pour `viewerId` (forme décodée) : soi exact, le reste filtré autour de lui. */
export function snapshotFor(w: World, viewerId: number, events: GameEvent[], ack: number): Snapshot {
  const viewer = w.players.find((p) => p.id === viewerId) ?? null;
  const cx = viewer ? viewer.x : w.level.spawn.x;
  return {
    t: w.tick,
    ack,
    stage: w.level.stage,
    stageInfo: w.stage,
    wave: w.wave,
    shrine: w.shrine,
    self: viewer,
    others: w.players.filter((p) => p !== viewer),
    enemies: w.enemies.filter((e) => near(e.x, cx)),
    projectiles: w.projectiles.filter((a) => near(a.x, cx)),
    orbs: w.orbs.filter((o) => near(o.x, cx)),
    events: events.filter((ev) => eventVisible(ev, cx)),
    away: w.away ?? [],
  };
}

/**
 * Cache des vues encodées d'un monde pour un tick : les vues partagées entre clients (autres joueurs,
 * ennemis, projectiles, orbes, événements) ne sont encodées qu'une fois par tick, quel que soit le
 * nombre de destinataires. Clé : l'objet lui-même (un monde serveur ne modifie ses entités qu'en
 * avançant d'un tick, et son tick ne recule jamais).
 */
interface TickCache {
  tick: number;
  encoder: ViewEncoder;
}
const caches = new WeakMap<World, TickCache>();

/** Encodeur mémoïsé par objet. */
function memo<T extends object, A extends unknown[]>(fn: (o: T, ...args: A) => unknown): (o: T, ...args: A) => unknown {
  const m = new Map<T, unknown>();
  return (o, ...args) => {
    let r = m.get(o);
    if (r === undefined) {
      r = fn(o, ...args);
      m.set(o, r);
    }
    return r;
  };
}

function encoderFor(w: World): ViewEncoder {
  let c = caches.get(w);
  if (!c || c.tick !== w.tick) {
    // L'âge des ticks des autres joueurs dépend de t : identique pour tout le tick.
    c = {
      tick: w.tick,
      encoder: {
        other: memo<Player, [number]>(encodeOther),
        enemy: memo<Enemy, []>(encodeEnemy),
        projectile: memo<Projectile, []>(encodeProjectile),
        orb: memo<Orb, []>(encodeOrb),
        event: memo<GameEvent, []>(encodeEvent),
      },
    };
    caches.set(w, c);
  }
  return c.encoder;
}

/** Instantané encodé pour le joueur `viewerId` (prêt à être envoyé). Vues partagées en cache par tick. */
export function makeSnapshot(w: World, viewerId: number, events: GameEvent[], ack: number): SnapshotWire {
  return encodeSnapshotWith(snapshotFor(w, viewerId, events, ack), encoderFor(w));
}

/**
 * Applique un instantané décodé sur le monde local du client (créé avec la même graine).
 * La référence `w.level` est conservée ; la barrière de l'arène est réappliquée d'après l'état d'étape.
 * Le joueur destinataire est placé en tête de `w.players`.
 */
export function applySnapshot(w: World, snap: Snapshot): { stageChanged: boolean } {
  let stageChanged = false;
  if (snap.stage !== w.level.stage) {
    Object.assign(w.level, buildStage(snap.stage, w.seed));
    stageChanged = true;
  }
  w.tick = snap.t;
  w.stage = snap.stageInfo;
  w.wave = snap.wave;
  w.shrine = snap.shrine;
  w.players = snap.self ? [snap.self, ...snap.others] : snap.others;
  w.enemies = snap.enemies;
  w.projectiles = snap.projectiles;
  w.orbs = snap.orbs;
  if (w.mode === 'coop') w.away = snap.away;
  setBarrier(w, snap.stageInfo.state === 'arena');
  return { stageChanged };
}
