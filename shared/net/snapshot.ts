// Instantanés du mode en ligne : construits par le serveur, appliqués par le client.
// Le niveau n'est jamais transmis : il se reconstruit à partir de la graine et du numéro d'étape.
import { setBarrier } from '../stage';
import { buildStage } from '../stagebuild';
import type { GameEvent, World } from '../types';
import { INTEREST_PX, type SnapshotMsg } from './protocol';

const near = (x: number, cx: number) => Math.abs(x - cx) <= INTEREST_PX;

/** Un événement est-il visible depuis `cx` ? (les événements sans position concernent toute la salle) */
function eventVisible(ev: GameEvent, cx: number): boolean {
  if ('x' in ev && typeof ev.x === 'number') return near(ev.x, cx);
  if (ev.type === 'iai') return near(ev.x0, cx) || near(ev.x1, cx);
  return true;
}

/** Instantané pour le joueur `viewerId` : tous les joueurs, le reste filtré autour de lui. */
export function makeSnapshot(w: World, viewerId: number, events: GameEvent[], ack: number): SnapshotMsg {
  const viewer = w.players.find((p) => p.id === viewerId);
  const cx = viewer ? viewer.x : w.level.spawn.x;
  return {
    t: w.tick,
    ack,
    stage: w.level.stage,
    stageInfo: w.stage,
    wave: w.wave,
    players: w.players,
    enemies: w.enemies.filter((e) => near(e.x, cx)),
    projectiles: w.projectiles.filter((a) => near(a.x, cx)),
    orbs: w.orbs.filter((o) => near(o.x, cx)),
    events: events.filter((ev) => eventVisible(ev, cx)),
  };
}

/**
 * Applique un instantané sur le monde local du client (créé avec la même graine).
 * La référence `w.level` est conservée ; la barrière de l'arène est réappliquée d'après l'état d'étape.
 */
export function applySnapshot(w: World, snap: SnapshotMsg): { stageChanged: boolean } {
  let stageChanged = false;
  if (snap.stage !== w.level.stage) {
    Object.assign(w.level, buildStage(snap.stage, w.seed));
    stageChanged = true;
  }
  w.tick = snap.t;
  w.stage = snap.stageInfo;
  w.wave = snap.wave;
  w.players = snap.players;
  w.enemies = snap.enemies;
  w.projectiles = snap.projectiles;
  w.orbs = snap.orbs;
  setBarrier(w, snap.stageInfo.state === 'arena');
  return { stageChanged };
}
