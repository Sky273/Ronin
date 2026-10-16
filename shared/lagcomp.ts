// Compensation de latence des coups (mode en ligne uniquement).
//
// Le serveur juge chaque échange de coups tel que le joueur l'a vu à l'écran :
// - attaque : le corps de l'ennemi est pris au tick de vue du joueur (S − L) ;
// - défense : une frappe ennemie (ou un projectile ennemi) enregistrée au tick S − L est jugée
//   contre l'état actuel du joueur, L ticks plus tard (avantage à celui qui pare).
//
// Tout passe par `World.net`, posé uniquement par la session serveur : sans `w.net`
// (solo, tests coop purs, client) ou avec L = 0, la sémantique d'origine est inchangée.
//
// Convention des ticks : l'enregistrement H[k] est l'état du monde au début du pas k
// (enregistré à la fin du pas k − 1, après w.tick++), c'est-à-dire l'instantané de tick k.
import { bodyRect } from './combat';
import { damagePlayer, stunEnemy } from './interactions';
import { overlaps, type Rect } from './math';
import { kekkaiSplits } from './level';
import { MAX_REWIND_TICKS } from './net/protocol';
import type { Enemy, Player, Projectile, World } from './types';

/** Taille de l'historique circulaire : H[S − MAX_REWIND_TICKS] … H[S]. */
const RING = MAX_REWIND_TICKS + 1;

/** Un tick enregistré : corps des ennemis et positions des projectiles ennemis (tableaux plats réutilisés). */
interface HistorySlot {
  tick: number;
  enemyIdx: Map<number, number>; // id → index dans enemyRects
  enemyRects: number[]; // x, y, w, h
  projIdx: Map<number, number>; // id → index dans projPos
  projPos: number[]; // x, y
}

/** Une attaque de mêlée ennemie (« une seule touche par attaque », comme Enemy.hitDone). */
interface Swing {
  done: boolean;
}

/** Frappe de mêlée enregistrée pour un jugement différé. */
interface Strike {
  tick: number; // tick du pas où la frappe a eu lieu
  box: Rect;
  dmg: number;
  srcX: number; // position de l'attaquant (côté de la parade)
  dir: number; // poussée de l'étourdissement si la frappe est parée
  stun: number | undefined; // durée d'étourdissement (undefined : valeur par défaut)
  enemy: Enemy;
  swing: Swing;
}

export interface NetCompensation {
  /** Retard courant de chaque joueur (ticks, 0..MAX_REWIND_TICKS), fixé par la session. */
  lag: Map<number, number>;
  /** Dernier tick (S − L) déjà jugé pour chaque joueur, en défense différée. */
  judged: Map<number, number>;
  ring: HistorySlot[];
  strikes: Strike[];
  swings: WeakMap<Enemy, Swing>;
  /**
   * Projectiles ennemis disparus contre un mur ou en fin de vie : encore jugés quelque temps pour
   * les joueurs en retard, qui les voyaient en vol (`tick` : tick de leur disparition).
   */
  ghosts: { a: Projectile; tick: number }[];
  /** Retard courant du joueur (0 si inconnu) ; équivaut à lagOf(net, pid). */
  lagOf(pid: number): number;
  /** Étape de l'historique : à chaque nouvelle étape, frappes et fantômes de l'ancienne sont oubliés. */
  stage: number;
}

export function createLagComp(): NetCompensation {
  const ring: HistorySlot[] = [];
  for (let i = 0; i < RING; i++) ring.push({ tick: -1, enemyIdx: new Map(), enemyRects: [], projIdx: new Map(), projPos: [] });
  const lag = new Map<number, number>();
  return { lag, judged: new Map(), ring, strikes: [], swings: new WeakMap(), ghosts: [], lagOf: (pid) => lag.get(pid) ?? 0, stage: -1 };
}

const clampLag = (l: number): number => (l > 0 ? Math.min(MAX_REWIND_TICKS, Math.floor(l)) : 0);

/** Fixe le retard d'un joueur (borné à 0..MAX_REWIND_TICKS). */
export function setLag(net: NetCompensation, pid: number, ticks: number): void {
  net.lag.set(pid, Number.isFinite(ticks) ? clampLag(ticks) : 0);
}

/** Retard courant du joueur (0 si inconnu). */
export function lagOf(net: NetCompensation, pid: number): number {
  return net.lag.get(pid) ?? 0;
}

/** Oublie un joueur parti. */
export function forgetPlayer(net: NetCompensation, pid: number): void {
  net.lag.delete(pid);
  net.judged.delete(pid);
}

function slotAt(net: NetCompensation, tick: number): HistorySlot | null {
  if (tick < 0) return null;
  const s = net.ring[tick % RING];
  return s.tick === tick ? s : null;
}

/** Corps de l'ennemi `id` enregistré au tick `tick` (null si inconnu). */
export function enemyRectAt(net: NetCompensation, id: number, tick: number): Rect | null {
  const s = slotAt(net, tick);
  const i = s?.enemyIdx.get(id);
  if (!s || i === undefined) return null;
  const r = s.enemyRects;
  return { x: r[i], y: r[i + 1], w: r[i + 2], h: r[i + 3] };
}

/** Position du projectile `id` enregistrée au tick `tick` (null si inconnue). */
export function projPosAt(net: NetCompensation, id: number, tick: number): { x: number; y: number } | null {
  const s = slotAt(net, tick);
  const i = s?.projIdx.get(id);
  if (!s || i === undefined) return null;
  return { x: s.projPos[i], y: s.projPos[i + 1] };
}

/**
 * Enregistre H[w.tick] : à appeler à la fin de chaque stepWorld (après w.tick++).
 * Purge aussi les frappes trop anciennes pour être encore jugées.
 */
export function recordHistory(w: World): void {
  const net = w.net;
  if (!net) return;
  if (net.stage !== w.level.stage) {
    // Nouvelle étape : rien de l'ancien niveau ne doit plus être jugé (coordonnées d'un autre décor).
    net.stage = w.level.stage;
    net.strikes.length = 0;
    net.ghosts.length = 0;
    for (const slot of net.ring) slot.tick = -1;
  }
  const s = net.ring[w.tick % RING];
  s.tick = w.tick;
  s.enemyIdx.clear();
  s.enemyRects.length = 0;
  for (const e of w.enemies) {
    if (e.state === 'dead') continue;
    s.enemyIdx.set(e.id, s.enemyRects.length);
    s.enemyRects.push(e.x - e.w / 2, e.y - e.h, e.w, e.h);
  }
  s.projIdx.clear();
  s.projPos.length = 0;
  for (const a of w.projectiles) {
    if (a.dead || a.owner !== 'enemy') continue;
    s.projIdx.set(a.id, s.projPos.length);
    s.projPos.push(a.x, a.y);
  }
  // Une frappe du pas k est jugée au plus tard au pas k + MAX_REWIND_TICKS.
  const oldest = w.tick - MAX_REWIND_TICKS;
  let n = 0;
  while (n < net.strikes.length && net.strikes[n].tick < oldest) n++;
  if (n) net.strikes.splice(0, n);
  if (net.ghosts.length) net.ghosts = net.ghosts.filter((g) => g.tick >= oldest);
}

/**
 * Projectiles ennemis que `p` peut trancher : ceux du monde et, s'il est en retard, les fantômes
 * encore en vol à son tick de vue (éteints sur le serveur, mais visibles sur son écran).
 * Sans `w.net` : exactement `w.projectiles`.
 */
export function sliceableProjectiles(w: World, p: Player): Projectile[] {
  const net = w.net;
  if (!net || !net.ghosts.length) return w.projectiles;
  const l = lagOf(net, p.id);
  if (l <= 0) return w.projectiles;
  const seen = w.tick - l;
  const extra = net.ghosts.filter((g) => g.tick >= seen && g.a.owner === 'enemy').map((g) => g.a);
  return extra.length ? w.projectiles.concat(extra) : w.projectiles;
}

/** `a` est-il un fantôme (projectile éteint encore jugeable) ? Toujours faux sans `w.net`. */
export function isGhost(w: World, a: Projectile): boolean {
  return !!w.net && w.net.ghosts.some((g) => g.a === a);
}

/** Un fantôme a été tranché (`revive` : renvoyé, il reprend vie) : il quitte la liste des fantômes. */
export function claimGhost(w: World, a: Projectile, revive: boolean): void {
  const net = w.net;
  if (!net) return;
  const i = net.ghosts.findIndex((g) => g.a === a);
  if (i < 0) return;
  net.ghosts.splice(i, 1);
  if (revive) {
    a.dead = false;
    // Il peut être encore dans w.projectiles (éteint ce pas-ci, pas encore filtré) : jamais en double.
    if (!w.projectiles.includes(a)) w.projectiles.push(a);
  }
}

/** Projectile ennemi éteint par le décor (mur, fin de vie) : gardé pour les joueurs en retard. */
export function keepGhost(w: World, a: Projectile): void {
  if (w.net && a.owner === 'enemy') w.net.ghosts.push({ a, tick: w.tick });
}

// ─── Attaque : corps rembobiné ──────────────────────────────────────────────

/**
 * Zone touchable de l'ennemi `e` pour une attaque de `attacker` : son corps au tick de vue
 * de l'attaquant (S − L). Sans `w.net`, avec L = 0 ou sans enregistrement : bodyRect(e).
 * Les dégâts et le recul s'appliquent toujours à l'ennemi actuel.
 */
export function hurtRect(w: World, attacker: Player, e: Enemy): Rect {
  const net = w.net;
  if (!net) return bodyRect(e);
  const l = lagOf(net, attacker.id);
  if (l <= 0) return bodyRect(e);
  return enemyRectAt(net, e.id, w.tick - l) ?? bodyRect(e);
}

/**
 * Position d'un projectile ennemi telle que `p` la voit, pendant la phase des joueurs
 * (avant le déplacement des projectiles de ce pas) : H[S − L]. Sert à trancher ou briser les flèches.
 */
export function projectileSeenBy(w: World, p: Player, a: Projectile): { x: number; y: number } {
  const net = w.net;
  if (!net || a.owner !== 'enemy') return a;
  const l = lagOf(net, p.id);
  if (l <= 0) return a;
  return projPosAt(net, a.id, w.tick - l) ?? a;
}

// ─── Défense : frappes ennemies différées ───────────────────────────────────

/**
 * Frappe de mêlée ennemie avec compensation (remplace meleeHit quand `w.net` existe).
 * Les joueurs sans retard sont jugés tout de suite, exactement comme sans compensation ;
 * pour les autres, la frappe est enregistrée et sera jugée par resolveDeferred.
 * `e.hitDone` sert ici à repérer le début d'une nouvelle attaque (il est remis à false à
 * chaque attaque) ; « une seule touche par attaque » est porté par le Swing associé.
 */
export function meleeStrike(w: World, net: NetCompensation, e: Enemy, box: Rect, dmg: number, stun: number | undefined): void {
  let sw = net.swings.get(e);
  if (!e.hitDone || !sw) {
    e.hitDone = true;
    sw = { done: false };
    net.swings.set(e, sw);
  }
  if (sw.done) return;
  let deferred = false;
  for (const p of w.players) {
    if (p.state === 'dead') continue;
    if (kekkaiSplits(w, e.x, p.x)) continue; // le sabre ne traverse pas le kekkai
    if (lagOf(net, p.id) > 0) {
      deferred = true;
      continue;
    }
    if (!overlaps(box, bodyRect(p))) continue;
    sw.done = true;
    if (damagePlayer(w, p, dmg, e.x) === 'parried') stunEnemy(w, e, -e.facing, stun);
    return;
  }
  if (deferred) net.strikes.push({ tick: w.tick, box: { ...box }, dmg, srcX: e.x, dir: -e.facing, stun, enemy: e, swing: sw });
}

/** L'ennemi est-il encore dans la partie (ni mort, ni condamné, ni retiré) ? */
const alive = (w: World, e: Enemy): boolean => e.state !== 'dead' && e.state !== 'doomed' && w.enemies.includes(e);

const projRect = (a: Projectile, x: number, y: number): Rect =>
  a.kind === 'wave' ? { x: x - 14, y: y - 26, w: 28, h: 52 } : { x: x - 6, y: y - 3, w: 12, h: 6 };

/**
 * Passe de défense différée, appelée par stepWorld juste après les ennemis et les projectiles.
 * Pour chaque joueur en retard (L > 0), juge contre son état actuel les frappes enregistrées
 * aux ticks (dernier jugé, S − L], et les projectiles ennemis à leurs positions de ces ticks.
 */
export function resolveDeferred(w: World): void {
  const net = w.net;
  if (!net) return;
  const S = w.tick;
  for (const p of w.players) {
    const l = lagOf(net, p.id);
    // L = 0 : le tick S est jugé immédiatement (meleeStrike, stepProjectiles) ; les ticks encore
    // en attente d'un retard précédent (from, S − 1] sont jugés ici, sans jamais être sautés.
    const to = l === 0 ? S - 1 : S - l;
    const prev = net.judged.get(p.id);
    // Jamais plus loin que l'historique (au retour d'un bilan ou d'une salle vide).
    // Premier passage : rien d'antérieur à juger (à L = 0, le tick courant l'est déjà immédiatement).
    const from = prev === undefined ? (l === 0 ? to : to - 1) : Math.max(prev, to - MAX_REWIND_TICKS - 1);
    if (l === 0) net.judged.set(p.id, S);
    if (to <= from) continue; // retard en hausse : ces ticks ont déjà été jugés
    if (l !== 0) net.judged.set(p.id, to);
    if (p.state === 'dead') continue;
    judgeStrikes(w, net, p, from, to);
    judgeProjectiles(w, net, p, from, to);
  }
}

function judgeStrikes(w: World, net: NetCompensation, p: Player, from: number, to: number): void {
  for (const st of net.strikes) {
    if (st.tick > to) break; // frappes rangées par tick croissant
    if (st.tick <= from || st.swing.done) continue;
    if (p.state === 'dead') return;
    if (kekkaiSplits(w, st.srcX, p.x) || !overlaps(st.box, bodyRect(p))) continue;
    // Attaquant tombé depuis (tué, condamné, retiré) : sa frappe n'a plus d'effet.
    if (!alive(w, st.enemy)) continue;
    st.swing.done = true;
    if (damagePlayer(w, p, st.dmg, st.srcX) === 'parried' && alive(w, st.enemy)) stunEnemy(w, st.enemy, st.dir, st.stun);
  }
}

function judgeProjectiles(w: World, net: NetCompensation, p: Player, from: number, to: number): void {
  for (const a of w.projectiles) {
    if (a.dead || a.owner !== 'enemy') continue;
    judgeProjectile(w, net, p, a, from, to);
    if (p.state === 'dead') return;
  }
  // Projectiles déjà éteints par le décor : seules leurs positions d'avant comptent (H[k + 1] absent ensuite).
  for (let i = 0; i < net.ghosts.length; i++) {
    const g = net.ghosts[i];
    if (g.a.owner !== 'enemy') continue;
    const res = judgeProjectile(w, net, p, g.a, from, to);
    if (res === 'none') continue;
    net.ghosts.splice(i--, 1);
    if (res === 'parried') {
      // Renvoyé : il reprend vie devant le joueur (jamais en double dans w.projectiles).
      g.a.dead = false;
      if (!w.projectiles.includes(g.a)) w.projectiles.push(g.a);
    }
    if (p.state === 'dead') return;
  }
}

/** Juge un projectile ennemi contre `p` à ses positions des ticks (from, to]. */
function judgeProjectile(w: World, net: NetCompensation, p: Player, a: Projectile, from: number, to: number): 'none' | 'parried' | 'hit' {
  if (a.hits.includes(p.id)) return 'none';
  // Position après le déplacement du pas k : H[k + 1].
  for (let k = from + 1; k <= to; k++) {
    const pos = projPosAt(net, a.id, k + 1);
    if (!pos || !overlaps(projRect(a, pos.x, pos.y), bodyRect(p))) continue;
    const res = damagePlayer(w, p, a.damage, pos.x - Math.sign(a.vx) * 40);
    if (res === 'parried') {
      // Renvoyé depuis l'endroit de la parade (devant le joueur), comme sans compensation.
      a.hits.push(p.id);
      a.owner = 'player';
      a.ownerId = p.id;
      a.x = p.x + p.facing * (p.w / 2 + 6);
      a.y = pos.y;
      a.vx = -a.vx * 1.3;
      a.vy = -60;
      a.life = 120;
      a.damage = 30;
      return 'parried';
    }
    if (res === 'hit') {
      a.hits.push(p.id);
      a.dead = true;
      return 'hit';
    }
    return 'none'; // ignoré (esquive, invulnérabilité) : il pourra toucher plus tard
  }
  return 'none';
}
