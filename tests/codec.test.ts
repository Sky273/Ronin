// Tests du codec compact des instantanés (aller-retour, précision, taille).
// Lancer : npm run test:codec
import { pack, unpack } from 'msgpackr';
import { BTN } from '../shared/input';
import { Rng } from '../shared/math';
import {
  AGE_MAX,
  ATTACK_IDS,
  decodeSnapshot,
  ENEMY_MOVES,
  ENEMY_TYPES,
  encodeSnapshot,
  EVENT_KEYS,
  EVENT_TYPES,
  UPGRADE_TABLE,
  SELF_KEYS,
  type SnapshotWire,
} from '../shared/net/codec';
import { ENEMY_VIEW_KEYS, PLAYER_VIEW_KEYS, SNAP_EVERY, type Snapshot } from '../shared/net/protocol';
import { makeSnapshot, snapshotFor } from '../shared/net/snapshot';
import { createEnemy } from '../shared/enemy';
import { createPlayer } from '../shared/player';
import type { Enemy, EnemyType, GameEvent, Orb, Player, Projectile, World } from '../shared/types';
import { addPlayer, createWorld, stepWorld } from '../shared/world';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Aller-retour par le vrai encodage réseau (msgpack). */
const roundTrip = (w: SnapshotWire): Snapshot => decodeSnapshot(unpack(pack(w)) as SnapshotWire);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Égalité profonde : NaN égal à NaN ; 0 et -0 confondus (msgpack transmet -0 comme l'entier 0).
 * Renvoie le chemin de la première différence, ou '' si égal.
 */
function diff(a: unknown, b: unknown, path = ''): string {
  if (typeof a === 'number' && typeof b === 'number') return a === b || (a !== a && b !== b) ? '' : `${path}: ${a} ≠ ${b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? '' : `${path}: ${String(a)} ≠ ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: tableau ≠ objet`;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${path}: clés [${ka}] ≠ [${kb}]`;
  for (const k of ka) {
    const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return '';
}

/** Entrées scriptées pseudo-aléatoires (déterministes) : un appui tenu quelques dizaines de ticks. */
function scripted(seed: number, n: number): (i: number, t: number) => number {
  const rng = new Rng(seed);
  const MOVES = [
    0, BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.RIGHT | BTN.JUMP, BTN.JUMP, BTN.ATTACK, BTN.RIGHT | BTN.ATTACK,
    BTN.UP | BTN.ATTACK, BTN.PARRY, BTN.DASH | BTN.RIGHT, BTN.DOWN, BTN.DOWN | BTN.RIGHT, BTN.IAI, BTN.PICK1, BTN.JUMP | BTN.DOWN | BTN.ATTACK,
  ];
  const held = Array.from({ length: n }, () => ({ b: 0, until: 0, pulse: 0 }));
  return (i, t) => {
    const h = held[i];
    if (t >= h.until) {
      h.b = MOVES[Math.floor(rng.next() * MOVES.length)];
      h.until = t + 8 + Math.floor(rng.next() * 50);
      h.pulse = 2 + Math.floor(rng.next() * 12);
    }
    // Les actions sont des appuis répétés (relâchés un tick sur `pulse`), les déplacements sont tenus.
    const actions = BTN.JUMP | BTN.ATTACK | BTN.PARRY | BTN.DASH | BTN.PICK1;
    return t % h.pulse === 0 ? h.b & ~actions : h.b;
  };
}

function stepAll(w: World, input: (i: number, t: number) => number, t: number, out: GameEvent[]): void {
  const m = new Map<number, number>();
  w.players.forEach((p, i) => m.set(p.id, input(i, t)));
  stepWorld(w, m);
  for (const ev of w.events) out.push(ev);
  w.events.length = 0;
}

// 1. SELF_KEYS couvre exactement les champs de Player.
{
  const keys = Object.keys(createPlayer(1, 'x', 0, 0)).sort();
  const self = [...SELF_KEYS].sort();
  const missing = keys.filter((k) => !self.includes(k as (typeof SELF_KEYS)[number]));
  const extra = self.filter((k) => !keys.includes(k));
  check('SELF_KEYS : tous les champs de createPlayer, sans doublon ni champ en trop', !missing.length && !extra.length && new Set(SELF_KEYS).size === SELF_KEYS.length, `manquants [${missing}] en trop [${extra}]`);
}

// 2. self : exact après pack/unpack (NaN, offre d'amélioration, hitList, attaques).
{
  const w = createWorld(11, { mode: 'coop' });
  const a = addPlayer(w, 'Ayame', { color: 4 });
  addPlayer(w, 'Benkei', { color: 6 });
  const input = scripted(5, 2);
  const evs: GameEvent[] = [];
  for (let t = 0; t < 400; t++) stepAll(w, input, t, evs);
  const base = snapshotFor(w, a.id, [], 7);
  const d1 = diff(roundTrip(encodeSnapshot(base)).self, a);
  check('self après une partie : deepEqual exact', d1 === '' && Number.isNaN(a.lostX) === Number.isNaN(base.self!.lostX), d1);

  const p: Player = { ...a, up: { ...a.up }, offer: ['edge', 'iai', 'storm'], hitList: [3, 17, 42], lostX: NaN, lostY: NaN, attack: 'slash2', chainNext: 'slash3', state: 'attack', vx: 123.456789, iaiFrom: 1.0e-7 };
  p.up.edge = 2;
  p.up.magnet = 1;
  const got = roundTrip(encodeSnapshot({ ...base, self: p })).self!;
  const d2 = diff(got, p);
  check('self avec NaN, offre et hitList : deepEqual exact', d2 === '' && Number.isNaN(got.lostX) && Number.isNaN(got.lostY) && got.offer.join() === 'edge,iai,storm' && got.hitList.join() === '3,17,42', d2);
  check('self décodé indépendant de l’original', got !== p && got.hitList !== p.hitList && got.up !== p.up && got.offer !== p.offer);
  const q: Player = { ...p, lostX: 812.5, lostY: 640.25, offer: [], attack: null, chainNext: null };
  const d3 = diff(roundTrip(encodeSnapshot({ ...base, self: q })).self, q);
  check('self sans offre, honneur perdu posé : deepEqual exact', d3 === '', d3);
  const nul = roundTrip(encodeSnapshot({ ...base, self: null }));
  check('self absent (spectateur) : null', nul.self === null);
}

// Comparaisons de vues (tolérances de quantification).
const POS_TOL = 0.5;
const VEL_TOL = 0.5;
const ANG_TOL = 0.01;
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const QUANT_POS = new Set(['x', 'y']);
const QUANT_VEL = new Set(['vx', 'vy']);

function viewDiff<T extends object>(got: T, ref: T, keys: readonly (keyof T)[], t: number): string {
  for (const k of keys) {
    const g = got[k] as unknown;
    const r = ref[k] as unknown;
    const name = String(k);
    if (QUANT_POS.has(name)) {
      if (!near(g as number, r as number, POS_TOL)) return `${name} ${g} / ${r}`;
    } else if (QUANT_VEL.has(name)) {
      if (!near(g as number, r as number, VEL_TOL)) return `${name} ${g} / ${r}`;
    } else if (name === 'aimAng') {
      if (!near(g as number, r as number, ANG_TOL)) return `${name} ${g} / ${r}`;
    } else if (name === 'doubleJumpTick' || name === 'parryTick') {
      // Ancienneté bornée : exacte si récente, sinon « jamais » (-999), l'original étant ancien.
      const ok = t - (r as number) < AGE_MAX ? g === r : g === -999;
      if (!ok) return `${name} ${g} / ${r} (t=${t})`;
    } else if (diff(g, r)) return `${name} ${String(g)} / ${String(r)}`;
  }
  return '';
}

// 3. Taille et précision : 12 joueurs scriptés pendant 3000 ticks, chaque instantané passé par pack().
{
  const N = 12;
  const w = createWorld(23, { mode: 'coop' });
  const ids = Array.from({ length: N }, (_, i) => addPlayer(w, `ronin${i}`, { color: i }).id);
  const input = scripted(17, N);
  let pending: GameEvent[] = [];
  const sizes: number[] = [];
  const errs = { others: '', enemies: '', projectiles: '', orbs: '', same: '' };
  const counts = { others: 0, enemies: 0, projectiles: 0, orbs: 0 };
  let maxPos = 0;
  let maxVel = 0;
  let maxAng = 0;
  let tDirect = 0;
  let tCached = 0;
  let sharedRefs = true;
  for (let t = 0; t < 3000; t++) {
    stepAll(w, input, t, pending);
    if ((t + 1) % SNAP_EVERY) continue;
    // Chemin direct (sans cache) mesuré pour comparaison, dans un ordre alterné pour ne favoriser aucun des deux.
    const ev = pending;
    const runDirect = (): SnapshotWire[] => ids.map((id, i) => encodeSnapshot(snapshotFor(w, id, ev, i)));
    const runCached = (): SnapshotWire[] => ids.map((id, i) => makeSnapshot(w, id, ev, i));
    let direct: SnapshotWire[];
    let wires: SnapshotWire[];
    const t0 = performance.now();
    if (t % 2) direct = runDirect();
    else wires = runCached();
    const t1 = performance.now();
    if (t % 2) wires = runCached();
    else direct = runDirect();
    const t2 = performance.now();
    tDirect += t % 2 ? t1 - t0 : t2 - t1;
    tCached += t % 2 ? t2 - t1 : t1 - t0;
    direct = direct!;
    wires = wires!;
    for (let i = 0; i < N; i++) {
      const bytes = pack(wires[i]);
      sizes.push(bytes.byteLength);
      if (!errs.same && !sameBytes(bytes, pack(direct[i]))) errs.same = `t=${w.tick} joueur ${i}`;
    }
    // Les vues partagées (ennemis) sont les mêmes objets d'un destinataire à l'autre : encodées une fois.
    // (même ennemi chez deux destinataires ⇒ même tuple, par référence)
    const byId = new Map<number, unknown[]>();
    for (const wi of wires) {
      for (const tu of (wi as unknown as unknown[][][])[8]) {
        const prev = byId.get(tu[0] as number);
        if (prev && prev !== tu) sharedRefs = false;
        byId.set(tu[0] as number, tu);
      }
    }

    // Précision (destinataire 0).
    const ref = snapshotFor(w, ids[0], pending, 0);
    const s = roundTrip(wires[0]);
    const ti = s.t;
    s.others.forEach((p, k) => {
      const r = ref.others[k];
      maxPos = Math.max(maxPos, Math.abs(p.x - r.x), Math.abs(p.y - r.y));
      maxVel = Math.max(maxVel, Math.abs(p.vx - r.vx), Math.abs(p.vy - r.vy));
      const d = viewDiff<Player>(p, r, PLAYER_VIEW_KEYS, ti);
      if (d && !errs.others) errs.others = d;
      counts.others++;
    });
    s.enemies.forEach((e, k) => {
      const r = ref.enemies[k];
      maxPos = Math.max(maxPos, Math.abs(e.x - r.x), Math.abs(e.y - r.y));
      maxVel = Math.max(maxVel, Math.abs(e.vx - r.vx), Math.abs(e.vy - r.vy));
      maxAng = Math.max(maxAng, Math.abs(e.aimAng - r.aimAng));
      const d = viewDiff<Enemy>(e, r, ENEMY_VIEW_KEYS, ti);
      if (d && !errs.enemies) errs.enemies = d;
      counts.enemies++;
    });
    s.projectiles.forEach((a, k) => {
      const d = viewDiff<Projectile>(a, ref.projectiles[k], Object.keys(a) as (keyof Projectile)[], ti);
      if (d && !errs.projectiles) errs.projectiles = d;
      counts.projectiles++;
    });
    s.orbs.forEach((o, k) => {
      const d = viewDiff<Orb>(o, ref.orbs[k], Object.keys(o) as (keyof Orb)[], ti);
      if (d && !errs.orbs) errs.orbs = d;
      counts.orbs++;
    });
    if (s.others.length !== ref.others.length || s.enemies.length !== ref.enemies.length) errs.others ||= 'nombre d’entités';
    pending = [];
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
  check('autres joueurs : position ≤ 0,5 px, vitesse ≤ 0,5, champs discrets égaux', !errs.others && counts.others > 0, errs.others || `${counts.others} vues`);
  check('ennemis : position ≤ 0,5 px, vitesse ≤ 0,5, angle ≤ 0,01 rad, champs discrets égaux', !errs.enemies && counts.enemies > 0, errs.enemies || `${counts.enemies} vues`);
  check('projectiles : tous les champs (quantifiés ou égaux)', !errs.projectiles, errs.projectiles || `${counts.projectiles} vues`);
  check('orbes : tous les champs (quantifiés ou égaux)', !errs.orbs, errs.orbs || `${counts.orbs} vues`);
  console.log(`  erreurs maximales : position ${maxPos} px, vitesse ${maxVel} px/s, angle ${maxAng.toFixed(4)} rad`);
  check('cache : octets identiques à l’encodage direct', !errs.same, errs.same);
  check('cache : vues d’ennemis partagées entre destinataires (encodées une fois par tick)', sharedRefs);
  console.log(`  temps d’encodage de 12 instantanés × ${sizes.length / N} : direct ${tDirect.toFixed(0)} ms, avec cache ${tCached.toFixed(0)} ms (×${(tDirect / tCached).toFixed(1)})`);
  check('taille moyenne < 2048 o à 12 joueurs', avg < 2048, `${avg.toFixed(0)} o sur ${sizes.length} instantanés`);
  check('taille p95 < 3072 o à 12 joueurs', p95 < 3072, `${p95} o, max ${sorted[sorted.length - 1]} o`);
}

// 4. Événements : tous les types produits par une partie coop de 6000 ticks font l'aller-retour.
//    Seules les positions (x, y, x0, x1) sont quantifiées au demi-pixel (erreur ≤ 0,25 px).
{
  const w = createWorld(31, { mode: 'coop' });
  for (let i = 0; i < 4; i++) addPlayer(w, `p${i}`, { color: i });
  const input = scripted(99, 4);
  const evs: GameEvent[] = [];
  for (let t = 0; t < 6000; t++) stepAll(w, input, t, evs);
  const base = snapshotFor(w, w.players[0].id, [], 0);
  const got = roundTrip(encodeSnapshot({ ...base, events: evs })).events;
  const POS = new Set(['x', 'y', 'x0', 'x1']);
  let err = got.length === evs.length ? '' : `${got.length} / ${evs.length}`;
  for (let i = 0; i < evs.length && !err; i++) {
    const a = evs[i] as unknown as Record<string, unknown>;
    const b = got[i] as unknown as Record<string, unknown>;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) err = `${a.type} : clés [${ka}] / [${kb}]`;
    for (const k of ka) {
      if (err) break;
      if (POS.has(k) ? !near(a[k] as number, b[k] as number, 0.25) : diff(a[k], b[k])) err = `${a.type}.${k} ${String(a[k])} / ${String(b[k])}`;
    }
  }
  const types = [...new Set(evs.map((e) => e.type))].sort();
  check('événements d’une partie coop de 6000 ticks : aller-retour exact (x, y à 0,25 px)', !err && types.length >= 15, err || `${evs.length} événements, ${types.length} types : ${types.join(' ')}`);

  // pid optionnel : absent en entrée, absent en sortie ; présent, conservé.
  const opt: GameEvent[] = [
    { type: 'hit', x: 10.3, y: 20.7, dir: 1, damage: 2, heavy: false, targetId: 9 },
    { type: 'hit', x: 10, y: 20, dir: -1, damage: 1.5, heavy: true, targetId: 9, pid: 4 },
    { type: 'arenaReset' },
    { type: 'pick', upgrade: 'storm', level: 3, pid: 2 },
    { type: 'windup', id: 5, x: 1, y: 2, enemyType: 'oni', move: 'smash' },
  ];
  const back = roundTrip(encodeSnapshot({ ...base, events: opt })).events;
  check('pid optionnel : absent reste absent, présent conservé', !('pid' in back[0]) && (back[1] as { pid?: number }).pid === 4 && diff(back.slice(2), opt.slice(2)) === '', JSON.stringify(back));

  // Repli : type d'événement et valeurs d'énumération inconnus.
  const weird = [{ type: 'mystery', a: 1, b: 'z' }, { type: 'spawn', x: 4, y: 8, enemyType: 'tengu' }] as unknown as GameEvent[];
  const wb = roundTrip(encodeSnapshot({ ...base, events: weird })).events;
  check('repli : type d’événement et énumération inconnus transmis tels quels', diff(wb, weird) === '', JSON.stringify(wb));
  const oddEnemy = { ...createEnemy(77, 'ninja', 100, 200), type: 'tengu' as EnemyType, move: 'fly' as Enemy['move'], state: 'dance' as Enemy['state'] };
  const oe = roundTrip(encodeSnapshot({ ...base, enemies: [oddEnemy] })).enemies[0];
  check('repli : ennemi de type, état et mouvement inconnus', !!oe && diff([oe.type, oe.move, oe.state], ['tengu', 'fly', 'dance']) === '');

  // QA : chaque type d'événement, toutes clés remplies (valeurs nulles, négatives, fausses, toutes
  // les valeurs d'énumération), puis sans sa dernière clé (tuple raccourci) et sans pid.
  const ENUMS: Record<string, readonly string[]> = { attack: ATTACK_IDS, enemyType: ENEMY_TYPES, move: ENEMY_MOVES, upgrade: UPGRADE_TABLE };
  const POSK = new Set(['x', 'y', 'x0', 'x1']);
  const samples: GameEvent[] = [];
  const VALUES: unknown[] = [0, -3, 7.25, 123456, true, false];
  for (const type of EVENT_TYPES) {
    const keys = EVENT_KEYS[type] as readonly string[];
    const nVar = Math.max(VALUES.length, ...keys.map((k) => ENUMS[k]?.length ?? 0));
    for (let v = 0; v < nVar; v++) {
      const ev: Record<string, unknown> = { type };
      keys.forEach((k, i) => {
        ev[k] = POSK.has(k) ? -40.5 + 1234.5 * v + i : ENUMS[k] ? ENUMS[k][v % ENUMS[k].length] : VALUES[(v + i) % VALUES.length];
      });
      samples.push(ev as unknown as GameEvent);
      if (keys.length) {
        const short = { ...ev };
        delete short[keys[keys.length - 1]];
        samples.push(short as unknown as GameEvent);
      }
      if ('pid' in ev) {
        const nopid = { ...ev };
        delete nopid.pid;
        samples.push(nopid as unknown as GameEvent);
      }
    }
  }
  const back2 = roundTrip(encodeSnapshot({ ...base, events: samples })).events;
  const d = back2.length === samples.length ? diff(back2, samples) : `${back2.length} / ${samples.length}`;
  check(`tous les types d’événements (${EVENT_TYPES.length}), toutes les énumérations : aller-retour exact`, d === '', d);
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests du codec passent.');
