import Phaser from 'phaser';
import { gFill, gStroke, ringPoints, seeded } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

/** Délai pendant lequel l'écran ignore touches et clics après son apparition. */
const INPUT_GUARD_MS = 300;
const COL_ON = '#15120e';
const COL_OFF = '#6b6359';

/** Écran titre (浪人) avec un petit menu : jouer ou consulter le tableau d'honneur. */
export class TitleScreen {
  private root: Phaser.GameObjects.Container;
  private entries: Phaser.GameObjects.Text[] = [];
  private mark: Phaser.GameObjects.Graphics;
  private sel = 0;
  private shown = false;
  private readyAt = 0;
  private actions: (() => void)[];

  constructor(private scene: Phaser.Scene, put: Put, cb: { onPlay(): void; onScores(): void }) {
    this.actions = [() => cb.onPlay(), () => cb.onScores()];
    const W = scene.scale.width;
    const H = scene.scale.height;
    const r = seeded(9);
    // Même composition que l'ancien écran titre : voile, 浪人, sceau 侍 et anneau d'encre.
    const veil = scene.add.rectangle(0, 0, W, H, C.paper, 0.78).setOrigin(0);
    const kanji = scene.add.text(W / 2 - 20, H * 0.36, '浪人', { fontFamily: FONT_BRUSH, fontSize: '200px', color: '#15120e' }).setOrigin(0.5);
    const seal = scene.add.graphics();
    const sx = W / 2 + 205;
    const sy = H * 0.2;
    gFill(seal, [{ x: sx - 30, y: sy - 31 }, { x: sx + 31, y: sy - 29 }, { x: sx + 29, y: sy + 31 }, { x: sx - 31, y: sy + 29 }], C.red, 0.92);
    gStroke(seal, ringPoints(W / 2 - 20, H * 0.36, 175, -2.6, 2.9, 40), C.ink, 0.12, { width: 22, taperStart: 0.3, taperEnd: 0.6 }, r);
    const sealText = scene.add.text(sx, sy, '侍', { fontFamily: FONT_BRUSH, fontSize: '44px', color: '#f0e7d3' }).setOrigin(0.5);
    const name = scene.add.text(W / 2, H * 0.6, 'R O N I N . I O', { fontFamily: FONT_TEXT, fontSize: '34px', color: '#15120e' }).setOrigin(0.5);
    const sub = scene.add.text(W / 2, H * 0.66, 'the way of the sword', { fontFamily: FONT_TEXT, fontSize: '18px', color: '#4a433b' }).setOrigin(0.5);

    // Trait de pinceau rouge sous l'entrée sélectionnée (dessiné en coordonnées locales,
    // pour pouvoir le « tracer » de gauche à droite via scaleX).
    this.mark = scene.add.graphics();
    const labels = ['Draw your blade', 'Hall of Honor'];
    labels.forEach((label, i) => {
      const t = scene.add.text(W / 2, 548 + i * 50, label, { fontFamily: FONT_TEXT, fontSize: '27px', color: COL_OFF }).setOrigin(0.5);
      t.setInteractive({ useHandCursor: true });
      t.on('pointerover', () => {
        if (this.shown) this.select(i);
      });
      t.on('pointerdown', () => {
        if (!this.ready()) return;
        this.select(i);
        this.confirm();
      });
      this.entries.push(t);
    });
    const help = scene.add.text(W / 2, 676, '↑↓ choose  ·  Enter confirm', { fontFamily: FONT_TEXT, fontSize: '15px', color: '#6b6359' }).setOrigin(0.5).setAlpha(0.8);

    // Tous les enfants sont créés avant `put` : la caméra ignore le conteneur entier.
    this.root = put(
      scene.add.container(0, 0, [veil, seal, kanji, sealText, name, sub, this.mark, ...this.entries, help]).setDepth(200).setVisible(false),
      'ui',
    );
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    this.scene.tweens.killTweensOf([this.root, this.mark]);
    this.shown = true;
    this.readyAt = this.scene.time.now + INPUT_GUARD_MS;
    this.root.setVisible(true).setAlpha(0);
    this.scene.tweens.add({ targets: this.root, alpha: 1, duration: 450, ease: 'Sine.easeOut' });
    this.select(0, true);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.scene.tweens.killTweensOf([this.root, this.mark]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 400, ease: 'Sine.easeIn', onComplete: () => this.root.setVisible(false) });
  }

  key(code: string): void {
    if (!this.ready()) return;
    if (code === 'ArrowUp' || code === 'KeyW') this.select((this.sel + this.entries.length - 1) % this.entries.length);
    else if (code === 'ArrowDown' || code === 'KeyS') this.select((this.sel + 1) % this.entries.length);
    else if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') this.confirm();
  }

  private ready(): boolean {
    return this.shown && this.scene.time.now >= this.readyAt;
  }

  private confirm(): void {
    this.actions[this.sel]();
  }

  private select(i: number, force = false): void {
    if (i === this.sel && !force) return;
    this.sel = i;
    this.entries.forEach((t, k) => t.setColor(k === i ? COL_ON : COL_OFF));
    const t = this.entries[i];
    const half = t.width / 2 + 16;
    const r = seeded(101 + i * 17);
    const g = this.mark;
    g.clear();
    gStroke(g, [{ x: 0, y: 2 }, { x: half, y: -1 }, { x: half * 2, y: 1 }], C.red, 0.85, { width: 6, taperStart: 0.08, taperEnd: 0.5, jitter: 0.25 }, r, 4);
    gFill(g, [{ x: -18, y: -24 }, { x: -12, y: -25 }, { x: -13, y: -19 }, { x: -19, y: -18 }], C.red, 0.9);
    g.setPosition(t.x - half, t.y + 20);
    this.scene.tweens.killTweensOf(g);
    g.setScale(0.15, 1).setAlpha(0.4);
    this.scene.tweens.add({ targets: g, scaleX: 1, alpha: 1, duration: 180, ease: 'Quad.easeOut' });
  }
}
