import Phaser from 'phaser';
import { DIFFICULTY_TEXT, fmtScore } from './difficultyText';
import type { DifficultyId } from '../../shared/difficulty';
import { gFill, gStroke, seeded, type Pt } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';
import { MAX_NAME } from '../scores/types';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

const INPUT_GUARD_MS = 300;

/** Caractères acceptés à la frappe : les mêmes que ceux conservés par sanitizeName. */
const NAME_CHAR = /^[\p{L}\p{N} ._-]$/u;

/** Longueur en points de code (un emoji ou un kanji hors BMP compte pour un). */
const cpLen = (s: string): number => Array.from(s).length;

/** Fin de partie avec un score digne du tableau : le joueur inscrit son nom (終). */
export class NameEntry {
  private root: Phaser.GameObjects.Container;
  private panel: Phaser.GameObjects.Graphics;
  private scoreText: Phaser.GameObjects.Text;
  private record: Phaser.GameObjects.Text;
  private field: Phaser.GameObjects.Text;
  private counter: Phaser.GameObjects.Text;
  private cursor: Phaser.GameObjects.Graphics;
  private help: Phaser.GameObjects.Text;
  private stamp: Phaser.GameObjects.Container;
  private text = '';
  private shown = false;
  private readyAt = 0;

  constructor(private scene: Phaser.Scene, put: Put, private cb: { onSubmit(name: string): void }) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const cx = W / 2;
    const veil = scene.add.rectangle(0, 0, W, H, C.paper, 0.55).setOrigin(0);
    this.panel = scene.add.graphics();
    this.drawPanel();
    const kanji = scene.add.text(cx, 176, '終', { fontFamily: FONT_BRUSH, fontSize: '96px', color: '#15120e' }).setOrigin(0.5);
    const ends = scene.add.text(cx, 246, 'Your journey ends', { fontFamily: FONT_TEXT, fontSize: '20px', color: '#4a433b' }).setOrigin(0.5);
    this.scoreText = scene.add.text(cx, 312, '0', { fontFamily: FONT_BRUSH, fontSize: '66px', color: '#15120e' }).setOrigin(0.5);
    this.record = scene.add.text(cx, 368, '', { fontFamily: FONT_TEXT, fontSize: '18px', color: '#b8321f' }).setOrigin(0.5);
    const label = scene.add.text(cx - 210, 418, 'Your name', { fontFamily: FONT_TEXT, fontSize: '16px', color: '#6b6359' }).setOrigin(0, 0.5);
    this.counter = scene.add.text(cx + 210, 418, '', { fontFamily: FONT_TEXT, fontSize: '15px', color: '#6b6359' }).setOrigin(1, 0.5);
    this.field = scene.add.text(cx - 206, 460, '', { fontFamily: FONT_BRUSH, fontSize: '32px', color: '#15120e' }).setOrigin(0, 0.5);
    this.cursor = scene.add.graphics();
    gStroke(this.cursor, [{ x: 0, y: -18 }, { x: 1, y: 0 }, { x: 0, y: 18 }], C.red, 0.9, { width: 3.5, taperStart: 0.1, taperEnd: 0.3, jitter: 0.2 }, seeded(3));
    this.help = scene.add.text(cx, 548, 'Enter — inscribe your name', { fontFamily: FONT_TEXT, fontSize: '18px', color: '#b8321f' }).setOrigin(0.5);
    // Cliquable aussi (souris, ou validation à la manette relayée par la scène).
    this.help.setInteractive({ useHandCursor: true });
    this.help.on('pointerdown', () => this.keyText('Enter', 'Enter'));

    // Petit hanko « 誉 » tamponné à côté du score.
    const sg = scene.add.graphics();
    const r = seeded(77);
    gFill(sg, [{ x: -30, y: -31 }, { x: 31, y: -29 }, { x: 29, y: 31 }, { x: -31, y: 29 }], C.red, 0.92);
    gStroke(sg, [{ x: -25, y: -25 }, { x: 26, y: -24 }, { x: 24, y: 25 }, { x: -26, y: 24 }, { x: -25, y: -25 }], C.paper, 0.5, { width: 2, taperStart: 0, taperEnd: 0, jitter: 0.4 }, r);
    const sk = scene.add.text(0, 0, '誉', { fontFamily: FONT_BRUSH, fontSize: '42px', color: '#f0e7d3' }).setOrigin(0.5);
    this.stamp = scene.add.container(cx + 215, 190, [sg, sk]);

    this.root = put(
      scene.add
        .container(0, 0, [veil, this.panel, kanji, ends, this.scoreText, this.record, label, this.counter, this.field, this.cursor, this.help, this.stamp])
        .setDepth(210)
        .setVisible(false),
      'ui',
    );
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Texte brut saisi (l'appelant le nettoie avant stockage). */
  get name(): string {
    return this.text;
  }

  show(info: { score: number; rank: number; difficulty: DifficultyId; defaultName: string }): void {
    this.scene.tweens.killTweensOf([this.root, this.cursor, this.help, this.stamp, this.scoreText]);
    this.shown = true;
    this.readyAt = this.scene.time.now + INPUT_GUARD_MS;
    this.text = Array.from(info.defaultName).slice(0, MAX_NAME).join('');
    this.scoreText.setText(fmtScore(info.score));
    const where = DIFFICULTY_TEXT[info.difficulty].name;
    this.record.setText(info.rank === 0 ? `New record — rank #1 in ${where}` : `A place in the Hall of Honor — rank #${info.rank + 1} in ${where}`);
    this.refresh();

    this.root.setVisible(true).setAlpha(0).setY(20);
    this.scene.tweens.add({ targets: this.root, alpha: 1, y: 0, duration: 500, ease: 'Sine.easeOut' });
    this.scoreText.setScale(1.25);
    this.scene.tweens.add({ targets: this.scoreText, scale: 1, delay: 200, duration: 500, ease: 'Back.easeOut' });
    this.stamp.setScale(3).setAlpha(0).setAngle(-18);
    this.scene.tweens.add({ targets: this.stamp, scale: 1, alpha: 1, angle: -6, delay: 650, duration: 220, ease: 'Quad.easeIn' });
    this.cursor.setAlpha(1);
    this.scene.tweens.add({ targets: this.cursor, alpha: 0, duration: 480, yoyo: true, repeat: -1, ease: 'Stepped', easeParams: [1] });
    this.scene.tweens.add({ targets: this.help, alpha: { from: 0.4, to: 1 }, delay: 800, duration: 800, yoyo: true, repeat: -1 });
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.scene.tweens.killTweensOf([this.root, this.cursor, this.help, this.stamp, this.scoreText]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 300, onComplete: () => this.root.setVisible(false) });
  }

  /** Reçoit chaque touche en mode saisie (`e.key`, `e.code`). */
  keyText(key: string, code: string): void {
    if (!this.shown || this.scene.time.now < this.readyAt) return;
    if (code === 'Backspace') {
      this.text = Array.from(this.text).slice(0, -1).join('');
    } else if (code === 'Enter' || code === 'NumpadEnter') {
      this.cb.onSubmit(this.text);
      return;
    } else if (cpLen(key) === 1 && NAME_CHAR.test(key)) {
      if (cpLen(this.text) >= MAX_NAME) return;
      this.text += key;
    } else {
      return;
    }
    this.refresh();
  }

  private refresh(): void {
    this.field.setText(this.text);
    this.counter.setText(`${cpLen(this.text)}/${MAX_NAME}`);
    this.cursor.setPosition(this.field.x + this.field.width + 5, this.field.y);
  }

  private drawPanel(): void {
    const cx = this.scene.scale.width / 2;
    const r = seeded(131);
    const g = this.panel;
    const quad: Pt[] = [{ x: cx - 300, y: 108 }, { x: cx + 302, y: 104 }, { x: cx + 298, y: 596 }, { x: cx - 304, y: 592 }];
    gFill(g, quad, C.paper, 0.96);
    gStroke(g, [...quad, quad[0]], C.ink, 0.85, { width: 3.5, taperStart: 0.02, taperEnd: 0.04, jitter: 0.3 }, r);
    // Ligne d'écriture du nom, comme un trait tiré à l'encre sur le papier.
    gStroke(g, [{ x: cx - 214, y: 490 }, { x: cx, y: 492 }, { x: cx + 214, y: 489 }], C.ink, 0.7, { width: 2.6, taperStart: 0.05, taperEnd: 0.4, jitter: 0.25 }, r, 3);
    gStroke(g, [{ x: cx - 150, y: 392 }, { x: cx + 150, y: 393 }], C.ink, 0.25, { width: 1.6, taperStart: 0.3, taperEnd: 0.3 }, r);
  }
}
