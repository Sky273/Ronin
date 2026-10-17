// Tests de la simulation des duels iaidō (jugement, manches, invitations, immunité).
// Lancer : npm run test:duel
import { DUEL, DUEL_WHY, PLAYER, TILE } from '../shared/constants';
import {
  duelOf, type DuelRules, type ExchangeSide, findDuelSpot, forfeit, isFoul, judgeExchange, kamaeLength, startDuel, stepDuelist, strikeStart,
} from '../shared/duel';
import { pairCooling } from '../shared/duelInvite';
import { findGround, spawnEnemy, targetPlayer } from '../shared/enemy';
import { BTN } from '../shared/input';
import { damagePlayer, killEnemy } from '../shared/interactions';
import { createLagComp, setLag } from '../shared/lagcomp';
import { arenaInside, T_EMPTY, T_SOLID, type Level } from '../shared/level';
import { fitsAt } from '../shared/physics';
import type { DifficultyId } from '../shared/difficulty';
import type { Duel, EnemyState, EnemyType, GameEvent, Player, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, removePlayer, stepWorld, warpToArena } from '../shared/world';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const W = DUEL_WHY;

// ─── Outils ─────────────────────────────────────────────────────────────────

type Script = (w: World, p: Player) => number;

/** Salle coop calme : aucun ennemi, aucun renfort, Marée figée en accalmie. */
function quiet(w: World): void {
  w.enemies = [];
  w.projectiles = [];
  w.spawnTimer = 1e9;
  w.wave.phase = 'calm';
  w.wave.t = 0;
}

/** Monde coop à n joueurs, tous posés au sol près d'un sol plat (centre renvoyé). */
function coopWorld(n: number, seed = 5): { w: World; ps: Player[]; cx: number; gy: number } {
  const w = createWorld(seed, { mode: 'coop', difficulty: 'normal' });
  const ps: Player[] = [];
  for (let i = 0; i < n; i++) ps.push(addPlayer(w, 'p' + i, { color: i }));
  quiet(w);
  const spot = findDuelSpot(w.level, w.level.spawn.x + 300, w.level.spawn.y, DUEL.GAP)!;
  for (const p of ps) {
    p.iframes = 0;
    put(w, p, spot.x);
  }
  return { w, ps, cx: spot.x, gy: spot.y };
}

function put(w: World, p: Player, x: number): void {
  p.x = x;
  // Sol à hauteur des pieds (pas le dessus d'un bloc voisin), sinon le plus proche au-dessus.
  p.y = findGround(w.level, x, p.y, 1) ?? findGround(w.level, x, p.y, 12) ?? p.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = true;
}

/** Avance d'un tick ; renvoie les événements produits. */
function tick(w: World, script: Script = () => 0, keepQuiet = true): GameEvent[] {
  const m = new Map<number, number>();
  for (const p of w.players) m.set(p.id, script(w, p));
  stepWorld(w, m);
  if (keepQuiet) quiet(w);
  const ev = w.events.slice();
  w.events.length = 0;
  return ev;
}

function run(w: World, n: number, script: Script = () => 0, keepQuiet = true): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...tick(w, script, keepQuiet));
  return out;
}

/** Avance jusqu'à la fin du duel `d` (retiré de w.duels) ; renvoie les événements. */
function runDuel(w: World, d: Duel, script: Script, max = 20000): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < max && w.duels!.includes(d); i++) out.push(...tick(w, script));
  return out;
}

/** Plan d'un duelliste pour une manche : action et décalage par rapport au signal. */
type Plan = { kind: 'none' } | { kind: 'iai' | 'attack' | 'parry'; at: number };
const none: Plan = { kind: 'none' };
const iai = (at: number): Plan => ({ kind: 'iai', at });
const attack = (at: number): Plan => ({ kind: 'attack', at });
const parry = (at: number): Plan => ({ kind: 'parry', at });

/**
 * Script de duel : pour chaque manche jouée (d.played), le plan de chaque côté.
 * iai : IAI tenu dès la garde puis relâché au tick sig + at ; attack / parry : appui au tick sig + at.
 */
function duelScript(plans: (pid: number, played: number) => Plan): Script {
  return (w, p) => {
    const d = duelOf(w, p.id);
    if (!d || (d.phase !== 'kamae' && d.phase !== 'open')) return 0;
    const plan = plans(p.id, d.played);
    const t = w.tick - d.sigTick;
    switch (plan.kind) {
      case 'none': return 0;
      case 'iai': return t < plan.at ? BTN.IAI : 0;
      case 'attack': return t === plan.at ? BTN.ATTACK : 0;
      case 'parry': return t === plan.at ? BTN.PARRY : 0;
    }
  };
}

const rounds = (ev: GameEvent[]) => ev.filter((e): e is Extract<GameEvent, { type: 'duelRound' }> => e.type === 'duelRound');
const ends = (ev: GameEvent[]) => ev.filter((e): e is Extract<GameEvent, { type: 'duelEnd' }> => e.type === 'duelEnd');
const cancels = (ev: GameEvent[]) => ev.filter((e): e is Extract<GameEvent, { type: 'duelCancel' }> => e.type === 'duelCancel');
const invites = (ev: GameEvent[]) => ev.filter((e): e is Extract<GameEvent, { type: 'duelInvite' }> => e.type === 'duelInvite');

/** Engage un duel coop entre deux joueurs (sol plat trouvé autour d'eux). */
function duel(w: World, a: Player, b: Player, rules: DuelRules = { firstTo: DUEL.FIRST_TO, maxRounds: DUEL.MAX_ROUNDS, draw: true }): Duel {
  const d = startDuel(w, a, b, rules);
  if (!d) throw new Error('aucun emplacement de duel');
  w.events.length = 0;
  return d;
}

// ─── 1. judgeExchange : table ───────────────────────────────────────────────
{
  const S = 1000;
  const T = DUEL.STRIKE_TRAVEL;
  const side = (o: Partial<ExchangeSide> = {}): ExchangeSide => ({ foul: false, strikeT: -1, parryT: -1, ...o });
  const iaiAt = (t: number) => side({ strikeT: strikeStart(t, false) });
  const slashAt = (t: number) => side({ strikeT: strikeStart(t, true) });
  /** Premier verdict rendu en avançant le tick de jugement, et son tick. */
  const first = (a: ExchangeSide, b: ExchangeSide) => {
    for (let now = S - 300; now < S + DUEL.ROUND_MAX + 100; now++) {
      const v = judgeExchange(S, a, b, now);
      if (v) return { ...v, now };
    }
    return null;
  };
  const is = (r: ReturnType<typeof first>, winner: number, why: number, now?: number) =>
    !!r && r.winner === winner && r.why === why && (now === undefined || r.now === now);
  const fmt = (r: ReturnType<typeof first>) => (r ? `w=${r.winner} why=${r.why} à S${r.now - S >= 0 ? '+' : ''}${r.now - S}` : 'aucun');

  check('faute : action avant S + ANTICIPATE', isFoul(S, S - 50) && isFoul(S, S + DUEL.ANTICIPATE - 1) && !isFoul(S, S + DUEL.ANTICIPATE));
  let r = first(side({ foul: true }), iaiAt(S + 20));
  check('faute seule : l\'autre gagne (反則)', is(r, 1, W.FOUL), fmt(r));
  r = first(iaiAt(S + 20), side({ foul: true }));
  check('faute seule (côté b) : a gagne', is(r, 0, W.FOUL), fmt(r));
  r = first(side({ foul: true }), side({ foul: true }));
  check('double faute : rejouée', is(r, -1, W.DOUBLE_FOUL), fmt(r));

  r = first(iaiAt(S + 10), iaiAt(S + 15));
  check('frappe contre frappe : le premier impact gagne, tranché à min(I) + TIE', is(r, 0, W.IPPON, S + 10 + T + DUEL.TIE_TICKS), fmt(r));
  r = first(iaiAt(S + 30), iaiAt(S + 12));
  check('frappe contre frappe (b plus rapide)', is(r, 1, W.IPPON, S + 12 + T + DUEL.TIE_TICKS), fmt(r));
  for (const dt of [-1, 0, 1]) {
    r = first(iaiAt(S + 20), iaiAt(S + 20 + dt));
    check(`相打ち à ${dt >= 0 ? '+' : ''}${dt} tick : rejouée`, is(r, -1, W.AIUCHI, S + 20 + Math.min(0, dt) + T + DUEL.TIE_TICKS), fmt(r));
  }
  r = first(iaiAt(S + 20), iaiAt(S + 22));
  check('écart de 2 ticks : pas de 相打ち', is(r, 0, W.IPPON), fmt(r));

  for (let k = 0; k <= T; k++) {
    r = first(iaiAt(S + 20), side({ parryT: S + 20 + k }));
    check(`parade ${k} tick(s) après la frappe adverse : contre (弾)`, is(r, 1, W.PARRY, S + 20 + T), fmt(r));
  }
  r = first(iaiAt(S + 20), side({ parryT: S + 20 + T + 1 }));
  check('parade 9 ticks après la frappe : trop tard', is(r, 0, W.IPPON), fmt(r));
  r = first(side({ parryT: S + 18 }), iaiAt(S + 20));
  check('parade avant la frappe (garde qui couvre l\'impact) : contre', is(r, 0, W.PARRY), fmt(r));
  r = first(iaiAt(S + 20), side({ parryT: S + 20 + T - PLAYER.PARRY_ACTIVE - 1 }));
  check('impact juste après la garde (récupération) : la frappe gagne', is(r, 0, W.IPPON), fmt(r));
  r = first(iaiAt(S + 14), side({ parryT: S + 10 }));
  check('parade dans le vide puis frappe pendant la récupération : la frappe gagne', is(r, 0, W.IPPON), fmt(r));
  r = first(slashAt(S + 10), iaiAt(S + 14));
  check('ATTACK plus lent de 6 ticks : l\'iai relâché 4 ticks plus tard gagne', is(r, 1, W.IPPON), fmt(r));
  r = first(slashAt(S + 10), iaiAt(S + 15));
  check('ATTACK contre iai relâché 5 ticks plus tard : 相打ち (impacts à 1 tick)', is(r, -1, W.AIUCHI), fmt(r));
  r = first(slashAt(S + 10), iaiAt(S + 16));
  check('ATTACK contre iai relâché 6 ticks plus tard : 相打ち', is(r, -1, W.AIUCHI), fmt(r));
  r = first(slashAt(S + 10), iaiAt(S + 18));
  check('ATTACK contre iai relâché 8 ticks plus tard : ATTACK gagne', is(r, 0, W.IPPON), fmt(r));
  r = first(side(), side());
  check('personne ne frappe : rejouée à S + ROUND_MAX', is(r, -1, W.TIMEOUT, S + DUEL.ROUND_MAX), fmt(r));
  r = first(side({ parryT: S + 30 }), side());
  check('une parade seule ne fait rien : rejouée (TIMEOUT)', is(r, -1, W.TIMEOUT), fmt(r));
  r = first(iaiAt(S + DUEL.ROUND_MAX - 1), side());
  check('frappe juste avant ROUND_MAX : elle porte', is(r, 0, W.IPPON), fmt(r));

  // Balayage : symétrie a ↔ b et stabilité du verdict (il ne change plus une fois rendu).
  const offs = [-1, 6, 8, 10, 12, 14, 18, 20, 22, 26, 30, 40];
  let asym = 0;
  let unstable = 0;
  let total = 0;
  for (const sa of offs) for (const pa of offs) for (const sb of offs) for (const pb of offs) for (const slash of [false, true]) {
    const a = side({ strikeT: sa < 0 ? -1 : strikeStart(S + sa, slash), parryT: pa < 0 ? -1 : S + pa });
    const b = side({ strikeT: sb < 0 ? -1 : strikeStart(S + sb, false), parryT: pb < 0 ? -1 : S + pb });
    const ab = first(a, b);
    const ba = first(b, a);
    total++;
    if (!ab || !ba || ab.why !== ba.why || ab.now !== ba.now || (ab.winner < 0 ? ba.winner !== -1 : ba.winner !== 1 - ab.winner)) asym++;
    const late = judgeExchange(S, a, b, S + DUEL.ROUND_MAX + 500);
    if (ab && (!late || late.winner !== ab.winner || late.why !== ab.why)) unstable++;
  }
  check(`balayage de ${total} échanges : verdict symétrique (a ↔ b)`, asym === 0, `${asym} écart(s)`);
  check('balayage : verdict stable une fois rendu', unstable === 0, `${unstable} écart(s)`);

  const ks = new Set<number>();
  let inRange = true;
  for (let id = 1; id < 400; id++) for (let pl = 0; pl < 6; pl++) {
    const k = kamaeLength(id, pl);
    ks.add(k);
    if (k < DUEL.KAMAE_MIN || k > DUEL.KAMAE_MAX) inRange = false;
  }
  check('durée de garde hachée dans [KAMAE_MIN, KAMAE_MAX], variée', inRange && ks.size > 100, `${ks.size} valeurs`);
}

// ─── 2. Manches simulées ────────────────────────────────────────────────────
{
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const rngBefore = JSON.stringify(w.rng);
  const d = duel(w, a, b);
  check('startDuel : joueurs sur leurs marques, face à face, même sol', a.x === d.x - d.gap / 2 && b.x === d.x + d.gap / 2 && a.y === d.y && b.y === d.y && a.facing === 1 && b.facing === -1);
  check('le joueur de gauche est le côté a', d.a.pid === a.id && d.b.pid === b.id);
  // Mise en place : bouger ne sert à rien.
  run(w, DUEL.ENTER_TICKS - 1, () => BTN.RIGHT | BTN.JUMP);
  check('enter : immobiles malgré les entrées', d.phase === 'enter' && a.x === d.x - d.gap / 2 && a.y === d.y && a.state === 'normal');
  tick(w);
  check('kamae : signal publié dès l\'entrée en garde', d.phase === 'kamae' && d.sigTick === w.tick + kamaeLength(d.id, 0), `sig=${d.sigTick} tick=${w.tick}`);
  // Garde : IAI tenu charge à la vitesse de base ; aucune autre entrée ne déplace.
  a.up.iai = 5; // amélioration ignorée en duel
  const ev = run(w, 60, (_w, p) => (p === a ? BTN.IAI | BTN.LEFT : BTN.DASH | BTN.RIGHT | BTN.DOWN));
  check('kamae : IAI tenu → pose iaiCharge, charge à vitesse de base', a.state === 'iaiCharge' && a.iaiCharge === 59, `état=${a.state} charge=${a.iaiCharge}`);
  check('kamae : événements iaiStart et iaiReady', ev.some((e) => e.type === 'iaiStart' && e.pid === a.id) && ev.some((e) => e.type === 'iaiReady' && e.pid === a.id));
  check('kamae : personne ne bouge (dash, déplacement)', a.x === d.x - d.gap / 2 && b.x === d.x + d.gap / 2 && b.state === 'normal' && !b.crouch);
  check('le duel ne consomme pas w.rng', JSON.stringify(w.rng) === rngBefore);
  // Relâcher avant le signal : faute.
  const ev2 = run(w, 2, () => 0);
  const r0 = rounds(ev2)[0];
  check('relâcher l\'iai chargé avant le signal : faute, b gagne la manche', !!r0 && r0.winner === b.id && r0.why === W.FOUL && d.phase === 'resolve' && d.b.wins === 1, JSON.stringify(r0));
  check('react publié (négatif pour une faute pendant la garde, -1 sans action)', !!r0 && r0.ra < 0 && r0.rb === -1);
  tick(w);
  check('resolve : vainqueur en iaiStrike, perdant en hurt', b.state === 'iaiStrike' && a.state === 'hurt', `${b.state}/${a.state}`);
}

// Séries complètes
function series(plans: (side: 'a' | 'b', played: number) => Plan, rules: DuelRules = { firstTo: 2, maxRounds: 5, draw: true }) {
  const { w, ps } = coopWorld(2);
  const d = duel(w, ps[0], ps[1], rules);
  const ev = runDuel(w, d, duelScript((pid, pl) => plans(pid === d.a.pid ? 'a' : 'b', pl)));
  return { w, d, ev, a: ps[0], b: ps[1] };
}
{
  const s = series((side) => (side === 'a' ? iai(10) : none));
  const rs = rounds(s.ev);
  const e = ends(s.ev)[0];
  check('série 2–0 : deux ippon, duelEnd WIN', rs.length === 2 && rs.every((x) => x.why === W.IPPON && x.winner === s.a.id) && !!e && e.why === W.WIN && e.winner === s.a.id && e.wa === 2 && e.wb === 0, JSON.stringify(e));
  check('réaction publiée (ticks après le signal)', rs[0].ra === 10 && rs[0].rb === -1, `${rs[0].ra}/${rs[0].rb}`);
  check('numéros de manche 1, 2', rs[0].round === 1 && rs[1].round === 2);
  check('fin : duel retiré, joueurs libérés avec END_IFRAMES', !s.w.duels!.length && s.a.state === 'normal' && s.b.state === 'normal' && s.a.iframes === DUEL.END_IFRAMES && s.b.iframes === DUEL.END_IFRAMES);
  check('fin : délai AFTER_COOLDOWN pour la paire', s.w.duelInvites!.some((i) => i.cd && i.until === s.w.tick - 1 + DUEL.AFTER_COOLDOWN));
}
{
  const s = series((side, pl) => (pl === 1 ? (side === 'b' ? iai(9) : none) : side === 'a' ? iai(12) : parry(40)));
  const rs = rounds(s.ev);
  const e = ends(s.ev)[0];
  check('série 2–1', rs.length === 3 && !!e && e.winner === s.a.id && e.wa === 2 && e.wb === 1 && e.why === W.WIN, rs.map((x) => `${x.winner}:${x.why}`).join(' '));
}
{
  // 1–1 puis trois 相打ち : 5 manches jouées, nul (coop).
  const plan = (side: 'a' | 'b', pl: number): Plan => (pl === 0 ? (side === 'a' ? iai(10) : none) : pl === 1 ? (side === 'b' ? iai(10) : none) : iai(10));
  const s = series(plan);
  const rs = rounds(s.ev);
  const e = ends(s.ev)[0];
  check('nul après 5 manches (相打ち rejouées comprises)', rs.length === 5 && rs.slice(2).every((x) => x.why === W.AIUCHI && x.winner === -1) && !!e && e.why === W.DRAW && e.winner === -1 && s.d.played === 5, rs.map((x) => x.why).join(','));
  check('manche rejouée : même numéro de manche', rs[2].round === 3 && rs[3].round === 3 && rs[4].round === 3);
  // Même chose sans nul : mort subite.
  const s2 = series((side, pl) => (pl < 5 ? plan(side, pl) : side === 'b' ? iai(15) : none), { firstTo: 2, maxRounds: 5, draw: false });
  const e2 = ends(s2.ev)[0];
  check('mort subite si draw: false', rounds(s2.ev).length === 6 && !!e2 && e2.why === W.WIN && e2.winner === s2.b.id && e2.wb === 2, JSON.stringify(e2));
  // Mort subite plafonnée : 0–0 à SUDDEN_MAX, départage par la somme des réactions.
  const s3 = series((side) => (side === 'a' ? iai(10) : iai(11)), { firstTo: 2, maxRounds: 5, draw: false });
  const e3 = ends(s3.ev)[0];
  check('mort subite plafonnée : départage par la plus petite somme des réactions', rounds(s3.ev).length === DUEL.SUDDEN_MAX && !!e3 && e3.winner === s3.a.id && e3.wa === 0 && e3.wb === 0, JSON.stringify(e3));
}
{
  // Parade : manche gagnée par le défenseur ; parade dans le vide puis frappe.
  const s = series((side, pl) => (pl === 0 ? (side === 'a' ? iai(10) : parry(10 + DUEL.STRIKE_TRAVEL)) : side === 'a' ? parry(DUEL.ANTICIPATE) : iai(12)));
  const rs = rounds(s.ev);
  check('simulé : parade 8 ticks après la frappe adverse → 弾, défenseur gagnant', rs[0].why === W.PARRY && rs[0].winner === s.b.id);
  check('simulé : parade dans le vide puis frappe pendant la récupération → frappe gagnante', rs[1].why === W.IPPON && rs[1].winner === s.b.id);
  // Attaque sans charge contre iai.
  const s2 = series((side) => (side === 'a' ? attack(10) : iai(14)));
  check('simulé : ATTACK (plus lent de 6) perd contre un iai relâché 4 ticks après', rounds(s2.ev)[0].winner === s2.b.id && rounds(s2.ev)[0].why === W.IPPON);
  // Relâcher un iai pas assez chargé ne fait rien.
  const { w, ps } = coopWorld(2);
  const d = duel(w, ps[0], ps[1]);
  run(w, DUEL.ENTER_TICKS);
  run(w, 5, (_w, p) => (p === ps[0] ? BTN.IAI : 0));
  run(w, 2);
  check('iai relâché sous IAI_MIN_CHARGE : aucune action, aucune faute', !d.a.foul && d.a.strikeT < 0 && d.a.react === -1 && d.phase === 'kamae' && ps[0].state === 'normal');
  const evT = runDuel(w, d, () => 0);
  check('personne ne frappe : manches rejouées (TIMEOUT) puis nul', rounds(evT).every((x) => x.why === W.TIMEOUT) && ends(evT)[0]?.why === W.DRAW);
}
{
  // Double faute simulée.
  const { w, ps } = coopWorld(2);
  const d = duel(w, ps[0], ps[1]);
  const ev = run(w, DUEL.ENTER_TICKS + 3, (ww) => (ww.duels![0]?.phase === 'kamae' ? BTN.ATTACK : 0));
  const r = rounds(ev)[0];
  check('double faute simulée : rejouée', !!r && r.why === W.DOUBLE_FOUL && r.winner === -1 && d.a.wins === 0 && d.b.wins === 0);
}

// ─── 3. Prédiction : stepDuelist ne dépend que de w.tick, d et p ────────────
{
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b);
  const script = duelScript((pid, pl) => (pid === a.id ? (pl % 2 ? parry(9) : iai(12)) : pl % 2 ? iai(10) : attack(20)));
  let diverge = 0;
  let steps = 0;
  for (let i = 0; i < 6000 && w.duels!.includes(d); i++) {
    const bA = script(w, a);
    // Copie jetable : un monde minimal, le duel et le joueur clonés.
    const dc: Duel = structuredClone(d);
    const pc: Player = structuredClone(a);
    const fake = { tick: w.tick, duels: [dc], events: [] as GameEvent[] } as unknown as World;
    const pressed = bA & ~pc.prevButtons;
    pc.prevButtons = bA;
    stepDuelist(fake, dc, pc, bA, pressed);
    tick(w, (_w, p) => (p === a ? bA : script(w, p)));
    if (!w.duels!.includes(d)) break;
    steps++;
    const same = pc.state === a.state && pc.stateT === a.stateT && pc.iaiCharge === a.iaiCharge && pc.x === a.x && pc.y === a.y && pc.facing === a.facing;
    const sideSame = JSON.stringify(dc.a) === JSON.stringify({ ...d.a, wins: dc.a.wins }) || d.phase === 'resolve' || d.phase === 'enter';
    if (!same || !sideSame) diverge++;
  }
  check('copie jetable du duel : même pose et mêmes actions que le serveur', diverge === 0 && steps > 500, `${diverge} écart(s) sur ${steps} ticks`);
}

// ─── 4. Invitations ─────────────────────────────────────────────────────────
const press = (who: Player[]): Script => (_w, p) => (who.includes(p) ? BTN.DUEL : 0);
{
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx);
  put(w, b, cx + DUEL.INVITE_RANGE + 30);
  put(w, c, cx - 4000);
  a.facing = 1;
  let ev = tick(w, press([a]));
  check('hors de portée : aucun défi', invites(ev).length === 0 && !w.duelInvites!.length);
  tick(w);
  put(w, b, cx + 200);
  ev = tick(w, press([a]));
  check('à portée : défi lancé (duelInvite)', invites(ev).length === 1 && invites(ev)[0].to === b.id && w.duelInvites!.length === 1);
  tick(w);
  ev = tick(w, press([a]));
  check('second appui : annulation (CANCEL), pas de second défi', cancels(ev)[0]?.why === W.CANCEL && !w.duelInvites!.some((i) => !i.cd));
  tick(w);
  ev = tick(w, press([a]));
  check('délai par paire après annulation : B n\'est plus défiable', invites(ev).length === 0);
  put(w, c, cx - 150);
  tick(w);
  ev = tick(w, press([a]));
  check('… mais C l\'est (même en tournant le dos)', invites(ev)[0]?.to === c.id);
  check('une seule invitation sortante', w.duelInvites!.filter((i) => !i.cd && i.from === a.id).length === 1);
  run(w, DUEL.PAIR_COOLDOWN + 5);
  check('délais purgés à l\'échéance', !w.duelInvites!.some((i) => i.cd && i.until <= w.tick));
}
{
  // Choix de la cible : le plus proche devant, sinon le plus proche.
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx);
  put(w, b, cx + 220);
  put(w, c, cx - 60);
  a.facing = 1;
  let ev = tick(w, press([a]));
  check('cible : le plus proche dans la direction regardée', invites(ev)[0]?.to === b.id);
  tick(w);
  tick(w, press([a])); // annule
  tick(w);
  a.facing = -1;
  ev = tick(w, press([a]));
  check('cible : se retourner change de cible', invites(ev)[0]?.to === c.id);
}
{
  // Conditions.
  const attempt = (setup: (w: World, a: Player, b: Player) => void, keepQuiet = true): number => {
    const { w, ps, cx } = coopWorld(2);
    const [a, b] = ps;
    put(w, a, cx - 60);
    put(w, b, cx + 60);
    a.facing = 1;
    setup(w, a, b);
    const ev = tick(w, press([a]), keepQuiet);
    return invites(ev).length;
  };
  check('conditions réunies : défi', attempt(() => {}) === 1);
  check('Marée en alerte : pas de défi', attempt((w) => { w.wave.phase = 'warn'; }, false) === 0);
  check('dans l\'arène : pas de défi', attempt((w, a, b) => {
    const x = (w.level.arena.col + 4) * TILE;
    put(w, a, x);
    put(w, b, x + 80);
  }) === 0);
  check('cible morte : pas de défi', attempt((w, _a, b) => { b.iframes = 0; damagePlayer(w, b, 1e6, b.x + 10); }) === 0);
  check('cible absente : pas de défi', attempt((w, _a, b) => { w.away = [b.id]; }) === 0);
  check('défieur absent : pas de défi', attempt((w, a) => { w.away = [a.id]; }) === 0);
  check('étape hors exploration : pas de défi', attempt((w) => { w.stage.state = 'gateOpen'; }) === 0);
  const engagedAt = (dx: number) => attempt((w, a) => {
    const e = spawnEnemy(w, 'ashigaru', a.x + dx, a.y, false);
    e.state = 'chase';
    e.freeze = 99;
  }, false);
  check('ennemi engagé à moins de ENGAGED_RANGE : pas de défi', engagedAt(-DUEL.ENGAGED_RANGE + 50) === 0);
  check('ennemi engagé au-delà : défi possible', engagedAt(-DUEL.ENGAGED_RANGE - 200) === 1);
  check('ennemi en patrouille tout près : défi possible', attempt((w, a) => {
    const e = spawnEnemy(w, 'ashigaru', a.x - 100, a.y, false);
    e.freeze = 99;
  }, false) === 1);
}
{
  // Expiration, rupture par la distance, coup reçu.
  const { w, ps, cx } = coopWorld(2);
  const [a, b] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  a.facing = 1;
  tick(w, press([a]));
  const ev = run(w, DUEL.INVITE_TICKS + 2);
  check('expiration après INVITE_TICKS (EXPIRED)', cancels(ev)[0]?.why === W.EXPIRED && !w.duelInvites!.some((i) => !i.cd));
  check('expiration : délai PAIR_COOLDOWN pour la paire', w.duelInvites!.some((i) => i.cd && i.from === a.id && i.until > w.tick + DUEL.PAIR_COOLDOWN - 10));

  const s = coopWorld(2);
  put(s.w, s.ps[0], s.cx - 60);
  put(s.w, s.ps[1], s.cx + 60);
  s.ps[0].facing = 1;
  tick(s.w, press([s.ps[0]]));
  put(s.w, s.ps[1], s.cx + DUEL.INVITE_BREAK + 100);
  check('écart > INVITE_BREAK : défi rompu (DISTANCE)', cancels(tick(s.w))[0]?.why === W.DISTANCE);

  const h = coopWorld(2);
  put(h.w, h.ps[0], h.cx - 60);
  put(h.w, h.ps[1], h.cx + 60);
  h.ps[0].facing = 1;
  tick(h.w, press([h.ps[0]]));
  damagePlayer(h.w, h.ps[1], 5, h.ps[1].x + 10);
  check('l\'un des deux touché : défi rompu (HIT)', cancels(tick(h.w))[0]?.why === W.HIT);
}
{
  // Accepter, appui mutuel.
  const { w, ps, cx } = coopWorld(2);
  const [a, b] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  a.facing = 1;
  tick(w, press([a]));
  tick(w);
  const ev = tick(w, press([b]));
  const st = ev.find((e) => e.type === 'duelStart');
  check('accepter : duelStart, duel engagé, défi consommé', !!st && w.duels!.length === 1 && !w.duelInvites!.some((i) => !i.cd));
  check('placement sur sol plat : même hauteur, écart GAP', a.y === b.y && Math.abs(b.x - a.x) === DUEL.GAP && findGround(w.level, a.x, a.y, 1) === a.y && findGround(w.level, b.x, b.y, 1) === b.y);
  // DUEL encore tenu après l'acceptation : pas d'abandon.
  run(w, DUEL.FORFEIT_HOLD + 30, press([b]));
  check('DUEL tenu depuis l\'acceptation : pas d\'abandon', w.duels!.length === 1 && w.duels![0].phase !== 'end');

  const m = coopWorld(2);
  put(m.w, m.ps[0], m.cx - 60);
  put(m.w, m.ps[1], m.cx + 60);
  m.ps[0].facing = 1;
  m.ps[1].facing = -1;
  const evm = tick(m.w, press(m.ps));
  check('appui mutuel au même tick : duel engagé', evm.some((e) => e.type === 'duelStart') && m.w.duels!.length === 1);
}
{
  // Échec TERRAIN : piliers hauts toutes les 4 colonnes autour des joueurs.
  const { w, ps, cx, gy } = coopWorld(2);
  const [a, b] = ps;
  const L = w.level;
  const floorRow = gy / TILE;
  const c0 = Math.floor(cx / TILE);
  for (let c = c0 - 24; c <= c0 + 24; c++) {
    if ((c - c0) % 4 !== 2 && (c - c0) % 4 !== -2) continue;
    for (let r = Math.max(0, floorRow - 12); r < floorRow; r++) L.tiles[r * L.w + c] = T_SOLID;
  }
  put(w, a, (c0 - 1 + 0.5) * TILE);
  put(w, b, (c0 + 1 + 0.5) * TILE);
  a.facing = 1;
  check('findDuelSpot : aucun sol plat → null', findDuelSpot(L, cx, gy, DUEL.GAP) === null);
  tick(w, press([a]));
  tick(w);
  const ev = tick(w, press([b]));
  check('sans emplacement : duelCancel TERRAIN', cancels(ev)[0]?.why === W.TERRAIN && !w.duels!.length);
}
{
  // findDuelSpot sur un niveau synthétique.
  const mk = (heights: number[]): Level => {
    const w = heights.length;
    const h = 20;
    const tiles = new Uint8Array(w * h).fill(T_EMPTY);
    heights.forEach((gh, c) => { for (let r = h - gh; r < h; r++) tiles[r * w + c] = T_SOLID; });
    return { stage: 0, biome: 'bamboo', w, h, pxW: w * TILE, pxH: h * TILE, tiles, spawn: { x: 0, y: 0 }, decos: [], enemySpawns: [], checkpoints: [], arena: { col: w + 10, rows: h, trigger: 1e9, guardianX: 0, guardianY: 0, backup: [] }, gate: { x: 0, y: 0 } } as unknown as Level;
  };
  const flat = mk(new Array(60).fill(3));
  const s = findDuelSpot(flat, 30 * TILE, 17 * TILE, DUEL.GAP);
  check('findDuelSpot : sol plat trouvé au point demandé', !!s && s.x === 30 * TILE && s.y === 17 * TILE, JSON.stringify(s));
  const step = mk(Array.from({ length: 60 }, (_, c) => (c < 31 ? 3 : 4)));
  const s2 = findDuelSpot(step, 30 * TILE, 17 * TILE, DUEL.GAP);
  check('findDuelSpot : marche → centre décalé sur un sol plat, marques à même hauteur', !!s2 && s2.x !== 30 * TILE && Math.abs(s2.x - 30 * TILE) <= DUEL.SPOT_SCAN_TILES * TILE, JSON.stringify(s2));
  const bumpy = mk(Array.from({ length: 60 }, (_, c) => 3 + (c % 2)));
  check('findDuelSpot : sol irrégulier partout → null (ou marques à même hauteur sans mur)', (() => {
    const r = findDuelSpot(bumpy, 30 * TILE, 17 * TILE, DUEL.GAP);
    return r === null;
  })());
}

// ─── 5. Immunité ────────────────────────────────────────────────────────────
function immunityScene(net: boolean) {
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  put(w, c, cx - 4000);
  const d = duel(w, a, b);
  if (net) {
    w.net = createLagComp();
    for (const p of ps) setLag(w.net, p.id, 4);
  }
  return { w, a, b, c, d };
}
for (const net of [false, true]) {
  const tag = net ? ' (compensation de latence)' : '';
  {
    const { w, a, b, c, d } = immunityScene(net);
    // Spectateur collé derrière le duelliste a (entre les marques) ; ennemi à gauche de a.
    put(w, c, a.x + 14);
    const e = spawnEnemy(w, 'ashigaru', a.x - 70, a.y, false);
    e.state = 'chase';
    e.facing = 1;
    check(`targetPlayer ignore les duellistes${tag}`, targetPlayer(w, e) === c);
    const hits: number[] = [];
    for (let i = 0; i < 900; i++) {
      const ev = tick(w, () => 0, false);
      w.projectiles = w.projectiles.filter((p) => p.owner !== 'enemy' || p.kind !== 'arrow');
      w.spawnTimer = 1e9;
      w.enemies = w.enemies.filter((x) => x === e);
      w.wave.t = 0;
      for (const x of ev) if (x.type === 'playerHit') hits.push(x.pid);
      c.hp = c.maxHp;
      c.x = a.x + 14;
      if (!w.enemies.includes(e)) break;
    }
    check(`frappes ennemies : duelliste jamais touché, spectateur derrière lui touché${tag}`, !hits.includes(a.id) && !hits.includes(b.id) && hits.includes(c.id), `touchés : ${hits.join(',')}`);
    check(`duellistes sans dégâts${tag}`, a.hp === a.maxHp && b.hp === b.maxHp && d.phase !== 'end');
    check(`damagePlayer ignore un duelliste${tag}`, damagePlayer(w, a, 50, a.x + 10) === 'ignored' && a.hp === a.maxHp);
  }
  {
    const { w, a, b, c } = immunityScene(net);
    // Spectateur collé derrière le duelliste a (entre les marques, sur le même sol).
    c.x = a.x + 30;
    c.y = a.y;
    c.onGround = true;
    // Flèche tirée de la gauche, à hauteur du torse : elle traverse a et touche c.
    w.projectiles.push({ id: w.nextId++, kind: 'arrow', x: a.x - 120, y: a.y - 28, vx: 700, vy: -60, owner: 'enemy', ownerId: 0, damage: 10, life: 200, hits: [], dead: false });
    const hits: number[] = [];
    for (let i = 0; i < 90; i++) {
      const ev = tick(w, () => 0, false);
      w.enemies = [];
      w.spawnTimer = 1e9;
      for (const x of ev) if (x.type === 'playerHit') hits.push(x.pid);
    }
    check(`flèches : traversent le duelliste, touchent le spectateur collé derrière${tag}`, !hits.includes(a.id) && !hits.includes(b.id) && hits.includes(c.id), `touchés : ${hits.join(',')}`);
  }
}
{
  // Orbes : un duelliste ne les attire pas.
  const { w, a, c } = immunityScene(false);
  w.orbs.push({ id: w.nextId++, x: a.x, y: a.y - 22, vx: 0, vy: 0, value: 5, life: 600, lost: false, onGround: true });
  const h0 = a.honor;
  run(w, 60, () => 0, false);
  check('orbes : non ramassées par un duelliste', a.honor === h0 && c.honor === 0);
}
{
  // Aucun renfort près d'un duel (la horde continue ailleurs).
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  const d = duel(w, a, b);
  put(w, c, cx + 1900);
  w.spawnTimer = 0;
  w.enemies = [];
  const near: number[] = [];
  let spawns = 0;
  for (let i = 0; i < 2500 && w.duels!.includes(d); i++) {
    const ev = tick(w, () => 0, false);
    w.wave.t = 0;
    for (const x of ev) {
      if (x.type !== 'spawn') continue;
      spawns++;
      if (Math.abs(x.x - d.x) < DUEL.NO_SPAWN_RANGE) near.push(Math.round(x.x - d.x));
    }
    // Les ennemis retirés régulièrement : le spawner reste actif.
    if (i % 200 === 0) w.enemies = [];
    c.hp = c.maxHp;
  }
  check('aucun renfort à moins de NO_SPAWN_RANGE d\'un duel (la horde continue ailleurs)', near.length === 0 && spawns > 0, `${spawns} renforts, près : ${near.join(',')}`);
}

// ─── 6. Sorties : abandon, déconnexion, passage d'étape ─────────────────────
{
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b);
  run(w, 70);
  const ev = run(w, DUEL.FORFEIT_HOLD, press([b]));
  const e = ends(ev)[0];
  check('abandon : DUEL tenu FORFEIT_HOLD ticks → FORFEIT, l\'autre gagne', !!e && e.why === W.FORFEIT && e.winner === a.id && d.phase === 'end');
  const ev2 = runDuel(w, d, () => 0);
  check('abandon : duel retiré après END_TICKS', !w.duels!.includes(d) && ends(ev2).length === 0);
}
{
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b);
  run(w, 100);
  removePlayer(w, b.id);
  const e = ends(w.events)[0];
  w.events.length = 0;
  check('removePlayer d\'un duelliste : victoire de l\'autre (DISCONNECT)', !!e && e.why === W.DISCONNECT && e.winner === a.id);
  runDuel(w, d, () => 0);
  check('déconnexion : duel retiré, a libéré', !w.duels!.length && a.state === 'normal' && a.iframes === DUEL.END_IFRAMES);
}
{
  const { w, ps } = coopWorld(3);
  const [a, b, c] = ps;
  duel(w, a, b);
  put(w, c, a.x - 3000);
  run(w, 100);
  // c défie quelqu'un ? personne à portée : on pose un défi en attente à la main.
  w.duelInvites!.push({ from: c.id, to: a.id, until: w.tick + 100, cd: false });
  nextStage(w);
  const e = ends(w.events)[0];
  const cn = cancels(w.events)[0];
  w.events.length = 0;
  check('passage d\'étape : duel interrompu sans résultat (INTERRUPT)', !!e && e.why === W.INTERRUPT && e.winner === -1 && !w.duels!.length);
  check('passage d\'étape : défis en attente tombés', cn?.why === W.INTERRUPT && !w.duelInvites!.some((i) => !i.cd));
  check('passage d\'étape : joueurs libres', a.state === 'normal' && b.state === 'normal' && !duelOf(w, a.id));
}
{
  // Bilan (clearStage) pendant un duel.
  const { w, ps } = coopWorld(3);
  const [a, b, c] = ps;
  duel(w, a, b);
  run(w, 10);
  warpToArena(w, c.id);
  const ev: GameEvent[] = [];
  for (let i = 0; i < 600 && w.stage.state !== 'cleared'; i++) {
    if (w.stage.state === 'arena') {
      const g = w.enemies.find((e) => e.id === w.stage.guardianId);
      if (g) killEnemy(w, g, c, 0, false);
    }
    if (w.stage.state === 'gateOpen') {
      c.x = w.level.gate.x;
      c.y = w.level.gate.y;
    }
    c.hp = c.maxHp;
    ev.push(...tick(w, (ww, p) => (p === c && ww.stage.state === 'playing' ? BTN.RIGHT : 0), false));
  }
  check('bilan pendant un duel : duel interrompu (INTERRUPT)', w.stage.state === 'cleared' && ends(ev).some((x) => x.why === W.INTERRUPT) && !w.duels!.length, `état=${w.stage.state}`);
}

// ─── 7. Neutralité ──────────────────────────────────────────────────────────
{
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  a.up.iai = 3;
  a.up.parry = 2;
  b.up.edge = 4;
  a.honor = 120;
  b.honor = 40;
  a.hp = 70;
  a.picks = 1;
  a.offer = ['edge', 'reach', 'swift'];
  const before = JSON.stringify({ a: [a.up, a.honor, a.hp, a.level, a.picks, a.offer, a.kills, a.score], b: [b.up, b.honor, b.hp, b.level, b.kills, b.score], st: w.stage.byPlayer, s: [w.stage.kills, w.stage.parries, w.stage.deaths, w.stage.honor] });
  const d = duel(w, a, b);
  runDuel(w, d, duelScript((pid, pl) => (pid === a.id ? (pl === 1 ? parry(9) : iai(10)) : pl === 1 ? iai(10) : none)), 20000);
  // Les appuis PICK pendant le duel ne choisissent rien non plus.
  const after = JSON.stringify({ a: [a.up, a.honor, a.hp, a.level, a.picks, a.offer, a.kills, a.score], b: [b.up, b.honor, b.hp, b.level, b.kills, b.score], st: w.stage.byPlayer, s: [w.stage.kills, w.stage.parries, w.stage.deaths, w.stage.honor] });
  check('après un duel : améliorations, Honneur, PV et byPlayer inchangés', before === after, after);
  const s2 = coopWorld(2);
  s2.ps[0].picks = 1;
  s2.ps[0].offer = ['edge', 'reach', 'swift'];
  duel(s2.w, s2.ps[0], s2.ps[1]);
  run(s2.w, 10, (_w, p) => (p === s2.ps[0] ? BTN.PICK1 : 0));
  check('choix d\'amélioration bloqué pendant le duel', s2.ps[0].up.edge === 0 && s2.ps[0].picks === 1);
}

// ─── 8. Déterminisme ────────────────────────────────────────────────────────
{
  const scenario = (): string => {
    const w = createWorld(31337, { mode: 'coop', difficulty: 'normal' });
    const ps = [addPlayer(w, 'a'), addPlayer(w, 'b'), addPlayer(w, 'c')];
    const log: GameEvent[] = [];
    const m = new Map<number, number>();
    for (let t = 0; t < 4000; t++) {
      m.clear();
      for (const p of ps) {
        const d = duelOf(w, p.id);
        let bt = 0;
        if (!d) bt = t % 400 === 50 + p.id * 3 ? BTN.DUEL : t % 400 < 40 ? BTN.RIGHT : 0;
        else if (d.phase === 'kamae' || d.phase === 'open') bt = w.tick - d.sigTick < 8 + p.id * 2 ? BTN.IAI : 0;
        m.set(p.id, bt);
      }
      stepWorld(w, m);
      log.push(...w.events);
      w.events.length = 0;
    }
    const n = log.filter((e) => e.type.startsWith('duel')).length;
    return `${n}|${JSON.stringify(log)}|${JSON.stringify({ ...w, net: undefined })}`;
  };
  const r1 = scenario();
  const r2 = scenario();
  check('déterminisme : même graine, même résultat (duels et défis compris)', r1 === r2 && Number(r1.split('|')[0]) > 0, `${r1.split('|')[0]} événements de duel`);
}

// ─── 9. Solo intact ─────────────────────────────────────────────────────────
{
  // Même empreinte que tests/coop.test.ts §13, avec un bit ajouté à toutes les entrées.
  const soloFingerprint = (seed: number, difficulty: DifficultyId, nPlayers: number, ticks: number, extra: number): { fp: string; keys: boolean } => {
    const w = createWorld(seed, { difficulty });
    for (let i = 0; i < nPlayers; i++) addPlayer(w, 'p' + i, { color: i });
    let s = (seed * 31 + nPlayers) >>> 0 || 1;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const moves = [0, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT | BTN.ATTACK, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.DASH | BTN.RIGHT, BTN.PARRY, BTN.IAI, BTN.DOWN, BTN.PICK1, BTN.PICK2, BTN.UP | BTN.ATTACK, BTN.JUMP | BTN.ATTACK];
    const held = new Map<number, [number, number]>();
    const m = new Map<number, number>();
    let h = 0x811c9dc5;
    let keys = false;
    const feed = (str: string) => {
      for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    };
    const state = () => {
      const j = JSON.stringify({ ...w, shrine: undefined });
      if (j.includes('"duels"') || j.includes('"duelInvites"')) keys = true;
      return j;
    };
    const kill = (p: Player) => {
      if (p.state === 'dead') return;
      p.iframes = 0;
      p.state = 'normal';
      damagePlayer(w, p, 1e6, p.x + 10);
    };
    for (let t = 0; t < ticks; t++) {
      if (t % 2300 === 350) for (const p of w.players) if (p.state !== 'dead') kill(p);
      if (t % 3000 === 1500) warpToArena(w);
      if (t % 3000 === 1700 && w.stage.state === 'arena') {
        const g = w.enemies.find((e) => e.id === w.stage.guardianId);
        if (g) killEnemy(w, g, w.players[0], 0, false);
      }
      if (t % 3000 === 1760 && w.players[0]) {
        w.players[0].x = w.level.gate.x - 40;
        w.players[0].y = w.level.gate.y;
      }
      if (t % 60 === 0) for (const p of w.players) if (p.state !== 'dead') p.hp = p.maxHp;
      if (t % 3000 === 600 || t % 3000 === 1100) {
        const cps = w.level.checkpoints;
        const c = cps[1 + (((t / 500) | 0) % Math.max(1, cps.length - 1))] ?? cps[0];
        const p = w.players[w.players.length - 1];
        if (p && p.state !== 'dead' && w.stage.state === 'playing') {
          p.x = c.x;
          p.y = c.y;
        }
      }
      m.clear();
      for (const p of w.players) {
        let k = held.get(p.id);
        if (!k || t >= k[1]) {
          k = [moves[Math.floor(rnd() * moves.length)], t + 3 + Math.floor(rnd() * 25)];
          held.set(p.id, k);
        }
        m.set(p.id, (w.stage.state === 'cleared' && t % 200 === 0 ? BTN.JUMP : k[0]) | extra);
      }
      stepWorld(w, m);
      if (w.events.length) feed(t + JSON.stringify(w.events));
      w.events.length = 0;
      if (t % 500 === 0) feed(state());
    }
    feed(state());
    return { fp: `${h.toString(16)} étape=${w.level.stage} over=${w.over}`, keys };
  };
  const golden: [number, DifficultyId, number, number, string][] = [
    [4242, 'normal', 1, 9000, '592f6d52 étape=2 over=false'],
    [7, 'veryEasy', 2, 9000, '3ff24d30 étape=3 over=false'],
  ];
  for (const [seed, diff, n, ticks, want] of golden) {
    const plain = soloFingerprint(seed, diff, n, ticks, 0);
    const withDuel = soloFingerprint(seed, diff, n, ticks, BTN.DUEL);
    check(`solo : empreinte identique avec BTN.DUEL sur toutes les entrées (graine ${seed})`, plain.fp === withDuel.fp && withDuel.fp === want, `${plain.fp} / ${withDuel.fp}`);
    check(`solo : aucune clé duels ni duelInvites dans le JSON (graine ${seed})`, !plain.keys && !withDuel.keys);
  }
  const solo = createWorld(3);
  check('solo : createWorld sans duels ni duelInvites', !('duels' in solo) && !('duelInvites' in solo));
}
{
  // Coop hors duel : appuyer sur DUEL sans personne à portée ne change rien.
  const fp = (extra: number): string => {
    const w = createWorld(77, { mode: 'coop', difficulty: 'normal' });
    addPlayer(w, 'solo-en-coop');
    let s = 12345;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const moves = [0, BTN.RIGHT, BTN.RIGHT | BTN.ATTACK, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.PARRY, BTN.IAI, BTN.DASH | BTN.RIGHT];
    let held = 0;
    let until = 0;
    const m = new Map<number, number>();
    let log = '';
    for (let t = 0; t < 5000; t++) {
      if (t >= until) {
        held = moves[Math.floor(rnd() * moves.length)];
        until = t + 3 + Math.floor(rnd() * 25);
      }
      m.set(w.players[0].id, held | (t % 7 < 3 ? extra : 0));
      stepWorld(w, m);
      if (w.events.length) log += t + JSON.stringify(w.events);
      w.events.length = 0;
    }
    return log + JSON.stringify({ ...w, players: w.players.map((p) => ({ ...p, prevButtons: 0 })) });
  };
  check('coop hors duel : DUEL sans cible ne change rien', fp(0) === fp(BTN.DUEL));
}

// ─── 10. Cas limites : Marée, arène, absents, duels voisins, défis croisés, bilan, spectateurs ───
const COOP_RULES: DuelRules = { firstTo: DUEL.FIRST_TO, maxRounds: DUEL.MAX_ROUNDS, draw: true };
/** Série scriptée : a relâche l'iai à sig + 10 à chaque manche, b ne fait rien (a gagne 2–0). */
const aWins = (a: Player): Script => duelScript((pid) => (pid === a.id ? iai(10) : none));
/** Tous les joueurs dans au plus un duel, et chaque duel a deux duellistes distincts. */
function duelInvariant(w: World): boolean {
  const seen = new Set<number>();
  for (const d of w.duels ?? []) {
    if (d.a.pid === d.b.pid || seen.has(d.a.pid) || seen.has(d.b.pid)) return false;
    seen.add(d.a.pid);
    seen.add(d.b.pid);
  }
  return true;
}
{
  // 10a. Marée qui se lève pendant un duel : le duel suit son cours, aucun renfort près de lui.
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, c, cx + 1500);
  const d = duel(w, a, b);
  w.spawnTimer = 0;
  w.wave.phase = 'calm';
  w.wave.t = 1e6; // l'alerte tombe au prochain pas
  const known = new Set(w.enemies.map((e) => e.id));
  const near: number[] = [];
  const ev: GameEvent[] = [];
  const script = aWins(a);
  for (let i = 0; i < 20000 && w.duels!.includes(d); i++) {
    c.hp = c.maxHp;
    c.iframes = 1e6;
    ev.push(...tick(w, script, false));
    for (const e of w.enemies) {
      if (known.has(e.id)) continue;
      known.add(e.id);
      if (Math.abs(e.x - d.x) < DUEL.NO_SPAWN_RANGE) near.push(Math.round(e.x - d.x));
    }
  }
  const e = ends(ev)[0];
  check('Marée pendant un duel : alerte puis Marée levées', ev.some((x) => x.type === 'tideWarn') && w.wave.phase !== 'calm', `phase=${w.wave.phase}`);
  check('Marée pendant un duel : série menée à terme (2–0, WIN), sans interruption', !!e && e.why === W.WIN && e.winner === a.id && e.wa === 2, JSON.stringify(e));
  check('Marée pendant un duel : duellistes intacts', a.hp === a.maxHp && b.hp === b.maxHp);
  check('Marée pendant un duel : aucun renfort à moins de NO_SPAWN_RANGE', near.length === 0 && known.size > 0, `${known.size} ennemis, près : ${near.join(',')}`);
}
{
  // 10a bis. Défi lancé au calme, la Marée s'annonce avant l'acceptation : le défi tombe (TIDE), sans délai de paire.
  const { w, ps, cx } = coopWorld(2);
  const [a, b] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  a.facing = 1;
  tick(w, press([a]));
  tick(w);
  w.wave.phase = 'warn';
  const ev = run(w, 1, press([b]), false);
  check('acceptation pendant l\'alerte de Marée : pas de duel, défi annulé (TIDE) sans délai de paire', !ev.some((x) => x.type === 'duelStart') && !w.duels!.length && cancels(ev)[0]?.why === W.TIDE && !w.duelInvites!.length, JSON.stringify(cancels(ev)));
}
{
  // 10b. Arène fermée par un autre joueur pendant un duel collé à la barrière.
  const { w, ps } = coopWorld(3);
  const [a, b, c] = ps;
  const col = w.level.arena.col;
  // Emplacement de duel au plus près de la barrière (les niveaux générés ont un fossé juste avant elle).
  let spot: { x: number; y: number } | null = null;
  for (let x = (col + 1) * TILE - DUEL.GAP / 2; x > (col - 20) * TILE && !spot; x -= 4) spot = findDuelSpot(w.level, x, w.level.arena.guardianY, DUEL.GAP);
  if (!spot) check('arène fermée : emplacement de duel près de la barrière trouvé', false);
  else {
    const d = startDuel(w, a, b, COOP_RULES, spot)!;
    w.events.length = 0;
    run(w, 30);
    // c entre dans l'arène : le kekkai se ferme.
    c.x = w.level.arena.trigger + 3 * TILE;
    c.y = findGround(w.level, c.x, w.level.arena.guardianY, 12) ?? c.y;
    c.onGround = true;
    c.iframes = 1e6;
    const ev: GameEvent[] = [];
    let locked = false;
    for (let i = 0; i < 20000 && w.duels!.includes(d); i++) {
      c.hp = c.maxHp;
      ev.push(...tick(w, aWins(a), false));
      w.spawnTimer = 1e9;
      w.enemies = w.enemies.filter((e) => e.id === w.stage.guardianId);
      for (const e of w.enemies) e.x = Math.max(e.x, (col + 12) * TILE); // gardien tenu loin des marques
      locked ||= w.stage.state === 'arena';
    }
    const e = ends(ev)[0];
    const bx = b.x;
    check('arène fermée pendant un duel : le kekkai se ferme, le duel n\'est pas interrompu', locked && !!e && e.why === W.WIN && e.winner === a.id, `état=${w.stage.state} fin=${JSON.stringify(e)}`);
    check('arène fermée : duellistes du même côté du kekkai, hors de l\'arène', !arenaInside(w.level, a.x) && !arenaInside(w.level, bx), `b.x=${bx}, kekkai à ${col * TILE}–${(col + 1) * TILE}`);
    check('arène fermée : le duelliste de droite n\'est pas pris dans le kekkai à la sortie', fitsAt(w.level, b.x, b.y, PLAYER.W, PLAYER.H), `b.x=${b.x} (corps ${b.x - PLAYER.W / 2}–${b.x + PLAYER.W / 2}), kekkai ${col * TILE}–${(col + 1) * TILE}`);
    // Après le duel, b recule librement (il n'est pas emmuré).
    run(w, 40, (_w, p) => (p === b ? BTN.LEFT : 0), false);
    check('arène fermée : après le duel, le duelliste de droite peut repartir à gauche', b.x < bx - 40, `${bx} → ${b.x}`);
  }
}
{
  // 10c. Duelliste absent (aucun bouton depuis longtemps) : le duel continue et se joue.
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b);
  const play = aWins(a);
  const ev = runDuel(w, d, (ww, p) => {
    ww.away = [b.id];
    return play(ww, p);
  });
  const e = ends(ev)[0];
  check('duelliste absent : série jouée normalement (pas de forfait, pas d\'abandon)', !!e && e.why === W.WIN && e.winner === a.id, JSON.stringify(e));
}
{
  // 10d. Deux duels côte à côte : marques distinctes, jugements indépendants.
  const { w, ps, cx } = coopWorld(4);
  const [a, b, c, dd] = ps;
  put(w, c, cx - 3000);
  put(w, dd, cx - 3100);
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  a.facing = 1;
  b.facing = -1;
  tick(w, press([a]));
  tick(w);
  tick(w, press([b]));
  const d1 = duelOf(w, a.id);
  // c et d là où a et b se tenaient (même point médian) : juste à côté du premier duel.
  put(w, c, cx - 60);
  put(w, dd, cx + 60);
  c.facing = 1;
  dd.facing = -1;
  run(w, 2);
  tick(w, press([c]));
  tick(w);
  tick(w, press([dd]));
  const d2 = duelOf(w, c.id);
  check('deux duels côte à côte : les deux sont engagés', !!d1 && !!d2 && d1 !== d2 && w.duels!.length === 2);
  if (d1 && d2) {
    const marks = [d1.x - d1.gap / 2, d1.x + d1.gap / 2, d2.x - d2.gap / 2, d2.x + d2.gap / 2];
    let minGap = Infinity;
    for (let i = 0; i < 2; i++) for (let j = 2; j < 4; j++) minGap = Math.min(minGap, Math.abs(marks[i] - marks[j]));
    check('deux duels côte à côte : aucun duelliste sur la marque d\'un autre duel (≥ largeur d\'un corps)', minGap >= PLAYER.W, `écart minimal ${minGap} px, centres ${d1.x} / ${d2.x}`);
    // a gagne le premier, d (côté droit du second) gagne le second.
    const ev = runDuel(w, d2, duelScript((pid) => (pid === a.id ? iai(10) : pid === dd.id ? iai(14) : none)));
    const e1 = ends(ev).find((x) => x.id === d1.id);
    const e2 = ends(ev).find((x) => x.id === d2.id);
    check('deux duels côte à côte : chaque série a son vainqueur', e1?.winner === a.id && e2?.winner === dd.id && e1.why === W.WIN && e2.why === W.WIN, `${JSON.stringify(e1)} ${JSON.stringify(e2)}`);
    check('deux duels côte à côte : réactions propres à chaque duel', rounds(ev).length >= 4 && rounds(ev).every((r) => (r.id === d1.id ? (d1.a.pid === a.id ? r.ra : r.rb) === 10 : (d2.a.pid === dd.id ? r.ra : r.rb) === 14)));
  }
}
{
  // 10e. Défis croisés à trois : a → b en attente, puis c → a en attente ; tous appuient au même tick.
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx);
  put(w, b, cx + 100);
  put(w, c, cx - 100);
  a.facing = 1;
  c.facing = 1;
  tick(w, press([a]));
  tick(w);
  const ev1 = tick(w, press([c]));
  const ok1 = w.duelInvites!.some((i) => !i.cd && i.from === a.id && i.to === b.id) && invites(ev1)[0]?.from === c.id && invites(ev1)[0]?.to === a.id;
  check('défis croisés : a → b et c → a en attente en même temps', ok1, JSON.stringify(w.duelInvites));
  tick(w);
  const ev = tick(w, press([a, b, c]));
  const starts = ev.filter((x) => x.type === 'duelStart');
  // Chacun annule d'abord son propre défi : appuis simultanés, au plus un duel, jamais un joueur dans deux.
  check('défis croisés, appuis simultanés : au plus un duel, aucun joueur dans deux duels', starts.length <= 1 && w.duels!.length <= 1 && duelInvariant(w), `${starts.length} duelStart`);
  const dd = w.duels![0];
  check('défis croisés : plus aucun défi en attente pour les duellistes (si un duel a commencé)', !dd || !w.duelInvites!.some((i) => !i.cd && [dd.a.pid, dd.b.pid].some((q) => q === i.from || q === i.to)));
  const loner = [a, b, c].find((p) => !duelOf(w, p.id))!;
  tick(w);
  const ev2 = run(w, 3, (_w, p) => (p === loner ? BTN.DUEL : 0));
  check('défis croisés : le troisième ne peut défier aucun duelliste', invites(ev2).length === 0 && duelInvariant(w));
}
{
  // 10e bis. a a défié b ; c défie a. a appuie de nouveau, seul (pour annuler son défi ?).
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx);
  put(w, b, cx + 100);
  put(w, c, cx - 100);
  a.facing = 1;
  c.facing = 1;
  tick(w, press([a]));
  tick(w);
  tick(w, press([c]));
  tick(w);
  const ev = tick(w, press([a]));
  const cn = cancels(ev).find((x) => x.from === a.id && x.to === b.id);
  check('défis croisés : le second appui de a annule d\'abord son propre défi (a → b), sans accepter c', cn?.why === W.CANCEL && !ev.some((x) => x.type === 'duelStart'), JSON.stringify(cn));
  tick(w);
  const ev3 = tick(w, press([a]));
  const st = ev3.find((x): x is Extract<GameEvent, { type: 'duelStart' }> => x.type === 'duelStart');
  check('défis croisés : un nouvel appui de a accepte alors le défi de c', !!st && [st.a, st.b].includes(c.id) && [st.a, st.b].includes(a.id), JSON.stringify(st));
}
{
  // 10f. Invitation pendant le bilan : impossible ; DUEL tenu depuis le bilan ne défie pas à l'étape suivante.
  const { w, ps, cx } = coopWorld(2);
  const [a, b] = ps;
  w.stage.state = 'cleared';
  w.stage.t = 0;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  a.facing = 1;
  const ev: GameEvent[] = [];
  for (let i = 0; i < 40; i++) ev.push(...tick(w, (_w, p) => (p === a && i % 2 === 0 ? BTN.DUEL : 0)));
  check('bilan : DUEL martelé ne lance aucun défi', invites(ev).length === 0 && !w.duelInvites!.some((i) => !i.cd), `${invites(ev).length} défis`);
  tick(w, press([a]));
  nextStage(w);
  w.events.length = 0;
  put(w, a, w.level.spawn.x + 300);
  put(w, b, a.x + 120);
  a.facing = 1;
  quiet(w);
  const ev2 = run(w, 5, press([a]));
  check('étape suivante : DUEL tenu depuis le bilan ne défie pas (front montant)', invites(ev2).length === 0);
  tick(w);
  const ev3 = tick(w, press([a]));
  check('étape suivante : relâché puis appuyé, le défi part', invites(ev3).length === 1, `${invites(ev3).length}`);
}
{
  // 10g/h. Spectateur qui combat à côté du duel et frappe les duellistes : aucun effet sur le duel.
  const plan = (a: Player, b: Player): Script => duelScript((pid) => (pid === a.id ? iai(12) : pid === b.id ? iai(15) : none));
  const fmtRounds = (ev: GameEvent[], a: Player) => rounds(ev).map((r) => `${r.winner === a.id ? 'a' : 'b'}${r.why}:${r.ra}/${r.rb}`).join(' ');
  const baseline = (() => {
    const { w, ps } = coopWorld(3);
    const [a, b, c] = ps;
    put(w, c, a.x - 4000);
    const d = duel(w, a, b);
    return fmtRounds(runDuel(w, d, plan(a, b)), a);
  })();
  const { w, ps } = coopWorld(3);
  const [a, b, c] = ps;
  const d = duel(w, a, b);
  const moves = [BTN.ATTACK, BTN.ATTACK | BTN.RIGHT, BTN.IAI, 0, BTN.JUMP, BTN.DOWN | BTN.ATTACK, BTN.DASH | BTN.LEFT, BTN.UP | BTN.ATTACK, BTN.PARRY];
  const script = plan(a, b);
  const ev: GameEvent[] = [];
  let k = 0;
  for (let i = 0; i < 20000 && w.duels!.includes(d); i++) {
    // c se colle alternativement à chaque duelliste et frappe ; un ennemi l'attaque à côté.
    if (i % 90 === 0) {
      const target = (i / 90) % 2 ? a : b;
      c.x = target.x + (target === a ? 20 : -20);
      c.y = target.y;
      w.enemies = [];
      const e = spawnEnemy(w, 'ashigaru', c.x + (target === a ? -50 : 50), c.y, false);
      e.state = 'chase';
      e.hp = e.maxHp = 1e6; // il survit aux coups du spectateur
    }
    c.hp = c.maxHp;
    ev.push(...tick(w, (ww, p) => (p === c ? (i % 90 < 45 ? moves[(k++ >> 3) % moves.length] : 0) : script(ww, p)), false));
    w.spawnTimer = 1e9;
    w.projectiles = w.projectiles.filter((p) => p.owner !== 'enemy');
  }
  const got = fmtRounds(ev, a);
  const touched = ev.filter((x) => ('targetId' in x && (x.targetId === a.id || x.targetId === b.id)) || (x.type === 'playerHit' && (x.pid === a.id || x.pid === b.id)));
  check('spectateur qui combat et frappe les duellistes : mêmes manches qu\'au calme', got === baseline && got.length > 0, `${got} / ${baseline}`);
  check('spectateur qui frappe : duellistes ni touchés ni blessés', touched.length === 0 && a.hp === a.maxHp && b.hp === b.maxHp, `${touched.length} événements`);
  check('spectateur qui combat : il a bien été attaqué à côté du duel', ev.some((x) => x.type === 'playerHit' && x.pid === c.id), [...new Set(ev.map((x) => x.type))].join(','));
}
{
  // 10i. Duelliste qui avait de l'Honneur perdu au sol, sous sa marque.
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, c, cx - 4000);
  put(w, b, cx - 3000); // personne d'autre ne ramasse les orbes de a
  a.honor = 300;
  put(w, a, cx);
  a.iframes = 0;
  damagePlayer(w, a, 1e6, a.x + 10);
  const lost = w.orbs.filter((o) => o.lost).reduce((s, o) => s + o.value, 0);
  run(w, 400); // a renaît
  w.orbs = w.orbs.filter((o) => o.lost);
  const left = w.orbs.reduce((s, o) => s + o.value, 0); // encore au sol (une orbe a pu être reprise avant le duel)
  const h0 = a.honor;
  const d = startDuel(w, a, b, COOP_RULES, findDuelSpot(w.level, cx + DUEL.GAP / 2, w.level.spawn.y, DUEL.GAP) ?? undefined);
  if (!d || lost <= 0 || left <= 0) check('Honneur perdu : duel engagé sur les orbes', false, `lost=${lost} left=${left}`);
  else {
    w.events.length = 0;
    for (const o of w.orbs) {
      o.x = a.x;
      o.y = a.y - 10;
      o.vx = o.vy = 0;
    }
    const orbsBefore = w.orbs.length;
    runDuel(w, d, aWins(a));
    const life = Math.min(...w.orbs.map((o) => o.life));
    check('Honneur perdu : non ramassé pendant le duel', a.honor === h0 && w.orbs.length === orbsBefore, `honneur ${h0} → ${a.honor}, orbes ${orbsBefore} → ${w.orbs.length}`);
    run(w, 120);
    check('Honneur perdu : ramassé après le duel (orbes encore en vie)', a.honor - h0 === left && !w.orbs.some((o) => o.lost), `+${a.honor - h0} sur ${left}, vie restante ${life}, orbes perdues au sol ${w.orbs.filter((o) => o.lost).length}`);
    // Les orbes empilées sous la marque sont ramassées au même tick à la sortie du duel.
    check('Honneur perdu : plus aucune orbe au sol → repère effacé (lostX = NaN)', Number.isNaN(a.lostX), `lostX ${a.lostX}`);
  }
}

// ─── 11. Robustesse : DUEL martelé, abandon commencé avant l'acceptation ─────
{
  // DUEL martelé (un appui tous les deux ticks) par a, avec b et c à portée, pendant 4000 ticks.
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx);
  put(w, b, cx + 100);
  put(w, c, cx - 100);
  const ev = run(w, 4000, (ww, p) => (p === a && ww.tick % 2 === 0 ? BTN.DUEL : 0));
  const n = invites(ev).length;
  // Chaque défi annulé bloque la paire PAIR_COOLDOWN ticks : au plus 2 cibles × (4000 / PAIR_COOLDOWN + 1) défis.
  const bound = 2 * (Math.floor(4000 / DUEL.PAIR_COOLDOWN) + 1);
  check('DUEL martelé : nombre de défis borné par les délais de paire', n > 0 && n <= bound, `${n} défis (borne ${bound})`);
  check('DUEL martelé : aucun duel sans acceptation, liste des défis bornée', !w.duels!.length && w.duelInvites!.length <= 3, `${w.duelInvites!.length} entrées`);
  const cds = w.duelInvites!.filter((i) => i.cd);
  check('DUEL martelé : un seul délai par paire', new Set(cds.map((i) => [i.from, i.to].sort().join('-'))).size === cds.length);
}
{
  // DUEL martelé pendant un duel, ou tenu FORFEIT_HOLD − 1 ticks puis relâché : jamais d'abandon.
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b);
  const ev = run(w, 400, (ww, p) => (p === b && ww.tick % 2 === 0 ? BTN.DUEL : 0));
  const ev2 = run(w, 400, (ww, p) => (p === b && ww.tick % DUEL.FORFEIT_HOLD < DUEL.FORFEIT_HOLD - 1 ? BTN.DUEL : 0));
  check('DUEL martelé pendant un duel : pas d\'abandon', !ends(ev).length);
  check('DUEL tenu FORFEIT_HOLD − 1 ticks puis relâché, en boucle : pas d\'abandon', !ends(ev2).length && d.phase !== 'end', `phase ${d.phase}`);
}
{
  // Abandon commencé avant l'acceptation : b tient DUEL (défi vers a), a accepte ; tous deux continuent de tenir.
  const { w, ps, cx } = coopWorld(2);
  const [a, b] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  b.facing = -1;
  const ev0 = run(w, 5, press([b]));
  check('b tient DUEL : défi vers a', invites(ev0)[0]?.from === b.id);
  const ev1 = tick(w, press([a, b]));
  const ev = run(w, 3 * DUEL.FORFEIT_HOLD, press([a, b]));
  check('abandon commencé avant l\'acceptation : le duel démarre, aucun abandon (défieur et défié tiennent DUEL)', ev1.some((x) => x.type === 'duelStart') && !ends(ev).length && w.duels!.length === 1);
  tick(w);
  const ev2 = run(w, DUEL.FORFEIT_HOLD, press([b]));
  check('… relâché puis tenu FORFEIT_HOLD ticks : abandon de b', ends(ev2)[0]?.why === W.FORFEIT && ends(ev2)[0]?.winner === a.id);
}
{
  // Famine d'entrées (w.starved, posé par la session qui répète le dernier masque) : l'appui d'abandon ne compte que les
  // entrées reçues ; son compteur est en pause, ni compté ni remis à zéro, quel que soit le masque répété.
  const starve = (w: World, who: Player, n: number, starved: boolean, script: Script): GameEvent[] => {
    const out: GameEvent[] = [];
    for (let i = 0; i < n; i++) {
      w.starved = starved ? [who.id] : [];
      out.push(...tick(w, script));
    }
    return out;
  };
  for (const repeated of [BTN.DUEL, 0]) {
    const { w, ps } = coopWorld(2);
    const [a, b] = ps;
    const d = duel(w, a, b);
    run(w, 70);
    const mask = (m: number): Script => (_w, p) => (p === b ? m : 0);
    const ev = [...starve(w, b, 40, false, mask(BTN.DUEL)), ...starve(w, b, 100, true, mask(repeated)), ...starve(w, b, DUEL.FORFEIT_HOLD - 41, false, mask(BTN.DUEL))];
    check(`famine pendant l'appui (masque répété ${repeated ? 'avec' : 'sans'} DUEL) : FORFEIT_HOLD − 1 entrées reçues, pas d'abandon`, !ends(ev).length && d.phase !== 'end', `phase ${d.phase}`);
    const ev2 = starve(w, b, 1, false, mask(BTN.DUEL));
    check(`… l'entrée reçue suivante atteint FORFEIT_HOLD : abandon (compteur gardé pendant la famine)`, ends(ev2)[0]?.why === W.FORFEIT && ends(ev2)[0]?.winner === a.id);
  }
  // Appui commencé avant l'acceptation, puis famine (DUEL répété) : il ne compte toujours pas.
  const { w, ps, cx } = coopWorld(2);
  const [a, b] = ps;
  put(w, a, cx - 60);
  put(w, b, cx + 60);
  b.facing = -1;
  run(w, 5, press([b]));
  const ev1 = tick(w, press([a, b]));
  const ev = [...starve(w, b, 50, true, press([a, b])), ...starve(w, b, 3 * DUEL.FORFEIT_HOLD, false, press([a, b]))];
  check('appui commencé avant l\'acceptation, famine pendant le duel : aucun abandon', ev1.some((x) => x.type === 'duelStart') && !ends(ev).length && w.duels!.length === 1);
}

// ─── 12. Issue acquise, défis tombés, ennemis engagés, joueurs hors combat ──
{
  // 12a. Série décidée par la manche en cours de dénouement (a mène 2–0) : ni l'abandon du vainqueur,
  // ni sa déconnexion, ni un forfait FLOOD, ni le passage d'étape ne la renversent ou ne l'effacent.
  const decisive = (act: (w: World, a: Player) => void, hold = false) => {
    const { w, ps } = coopWorld(2);
    const [a, b] = ps;
    const d = duel(w, a, b);
    const play = aWins(a);
    for (let i = 0; i < 20000 && w.duels!.includes(d) && !(d.phase === 'resolve' && d.played === 2); i++) tick(w, play);
    const ready = d.phase === 'resolve' && (d.a.pid === a.id ? d.a : d.b).wins === 2;
    act(w, a);
    const ev = w.events.slice();
    w.events.length = 0;
    ev.push(...runDuel(w, d, (ww, p) => (hold && p === a ? BTN.DUEL : play(ww, p))));
    const e = ends(ev);
    const ok = ready && e.length === 1 && e[0].winner === a.id && e[0].why === W.WIN && (d.a.pid === a.id ? e[0].wa : e[0].wb) === 2;
    return { ok, info: `prêt=${ready} ${JSON.stringify(e)}` };
  };
  const held = decisive(() => {}, true);
  check('série acquise : DUEL tenu par le vainqueur pendant le dénouement → WIN, pas FORFEIT', held.ok, held.info);
  const left = decisive((w, a) => removePlayer(w, a.id));
  check('série acquise : le vainqueur se déconnecte pendant le dénouement → WIN, pas DISCONNECT', left.ok, left.info);
  const flood = decisive((w, a) => forfeit(w, a.id, W.FLOOD));
  check('série acquise : forfait FLOOD pendant le dénouement → WIN', flood.ok, flood.info);
  const moved = decisive((w) => nextStage(w));
  check('série acquise : passage d\'étape pendant le dénouement → WIN, pas INTERRUPT', moved.ok, moved.info);
}
{
  // Témoin : série encore ouverte (1–0, dénouement de la première manche) : l'abandon tient.
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b);
  const play = aWins(a);
  for (let i = 0; i < 20000 && !(d.phase === 'resolve' && d.played === 1); i++) tick(w, play);
  forfeit(w, a.id, W.FORFEIT);
  const e = ends(w.events)[0];
  w.events.length = 0;
  check('série encore ouverte (1–0) : l\'abandon du meneur pendant le dénouement reste un abandon', e?.why === W.FORFEIT && e.winner === b.id, JSON.stringify(e));
}
{
  // Nul acquis : une manche au plus, personne ne frappe (TIMEOUT) ; la déconnexion n'offre pas la victoire.
  const { w, ps } = coopWorld(2);
  const [a, b] = ps;
  const d = duel(w, a, b, { firstTo: 2, maxRounds: 1, draw: true });
  for (let i = 0; i < 20000 && d.phase !== 'resolve'; i++) tick(w);
  const timeout = d.last === W.TIMEOUT && d.played === 1;
  removePlayer(w, b.id);
  const e = ends(w.events)[0];
  w.events.length = 0;
  check('nul acquis au dénouement : la déconnexion d\'un duelliste donne DRAW, sans vainqueur', timeout && e?.why === W.DRAW && e.winner === -1, JSON.stringify(e));
}
{
  // 12b. Ennemi en plein échange (récupération, coup encaissé, étourdi, ninja caché) près du défieur :
  // pas de défi, et un défi lancé au calme ne peut pas être accepté (témoin : patrouille).
  const near = (type: EnemyType, state: EnemyState, accept: boolean): boolean => {
    const { w, ps, cx } = coopWorld(2);
    const [a, b] = ps;
    put(w, a, cx - 60);
    put(w, b, cx + 60);
    a.facing = 1;
    b.facing = -1;
    if (accept) {
      tick(w, press([a]));
      tick(w);
    }
    const e = spawnEnemy(w, type, a.x - 50, a.y, false);
    e.state = state;
    e.freeze = 9999;
    const ev = tick(w, press([accept ? b : a]), false);
    return accept ? ev.some((x) => x.type === 'duelStart') : invites(ev).length > 0;
  };
  for (const [type, state] of [['ashigaru', 'recover'], ['ashigaru', 'hitstun'], ['ashigaru', 'stunned'], ['oni', 'recover'], ['ninja', 'hidden']] as [EnemyType, EnemyState][]) {
    check(`ennemi engagé (${type} en ${state}) à 50 px : pas de défi`, !near(type, state, false));
  }
  check('ennemi étourdi près du défieur au moment d\'accepter : pas de duel', !near('ashigaru', 'stunned', true));
  check('… témoin : ennemi en patrouille au même endroit, duel accepté', near('ashigaru', 'patrol', true));
}
{
  // 12c. startDuel (dojo, raccourci de développement) refuse un joueur mort, à 0 PV ou sorti, sans rien changer.
  const refused = (hurt: (w: World, b: Player) => void): boolean => {
    const { w, ps } = coopWorld(2);
    const [a, b] = ps;
    hurt(w, b);
    const before = JSON.stringify([a.state, b.state, b.hp, b.x, b.y]);
    const d = startDuel(w, a, b, COOP_RULES);
    return !d && !w.duels?.length && !w.events.some((x) => x.type === 'duelStart') && JSON.stringify([a.state, b.state, b.hp, b.x, b.y]) === before;
  };
  check('startDuel : joueur mort refusé (il n\'est pas relevé)', refused((w, b) => {
    b.iframes = 0;
    damagePlayer(w, b, 1e6, b.x + 10);
  }));
  check('startDuel : joueur à 0 PV refusé', refused((_w, b) => { b.hp = 0; }));
  check('startDuel : joueur sorti de la partie refusé', refused((_w, b) => { b.out = true; }));
  check('startDuel : … témoin, deux joueurs valides : duel engagé', !refused(() => {}));
}
{
  // 12d. a → b et c → a en attente ; b accepte : le défi de c tombe (BUSY : c n'a rien retiré), sans
  // délai de paire, et le duel a–b s'engage.
  const { w, ps, cx } = coopWorld(3);
  const [a, b, c] = ps;
  put(w, a, cx);
  put(w, b, cx + 100);
  put(w, c, cx - 100);
  a.facing = 1;
  c.facing = 1;
  tick(w, press([a]));
  tick(w);
  tick(w, press([c]));
  tick(w);
  const cn = cancels(tick(w, press([b])));
  check('défi tombé parce que sa cible entre en duel : motif BUSY, pas CANCEL', cn.length === 1 && cn[0].from === c.id && cn[0].to === a.id && cn[0].why === W.BUSY, JSON.stringify(cn));
  check('BUSY : duel a–b engagé, aucun délai de paire entre c et a', !!duelOf(w, a.id) && duelOf(w, a.id) === duelOf(w, b.id) && !pairCooling(w, c.id, a.id));
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de duel passent.');
