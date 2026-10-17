# Ronin.io

**A side-scrolling samurai `.io` game, painted in Japanese ink.**

You are a lone ronin with a katana, cutting through hordes along the Tōkaidō road — alone, or online with up to eleven companions. Every stroke on screen is drawn live with a procedural brush, in the style of *sumi-e* (墨絵) ink sketches on rice paper, with a single vermilion accent. Characters, landscapes, effects, sounds and music are all generated in code: the game ships **no image or audio assets**.

> Status: solo campaign complete; **online co-op** (“the shared road”, up to 12 players) with **iaidō duels** between players; the **dojo**, an 8-player iaidō tournament.

## Features

### Solo
- **Katana combat**:
  - a three-hit combo, rising cut, aerial slash and plunge attack;
  - parry, dash with invincibility frames;
  - **iai**, a charged draw-and-strike: enemies freeze for a beat, then fall in two.
- **Fluid platforming**:
  - variable-height jump with coyote time, double jump, wall jump;
  - crouch, slide, drop through platforms.
- **Hordes**:
  - **ashigaru** spearmen;
  - **archers**: crouch under their arrows;
  - shield-bearing **oni**: strike from behind, break their guard, or parry;
  - **ninja**: jump their low shuriken, and expect them to teleport behind you.
- **The Tide (潮)**: lulls and ever-harder waves alternate.
- **The guardian**: at the end of each stage, a barrier seals the arena and **Akaoni (赤鬼)**, a demon general, attacks.
  - His sweep: crouch.
  - His leap: jump the shockwave.
  - His charge: dash through it.
  - Defeat him to break the seals of the torii gate.
- **A different road every stage**: a bamboo forest first, then generated stages built from hand-made segments across four biomes (bamboo, burning village, snowy pass, castle), always checked to be playable.
- **Progression**:
  - slain foes drop honor (誉) orbs, and every level offers 1 upgrade among 3, without pausing;
  - ranks go from Ronin to Shogun;
  - when you die, half your honor stays where you fell.
- **Journey loops (周)**: after the stage results, the journey goes on, harder, keeping your upgrades.
- **Five difficulty levels**, from Very Easy to Very Hard: 10 / 8 / 5 / 3 / 1 lives, tougher and faster foes, a denser horde, and a score multiplier of ×0.5 to ×2.5.
- **Hall of Honor (誉)**: when your last life is gone, inscribe your name among the local top 10 for your difficulty. The score only grows: kills (with a combo bonus), repelled Tides and stage results, multiplied by difficulty and loop.

### Online co-op — “the shared road” (縁)
- **Up to 12 ronin per room**, one ink color each, walking the same stages together against the hordes. Join from the title screen (**Online**), with just a name — no account.
- **No lives, no game over**: fallen players are reborn at the furthest shrine anyone has reached (社, shared by the whole room).
- **The guardian's kekkai (結界) is one-way**: anyone can step into the arena at any time, nobody can leave until Akaoni falls. His strength scales with the number of active players.
- **Stage results for the whole room**: everyone gets their own grade and bonus; the room votes to move on (a majority is enough, or the road resumes by itself after 8 s).
- **Teammates off screen** are shown at the screen edge, with their name and distance.
- **Away players** (no key pressed for 30 s) don't count for votes or the guardian's strength, and are dismissed after 3 minutes.

### Iaidō duels (決闘) — PvP by consent only
- Press **G** next to another ronin to challenge them; they press **G** to accept. An ink circle is drawn and both samurai face off.
- **構え** — stand still and charge your iai. **斬** — the signal: release first. Strike too early and it's a foul (反則); parry a fast strike (弾); strike at the same instant and the round is replayed (相打ち). Best of three; hold **G** to forfeit.
- **Fair at any latency**: the 斬 signal is scheduled by the server in advance and appears at the same game tick for both duelists, and reactions are judged on the server tick each input is consumed — no rewind, nothing to exploit with a forged lag. Over 0–150 ms per direction, the faster player wins 100 % of the time in tests.
- Duelists are untouchable while the rest of the room plays on and watches. There is nothing to win but glory.

### The dojo (道場) — an iaidō tournament
- **Dojo** on the title screen: enter your name and join a dojo of **8 places**.
- **Single elimination**: quarterfinals, semifinals, final, every match a best-of-three iaidō duel with the same rules and network fairness as above. Matches of a round are fought at the same time on four tatami mats; the others watch.
- The tournament starts when the dojo is full, when everyone present has pressed **G** (ready), or after **60 s**: training **bots** (marked 木人) then fill the empty places. Bots react like people — never faster than 200 ms, sometimes too early.
- **No draws**: sudden death, then the sum of reaction times, then the lot (抽選).
- Leaving, holding **G** (forfeit) or staying idle for 15 s loses the match; three inhumanly fast reactions in one tournament disqualify (反則).
- **Tab** shows the bracket. The champion (優勝) is celebrated, then the dojo waits for the next tournament. A dojo is locked while its tournament runs: newcomers get a new one.

### Presentation
- **Ink rendering**: brush strokes that boil like hand-drawn animation, ink stains that build up on the ground, foes cut in half, hit-stop, slow motion (solo).
- **Adaptive music**, generated in the *In* (Miyako-bushi) scale:
  - koto and shamisen synthesized with Karplus-Strong;
  - a **shinobue** (bamboo transverse flute) lead: phrases built as motif, variation, contrast and cadence, with grace notes, trills, slides and falls;
  - shakuhachi in call-and-response with the flute, and taiko;
  - it follows the action: calm, Tide, guardian.

## Getting started

Requires **Node.js 22+** (the game server uses Colyseus 0.18).

```bash
npm install
npm run dev          # the game: http://localhost:5180
npm run dev:server   # the online server: ws://localhost:2567 (only needed for "Online")
```

Other scripts:

```bash
npm test               # all headless test suites (simulation, co-op, netcode, server, duels…)
npm run build          # type-check and production build of the game (dist/)
npm run preview        # serve the production build
npm run build:server   # bundle the server (dist-server/)
npm run start:server   # run the bundled server
npm run typecheck:server
npm run bots -- 12     # fill a room with 12 bots and print traffic statistics
npm run bots -- 8 --room dojo   # the same in a dojo (bots ready up and duel)
```

### Configuration

| Variable | Where | Meaning |
|---|---|---|
| `VITE_SERVER_URL` | client (see `.env.example`) | game server address (default `ws://localhost:2567`) |
| `PORT` | server | listening port (default 2567) |
| `MAX_ROOMS` | server | maximum rooms per process, co-op and dojo together (default 50) |
| `LAG_MS`, `JITTER_MS` | server | simulated latency per direction, for testing |
| `STATS_EVERY_MS` | server | interval of the performance log (0 to disable) |
| `SERVER_URL` | `npm run bots` | server the bots join (default `ws://localhost:2567`) |

Client and server must run the same protocol version (checked on join): update both together.

## Controls

| Action | Keyboard | Mouse / gamepad |
|---|---|---|
| Move | ← → / A D (Q D on AZERTY) | stick, d-pad |
| Jump (double jump, wall jump) | Space | A |
| Crouch · slide (↓ while running) · drop through (↓ + Space) | ↓ / S | — |
| Katana (3-hit combo), ↑ rising cut, ↓ in the air plunge | J | left click / X |
| Dash | Shift | B / RT |
| Parry | K | right click / LB · RB |
| Iai (hold, then release) | L | middle click / Y |
| Choose an upgrade | 1 · 2 · 3 | — |
| Online: challenge / accept a duel · hold to forfeit | G | R3 |
| Online: leave the room | Esc | hold Select |
| Online: ready at the stage results | Space / J | A / X |
| Dojo: ready (start without waiting) · hold to forfeit a match | G | R3 |
| Dojo: show / hide the bracket | Tab | — |
| Help · sound · music · hitboxes | H · M · N · F1 | — |

Game keys are read by physical position (`event.code`), so QWERTY and AZERTY both work without any setting; the H, M and N shortcuts follow the letter printed on the key.

Development shortcuts (dev server, solo only): **F2** next Tide phase, **F3** warp to the guardian's arena, **F4** +100 honor, **F7** next stage, **F8** add a delayed “echo” player, **F9** start a local duel against an echo, **F10** an offline dojo against bots.

## Architecture

```
shared/        deterministic 60 Hz simulation (no DOM, no Math.random): the same code runs
               in solo, on the server and in the client's prediction
               physics, player, combat, enemies, interactions, stages and arena (kekkai),
               level generation and checks, difficulty, co-op rules, duels and challenges,
               the dojo (level, tournament, duelist bots), lag compensation (lagcomp)
  net/         protocol, compact snapshot codec, snapshot building / applying
client/        Phaser 3 rendering, fully procedural
  scenes/      the game scene: screens, solo and online play
  world/       world sources: local simulation (solo) or online
  net/         connection (Colyseus SDK, loaded on demand), prediction and reconciliation,
               interpolation and server clock, event gating
  render/      brush engine, IK skeletons and key poses, painted backdrops and terrain
  fx/          ink particles, halved corpses, afterimages, per-player effect policy
  audio/       synthesized sound effects and adaptive music
  ui/          HUD, banners, results and room roster, online menu, duels, tournament bracket,
               teammate markers, title, difficulty, name entry, Hall of Honor
  scores/      local high scores
server/        Colyseus game server: a CoopSession (or DojoSession) per room runs the shared
               simulation (fixed-step, input queues, away players); co-op and dojo rooms,
               lag simulator, bots
tests/         headless tests (esbuild or tsx + Node), including a virtual network bench
```

**Netcode.** The client only sends **inputs** (a button bitmask, 60 Hz) and renders what the simulation emits. Online, the server is authoritative:
- your own samurai is **predicted** locally and **reconciled** with the server, so it reacts on the very frame you press a key;
- other players and enemies are **interpolated** about 100 ms behind, on an estimated server clock;
- the server judges your strikes and parries against what you saw on screen (**lag compensation**, up to 500 ms);
- snapshots are compact tuples (well under 1 KB with 12 players), sent at 20 Hz and filtered around each player.

**Tests.** `npm test` runs every suite: solo simulation smoke test, player body and honor orbs, enemies and arena, high scores, game over, melody, level generation and stage chaining, snapshots and codec, co-op rules (with reference fingerprints guaranteeing the solo simulation never changes by accident), remote source, server (real Colyseus server with SDK clients, malformed requests, rate limits), effect policy, interface (HUD, banners, keyboard layouts), terrain ink uploads, prediction, interpolation, server clock, lag compensation, a virtual network bench (latency × jitter matrix, outages, server stalls), room roster, duels and duel fairness, the dojo (tournament, bracket, real server rooms).

**Stack**: TypeScript (strict), Phaser 3, Vite, Web Audio API, Colyseus 0.18, msgpack.

## License

[GNU GPL v3.0](LICENSE)
