import { TICK_RATE, TILE } from './constants';
import { clearBonus, enemyHpMult, guardianHpMult } from './difficulty';
import { spawnEnemy } from './enemy';
import { gainHonor } from './interactions';
import { BTN } from './input';
import { buildLevel, T_SOLID } from './level';
import { handlePicks, resetForStage } from './player';
import type { StageState, World } from './types';

// Déroulé d'une étape : exploration → arène du gardien → porte ouverte → bilan,
// puis retour à l'étape 1 en plus difficile (boucle du voyage).

export function newStageState(loop: number, tick: number): StageState {
  return {
    loop, state: 'playing', t: 0, startTick: tick, kills: 0, parries: 0, deaths: 0,
    honor: 0, bestCombo: 0, guardianId: 0, grade: 2, bonus: 0, time: 0,
  };
}

/** Peuple l'étape avec ses ennemis de départ. */
export function populateStage(w: World): void {
  const hp = enemyHpMult(w.stage.loop);
  for (const s of w.level.enemySpawns) spawnEnemy(w, s.type, s.x, s.y, false, hp);
}

function setBarrier(w: World, on: boolean): void {
  const l = w.level;
  const a = l.arena;
  for (let r = 0; r < a.rows; r++) l.tiles[r * l.w + a.col] = on ? T_SOLID : a.backup[r];
}

const inArena = (w: World, x: number) => x > (w.level.arena.col + 1) * TILE;

export function stepStage(w: World): void {
  const st = w.stage;
  st.t++;
  for (const p of w.players) st.bestCombo = Math.max(st.bestCombo, p.combo);
  const a = w.level.arena;

  switch (st.state) {
    case 'playing': {
      if (w.players.some((p) => p.state !== 'dead' && p.onGround && p.x > a.trigger)) lockArena(w);
      break;
    }
    case 'arena': {
      if (w.players.every((p) => p.state === 'dead')) {
        resetArena(w);
        break;
      }
      if (!w.enemies.some((e) => e.id === st.guardianId)) {
        st.state = 'gateOpen';
        st.t = 0;
        setBarrier(w, false);
        w.events.push({ type: 'gateOpen', x: w.level.gate.x, y: w.level.gate.y });
      }
      break;
    }
    case 'gateOpen': {
      const g = w.level.gate;
      if (w.players.some((p) => p.state !== 'dead' && p.x > g.x - 14 && Math.abs(p.y - g.y) < 70)) clearStage(w);
      break;
    }
    case 'cleared':
      break;
  }
}

/** Le kekkai se referme : duel contre le gardien, sans Marée ni renforts. */
function lockArena(w: World): void {
  const st = w.stage;
  const a = w.level.arena;
  st.state = 'arena';
  st.t = 0;
  setBarrier(w, true);
  w.enemies = w.enemies.filter((e) => !inArena(w, e.x));
  w.projectiles = [];
  w.wave.phase = 'calm';
  w.wave.t = 0;
  const g = spawnEnemy(w, 'boss', a.guardianX, a.guardianY, false, guardianHpMult(st.loop));
  g.state = 'intro';
  g.facing = -1;
  st.guardianId = g.id;
  w.events.push({ type: 'arenaLock', x: (a.col + 0.5) * TILE });
  w.events.push({ type: 'bossSpawn', id: g.id, x: g.x, y: g.y });
}

/** Tous les joueurs sont morts dans l'arène : elle se rouvre, le gardien attendra. */
function resetArena(w: World): void {
  const st = w.stage;
  w.enemies = w.enemies.filter((e) => !inArena(w, e.x) && e.id !== st.guardianId);
  w.projectiles = [];
  setBarrier(w, false);
  st.state = 'playing';
  st.t = 0;
  st.guardianId = 0;
  w.events.push({ type: 'arenaReset' });
}

function clearStage(w: World): void {
  const st = w.stage;
  st.state = 'cleared';
  st.t = 0;
  st.time = w.tick - st.startTick;
  st.grade = st.deaths === 0 && st.time < 6 * 60 * TICK_RATE ? 0 : st.deaths <= 1 ? 1 : 2;
  st.bonus = clearBonus(st.grade, st.loop);
  for (const p of w.players) gainHonor(w, p, st.bonus);
  w.events.push({ type: 'stageClear', loop: st.loop, grade: st.grade, bonus: st.bonus });
}

/** Pendant le bilan : seuls les choix d'amélioration et « reprendre la route » comptent. */
export function stepCleared(w: World, inputs: Map<number, number>): void {
  const st = w.stage;
  st.t++;
  let proceed = false;
  for (const p of w.players) {
    const b = inputs.get(p.id) ?? 0;
    const pressed = b & ~p.prevButtons;
    p.prevButtons = b;
    handlePicks(w, p, pressed);
    if (st.t > 90 && pressed & (BTN.JUMP | BTN.ATTACK)) proceed = true;
  }
  if (proceed) nextStage(w);
}

/** Retour à l'étape 1, une boucle plus loin. Améliorations et Honneur sont conservés. */
export function nextStage(w: World): void {
  const loop = w.stage.loop + 1;
  Object.assign(w.level, buildLevel());
  w.enemies = [];
  w.projectiles = [];
  w.orbs = [];
  w.attackTokens = 0;
  w.spawnTimer = 240;
  w.wave = { n: 0, phase: 'calm', t: 0, kills: 0, quota: 0 };
  w.stage = newStageState(loop, w.tick);
  for (const p of w.players) resetForStage(p, w.level.spawn.x, w.level.spawn.y);
  populateStage(w);
  w.events.push({ type: 'stageStart', loop });
}

/** Outil de debug : téléporte le joueur à l'entrée de l'arène. */
export function warpToArena(w: World): void {
  const p = w.players[0];
  if (!p || w.stage.state !== 'playing') return;
  p.x = (w.level.arena.col + 1.5) * TILE;
  p.y = w.level.arena.guardianY;
  p.vx = 0;
  p.vy = 0;
}
