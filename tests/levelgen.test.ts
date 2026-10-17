// Tests des niveaux générés (étapes 1 et suivantes).
// Lancer : npm run test:levelgen
import { BIOME_ORDER, BIOMES, biomeForStage } from '../shared/biomes';
import { TILE } from '../shared/constants';
import { BTN } from '../shared/input';
import { buildLevel, type Level, T_EMPTY, T_SOLID, tileAt } from '../shared/level';
import { reachable, validateLevel } from '../shared/levelcheck';
import { assembleLevel, generateLevel, planSegments, targetWidth } from '../shared/levelgen';
import { Rng, stageSeed } from '../shared/math';
import { touchingWall } from '../shared/physics';
import { finalArenaPiece, flatPiece, G, SEGMENTS, type SegmentId, type SegmentPiece, startPiece } from '../shared/segments';
import { buildStage } from '../shared/stagebuild';
import type { Player, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, stepWorld } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}
const t0 = Date.now();

/** Empreinte d'un niveau : tuiles, décors, ennemis, sanctuaires, arène et porte. */
function fingerprint(l: ReturnType<typeof buildStage>): string {
  return JSON.stringify({ w: l.w, t: Array.from(l.tiles), d: l.decos, e: l.enemySpawns, c: l.checkpoints, a: l.arena, g: l.gate, s: l.spawn, b: l.biome });
}

// ─── Fondations ─────────────────────────────────────────────────────────────
check('étape 0 = forêt de bambous historique', buildStage(0, 123).biome === 'bamboo' && buildStage(0, 123).stage === 0 && buildStage(0, 1).w === 224);
check('biomes en cycle', [0, 1, 2, 3, 4, 5].map(biomeForStage).join(',') === 'bamboo,village,snow,castle,bamboo,village');
check('graine d’étape déterministe et variée', stageSeed(7, 3) === stageSeed(7, 3) && stageSeed(7, 3) !== stageSeed(7, 4) && stageSeed(7, 3) !== stageSeed(8, 3));
check('buildStage déterministe', fingerprint(buildStage(3, 42)) === fingerprint(buildStage(3, 42)));
{
  const w = createWorld(5);
  addPlayer(w, 'pilgrim');
  const level = w.level;
  nextStage(w);
  check('nextStage : étape 1 = village, même référence de niveau', w.level === level && w.level.stage === 1 && w.level.biome === 'village');
}
check('4 biomes définis', BIOME_ORDER.length === 4);

// ─── Vérificateur sur le niveau historique ──────────────────────────────────
{
  const l = buildLevel();
  const errs = validateLevel(l);
  check('validateLevel : niveau historique valide', errs.length === 0, errs.slice(0, 3).join(' ; '));
  const r = reachable(l);
  check('reachable : niveau historique franchissable sans impasse', r.ok, r.reason);
  // Un mur infranchissable au milieu est détecté.
  const wall = buildLevel();
  for (let y = 0; y < G; y++) wall.tiles[y * wall.w + 70] = T_SOLID;
  check('reachable : un mur de 18 tuiles bloque la porte', !reachable(wall).ok, reachable(wall).reason);
  // Une fosse profonde et étroite (5 tuiles) est une impasse.
  const pit = buildLevel();
  for (let y = G; y < G + 5; y++) for (let x = 70; x <= 71; x++) pit.tiles[y * pit.w + x] = T_EMPTY;
  const rp = reachable(pit);
  check('reachable : un puits de 5 tuiles sans issue est une impasse', !rp.ok && /impasse/.test(rp.reason ?? ''), rp.reason);
  // Un ennemi en l'air et un sanctuaire dans l'arène sont signalés.
  const bad = buildLevel();
  bad.enemySpawns.push({ x: 50 * TILE, y: 5 * TILE, type: 'archer' });
  bad.checkpoints.push({ x: 200 * TILE, y: G * TILE });
  const be = validateLevel(bad);
  check('validateLevel : ennemi en l’air et sanctuaire dans l’arène signalés', be.some((e) => /ennemi/.test(e)) && be.some((e) => /arène/.test(e)), be.join(' ; '));
}

// ─── Déterminisme et diversité ──────────────────────────────────────────────
{
  let same = true;
  for (const seed of [1, 99, 123456]) for (let s = 1; s <= 8; s++) {
    if (fingerprint(generateLevel(seed, s, biomeForStage(s))) !== fingerprint(generateLevel(seed, s, biomeForStage(s)))) same = false;
  }
  check('générateur déterministe (3 graines × 8 étapes)', same);
  const tilesOf = (l: Level) => `${l.w}:${Array.from(l.tiles).join('')}`;
  const stages = Array.from({ length: 8 }, (_, i) => tilesOf(buildStage(i + 1, 7)));
  check('étapes 1 à 8 d’une graine : géométries deux à deux différentes', new Set(stages).size === 8);
  let distinct = true;
  for (let s = 1; s <= 8; s++) if (tilesOf(buildStage(s, 7)) === tilesOf(buildStage(s, 8))) distinct = false;
  check('deux graines différentes → niveaux différents', distinct);
  const ws = new Set<number>();
  for (let seed = 1; seed <= 30; seed++) ws.add(buildStage(2, seed).w);
  check('largeurs variées', ws.size >= 8, [...ws].sort((a, b) => a - b).join(','));
}

// ─── Validité et franchissabilité de masse : 200 graines × étapes 1 à 8 ─────
{
  let bad = 0;
  let firstErr = '';
  let minW = 1e9;
  let maxW = 0;
  let minCp = 1e9;
  let minE = 1e9;
  let maxE = 0;
  let repeat = 0;
  let hardMax = 0;
  const uses: Partial<Record<string, number>> = {};
  for (let seed = 1; seed <= 200; seed++) {
    for (let s = 1; s <= 8; s++) {
      const ss = stageSeed(seed, s);
      const l = generateLevel(ss, s, biomeForStage(s));
      const errs = validateLevel(l);
      const r = reachable(l);
      if (errs.length || !r.ok || l.stage !== s || l.biome !== biomeForStage(s)) {
        if (!bad) firstErr = `graine ${seed} étape ${s} : ${errs[0] ?? r.reason}`;
        bad++;
      }
      minW = Math.min(minW, l.w);
      maxW = Math.max(maxW, l.w);
      minCp = Math.min(minCp, l.checkpoints.length);
      minE = Math.min(minE, l.enemySpawns.length);
      maxE = Math.max(maxE, l.enemySpawns.length);
      const plan = planSegments(new Rng(ss), s);
      let hard = 0;
      plan.forEach((p, i) => {
        uses[p.id] = (uses[p.id] ?? 0) + 1;
        if (i > 0 && plan[i - 1].id === p.id) repeat++;
        if (p.id === 'slideTunnel' || p.id === 'wallShaft') hard++;
      });
      hardMax = Math.max(hardMax, hard);
    }
  }
  check('200 graines × 8 étapes : validateLevel sans erreur et reachable OK', bad === 0, bad ? `${bad} échecs, ${firstErr}` : '1600 niveaux');
  check('largeur bornée (≈ 200-260)', minW >= 195 && maxW <= 265, `${minW}-${maxW}`);
  check('≥ 3 sanctuaires en plus du départ', minCp >= 4, `min ${minCp}`);
  check('densité d’ennemis comparable (14-20)', minE >= 14 && maxE <= 20, `${minE}-${maxE}`);
  check('jamais deux fois le même segment d’affilée', repeat === 0, `${repeat}`);
  check('au plus 3 tunnels / puits par niveau', hardMax <= 3, `max ${hardMax}`);
  const all = Object.keys(SEGMENTS).every((k) => (uses[k] ?? 0) > 0);
  check('tous les segments du catalogue sont utilisés', all, JSON.stringify(uses));
}
{
  // Largeur minimale sur bien plus de graines (plans seuls : rapide), toutes les étapes 1 à 12.
  // La fin de plan (BREAK) n'abandonne jamais plus de 11 tuiles avant l'arène, même juste après
  // une fusion de plats (avant correction : 184 tuiles pour la graine 29984 à l'étape 2).
  const cases: [number, number][] = [[29984, 2], [12103, 1]];
  for (let seed = 1; seed <= 3000; seed++) for (let s = 1; s <= 12; s++) cases.push([seed, s]);
  let minW = 1e9;
  let short = 0;
  let first = '';
  for (const [seed, s] of cases) {
    const ss = stageSeed(seed, s);
    const w = planSegments(new Rng(ss), s).reduce((a, p) => a + p.w, 0);
    const want = targetWidth(new Rng(ss), s) - 11;
    minW = Math.min(minW, w);
    if (w < want) {
      if (!short) first = `graine ${seed} étape ${s} : ${w} < ${want}`;
      short++;
    }
  }
  check('largeur minimale : 3000 graines × étapes 1 à 12, au plus 11 tuiles sous la largeur visée (≥ 195)', short === 0 && minW >= 195, short ? `${short} niveaux trop courts, ${first}, min ${minW}` : `min ${minW}`);
  check('graine 29984 étape 2 et graine 12103 étape 1 : niveaux complets', buildStage(2, 29984).w >= 197 && buildStage(1, 12103).w >= 197, `${buildStage(2, 29984).w}, ${buildStage(1, 12103).w}`);
}
{
  // Pondération : plus de segments exigeants aux étapes avancées.
  const hardShare = (s: number) => {
    let hard = 0;
    let total = 0;
    for (let seed = 1; seed <= 150; seed++) {
      for (const p of planSegments(new Rng(stageSeed(seed, s)), s)) {
        const d = SEGMENTS[p.id as SegmentId];
        if (!d || d.weight === 0) continue;
        total++;
        if (d.tier >= 1) hard++;
      }
    }
    return hard / total;
  };
  const a = hardShare(1);
  const b = hardShare(7);
  check('la difficulté des segments croît avec l’étape', b > a + 0.05, `tiers ≥ 1 : ${(a * 100).toFixed(0)} % → ${(b * 100).toFixed(0)} %`);
}
{
  // Décors du biome uniquement (hors décors fixes), ennemis du biome, aucun décor dans l'arène.
  let ok = true;
  let info = '';
  for (let s = 1; s <= 8; s++) {
    const biome = biomeForStage(s);
    const l = buildStage(s, 31);
    const allowed = new Set<string>([...BIOMES[biome].decos.map(([k]) => k), 'shrine', 'lantern', 'torii']);
    const kinds = new Set(BIOMES[biome].enemies.map(([k]) => k));
    const inArena = l.decos.filter((d) => d.x > (l.arena.col + 1) * TILE && d.kind !== 'torii');
    if (l.decos.some((d) => !allowed.has(d.kind)) || l.enemySpawns.some((e) => !kinds.has(e.type)) || inArena.length) {
      ok = false;
      info = `étape ${s}`;
    }
  }
  check('décors et ennemis tirés dans le biome, arène sans décor', ok, info);
  const l = buildStage(4, 31);
  const g = l.decos.find((d) => d.kind === 'torii' && d.x === l.gate.x);
  check('torii s=0.9 sur la porte, lanterne sur chaque sanctuaire', !!g && g.s === 0.9 && l.checkpoints.every((c) => l.decos.some((d) => d.kind === 'lantern' && d.x === c.x && d.s === 1.35)));
}

// ─── Physique réelle : un bot simple traverse les niveaux ───────────────────

interface Bot {
  hold: number;
  /** Ne saute pas les trous : tombe dedans et doit en ressortir. */
  noGapJump: boolean;
}

/** Bot : court à droite, saute devant un mur ou un trou, s'accroupit devant un passage bas. */
function botButtons(w: World, p: Player, bot: Bot): number {
  const L = w.level;
  const b = BTN.RIGHT;
  if (bot.hold > 1) {
    bot.hold--;
    return b | BTN.JUMP;
  }
  if (bot.hold === 1) {
    bot.hold = 0; // relâche un tick avant tout nouveau saut
    return b;
  }
  if (!p.onGround) return b;
  const fy = Math.round(p.y / TILE);
  const solid = (x: number, y: number) => tileAt(L, x, y) === T_SOLID;
  const c0 = Math.floor((p.x - p.w / 2) / TILE);
  const cf = Math.floor((p.x + p.w / 2 + 6) / TILE);
  for (let c = c0; c <= cf + 1; c++) if (solid(c, fy - 2) && !solid(c, fy - 1)) return b | BTN.DOWN;
  if (solid(cf, fy - 1)) {
    bot.hold = 22;
    return b | BTN.JUMP;
  }
  const cg = Math.floor((p.x + p.w / 2 + 2) / TILE);
  if (!bot.noGapJump && tileAt(L, cg, fy) === T_EMPTY) {
    bot.hold = 22;
    return b | BTN.JUMP;
  }
  return b;
}

/** Monde de test sur le niveau donné : pas d'ennemis, pas de horde. */
function worldOn(level: Level): { w: World; p: Player } {
  const w = createWorld(3);
  Object.assign(w.level, level);
  w.enemies = [];
  w.spawnTimer = 1e9;
  const p = addPlayer(w, 'bot');
  p.x = level.spawn.x;
  p.y = level.spawn.y;
  p.spawnX = p.x;
  p.spawnY = p.y;
  return { w, p };
}

interface RunResult {
  ok: boolean;
  ticks: number;
  info: string;
}

/**
 * Fait courir le bot ; succès quand `goal` est vrai. Ennemis et projectiles vidés à chaque
 * tick (le gardien compris : l'arène se rouvre aussitôt). Échec : délai, valeur non
 * finie, mort, ou aucune progression pendant 10 s.
 */
function runBot(w: World, p: Player, bot: Bot, maxTicks: number, goal: () => boolean): RunResult {
  const m = new Map<number, number>();
  let best = p.x;
  let lastProgress = 0;
  let locked = false;
  for (let t = 0; t < maxTicks; t++) {
    w.enemies = [];
    w.projectiles = [];
    m.set(p.id, botButtons(w, p, bot));
    stepWorld(w, m);
    w.events.length = 0;
    if (w.stage.state !== 'playing') locked = true;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.vx) || !Number.isFinite(p.vy)) return { ok: false, ticks: t, info: 'valeur non finie' };
    if (p.state === 'dead') return { ok: false, ticks: t, info: `mort en x=${(p.x / TILE).toFixed(1)}` };
    if (goal()) return { ok: true, ticks: t, info: '' };
    if (p.x > best + 4) {
      best = p.x;
      lastProgress = t;
    } else if (t - lastProgress > 600) {
      return { ok: false, ticks: t, info: `bloqué en (${(p.x / TILE).toFixed(1)}, ${(p.y / TILE).toFixed(1)}) arène=${locked}` };
    }
  }
  return { ok: false, ticks: maxTicks, info: `délai dépassé en x=${(p.x / TILE).toFixed(1)}` };
}

/** Route haute d'un puits posé en colonne x0 : wall-jumps alternés jusqu'au plateau (rangée 8). */
function climbShaft(level: Level, x0: number): boolean {
  const { w, p } = worldOn(level);
  p.x = (x0 + 6) * TILE + 16;
  p.y = 15 * TILE;
  const m = new Map<number, number>();
  let dir = 1;
  let hold = 0;
  let prev = 0;
  for (let t = 0; t < 600; t++) {
    if (p.onGround && Math.abs(p.y - 8 * TILE) < 1 && p.x > (x0 + 8) * TILE) return true;
    let b = dir > 0 ? BTN.RIGHT : BTN.LEFT;
    if (p.y < 8 * TILE - 4) b = BTN.RIGHT; // au-dessus du plateau : on s'y pose
    else if (hold > 0) {
      hold--;
      b |= BTN.JUMP;
    } else if (!(prev & BTN.JUMP) && (p.onGround || touchingWall(p, w.level, dir))) {
      if (!p.onGround) dir = -dir; // le saut mural renvoie de l'autre côté
      hold = 14;
      b = (dir > 0 ? BTN.RIGHT : BTN.LEFT) | BTN.JUMP;
    }
    prev = b;
    m.set(p.id, b);
    stepWorld(w, m);
    w.events.length = 0;
  }
  return false;
}

// Chaque segment, entouré de sol plat dans un niveau minimal, traversé par la vraie physique.
{
  const ids = Object.keys(SEGMENTS) as SegmentId[];
  for (const id of ids) {
    let ok = true;
    let info = '';
    let maxT = 0;
    let n = 0;
    for (let k = 0; k < 16; k++) {
      const stage = 1 + (k % 8);
      const rng = new Rng(1000 + k * 7919 + id.length);
      const seg = SEGMENTS[id].make(rng, stage);
      const pieces: SegmentPiece[] = [startPiece(), flatPiece(6), seg, flatPiece(6), finalArenaPiece()];
      const segStart = 17 + 6;
      const level = assembleLevel(pieces, rng, stage, biomeForStage(stage));
      // Contrat de raccord : 2 tuiles plates au sol, 3 tuiles libres au-dessus, aux deux bouts.
      for (const x of [segStart, segStart + 1, segStart + seg.w - 2, segStart + seg.w - 1]) {
        if (tileAt(level, x, G) !== T_SOLID || [G - 1, G - 2, G - 3].some((y) => tileAt(level, x, y) !== T_EMPTY)) {
          ok = false;
          info = `raccord rompu en colonne relative ${x - segStart}`;
        }
      }
      const errs = validateLevel(level);
      const r = reachable(level);
      if (errs.length || !r.ok) {
        ok = false;
        info = `statique : ${errs[0] ?? r.reason}`;
      }
      if (id === 'wallShaft' && !climbShaft(level, segStart)) {
        ok = false;
        info = `instance ${k} : ascension en wall-jump impossible`;
      }
      if (id === 'slideTunnel') {
        // Debout, sans s'accroupir : le tunnel bloque.
        const { w, p } = worldOn(level);
        const m = new Map([[p.id, BTN.RIGHT]]);
        for (let t = 0; t < 300; t++) stepWorld(w, m);
        if (p.x > (segStart + 4) * TILE) {
          ok = false;
          info = `instance ${k} : tunnel franchi debout`;
        }
      }
      for (const noGapJump of id === 'shallowPit' ? [false, true] : [false]) {
        const { w, p } = worldOn(level);
        const exitX = (segStart + seg.w + 2) * TILE;
        const res = runBot(w, p, { hold: 0, noGapJump }, 60 * 30, () => p.x > exitX);
        n++;
        maxT = Math.max(maxT, res.ticks);
        if (!res.ok) {
          ok = false;
          info = `instance ${k}${noGapJump ? ' (sans sauter les trous)' : ''} : ${res.info}`;
        }
      }
    }
    check(`segment ${id} : contrat de raccord, statique et traversée réelle`, ok, ok ? `${n} traversées, ≤ ${maxT} ticks` : info);
  }
}

// Bot complet : 25 graines × étapes 1 à 4, du départ à la porte (bilan « cleared »).
{
  let ok = 0;
  let total = 0;
  let firstFail = '';
  let maxT = 0;
  for (let seed = 1; seed <= 25; seed++) {
    for (let s = 1; s <= 4; s++) {
      const w = createWorld(seed);
      const p = addPlayer(w, 'bot');
      w.stage.loop = s - 1;
      nextStage(w); // charge l'étape s (vrai chemin du jeu)
      w.spawnTimer = 1e9;
      total++;
      let armed = false;
      const res = runBot(w, p, { hold: 0, noGapJump: false }, 60 * 120, () => {
        if (w.stage.state === 'arena') armed = true;
        return w.stage.state === 'cleared';
      });
      maxT = Math.max(maxT, res.ticks);
      if (res.ok && armed) ok++;
      else if (!firstFail) firstFail = `graine ${seed} étape ${s} (w=${w.level.w}) : ${res.info}`;
    }
  }
  check('bot complet : 25 graines × étapes 1-4 jusqu’à la porte', ok === total, ok === total ? `${total} niveaux, ≤ ${(maxT / 60).toFixed(0)} s de jeu` : `${ok}/${total}, ${firstFail}`);
}

// ─── Exemples ───────────────────────────────────────────────────────────────
for (let s = 1; s <= 4; s++) {
  const l = buildStage(s, 7);
  const kinds: Record<string, number> = {};
  for (const e of l.enemySpawns) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
  const plan = planSegments(new Rng(stageSeed(7, s)), s).map((p) => p.id).join(' ');
  console.log(`  · étape ${s} (${l.biome}) : ${l.w} tuiles, ${l.checkpoints.length} sanctuaires, ${l.enemySpawns.length} ennemis ${JSON.stringify(kinds)}, ${l.decos.length} décors`);
  console.log(`    ${plan}`);
}

console.log(`  durée : ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de niveaux passent.');
