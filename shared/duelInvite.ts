// Défis de duel en coop : défier, accepter, annuler, délais par paire.
// Exécuté par stepWorld avant les joueurs, en coop seulement (jamais en solo).
import { DUEL, DUEL_WHY, TILE } from './constants';
import { COOP_DUEL_RULES, findDuelSpot, isDueling, setPairCooldown, startDuel } from './duel';
import { BTN } from './input';
import { arenaInside, kekkaiSplits } from './level';
import { isAway } from './stage';
import type { DuelInvite, Player, World } from './types';

/** Joueur touché ou mort : un défi en cours qui le concerne tombe. */
const hitOrDead = (p: Player): boolean => p.state === 'dead' || p.state === 'hurt';

const dist = (a: Player, b: Player): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Défi en attente (pas un délai) reçu par `pid`. */
const incomingOf = (list: DuelInvite[], pid: number): DuelInvite | undefined => list.find((i) => !i.cd && i.to === pid);
/** Défi en attente lancé par `pid`. */
const outgoingOf = (list: DuelInvite[], pid: number): DuelInvite | undefined => list.find((i) => !i.cd && i.from === pid);

/** Délai actif entre `a` et `b` (dans un sens ou dans l'autre) ? */
export function pairCooling(w: World, a: number, b: number): boolean {
  const list = w.duelInvites;
  if (!list) return false;
  return list.some((i) => i.cd && w.tick < i.until && ((i.from === a && i.to === b) || (i.from === b && i.to === a)));
}

/** Un ennemi engagé (poursuite, préparation, attaque) est-il à moins de ENGAGED_RANGE de `p` ? */
function engaged(w: World, p: Player): boolean {
  for (const e of w.enemies) {
    if (e.state !== 'chase' && e.state !== 'windup' && e.state !== 'attack') continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) < DUEL.ENGAGED_RANGE) return true;
  }
  return false;
}

/** Le joueur peut-il prendre part à un défi (vivant, présent, libre) ? */
function free(w: World, p: Player): boolean {
  return p.state !== 'dead' && !p.out && !isAway(w, p.id) && !isDueling(w, p.id);
}

/** Conditions de la salle et du terrain pour qu'un duel s'engage entre `a` et `b`. */
export function duelAllowed(w: World, a: Player, b: Player): boolean {
  if (w.stage.state !== 'playing' || w.wave.phase !== 'calm') return false;
  if (arenaInside(w.level, a.x) || arenaInside(w.level, b.x) || kekkaiSplits(w, a.x, b.x)) return false;
  return !engaged(w, a) && !engaged(w, b);
}

/**
 * Cible d'un défi lancé par `a` : le joueur éligible le plus proche dans la direction où `a`
 * regarde, sinon le plus proche, à moins de INVITE_RANGE. null si personne.
 */
export function inviteTarget(w: World, a: Player): Player | null {
  const list = w.duelInvites ?? [];
  let ahead: Player | null = null;
  let any: Player | null = null;
  let da = Infinity;
  let dn = Infinity;
  for (const q of w.players) {
    if (q === a || !free(w, q) || hitOrDead(q) || incomingOf(list, q.id) || pairCooling(w, a.id, q.id)) continue;
    if (kekkaiSplits(w, a.x, q.x)) continue;
    const d = dist(a, q);
    if (d > DUEL.INVITE_RANGE) continue;
    if (d < dn) {
      dn = d;
      any = q;
    }
    if (Math.sign(q.x - a.x) !== -a.facing && d < da) {
      da = d;
      ahead = q;
    }
  }
  return ahead ?? any;
}

function drop(w: World, inv: DuelInvite): void {
  if (w.duelInvites) w.duelInvites = w.duelInvites.filter((i) => i !== inv);
}

/** Retire un défi en attente avec son motif ; `cooldown` : la paire est ensuite bloquée PAIR_COOLDOWN ticks. */
function cancel(w: World, inv: DuelInvite, why: number, cooldown: boolean): void {
  drop(w, inv);
  w.events.push({ type: 'duelCancel', from: inv.from, to: inv.to, why });
  if (cooldown) setPairCooldown(w, inv.from, inv.to, DUEL.PAIR_COOLDOWN);
}

/** Un joueur quitte la salle : ses défis en attente tombent, ses délais sont oubliés. */
export function forgetInvites(w: World, pid: number): void {
  const list = w.duelInvites;
  if (!list) return;
  for (const i of list) if (!i.cd && (i.from === pid || i.to === pid)) w.events.push({ type: 'duelCancel', from: i.from, to: i.to, why: DUEL_WHY.DISCONNECT });
  w.duelInvites = list.filter((i) => i.from !== pid && i.to !== pid);
}

/** `b` accepte le défi `inv` de `a` : le duel démarre sur un sol plat autour du point médian. */
function accept(w: World, inv: DuelInvite, a: Player, b: Player): void {
  // Conditions revérifiées : si elles ne sont plus réunies, l'appui est sans effet (le défi attend).
  if (!free(w, a) || !free(w, b) || !duelAllowed(w, a, b)) return;
  // Joueurs à la même hauteur (pas l'un sur une corniche au-dessus de l'autre).
  if (Math.abs(a.y - b.y) > TILE) {
    cancel(w, inv, DUEL_WHY.TERRAIN, false);
    return;
  }
  const spot = findDuelSpot(w.level, (a.x + b.x) / 2, (a.y + b.y) / 2, DUEL.GAP, w.duels ?? []);
  if (!spot) {
    cancel(w, inv, DUEL_WHY.TERRAIN, false);
    return;
  }
  drop(w, inv);
  // Les autres défis en attente des deux duellistes tombent.
  for (const o of (w.duelInvites ?? []).slice()) {
    if (!o.cd && (o.from === a.id || o.to === a.id || o.from === b.id || o.to === b.id)) cancel(w, o, DUEL_WHY.CANCEL, false);
  }
  startDuel(w, a, b, COOP_DUEL_RULES, spot);
}

/** `a` lance un défi (si les conditions sont réunies et qu'une cible est à portée). */
function challenge(w: World, a: Player): void {
  if (!free(w, a) || hitOrDead(a)) return;
  const b = inviteTarget(w, a);
  if (!b || !duelAllowed(w, a, b)) return;
  w.duelInvites!.push({ from: a.id, to: b.id, until: w.tick + DUEL.INVITE_TICKS, cd: false });
  w.events.push({ type: 'duelInvite', from: a.id, to: b.id });
}

/**
 * Défis de la salle, avant les joueurs (p.prevButtons est encore l'entrée du tick précédent) :
 * échéances, ruptures, puis appuis sur DUEL (accepter, annuler ou défier).
 */
export function stepInvites(w: World, inputs: Map<number, number>): void {
  const list = (w.duelInvites ??= []);
  // Délais échus purgés ; défis rompus ou expirés.
  if (list.length) {
    for (const inv of list.slice()) {
      if (inv.cd) {
        if (w.tick >= inv.until) drop(w, inv);
        continue;
      }
      const a = w.players.find((p) => p.id === inv.from);
      const b = w.players.find((p) => p.id === inv.to);
      if (!a || !b) cancel(w, inv, DUEL_WHY.DISCONNECT, false);
      // La Marée se lève : le défi ne pourrait plus être accepté (sans délai de paire).
      else if (w.wave.phase !== 'calm') cancel(w, inv, DUEL_WHY.TIDE, false);
      else if (hitOrDead(a) || hitOrDead(b)) cancel(w, inv, DUEL_WHY.HIT, false);
      else if (dist(a, b) > DUEL.INVITE_BREAK) cancel(w, inv, DUEL_WHY.DISTANCE, true);
      else if (w.tick >= inv.until) cancel(w, inv, DUEL_WHY.EXPIRED, true);
    }
  }
  for (const p of w.players) {
    const b = inputs.get(p.id) ?? 0;
    if (!(b & BTN.DUEL) || p.prevButtons & BTN.DUEL) continue; // front montant seulement
    if (isDueling(w, p.id)) continue; // en duel : tenir DUEL pour abandonner (stepForfeits)
    const cur = w.duelInvites!;
    const inc = incomingOf(cur, p.id);
    const out = outgoingOf(cur, p.id);
    // Son propre défi en cours d'abord : l'appui l'annule (un second appui acceptera un défi reçu),
    // sauf s'il vise justement celui qui nous défie (défis croisés = acceptation mutuelle).
    if (out && !(inc && inc.from === out.to)) {
      cancel(w, out, DUEL_WHY.CANCEL, true);
      continue;
    }
    if (inc) {
      // Accepter (y compris un appui simultané : le défi de l'autre vient d'être lancé ce tick).
      const from = w.players.find((q) => q.id === inc.from);
      if (from) accept(w, inc, from, p);
      continue;
    }
    challenge(w, p);
  }
}
