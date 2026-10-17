// Duels iaidō : face-à-face immobile, signal 斬 planifié à un tick serveur connu à l'avance,
// premier impact gagnant, parade, fautes, série au meilleur des trois manches.
// Module sans dépendance au mode coop : le dojo-tournoi (M5) le réutilise tel quel.
//
// Déroulé d'une manche (ticks serveur, ceux où les entrées sont consommées) :
//   enter (mise en place) → kamae (garde, signal publié) → open (dès le signal) → resolve → enter… → end.
// Les duellistes sont figés sur leurs marques : seuls p.state, p.stateT et p.iaiCharge portent
// l'animation, si bien que le client peut prédire son duelliste (stepDuelist) sur une copie du duel.
import { DUEL, DUEL_WHY, PLAYER as P, TILE } from './constants';
import { findGround } from './enemy';
import { BTN } from './input';
import { arenaInside, type Level } from './level';
import { fitsAt } from './physics';
import type { Duel, DuelSide, Player, PlayerState, World } from './types';

/** Duel du joueur `pid`, s'il en dispute un. */
export function duelOf(w: World, pid: number): Duel | undefined {
  const ds = w.duels;
  if (!ds || !ds.length) return undefined;
  for (const d of ds) if (d.a.pid === pid || d.b.pid === pid) return d;
  return undefined;
}

/** Le joueur `pid` dispute-t-il un duel ? (toujours faux en solo : `w.duels` absent) */
export function isDueling(w: World, pid: number): boolean {
  return duelOf(w, pid) !== undefined;
}

/**
 * Le signal 斬 est-il visible au tick `tick` ? Le client l'affiche à son tick prédit, qui est le
 * tick de consommation serveur de ses entrées : chaque joueur le voit au même tick de jeu.
 */
export function signalShown(d: Duel, tick: number): boolean {
  return d.sigTick >= 0 && tick >= d.sigTick && (d.phase === 'kamae' || d.phase === 'open');
}

// ─── Règles d'une série ─────────────────────────────────────────────────────

export interface DuelRules {
  firstTo: number; // manches à gagner (2 = BO3)
  maxRounds: number; // manches jouées au-delà desquelles on départage
  draw: boolean; // nul possible (coop) ; sinon mort subite (dojo)
}

/** Règles du duel consenti en coop : BO3, nul possible après MAX_ROUNDS manches jouées. */
export const COOP_DUEL_RULES: DuelRules = { firstTo: DUEL.FIRST_TO, maxRounds: DUEL.MAX_ROUNDS, draw: true };

// ─── Jugement d'un échange (fonction pure) ──────────────────────────────────

/** Ce qu'un duelliste a fait dans la manche (sous-ensemble de DuelSide). */
export interface ExchangeSide {
  foul: boolean; // première action consommée avant S + ANTICIPATE
  strikeT: number; // départ de la lame (impact à strikeT + STRIKE_TRAVEL), -1 si aucun
  parryT: number; // tick de la parade (garde sur [parryT, parryT + PARRY_ACTIVE]), -1 si aucune
}

/** Verdict d'une manche : `winner` 0 = côté a, 1 = côté b, -1 = manche rejouée. */
export interface ExchangeVerdict {
  winner: -1 | 0 | 1;
  why: number; // DUEL_WHY
}

/** Une action consommée au tick `t` est-elle une faute (signal au tick `sig`) ? */
export const isFoul = (sig: number, t: number): boolean => t < sig + DUEL.ANTICIPATE;

/**
 * Départ de la lame d'une frappe consommée au tick `t` : l'iai relâché part tout de suite,
 * une attaque sans charge SLASH_EXTRA ticks plus tard (impact = départ + STRIKE_TRAVEL).
 */
export const strikeStart = (t: number, slash: boolean): number => t + (slash ? DUEL.SLASH_EXTRA : 0);

/** Tick d'impact d'un départ de lame (-1 si aucune frappe). */
const impactOf = (strikeT: number): number => (strikeT >= 0 ? strikeT + DUEL.STRIKE_TRAVEL : -1);

/** La garde de `def` couvre-t-elle un impact au tick `i` ? */
const guards = (def: ExchangeSide, i: number): boolean => def.parryT >= 0 && i >= def.parryT && i <= def.parryT + P.PARRY_ACTIVE;

/**
 * Jugement d'une manche au tick `now`, signal au tick `sig` : verdict, ou null tant que rien
 * n'est tranché. Ne lit que des ticks déjà consommés ; appelé à chaque tick, il tranche :
 * - une faute dès qu'elle est commise (deux fautes au même tick : rejouée) ;
 * - une frappe parée à son impact (le défenseur gagne) ;
 * - une frappe qui porte à son impact + TIE_TICKS (deux impacts à ±TIE_TICKS : 相打ち, rejouée) ;
 * - personne n'a frappé à sig + ROUND_MAX : rejouée.
 */
export function judgeExchange(sig: number, a: ExchangeSide, b: ExchangeSide, now: number): ExchangeVerdict | null {
  if (a.foul || b.foul) {
    if (a.foul && b.foul) return { winner: -1, why: DUEL_WHY.DOUBLE_FOUL };
    return { winner: a.foul ? 1 : 0, why: DUEL_WHY.FOUL };
  }
  const ia = impactOf(a.strikeT);
  const ib = impactOf(b.strikeT);
  // Frappes parées : l'impact tombe dans la garde adverse (parade consommée au plus tard à l'impact).
  const pa = ia >= 0 && ia <= now && guards(b, ia);
  const pb = ib >= 0 && ib <= now && guards(a, ib);
  // Frappes qui portent : impact passé sans garde adverse.
  const la = ia >= 0 && ia <= now && !pa ? ia : -1;
  const lb = ib >= 0 && ib <= now && !pb ? ib : -1;
  const tp = pa && pb ? Math.min(ia, ib) : pa ? ia : pb ? ib : -1;
  const tl = la >= 0 && lb >= 0 ? Math.min(la, lb) : Math.max(la, lb);
  if (tp >= 0 && (tl < 0 || tp <= tl)) {
    if (pa && pb && ia === ib) return { winner: -1, why: DUEL_WHY.AIUCHI }; // deux parades croisées : rejouée
    return { winner: tp === ia && pa ? 1 : 0, why: DUEL_WHY.PARRY };
  }
  if (tl >= 0) {
    // Une frappe adverse peut encore tomber dans la fenêtre du 相打ち : on tranche à min(I) + TIE_TICKS.
    if (now < tl + DUEL.TIE_TICKS) return null;
    // L'autre impact (déjà connu : un départ de lame plus tardif tomberait hors de la fenêtre).
    const oa = la >= 0 ? la : ia;
    const ob = lb >= 0 ? lb : ib;
    if (oa >= 0 && ob >= 0 && Math.abs(oa - ob) <= DUEL.TIE_TICKS) return { winner: -1, why: DUEL_WHY.AIUCHI };
    if (la >= 0 && (lb < 0 || la < lb)) return { winner: 0, why: DUEL_WHY.IPPON };
    return { winner: 1, why: DUEL_WHY.IPPON };
  }
  if (a.strikeT < 0 && b.strikeT < 0 && now >= sig + DUEL.ROUND_MAX) return { winner: -1, why: DUEL_WHY.TIMEOUT };
  return null;
}

/**
 * Issue de la série après une manche, ou null si elle continue. `sums` : sommes des réactions
 * (départage de la mort subite plafonnée), si connues.
 */
export function seriesOutcome(d: Duel, sums?: [number, number]): { winner: number; why: number } | null {
  const wa = d.a.wins;
  const wb = d.b.wins;
  const lead = wa > wb ? d.a.pid : d.b.pid;
  if (wa >= d.firstTo || wb >= d.firstTo) return { winner: lead, why: DUEL_WHY.WIN };
  if (d.played < d.maxRounds) return null;
  if (wa !== wb) return { winner: lead, why: DUEL_WHY.WIN };
  if (d.draw) return { winner: -1, why: DUEL_WHY.DRAW };
  if (d.played < DUEL.SUDDEN_MAX) return null; // mort subite
  // Mort subite plafonnée : la plus petite somme des réactions l'emporte.
  if (sums && sums[0] !== sums[1]) return { winner: sums[0] < sums[1] ? d.a.pid : d.b.pid, why: DUEL_WHY.WIN };
  return { winner: -1, why: DUEL_WHY.DRAW };
}

/** Durée de la garde de la manche : hachage déterministe de (id, manches jouées), sans w.rng. */
export function kamaeLength(id: number, played: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((played + 0x632be5ab) | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return DUEL.KAMAE_MIN + ((h >>> 0) % (DUEL.KAMAE_MAX - DUEL.KAMAE_MIN + 1));
}

// ─── Emplacement ────────────────────────────────────────────────────────────

/**
 * Sol plat pour un duel autour de (x, y) : les deux marques à ±gap/2 du centre ont un sol à la
 * même hauteur, rien ne bloque un corps le long du segment, et aucune n'est dans l'arène.
 * Balayage du centre par tuiles jusqu'à ±SPOT_SCAN_TILES, au plus près d'abord. null si rien ne convient.
 */
export function findDuelSpot(level: Level, x: number, y: number, gap: number, avoid: readonly Duel[] = []): { x: number; y: number } | null {
  // Un duel en cours à éviter peut demander de s'écarter d'un segment entier.
  const scan = DUEL.SPOT_SCAN_TILES + (avoid.length ? Math.ceil((gap + 2 * P.W) / TILE) : 0);
  for (let k = 0; k <= scan; k++) {
    for (const s of k === 0 ? [0] : [1, -1]) {
      const cx = x + s * k * TILE;
      const x0 = cx - gap / 2;
      const x1 = cx + gap / 2;
      if (x0 < TILE || x1 > level.pxW - TILE) continue;
      if (arenaInside(level, x0) || arenaInside(level, x1)) continue;
      // Ni dans ni contre la colonne du kekkai (une tuile de marge) : une arène fermée pendant le duel
      // ne doit pas enfermer un duelliste dans la barrière.
      const kL = (level.arena.col - 1) * TILE - P.W / 2;
      const kR = (level.arena.col + 2) * TILE + P.W / 2;
      if (x1 > kL && x0 < kR) continue;
      // Pas sur le segment d'un duel en cours (une largeur de corps de marge, même hauteur).
      if (avoid.some((o) => Math.abs(o.y - y) < 2 * TILE && x1 + P.W > o.x - o.gap / 2 && x0 - P.W < o.x + o.gap / 2)) continue;
      // Sol à la hauteur des joueurs (jamais le toit d'un bloc au-dessus d'eux).
      const g0 = findGround(level, x0, y, 1);
      if (g0 === null || Math.abs(g0 - y) > TILE || findGround(level, x1, y, 1) !== g0) continue;
      let clear = true;
      for (let px = x0; px < x1 + 2; px += 4) {
        if (!fitsAt(level, Math.min(px, x1), g0, P.W, P.H)) {
          clear = false;
          break;
        }
      }
      if (clear) return { x: cx, y: g0 };
    }
  }
  return null;
}

// ─── Démarrage ──────────────────────────────────────────────────────────────

/** Sommes des réactions par duel (départage de la mort subite) : état serveur, hors instantané. */
const reactSums = new WeakMap<Duel, [number, number]>();

const emptySide = (pid: number): DuelSide => ({ pid, wins: 0, strikeT: -1, parryT: -1, foul: false, react: -1 });

/** Joueur en état de croiser le fer : vivant (ni mort ni à 0 PV) et encore dans la partie. */
const standing = (p: Player): boolean => p.state !== 'dead' && p.hp > 0 && !p.out;

function resetRound(d: Duel): void {
  for (const s of [d.a, d.b]) {
    s.strikeT = -1;
    s.parryT = -1;
    s.foul = false;
    s.react = -1;
  }
  d.sigTick = -1;
}

/**
 * Engage un duel entre `a` et `b` (public : le dojo de M5 l'appelle). `spot` : centre au sol ;
 * par défaut, un sol plat autour du point médian (findDuelSpot). Le joueur de gauche devient le
 * côté a. Renvoie null (sans rien changer) si aucun emplacement ne convient, si l'un se bat déjà, est
 * mort ou est sorti de la partie (la pose du duel ne doit jamais relever un mort).
 */
export function startDuel(w: World, a: Player, b: Player, rules: DuelRules, spot?: { x: number; y: number }): Duel | null {
  if (a === b || isDueling(w, a.id) || isDueling(w, b.id) || !standing(a) || !standing(b)) return null;
  const at = spot ?? findDuelSpot(w.level, (a.x + b.x) / 2, (a.y + b.y) / 2, DUEL.GAP, w.duels ?? []);
  if (!at) return null;
  const [l, r] = a.x <= b.x ? [a, b] : [b, a];
  const d: Duel = {
    id: w.nextId++,
    a: emptySide(l.id),
    b: emptySide(r.id),
    x: at.x,
    y: at.y,
    gap: DUEL.GAP,
    phase: 'enter',
    t: 0,
    round: 1,
    played: 0,
    sigTick: -1,
    stage: w.level.stage,
    last: -1,
    winner: -1,
    firstTo: rules.firstTo,
    maxRounds: rules.maxRounds,
    draw: rules.draw,
  };
  (w.duels ??= []).push(d);
  reactSums.set(d, [0, 0]);
  for (const p of [l, r]) {
    p.attack = null;
    p.queued = false;
    p.chainNext = null;
    p.iaiCharge = 0;
    p.freeze = 0;
    p.jumpBuffer = p.attackBuffer = p.parryBuffer = p.dashBuffer = p.downBuffer = 0;
    p.jumpHeld = false;
    setPose(p, 'normal');
    holdMark(d, p);
  }
  w.events.push({ type: 'duelStart', id: d.id, a: d.a.pid, b: d.b.pid });
  return d;
}

// ─── Duelliste (prédictible : ne dépend que de w.tick, d et p) ──────────────

function setPose(p: Player, s: PlayerState): void {
  if (p.state === s) return;
  p.state = s;
  p.stateT = 0;
  if (s !== 'attack') p.attack = null;
}

/** Le duelliste reste sur sa marque, face à l'adversaire. */
function holdMark(d: Duel, p: Player): void {
  const left = d.a.pid === p.id;
  p.x = d.x + (left ? -d.gap / 2 : d.gap / 2);
  p.y = d.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = true;
  p.facing = left ? 1 : -1;
  p.h = P.H;
  p.crouch = false;
  p.wallDir = 0;
  p.lock = 0;
}

/**
 * Un pas d'un duelliste (appelé par stepPlayer au lieu de la machine à états habituelle).
 * Ne dépend que de w.tick, du duel `d` et de l'état de `p` : le client le rejoue sur une copie
 * jetable du duel. Enregistre strikeT / parryT / foul / react dans le DuelSide. Renvoie true.
 */
export function stepDuelist(w: World, d: Duel, p: Player, buttons: number, pressed: number): boolean {
  const side = d.a.pid === p.id ? d.a : d.b;
  holdMark(d, p);
  p.freeze = 0;
  p.stateT++;
  switch (d.phase) {
    case 'enter':
    case 'end':
      setPose(p, 'normal');
      p.iaiCharge = 0;
      break;
    case 'resolve':
      setPose(p, d.winner === p.id ? 'iaiStrike' : d.winner >= 0 ? 'hurt' : 'normal');
      break;
    case 'kamae':
    case 'open':
      duelAct(w, d, side, p, buttons, pressed);
      break;
  }
  return true;
}

/** Actions pendant la garde et après le signal (constantes de base : améliorations ignorées). */
function duelAct(w: World, d: Duel, side: DuelSide, p: Player, buttons: number, pressed: number): void {
  // Engagé : la pose tient jusqu'au dénouement. La pose suffit aussi à le savoir : le prédicteur
  // repart à chaque pas de la copie du duel reçue du serveur, sans les actions déjà prédites.
  if (side.strikeT >= 0 || side.foul || p.state === 'iaiStrike' || p.state === 'attack') return;
  if (p.state === 'parry') {
    if (p.stateT >= P.PARRY_ACTIVE + P.PARRY_RECOVERY) setPose(p, 'normal'); // retour en kamae
    return;
  }
  const first = side.parryT < 0;
  const act = (): boolean => {
    if (first) {
      side.react = w.tick - d.sigTick;
      if (isFoul(d.sigTick, w.tick)) side.foul = true;
    }
    return side.foul;
  };
  if (pressed & BTN.PARRY && side.parryT < 0) {
    if (!act()) side.parryT = w.tick;
    p.parryTick = w.tick;
    p.iaiCharge = 0;
    setPose(p, 'parry');
    return;
  }
  const charged = p.state === 'iaiCharge' && p.iaiCharge >= P.IAI_MIN_CHARGE;
  if (pressed & BTN.ATTACK) {
    // Attaque : iai déjà chargé = frappe d'iai ; sinon coupe ordinaire, plus lente.
    if (!act()) side.strikeT = strikeStart(w.tick, !charged);
    if (charged) iaiPose(p);
    else {
      setPose(p, 'attack');
      p.attack = 'slash1';
    }
    return;
  }
  if (p.state === 'iaiCharge') {
    if (!(buttons & BTN.IAI)) {
      if (charged) {
        if (!act()) side.strikeT = strikeStart(w.tick, false);
        iaiPose(p);
      } else {
        p.iaiCharge = 0;
        setPose(p, 'normal'); // pas assez chargé : rien
      }
      return;
    }
    const before = p.iaiCharge;
    p.iaiCharge += 1;
    if (before < P.IAI_FULL_CHARGE && p.iaiCharge >= P.IAI_FULL_CHARGE) w.events.push({ type: 'iaiReady', x: p.x, y: p.y - 30, pid: p.id });
    return;
  }
  if (buttons & BTN.IAI) {
    setPose(p, 'iaiCharge');
    p.iaiCharge = 0;
    w.events.push({ type: 'iaiStart', pid: p.id });
  }
}

function iaiPose(p: Player): void {
  p.iaiFull = p.iaiCharge >= P.IAI_FULL_CHARGE;
  p.iaiFrom = p.x;
  p.iaiTo = p.x;
  setPose(p, 'iaiStrike');
}

// ─── Machine des manches (serveur) ──────────────────────────────────────────

/** Délai entre deux défis d'une même paire (remplace un délai existant). */
export function setPairCooldown(w: World, a: number, b: number, ticks: number): void {
  const list = w.duelInvites;
  if (!list) return;
  w.duelInvites = list.filter((i) => !(i.cd && ((i.from === a && i.to === b) || (i.from === b && i.to === a))));
  w.duelInvites.push({ from: a, to: b, until: w.tick + ticks, cd: true });
}

/** Phases, jugement, série et événements de tous les duels (après les joueurs). */
export function stepDuels(w: World): void {
  const ds = w.duels;
  if (!ds || !ds.length) return;
  for (const d of ds.slice()) {
    if (d.stage !== w.level.stage) {
      endNow(w, d, -1, DUEL_WHY.INTERRUPT);
      continue;
    }
    // Un duelliste disparu sans removePlayer : forfait.
    const gone = [d.a, d.b].find((s) => !w.players.some((p) => p.id === s.pid));
    if (gone && d.phase !== 'end') forfeit(w, gone.pid, DUEL_WHY.DISCONNECT);
    d.t++;
    switch (d.phase) {
      case 'enter':
        if (d.t >= DUEL.ENTER_TICKS) {
          resetRound(d);
          d.phase = 'kamae';
          d.t = 0;
          // Signal publié dès l'entrée en garde ; la garde commence au tick suivant.
          d.sigTick = w.tick + 1 + kamaeLength(d.id, d.played);
        }
        break;
      case 'kamae':
      case 'open': {
        const v = judgeExchange(d.sigTick, d.a, d.b, w.tick);
        if (v) endRound(w, d, v);
        else if (d.phase === 'kamae' && w.tick + 1 >= d.sigTick) {
          d.phase = 'open';
          d.t = 0;
        }
        break;
      }
      case 'resolve':
        if (d.t >= DUEL.RESOLVE_TICKS) {
          const out = seriesOutcome(d, reactSums.get(d));
          if (out) {
            d.phase = 'end';
            d.t = 0;
            d.winner = out.winner;
            d.last = out.why;
            w.events.push({ type: 'duelEnd', id: d.id, winner: out.winner, wa: d.a.wins, wb: d.b.wins, why: out.why });
          } else {
            resetRound(d);
            d.phase = 'enter';
            d.t = 0;
            d.winner = -1;
          }
        }
        break;
      case 'end':
        if (d.t >= DUEL.END_TICKS) release(w, d);
        break;
    }
  }
}

function endRound(w: World, d: Duel, v: ExchangeVerdict): void {
  const ws = v.winner === 0 ? d.a : v.winner === 1 ? d.b : null;
  const round = d.round;
  d.played++;
  if (ws) {
    ws.wins++;
    d.round++;
  }
  d.winner = ws ? ws.pid : -1;
  d.last = v.why;
  d.phase = 'resolve';
  d.t = 0;
  const sums = reactSums.get(d);
  if (sums) {
    // Sans action (ou faute) : la manche compte pour ROUND_MAX.
    sums[0] += d.a.react >= 0 && !d.a.foul ? d.a.react : DUEL.ROUND_MAX;
    sums[1] += d.b.react >= 0 && !d.b.foul ? d.b.react : DUEL.ROUND_MAX;
  }
  w.events.push({
    type: 'duelRound', id: d.id, round, winner: d.winner, why: v.why,
    ra: d.a.react, rb: d.b.react, wa: d.a.wins, wb: d.b.wins,
  });
}

/** Fin de série : retrait du duel, joueurs libérés (brève invulnérabilité), délai pour la paire. */
function release(w: World, d: Duel): void {
  if (w.duels) w.duels = w.duels.filter((x) => x !== d);
  reactSums.delete(d);
  for (const s of [d.a, d.b]) {
    const p = w.players.find((q) => q.id === s.pid);
    if (!p) continue;
    setPose(p, 'normal');
    p.stateT = 0;
    p.iaiCharge = 0;
    p.vx = 0;
    p.vy = 0;
    p.iframes = Math.max(p.iframes, DUEL.END_IFRAMES);
  }
  setPairCooldown(w, d.a.pid, d.b.pid, DUEL.AFTER_COOLDOWN);
}

/**
 * Série déjà décidée par la manche en cours de dénouement : son issue (WIN ou DRAW) est acquise avant
 * la fin de l'animation, et ni un abandon ni une interruption ne la renversent. null sinon.
 */
function decided(d: Duel): { winner: number; why: number } | null {
  return d.phase === 'resolve' ? seriesOutcome(d, reactSums.get(d)) : null;
}

/** Fin immédiate (sans phase end) : interruption au passage d'étape (une série décidée garde son issue). */
function endNow(w: World, d: Duel, winner: number, why: number): void {
  const out = decided(d) ?? { winner, why };
  if (d.phase !== 'end') w.events.push({ type: 'duelEnd', id: d.id, winner: out.winner, wa: d.a.wins, wb: d.b.wins, why: out.why });
  d.winner = out.winner;
  d.last = out.why;
  release(w, d);
}

/**
 * Le joueur `pid` quitte son duel : abandon (FORFEIT), déconnexion (DISCONNECT) ou entrées trop rapides
 * (FLOOD), l'autre gagne la série ; INTERRUPT : sans résultat. Le duel passe en phase end (sans effet
 * s'il y est déjà). Pendant le dénouement de la manche qui a décidé la série, c'est son issue qui est émise.
 */
export function forfeit(w: World, pid: number, why: number): void {
  const d = duelOf(w, pid);
  if (!d || d.phase === 'end') return;
  const out = decided(d) ?? { winner: why === DUEL_WHY.INTERRUPT ? -1 : d.a.pid === pid ? d.b.pid : d.a.pid, why };
  d.phase = 'end';
  d.t = 0;
  d.winner = out.winner;
  d.last = out.why;
  w.events.push({ type: 'duelEnd', id: d.id, winner: out.winner, wa: d.a.wins, wb: d.b.wins, why: out.why });
}

/**
 * Passage d'étape (bilan, étape suivante) : tous les duels s'arrêtent sans résultat (hors série déjà
 * décidée) et les défis en attente tombent. Sans effet en solo.
 */
export function interruptDuels(w: World): void {
  if (w.duels) for (const d of w.duels.slice()) endNow(w, d, -1, DUEL_WHY.INTERRUPT);
  if (w.duelInvites) {
    for (const i of w.duelInvites) if (!i.cd) w.events.push({ type: 'duelCancel', from: i.from, to: i.to, why: DUEL_WHY.INTERRUPT });
    w.duelInvites = w.duelInvites.filter((i) => i.cd);
  }
}

// ─── Abandon par appui tenu ─────────────────────────────────────────────────

/** Durée d'appui de DUEL par duelliste (état serveur, hors instantané). */
const holds = new WeakMap<World, Map<number, number>>();

/**
 * Abandon : DUEL tenu FORFEIT_HOLD ticks pendant un duel. L'appui doit commencer pendant le duel
 * (le bouton encore tenu depuis l'acceptation ne compte pas). À appeler avant les joueurs.
 * Seules les entrées reçues comptent : pendant une famine (w.starved, masque répété par la session),
 * le compteur est en pause, ni compté ni remis à zéro.
 */
export function stepForfeits(w: World, inputs: Map<number, number>): void {
  if (!w.duels) return;
  let m = holds.get(w);
  if (!w.duels.length) {
    if (m && m.size) m.clear();
    return;
  }
  if (!m) holds.set(w, (m = new Map()));
  for (const p of w.players) {
    const d = duelOf(w, p.id);
    if (!d || d.phase === 'end') {
      m.delete(p.id);
      continue;
    }
    if (w.starved && w.starved.includes(p.id)) continue;
    const b = inputs.get(p.id) ?? 0;
    const n = m.get(p.id) ?? 0;
    const held = (b & BTN.DUEL) !== 0;
    const fresh = held && !(p.prevButtons & BTN.DUEL);
    const next = held && (n > 0 || fresh) ? n + 1 : 0;
    m.set(p.id, next);
    if (next >= DUEL.FORFEIT_HOLD) {
      m.delete(p.id);
      forfeit(w, p.id, DUEL_WHY.FORFEIT);
    }
  }
}
