import { COOP, COOP_CLEARED_TICKS, COOP_READY_AFTER, TICK_RATE, TILE } from './constants';
import { clearBonus, enemyHpScale, guardianHpScale } from './difficulty';
import { interruptDuels } from './duel';
import { spawnEnemy } from './enemy';
import { addScore, emptyStageStats, gainHonor, releaseToken, stageStatsOf } from './interactions';
import { BTN } from './input';
import { arenaInside, T_KEKKAI, T_SOLID } from './level';
import { handlePicks, resetAfterDeath, resetForStage } from './player';
import { buildStage } from './stagebuild';
import type { Enemy, StageState, World } from './types';

// Déroulé d'une étape : exploration → arène du gardien → porte ouverte → bilan,
// puis retour à l'étape 1 en plus difficile (boucle du voyage).

export function newStageState(loop: number, tick: number): StageState {
  return {
    loop, state: 'playing', t: 0, startTick: tick, kills: 0, parries: 0, deaths: 0,
    honor: 0, bestCombo: 0, guardianId: 0, grade: 2, bonus: 0, time: 0,
  };
}

/**
 * Coop : ouvre les statistiques d'étape par joueur (vierges) pour tous les joueurs présents.
 * Sans effet en solo : la clé byPlayer reste absente.
 */
export function openStageStats(w: World): void {
  if (w.mode !== 'coop') return;
  w.stage.byPlayer = {};
  for (const p of w.players) w.stage.byPlayer[p.id] = emptyStageStats();
}

/** Peuple l'étape avec ses ennemis de départ. */
export function populateStage(w: World): void {
  const hp = enemyHpScale(w);
  for (const s of w.level.enemySpawns) spawnEnemy(w, s.type, s.x, s.y, false, hp);
}

/**
 * Pose (on) ou retire la barrière de l'arène dans les tuiles du niveau. En coop, c'est un kekkai à
 * sens unique (on peut toujours rejoindre le combat, jamais le fuir) ; en solo, un mur plein.
 */
export function setBarrier(w: World, on: boolean): void {
  const l = w.level;
  const a = l.arena;
  const wall = w.mode === 'coop' ? T_KEKKAI : T_SOLID;
  for (let r = 0; r < a.rows; r++) l.tiles[r * l.w + a.col] = on ? wall : a.backup[r];
}

const inArena = (w: World, x: number) => arenaInside(w.level, x);

/** Retire les ennemis désignés par `gone` en libérant leur jeton d'attaque (sinon perdu jusqu'à l'étape suivante). */
function removeEnemies(w: World, gone: (e: Enemy) => boolean): void {
  w.enemies = w.enemies.filter((e) => {
    if (!gone(e)) return true;
    releaseToken(w, e);
    return false;
  });
}

/** Joueur absent (coop en ligne : aucun bouton depuis un moment) ? Toujours faux en solo. */
export function isAway(w: World, id: number): boolean {
  return !!w.away && w.away.includes(id);
}

/** Coop : multiplicateur de PV du gardien pour `n` joueurs actifs. */
const guardianCoopMult = (n: number): number => 1 + COOP.GUARDIAN_HP_PER_PLAYER * Math.max(0, n - 1);

/**
 * Coop, pendant l'arène : un joueur absent à la fermeture qui revient renforce le gardien en proportion
 * (un arrivant en cours de combat ne change rien).
 * La force ne baisse jamais : rester absent juste avant la fermeture ne l'affaiblit pas pour de bon.
 */
function scaleGuardianUp(w: World): void {
  const pool = w.guardianPool;
  if (!pool) return;
  // Joueurs présents à la fermeture, toujours là et actifs (un arrivant ne compte pas).
  let n = 0;
  for (const p of w.players) if (pool.includes(p.id) && !isAway(w, p.id)) n++;
  const was = w.guardianFor ?? n;
  if (n <= was) return;
  w.guardianFor = n;
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (!g) return;
  const k = guardianCoopMult(n) / guardianCoopMult(was);
  g.maxHp *= k;
  g.hp *= k;
}

/** Joueurs présents et actifs : ceux qui comptent pour la force du gardien et pour le vote. */
export function activeCount(w: World): number {
  if (!w.away || !w.away.length) return w.players.length;
  let n = 0;
  for (const p of w.players) if (!isAway(w, p.id)) n++;
  return n;
}

export function stepStage(w: World): void {
  const st = w.stage;
  st.t++;
  for (const p of w.players) {
    st.bestCombo = Math.max(st.bestCombo, p.combo);
    const ps = stageStatsOf(w, p);
    if (ps) ps.bestCombo = Math.max(ps.bestCombo, p.combo);
  }
  const a = w.level.arena;

  switch (st.state) {
    case 'playing': {
      if (w.players.some((p) => p.state !== 'dead' && p.onGround && p.x > a.trigger)) lockArena(w);
      break;
    }
    case 'arena': {
      if (w.mode === 'coop') scaleGuardianUp(w);
      // Salle vide (coop) : every() serait vrai, mais personne n'a perdu — l'arène reste fermée.
      // Coop : l'arène se rouvre dès qu'aucun joueur vivant n'est plus à l'intérieur (ceux du dehors
      // ne sont pas touchés) ; solo : quand le joueur est mort.
      const lost =
        w.mode === 'coop'
          ? !w.players.some((p) => p.state !== 'dead' && inArena(w, p.x))
          : w.players.every((p) => p.state === 'dead');
      if (w.players.length > 0 && lost) {
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
  // Ennemis de l'arène retirés, et ceux à cheval sur la barrière (corps qui dépasse la colonne),
  // sinon encastrés dans le mur.
  const edge = a.col * TILE;
  removeEnemies(w, (e) => inArena(w, e.x) || e.x + e.w / 2 > edge);
  w.projectiles = [];
  w.wave.phase = 'calm';
  w.wave.t = 0;
  // Coop : le gardien est plus robuste selon les joueurs actifs (morts compris, absents exclus) ;
  // si des absents reviennent pendant le combat, sa force monte (voir stepStage), elle ne baisse jamais.
  if (w.mode === 'coop') {
    w.guardianPool = w.players.map((p) => p.id);
    w.guardianFor = Math.max(1, activeCount(w));
  }
  const hpMult = w.mode === 'coop' ? guardianHpScale(w) * guardianCoopMult(w.guardianFor ?? 1) : guardianHpScale(w);
  const g = spawnEnemy(w, 'boss', a.guardianX, a.guardianY, false, hpMult);
  g.state = 'intro';
  g.facing = -1;
  st.guardianId = g.id;
  w.events.push({ type: 'arenaLock', x: (a.col + 0.5) * TILE });
  w.events.push({ type: 'bossSpawn', id: g.id, x: g.x, y: g.y });
}

/** Plus personne ne combat dans l'arène : elle se rouvre, le gardien attendra. */
function resetArena(w: World): void {
  const st = w.stage;
  removeEnemies(w, (e) => inArena(w, e.x) || e.id === st.guardianId);
  w.projectiles = [];
  setBarrier(w, false);
  st.state = 'playing';
  st.t = 0;
  st.guardianId = 0;
  w.events.push({ type: 'arenaReset' });
}

function clearStage(w: World): void {
  interruptDuels(w); // duels arrêtés sans résultat (sans effet en solo)
  const st = w.stage;
  st.state = 'cleared';
  st.t = 0;
  st.time = w.tick - st.startTick;
  if (w.mode === 'coop' && st.byPlayer && w.players.length > 0) clearStageCoop(w);
  else {
    st.grade = gradeOf(st.deaths, st.time);
    st.bonus = clearBonus(st.grade, st.loop);
    for (const p of w.players) {
      gainHonor(w, p, st.bonus);
      if (!p.out) addScore(w, p, st.bonus);
    }
  }
  w.events.push({ type: 'stageClear', loop: st.loop, grade: st.grade, bonus: st.bonus });
}

/** Note d'étape : 0 = 優 (aucune mort et moins de 6 min), 1 = 良 (au plus une mort), 2 = 可. */
const gradeOf = (deaths: number, time: number): number => (deaths === 0 && time < 6 * 60 * TICK_RATE ? 0 : deaths <= 1 ? 1 : 2);

/**
 * Coop : chaque joueur reçoit sa note (selon ses propres morts) et le bonus correspondant ;
 * la « note de la salle » (st.grade, st.bonus, portée par stageClear) est la note médiane
 * (pour un nombre pair de joueurs, la meilleure des deux notes centrales).
 */
function clearStageCoop(w: World): void {
  const st = w.stage;
  const grades: number[] = [];
  for (const p of w.players) {
    const ps = stageStatsOf(w, p);
    const grade = gradeOf(ps ? ps.deaths : 0, st.time);
    const bonus = clearBonus(grade, st.loop);
    if (ps) {
      ps.grade = grade;
      ps.bonus = bonus;
    }
    grades.push(grade);
    gainHonor(w, p, bonus);
    if (!p.out) addScore(w, p, bonus);
  }
  grades.sort((x, y) => x - y);
  st.grade = grades[(grades.length - 1) >> 1];
  st.bonus = clearBonus(st.grade, st.loop);
}

/** Pendant le bilan : seuls les choix d'amélioration et « reprendre la route » comptent. */
export function stepCleared(w: World, inputs: Map<number, number>): void {
  const st = w.stage;
  st.t++;
  const coop = w.mode === 'coop';
  let proceed = false;
  let ready = 0;
  for (const p of w.players) {
    // Solo : le bouton DUEL n'existe pas (prevButtons identique au bit près).
    const b = (inputs.get(p.id) ?? 0) & (coop ? ~0 : ~BTN.DUEL);
    const pressed = b & ~p.prevButtons;
    p.prevButtons = b;
    handlePicks(w, p, pressed);
    if (coop) {
      // Coop : un appui vaut un vote « prêt », définitif (les morts votent aussi).
      const ps = stageStatsOf(w, p);
      if (!ps) continue;
      if (st.t > COOP_READY_AFTER && pressed & (BTN.JUMP | BTN.ATTACK)) ps.ready = true;
      if (ps.ready && !isAway(w, p.id)) ready++;
    } else if (st.t > 90 && pressed & (BTN.JUMP | BTN.ATTACK)) proceed = true;
  }
  if (coop) {
    // Majorité stricte des joueurs actifs (les absents ne comptent pas) ; sinon, personne ne bloque
    // la salle : la route reprend d'elle-même.
    const active = activeCount(w);
    if ((active > 0 && ready * 2 > active) || st.t >= COOP_CLEARED_TICKS) proceed = true;
  }
  if (proceed) nextStage(w);
}

/** Retour à l'étape 1, une boucle plus loin. Améliorations et Honneur sont conservés. */
export function nextStage(w: World): void {
  interruptDuels(w); // sans effet en solo
  const loop = w.stage.loop + 1;
  Object.assign(w.level, buildStage(loop, w.seed));
  w.enemies = [];
  w.projectiles = [];
  w.orbs = [];
  w.attackTokens = 0;
  w.spawnTimer = 240;
  w.wave = { n: 0, phase: 'calm', t: 0, kills: 0, quota: 0 };
  w.stage = newStageState(loop, w.tick);
  w.shrine = 0;
  openStageStats(w);
  for (const p of w.players) {
    // Coop : un joueur encore mort au passage d'étape repart comme après une renaissance.
    if (w.mode === 'coop' && p.state === 'dead') resetAfterDeath(p);
    resetForStage(p, w.level.spawn.x, w.level.spawn.y);
  }
  populateStage(w);
  w.events.push({ type: 'stageStart', loop });
}

/** Outil de debug : téléporte le joueur à l'entrée de l'arène. */
export function warpToArena(w: World, pid?: number): void {
  const p = pid === undefined ? w.players[0] : w.players.find((q) => q.id === pid);
  if (!p || w.stage.state !== 'playing') return;
  p.x = (w.level.arena.col + 1.5) * TILE;
  p.y = w.level.arena.guardianY;
  p.vx = 0;
  p.vy = 0;
}
