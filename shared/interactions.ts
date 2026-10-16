import { BOSS, COOP, ENEMY, HONOR, honorForLevel, PLAYER as P, SPAWN } from './constants';
import { DIFFICULTIES, enemyDmgScale, loopScoreMult } from './difficulty';
import { canFit } from './physics';
import type { Enemy, Player, World } from './types';
import { leechHeal, parryWindow, rollOffer } from './upgrades';

// Résolution des coups échangés entre joueurs et ennemis, et économie d'Honneur.

/** Jetons d'attaque : limite le nombre d'ennemis qui frappent en même temps (lisibilité). */
export function takeToken(w: World, e: Enemy): boolean {
  if (e.token) return true;
  if (e.type === 'boss') return true; // le boss ne partage pas
  // Coop : chaque joueur vivant a droit à son propre lot d'assaillants.
  const cap = w.mode === 'coop'
    ? ENEMY.MAX_ATTACKERS * Math.max(1, w.players.filter((p) => p.state !== 'dead').length)
    : ENEMY.MAX_ATTACKERS;
  if (w.attackTokens >= cap) return false;
  e.token = true;
  w.attackTokens++;
  return true;
}

export function releaseToken(w: World, e: Enemy): void {
  if (!e.token) return;
  e.token = false;
  w.attackTokens--;
}

export type DamageResult = 'parried' | 'hit' | 'ignored';

export function damagePlayer(w: World, p: Player, dmg: number, srcX: number): DamageResult {
  if (p.state === 'dead') return 'ignored';
  const srcSide = srcX >= p.x ? 1 : -1;

  // Parade : fenêtre courte, il faut faire face à l'attaque.
  if (p.state === 'parry' && p.stateT <= parryWindow(p) && p.facing === srcSide) {
    p.state = 'normal';
    p.stateT = 0;
    p.iframes = P.PARRY_SUCCESS_IFRAMES;
    p.freeze = 8;
    p.vx = -srcSide * 120;
    p.hp = Math.min(p.maxHp, p.hp + 6 * p.up.parry);
    w.stage.parries++;
    w.events.push({ type: 'parry', x: p.x + p.facing * 14, y: p.y - 30, pid: p.id });
    return 'parried';
  }
  if (p.iframes > 0 || p.state === 'dash' || p.state === 'iaiStrike') return 'ignored';

  dmg = Math.round(dmg * enemyDmgScale(w));
  p.hp -= dmg;
  p.combo = 0;
  p.comboTimer = 0;
  p.attack = null;
  p.vx = -srcSide * 260;
  p.vy = -320;
  p.onGround = false;
  p.iframes = P.HURT_IFRAMES;
  p.freeze = 5;
  if (p.h !== P.H && canFit(p, w.level, P.H)) {
    p.h = P.H;
    p.crouch = false;
  }
  w.events.push({ type: 'playerHit', x: p.x, y: p.y - p.h / 2, dir: -srcSide, damage: dmg, pid: p.id });

  if (p.hp <= 0) killPlayer(w, p);
  else {
    p.state = 'hurt';
    p.stateT = 0;
  }
  return 'hit';
}

function killPlayer(w: World, p: Player): void {
  p.hp = 0;
  p.state = 'dead';
  p.stateT = 0;
  p.respawnT = P.RESPAWN_TICKS;
  w.stage.deaths++;
  // Coop : pas de vies, on renaît toujours ; la moitié de l'Honneur tombe au sol.
  if (w.mode === 'coop') {
    const dropped = Math.floor(p.honor * HONOR.DEATH_DROP);
    if (dropped > 0) {
      spawnOrbs(w, p.x, p.y - 20, dropped, true);
      p.lostX = p.x;
      p.lostY = p.y;
    }
    w.events.push({ type: 'playerDeath', x: p.x, y: p.y, pid: p.id, lost: dropped, livesLeft: -1 });
    return;
  }
  p.lives--;
  // Plus de vie : le joueur sort de la partie, il ne laisse pas d'Honneur à ramasser.
  if (p.lives <= 0) {
    p.out = true;
    p.outT = 0;
  }
  // L'Honneur à moitié perdu reste au sol : on peut revenir le chercher.
  const lost = p.out ? 0 : Math.floor(p.honor * HONOR.DEATH_DROP);
  if (lost > 0) {
    spawnOrbs(w, p.x, p.y - 20, lost, true);
    p.lostX = p.x;
    p.lostY = p.y;
  }
  w.events.push({ type: 'playerDeath', x: p.x, y: p.y, pid: p.id, lost, livesLeft: p.lives });
}

/**
 * Renaissance du joueur : la horde qui l'a vaincu se dissipe. Les ennemis engagés contre
 * lui, ou proches du lieu de sa mort ou du sanctuaire, disparaissent ; une Marée en cours
 * se retire (sans bonus) et l'accalmie reprend. Le gardien et son arène ne sont pas concernés
 * (l'arène a sa propre réinitialisation). spawnX : lieu de renaissance (par défaut le sanctuaire).
 */
export function calmHordeOnRespawn(w: World, p: Player, deathX: number, spawnX: number = p.spawnX): void {
  if (w.mode === 'coop') {
    calmAroundSpawnCoop(w, p, spawnX);
    return;
  }
  const engaged = new Set(['chase', 'windup', 'attack', 'recover', 'hitstun', 'stunned', 'hidden']);
  const keep = [];
  for (const e of w.enemies) {
    const gone =
      e.type !== 'boss' &&
      e.state !== 'doomed' &&
      (engaged.has(e.state) || Math.abs(e.x - deathX) < SPAWN.CLEAR_AROUND_DEATH || Math.abs(e.x - spawnX) < SPAWN.CLEAR_AROUND_SPAWN);
    if (gone) {
      releaseToken(w, e);
      w.events.push({ type: 'despawn', x: e.x, y: e.y - e.h / 2 });
    } else keep.push(e);
  }
  w.enemies = keep;
  w.projectiles = w.projectiles.filter((a) => a.owner !== 'enemy');
  if (w.wave.phase !== 'calm') {
    w.wave.phase = 'calm';
    w.wave.t = 0;
    w.events.push({ type: 'tideEnd', n: w.wave.n, bonus: 0 });
  }
  w.spawnTimer = Math.max(w.spawnTimer, 180); // quelques secondes de répit
}

/**
 * Coop : la renaissance d'un joueur ne doit pas perturber les autres. La Marée et le spawner
 * continuent ; seuls disparaissent les ennemis (et projectiles ennemis) proches du point de
 * renaissance qui ne sont à portée d'aucun autre joueur vivant.
 */
function calmAroundSpawnCoop(w: World, p: Player, spawnX: number): void {
  const others = w.players.filter((q) => q !== p && q.state !== 'dead');
  const clears = (x: number) =>
    Math.abs(x - spawnX) < SPAWN.CLEAR_AROUND_SPAWN && others.every((q) => Math.abs(q.x - x) > COOP.KEEP_NEAR_OTHERS);
  const keep = [];
  for (const e of w.enemies) {
    if (e.type !== 'boss' && e.state !== 'doomed' && clears(e.x)) {
      releaseToken(w, e);
      w.events.push({ type: 'despawn', x: e.x, y: e.y - e.h / 2 });
    } else keep.push(e);
  }
  w.enemies = keep;
  w.projectiles = w.projectiles.filter((a) => a.owner !== 'enemy' || !clears(a.x));
}

export function stunEnemy(w: World, e: Enemy, pushDir: number, ticks: number = ENEMY.STUN_TICKS): void {
  releaseToken(w, e);
  e.state = 'stunned';
  e.stateT = 0;
  e.stunLen = e.type === 'boss' ? BOSS.STAGGER : ticks;
  e.move = 'none';
  if (e.type !== 'boss') e.vx = pushDir * 180;
  e.freeze = 8;
}

export interface HitInfo {
  dmg: number;
  kbx: number;
  kby: number;
  hitstop: number;
  cut: number;
  heavy: boolean; // brise la garde de l'oni
  fromX: number;
  fromY: number;
}

export type HitResult = 'none' | 'blocked' | 'hit' | 'kill';

/**
 * Auteur d'un événement de combat : `{ pid }` en coop, rien en solo (la clé reste absente,
 * pour que les événements solo soient identiques au bit près).
 */
export function byPlayer(w: World, p: Player): { pid?: number } {
  return w.mode === 'coop' ? { pid: p.id } : {};
}

/** Oni en garde, frappé de face et pas depuis le dessus ? */
function guards(e: Enemy, h: HitInfo): boolean {
  if (e.type !== 'oni') return false;
  if (e.state !== 'patrol' && e.state !== 'chase' && e.state !== 'windup') return false;
  const front = Math.sign(h.fromX - e.x) === e.facing;
  const fromAbove = h.fromY < e.y - e.h * 0.85;
  return front && !fromAbove;
}

export function hitEnemy(w: World, p: Player, e: Enemy, h: HitInfo): HitResult {
  if (e.state === 'dead' || e.state === 'doomed' || e.state === 'hidden' || e.state === 'intro') return 'none';

  if (guards(e, h)) {
    if (!h.heavy) {
      // Bouclier : le coup rebondit.
      e.flash = 2;
      e.freeze = 3;
      p.freeze = Math.max(p.freeze, 4);
      p.vx = -Math.sign(e.x - p.x) * 220;
      w.events.push({ type: 'block', x: e.x + e.facing * 14, y: e.y - e.h * 0.55, dir: -e.facing, ...byPlayer(w, p) });
      return 'blocked';
    }
    stunEnemy(w, e, Math.sign(e.x - h.fromX) || 1, 80);
    w.events.push({ type: 'guardBreak', x: e.x + e.facing * 14, y: e.y - e.h * 0.55, ...byPlayer(w, p) });
  }

  const mult = e.state === 'stunned' ? 1.5 : 1; // punition après parade
  const dmg = h.dmg * mult;
  e.hp -= dmg;
  e.flash = 5;
  e.freeze = h.hitstop;
  if (e.type !== 'boss') {
    e.vx = h.kbx;
    e.vy = h.kby;
    if (h.kby < 0) e.onGround = false;
  }
  if (p.state !== 'dead') p.hp = Math.min(p.maxHp, p.hp + leechHeal(p));
  bumpCombo(p);
  w.events.push({ type: 'hit', x: e.x, y: e.y - e.h * 0.55, dir: h.kbx >= 0 ? 1 : -1, damage: dmg, heavy: h.heavy, targetId: e.id, ...byPlayer(w, p) });

  if (e.hp <= 0) {
    killEnemy(w, e, p, h.cut, false);
    return 'kill';
  }
  // Le boss a une super-armure : il ne vacille pas, sauf s'il est déjà étourdi.
  if (e.type !== 'boss' && e.state !== 'stunned') {
    releaseToken(w, e);
    e.state = 'hitstun';
    e.stateT = 0;
    e.move = 'none';
    e.stunLen = h.heavy ? 30 : 20;
  }
  return 'hit';
}

/** Frappe d'iai fatale : l'ennemi se fige… puis se sépare en deux un instant plus tard. */
export function doomEnemy(w: World, p: Player, e: Enemy): void {
  if (e.state === 'dead' || e.state === 'doomed') return;
  releaseToken(w, e);
  e.state = 'doomed';
  e.stateT = 0;
  e.vx = 0;
  e.vy = 0;
  e.flash = 4;
  e.doomBy = p.id;
  bumpCombo(p);
  w.events.push({ type: 'doom', id: e.id, x: e.x, y: e.y - e.h / 2 });
}

export function killEnemy(w: World, e: Enemy, p: Player | null, cut: number, byIai: boolean): void {
  releaseToken(w, e);
  e.state = 'dead';
  w.totalKills++;
  w.stage.kills++;
  if (w.wave.phase === 'tide') w.wave.kills++;
  let honor: number = HONOR[e.type];
  if (p) {
    p.kills++;
    honor = Math.round(honor * (1 + Math.min(20, p.combo) * HONOR.COMBO_BONUS));
    // Un projectile encore en vol après la dernière mort ne compte plus.
    if (!p.out) {
      p.runKills++;
      addScore(w, p, honor);
    }
  }
  spawnOrbs(w, e.x, e.y - e.h * 0.5, honor, false);
  w.events.push({
    type: 'kill',
    id: e.id,
    enemyType: e.type,
    x: e.x,
    y: e.y,
    facing: e.facing,
    dir: p ? (e.x >= p.x ? 1 : -1) : 1,
    cutAngle: cut,
    byIai,
    pid: p ? p.id : 0,
    honor,
  });
}

function bumpCombo(p: Player): void {
  p.combo++;
  p.comboTimer = P.COMBO_TIMEOUT;
  if (p.combo > p.bestCombo) p.bestCombo = p.combo;
}

// ─── Score ──────────────────────────────────────────────────────────────────

/** Crédite le score (entier, jamais décroissant), pondéré par la difficulté et la boucle. */
export function addScore(w: World, p: Player, base: number): void {
  if (base <= 0) return;
  p.score += Math.round(base * DIFFICULTIES[w.difficulty].scoreMult * loopScoreMult(w.stage.loop));
}

// ─── Honneur ────────────────────────────────────────────────────────────────

export function spawnOrbs(w: World, x: number, y: number, total: number, lost: boolean): void {
  let left = Math.round(total);
  let count = 0;
  while (left > 0 && count < 40) {
    const v = left >= 50 ? 25 : left >= 12 ? 5 : 1;
    const value = Math.min(left, count === 39 ? left : v);
    left -= value;
    count++;
    const ang = -Math.PI / 2 + (w.rng.next() - 0.5) * 2.2;
    const spd = 120 + w.rng.next() * 220;
    w.orbs.push({
      id: w.nextId++, x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, value,
      life: lost ? HONOR.LOST_LIFE : HONOR.ORB_LIFE, lost, onGround: false,
    });
  }
}

export function gainHonor(w: World, p: Player, v: number): void {
  p.honor += v;
  w.stage.honor += v;
  while (p.honor >= honorForLevel(p.level + 1)) {
    p.level++;
    p.picks++;
    w.events.push({ type: 'levelUp', level: p.level, pid: p.id });
  }
  if (p.picks > 0 && p.offer.length === 0) p.offer = rollOffer(w.rng, p.up);
}
