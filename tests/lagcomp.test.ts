// Tests de la compensation de latence (attaque rembobinée, défense retardée).
// Lancer : npm run test:lagcomp
import { findGround, spawnEnemy } from '../shared/enemy';
import { BTN } from '../shared/input';
import { killEnemy } from '../shared/interactions';
import { createLagComp, forgetPlayer, lagOf, setLag } from '../shared/lagcomp';
import { Rng } from '../shared/math';
import { MAX_REWIND_TICKS } from '../shared/net/protocol';
import type { Enemy, EnemyType, GameEvent, Player, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, removePlayer, stepWorld, warpToArena } from '../shared/world';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const eState = (e: Enemy): string => e.state;
const KINDS: EnemyType[] = ['ashigaru', 'archer', 'ninja', 'oni', 'ashigaru'];

/** Monde coop calme : pas de horde ni de Marée, n joueurs posés au sol près du départ. */
function arena(n: number, net: boolean): { w: World; ps: Player[] } {
  const w = createWorld(31, { mode: 'coop' });
  w.enemies = [];
  w.spawnTimer = 1e9;
  w.wave.t = -1e9;
  if (net) w.net = createLagComp();
  const ps: Player[] = [];
  for (let i = 0; i < n; i++) {
    const p = addPlayer(w, 'p' + i, { color: i });
    p.iframes = 0;
    ps.push(p);
  }
  step(w, 40); // tout le monde au sol
  for (const p of ps) p.iframes = 0;
  return { w, ps };
}

/** Avance de n ticks ; `input(S, p)` donne les boutons, `before(S)` agit avant chaque pas. */
function step(w: World, n: number, input: (S: number, p: Player) => number = () => 0, before?: (S: number) => void): GameEvent[] {
  const evs: GameEvent[] = [];
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    before?.(w.tick);
    m.clear();
    for (const p of w.players) m.set(p.id, input(w.tick, p));
    stepWorld(w, m);
    evs.push(...w.events);
    w.events.length = 0;
  }
  return evs;
}

const hitsOn = (evs: GameEvent[], id: number) => evs.filter((e) => e.type === 'hit' && e.targetId === id).length;

// ─── 1. Attaque : corps de l'ennemi pris au tick de vue ─────────────────────
// Mannequin figé, collé au joueur jusqu'au tick `until` puis déplacé à 300 px.
// Le joueur appuie sur attaque au tick A : slash1 est actif aux pas A+6 … A+9.
function dummyScenario(lag: number | null, until: (A: number) => number): { hits: number; e: Enemy } {
  const { w, ps } = arena(1, lag !== null);
  const p = ps[0];
  if (w.net && lag !== null) setLag(w.net, p.id, lag);
  const e = spawnEnemy(w, 'ashigaru', p.x + 40, p.y, false);
  e.hp = e.maxHp = 1e6;
  e.freeze = 1e9;
  const A = w.tick + 30;
  const near = p.x + 40;
  const far = p.x + 300;
  const evs = step(
    w,
    60,
    (S) => (S === A ? BTN.ATTACK : 0),
    (S) => {
      if (e.freeze > 1000) e.x = S < until(A) ? near : far;
    },
  );
  return { hits: hitsOn(evs, e.id), e };
}
{
  const moved = (A: number) => A; // l'ennemi s'éloigne quand le joueur appuie
  const ref = dummyScenario(null, moved);
  check('sans compensation : l’ennemi parti n’est pas touché', ref.hits === 0, `${ref.hits} coup(s)`);
  const zero = dummyScenario(0, moved);
  check('L = 0 : même résultat que sans compensation', zero.hits === 0, `${zero.hits} coup(s)`);
  const comp = dummyScenario(10, moved);
  check('L = 10 : touché, le client voyait le chevauchement au tick v', comp.hits === 1, `${comp.hits} coup(s)`);
  check('… dégâts appliqués à l’ennemi actuel', comp.e.hp < 1e6);
  // Retard demandé au-delà du plafond : ramené à MAX_REWIND_TICKS (chevauchement vu juste avant, touché ;
  // un peu plus tôt, hors de portée du rembobinage, refusé).
  const over = MAX_REWIND_TICKS + 5;
  const max = dummyScenario(over, (A) => A + 10 - MAX_REWIND_TICKS);
  check(`L demandé ${over} → borné à ${MAX_REWIND_TICKS} : chevauchement vu ${MAX_REWIND_TICKS - 6} ticks avant, touché`, max.hits === 1, `${max.hits} coup(s)`);
  const far = dummyScenario(over, (A) => A + 5 - MAX_REWIND_TICKS);
  check(`S − v > ${MAX_REWIND_TICKS} : refusé (le rembobinage est borné)`, far.hits === 0, `${far.hits} coup(s)`);
  const net = createLagComp();
  setLag(net, 1, 99);
  setLag(net, 2, -4);
  setLag(net, 3, NaN);
  check('setLag borne le retard à 0..MAX_REWIND_TICKS', lagOf(net, 1) === MAX_REWIND_TICKS && lagOf(net, 2) === 0 && lagOf(net, 3) === 0 && lagOf(net, 9) === 0);
}

// ─── 2. Une seule touche par attaque ────────────────────────────────────────
{
  for (const lag of [0, 5, 17]) {
    const { w, ps } = arena(1, true);
    const p = ps[0];
    setLag(w.net!, p.id, lag);
    const e = spawnEnemy(w, 'ashigaru', p.x + 40, p.y, false);
    e.hp = e.maxHp = 1e6;
    e.freeze = 1e9;
    const A = w.tick + 25;
    // L'ennemi reste au contact (présent et passé) : le coup ne doit compter qu'une fois.
    const near = p.x + 40;
    const evs = step(w, 40, (S) => (S === A ? BTN.ATTACK : 0), () => {
      if (e.freeze > 1000) e.x = near;
    });
    check(`attaque (L = ${lag}) : une seule touche par coup`, hitsOn(evs, e.id) === 1, `${hitsOn(evs, e.id)}`);
  }
}

// ─── 3. Défense : parade d'une frappe vue à l'écran ─────────────────────────
// Un lancier attaque un joueur immobile. Référence : tick k de l'impact sans compensation.
function spearScenario(lag: number | null, parryAt: number | null): { evs: GameEvent[]; e: Enemy; p: Player; w: World; stunned: boolean } {
  const { w, ps } = arena(1, lag !== null);
  const p = ps[0];
  if (w.net && lag !== null) setLag(w.net, p.id, lag);
  p.facing = 1;
  const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  let stunned = false;
  // Une seule attaque : après sa récupération, le lancier ne recommence plus.
  let once = false;
  const evs = step(w, 160, (S) => (S === parryAt ? BTN.PARRY : 0), () => {
    if (eState(e) === 'recover' || eState(e) === 'stunned') once = true;
    if (once) e.cd = 1e9;
    stunned ||= eState(e) === 'stunned';
  });
  return { evs, e, p, w, stunned };
}
{
  // Tick serveur de l'impact sans compensation (les événements ne portent pas leur tick).
  let kTick = -1;
  {
    const { w, ps } = arena(1, false);
    const p = ps[0];
    p.facing = 1;
    const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
    e.facing = -1;
    e.state = 'chase';
    e.cd = 0;
    for (let i = 0; i < 200 && kTick < 0; i++) {
      const S = w.tick;
      stepWorld(w, new Map());
      if (w.events.some((ev) => ev.type === 'playerHit')) kTick = S;
      w.events.length = 0;
    }
  }
  check('référence : le lancier touche le joueur immobile', kTick > 0, `tick ${kTick}`);
  // Le client (L = 17) voit la frappe au tick k et pare juste avant : son appui arrive au serveur à k + 15.
  const L = 17;
  const comp = spearScenario(L, kTick + L - 2);
  const parried = comp.evs.some((ev) => ev.type === 'parry');
  const hurt = comp.evs.some((ev) => ev.type === 'playerHit');
  check('L = 17 : parade lancée à l’écran avant l’impact → événement parry', parried && !hurt, `parry=${parried} playerHit=${hurt}`);
  check('… le lancier est étourdi', comp.stunned && comp.w.stage.parries === 1);
  const plain = spearScenario(null, kTick + L - 2);
  const plainHurt = plain.evs.some((ev) => ev.type === 'playerHit');
  const plainParry = plain.evs.some((ev) => ev.type === 'parry');
  check('sans compensation : le même scénario donne playerHit', plainHurt && !plainParry, `parry=${plainParry} playerHit=${plainHurt}`);
  const late = spearScenario(L, null);
  const lateHits = late.evs.filter((ev) => ev.type === 'playerHit').length;
  check('L = 17 sans parade : la frappe touche quand même, une seule fois', lateHits === 1, `${lateHits}`);
  const early = spearScenario(L, kTick + L - 14);
  check('L = 17 : parade lancée trop tôt (fenêtre close à l’impact vu) → playerHit', early.evs.some((ev) => ev.type === 'playerHit') && !early.evs.some((ev) => ev.type === 'parry'));
  const zero = spearScenario(0, kTick + L - 2);
  check('L = 0 : mêmes événements que sans compensation', JSON.stringify(zero.evs) === JSON.stringify(plain.evs));
}

// ─── 4. Défense : une seule touche par attaque ennemie, retards différents ──
{
  const count = (lags: number[] | null): number => {
    const { w, ps } = arena(2, lags !== null);
    ps[1].x = ps[0].x + 6; // deux joueurs l'un sur l'autre, dans la zone du coup de lance
    ps[1].y = ps[0].y;
    if (lags) ps.forEach((p, i) => setLag(w.net!, p.id, lags[i]));
    const e = spawnEnemy(w, 'ashigaru', ps[0].x + 66, ps[0].y, false);
    e.facing = -1;
    e.state = 'chase';
    e.cd = 1;
    let n = 0;
    let once = false;
    const evs = step(w, 160, () => 0, () => {
      if (eState(e) === 'recover') once = true;
      if (once) e.cd = 1e9; // une seule attaque
    });
    for (const ev of evs) if (ev.type === 'playerHit') n++;
    return n;
  };
  check('référence : un coup de lance ne touche qu’un joueur', count(null) === 1, `${count(null)}`);
  for (const lags of [[0, 0], [5, 12], [12, 5], [0, 17], [17, 0]]) {
    check(`retards ${lags.join('/')} : une seule touche par attaque ennemie`, count(lags) === 1, `${count(lags)}`);
  }
}

// ─── 5. Défense : projectile vu à l'écran, paré ─────────────────────────────
function shurikenScenario(lag: number | null, parryAt: number | null): { evs: GameEvent[]; hitTick: number; w: World } {
  const { w, ps } = arena(1, lag !== null);
  const p = ps[0];
  if (w.net && lag !== null) setLag(w.net, p.id, lag);
  p.facing = 1;
  w.projectiles.push({ id: w.nextId++, kind: 'shuriken', x: p.x + 260, y: p.y - 14, vx: -600, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life: 200, hits: [], dead: false });
  const evs: GameEvent[] = [];
  let hitTick = -1;
  for (let i = 0; i < 120; i++) {
    const S = w.tick;
    stepWorld(w, new Map([[p.id, S === parryAt ? BTN.PARRY : 0]]));
    if (hitTick < 0 && w.events.some((ev) => ev.type === 'playerHit')) hitTick = S;
    evs.push(...w.events);
    w.events.length = 0;
  }
  return { evs, hitTick, w };
}
{
  const ref = shurikenScenario(null, null);
  check('référence : le shuriken touche le joueur immobile', ref.hitTick > 0, `tick ${ref.hitTick}`);
  const L = 17;
  const comp = shurikenScenario(L, ref.hitTick + L - 2);
  const parried = comp.evs.some((ev) => ev.type === 'parry');
  check('projectile, L = 17 : parade lancée avant l’impact vu → parry', parried && !comp.evs.some((ev) => ev.type === 'playerHit'));
  const back = comp.w.projectiles.find((a) => a.kind === 'shuriken');
  check('… le shuriken est renvoyé (appartient au joueur, repart vers la droite)', !!back && back.owner === 'player' && back.vx > 0, back ? `${back.owner} vx=${back.vx}` : 'disparu');
  const plain = shurikenScenario(null, ref.hitTick + L - 2);
  check('projectile sans compensation : le même scénario donne playerHit', plain.evs.some((ev) => ev.type === 'playerHit') && !plain.evs.some((ev) => ev.type === 'parry'));
  const late = shurikenScenario(L, null);
  check('projectile, L = 17 sans parade : touché une seule fois', late.evs.filter((ev) => ev.type === 'playerHit').length === 1, `${late.evs.filter((ev) => ev.type === 'playerHit').length}`);
}

// ─── 6. L = 0 ⇒ mêmes événements que sans w.net (partie coop scriptée) ──────
function scripted(seed: number): (t: number, id: number) => number {
  const rng = new Rng(seed);
  const held = new Map<number, { mask: number; until: number }>();
  const moves = [0, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.ATTACK, BTN.RIGHT | BTN.ATTACK, BTN.DASH | BTN.RIGHT, BTN.PARRY, BTN.PARRY, BTN.IAI, BTN.DOWN | BTN.RIGHT, BTN.PICK1, BTN.UP | BTN.ATTACK, BTN.DOWN | BTN.ATTACK | BTN.JUMP];
  return (t, id) => {
    let h = held.get(id);
    if (!h || t >= h.until) {
      h = { mask: moves[Math.floor(rng.next() * moves.length)], until: t + 4 + Math.floor(rng.next() * 30) };
      held.set(id, h);
    }
    return h.mask;
  };
}
function coopGame(withNet: boolean, lagFor: (t: number, pid: number) => number, ticks = 3000): { evs: string[]; w: World; counts: Record<string, number> } {
  const w = createWorld(2024, { mode: 'coop' });
  if (withNet) w.net = createLagComp();
  for (let i = 0; i < 4; i++) addPlayer(w, 'p' + i, { color: i });
  const input = scripted(99);
  const m = new Map<number, number>();
  const evs: string[] = [];
  const counts: Record<string, number> = {};
  for (let t = 0; t < ticks; t++) {
    if (t % 120 === 0) for (const p of w.players) if (p.state !== 'dead') p.hp = p.maxHp;
    // Renforts au contact de chaque joueur : beaucoup d'échanges de coups (frappes, flèches, parades).
    if (t % 150 === 75) {
      w.players.forEach((p, i) => {
        if (p.state === 'dead') return;
        const x = p.x + (i % 2 ? -1 : 1) * (90 + 20 * i);
        const gy = findGround(w.level, x, p.y, 2);
        if (gy === null || Math.abs(gy - p.y) > 40) return;
        const e = spawnEnemy(w, KINDS[(t / 150 + i) % KINDS.length | 0], x, gy, false);
        e.state = 'chase';
        e.cd = 0;
      });
    }
    m.clear();
    for (const p of w.players) {
      m.set(p.id, input(w.tick, p.id));
      if (w.net) setLag(w.net, p.id, lagFor(t, p.id));
    }
    stepWorld(w, m);
    for (const ev of w.events) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    evs.push(JSON.stringify(w.events));
    w.events.length = 0;
  }
  return { evs, w, counts };
}
{
  const ref = coopGame(false, () => 0);
  const zero = coopGame(true, () => 0);
  let diff = -1;
  for (let i = 0; i < ref.evs.length; i++) if (ref.evs[i] !== zero.evs[i]) {
    diff = i;
    break;
  }
  const c = ref.counts;
  check(
    'L = 0 : mêmes événements que sans w.net sur 3000 ticks de coop scriptée',
    diff < 0,
    diff < 0 ? `${c.hit ?? 0} hit, ${c.playerHit ?? 0} playerHit, ${c.parry ?? 0} parry, ${c.kill ?? 0} kill` : `écart au tick ${diff}`,
  );
  check('… la partie contient bien des échanges de coups', (c.hit ?? 0) > 20 && (c.playerHit ?? 0) > 5 && (c.kill ?? 0) > 5);
  const strip = (w: World) => JSON.stringify(w.players.map((p) => [p.x, p.y, p.hp, p.state])) + JSON.stringify(w.enemies.map((e) => [e.id, e.x, e.y, e.hp, e.state]));
  check('… et le même état final (joueurs, ennemis)', strip(ref.w) === strip(zero.w));
  check('le solo n’a jamais de w.net (clé absente du JSON)', !('net' in createWorld(5)) && !JSON.stringify(createWorld(5)).includes('"net"'));

  // Retards variables (0..25, changeants) : aucune exception, état fini, frappes purgées.
  let err = '';
  let g: ReturnType<typeof coopGame> | null = null;
  try {
    g = coopGame(true, (t, pid) => ((t >> 6) * 7 + pid * 5) % 26);
  } catch (x) {
    err = String((x as Error)?.stack ?? x);
  }
  check('retards variables sur 3000 ticks : aucune exception', err === '', err.slice(0, 300));
  if (g) {
    const net = g.w.net!;
    const ok = g.w.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const oldest = net.strikes.length ? net.strikes[0].tick : g.w.tick;
    check('… état fini et historique des frappes borné', ok && g.w.tick - oldest <= MAX_REWIND_TICKS + 1, `${net.strikes.length} frappe(s) en attente`);
    const gc = g.counts;
    check('… la partie compensée reste jouable (coups, touches, parades)', (gc.hit ?? 0) > 20 && (gc.playerHit ?? 0) > 0, `${gc.hit ?? 0} hit, ${gc.playerHit ?? 0} playerHit, ${gc.parry ?? 0} parry`);
  }
}

// ─── 7. Cas limites (QA) ────────────────────────────────────────────────────
/**
 * Un ennemi de mêlée attaque en boucle un joueur immobile, maintenu dans sa zone de frappe.
 * `lagAt(S)` donne le retard du joueur à chaque pas. Compte les attaques (passages en 'attack', shurikens lancés),
 * les playerHit, et le maximum de touches attribuées à une même attaque.
 */
function meleeLoop(type: EnemyType, lagAt: (S: number) => number, ticks: number, dx = 50): { attacks: number; hits: number; maxPerAttack: number; err: string } {
  const { w, ps } = arena(1, true);
  const p = ps[0];
  p.facing = 1;
  const e = spawnEnemy(w, type, p.x + dx, p.y, false);
  e.hp = e.maxHp = 1e7;
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  let attacks = 0;
  let hits = 0;
  let maxPerAttack = 0;
  let cur = 0;
  let prevState = '';
  let err = '';
  const x0 = p.x;
  try {
    for (let i = 0; i < ticks; i++) {
      setLag(w.net!, p.id, lagAt(w.tick));
      p.hp = p.maxHp;
      if (p.state !== 'dead') {
        p.x = x0; // le joueur ne recule pas : chaque attaque peut toucher
        p.vx = 0;
      }
      stepWorld(w, new Map([[p.id, 0]]));
      const st = eState(e);
      if (st === 'attack' && prevState !== 'attack') {
        attacks++;
        cur = 0;
      }
      prevState = st;
      for (const ev of w.events) {
        // Ninja : chaque shuriken lancé est une attaque.
        if (ev.type === 'throw') {
          attacks++;
          cur = 0;
        }
        if (ev.type !== 'playerHit') continue;
        hits++;
        cur++;
        maxPerAttack = Math.max(maxPerAttack, cur);
      }
      w.events.length = 0;
    }
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  return { attacks, hits, maxPerAttack, err };
}
{
  // 7a. Retard qui chute brutalement après une frappe différée : pas de trou.
  // Le lancier frappe pendant que L = 17 ; L passe à 0 dès la fin de sa fenêtre active.
  const { w, ps } = arena(1, true);
  const p = ps[0];
  p.facing = 1;
  const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  setLag(w.net!, p.id, 17);
  let dropped = -1;
  let once = false;
  const evs = step(w, 200, () => 0, (S) => {
    if (eState(e) === 'recover' || eState(e) === 'stunned') once = true;
    if (once) e.cd = 1e9;
    if (eState(e) === 'recover' && dropped < 0) {
      dropped = S;
      setLag(w.net!, p.id, 0);
    }
  });
  const n = evs.filter((ev) => ev.type === 'playerHit').length;
  check('L 17 → 0 juste après la frappe : la frappe différée est quand même jugée (pas de trou)', dropped > 0 && n === 1, `${n} playerHit, chute au tick ${dropped}`);
}
{
  // 7b. Retard qui oscille (0 → 20 → 0…) : jamais deux touches pour une attaque, aucune perdue.
  const scheds: [string, (S: number) => number][] = [
    ['constant 20', () => 20],
    ['0/20 tous les 7 ticks', (S) => (((S / 7) | 0) % 2 ? 20 : 0)],
    ['0/20 tous les 3 ticks', (S) => (((S / 3) | 0) % 2 ? 20 : 0)],
    ['dents de scie 20→0', (S) => 20 - (S % 21)],
    ['pseudo-aléatoire 0..20', (S) => (Math.imul(S, 2654435761) >>> 27) % 21],
  ];
  for (const type of ['ashigaru', 'oni', 'ninja'] as EnemyType[]) {
    const ref = meleeLoop(type, () => 0, 3000);
    check(`${type}, L = 0 (référence) : une touche par attaque`, !ref.err && ref.attacks > 5 && ref.maxPerAttack <= 1, ref.err || `${ref.hits}/${ref.attacks}`);
    for (const [name, f] of scheds) {
      const r = meleeLoop(type, f, 3000);
      check(
        `${type}, retard ${name} : ≤ 1 touche par attaque, aucune perdue`,
        !r.err && r.attacks > 5 && r.maxPerAttack <= 1 && r.hits <= r.attacks && r.hits >= ref.hits - 1,
        r.err || `${r.attacks} attaques, ${r.hits} touches (réf. L = 0 : ${ref.hits}/${ref.attacks}), max ${r.maxPerAttack}/attaque`,
      );
    }
  }
}
{
  // 7c. Ennemi tué entre l'enregistrement de sa frappe et son jugement : la frappe n'a plus d'effet.
  const { w, ps } = arena(1, true);
  const p = ps[0];
  p.facing = 1;
  setLag(w.net!, p.id, 15);
  const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  let killedAt = -1;
  const evs = step(w, 150, () => 0, (S) => {
    if (killedAt < 0 && w.net!.strikes.length > 0) {
      killedAt = S;
      killEnemy(w, e, p, 0, false);
    }
  });
  const n = evs.filter((ev) => ev.type === 'playerHit').length;
  check('ennemi tué avant le jugement différé : aucune touche', killedAt > 0 && n === 0, `${n} playerHit, tué au tick ${killedAt}`);
}
{
  // 7d. Joueur parti avec des frappes en attente : aucune exception, l'autre joueur reste jugé.
  const { w, ps } = arena(2, true);
  ps[1].x = ps[0].x + 4;
  ps[1].y = ps[0].y;
  setLag(w.net!, ps[0].id, 18);
  setLag(w.net!, ps[1].id, 6);
  const e = spawnEnemy(w, 'ashigaru', ps[0].x + 60, ps[0].y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  let left = -1;
  let err = '';
  let evs: GameEvent[] = [];
  let once = false;
  try {
    evs = step(w, 150, () => 0, (S) => {
      if (eState(e) === 'recover') once = true;
      if (once) e.cd = 1e9;
      if (left < 0 && w.net!.strikes.length > 0) {
        left = S;
        removePlayer(w, ps[0].id);
        forgetPlayer(w.net!, ps[0].id);
      }
    });
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  const on0 = evs.filter((ev) => ev.type === 'playerHit' && ev.pid === ps[0].id).length;
  const on1 = evs.filter((ev) => ev.type === 'playerHit' && ev.pid === ps[1].id).length;
  check('joueur parti avec des frappes différées : aucune exception', !err && left > 0, err);
  check('… aucune touche sur le joueur parti, l’autre (L = 6) touché une fois', on0 === 0 && on1 === 1, `parti ${on0}, resté ${on1}`);
}
{
  // 7e. Fantôme paré le pas même où il s'éteint (fin de vie) : jamais en double dans w.projectiles.
  // Balayage : durée de vie × instant de la parade. Le joueur est éloigné du bord gauche du niveau
  // pour que le shuriken s'éteigne en fin de vie et non contre le mur derrière lui.
  let dup = 0;
  let parried = 0;
  let sameStep = 0;
  for (let life = 2; life <= 50; life++) {
    for (let pa = 0; pa <= 60; pa++) {
      const { w, ps } = arena(1, true);
      const p = ps[0];
      p.x += 480;
      step(w, 40);
      p.iframes = 0;
      setLag(w.net!, p.id, 17);
      p.facing = 1;
      w.projectiles.push({ id: w.nextId++, kind: 'shuriken', x: p.x + 160, y: p.y - 14, vx: -600, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life, hits: [], dead: false });
      const P0 = w.tick;
      for (let i = 0; i < 70; i++) {
        const ghosts = w.net!.ghosts.length;
        stepWorld(w, new Map([[p.id, w.tick - P0 === pa ? BTN.PARRY : 0]]));
        if (w.events.some((ev) => ev.type === 'parry')) {
          parried++;
          if (ghosts === 0 && w.events.some((ev) => ev.type === 'arrowBreak') === false && w.projectiles.length > 0 && life === i + 1) sameStep++;
        }
        w.events.length = 0;
        if (new Set(w.projectiles).size !== w.projectiles.length || new Set(w.projectiles.map((a) => a.id)).size !== w.projectiles.length) {
          dup++;
          break;
        }
      }
    }
  }
  check('fantôme renvoyé le pas même de son extinction : jamais deux fois dans w.projectiles', dup === 0 && sameStep > 0, `${dup} doublon(s), ${parried} parade(s), ${sameStep} le pas de l’extinction`);
}
{
  // 7f. Changement d'étape avec un historique rempli : rien de l'ancien niveau n'est jugé.
  // Un shuriken s'éteint à l'endroit du départ de l'étape suivante, puis nextStage ; le joueur
  // en retard pare juste après : rien ne doit être renvoyé ni subi de l'ancien niveau.
  const probe = createWorld(31, { mode: 'coop' });
  nextStage(probe);
  const spawn = { ...probe.level.spawn };
  let revived = 0;
  let touched = 0;
  for (let pa = 0; pa <= 24; pa++) {
    const { w, ps } = arena(1, true);
    const p = ps[0];
    setLag(w.net!, p.id, 20);
    const id = w.nextId++;
    w.projectiles.push({ id, kind: 'shuriken', x: spawn.x + 4, y: spawn.y - 14, vx: 0, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life: 3, hits: [], dead: false });
    step(w, 4);
    nextStage(w);
    p.iframes = 0;
    p.facing = 1;
    const P0 = w.tick;
    const evs = step(w, 30, (S) => (S - P0 === pa ? BTN.PARRY : 0));
    if (w.projectiles.some((a) => a.id === id)) revived++;
    if (evs.some((ev) => ev.type === 'playerHit' || ev.type === 'parry')) touched++;
  }
  check('nextStage : aucun projectile de l’ancien niveau renvoyé ni jugé dans le nouveau', revived === 0 && touched === 0, `${revived} ressuscité(s), ${touched} touche/parade`);
  // Frappes différées de l'ancien niveau : oubliées au changement d'étape.
  const { w, ps } = arena(1, true);
  const p = ps[0];
  setLag(w.net!, p.id, 20);
  const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  for (let i = 0; i < 200 && !w.net!.strikes.length; i++) step(w, 1);
  const had = w.net!.strikes.length;
  nextStage(w);
  const after = step(w, 25);
  check(
    'nextStage : frappes différées de l’ancien niveau oubliées',
    had > 0 && w.net!.strikes.length === 0 && !after.some((ev) => ev.type === 'playerHit'),
    `${had} → ${w.net!.strikes.length} frappe(s)`,
  );
}
{
  // 7g. Boss : balayage au contact, charge et saut (slam) à distance, avec retard : ≤ 1 touche par attaque.
  for (const lag of [0, 9, 20]) {
    const near = meleeLoop('boss', () => lag, 4000, 70);
    const far = meleeLoop('boss', () => lag, 4000, 320);
    check(`boss, L = ${lag}, au contact : ≤ 1 touche par attaque`, !near.err && near.attacks > 3 && near.maxPerAttack <= 1 && near.hits > 0, near.err || `${near.attacks} attaques, ${near.hits} touches`);
    check(`boss, L = ${lag}, à distance (charge, saut) : ≤ 1 touche par attaque`, !far.err && far.attacks > 3 && far.maxPerAttack <= 1 && far.hits > 0, far.err || `${far.attacks} attaques, ${far.hits} touches`);
  }
}
{
  // 7h. Mort puis renaissance pendant le délai : la frappe d'avant la mort touche au plus une fois.
  const { w, ps } = arena(2, true);
  const [a, b] = ps;
  b.x = a.x + 4;
  b.y = a.y;
  setLag(w.net!, a.id, 20);
  setLag(w.net!, b.id, 20);
  const e = spawnEnemy(w, 'ashigaru', a.x + 60, a.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  let deathAt = -1;
  let once = false;
  let err = '';
  let evs: GameEvent[] = [];
  try {
    evs = step(w, 400, () => 0, (S) => {
      if (eState(e) === 'recover') once = true;
      if (once) e.cd = 1e9;
      if (deathAt < 0 && w.net!.strikes.length) {
        deathAt = S;
        a.hp = 0;
        a.state = 'dead';
        a.respawnT = 1; // renaissance immédiate (cas le plus défavorable)
      }
    });
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  const all = evs.filter((ev) => ev.type === 'playerHit').length;
  check('mort et renaissance pendant le délai : aucune exception, au plus une touche pour la frappe', !err && deathAt > 0 && all <= 1, err || `${all} touche(s)`);
}
{
  // 7i. Aspiration dans l'arène avec une frappe différée en attente : pas de touche fantôme à l'entrée.
  const { w, ps } = arena(2, true);
  const [a, b] = ps;
  setLag(w.net!, a.id, 20);
  a.facing = 1;
  const e = spawnEnemy(w, 'ashigaru', a.x + 60, a.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  let pulledAt = -1;
  let err = '';
  let evs: GameEvent[] = [];
  const x0 = a.x;
  try {
    evs = step(w, 300, (_S, q) => (q === b && pulledAt >= 0 ? BTN.RIGHT : 0), (S) => {
      if (pulledAt < 0 && w.net!.strikes.some((st) => st.enemy === e)) {
        pulledAt = S;
        warpToArena(w, b.id); // b entre dans l'arène : a est aspiré à l'entrée
      }
      if (eState(e) === 'recover') e.cd = 1e9;
    });
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  const onA = evs.filter((ev) => (ev.type === 'playerHit' || ev.type === 'parry') && ev.pid === a.id).length;
  check(
    'aspiration dans l’arène avec une frappe en attente : aucune exception, aucune touche à l’entrée',
    !err && pulledAt > 0 && w.stage.state === 'arena' && Math.abs(a.x - x0) > 300 && onA === 0,
    err || `${onA} touche(s), état ${w.stage.state}, déplacé de ${Math.round(a.x - x0)} px`,
  );
}
{
  // 7j. Fantôme tranché par un coup (joueur en retard) : renvoyé une seule fois, jamais en double,
  // et jamais à la fois tranché et encaissé.
  let deflects = 0;
  let both = 0;
  let dup = 0;
  let err = '';
  try {
    for (let life = 8; life <= 30; life++) {
      for (let at = 0; at <= 30; at++) {
        const { w, ps } = arena(1, true);
        const p = ps[0];
        p.x += 480;
        step(w, 40);
        p.iframes = 0;
        p.facing = 1;
        setLag(w.net!, p.id, 17);
        const id = w.nextId++;
        w.projectiles.push({ id, kind: 'shuriken', x: p.x + 200, y: p.y - 30, vx: -600, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life, hits: [], dead: false });
        const P0 = w.tick;
        const evs = step(w, 80, (S) => (S - P0 === at ? BTN.ATTACK : 0));
        const d = evs.some((ev) => ev.type === 'deflect');
        const h = evs.some((ev) => ev.type === 'playerHit');
        if (d) deflects++;
        if (d && h) both++;
        if (new Set(w.projectiles).size !== w.projectiles.length || w.projectiles.filter((a) => a.id === id).length > 1) dup++;
      }
    }
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  check('fantôme tranché (L = 17) : renvoyé sans doublon, jamais tranché et encaissé', !err && deflects > 0 && both === 0 && dup === 0, err || `${deflects} renvoi(s), ${both} double(s) effet(s), ${dup} doublon(s)`);
}

// ─── 8. Plafond relevé : retards de 25 à MAX_REWIND_TICKS (QA) ──────────────
const LMAX = MAX_REWIND_TICKS;
check(`plafond de la compensation ≥ 30 ticks (${LMAX})`, LMAX >= 30);
{
  // 8a. Oscillations et dents de scie jusqu'au plafond : ≤ 1 touche par attaque, aucune perdue.
  const scheds: [string, (S: number) => number][] = [
    ['constant 25', () => 25],
    [`constant ${LMAX}`, () => LMAX],
    [`0/${LMAX} tous les 7 ticks`, (S) => (((S / 7) | 0) % 2 ? LMAX : 0)],
    [`0/${LMAX} tous les 3 ticks`, (S) => (((S / 3) | 0) % 2 ? LMAX : 0)],
    [`0/${LMAX} à chaque tick`, (S) => (S % 2 ? LMAX : 0)],
    [`dents de scie ${LMAX}→0`, (S) => LMAX - (S % (LMAX + 1))],
    [`dents de scie 0→${LMAX}`, (S) => S % (LMAX + 1)],
    [`25/${LMAX} tous les 5 ticks`, (S) => (((S / 5) | 0) % 2 ? LMAX : 25)],
    [`pseudo-aléatoire 0..${LMAX}`, (S) => (Math.imul(S, 2654435761) >>> 26) % (LMAX + 1)],
  ];
  for (const type of ['ashigaru', 'oni', 'ninja'] as EnemyType[]) {
    const ref = meleeLoop(type, () => 0, 3000);
    for (const [name, f] of scheds) {
      const r = meleeLoop(type, f, 3000);
      check(
        `${type}, retard ${name} : ≤ 1 touche par attaque, aucune perdue`,
        !r.err && r.attacks > 5 && r.maxPerAttack <= 1 && r.hits <= r.attacks && r.hits >= ref.hits - 1,
        r.err || `${r.attacks} attaques, ${r.hits} touches (réf. L = 0 : ${ref.hits}/${ref.attacks}), max ${r.maxPerAttack}/attaque`,
      );
    }
  }
  for (const lag of [25, LMAX]) {
    const near = meleeLoop('boss', () => lag, 4000, 70);
    const far = meleeLoop('boss', () => lag, 4000, 320);
    check(`boss, L = ${lag}, au contact : ≤ 1 touche par attaque`, !near.err && near.attacks > 3 && near.maxPerAttack <= 1 && near.hits > 0, near.err || `${near.attacks} attaques, ${near.hits} touches`);
    check(`boss, L = ${lag}, à distance (charge, saut) : ≤ 1 touche par attaque`, !far.err && far.attacks > 3 && far.maxPerAttack <= 1 && far.hits > 0, far.err || `${far.attacks} attaques, ${far.hits} touches`);
  }
  const osc = meleeLoop('boss', (S) => (((S / 4) | 0) % 2 ? LMAX : 0), 4000, 70);
  check(`boss, retard 0/${LMAX} tous les 4 ticks : ≤ 1 touche par attaque`, !osc.err && osc.attacks > 3 && osc.maxPerAttack <= 1 && osc.hits > 0, osc.err || `${osc.attacks} attaques, ${osc.hits} touches`);
}
{
  // 8b. Parade d'une frappe et d'un shuriken vus à l'écran, L = 25 et L = plafond.
  let kTick = -1;
  {
    const { w, ps } = arena(1, false);
    const p = ps[0];
    p.facing = 1;
    const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
    e.facing = -1;
    e.state = 'chase';
    e.cd = 0;
    for (let i = 0; i < 200 && kTick < 0; i++) {
      const S = w.tick;
      stepWorld(w, new Map());
      if (w.events.some((ev) => ev.type === 'playerHit')) kTick = S;
      w.events.length = 0;
    }
  }
  const shRef = shurikenScenario(null, null);
  for (const L of [25, LMAX]) {
    const ok = spearScenario(L, kTick + L - 2);
    check(`L = ${L} : parade lancée à l’écran avant l’impact → parry, lancier étourdi`, ok.evs.some((ev) => ev.type === 'parry') && !ok.evs.some((ev) => ev.type === 'playerHit') && ok.stunned);
    const none = spearScenario(L, null);
    const n = none.evs.filter((ev) => ev.type === 'playerHit').length;
    check(`L = ${L} sans parade : la frappe touche une seule fois`, n === 1, `${n}`);
    const early = spearScenario(L, kTick + L - 14);
    check(`L = ${L} : parade trop tôt → playerHit`, early.evs.some((ev) => ev.type === 'playerHit') && !early.evs.some((ev) => ev.type === 'parry'));
    const sh = shurikenScenario(L, shRef.hitTick + L - 2);
    check(`projectile, L = ${L} : parade avant l’impact vu → parry, renvoyé`, sh.evs.some((ev) => ev.type === 'parry') && !sh.evs.some((ev) => ev.type === 'playerHit') && sh.w.projectiles.some((a) => a.kind === 'shuriken' && a.owner === 'player'));
    const shLate = shurikenScenario(L, null);
    const m = shLate.evs.filter((ev) => ev.type === 'playerHit').length;
    check(`projectile, L = ${L} sans parade : touché une seule fois`, m === 1, `${m}`);
  }
}
{
  // 8c. Fantômes à L = plafond : renvoyés au plus une fois, jamais en double, jamais tranchés et encaissés.
  let dup = 0;
  let parried = 0;
  let both = 0;
  let err = '';
  try {
    for (let life = 2; life <= 50; life += 2) {
      for (let pa = 0; pa <= 75; pa += 3) {
        for (const btn of [BTN.PARRY, BTN.ATTACK]) {
          const { w, ps } = arena(1, true);
          const p = ps[0];
          p.x += 480;
          step(w, 40);
          p.iframes = 0;
          setLag(w.net!, p.id, LMAX);
          p.facing = 1;
          const id = w.nextId++;
          w.projectiles.push({ id, kind: 'shuriken', x: p.x + 160, y: p.y - (btn === BTN.ATTACK ? 30 : 14), vx: -600, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life, hits: [], dead: false });
          const P0 = w.tick;
          const evs = step(w, 90, (S) => (S - P0 === pa ? btn : 0), () => {
            if (new Set(w.projectiles).size !== w.projectiles.length || w.projectiles.filter((a) => a.id === id).length > 1) dup++;
          });
          const back = evs.filter((ev) => ev.type === 'parry' || ev.type === 'deflect').length;
          const hit = evs.filter((ev) => ev.type === 'playerHit').length;
          if (back) parried++;
          if ((back && hit) || back > 1 || hit > 1) both++;
        }
      }
    }
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  check(`fantômes, L = ${LMAX} : renvoyés sans doublon, jamais renvoyé et encaissé`, !err && parried > 0 && dup === 0 && both === 0, err || `${parried} renvoi(s), ${dup} doublon(s), ${both} double(s) effet(s)`);
}
{
  // 8d. Changement d'étape à L = plafond : rien de l'ancien niveau n'est jugé.
  const probe = createWorld(31, { mode: 'coop' });
  nextStage(probe);
  const spawn = { ...probe.level.spawn };
  let revived = 0;
  let touched = 0;
  for (let pa = 0; pa <= LMAX + 6; pa++) {
    const { w, ps } = arena(1, true);
    const p = ps[0];
    setLag(w.net!, p.id, LMAX);
    const id = w.nextId++;
    w.projectiles.push({ id, kind: 'shuriken', x: spawn.x + 4, y: spawn.y - 14, vx: 0, vy: 0, owner: 'enemy', ownerId: 0, damage: 8, life: 3, hits: [], dead: false });
    step(w, 4);
    nextStage(w);
    p.iframes = 0;
    p.facing = 1;
    const P0 = w.tick;
    const evs = step(w, LMAX + 12, (S) => (S - P0 === pa ? BTN.PARRY : 0));
    if (w.projectiles.some((a) => a.id === id)) revived++;
    if (evs.some((ev) => ev.type === 'playerHit' || ev.type === 'parry')) touched++;
  }
  check(`nextStage, L = ${LMAX} : aucun projectile de l’ancien niveau renvoyé ni jugé`, revived === 0 && touched === 0, `${revived} ressuscité(s), ${touched} touche/parade`);
  const { w, ps } = arena(1, true);
  const p = ps[0];
  setLag(w.net!, p.id, LMAX);
  const e = spawnEnemy(w, 'ashigaru', p.x + 60, p.y, false);
  e.facing = -1;
  e.state = 'chase';
  e.cd = 0;
  for (let i = 0; i < 200 && !w.net!.strikes.length; i++) step(w, 1);
  const had = w.net!.strikes.length;
  nextStage(w);
  const after = step(w, LMAX + 5);
  check(`nextStage, L = ${LMAX} : frappes différées oubliées`, had > 0 && w.net!.strikes.length === 0 && !after.some((ev) => ev.type === 'playerHit'), `${had} → ${w.net!.strikes.length}`);
}
{
  // 8e. Mort puis renaissance pendant un délai de 30 ticks : au plus une touche pour la frappe.
  for (const respawn of [1, 10, 25]) {
    const { w, ps } = arena(2, true);
    const [a, b] = ps;
    b.x = a.x + 4;
    b.y = a.y;
    setLag(w.net!, a.id, LMAX);
    setLag(w.net!, b.id, LMAX);
    const e = spawnEnemy(w, 'ashigaru', a.x + 60, a.y, false);
    e.facing = -1;
    e.state = 'chase';
    e.cd = 0;
    let deathAt = -1;
    let once = false;
    let err = '';
    let evs: GameEvent[] = [];
    try {
      evs = step(w, 400, () => 0, (S) => {
        if (eState(e) === 'recover') once = true;
        if (once) e.cd = 1e9;
        if (deathAt < 0 && w.net!.strikes.length) {
          deathAt = S;
          a.hp = 0;
          a.state = 'dead';
          a.respawnT = respawn;
        }
      });
    } catch (x) {
      err = String((x as Error)?.stack ?? x).slice(0, 300);
    }
    const all = evs.filter((ev) => ev.type === 'playerHit').length;
    check(`L = ${LMAX}, mort et renaissance (${respawn} tick(s)) pendant le délai : au plus une touche`, !err && deathAt > 0 && all <= 1, err || `${all} touche(s)`);
  }
}
{
  // 8f. Partie coop de 4000 ticks, retards 0..plafond (oscillations brutales, dents de scie) :
  // historique borné à chaque pas (frappes, fantômes), état fini, partie jouable.
  const w = createWorld(2024, { mode: 'coop' });
  w.net = createLagComp();
  for (let i = 0; i < 4; i++) addPlayer(w, 'p' + i, { color: i });
  const input = scripted(77);
  const lagAt = (t: number, i: number): number =>
    i === 0 ? LMAX : i === 1 ? (((t / 3) | 0) % 2 ? LMAX : 0) : i === 2 ? LMAX - (t % (LMAX + 1)) : (Math.imul(t, 2654435761) >>> 26) % (LMAX + 1);
  const m = new Map<number, number>();
  const counts: Record<string, number> = {};
  let maxStrikeAge = 0;
  let maxGhostAge = 0;
  let maxStrikes = 0;
  let err = '';
  try {
    for (let t = 0; t < 4000; t++) {
      if (t % 120 === 0) for (const p of w.players) if (p.state !== 'dead') p.hp = p.maxHp;
      if (t % 150 === 75) {
        w.players.forEach((p, i) => {
          if (p.state === 'dead') return;
          const x = p.x + (i % 2 ? -1 : 1) * (90 + 20 * i);
          const gy = findGround(w.level, x, p.y, 2);
          if (gy === null || Math.abs(gy - p.y) > 40) return;
          const e = spawnEnemy(w, KINDS[(t / 150 + i) % KINDS.length | 0], x, gy, false);
          e.state = 'chase';
          e.cd = 0;
        });
      }
      m.clear();
      w.players.forEach((p, i) => {
        m.set(p.id, input(w.tick, p.id));
        setLag(w.net!, p.id, lagAt(t, i));
      });
      stepWorld(w, m);
      for (const ev of w.events) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
      w.events.length = 0;
      const net = w.net!;
      maxStrikes = Math.max(maxStrikes, net.strikes.length);
      for (const st of net.strikes) maxStrikeAge = Math.max(maxStrikeAge, w.tick - st.tick);
      for (const g of net.ghosts) maxGhostAge = Math.max(maxGhostAge, w.tick - g.tick);
    }
  } catch (x) {
    err = String((x as Error)?.stack ?? x).slice(0, 300);
  }
  check(`coop 4000 ticks, retards 0..${LMAX} : aucune exception`, !err, err);
  const finite = w.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) && w.enemies.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y));
  check('… état fini', finite);
  check(`… historique borné à chaque pas : frappes et fantômes de moins de ${LMAX + 1} ticks`, maxStrikeAge <= LMAX && maxGhostAge <= LMAX, `âge max frappes ${maxStrikeAge}, fantômes ${maxGhostAge}, ${maxStrikes} frappe(s) en attente au plus`);
  check('… anneau de taille plafond + 1', w.net!.ring.length === LMAX + 1);
  check('… partie jouable (coups, touches)', (counts.hit ?? 0) > 20 && (counts.playerHit ?? 0) > 0, `${counts.hit ?? 0} hit, ${counts.playerHit ?? 0} playerHit, ${counts.parry ?? 0} parry`);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de compensation de latence passent.');
