// Tests de la compensation de latence (attaque rembobinée, défense retardée).
// Lancer : npm run test:lagcomp
import { findGround, spawnEnemy } from '../shared/enemy';
import { BTN } from '../shared/input';
import { createLagComp, lagOf, setLag } from '../shared/lagcomp';
import { Rng } from '../shared/math';
import { MAX_REWIND_TICKS } from '../shared/net/protocol';
import type { Enemy, EnemyType, GameEvent, Player, World } from '../shared/types';
import { addPlayer, createWorld, stepWorld } from '../shared/world';

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
  const max = dummyScenario(25, (A) => A - 10);
  check(`L demandé 25 → borné à ${MAX_REWIND_TICKS} : chevauchement vu 14 ticks avant, touché`, max.hits === 1, `${max.hits} coup(s)`);
  const far = dummyScenario(25, (A) => A - 15);
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

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de compensation de latence passent.');
