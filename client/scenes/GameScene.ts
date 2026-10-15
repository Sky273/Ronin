import Phaser from 'phaser';
import { ATTACKS, activeAttackBox, bodyRect, boxFromFacing } from '../../shared/combat';
import { BOSS, DT, ENEMY, NINJA_SLASH_HB, ONI_SMASH_HB, PLAYER as P, SPEAR_HB, TILE } from '../../shared/constants';
import { gainHonor } from '../../shared/interactions';
import type { Rect } from '../../shared/math';
import type { Enemy, GameEvent, Player, World } from '../../shared/types';
import { addPlayer, createWorld, skipWavePhase, stepWorld, warpToArena } from '../../shared/world';
import { type Mood, Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { Fx } from '../fx/fx';
import { Controls } from '../input/controls';
import { Backdrop, makeGrainOverlay, makeVignette } from '../render/backdrop';
import { gBlob, gFill, gStroke, hash2, type Pt, ringPoints, seeded } from '../render/brush';
import {
  buildSkeleton, drawSamurai, headBackWorld, headWorld, makeXf, type Pose, SAMURAI, samuraiPose, slashTrail, star,
} from '../render/characters';
import { bossTrail, drawEnemy, enemyPose, enemySkeleton, isGuarding, SCALE, windupLength } from '../render/enemies';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';
import { Terrain } from '../render/terrain';
import { Hud } from '../ui/hud';
import { Results } from '../ui/results';
import { UPGRADE_TEXT } from '../ui/texts';

type Layer = 'bg' | 'world' | 'ui';
type G = Phaser.GameObjects.Graphics;

const ZOOM = 1.4;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class GameScene extends Phaser.Scene {
  private world!: World;
  private me!: Player;
  private controls!: Controls;
  private sfx = new Sfx();
  private music: Music | null = null;
  private bgCam!: Phaser.Cameras.Scene2D.Camera;
  private worldCam!: Phaser.Cameras.Scene2D.Camera;
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private backdrop!: Backdrop;
  private terrain!: Terrain;
  private fx!: Fx;
  private hud!: Hud;
  private results!: Results;
  private gBack!: G;
  private gChars!: G;
  private gFront!: G;
  private gDebug!: G;
  private gOverlay!: G;
  private title!: Phaser.GameObjects.Container;
  private deathText!: Phaser.GameObjects.Text;
  private deathSub!: Phaser.GameObjects.Text;

  private inputs = new Map<number, number>();
  private acc = 0;
  private timeScale = 1;
  private started = false;
  private debug = false;
  private slowmo = 0;
  private flash = 0;
  private shake = 0;
  private zoomPunch = 0;
  private camX = 0;
  private camY = 0;
  private prev = new Map<number, Pt>();
  private phase = new Map<number, number>();
  private lastPose = new Map<number, Pose>();
  private lastPlayerPose: Pose | null = null;
  private scarf: Pt[] = [];
  private parryTick = -999;
  private hurtFlash = 0;
  private ghostTimer = 0;
  private petalTimer = 0;
  private best = 0;
  private orbStreak = 0;
  private orbStreakT = 0;
  private lastLost = 0;
  private wipe = 0;

  constructor() {
    super('game');
  }

  /** Chaque objet est rendu par une seule des trois caméras (fond, monde zoomé, interface). */
  private put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: Layer): T => {
    if (layer !== 'bg') this.bgCam.ignore(obj);
    if (layer !== 'world') this.worldCam.ignore(obj);
    if (layer !== 'ui') this.uiCam.ignore(obj);
    return obj;
  };

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    this.world = createWorld((Date.now() & 0xffff) + 1);
    this.me = addPlayer(this.world, 'Ronin');
    const L = this.world.level;

    this.bgCam = this.cameras.main;
    this.worldCam = this.cameras.add(0, 0, W, H);
    this.uiCam = this.cameras.add(0, 0, W, H);
    this.worldCam.setZoom(ZOOM).setBounds(0, 0, L.pxW, L.pxH);
    this.camX = this.me.x + 60;
    this.camY = this.me.y - 60;
    this.worldCam.centerOn(this.camX, this.camY);

    this.backdrop = new Backdrop(this, this.put);
    this.terrain = new Terrain(this, L, this.put);
    this.fx = new Fx(L, this.terrain);
    this.gBack = this.put(this.add.graphics().setDepth(5), 'world');
    this.gChars = this.put(this.add.graphics().setDepth(10), 'world');
    this.gFront = this.put(this.add.graphics().setDepth(20), 'world');
    this.gDebug = this.put(this.add.graphics().setDepth(30), 'world');

    this.put(this.add.tileSprite(0, 0, W, H, makeGrainOverlay(this, 'grain')).setOrigin(0).setBlendMode(Phaser.BlendModes.MULTIPLY).setDepth(90), 'ui');
    this.put(this.add.image(0, 0, makeVignette(this, 'vignette', W, H)).setOrigin(0).setDepth(91), 'ui');
    this.gOverlay = this.put(this.add.graphics().setDepth(95), 'ui');
    this.hud = new Hud(this, this.put);
    this.results = new Results(this, this.put, () => {
      this.sfx.drum(0, true);
      this.addShake(6);
    });
    this.deathText = this.put(this.add.text(W / 2, H * 0.42, '討死', { fontFamily: FONT_BRUSH, fontSize: '150px', color: '#b8321f' }).setOrigin(0.5).setDepth(150).setAlpha(0), 'ui');
    this.deathSub = this.put(this.add.text(W / 2, H * 0.6, '', { fontFamily: FONT_TEXT, fontSize: '22px', color: '#15120e', align: 'center' }).setOrigin(0.5).setDepth(150).setAlpha(0), 'ui');
    this.buildTitle();

    this.controls = new Controls(this.game.canvas);
    this.controls.onKey('F1', () => (this.debug = !this.debug));
    this.controls.onKey('KeyM', () => this.sfx.toggleMute());
    this.controls.onKey('KeyN', () => this.music?.toggle());
    this.controls.onKey('KeyH', () => this.hud.toggleHelp());
    this.controls.onKey('Enter', () => this.start());
    this.controls.onKey('Space', () => this.start());
    this.input.on('pointerdown', () => this.start());
    if (import.meta.env.DEV) {
      // Raccourcis de test : F2 phase de Marée suivante, F3 arène du gardien, F4 +100 Honneur.
      this.controls.onKey('F2', () => skipWavePhase(this.world));
      this.controls.onKey('F3', () => warpToArena(this.world));
      this.controls.onKey('F4', () => gainHonor(this.world, this.me, 100));
      (window as unknown as { __ronin: unknown }).__ronin = this;
    }
  }

  private buildTitle(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const r = seeded(9);
    const veil = this.add.rectangle(0, 0, W, H, C.paper, 0.78).setOrigin(0);
    const kanji = this.add.text(W / 2 - 20, H * 0.36, '浪人', { fontFamily: FONT_BRUSH, fontSize: '200px', color: '#15120e' }).setOrigin(0.5);
    const seal = this.add.graphics();
    const sx = W / 2 + 205;
    const sy = H * 0.2;
    gFill(seal, [{ x: sx - 30, y: sy - 31 }, { x: sx + 31, y: sy - 29 }, { x: sx + 29, y: sy + 31 }, { x: sx - 31, y: sy + 29 }], C.red, 0.92);
    gStroke(seal, ringPoints(W / 2 - 20, H * 0.36, 175, -2.6, 2.9, 40), C.ink, 0.12, { width: 22, taperStart: 0.3, taperEnd: 0.6 }, r);
    const sealText = this.add.text(sx, sy, '侍', { fontFamily: FONT_BRUSH, fontSize: '44px', color: '#f0e7d3' }).setOrigin(0.5);
    const name = this.add.text(W / 2, H * 0.6, 'R O N I N . I O', { fontFamily: FONT_TEXT, fontSize: '34px', color: '#15120e' }).setOrigin(0.5);
    const sub = this.add.text(W / 2, H * 0.66, 'la voie du sabre — prototype', { fontFamily: FONT_TEXT, fontSize: '18px', color: '#4a433b' }).setOrigin(0.5);
    const press = this.add.text(W / 2, H * 0.8, 'Appuyez sur ENTRÉE ou cliquez pour dégainer', { fontFamily: FONT_TEXT, fontSize: '22px', color: '#b8321f' }).setOrigin(0.5);
    this.tweens.add({ targets: press, alpha: 0.35, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.title = this.add.container(0, 0, [veil, seal, kanji, sealText, name, sub, press]).setDepth(200);
    this.put(this.title, 'ui');
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.sfx.init();
    const out = this.sfx.output;
    if (out && !this.music) {
      this.music = new Music(out.ctx, out.dest);
      this.events.once('destroy', () => this.music?.dispose());
    }
    this.tweens.add({ targets: this.title, alpha: 0, duration: 600, ease: 'Sine.easeIn', onComplete: () => this.title.setVisible(false) });
  }

  update(time: number, delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    this.timeScale = 1;
    if (this.started) {
      if (this.slowmo > 0) {
        this.slowmo -= dt;
        this.timeScale = 0.3;
      }
      this.acc += dt * this.timeScale;
      let n = 0;
      while (this.acc >= DT && n < 4) {
        this.snapshot();
        this.inputs.set(this.me.id, this.controls.sample());
        stepWorld(this.world, this.inputs);
        for (const ev of this.world.events) this.onEvent(ev);
        this.world.events.length = 0;
        this.acc -= DT;
        n++;
      }
      if (n === 4) this.acc = 0;
    }
    this.renderFrame(dt, time);
  }

  private snapshot(): void {
    for (const p of this.world.players) this.prev.set(p.id, { x: p.x, y: p.y });
    for (const e of this.world.enemies) this.prev.set(e.id, { x: e.x, y: e.y });
  }

  private lerpPos(id: number, x: number, y: number, a: number): Pt {
    const pv = this.prev.get(id);
    if (!pv || Math.abs(pv.x - x) > 120) return { x, y };
    return { x: lerp(pv.x, x, a), y: lerp(pv.y, y, a) };
  }

  // ─── Rendu ────────────────────────────────────────────────────────────────

  private renderFrame(dt: number, time: number): void {
    const w = this.world;
    const alpha = Math.min(1, this.acc / DT);
    const boil = Math.floor(time / 85); // « ligne qui frémit » à ~12 i/s, comme une animation à la main
    const fxDt = dt * this.timeScale;
    this.gBack.clear();
    this.gChars.clear();
    this.gFront.clear();
    this.gDebug.clear();
    this.gOverlay.clear();

    this.drawCheckpoints(time);
    this.drawStageProps(time);
    for (const e of w.enemies) this.drawEnemyEntity(e, alpha, fxDt, time, boil);
    this.drawProjectiles(time);
    this.drawOrbs(time);
    const pos = this.drawPlayer(this.me, alpha, dt, time, boil);

    this.fx.update(fxDt);
    this.fx.draw(this.gBack, this.gFront, boil);

    this.petalTimer -= dt;
    if (this.petalTimer <= 0) {
      this.petalTimer = 0.2 + Math.random() * 0.45;
      const v = this.worldCam.worldView;
      this.fx.petal(v.x + v.width * (0.2 + Math.random()), v.y - 10);
    }

    if (this.debug) this.drawDebug();
    this.updateCamera(pos, dt);
    this.backdrop.update(this.worldCam);
    this.terrain.flush();

    const W = this.scale.width;
    const H = this.scale.height;
    if (w.wave.phase === 'tide') {
      // Pendant la Marée, l'encre gagne les bords de l'écran.
      const k = 0.1 + Math.sin(time * 0.003) * 0.03;
      this.gOverlay.fillStyle(C.redDeep, k);
      this.gOverlay.fillRect(0, 0, W, 10);
      this.gOverlay.fillRect(0, H - 10, W, 10);
    }
    if (this.wipe > 0) {
      // Lavis d'encre entre deux boucles
      const k = Math.min(1, this.wipe / 0.9);
      this.gOverlay.fillStyle(C.ink, k * k);
      this.gOverlay.fillRect(0, 0, W, H);
      this.wipe -= dt;
    }
    if (this.flash > 0) {
      this.gOverlay.fillStyle(C.paper, Math.min(0.65, this.flash * 4));
      this.gOverlay.fillRect(0, 0, W, H);
      this.flash -= dt;
    }
    this.orbStreakT -= dt;
    if (this.orbStreakT <= 0) this.orbStreak = 0;
    this.hud.update(this.me, w, this.best, dt, time, this.worldCam);
    this.updateMusic();

    const dead = this.me.state === 'dead';
    const da = dead ? Math.min(1, this.me.stateT / 40) : Math.max(0, this.deathText.alpha - dt * 3);
    this.deathText.setAlpha(da);
    this.deathSub.setAlpha(da);
    if (dead) {
      const lost = this.lastLost > 0 ? `\n${this.lastLost} honneur laissé au sol — revenez le chercher` : '';
      this.deathSub.setText(`${this.me.kills} ennemis tranchés${lost}\nVous renaîtrez au sanctuaire…`);
    }
  }

  /** L'ambiance musicale suit l'état de l'étape et de la Marée. */
  private updateMusic(): void {
    if (!this.music) return;
    const st = this.world.stage.state;
    const wave = this.world.wave.phase;
    const mood: Mood = st === 'arena' ? 'boss' : st === 'cleared' || st === 'gateOpen' ? 'rest' : wave === 'calm' ? 'calm' : 'tide';
    this.music.setMood(mood);
    this.music.duck(this.me.state === 'dead');
  }

  /** Barrière de l'arène (kekkai) et porte de fin d'étape. */
  private drawStageProps(time: number): void {
    const st = this.world.stage;
    const l = this.world.level;
    const gB = this.gFront;
    const boil = Math.floor(time / 90);
    if (st.state === 'arena') {
      const x = (l.arena.col + 0.5) * TILE;
      const top = 0;
      const bot = l.arena.rows * TILE;
      for (let i = 0; i < 4; i++) {
        const r = seeded(hash2(i + 70, boil));
        const pts: Pt[] = [];
        for (let y = top; y <= bot; y += 24) pts.push({ x: x + (i - 1.5) * 6 + Math.sin(y * 0.03 + time * 0.004 + i) * 3, y });
        gStroke(gB, pts, i % 2 ? C.redDeep : C.ink, 0.55, { width: 3, taperStart: 0.02, taperEnd: 0.02, jitter: 0.3 }, r);
      }
      for (let k = 0; k < 5; k++) {
        const y = bot - 70 - k * 90;
        const r = seeded(hash2(k + 90, boil));
        const sway = Math.sin(time * 0.003 + k) * 2;
        gFill(gB, [{ x: x - 6 + sway, y }, { x: x + 6 + sway, y }, { x: x + 6 + sway * 1.5, y: y + 30 }, { x: x - 6 + sway * 1.5, y: y + 30 }], C.paper, 0.95);
        gStroke(gB, [{ x: x - 2 + sway, y: y + 6 }, { x: x + 2 + sway, y: y + 14 }, { x: x - 2 + sway, y: y + 23 }], C.red, 0.9, { width: 2.2, taperStart: 0.1, taperEnd: 0.4 }, r);
      }
      if (Math.random() < 0.25) this.fx.mist(x, bot - Math.random() * bot, 1, { color: C.redDeep, size: 5, alpha: 0.2, vy: -30, life: 0.8 });
    }
    // Porte : scellée par des ofuda tant que le gardien vit, lumineuse une fois ouverte.
    const gx = l.gate.x;
    const gy = l.gate.y;
    const r = seeded(hash2(777, boil));
    const open = st.state === 'gateOpen' || st.state === 'cleared';
    if (!open) {
      const sag = (t: number) => Math.sin(Math.PI * t) * 9;
      const rope: Pt[] = [];
      for (let i = 0; i <= 10; i++) rope.push({ x: gx - 31 + i * 6.2, y: gy - 88 + sag(i / 10) });
      gStroke(this.gBack, rope, C.wood, 0.95, { width: 4.5, taperStart: 0.02, taperEnd: 0.02, jitter: 0.2 }, r);
      for (let k = 0; k < 3; k++) {
        const t = 0.25 + k * 0.25;
        const sx = gx - 31 + t * 62;
        const sy = gy - 86 + sag(t);
        const sway = Math.sin(time * 0.004 + k * 1.7) * 2;
        gFill(this.gBack, [{ x: sx - 5, y: sy }, { x: sx + 5, y: sy }, { x: sx + 5 + sway, y: sy + 28 }, { x: sx - 5 + sway, y: sy + 28 }], C.paper, 0.97);
        gStroke(this.gBack, [{ x: sx + sway * 0.3, y: sy + 5 }, { x: sx + 2 + sway * 0.6, y: sy + 13 }, { x: sx - 1 + sway, y: sy + 23 }], C.red, 0.9, { width: 2.4, taperStart: 0.1, taperEnd: 0.4 }, r);
      }
    } else {
      const pulse = 1 + Math.sin(time * 0.005) * 0.08;
      gBlob(this.gBack, gx, gy - 52, 40 * pulse, C.paper, 0.55, r, 0.2);
      gBlob(this.gBack, gx, gy - 52, 26 * pulse, 0xfffdf6, 0.7, r, 0.15);
      gStroke(this.gBack, ringPoints(gx, gy - 52, 46 * pulse, time * 0.002, time * 0.002 + Math.PI * 1.7, 20), C.red, 0.4, { width: 2.5, taperStart: 0.3, taperEnd: 0.5 }, r);
      if (Math.random() < 0.3) this.fx.mist(gx + (Math.random() - 0.5) * 50, gy - 10, 1, { color: C.paper, size: 4, alpha: 0.5, vy: -40, life: 1, front: true });
    }
  }

  private drawCheckpoints(time: number): void {
    const cps = this.world.level.checkpoints;
    cps.forEach((c, i) => {
      const active = i === this.me.checkpoint;
      const fy = c.y - 30 * 1.35;
      const r = seeded(hash2(i, Math.floor(time / 90)));
      if (active) {
        const fl = 1 + Math.sin(time * 0.013 + i) * 0.15;
        gBlob(this.gBack, c.x, fy, 14 * fl, C.red, 0.12, r, 0.3);
        gBlob(this.gBack, c.x, fy, 4.5 * fl, C.red, 0.9, r, 0.25);
        gBlob(this.gBack, c.x, fy - 2, 2.2, C.paper, 0.8, r, 0.2);
      } else gBlob(this.gBack, c.x, fy, 3, C.wash, 0.5, r, 0.2);
    });
  }

  private drawEnemyEntity(e: Enemy, alpha: number, fxDt: number, time: number, boil: number): void {
    if (e.state === 'hidden') return;
    const pos = this.lerpPos(e.id, e.x, e.y, alpha);
    let ph = this.phase.get(e.id) ?? Math.random() * 6;
    if (e.onGround) ph += (Math.abs(e.vx) * fxDt * 0.1) / SCALE[e.type];
    this.phase.set(e.id, ph);
    const t = e.stateT + (e.freeze > 0 ? 0 : alpha);
    const pose = enemyPose(e, t, ph);
    this.lastPose.set(e.id, pose);
    const sk = enemySkeleton(e.type, pose);
    const X = makeXf(pos.x, pos.y, e.facing);
    const r = seeded(hash2(e.id, boil));

    const trail = bossTrail(e, t);
    if (trail) {
      const tips = trail.tips.map(X);
      gFill(this.gChars, tips.concat(trail.inner.map(X).reverse()), C.ink, 0.85 * trail.alpha);
      gStroke(this.gChars, tips, C.red, 0.9 * trail.alpha, { width: 3, taperStart: 0.6, taperEnd: 0.05 }, r);
    }
    if (e.type === 'boss' && e.phase2 && Math.random() < 0.35) {
      this.fx.mist(pos.x + (Math.random() - 0.5) * 60, pos.y - Math.random() * 90, 1, { color: C.redDeep, size: 7, alpha: 0.25, vy: -60, life: 0.7 });
    }
    drawEnemy(this.gChars, e.type, sk, X, {
      alpha: e.state === 'intro' && e.type === 'boss' ? Math.min(1, t / 30) : 1,
      tint: e.flash > 0 ? C.red : null,
      rand: r,
      glint: e.state === 'windup' ? Math.min(1, t / windupLength(e)) : 0,
      parts: 'all',
      doomK: e.state === 'doomed' ? t / ENEMY.DOOM_TICKS : undefined,
      guard: isGuarding(e),
      time,
      phase2: e.phase2,
    });
    if (e.state === 'stunned') {
      const h = headWorld(sk, X);
      const rad = 9 * SCALE[e.type];
      for (let i = 0; i < 3; i++) {
        const a0 = time * 0.008 + i * 2.1;
        gStroke(this.gFront, ringPoints(h.x, h.y - 10 - rad, rad, a0, a0 + 1.3, 6), C.ink, 0.7, { width: 1.8, taperStart: 0.3, taperEnd: 0.6 }, seeded(i + boil));
      }
    }
    // Télégraphe du balayage : la zone dangereuse est marquée au sol.
    if (e.type === 'boss' && e.state === 'windup' && (e.move === 'sweep' || e.move === 'leap')) {
      const k = Math.min(1, t / windupLength(e));
      if (e.move === 'sweep') {
        const x0 = pos.x + e.facing * BOSS.SWEEP_HB.x;
        gStroke(this.gBack, [{ x: x0, y: pos.y - 1 }, { x: x0 + e.facing * BOSS.SWEEP_HB.w * k, y: pos.y - 1 }], C.red, 0.35, { width: 4, taperStart: 0.1, taperEnd: 0.6 }, r);
      } else {
        const tgt = this.me.x;
        gStroke(this.gBack, ringPoints(tgt, pos.y - 2, 30 * k + 10, Math.PI, Math.PI * 2, 12), C.red, 0.35, { width: 3, taperStart: 0.2, taperEnd: 0.2 }, r);
      }
    }
  }

  private drawProjectiles(time: number): void {
    for (const a of this.world.projectiles) {
      const r = seeded(a.id);
      const col = a.owner === 'player' ? C.red : C.ink;
      if (a.kind === 'arrow') {
        const ang = Math.atan2(a.vy, a.vx);
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const tail = { x: a.x - dx * 24, y: a.y - dy * 24 };
        gStroke(this.gChars, [tail, { x: a.x, y: a.y }], col, 1, { width: 1.6, taperStart: 0, taperEnd: 0 }, r);
        for (const s of [-1, 1]) gStroke(this.gChars, [{ x: tail.x + dx * 6, y: tail.y + dy * 6 }, { x: tail.x - dy * s * 4, y: tail.y + dx * s * 4 }], col, 0.8, { width: 1.3 }, r);
        gFill(this.gChars, [{ x: a.x + dx * 5, y: a.y + dy * 5 }, { x: a.x - dy * 2.2, y: a.y + dx * 2.2 }, { x: a.x + dy * 2.2, y: a.y - dx * 2.2 }], col, 1);
      } else if (a.kind === 'shuriken') {
        const spin = time * 0.03 + a.id;
        for (let i = 0; i < 4; i++) {
          const ang = spin + (i * Math.PI) / 2;
          gStroke(this.gChars, [{ x: a.x, y: a.y }, { x: a.x + Math.cos(ang) * 6, y: a.y + Math.sin(ang) * 6 }], col, 1, { width: 2.6, taperStart: 0, taperEnd: 0.9 }, r);
        }
        gStroke(this.gBack, [{ x: a.x - Math.sign(a.vx) * 26, y: a.y }, { x: a.x, y: a.y }], C.wash, 0.35, { width: 1.5, taperStart: 0.9, taperEnd: 0 }, r);
      } else {
        // Vague de vent : croissant vertical d'encre
        const d = Math.sign(a.vx);
        const pts: Pt[] = [];
        for (let i = 0; i <= 8; i++) {
          const u = i / 8 - 0.5;
          pts.push({ x: a.x + d * (10 - u * u * 44), y: a.y + u * 54 });
        }
        gStroke(this.gChars, pts, C.ink, 0.8, { width: 8, taperStart: 0.4, taperEnd: 0.4, jitter: 0.25 }, r);
        gStroke(this.gChars, pts.map((q) => ({ x: q.x + d * 2, y: q.y })), C.red, 0.7, { width: 2, taperStart: 0.4, taperEnd: 0.4 }, r);
      }
    }
  }

  private drawOrbs(time: number): void {
    for (const o of this.world.orbs) {
      const r = seeded(o.id + Math.floor(time / 120));
      const bob = o.onGround ? Math.sin(time * 0.006 + o.id) * 2 - 3 : 0;
      const size = o.value >= 25 ? 5.5 : o.value >= 5 ? 4 : 2.6;
      const fade = o.life < 120 ? (Math.floor(time / 80) % 2 ? 0.3 : 1) : 1;
      const col = o.lost ? C.red : o.value >= 5 ? C.redDeep : C.ink;
      gBlob(this.gFront, o.x, o.y + bob, size * 2.2, o.lost ? C.red : C.wash, 0.14 * fade, r, 0.3);
      gBlob(this.gFront, o.x, o.y + bob, size, col, 0.9 * fade, r, 0.2);
      if (o.lost) star(this.gFront, o.x, o.y + bob, 6 + Math.sin(time * 0.01 + o.id) * 2, C.red, 0.5 * fade, r);
    }
  }

  private drawPlayer(p: Player, alpha: number, dt: number, time: number, boil: number): Pt {
    const pos = this.lerpPos(p.id, p.x, p.y, alpha);
    let ph = this.phase.get(p.id) ?? 0;
    if (p.onGround) ph += Math.abs(p.vx) * dt * this.timeScale * 0.075;
    this.phase.set(p.id, ph);
    const t = p.stateT + (p.freeze > 0 ? 0 : alpha);
    const view = samuraiPose(p, t, ph, this.world.tick, this.world.tick - this.parryTick, time);
    this.lastPlayerPose = view.pose;
    const X = makeXf(pos.x, pos.y, p.facing, view.rot);
    const sk = buildSkeleton(view.pose, SAMURAI);
    const r = seeded(hash2(p.id + 999, boil));

    this.updateScarf(headBackWorld(sk, X), p, dt * this.timeScale, time);

    if (p.state === 'dash' || p.state === 'iaiStrike' || (p.state === 'slide' && p.stateT < 10)) {
      this.ghostTimer -= dt;
      if (this.ghostTimer <= 0) {
        this.ghostTimer = 0.03;
        this.fx.ghost(view.pose, pos.x, pos.y, p.facing, view.rot, 0.22, C.washLight, 0.5);
      }
    }

    // Croissant d'encre de la lame
    const tr = slashTrail(p, t);
    if (tr) {
      const tips = tr.tips.map(X);
      gFill(this.gChars, tips.concat(tr.wash.map(X).reverse()), C.wash, 0.22 * tr.alpha);
      gFill(this.gChars, tips.concat(tr.inner.map(X).reverse()), C.ink, 0.9 * tr.alpha);
      if (tr.heavy) gStroke(this.gChars, tips, C.red, 0.85 * tr.alpha, { width: 2.4, taperStart: 0.6, taperEnd: 0.05 }, r);
    }
    if (p.state === 'attack' && p.attack === 'plunge' && !p.plungeLanded && p.stateT > ATTACKS.plunge.startup) {
      for (let i = -1; i <= 1; i++) {
        gStroke(this.gBack, [{ x: pos.x + i * 7, y: pos.y - 110 - r() * 40 }, { x: pos.x + i * 7, y: pos.y - 40 }], C.ink, 0.35, { width: 2.2, taperStart: 0.9, taperEnd: 0.1 }, r);
      }
    }
    if (p.state === 'iaiCharge') {
      const k = Math.min(1, p.iaiCharge / P.IAI_FULL_CHARGE);
      const a0 = time * 0.004;
      gStroke(this.gBack, ringPoints(pos.x, pos.y - 24, 70 - 44 * k, a0, a0 + Math.PI * 1.6, 24), k >= 1 ? C.red : C.ink, 0.15 + 0.25 * k, { width: 2 + 3 * k, taperStart: 0.3, taperEnd: 0.6 }, r);
      if (Math.random() < 0.3) {
        const ang = Math.random() * Math.PI * 2;
        this.fx.mist(pos.x + Math.cos(ang) * 60, pos.y - 24 + Math.sin(ang) * 40, 1, { color: C.ink, size: 2.5, alpha: 0.4, vx: -Math.cos(ang) * 120, vy: -Math.sin(ang) * 80, life: 0.4, spread: 0 });
      }
    }

    let a = 1;
    if (p.iframes > 0 && p.state !== 'dash' && p.state !== 'iaiStrike' && p.state !== 'dead' && Math.floor(time / 70) % 2 === 0) a = 0.4;
    if (p.state === 'dead') a = Math.min(1, p.respawnT / 40);
    drawSamurai(this.gChars, sk, X, {
      alpha: a,
      tint: this.hurtFlash > 0 ? C.red : null,
      rand: r,
      glint: p.state === 'iaiCharge' ? Math.min(1, p.iaiCharge / P.IAI_FULL_CHARGE) : 0,
      scarf: this.scarf,
    });
    this.hurtFlash -= dt;
    return pos;
  }

  /** Hachimaki : chaîne de points qui suit la tête avec du retard (vent + gravité). */
  private updateScarf(anchor: Pt, p: Player, dt: number, time: number): void {
    const n = 8;
    const seg = 5;
    if (this.scarf.length !== n || Math.abs(this.scarf[0].x - anchor.x) > 100) {
      this.scarf = Array.from({ length: n }, (_, i) => ({ x: anchor.x - p.facing * i * seg, y: anchor.y }));
    }
    this.scarf[0] = { x: anchor.x, y: anchor.y };
    for (let i = 1; i < n; i++) {
      const q = this.scarf[i];
      q.x += (-p.facing * 26 + Math.sin(time * 0.006 + i * 0.9) * 18) * dt;
      q.y += (34 + Math.cos(time * 0.009 + i * 0.7) * 22) * dt;
      const pr = this.scarf[i - 1];
      const dx = q.x - pr.x;
      const dy = q.y - pr.y;
      const d = Math.hypot(dx, dy) || 1;
      q.x = pr.x + (dx / d) * seg;
      q.y = pr.y + (dy / d) * seg;
    }
  }

  private updateCamera(pos: Pt, dt: number): void {
    const p = this.me;
    const look = p.facing * 60 + Phaser.Math.Clamp(p.vx * 0.2, -70, 70);
    this.camX += (pos.x + look - this.camX) * (1 - Math.exp(-dt * 4.5));
    this.camY += (pos.y - 60 - this.camY) * (1 - Math.exp(-dt * 3));
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.2) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
    }
    this.shake *= Math.exp(-dt * 12);
    this.zoomPunch *= Math.exp(-dt * 7);
    this.worldCam.setZoom(ZOOM * (1 + this.zoomPunch));
    this.worldCam.centerOn(this.camX + sx, this.camY + sy);
  }

  private drawDebug(): void {
    const g = this.gDebug;
    const rect = (r: Rect, color: number) => {
      g.lineStyle(1, color, 0.9);
      g.strokeRect(r.x, r.y, r.w, r.h);
    };
    for (const p of this.world.players) {
      rect(bodyRect(p), 0x2266ff);
      const ab = activeAttackBox(p);
      if (ab) rect(ab, 0xff2222);
    }
    for (const e of this.world.enemies) {
      rect(bodyRect(e), 0x22aa44);
      if (e.state !== 'attack') continue;
      if (e.type === 'ashigaru') rect(boxFromFacing(e.x, e.y, e.facing, SPEAR_HB), 0xff8800);
      if (e.type === 'oni') rect(boxFromFacing(e.x, e.y, e.facing, ONI_SMASH_HB), 0xff8800);
      if (e.type === 'ninja') rect(boxFromFacing(e.x, e.y, e.facing, NINJA_SLASH_HB), 0xff8800);
      if (e.type === 'boss' && e.move === 'sweep') rect(boxFromFacing(e.x, e.y, e.facing, BOSS.SWEEP_HB), 0xff8800);
    }
  }

  // ─── Événements de simulation → mise en scène ────────────────────────────

  private addShake(v: number): void {
    this.shake = Math.max(this.shake, v);
  }

  private near(x: number): boolean {
    return Math.abs(x - this.me.x) < 700;
  }

  private popKanji(text: string, x: number, y: number, color: string, size: number): void {
    const t = this.put(this.add.text(x, y, text, { fontFamily: FONT_BRUSH, fontSize: `${size}px`, color }).setOrigin(0.5).setDepth(40).setScale(1.7).setAlpha(0.95), 'world');
    this.tweens.add({ targets: t, scale: 1, duration: 160, ease: 'Back.easeOut' });
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, delay: 380, duration: 600, ease: 'Sine.easeIn', onComplete: () => t.destroy() });
  }

  private onEvent(ev: GameEvent): void {
    const fx = this.fx;
    switch (ev.type) {
      case 'swing':
        this.sfx.swing(ATTACKS[ev.attack].heavy);
        if (ev.attack === 'slash3') fx.dust(ev.x, ev.y, -ev.dir, 5);
        break;
      case 'hit':
        this.sfx.hit(ev.heavy);
        fx.inkBurst(ev.x, ev.y, ev.dir, ev.heavy ? 16 : 10, ev.heavy ? 420 : 300);
        fx.sparks(ev.x, ev.y, 5, C.ink, 300);
        this.addShake(ev.heavy ? 9 : 4);
        break;
      case 'kill': {
        const pose = this.lastPose.get(ev.id);
        const boss = ev.enemyType === 'boss';
        if (pose) fx.corpse(ev.enemyType, pose, ev.x, ev.y, ev.facing, ev.dir, ev.cutAngle, ev.byIai || boss);
        const h = 22 * SCALE[ev.enemyType];
        fx.inkBurst(ev.x, ev.y - h, ev.dir, ev.byIai ? 34 : boss ? 70 : 22, ev.byIai ? 520 : boss ? 620 : 380);
        if (ev.byIai || boss) fx.inkBurst(ev.x, ev.y - h, ev.dir, boss ? 30 : 8, 300, C.red);
        this.sfx.slice();
        this.addShake(boss ? 18 : 5);
        this.lastPose.delete(ev.id);
        this.prev.delete(ev.id);
        this.phase.delete(ev.id);
        if (ev.pid === this.me.id) this.best = Math.max(this.best, this.me.kills);
        if (boss) {
          this.slowmo = 1.1;
          this.flash = 0.2;
          this.sfx.gong();
          this.hud.banner('討', 'Akaoni est tombé !', `+${ev.honor} honneur`, '#b8321f', 2400);
        }
        break;
      }
      case 'doom':
        fx.sparks(ev.x, ev.y, 4, C.red, 200);
        break;
      case 'parry':
        this.sfx.parry();
        fx.sparks(ev.x, ev.y, 18, C.red, 520);
        fx.sparks(ev.x, ev.y, 10, C.ink, 400);
        fx.ring(ev.x, ev.y, 6, 46, 0.3, C.ink, 4);
        this.popKanji('弾', ev.x, ev.y - 34, '#b8321f', 46);
        this.addShake(6);
        this.flash = 0.06;
        this.slowmo = 0.12;
        this.parryTick = this.world.tick;
        break;
      case 'deflect':
        this.sfx.deflect();
        fx.sparks(ev.x, ev.y, 8, C.red, 380);
        break;
      case 'block':
        this.sfx.block();
        fx.sparks(ev.x, ev.y, 10, C.ink, 360);
        fx.ring(ev.x, ev.y, 4, 22, 0.18, C.ink, 2.5);
        this.addShake(3);
        break;
      case 'guardBreak':
        this.sfx.guardBreak();
        fx.sparks(ev.x, ev.y, 16, C.red, 480);
        fx.inkBurst(ev.x, ev.y, 1, 8, 260, C.wood);
        this.popKanji('破', ev.x, ev.y - 30, '#b8321f', 44);
        this.addShake(8);
        break;
      case 'playerHit':
        this.sfx.hurt();
        fx.inkBurst(ev.x, ev.y, ev.dir, 14, 320, C.red);
        this.hurtFlash = 0.12;
        this.addShake(10);
        break;
      case 'playerDeath':
        this.sfx.death();
        this.lastLost = ev.lost;
        fx.inkBurst(ev.x, ev.y - 24, 1, 20, 400, C.red);
        fx.inkBurst(ev.x, ev.y - 24, -1, 20, 400, C.ink);
        this.slowmo = 0.6;
        this.addShake(14);
        break;
      case 'respawn':
        fx.mist(ev.x, ev.y - 20, 14, { color: C.ink, size: 10, alpha: 0.25, spread: 30, vy: -30, life: 0.8, front: true });
        fx.ring(ev.x, ev.y - 24, 10, 60, 0.5, C.ink, 4);
        this.sfx.spawn();
        break;
      case 'jump':
        this.sfx.jump(ev.double);
        if (ev.double) fx.ring(ev.x, ev.y - 4, 4, 28, 0.3, C.wash, 2.5);
        else fx.dust(ev.x, ev.y, 0, 5);
        break;
      case 'wallJump':
        this.sfx.jump(false);
        fx.dust(ev.x, ev.y, ev.dir, 6);
        break;
      case 'land':
        if (ev.impact > 450) {
          fx.dust(ev.x, ev.y, 1, 4);
          fx.dust(ev.x, ev.y, -1, 4);
          this.sfx.land(ev.impact > 850);
          if (ev.impact > 850) this.addShake(4);
        }
        break;
      case 'dash':
        this.sfx.dash();
        fx.mist(ev.x - ev.dir * 10, ev.y - 24, 6, { color: C.wash, size: 8, alpha: 0.25, vx: -ev.dir * 80 });
        break;
      case 'slide':
        this.sfx.dash();
        fx.dust(ev.x, ev.y, -ev.dir, 8);
        break;
      case 'iaiStart':
        this.sfx.iaiCharge();
        break;
      case 'iaiReady':
        this.sfx.iaiReady();
        fx.ring(ev.x, ev.y, 34, 4, 0.25, C.red, 2.5);
        break;
      case 'iai': {
        this.sfx.iai(ev.full);
        const y = ev.y - 26;
        const dir = Math.sign(ev.x1 - ev.x0) || this.me.facing;
        const xa = ev.x0 - dir * 20;
        const xb = ev.x1 + dir * 40;
        const pts: Pt[] = [];
        for (let i = 0; i <= 12; i++) pts.push({ x: lerp(xa, xb, i / 12), y: y + (Math.random() - 0.5) * 2 });
        fx.line(pts, ev.full ? 10 : 6.5, C.ink, 0.95, 0.55, true);
        fx.line(pts.map((q) => ({ x: q.x, y: q.y + 1 })), 2, C.red, 0.9, 0.65, true);
        if (this.lastPlayerPose) {
          for (let i = 0; i < 5; i++) fx.ghost(this.lastPlayerPose, lerp(ev.x0, ev.x1, i / 5), ev.y, dir, 0, 0.3 + i * 0.04, C.wash, 0.45);
        }
        fx.dust(ev.x0, ev.y, -dir, 10);
        this.addShake(ev.full ? 14 : 9);
        this.flash = ev.full ? 0.12 : 0.07;
        this.zoomPunch = ev.full ? 0.08 : 0.05;
        if (ev.count > 0) {
          this.slowmo = ev.full ? 0.45 : 0.3;
          this.popKanji('斬', ev.x1 + dir * 34, y - 44, '#15120e', ev.full ? 96 : 72);
        }
        break;
      }
      case 'plungeLand':
        this.sfx.land(true);
        fx.ring(ev.x, ev.y - 2, 6, 62, 0.35, C.ink, 4);
        fx.dust(ev.x, ev.y, 1, 8);
        fx.dust(ev.x, ev.y, -1, 8);
        this.addShake(8);
        break;
      case 'windSlash':
        this.sfx.swing(true);
        fx.mist(ev.x, ev.y, 4, { color: C.wash, size: 6, alpha: 0.3, vx: ev.dir * 200 });
        break;
      case 'orb':
        this.orbStreak++;
        this.orbStreakT = 0.6;
        this.sfx.orb(this.orbStreak, ev.lost);
        if (ev.value >= 5 || ev.lost) fx.sparks(this.me.x, this.me.y - 26, 2, ev.lost ? C.red : C.ink, 160);
        break;
      case 'levelUp':
        this.sfx.levelUp();
        fx.ring(this.me.x, this.me.y - 24, 10, 70, 0.5, C.red, 3);
        this.popKanji('昇', this.me.x, this.me.y - 70, '#b8321f', 40);
        break;
      case 'pick': {
        const t = UPGRADE_TEXT[ev.upgrade];
        this.sfx.pick();
        this.popKanji(t.kanji, this.me.x, this.me.y - 72, '#15120e', 48);
        fx.ring(this.me.x, this.me.y - 24, 40, 6, 0.3, C.ink, 3);
        break;
      }
      case 'checkpoint':
        this.sfx.bell();
        fx.ring(ev.x, ev.y - 40, 6, 50, 0.6, C.red, 3);
        this.hud.banner('社', 'Sanctuaire', 'point de renaissance · vie restaurée', '#15120e', 1100);
        break;
      case 'spawn':
        fx.mist(ev.x, ev.y - 22, 10, { color: C.ink, size: 9, alpha: 0.22, spread: 24, vy: -20, life: 0.9 });
        break;
      case 'windup':
        if (this.near(ev.x)) this.sfx.tick();
        break;
      case 'arrowFire':
        if (this.near(ev.x)) this.sfx.bow();
        break;
      case 'throw':
        if (this.near(ev.x)) this.sfx.shuriken();
        break;
      case 'arrowBreak':
        fx.sparks(ev.x, ev.y, 4, C.wood, 200);
        break;
      case 'alert':
        this.popKanji('!', ev.x, ev.y - 16, '#b8321f', 26);
        break;
      case 'vanish':
      case 'appear':
        fx.mist(ev.x, ev.y, 9, { color: C.inkSoft, size: 9, alpha: 0.35, spread: 22, vy: -25, life: 0.6, front: true });
        if (this.near(ev.x)) this.sfx.smoke();
        break;
      case 'slam': {
        const big = ev.w > 100;
        this.sfx.slam(big);
        fx.dust(ev.x, ev.y, 1, big ? 14 : 6);
        fx.dust(ev.x, ev.y, -1, big ? 14 : 6);
        if (big) {
          fx.ring(ev.x, ev.y - 4, 10, ev.w, 0.35, C.ink, 5);
          for (const d of [-1, 1]) fx.line([{ x: ev.x, y: ev.y - 2 }, { x: ev.x + d * ev.w * 0.5, y: ev.y - 3 }, { x: ev.x + d * ev.w, y: ev.y - 2 }], 5, C.ink, 0.8, 0.4, true);
        }
        this.addShake(big ? 14 : 5);
        break;
      }
      case 'charge':
        this.sfx.roar();
        fx.dust(ev.x, ev.y, -ev.dir, 12);
        break;
      case 'horn':
        this.sfx.horn();
        fx.ring(ev.x, ev.y, 10, 90, 0.8, C.redDeep, 4);
        break;
      case 'roar':
        this.sfx.roar();
        fx.ring(ev.x, ev.y + 20, 20, 140, 0.6, C.red, 5);
        this.addShake(10);
        break;
      case 'bossPhase':
        this.flash = 0.15;
        this.hud.banner('怒', 'Akaoni entre en rage', 'plus rapide · charge dévastatrice', '#8e2416', 1400);
        break;
      case 'bossSpawn':
        this.hud.banner('赤鬼', 'Akaoni, général démon', 'balayage : baissez-vous · bond : sautez · charge : dash', '#8e2416', 2600);
        fx.mist(ev.x, ev.y - 50, 26, { color: C.ink, size: 16, alpha: 0.3, spread: 70, vy: -30, life: 1.2, front: true });
        break;
      case 'tideWarn':
        this.sfx.taiko(false);
        this.hud.banner('潮', `La Marée monte — vague ${ev.n}`, 'tenez bon', '#8e2416', 1800);
        break;
      case 'arenaLock':
        this.sfx.taiko(true);
        fx.mist(ev.x, this.me.y - 60, 20, { color: C.redDeep, size: 12, alpha: 0.3, spread: 40, vy: -20, life: 1, front: true });
        this.addShake(8);
        break;
      case 'arenaReset':
        break;
      case 'gateOpen': {
        this.sfx.bell();
        this.sfx.gong();
        for (let k = 0; k < 3; k++) {
          const sx = ev.x - 31 + (0.25 + k * 0.25) * 62;
          fx.sparks(sx, ev.y - 74, 10, C.red, 260);
          fx.mist(sx, ev.y - 74, 5, { color: C.redDeep, size: 6, alpha: 0.35, vy: -50, life: 0.9, front: true });
        }
        this.hud.banner('開', 'La porte est ouverte', 'franchissez le torii pour achever l’étape', '#b8321f', 2000);
        break;
      }
      case 'stageClear':
        this.sfx.bell();
        this.flash = 0.25;
        fx.ring(this.world.level.gate.x, this.world.level.gate.y - 50, 10, 120, 0.8, C.red, 4);
        this.results.show(this.world.stage);
        break;
      case 'stageStart':
        this.results.hide();
        this.wipe = 1.3;
        this.terrain.repaint();
        this.prev.clear();
        this.phase.clear();
        this.lastPose.clear();
        this.scarf = [];
        this.lastLost = 0;
        this.sfx.taiko(false);
        this.hud.banner('周', `Le voyage recommence — boucle ${ev.loop + 1}`, 'les ennemis sont plus nombreux et plus redoutables', '#15120e', 2200);
        break;
      case 'tideStart':
        this.sfx.drum(0, true);
        break;
      case 'tideEnd':
        this.sfx.gong();
        if (ev.bonus > 0) this.hud.banner('凪', 'La Marée se retire', `+${ev.bonus} honneur`, '#15120e', 1600);
        break;
    }
  }
}
