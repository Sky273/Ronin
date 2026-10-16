# Ronin.io

**A side-scrolling samurai `.io` game, painted in Japanese ink.**

You are a lone ronin with a katana, cutting through hordes along the Tōkaidō road. Every stroke on screen is drawn live with a procedural brush, in the style of *sumi-e* (墨絵) ink sketches on rice paper, with a single vermilion accent. Characters, landscapes, effects, sounds and music are all generated in code: the game ships **no image or audio assets**.

> Status: playable prototype (solo). Online multiplayer is the next milestone: the simulation is already deterministic and shared, ready to run on an authoritative server.

## Features

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
- **The guardian**: at the end of the stage, a barrier seals the arena and **Akaoni (赤鬼)**, a demon general, attacks.
  - His sweep: crouch.
  - His leap: jump the shockwave.
  - His charge: dash through it.
  - Defeat him to break the seals of the torii gate.
- **Progression**:
  - slain foes drop honor (誉) orbs, and every level offers 1 upgrade among 3, without pausing;
  - ranks go from Ronin to Shogun;
  - when you die, half your honor stays where you fell.
- **Journey loops (周)**: after the stage results, the journey starts over, harder, keeping your upgrades.
- **Five difficulty levels**, from Very Easy to Very Hard: 10 / 8 / 5 / 3 / 1 lives, tougher and faster foes, a denser horde, and a score multiplier of ×0.5 to ×2.5.
- **Hall of Honor (誉)**: when your last life is gone, inscribe your name among the local top 10 for your difficulty. The score only grows: kills (with a combo bonus), repelled Tides and stage results, multiplied by difficulty and loop.
- **Ink rendering**: brush strokes that boil like hand-drawn animation, ink stains that build up on the ground, foes cut in half, hit-stop, slow motion.
- **Adaptive music**, generated in the *In* (Miyako-bushi) scale:
  - koto and shamisen synthesized with Karplus-Strong;
  - a **shinobue** (bamboo transverse flute) lead: phrases built as motif, variation, contrast and cadence, with grace notes, trills, slides and falls;
  - shakuhachi in call-and-response with the flute, and taiko;
  - it follows the action: calm, Tide, guardian.

## Getting started

Requires **Node.js 22+** (the game server uses Colyseus 0.18).

```bash
npm install
npm run dev      # http://localhost:5180
```

Other scripts:

```bash
npm test         # headless tests: simulation, scores, co-op rules, network, server
npm run build    # type-check and production build (dist/)
npm run preview  # serve the production build
```

## Online co-op (work in progress)

**The shared road**: up to twelve ronin, one ink color each, walk the same stages together against the hordes. No lives, no game over: fallen players are reborn at the furthest shrine anyone has reached, and the whole room moves to the next stage together.

```bash
npm run dev:server   # authoritative game server on ws://localhost:2567
npm run dev          # then choose "Online" on the title screen
```

- `VITE_SERVER_URL` (client, see `.env.example`) points the game at another server.
- `PORT` sets the server port. `LAG_MS` and `JITTER_MS` simulate network latency (per direction) for testing.
- `npm run bots -- 12` fills a room with 12 bots and prints traffic statistics.
- `npm run build:server` and `npm run start:server` build and run the production server.

This first milestone sends inputs and renders server snapshots as they arrive. Client-side prediction, iaidō duels between players and a 1v1 tournament dojo come next.

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
| Help · sound · music · hitboxes | H · M · N · F1 | — |

Development shortcuts (dev server only): **F2** next Tide phase, **F3** warp to the guardian's arena, **F4** +100 honor.

Keys are read by physical position (`event.code`), so QWERTY and AZERTY both work without any setting.

## Architecture

```
shared/   deterministic 60 Hz simulation: no DOM, no rendering
          physics (AABB), player state machine, combat, enemy AI,
          honor and upgrades, Tide, stages and loops, difficulty
client/   Phaser 3 rendering, fully procedural
          render/  brush engine, IK skeletons and key poses, painted backdrops
          fx/      ink particles, halved corpses, afterimages
          audio/   synthesized sound effects and adaptive music
          ui/      HUD, banners, results screen
server/   Colyseus game server: rooms run the same shared/ simulation
tests/    headless tests (bundled with esbuild, run with Node)
```

The client only sends **inputs** (a button bitmask) to the simulation and renders the events it emits. Online, the same `shared/` code runs on the server; clients send their inputs at 60 Hz and receive snapshots at 20 Hz, filtered around each player.

**Stack**: TypeScript (strict), Phaser 3, Vite, Web Audio API, Colyseus (online).

## License

[GNU GPL v3.0](LICENSE)
