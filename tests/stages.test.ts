// Tests d'enchaînement des étapes générées sur une même partie (nextStage, mort,
// arène, horde, resetWorld, graines extrêmes).
// Lancer : npm run test:stages
import { biomeForStage } from '../shared/biomes';
import { SPAWN, TILE } from '../shared/constants';
import { BTN } from '../shared/input';
import { buildLevel, type Level, T_SOLID } from '../shared/level';
import { reachable, validateLevel } from '../shared/levelcheck';
import { damagePlayer, killEnemy } from '../shared/interactions';
import { stageSeed } from '../shared/math';
import { buildStage } from '../shared/stagebuild';
import type { Player, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, resetWorld, stepWorld, warpToArena } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}
const t0 = Date.now();

/** Empreinte d'un niveau (tuiles, décors, ennemis, sanctuaires, arène, porte, départ, biome). */
function fingerprint(l: Level): string {
  return JSON.stringify({ w: l.w, h: l.h, t: Array.from(l.tiles), d: l.decos, e: l.enemySpawns, c: l.checkpoints, a: l.arena, g: l.gate, s: l.spawn, b: l.biome, st: l.stage });
}

/** État courant, sans le rétrécissement de type de TypeScript (il change pendant stepWorld). */
const stateOf = (w: World): string => w.stage.state;
const phaseOf = (w: World): string => w.wave.phase;
const pState = (p: Player): string => p.state;

function stepN(w: World, p: Player, b: number, n: number, evs?: string[]): void {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    m.set(p.id, b);
    stepWorld(w, m);
    if (evs) for (const ev of w.events) evs.push(ev.type);
    w.events.length = 0;
  }
}

/** Colonne de la barrière identique à sa sauvegarde (kekkai ouvert). */
function barrierOpen(l: Level): boolean {
  for (let r = 0; r < l.arena.rows; r++) if (l.tiles[r * l.w + l.arena.col] !== l.arena.backup[r]) return false;
  return true;
}
function barrierClosed(l: Level): boolean {
  for (let r = 0; r < l.arena.rows; r++) if (l.tiles[r * l.w + l.arena.col] !== T_SOLID) return false;
  return true;
}

/** Cohérence interne d'un niveau chargé (dimensions, arène, porte, départ). */
function levelIssues(l: Level): string[] {
  const out: string[] = [];
  if (l.tiles.length !== l.w * l.h) out.push(`tiles=${l.tiles.length} ≠ ${l.w}×${l.h}`);
  if (l.pxW !== l.w * TILE || l.pxH !== l.h * TILE) out.push('pxW/pxH incohérents');
  const a = l.arena;
  if (a.col <= 0 || a.col >= l.w - 1) out.push(`arena.col=${a.col} hors niveau`);
  if (a.backup.length !== a.rows) out.push(`backup=${a.backup.length} ≠ rows=${a.rows}`);
  if (a.rows > l.h) out.push('rows > h');
  if (!(a.trigger > (a.col + 1) * TILE && a.trigger < l.pxW)) out.push(`trigger=${a.trigger} hors arène`);
  if (!(a.guardianX > (a.col + 1) * TILE && a.guardianX < l.pxW)) out.push(`guardianX=${a.guardianX} hors arène`);
  if (!(l.gate.x > a.guardianX && l.gate.x < l.pxW)) out.push(`gate.x=${l.gate.x} incohérent`);
  if (!(l.spawn.x > 0 && l.spawn.x < a.col * TILE)) out.push(`spawn.x=${l.spawn.x} hors zone de jeu`);
  if (!barrierOpen(l)) out.push('barrière non conforme à sa sauvegarde au chargement');
  return out;
}

/** Ennemis non-gardiens au-delà de la zone autorisée ou hors du niveau. */
function enemiesOut(w: World): string[] {
  const l = w.level;
  return w.enemies
    .filter((e) => e.type !== 'boss' && (!(e.x >= 0 && e.x <= l.pxW) || !(e.y >= 0 && e.y <= l.pxH) || e.x > (l.arena.col + 1) * TILE))
    .map((e) => `${e.type}#${e.id} (${(e.x / TILE).toFixed(1)}, ${(e.y / TILE).toFixed(1)})`);
}

/** Termine l'étape en cours par le vrai déroulé : arène, gardien vaincu, porte, bilan, reprise. */
function clearAndContinue(w: World, p: Player): { ok: boolean; info: string; evs: string[] } {
  const evs: string[] = [];
  p.iframes = 1e6; // ennemis inoffensifs pendant la séquence
  warpToArena(w);
  stepN(w, p, BTN.RIGHT, 30, evs);
  if (stateOf(w) !== 'arena') return { ok: false, info: `pas d'arène (état=${w.stage.state}, x=${(p.x / TILE).toFixed(1)})`, evs };
  if (!barrierClosed(w.level)) return { ok: false, info: 'barrière non fermée', evs };
  const g = w.enemies.find((e) => e.id === w.stage.guardianId);
  if (!g) return { ok: false, info: 'gardien absent', evs };
  if (!(g.x > (w.level.arena.col + 1) * TILE && g.x < w.level.pxW)) return { ok: false, info: `gardien hors arène x=${g.x}`, evs };
  killEnemy(w, g, p, 0, false);
  stepN(w, p, 0, 2, evs);
  if (stateOf(w) !== 'gateOpen' || !barrierOpen(w.level)) return { ok: false, info: `porte non ouverte (état=${w.stage.state})`, evs };
  p.x = w.level.gate.x - 60;
  p.y = w.level.gate.y;
  p.vx = 0;
  p.vy = 0;
  for (let i = 0; i < 200 && stateOf(w) !== 'cleared'; i++) stepN(w, p, BTN.RIGHT, 1, evs);
  if (stateOf(w) !== 'cleared') return { ok: false, info: `porte non franchie (x=${(p.x / TILE).toFixed(1)} gate=${(w.level.gate.x / TILE).toFixed(1)})`, evs };
  p.iframes = 0;
  stepN(w, p, 0, 95, evs);
  stepN(w, p, BTN.JUMP, 1, evs);
  stepN(w, p, 0, 1, evs);
  return { ok: stateOf(w) === 'playing', info: `état=${w.stage.state}`, evs };
}

// ─── 1. Enchaînement réel de 10 étapes (2,5 cycles de biomes) ───────────────
{
  const seed = 1234;
  const w = createWorld(seed);
  const p = addPlayer(w, 'pilgrim');
  p.up.edge = 2;
  p.up.parry = 1;
  const level = w.level;
  const seen = new Set<string>([fingerprint(w.level)]);
  const problems: string[] = [];
  for (let k = 1; k <= 10; k++) {
    const lives = p.lives;
    const up = JSON.stringify(p.up);
    const scoreBefore = p.score;
    const r = clearAndContinue(w, p);
    if (!r.ok) {
      problems.push(`étape ${k - 1} → ${k} : ${r.info}`);
      break;
    }
    const L = w.level;
    const fp = fingerprint(L);
    if (L !== level) problems.push(`étape ${k} : référence w.level changée`);
    if (w.stage.loop !== k || L.stage !== k) problems.push(`étape ${k} : loop=${w.stage.loop} level.stage=${L.stage}`);
    if (L.biome !== biomeForStage(k)) problems.push(`étape ${k} : biome=${L.biome}`);
    if (fp !== fingerprint(buildStage(k, seed))) problems.push(`étape ${k} : niveau ≠ buildStage(${k}, seed)`);
    if (seen.has(fp)) problems.push(`étape ${k} : niveau déjà vu`);
    seen.add(fp);
    if (p.lives !== lives) problems.push(`étape ${k} : vies ${lives} → ${p.lives}`);
    if (JSON.stringify(p.up) !== up) problems.push(`étape ${k} : améliorations perdues`);
    if (!(p.score > scoreBefore)) problems.push(`étape ${k} : score ${scoreBefore} → ${p.score} (bonus de bilan absent)`);
    if (Math.abs(p.x - L.spawn.x) > 1 || Math.abs(p.y - L.spawn.y) > 1 || p.spawnX !== L.spawn.x || p.checkpoint !== 0) problems.push(`étape ${k} : joueur pas au départ`);
    if (stateOf(w) !== 'playing' || w.stage.guardianId !== 0) problems.push(`étape ${k} : état ${w.stage.state}`);
    const iss = levelIssues(L);
    if (iss.length) problems.push(`étape ${k} : ${iss.join(', ')}`);
    const out = enemiesOut(w);
    if (out.length) problems.push(`étape ${k} : ennemis hors zone ${out.slice(0, 3).join(' ')}`);
    if (w.enemies.length < L.enemySpawns.length - 1) problems.push(`étape ${k} : ${w.enemies.length} ennemis pour ${L.enemySpawns.length} placés`);
    if (!r.evs.includes('stageStart')) problems.push(`étape ${k} : pas d'événement stageStart`);
  }
  check('10 étapes enchaînées (arène → porte → bilan → nextStage) : progression conservée, niveaux distincts', problems.length === 0, problems.slice(0, 4).join(' ; ') || `${seen.size} niveaux`);
  // La partie continue normalement sur la dernière étape : quelques secondes de jeu sans valeur folle.
  stepN(w, p, BTN.RIGHT, 600);
  check('étape 10 : la simulation tourne (joueur fini, dans le niveau)', Number.isFinite(p.x) && p.x >= 0 && p.x <= w.level.pxW && Number.isFinite(p.y), `x=${(p.x / TILE).toFixed(1)}`);
}

// ─── 2. Horde : jamais au-delà de arena.col - 3 ni hors du niveau ───────────
{
  const problems: string[] = [];
  let spawned = 0;
  for (const seed of [3, 77, 4242]) {
    const w = createWorld(seed);
    const p = addPlayer(w, 'h');
    for (let k = 1; k <= 8; k++) {
      nextStage(w);
      const L = w.level;
      const maxX = (L.arena.col - 3) * TILE;
      // Le joueur se tient à divers endroits (début, milieu, juste avant l'arène, dans la zone
      // qui dépassait l'ancienne largeur) ; Marée forcée pour multiplier les renforts.
      for (const fx of [0.05, 0.5, 0.9, 0.99]) {
        const known = new Set(w.enemies.map((e) => e.id));
        for (let t = 0; t < 400; t++) {
          p.x = Math.min(fx * L.pxW, (L.arena.col - 1) * TILE);
          p.vx = 0;
          p.iframes = 1e6;
          p.hp = p.maxHp;
          if (phaseOf(w) !== 'tide') {
            w.wave.phase = 'tide';
            w.wave.t = 0;
            w.wave.n = 3;
            w.wave.quota = 1e6;
          }
          stepN(w, p, 0, 1);
          for (const e of w.enemies) {
            if (known.has(e.id)) continue;
            known.add(e.id);
            if (!e.horde) continue;
            spawned++;
            if (!(e.x >= 3 * TILE && e.x <= maxX && e.x < L.pxW && e.y <= L.pxH)) problems.push(`graine ${seed} étape ${k} : renfort en (${(e.x / TILE).toFixed(1)}, ${(e.y / TILE).toFixed(1)}) arène=${L.arena.col} w=${L.w}`);
          }
        }
      }
      if (stateOf(w) !== 'playing') problems.push(`graine ${seed} étape ${k} : état ${w.stage.state}`);
    }
  }
  check('horde : renforts dans [3, arena.col − 3] sur 24 niveaux de largeurs variées', problems.length === 0 && spawned > 100, problems.slice(0, 3).join(' ; ') || `${spawned} renforts`);
}

// ─── 3. Mort dans un niveau généré : renaissance au bon sanctuaire ──────────
{
  const problems: string[] = [];
  for (const seed of [11, 99, 2024]) {
    for (const k of [1, 2, 3, 4, 6]) {
      const w = createWorld(seed);
      const p = addPlayer(w, 'm');
      for (let i = 0; i < k; i++) nextStage(w);
      const L = w.level;
      const cps = L.checkpoints;
      if (cps.length < 2) {
        problems.push(`${seed}/${k} : ${cps.length} sanctuaires`);
        continue;
      }
      // Le premier sanctuaire est le départ.
      if (Math.abs(cps[0].x - L.spawn.x) > 40) problems.push(`${seed}/${k} : sanctuaire 0 (${cps[0].x}) ≠ départ (${L.spawn.x})`);
      const idx = Math.min(2, cps.length - 1);
      const c = cps[idx];
      p.x = c.x;
      p.y = c.y;
      p.vx = 0;
      p.vy = 0;
      const evs: string[] = [];
      stepN(w, p, 0, 2, evs);
      if (p.checkpoint !== idx || p.spawnX !== c.x || p.spawnY !== c.y) {
        problems.push(`${seed}/${k} : sanctuaire ${idx} non activé (checkpoint=${p.checkpoint})`);
        continue;
      }
      // On s'éloigne, on se fait encercler, puis on meurt.
      p.x = Math.min(c.x + 600, (L.arena.col - 4) * TILE);
      const lives = p.lives;
      const deathX = p.x;
      const near = w.enemies.find((e) => e.type !== 'boss');
      if (near) {
        near.x = deathX + 50;
        near.state = 'chase';
      }
      w.wave.phase = 'tide';
      w.wave.t = 0;
      w.wave.n = 1;
      w.wave.quota = 1e6;
      p.iframes = 0;
      p.state = 'normal';
      damagePlayer(w, p, 1e6, p.x + 10);
      if (pState(p) !== 'dead') {
        problems.push(`${seed}/${k} : pas mort`);
        continue;
      }
      let respawned = false;
      for (let t = 0; t < 400 && !respawned; t++) {
        stepN(w, p, 0, 1, evs);
        respawned = pState(p) !== 'dead';
      }
      const left = w.enemies.filter((e) => e.type !== 'boss' && e.state !== 'doomed' && (Math.abs(e.x - c.x) < SPAWN.CLEAR_AROUND_SPAWN - 200 || Math.abs(e.x - deathX) < SPAWN.CLEAR_AROUND_DEATH - 200));
      if (!respawned) problems.push(`${seed}/${k} : pas de renaissance`);
      else if (Math.abs(p.x - c.x) > 2 || Math.abs(p.y - c.y) > 2) problems.push(`${seed}/${k} : renaît en (${(p.x / TILE).toFixed(1)}, ${(p.y / TILE).toFixed(1)}) au lieu du sanctuaire ${idx} (${(c.x / TILE).toFixed(1)}, ${(c.y / TILE).toFixed(1)})`);
      if (p.lives !== lives - 1) problems.push(`${seed}/${k} : vies ${lives} → ${p.lives}`);
      if (phaseOf(w) !== 'calm') problems.push(`${seed}/${k} : Marée non retirée`);
      if (left.length) problems.push(`${seed}/${k} : ${left.length} ennemis restent près du sanctuaire / de la mort`);
      if (!p.onGround) {
        stepN(w, p, 0, 30);
        if (!p.onGround || p.y > L.pxH) problems.push(`${seed}/${k} : renaissance sans sol (y=${(p.y / TILE).toFixed(1)})`);
      }
    }
  }
  check('mort en niveau généré : renaissance au sanctuaire activé, horde dissipée, Marée retirée', problems.length === 0, problems.slice(0, 4).join(' ; '));
}

// Après nextStage, mourir avant tout sanctuaire ramène au départ du NOUVEAU niveau.
{
  const w = createWorld(8);
  const p = addPlayer(w, 'n');
  const cps0 = w.level.checkpoints;
  const c = cps0[cps0.length - 1];
  p.x = c.x;
  p.y = c.y;
  stepN(w, p, 0, 2);
  const oldSpawn = { x: p.spawnX, y: p.spawnY };
  nextStage(w);
  const L = w.level;
  p.iframes = 0;
  damagePlayer(w, p, 1e6, p.x + 10);
  for (let t = 0; t < 400 && pState(p) === 'dead'; t++) stepN(w, p, 0, 1);
  check('mort juste après nextStage : renaissance au départ du nouveau niveau', Math.abs(p.x - L.spawn.x) < 2 && Math.abs(p.y - L.spawn.y) < 2, `x=${(p.x / TILE).toFixed(1)} départ=${(L.spawn.x / TILE).toFixed(1)} ancien sanctuaire=${(oldSpawn.x / TILE).toFixed(1)}`);
}

// ─── 4. Arène d'un niveau généré : mort, réouverture, nouvelle tentative ────
{
  const problems: string[] = [];
  for (const seed of [5, 61]) {
    for (const k of [1, 2, 3, 4, 5]) {
      const w = createWorld(seed);
      const p = addPlayer(w, 'a');
      for (let i = 0; i < k; i++) nextStage(w);
      const L = w.level;
      const tag = `${seed}/${k}`;
      const tilesBefore = Array.from(L.tiles);
      warpToArena(w);
      p.iframes = 0;
      const evs: string[] = [];
      stepN(w, p, BTN.RIGHT, 30, evs);
      if (stateOf(w) !== 'arena' || !barrierClosed(L)) {
        problems.push(`${tag} : arène non verrouillée (état=${w.stage.state})`);
        continue;
      }
      if (w.enemies.some((e) => e.type !== 'boss' && e.x > (L.arena.col + 1) * TILE)) problems.push(`${tag} : ennemi ordinaire dans l'arène`);
      // Mort dans l'arène.
      damagePlayer(w, p, 1e6, p.x + 10);
      for (let t = 0; t < 50 && stateOf(w) === 'arena'; t++) stepN(w, p, 0, 1, evs);
      if (stateOf(w) !== 'playing' || !evs.includes('arenaReset')) problems.push(`${tag} : arène non réinitialisée (état=${w.stage.state})`);
      if (w.enemies.some((e) => e.type === 'boss')) problems.push(`${tag} : gardien resté`);
      if (Array.from(L.tiles).join() !== tilesBefore.join()) problems.push(`${tag} : tuiles modifiées après réouverture`);
      for (let t = 0; t < 400 && pState(p) === 'dead'; t++) stepN(w, p, 0, 1);
      if (p.x > L.arena.col * TILE) problems.push(`${tag} : renaissance dans l'arène`);
      // Seconde tentative : verrouillage, victoire, porte, bilan.
      const r = clearAndContinue(w, p);
      if (!r.ok) problems.push(`${tag} : seconde tentative ${r.info}`);
      else if (w.stage.loop !== k + 1) problems.push(`${tag} : loop=${w.stage.loop}`);
    }
  }
  check('arène générée : verrouillage, mort → réouverture intacte, puis victoire et étape suivante', problems.length === 0, problems.slice(0, 4).join(' ; '));
}

// nextStage pendant une arène verrouillée (F7 debug) : le nouveau niveau n'hérite pas de la barrière.
{
  const w = createWorld(9);
  const p = addPlayer(w, 'f7');
  nextStage(w);
  warpToArena(w);
  p.iframes = 1e6;
  stepN(w, p, BTN.RIGHT, 30);
  const wasArena = stateOf(w) === 'arena';
  nextStage(w);
  check('nextStage depuis une arène verrouillée : niveau suivant propre', wasArena && stateOf(w) === 'playing' && levelIssues(w.level).length === 0 && fingerprint(w.level) === fingerprint(buildStage(2, 9)) && !w.enemies.some((e) => e.type === 'boss'), levelIssues(w.level).join(', '));
}

// ─── 5. resetWorld après une étape générée ──────────────────────────────────
{
  const w = createWorld(21);
  const p = addPlayer(w, 'r');
  const ref = w.level;
  for (let i = 0; i < 3; i++) nextStage(w);
  // Niveau étape 3 éventuellement verrouillé (barrière posée).
  warpToArena(w);
  p.iframes = 1e6;
  stepN(w, p, BTN.RIGHT, 30);
  const w3 = w.level.w;
  resetWorld(w, 500);
  const q = addPlayer(w, 'r2');
  const hist = buildLevel();
  const keysOk = Object.keys(w.level).sort().join() === Object.keys(hist).sort().join();
  check(
    'resetWorld après étape générée : étape 0 historique (224, bamboo), même référence',
    w.level === ref && w.level.w === 224 && w.level.biome === 'bamboo' && w.level.stage === 0 && w.stage.loop === 0 &&
      fingerprint(w.level) === fingerprint(hist) && keysOk && levelIssues(w.level).length === 0 && w.seed === 500,
    `largeur avant=${w3} après=${w.level.w} biome=${w.level.biome}`,
  );
  check('resetWorld : joueur au départ historique, ennemis dans le niveau', q.x === hist.spawn.x && enemiesOut(w).length === 0 && w.enemies.length === hist.enemySpawns.length);
  // La nouvelle graine pilote les étapes suivantes.
  nextStage(w);
  check('après resetWorld, nextStage suit la nouvelle graine', fingerprint(w.level) === fingerprint(buildStage(1, 500)) && fingerprint(w.level) !== fingerprint(buildStage(1, 21)));
}

// ─── 6. Déterminisme ────────────────────────────────────────────────────────
{
  const run = (seed: number, script: number) => {
    const w = createWorld(seed);
    const p = addPlayer(w, 'd');
    const fps: string[] = [];
    for (let k = 1; k <= 5; k++) {
      // Entrées différentes selon `script` : le niveau ne doit dépendre que de la graine et de l'étape.
      stepN(w, p, script === 0 ? BTN.RIGHT : BTN.LEFT | BTN.JUMP, 120 + 37 * script);
      clearAndContinue(w, p);
      fps.push(fingerprint(w.level) + JSON.stringify(w.enemies.map((e) => [e.type, e.x, e.y, e.maxHp])));
    }
    return fps;
  };
  const a = run(77, 0);
  const b = run(77, 0);
  const c = run(77, 1);
  check('createWorld(seed) + mêmes entrées → mêmes niveaux et ennemis à chaque étape', a.join('|') === b.join('|'));
  const levelsOnly = (f: string[]) => f.map((s) => s.slice(0, s.lastIndexOf('[[')));
  check('niveaux d’étape indépendants des entrées (graine + étape seulement)', levelsOnly(a).join('|') === levelsOnly(c).join('|'));
}

// ─── 7. Bords : grandes étapes, graines extrêmes, stageSeed ─────────────────
{
  const seeds = [0, 1, -1, -2147483648, 2147483647, 4294967295, 4294967296, 65536, 1.5, Date.UTC(2026, 0, 1)];
  const problems: string[] = [];
  let n = 0;
  for (const s of seeds) {
    for (const k of [1, 2, 3, 4, 8, 13, 50, 99, 100, 101, 1000]) {
      let L: Level;
      try {
        L = buildStage(k, s);
      } catch (e) {
        problems.push(`graine ${s} étape ${k} : exception ${String(e)}`);
        continue;
      }
      n++;
      const errs = validateLevel(L);
      const r = reachable(L);
      const iss = levelIssues(L);
      if (errs.length || !r.ok || iss.length) problems.push(`graine ${s} étape ${k} : ${[...errs.slice(0, 2), r.reason ?? '', ...iss].filter(Boolean).join(', ')}`);
      if (L.stage !== k || L.biome !== biomeForStage(k)) problems.push(`graine ${s} étape ${k} : stage/biome`);
      if (L.w < 150 || L.w > 300) problems.push(`graine ${s} étape ${k} : largeur ${L.w}`);
      if (L.enemySpawns.length < 10 || L.enemySpawns.length > 30) problems.push(`graine ${s} étape ${k} : ${L.enemySpawns.length} ennemis`);
    }
  }
  check('étapes 1-1000 × graines extrêmes (0, négatives, 2^32−1, 2^32, non entière) : niveaux valides', problems.length === 0, problems.slice(0, 4).join(' ; ') || `${n} niveaux`);

  // Partie complète avec une graine extrême jusqu'à l'étape 100 via nextStage.
  for (const s of [0, 4294967295, -7]) {
    const w = createWorld(s);
    const p = addPlayer(w, 'x');
    let bad = '';
    for (let k = 1; k <= 100 && !bad; k++) {
      nextStage(w);
      if (w.level.stage !== k || levelIssues(w.level).length || enemiesOut(w).length) bad = `étape ${k} : ${levelIssues(w.level).join(', ')} ${enemiesOut(w).slice(0, 2).join(' ')}`;
      if (Math.abs(p.x - w.level.spawn.x) > 1) bad = `étape ${k} : joueur hors départ`;
      if (w.enemies.some((e) => !Number.isFinite(e.maxHp) || e.maxHp <= 0)) bad = `étape ${k} : PV ennemis non finis`;
    }
    stepN(w, p, BTN.RIGHT, 300);
    check(`graine ${s} : 100 nextStage successifs cohérents`, !bad && Number.isFinite(p.x), bad);
  }

  // stageSeed : jamais 0, entier 32 bits non signé, pas de collision entre étapes d'une graine.
  let zero = 0;
  let notU32 = 0;
  let collide = 0;
  for (const s of [...seeds, ...Array.from({ length: 500 }, (_, i) => i * 7919 - 1000)]) {
    const set = new Set<number>();
    for (let k = 0; k <= 120; k++) {
      const v = stageSeed(s, k);
      if (v === 0) zero++;
      if (!(Number.isInteger(v) && v > 0 && v <= 0xffffffff)) notU32++;
      if (set.has(v)) collide++;
      set.add(v);
    }
  }
  check('stageSeed : jamais 0, uint32, sans collision sur 121 étapes × 510 graines', zero === 0 && notU32 === 0 && collide === 0, `zéro=${zero} hors uint32=${notU32} collisions=${collide}`);
  // Graines client : (Date.now() & 0xffff) + 1 → 65536 valeurs ; deux graines voisines ≠ niveaux.
  check('graines voisines (client) → niveaux d’étape 1 différents', fingerprint(buildStage(1, 1000)) !== fingerprint(buildStage(1, 1001)) && fingerprint(buildStage(1, 65536)) !== fingerprint(buildStage(1, 1)));
}

console.log(`\n  durée : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failures) {
  console.log(`\n${failures} test(s) en échec.`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
}
console.log('\nTous les tests d’enchaînement d’étapes passent.');
