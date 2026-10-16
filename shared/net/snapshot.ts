// Instantanés du mode en ligne : construits par le serveur, appliqués par le client.
// Le niveau n'est jamais transmis : il se reconstruit à partir de la graine et du numéro d'étape.
import { setBarrier } from '../stage';
import { buildStage } from '../stagebuild';
import type { GameEvent, World } from '../types';
import { encodeSnapshot, type SnapshotWire } from './codec';
import { INTEREST_PX, type Snapshot } from './protocol';

const near = (x: number, cx: number) => Math.abs(x - cx) <= INTEREST_PX;

/** Un événement est-il visible depuis `cx` ? (les événements sans position concernent toute la salle) */
function eventVisible(ev: GameEvent, cx: number): boolean {
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
  };
}

/** Instantané encodé pour le joueur `viewerId` (prêt à être envoyé). */
export function makeSnapshot(w: World, viewerId: number, events: GameEvent[], ack: number): SnapshotWire {
  return encodeSnapshot(snapshotFor(w, viewerId, events, ack));
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
  setBarrier(w, snap.stageInfo.state === 'arena');
  return { stageChanged };
}
