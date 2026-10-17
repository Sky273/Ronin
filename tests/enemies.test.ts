// Tests des ennemis, de l'arène et des renforts (simulation, sans réseau) : jetons d'attaque
// à la fermeture et à la réouverture de l'arène, barrière en solo, renforts du cor, de la horde
// et de la Marée, gardien perché, réapparition du ninja.
// Lancer : npx esbuild tests/enemies.test.ts --bundle --platform=node --format=esm --log-level=warning --outfile=node_modules/.cache/enemies.test.mjs && node node_modules/.cache/enemies.test.mjs
import { ENEMY, PLAYER, TILE } from '../shared/constants';
import { findGround, spawnEnemy } from '../shared/enemy';
import { BTN } from '../shared/input';
import { damagePlayer, releaseToken, takeToken } from '../shared/interactions';
import { arenaInside, type Level } from '../shared/level';
import { Rng } from '../shared/math';
import { fitsAt } from '../shared/physics';
import type { Enemy, GameEvent, GameMode, Player, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, stepWorld, warpToArena } from '../shared/world';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** États lus sans le rétrécissement de type de TypeScript (ils changent pendant stepWorld). */
const stateOf = (w: World): string => w.stage.state;
const pState = (p: Player): string => p.state;

/** Avance de n ticks ; renvoie les événements produits. */
function run(w: World, n: number, input: (t: number, id: number) => number = () => 0, each?: (w: World) => void): GameEvent[] {
  const evs: GameEvent[] = [];
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    m.clear();
    for (const p of w.players) m.set(p.id, input(w.tick, p.id));
    stepWorld(w, m);
    evs.push(...w.events);
    w.events.length = 0;
    each?.(w);
  }
  return evs;
}

/** Tue un joueur à coup sûr (en ignorant parade et invulnérabilité). */
function kill(w: World, p: Player): void {
  if (p.state === 'dead') return;
  p.iframes = 0;
  p.state = 'normal';
  damagePlayer(w, p, 1e6, p.x + 10);
}

/** Ennemis porteurs d'un jeton d'attaque (doit toujours égaler w.attackTokens). */
const carriers = (w: World): number => w.enemies.filter((e) => e.token).length;

/** Monde sans ennemi ni renfort, Marée en sommeil, un joueur. */
function quiet(seed: number, mode: GameMode = 'solo'): { w: World; p: Player } {
  const w = createWorld(seed, { mode });
  w.enemies = [];
  w.spawnTimer = 1e9;
  w.wave.t = -1e9;
  const p = addPlayer(w, 'p');
  p.lives = 99;
  return { w, p };
}

/** Ferme l'arène (joueur posé au sol juste après le déclencheur) ; renvoie le gardien. */
function seal(w: World, p: Player): Enemy {
  p.x = w.level.arena.trigger + 10;
  p.y = w.level.arena.guardianY;
  p.vx = 0;
  p.vy = 0;
  run(w, 1);
  return w.enemies.find((e) => e.id === w.stage.guardianId) as Enemy;
}

/** Ennemi posé en poursuite, sans délai d'attaque (cd) sauf mention. */
function foe(w: World, type: Enemy['type'], x: number, y: number, cd = 0): Enemy {
  const e = spawnEnemy(w, type, x, y, false);
  e.state = 'chase';
  e.cd = cd;
  return e;
}

/** Marée forcée en continu (renforts toutes les 26 à 52 ticks, aux distances de la Marée). */
function forceTide(w: World, n: number): void {
  w.wave.phase = 'tide';
  w.wave.t = 0;
  w.wave.n = n;
  w.wave.quota = 1e9;
}

// ─── 1. Jetons d'attaque : la fermeture et la réouverture de l'arène les libèrent ─
{
  // Trois lanciers en préparation suivent le joueur dans l'arène : la fermeture les retire.
  const { w, p } = quiet(1);
  const a = w.level.arena;
  p.x = 187.4 * TILE; // sur la marche d'entrée, avant le déclencheur
  p.y = a.guardianY;
  run(w, 2);
  for (const tx of [188.3, 188.7, 189.2]) foe(w, 'ashigaru', tx * TILE, a.guardianY);
  const guard = () => {
    p.iframes = 99;
    p.hp = p.maxHp;
  };
  for (let i = 0; i < 10 && carriers(w) < 3; i++) run(w, 1, () => 0, guard);
  const before = `${w.attackTokens} jetons, ${carriers(w)} porteurs`;
  const prepared = carriers(w) === 3;
  for (let i = 0; i < 120 && stateOf(w) !== 'arena'; i++) run(w, 1, () => BTN.RIGHT, guard);
  check(
    'fermeture de l’arène : les jetons des ennemis retirés sont libérés',
    prepared && stateOf(w) === 'arena' && w.attackTokens === carriers(w),
    `avant : ${before} ; après : ${w.attackTokens} jetons, ${carriers(w)} porteurs`,
  );
  // Conséquence : après la mort dans l'arène et la renaissance, un lancier au contact attaque encore.
  kill(w, p);
  for (let i = 0; i < 400 && pState(p) === 'dead'; i++) run(w, 1);
  const e = foe(w, 'ashigaru', p.x + 40, p.y);
  const evs = run(w, 120, () => 0, guard);
  const windups = evs.filter((ev) => ev.type === 'windup' && ev.id === e.id).length;
  check('après fermeture, mort et renaissance : un lancier au contact attaque encore', stateOf(w) === 'playing' && windups > 0 && w.attackTokens === carriers(w), `${windups} préparation(s), ${w.attackTokens} jetons`);
}
{
  // Lancier de l'arène (comme un renfort du cor) en pleine attaque quand le joueur meurt :
  // la réouverture le retire avec son jeton.
  let ok = true;
  let info = '';
  for (let cycle = 0; cycle < 3 && ok; cycle++) {
    const { w, p } = quiet(1 + cycle);
    const g = seal(w, p);
    g.freeze = 1e9;
    const e = foe(w, 'ashigaru', p.x + 40, p.y);
    run(w, 1);
    const had = e.token;
    kill(w, p);
    run(w, 2);
    if (!had || stateOf(w) !== 'playing' || w.enemies.includes(e) || w.attackTokens !== carriers(w)) {
      ok = false;
      info = `graine ${1 + cycle} : jeton pris=${had}, état=${w.stage.state}, ${w.attackTokens} jetons, ${carriers(w)} porteurs`;
    }
  }
  check('réouverture de l’arène (mort du joueur) : le jeton du renfort retiré est libéré', ok, info);
}

// ─── 6. Solo : ennemis à cheval sur la barrière retirés à la fermeture ───────
{
  const { w, p } = quiet(1);
  const a = w.level.arena;
  const col = a.col;
  const kept = foe(w, 'ashigaru', (col - 1) * TILE, a.guardianY, 999); // entièrement dehors : reste
  const straddling = [-0.3, 0.1, 0.5, 0.7, 0.9].map((off) => foe(w, 'ashigaru', (col + off) * TILE, a.guardianY, 999));
  const oni = foe(w, 'oni', (col + 0.4) * TILE, 15 * TILE, 999); // sur la plateforme de la rangée 15
  const holder = straddling[2];
  takeToken(w, holder);
  holder.state = 'windup';
  holder.move = 'thrust';
  const g = seal(w, p);
  if (g) g.freeze = 1e9;
  const left = [...straddling, oni].filter((e) => w.enemies.includes(e));
  check(
    'solo, fermeture : ennemis à cheval sur la barrière retirés (ni encastrés, ni dans l’arène)',
    stateOf(w) === 'arena' && left.length === 0 && w.enemies.includes(kept),
    left.map((e) => `${e.type} en ${(e.x / TILE - col).toFixed(1)}`).join(', ') || 'aucun',
  );
  check('solo, fermeture : le jeton de l’ennemi retiré est libéré', !w.enemies.includes(holder) && w.attackTokens === carriers(w), `${w.attackTokens} jetons, ${carriers(w)} porteurs`);
  // Quelques secondes plus tard, aucun ennemi ordinaire dans le mur ni dans l'arène.
  run(w, 300, () => 0, () => {
    p.x = a.trigger + 150;
    p.iframes = 99;
  });
  const bad = w.enemies.filter((e) => e.type !== 'boss' && e.x + e.w / 2 > col * TILE);
  check('solo, 5 s après la fermeture : aucun ennemi ordinaire dans la barrière ni dans l’arène', bad.length === 0, bad.map((e) => `${e.type} x=${(e.x / TILE).toFixed(2)}`).join(', ') || 'aucun');
}

// ─── 7. La barrière fermée isole l'arène, en solo comme en coop ──────────────
for (const mode of ['solo', 'coop'] as GameMode[]) {
  // Téléportation du ninja : collé dehors, le joueur juste derrière la barrière.
  const { w, p } = quiet(1, mode);
  const col = w.level.arena.col;
  const g = seal(w, p);
  g.freeze = 1e9;
  p.x = (col + 1) * TILE + 30;
  const n = foe(w, 'ninja', col * TILE - 20, w.level.arena.guardianY, 999);
  n.dodgeCd = 0;
  let inside = false;
  const evs = run(w, 120, () => 0, () => {
    p.iframes = 99;
    p.hp = p.maxHp;
    inside ||= w.enemies.includes(n) && arenaInside(w.level, n.x);
  });
  const appear = evs.filter((ev) => ev.type === 'appear' && ev.id === n.id && arenaInside(w.level, ev.x)).length;
  check(`${mode} : un ninja dehors ne se téléporte pas dans l’arène fermée`, stateOf(w) === 'arena' && !inside && appear === 0, `x−barrière ${(n.x - col * TILE).toFixed(0)} px, ${appear} réapparition(s) dedans`);
}
for (const mode of ['solo', 'coop'] as GameMode[]) {
  // Ninja disparu juste avant la fermeture, le joueur entre la barrière et le déclencheur : sa destination
  // (choisie barrière ouverte) tombait dans la colonne de la barrière ; il y réapparaissait, et son estoc le
  // faisait entrer dans l'arène fermée.
  let tries = 0;
  let early = 0;
  let hits = 0;
  const bad: string[] = [];
  for (let k = 0; k < 40; k++) {
    for (const off of [-60, -75, -90, -105]) {
      const { w, p } = quiet(1, mode);
      const a = w.level.arena;
      const col = a.col;
      p.x = (col + 1) * TILE + 8 + (k / 40) * (a.trigger - (col + 1) * TILE - 8);
      p.y = a.guardianY;
      p.facing = 1;
      if (p.x + off + ENEMY.ninja.w / 2 > col * TILE) continue;
      const n = foe(w, 'ninja', p.x + off, a.guardianY, 999);
      n.dodgeCd = 0;
      tries++;
      let vanishT = -1;
      let lockT = -1;
      let wrong = '';
      run(w, 360, () => (stateOf(w) === 'playing' ? BTN.RIGHT : 0), (w) => {
        const g = w.enemies.find((e) => e.id === w.stage.guardianId);
        if (g) g.freeze = 1e9;
        if (vanishT < 0 && n.state === 'hidden') vanishT = w.tick;
        if (lockT < 0 && stateOf(w) === 'arena') lockT = w.tick;
        if (lockT >= 0 && p.hp < p.maxHp) hits++;
        p.hp = p.maxHp;
        if (!wrong && lockT >= 0 && w.enemies.includes(n) && n.state !== 'hidden' && n.x + n.w / 2 > col * TILE) {
          wrong = `joueur ${(p.x / TILE).toFixed(2)} écart ${off} : ${n.state} en ${(n.x / TILE).toFixed(2)}`;
        }
      });
      if (vanishT >= 0 && lockT >= vanishT && lockT - vanishT < 16) early++;
      if (wrong) bad.push(wrong);
    }
  }
  check(`${mode} : ninja disparu juste avant la fermeture : jamais dans la barrière ni dans l’arène, joueur jamais touché`, early > tries / 2 && bad.length === 0 && hits === 0, `${early}/${tries} disparus < 16 ticks avant, ${bad.length} dedans, ${hits} coup(s) ${bad.slice(0, 2).join(' ; ')}`);
}
for (const mode of ['solo', 'coop'] as GameMode[]) {
  // Corps à corps à travers la barrière : un lancier collé dehors, le joueur collé dedans.
  const strike = (attacker: 'foe' | 'player') => {
    const { w, p } = quiet(1, mode);
    const col = w.level.arena.col;
    const g = seal(w, p);
    g.freeze = 1e9;
    const px = (col + 1) * TILE + p.w / 2 + 0.5;
    const e = foe(w, 'ashigaru', col * TILE - 11, w.level.arena.guardianY, attacker === 'foe' ? 0 : 999);
    e.facing = 1;
    const ehp = e.hp;
    const evs = run(w, 300, (t) => (attacker === 'player' && t % 12 < 2 ? BTN.ATTACK : 0), () => {
      p.x = px;
      p.vx = 0;
      p.facing = -1;
      p.iframes = 0;
      p.hp = p.maxHp;
      if (attacker === 'player') e.cd = 999;
    });
    const hits = evs.filter((ev) => ev.type === 'playerHit').length;
    return { hits, ehp: `${ehp} → ${e.hp}`, eHurt: e.hp < ehp, locked: stateOf(w) === 'arena' };
  };
  const a = strike('foe');
  check(`${mode} : un lancier dehors ne touche pas le joueur à travers la barrière`, a.locked && a.hits === 0, `${a.hits} coup(s)`);
  const b = strike('player');
  check(`${mode} : le joueur dans l’arène ne touche pas un ennemi dehors à travers la barrière`, b.locked && !b.eHurt, `PV ${b.ehp}`);
}

// ─── 8. Renforts du cor : dans l'arène, le corps libre, dans les deux modes ──
for (const mode of ['solo', 'coop'] as GameMode[]) {
  let adds = 0;
  let out = 0;
  let stuck = 0;
  let horns = 0;
  let first = '';
  for (let s = 1; s <= 20; s++) {
    const { w, p } = quiet(s, mode);
    const col = w.level.arena.col;
    const g = seal(w, p);
    // Gardien près de l'entrée, en rage, sous le seuil du cor.
    g.x = (col + 4) * TILE;
    g.y = w.level.arena.guardianY;
    g.vx = 0;
    g.state = 'chase';
    g.cd = 0;
    g.phase2 = true;
    g.hp = Math.floor(g.maxHp * 0.65);
    const seen = new Set(w.enemies.map((e) => e.id));
    let horn = false;
    for (let t = 0; t < 200 && !horn; t++) {
      const evs = run(w, 1, () => 0, () => {
        p.x = g.x + 60;
        p.vx = 0;
        p.iframes = 99;
        p.hp = p.maxHp;
      });
      horn = evs.some((ev) => ev.type === 'horn');
    }
    if (horn) horns++;
    for (const e of w.enemies) {
      if (seen.has(e.id)) continue;
      adds++;
      if (e.x - e.w / 2 < (col + 1) * TILE) {
        out++;
        if (!first) first = `graine ${s} : renfort en ${(e.x / TILE).toFixed(1)} (barrière ${col})`;
      }
      if (!fitsAt(w.level, e.x, e.y, e.w, e.h)) stuck++;
    }
  }
  check(`${mode} : renforts du cor tous dans l’arène, le corps libre`, horns === 20 && adds > 0 && out === 0 && stuck === 0, `${horns} cors, ${adds} renforts, ${out} dehors, ${stuck} encastrés${first ? ', ' + first : ''}`);
}

// ─── 9. Horde : jamais à l'écran près du joueur, même près des bords ─────────
{
  const problems: string[] = [];
  let spawned = 0;
  let nearest = Infinity;
  for (const seed of [1, 2]) {
    const { w, p } = quiet(seed);
    const col = w.level.arena.col;
    // Sanctuaire de départ, terrasse de la pagode (8 tuiles avant la barrière), milieu du niveau.
    const spots = [w.level.spawn, { x: (col - 8) * TILE, y: 12 * TILE }, { x: 70.5 * TILE, y: 18 * TILE }];
    for (const at of spots) {
      p.x = at.x;
      p.y = at.y;
      w.spawnTimer = 0;
      forceTide(w, 3);
      run(w, 3000, () => 0, (w) => {
        for (const e of w.enemies) {
          if (!e.horde) continue;
          spawned++;
          const d = Math.abs(e.x - at.x);
          nearest = Math.min(nearest, d);
          if (d < 500 || e.x < 3 * TILE || e.x > (col - 3) * TILE) problems.push(`graine ${seed} : renfort ${e.type} en ${(e.x / TILE).toFixed(1)}, joueur en ${(at.x / TILE).toFixed(1)}`);
        }
        w.enemies = [];
        w.attackTokens = 0;
        forceTide(w, 3);
        p.x = at.x;
        p.y = at.y;
        p.vx = 0;
        p.vy = 0;
        p.iframes = 99;
      });
    }
  }
  check('horde : renforts à 500 px au moins du joueur et dans [3, arena.col − 3] (jamais ramenés sur la borne)', problems.length === 0 && spawned > 100, `${spawned} renforts, le plus proche à ${nearest.toFixed(0)} px${problems.length ? ' ; ' + problems.slice(0, 2).join(' ; ') : ''}`);
}

// ─── 10. Marée : un renfort marche vers le joueur au lieu de repasser en patrouille ─
{
  let tracked = 0;
  let patrol = 0;
  let first = '';
  for (let seed = 1; seed <= 6; seed++) {
    for (const stage of [0, 1]) {
      const { w, p } = quiet(seed);
      if (stage) {
        nextStage(w);
        w.enemies = [];
      }
      const cps = w.level.checkpoints;
      const at = cps[Math.min(2, cps.length - 1)];
      const born = new Map<Enemy, number>();
      p.x = at.x;
      p.y = at.y;
      w.spawnTimer = 0;
      forceTide(w, 2);
      run(w, 3600, () => 0, (w) => {
        for (const e of w.enemies) {
          if (!e.horde) continue;
          if (!born.has(e)) {
            born.set(e, w.tick);
            tracked++;
          }
          const age = w.tick - (born.get(e) as number);
          if (age <= 120 && e.state === 'patrol') {
            patrol++;
            if (!first) first = `graine ${seed} étape ${stage} : ${e.type} apparu à ${Math.abs(e.x - p.x).toFixed(0)} px, en patrouille après ${age} tick(s)`;
            born.set(e, -1e9); // compté une fois
          }
        }
        // Renforts observés assez longtemps : retirés pour que la Marée en envoie d'autres.
        for (const e of w.enemies) if (e.horde && w.tick - (born.get(e) as number) > 150) releaseToken(w, e);
        w.enemies = w.enemies.filter((e) => !e.horde || w.tick - (born.get(e) as number) <= 150);
        forceTide(w, 2);
        p.x = at.x;
        p.y = at.y;
        p.vx = 0;
        p.vy = 0;
        p.iframes = 99;
        p.hp = p.maxHp;
      });
    }
  }
  check('Marée : aucun renfort en patrouille pendant ses 2 premières secondes', tracked > 300 && patrol === 0, `${patrol}/${tracked} renforts${first ? ', ' + first : ''}`);
}

// ─── 11. Gardien perché sur une plateforme, joueur juste dessous ─────────────
for (const mode of ['solo', 'coop'] as GameMode[]) {
  // Plateformes de l'arène historique : rangée 14 (colonnes 192-198), rangée 10 (198-204), rangée 15 (187-188).
  for (const [tx, row] of [[195, 14], [201, 10], [188, 15]]) {
    const w = createWorld(1, { mode });
    w.enemies = [];
    w.spawnTimer = 1e9;
    const p = addPlayer(w, 'p');
    warpToArena(w);
    run(w, 30, () => BTN.RIGHT);
    const g = w.enemies.find((e) => e.id === w.stage.guardianId) as Enemy;
    g.x = tx * TILE;
    g.y = row * TILE;
    g.vx = 0;
    g.vy = 0;
    g.onGround = true;
    g.state = 'chase';
    g.stateT = 0;
    g.cd = 0;
    const px = g.x + 40;
    const gy0 = g.y;
    let lowest = g.y;
    const evs = run(w, 600, () => 0, () => {
      p.x = px;
      p.y = 18 * TILE;
      p.vx = 0;
      p.iframes = 99;
      p.hp = p.maxHp;
      lowest = Math.max(lowest, g.y);
    });
    const windups = evs.filter((ev) => ev.type === 'windup' && ev.id === g.id).length;
    check(
      `${mode} : gardien perché (rangée ${row}), joueur dessous : il descend et attaque`,
      stateOf(w) === 'arena' && lowest > gy0 + TILE && windups > 0,
      `descente ${((lowest - gy0) / TILE).toFixed(1)} tuile(s), ${windups} préparation(s)`,
    );
  }
}

// ─── 12. Renforts de la horde, ninja réapparu : le corps entièrement libre ────
{
  let spawned = 0;
  let stuck = 0;
  let first = '';
  for (let seed = 1; seed <= 8; seed++) {
    const { w, p } = quiet(seed);
    for (let stage = 0; stage <= 4; stage++) {
      if (stage) {
        nextStage(w);
        w.enemies = [];
      }
      for (const at of w.level.checkpoints) {
        p.x = at.x;
        p.y = at.y;
        w.spawnTimer = 0;
        forceTide(w, 3);
        run(w, 600, () => 0, (w) => {
          for (const e of w.enemies) {
            if (!e.horde) continue;
            spawned++;
            const d = ENEMY[e.type];
            if (!fitsAt(w.level, e.x, e.y, d.w, d.h)) {
              stuck++;
              if (!first) first = `graine ${seed} étape ${stage} : ${e.type} en (${(e.x / TILE).toFixed(2)}, ${(e.y / TILE).toFixed(0)})`;
            }
          }
          w.enemies = [];
          w.attackTokens = 0;
          forceTide(w, 3);
          p.x = at.x;
          p.y = at.y;
          p.vx = 0;
          p.vy = 0;
          p.iframes = 99;
        });
      }
    }
  }
  check('horde : aucun renfort encastré dans le décor à son apparition', spawned > 1000 && stuck === 0, `${stuck}/${spawned} encastrés${first ? ', ' + first : ''}`);
}
{
  // Ninja : sa destination est choisie à la disparition, le sol recalculé 16 ticks plus tard près du joueur,
  // qui a pu changer de hauteur (findGround ne regarde que la colonne du centre, ou ne trouve rien).
  /** Disparition du ninja `n`, le joueur déplacé par `move` pendant qu'il est caché : corps libre à la réapparition ? */
  const reappear = (w: World, p: Player, n: Enemy, move: () => void): string => {
    let hidden = false;
    let res = 'pas de disparition';
    run(w, 40, () => 0, () => {
      if (res.startsWith('réapparu')) return;
      if (n.state === 'hidden') {
        hidden = true;
        move();
      } else if (hidden) {
        res = `réapparu en (${(n.x / TILE).toFixed(2)}, ${(n.y / TILE).toFixed(2)}) libre=${fitsAt(w.level, n.x, n.y, n.w, n.h)}`;
      }
      p.vx = 0;
      p.vy = 0;
      p.iframes = 99;
    });
    return res;
  };
  {
    // Plateforme sautée (graine 5, étape 5) : joueur en l'air au-dessus de la plateforme de la rangée 12 à la
    // disparition, retombé plus bas à la réapparition ; le sol trouvé (rangée 18) est contre la colonne 87 pleine.
    const { w, p } = quiet(5);
    for (let s = 0; s < 5; s++) nextStage(w);
    w.enemies = [];
    w.spawnTimer = 1e9;
    w.wave.t = -1e9;
    p.x = 89.81 * TILE;
    p.y = 13.08 * TILE;
    p.facing = 1;
    const n = foe(w, 'ninja', 91.5 * TILE, 15 * TILE, 999);
    n.dodgeCd = 0;
    const fits0 = fitsAt(w.level, n.x, n.y, n.w, n.h);
    const res = reappear(w, p, n, () => {
      p.x = 89.81 * TILE;
      p.y = 14.28 * TILE;
    });
    check('ninja : joueur retombé sous la plateforme pendant la disparition : réapparition le corps libre', fits0 && res.endsWith('libre=true'), res);
  }
  {
    // Joueur descendu au pied d'un bloc (graine 24, étape 4) : findGround ne trouve rien à la destination
    // (dans le bloc), le ninja y réapparaissait à son ancienne hauteur, entièrement dans le bloc.
    const { w, p } = quiet(24);
    for (let s = 0; s < 4; s++) nextStage(w);
    w.enemies = [];
    w.spawnTimer = 1e9;
    w.wave.t = -1e9;
    p.x = 43.84 * TILE;
    p.y = 15 * TILE;
    p.facing = -1;
    const n = foe(w, 'ninja', 47.27 * TILE, 18 * TILE, 999);
    n.dodgeCd = 0;
    const fits0 = fitsAt(w.level, n.x, n.y, n.w, n.h);
    const res = reappear(w, p, n, () => {
      p.x = 49.3 * TILE;
      p.y = 18 * TILE;
    });
    let stuck = 0;
    run(w, 300, () => 0, () => {
      p.x = 49.3 * TILE;
      p.y = 18 * TILE;
      p.iframes = 99;
      p.hp = p.maxHp;
      if (w.enemies.includes(n) && !fitsAt(w.level, n.x, n.y, n.w, n.h)) stuck++;
    });
    check('ninja : joueur descendu au pied d’un bloc pendant la disparition : réapparition le corps libre', fits0 && res.endsWith('libre=true') && stuck === 0, `${res}, ensuite ${stuck}/300 ticks encastré`);
  }
  // Balayage : joueur sur un sol quelconque, ninja à portée de disparition ; pendant qu'il est caché, le
  // joueur passe sur un autre sol d'une colonne voisine (plus haut ou plus bas, sur un bloc ou à son pied),
  // parfois en l'air.
  /** Sols de la colonne de x (pieds) où un corps de largeur cw et de hauteur ch tient. */
  const grounds = (l: Level, x: number, cw: number, ch: number): number[] => {
    const out: number[] = [];
    for (let y = findGround(l, x, 0, 0); y !== null; y = findGround(l, x, y + TILE, 0)) if (fitsAt(l, x, y, cw, ch)) out.push(y);
    return out;
  };
  const rng = new Rng(2468);
  const pick = (a: number[]): number => a[Math.floor(rng.next() * a.length)];
  let appears = 0;
  let stuck = 0;
  let first = '';
  for (let seed = 1; seed <= 4; seed++) {
    const { w, p } = quiet(seed);
    for (let stage = 0; stage <= 4; stage++) {
      if (stage) nextStage(w);
      w.spawnTimer = 1e9;
      w.wave.t = -1e9;
      const l = w.level;
      for (let k = 0; k < 40; k++) {
        w.enemies = [];
        w.attackTokens = 0;
        const x = rng.range(4, l.arena.col - 6) * TILE;
        const gs = grounds(l, x, p.w, PLAYER.H);
        if (!gs.length) continue;
        const gy = rng.next() < 0.5 ? gs[0] : pick(gs); // souvent le plus haut (sur un bloc)
        const nx = x + (rng.next() < 0.5 ? -1 : 1) * rng.range(50, 105);
        const ngs = grounds(l, nx, ENEMY.ninja.w, ENEMY.ninja.h);
        if (!ngs.length) continue;
        p.x = x;
        p.y = gy;
        p.facing = rng.next() < 0.5 ? -1 : 1;
        const n = foe(w, 'ninja', nx, pick(ngs), 999); // à n'importe quelle hauteur : il disparaît dès 110 px
        n.dodgeCd = 0;
        // Pendant la disparition, le joueur saute, tombe ou s'écarte (position libre, sinon inchangée).
        const mx = x + rng.range(-90, 90);
        const ms = grounds(l, mx, p.w, PLAYER.H);
        const my = ms.length ? (rng.next() < 0.5 ? ms[ms.length - 1] : pick(ms)) : null; // souvent le plus bas
        const air = rng.next() < 0.5 ? 0 : rng.range(0, 3) * TILE;
        const to = my !== null && fitsAt(l, mx, my - air, p.w, PLAYER.H) ? { x: mx, y: my - air } : { x, y: gy };
        const res = reappear(w, p, n, () => {
          p.x = to.x;
          p.y = to.y;
        });
        if (!res.startsWith('réapparu')) continue;
        appears++;
        if (!res.endsWith('libre=true')) {
          stuck++;
          if (!first) first = `graine ${seed} étape ${stage} : ${res}`;
        }
      }
    }
  }
  check('ninja : jamais encastré dans le décor à sa réapparition, même si le joueur change de hauteur', appears > 300 && stuck === 0, `${stuck}/${appears} encastrés${first ? ', ' + first : ''}`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests des ennemis et de l’arène passent.');
