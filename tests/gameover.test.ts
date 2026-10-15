// Tests headless : difficulté, vies, score et fin de partie (simulation partagée, aucun rendu).
// Lancer : npm run test:gameover
import { PLAYER, SPAWN } from '../shared/constants';
import { damagePlayer, killEnemy } from '../shared/interactions';
import { BTN } from '../shared/input';
import { T_SOLID } from '../shared/level';
import {
  DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId, enemyCooldownMult, enemyCooldownScale, enemyDmgMult, enemyDmgScale,
  enemyHpMult, enemyHpScale, extraEnemies, extraEnemiesFor, guardianHpMult, guardianHpScale, loopScoreMult,
} from '../shared/difficulty';
import type { GameEvent, Player, World } from '../shared/types';
import { addPlayer, createWorld, resetWorld, stepWorld, warpToArena } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

// ─── Outils ────────────────────────────────────────────────────────────────

/** Avance de n ticks avec un masque d'entrées ; renvoie les événements émis. */
function step(w: World, p: Player, n: number, input: number | ((t: number) => number) = 0, each?: () => void): GameEvent[] {
  const m = new Map<number, number>();
  const evs: GameEvent[] = [];
  for (let t = 0; t < n; t++) {
    each?.();
    m.set(p.id, typeof input === 'number' ? input : input(t));
    stepWorld(w, m);
    evs.push(...w.events);
    w.events.length = 0;
  }
  return evs;
}

/** Mort immédiate (coup fatal). */
function kill(w: World, p: Player): void {
  p.iframes = 0;
  if (p.state === 'dead') return;
  damagePlayer(w, p, 1e6, p.x + 1);
}

/** Attend la renaissance (le joueur n'est plus mort). */
function waitRespawn(w: World, p: Player): GameEvent[] {
  return step(w, p, PLAYER.RESPAWN_TICKS + 5);
}

/** Entre dans l'arène et verrouille le kekkai. */
function enterArena(w: World, p: Player): GameEvent[] {
  warpToArena(w);
  return step(w, p, 30, BTN.RIGHT);
}

const barrierSolid = (w: World): boolean => w.level.tiles[10 * w.level.w + w.level.arena.col] === T_SOLID;
const count = (evs: GameEvent[], type: GameEvent['type']) => evs.filter((e) => e.type === type).length;

/** Termine l'étape : gardien abattu, porte franchie ; renvoie les événements. */
function clearCurrentStage(w: World, p: Player): GameEvent[] {
  const evs = enterArena(w, p);
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (g) killEnemy(w, g, p, 0, false);
  evs.push(...step(w, p, 2));
  p.x = w.level.gate.x - 60;
  p.y = w.level.gate.y;
  evs.push(...step(w, p, 40, BTN.RIGHT));
  return evs;
}

/** Reprend la route depuis le bilan (après le délai anti-saut). */
function proceed(w: World, p: Player): GameEvent[] {
  const evs = step(w, p, 100);
  evs.push(...step(w, p, 1, BTN.JUMP));
  evs.push(...step(w, p, 1));
  return evs;
}

const expectedScore = (d: DifficultyId, loop: number, base: number) =>
  Math.round(base * DIFFICULTIES[d].scoreMult * loopScoreMult(loop));

// 1. Normal = comportement historique : multiplicateurs combinés identiques aux multiplicateurs par boucle.
{
  let ok = true;
  const w = createWorld(1, { difficulty: 'normal' });
  for (let loop = 0; loop <= 5; loop++) {
    w.stage.loop = loop;
    ok &&= enemyHpScale(w) === enemyHpMult(loop) && guardianHpScale(w) === guardianHpMult(loop) &&
      enemyDmgScale(w) === enemyDmgMult(loop) && enemyCooldownScale(w) === enemyCooldownMult(loop) &&
      extraEnemiesFor(w) === extraEnemies(loop);
  }
  check('normal : multiplicateurs combinés = multiplicateurs historiques par boucle (boucles 0..5)', ok);
  const p = addPlayer(createWorld(1), 'n');
  check('normal : 5 vies par défaut', p.lives === 5 && DIFFICULTIES.normal.lives === 5);
}

// 2. Dernière vie perdue dans l'arène du gardien (très difficile : 1 vie).
{
  const w = createWorld(6, { difficulty: 'veryHard' });
  const p = addPlayer(w, 'arène');
  const lockEvs = enterArena(w, p);
  const locked = w.stage.state === 'arena' && barrierSolid(w) && count(lockEvs, 'arenaLock') === 1;
  kill(w, p);
  const evs = step(w, p, 1);
  const reopened = w.stage.state === 'playing' && !barrierSolid(w) && !w.enemies.some((e) => e.type === 'boss') && count(evs, 'arenaReset') === 1;
  evs.push(...step(w, p, PLAYER.GAME_OVER_DELAY + 50));
  const overs = evs.filter((e) => e.type === 'gameOver');
  check(
    'arène : dernière mort → arène rouverte puis game over unique',
    locked && reopened && w.over && overs.length === 1 && count(evs, 'respawn') === 0 && count(evs, 'arenaLock') === 0,
    `verrou=${locked} rouverte=${reopened} over=${w.over} gameOver=${overs.length} état=${w.stage.state}`,
  );
}

// 3. Dernière vie perdue dans l'arène sous les coups du gardien (mort « naturelle »).
{
  const w = createWorld(6, { difficulty: 'veryHard' });
  const p = addPlayer(w, 'duel');
  enterArena(w, p);
  p.hp = 1;
  p.iframes = 0;
  const evs: GameEvent[] = [];
  for (let i = 0; i < 1500 && !w.over; i++) evs.push(...step(w, p, 1));
  const go = evs.find((e) => e.type === 'gameOver');
  check(
    'arène : tué par le gardien avec 1 vie → game over',
    w.over && count(evs, 'gameOver') === 1 && count(evs, 'playerDeath') === 1 && go?.type === 'gameOver' && go.deaths === 1 && p.lives === 0,
    `over=${w.over} morts=${count(evs, 'playerDeath')}`,
  );
}

// 4. Difficile (3 vies) : deux morts hors arène, la troisième dans l'arène.
{
  const w = createWorld(8, { difficulty: 'hard' });
  const p = addPlayer(w, 'trois');
  const evs: GameEvent[] = [];
  let early = false;
  for (let k = 0; k < 2; k++) {
    kill(w, p);
    evs.push(...waitRespawn(w, p));
    if (w.over || p.out || p.state === 'dead') early = true;
  }
  const livesBefore = p.lives;
  evs.push(...enterArena(w, p));
  const inArena = w.stage.state === 'arena';
  kill(w, p);
  evs.push(...step(w, p, PLAYER.GAME_OVER_DELAY + 10));
  const go = evs.find((e) => e.type === 'gameOver');
  check(
    'difficile : game over à la 3e mort survenue dans l’arène',
    !early && livesBefore === 1 && inArena && w.over && count(evs, 'gameOver') === 1 && count(evs, 'respawn') === 2 &&
      go?.type === 'gameOver' && go.deaths === 3 && w.stage.state === 'playing' && !barrierSolid(w),
    `vies avant arène=${livesBefore} arène=${inArena} over=${w.over} renaissances=${count(evs, 'respawn')}`,
  );
}

// 5. Avant la dernière vie, une mort dans l'arène n'arrête pas la partie (et le joueur renaît).
{
  const w = createWorld(8, { difficulty: 'easy' });
  const p = addPlayer(w, 'persévérant');
  enterArena(w, p);
  kill(w, p);
  const evs = step(w, p, PLAYER.GAME_OVER_DELAY + PLAYER.RESPAWN_TICKS + 10);
  check('arène : mort non finale → renaissance, pas de game over', !w.over && !p.out && p.state !== 'dead' && p.lives === 7 && count(evs, 'respawn') === 1 && count(evs, 'gameOver') === 0, `vies=${p.lives}`);
}

// 6. Bilan et changement de boucle : vies, score et kills conservés ; multiplicateurs exacts.
{
  const d: DifficultyId = 'hard';
  const w = createWorld(5, { difficulty: d });
  const p = addPlayer(w, 'pèlerin');
  kill(w, p);
  waitRespawn(w, p);
  // Un kill en boucle 0
  const e0 = w.enemies.find((e) => e.type === 'ashigaru');
  let s = p.score;
  if (e0) killEnemy(w, e0, p, 0, false);
  const ev0 = w.events.filter((e) => e.type === 'kill').pop();
  w.events.length = 0;
  const kill0Ok = !!ev0 && ev0.type === 'kill' && p.score - s === expectedScore(d, 0, ev0.honor);
  s = p.score;
  const kills0 = p.runKills;
  const clearEvs = clearCurrentStage(w, p);
  const cleared = w.stage.state === 'cleared' && count(clearEvs, 'stageClear') === 1;
  // Le gardien rapporte son kill, puis le bilan ajoute st.bonus × multiplicateurs.
  const bossKill = clearEvs.find((e) => e.type === 'kill');
  const bonus = w.stage.bonus;
  const expectedAfterClear = s + expectedScore(d, 0, bossKill?.type === 'kill' ? bossKill.honor : 0) + expectedScore(d, 0, bonus);
  const scoreAtClear = p.score;
  const livesAtClear = p.lives;
  const runKillsAtClear = p.runKills;
  const prEvs = proceed(w, p);
  const looped = w.stage.loop === 1 && w.stage.state === 'playing' && count(prEvs, 'stageStart') === 1;
  check('boucle : étape franchie (bilan puis boucle 1)', cleared && looped, `état=${w.stage.state} boucle=${w.stage.loop}`);
  check('score boucle 0 : kill = honneur × 1,5', kill0Ok, `honneur=${ev0?.type === 'kill' ? ev0.honor : '?'}`);
  check('score : bilan = kill du gardien + bonus × 1,5', scoreAtClear === expectedAfterClear, `obtenu=${scoreAtClear} attendu=${expectedAfterClear} bonus=${bonus}`);
  check(
    'nextStage : vies, score et kills de partie conservés',
    p.lives === livesAtClear && p.lives === 2 && p.score === scoreAtClear && p.runKills === runKillsAtClear && runKillsAtClear === kills0 + 1 && !p.out,
    `vies=${p.lives} score=${p.score}/${scoreAtClear} kills=${p.runKills}`,
  );
  // Un kill en boucle 1 : × 1,5 × 1,25
  const e1 = w.enemies.find((e) => e.type === 'ashigaru');
  s = p.score;
  if (e1) killEnemy(w, e1, p, 0, false);
  const ev1 = w.events.filter((e) => e.type === 'kill').pop();
  w.events.length = 0;
  check('score boucle 1 : kill = honneur × 1,5 × 1,25', !!ev1 && ev1.type === 'kill' && p.score - s === expectedScore(d, 1, ev1.honor), `delta=${p.score - s}`);
  // Les deux vies restantes s'épuisent en boucle 1.
  const evs: GameEvent[] = [];
  kill(w, p);
  evs.push(...waitRespawn(w, p));
  const aliveAfter2 = !p.out && p.state !== 'dead' && !w.over;
  kill(w, p);
  evs.push(...step(w, p, PLAYER.GAME_OVER_DELAY + 10));
  const go = evs.find((e) => e.type === 'gameOver');
  check(
    'boucle 1 : game over à la 3e mort de la partie (pas de la boucle)',
    aliveAfter2 && w.over && count(evs, 'gameOver') === 1 && go?.type === 'gameOver' && go.deaths === 3 && go.loop === 1 && go.score === p.score && go.kills === p.runKills,
    `gameOver=${JSON.stringify(go)}`,
  );
}

// 7. Multiplicateurs de score exacts : kill, fin de Marée, bilan ; chaque difficulté, boucles 0 et 2.
for (const d of DIFFICULTY_ORDER) {
  for (const loop of [0, 2]) {
    // Kill
    const w = createWorld(1, { difficulty: d });
    const p = addPlayer(w, 's');
    w.stage.loop = loop;
    p.combo = 7; // bonus de combo compris
    const e = w.enemies[0];
    killEnemy(w, e, p, 0, false);
    const ev = w.events.find((x) => x.type === 'kill');
    const killOk = !!ev && ev.type === 'kill' && p.score === expectedScore(d, loop, ev.honor) && Number.isInteger(p.score);
    // Fin de Marée n°3 : 75 de base
    const w2 = createWorld(1, { difficulty: d });
    const p2 = addPlayer(w2, 't');
    w2.stage.loop = loop;
    w2.enemies = [];
    w2.spawnTimer = 1e9;
    w2.wave = { n: 3, phase: 'tide', t: 0, kills: 99, quota: 1 };
    const evs = step(w2, p2, 1);
    const tideEnd = evs.find((x) => x.type === 'tideEnd');
    const tideOk = tideEnd?.type === 'tideEnd' && tideEnd.bonus === 75 && p2.score === expectedScore(d, loop, 75);
    check(`score ${d} boucle ${loop} : kill et fin de Marée pondérés`, killOk && tideOk, `kill=${p.score} marée=${p2.score} attendu=${expectedScore(d, loop, 75)}`);
  }
}

// 8. L'Honneur perdu ramassé et la mort ne modifient jamais le score.
{
  const w = createWorld(2, { difficulty: 'easy' });
  const p = addPlayer(w, 'm');
  for (let i = 0; i < 3; i++) {
    const e = w.enemies.find((x) => x.state !== 'dead');
    if (e) killEnemy(w, e, p, 0, false);
  }
  w.events.length = 0;
  const s = p.score;
  kill(w, p);
  const sDead = p.score;
  waitRespawn(w, p);
  check('mort : le score ne baisse pas', s > 0 && sDead === s && p.score >= s, `${s} → ${sDead} → ${p.score}`);
  // Deux coups fatals consécutifs : une seule vie perdue.
  const lives = p.lives;
  kill(w, p);
  damagePlayer(w, p, 1e6, p.x + 1);
  check('deux coups fatals le même tick : une seule vie perdue', p.lives === lives - 1, `${lives} → ${p.lives}`);
}

// 9. Après le game over : stepWorld continue d'être appelé, rien ne bouge, aucun événement.
{
  const w = createWorld(3, { difficulty: 'veryHard' });
  const p = addPlayer(w, 'figé');
  kill(w, p);
  const evs = step(w, p, PLAYER.GAME_OVER_DELAY + 2);
  const snap = JSON.stringify({ players: w.players, enemies: w.enemies, orbs: w.orbs, projectiles: w.projectiles, wave: w.wave, stage: w.stage });
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const after = step(w, p, 3000, () => Math.floor(rnd() * 512));
  const snap2 = JSON.stringify({ players: w.players, enemies: w.enemies, orbs: w.orbs, projectiles: w.projectiles, wave: w.wave, stage: w.stage });
  check('après game over : un seul gameOver, aucun événement ensuite, état figé', count(evs, 'gameOver') === 1 && after.length === 0 && snap === snap2 && w.over, `événements après=${after.length}`);
}

// 10. Game over pendant la porte ouverte (gardien vaincu, porte non franchie).
{
  const w = createWorld(5, { difficulty: 'veryHard' });
  const p = addPlayer(w, 'porte');
  enterArena(w, p);
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (g) killEnemy(w, g, p, 0, false);
  step(w, p, 2);
  const open = w.stage.state === 'gateOpen';
  kill(w, p);
  const evs = step(w, p, PLAYER.GAME_OVER_DELAY + 5);
  check('porte ouverte : dernière mort → game over', open && w.over && count(evs, 'gameOver') === 1 && count(evs, 'stageClear') === 0, `porte=${open} over=${w.over}`);
}

// 11. resetWorld puis nouvelle partie complète jusqu'au game over.
{
  const w = createWorld(4, { difficulty: 'veryHard' });
  const level = w.level;
  const p1 = addPlayer(w, 'un');
  const e = w.enemies[0];
  killEnemy(w, e, p1, 0, false);
  enterArena(w, p1);
  kill(w, p1);
  step(w, p1, PLAYER.GAME_OVER_DELAY + 5);
  const firstOver = w.over;
  // Remettre le kekkai fermé pour vérifier que resetWorld reconstruit le niveau.
  w.level.tiles[10 * w.level.w + w.level.arena.col] = T_SOLID;
  resetWorld(w, 9, { difficulty: 'normal' });
  const clean = !w.over && w.overT === 0 && w.events.length === 0 && w.players.length === 0 && w.level === level &&
    !barrierSolid(w) && w.stage.state === 'playing' && w.stage.loop === 0 && w.difficulty === 'normal' && w.totalKills === 0;
  const p = addPlayer(w, 'deux');
  const evs: GameEvent[] = [];
  let early = false;
  for (let k = 1; k <= 5; k++) {
    kill(w, p);
    evs.push(...waitRespawn(w, p));
    if (k < 5 && (w.over || p.out)) early = true;
  }
  evs.push(...step(w, p, PLAYER.GAME_OVER_DELAY));
  const go = evs.find((x) => x.type === 'gameOver');
  check('resetWorld : monde propre (niveau reconstruit, mêmes références)', firstOver && clean, `over1=${firstOver} propre=${clean}`);
  check(
    'resetWorld : 2e partie complète, game over à la 5e mort, score de la 2e partie seulement',
    !early && w.over && count(evs, 'gameOver') === 1 && go?.type === 'gameOver' && go.deaths === 5 && go.score === 0 && go.kills === 0 && p.lives === 0,
    `gameOver=${JSON.stringify(go)}`,
  );
}

// 12. resetWorld est équivalent à createWorld : même seed, mêmes entrées → même partie.
{
  const play = (w: World) => {
    const p = addPlayer(w, 'jumeau');
    let seed = 21;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let b = 0;
    step(w, p, 4000, (t) => {
      if (t % 12 === 0) b = Math.floor(rnd() * 512) & ~BTN.LEFT;
      return b | (t % 9 === 0 ? BTN.ATTACK : 0);
    });
    return JSON.stringify(w);
  };
  const a = play(createWorld(77, { difficulty: 'hard' }));
  const used = createWorld(3, { difficulty: 'veryEasy' });
  const u = addPlayer(used, 'vieux');
  step(used, u, 2000, (t) => (t % 7 === 0 ? BTN.ATTACK : BTN.RIGHT));
  resetWorld(used, 77, { difficulty: 'hard' });
  const b = play(used);
  check('resetWorld ≡ createWorld (état identique après 4000 ticks)', a === b, a === b ? '' : `longueurs ${a.length}/${b.length}`);
}

// 13. Taille de la horde par difficulté (hors Marée) : BASE + extraEnemies.
{
  const sizes: string[] = [];
  let ok = true;
  const hordeMax = (d: DifficultyId) => {
    const w = createWorld(12, { difficulty: d });
    const p = addPlayer(w, 'appât');
    w.enemies = [];
    w.spawnTimer = 0;
    let max = 0;
    step(w, p, 4000, 0, () => {
      p.iframes = 999;
      p.hp = p.maxHp;
      w.wave.t = 0; // reste en accalmie
      max = Math.max(max, w.enemies.length);
    });
    return Math.max(max, w.enemies.length);
  };
  for (const d of DIFFICULTY_ORDER) {
    const n = hordeMax(d);
    sizes.push(`${d}=${n}`);
    if (n !== SPAWN.BASE + DIFFICULTIES[d].extraEnemies) ok = false;
  }
  check('horde : BASE + extraEnemies par difficulté (4/5/6/7/8)', ok, sizes.join(' '));
  // Plancher : même avec un extraEnemies très négatif, la horde garde 2 ennemis.
  const saved = DIFFICULTIES.veryEasy.extraEnemies;
  DIFFICULTIES.veryEasy.extraEnemies = -20;
  const floor = hordeMax('veryEasy');
  DIFFICULTIES.veryEasy.extraEnemies = saved;
  check('horde : plancher de 2 ennemis si extraEnemies très négatif', floor === 2, `ennemis=${floor}`);
}

// 14. Normal identique à une partie sans option (comportement historique).
{
  const a = createWorld(31);
  const b = createWorld(31, { difficulty: 'normal' });
  const pa = addPlayer(a, 'x');
  const pb = addPlayer(b, 'x');
  step(a, pa, 3000, (t) => (t % 10 === 0 ? BTN.ATTACK : BTN.RIGHT));
  step(b, pb, 3000, (t) => (t % 10 === 0 ? BTN.ATTACK : BTN.RIGHT));
  check('normal ≡ défaut (même partie)', JSON.stringify(a) === JSON.stringify(b));
}

// 15. Gardien : PV pondérés par la difficulté (et 1 en normal).
{
  const hp = (d: DifficultyId) => {
    const w = createWorld(6, { difficulty: d });
    const p = addPlayer(w, 'g');
    enterArena(w, p);
    return w.enemies.find((e) => e.id === w.stage.guardianId)?.maxHp ?? 0;
  };
  const n = hp('normal');
  const vh = hp('veryHard');
  const ve = hp('veryEasy');
  check('gardien : PV veryEasy < normal < veryHard', ve > 0 && ve < n && n < vh, `${ve}/${n}/${vh}`);
}


// 11. Après la dernière mort, un ennemi qui meurt encore (iai condamné, vague de vent)
//     ne rapporte plus rien : le score et les kills sont figés dès la sortie.
{
  const w = createWorld(21, { difficulty: 'veryHard' });
  w.spawnTimer = 1e9;
  const p = addPlayer(w, 'last-stand');
  step(w, p, 2);
  const e = w.enemies[0];
  kill(w, p);
  const score = p.score;
  const kills = p.runKills;
  killEnemy(w, e, p, 0, true);
  const evs = step(w, p, PLAYER.GAME_OVER_DELAY + 5);
  const go = evs.find((ev) => ev.type === 'gameOver');
  check(
    'pas de score ni de kill après la sortie',
    p.out && p.score === score && p.runKills === kills && !!go && go.type === 'gameOver' && go.score === score,
    `score=${p.score} (avant ${score}) kills=${p.runKills}`,
  );
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de fin de partie passent.');
