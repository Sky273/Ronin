// Tests des instantanés réseau : aller-retour serveur → msgpack → client, filtre de distance.
// Lancer : npm run test:snapshot
import { pack, unpack } from 'msgpackr';
import { TILE } from '../shared/constants';
import { BTN } from '../shared/input';
import { T_SOLID } from '../shared/level';
import { decodeSnapshot, type SnapshotWire } from '../shared/net/codec';
import { INTEREST_PX, sanitizePlayerName, type Snapshot } from '../shared/net/protocol';
import { applySnapshot, makeSnapshot } from '../shared/net/snapshot';
import { spawnEnemy } from '../shared/enemy';
import type { GameEvent, World } from '../shared/types';
import { addPlayer, createWorld, nextStage, stepWorld, warpToArena } from '../shared/world';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Passe un instantané par le vrai encodage réseau (msgpack) puis le décode. */
const wire = (s: SnapshotWire): Snapshot => decodeSnapshot(unpack(pack(s)) as SnapshotWire);

function run(w: World, ticks: number, input: (t: number, id: number) => number): GameEvent[] {
  const evs: GameEvent[] = [];
  const m = new Map<number, number>();
  for (let t = 0; t < ticks; t++) {
    for (const p of w.players) m.set(p.id, input(t, p.id));
    stepWorld(w, m);
    evs.push(...w.events);
    w.events.length = 0;
  }
  return evs;
}

// 1. Aller-retour : le client reproduit l'état du serveur autour de son joueur.
{
  const server = createWorld(77, { mode: 'coop' });
  const a = addPlayer(server, 'Ayame', { color: 3 });
  const b = addPlayer(server, 'Benkei', { color: 5 });
  b.x += 200;
  const evs = run(server, 400, (t, id) => (id === a.id ? BTN.RIGHT | (t % 40 === 0 ? BTN.ATTACK : 0) : t % 30 === 0 ? BTN.JUMP : 0));
  const snap = wire(makeSnapshot(server, a.id, evs, 399));
  const client = createWorld(77, { mode: 'coop' });
  const { stageChanged } = applySnapshot(client, snap);
  const pa = client.players.find((p) => p.id === a.id);
  const pb = client.players.find((p) => p.id === b.id);
  check(
    'joueurs reproduits (positions, états, couleurs, noms)',
    !!pa && !!pb && pa.x === a.x && pa.y === a.y && pa.state === a.state && pa.color === 3 && pb!.color === 5 && pb!.name === 'Benkei',
    `a=${pa?.x.toFixed(1)}/${a.x.toFixed(1)}`,
  );
  check('tick, Marée et étape reproduits', client.tick === server.tick && client.wave.phase === server.wave.phase && client.stage.state === server.stage.state && !stageChanged);
  const nearEnemies = server.enemies.filter((e) => Math.abs(e.x - a.x) <= INTEREST_PX);
  check('ennemis proches reproduits à l’identique', client.enemies.length === nearEnemies.length && client.enemies.every((e, i) => e.id === nearEnemies[i].id && e.x === nearEnemies[i].x && e.hp === nearEnemies[i].hp));
  check('accusé de réception transmis', snap.ack === 399);
}

// 2. Filtre de distance : rien de lointain n'est envoyé, sauf les joueurs.
{
  const w = createWorld(5, { mode: 'coop' });
  const a = addPlayer(w, 'near');
  const far = addPlayer(w, 'far');
  far.x = a.x + 4000;
  spawnEnemy(w, 'ashigaru', a.x + 4000, 18 * TILE, false);
  const events: GameEvent[] = [
    { type: 'spawn', x: a.x + 100, y: 576, enemyType: 'ashigaru' },
    { type: 'spawn', x: a.x + 5000, y: 576, enemyType: 'archer' },
    { type: 'tideWarn', n: 1 },
  ];
  const s = wire(makeSnapshot(w, a.id, events, 0));
  check('tous les joueurs envoyés, même lointains', s.self?.id === a.id && s.others.length === 1 && s.others[0].id === far.id);
  check('ennemis lointains filtrés', s.enemies.every((e) => Math.abs(e.x - a.x) <= INTEREST_PX));
  check('événements : proches et globaux gardés, lointains filtrés', s.events.length === 2 && s.events.some((e) => e.type === 'tideWarn'));
}

// 3. Changement d'étape et barrière de l'arène reconstruits côté client.
{
  const server = createWorld(9, { mode: 'coop' });
  const p = addPlayer(server, 'p');
  run(server, 2, () => 0);
  nextStage(server);
  server.events.length = 0;
  const client = createWorld(9, { mode: 'coop' });
  const r = applySnapshot(client, wire(makeSnapshot(server, p.id, [], 0)));
  const same = client.level.w === server.level.w && client.level.tiles.every((t, i) => t === server.level.tiles[i]) && client.level.biome === server.level.biome;
  check('nouvelle étape : niveau reconstruit depuis la graine, identique', r.stageChanged && same, `${client.level.biome} ${client.level.w}`);
  const levelRef = client.level;
  warpToArena(server, p.id);
  run(server, 40, () => BTN.RIGHT);
  const r2 = applySnapshot(client, wire(makeSnapshot(server, p.id, [], 0)));
  const col = client.level.arena.col;
  check(
    'arène verrouillée : barrière posée côté client, même référence de niveau',
    server.stage.state === 'arena' && !r2.stageChanged && client.level === levelRef && client.level.tiles[10 * client.level.w + col] === T_SOLID,
    server.stage.state,
  );
}

// 4. Pseudos.
check(
  'pseudos nettoyés',
  sanitizePlayerName('  Musashi<b>  ') === 'Musashib' && sanitizePlayerName('') === 'Ronin' && sanitizePlayerName(42) === 'Ronin' && Array.from(sanitizePlayerName('x'.repeat(40))).length === 12,
);

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests d’instantanés passent.');
