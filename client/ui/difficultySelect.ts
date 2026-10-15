import Phaser from 'phaser';
import { DIFFICULTY_TEXT } from './difficultyText';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../../shared/difficulty';
import { gFill, gStroke, seeded, type Pt } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

const INPUT_GUARD_MS = 300;

/** Présentation de chaque voie : kanji, nom et une ligne d'ambiance. */
const ROW_Y0 = 252;
const ROW_STEP = 76;

/** Formate un multiplicateur sans zéros superflus (0.5 → « 0.5 », 1 → « 1 »). */
function fmtMult(k: number): string {
  return String(Math.round(k * 100) / 100);
}

/** Choix de la difficulté (道) avant la partie. */
export class DifficultySelect {
  private root: Phaser.GameObjects.Container;
  private panel: Phaser.GameObjects.Graphics;
  private mark: Phaser.GameObjects.Graphics;
  private kanjis: Phaser.GameObjects.Text[] = [];
  private names: Phaser.GameObjects.Text[] = [];
  private stats: Phaser.GameObjects.Text[] = [];
  private sel = 2;
  private shown = false;
  private readyAt = 0;

  constructor(private scene: Phaser.Scene, put: Put, private cb: { onPick(d: DifficultyId): void; onBack(): void }) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const cx = W / 2;
    const veil = scene.add.rectangle(0, 0, W, H, C.paper, 0.6).setOrigin(0);
    this.panel = scene.add.graphics();
    this.drawPanel();
    const title = scene.add.text(cx, 114, '道', { fontFamily: FONT_BRUSH, fontSize: '78px', color: '#15120e' }).setOrigin(0.5);
    const sub = scene.add.text(cx, 174, 'Choose your path', { fontFamily: FONT_TEXT, fontSize: '26px', color: '#3a342d' }).setOrigin(0.5);
    // Le trait rouge et le lavis de sélection passent sous le texte des lignes.
    this.mark = scene.add.graphics();
    const rows: Phaser.GameObjects.GameObject[] = [];
    DIFFICULTY_ORDER.forEach((id, i) => {
      const y = ROW_Y0 + i * ROW_STEP;
      const p = DIFFICULTY_TEXT[id];
      const lives = DIFFICULTIES[id].lives;
      const k = scene.add.text(cx - 300, y, p.kanji, { fontFamily: FONT_BRUSH, fontSize: '50px', color: '#15120e' }).setOrigin(0.5);
      const n = scene.add.text(cx - 250, y - 12, p.name, { fontFamily: FONT_TEXT, fontSize: '25px', color: '#6b6359' }).setOrigin(0, 0.5);
      const d = scene.add.text(cx - 250, y + 17, p.desc, { fontFamily: FONT_TEXT, fontSize: '15px', color: '#6b6359' }).setOrigin(0, 0.5);
      const s = scene.add
        .text(cx + 320, y - 12, `${lives} ${lives === 1 ? 'life' : 'lives'}  ·  score ×${fmtMult(DIFFICULTIES[id].scoreMult)}`, { fontFamily: FONT_TEXT, fontSize: '17px', color: '#6b6359' })
        .setOrigin(1, 0.5);
      // Zone cliquable couvrant toute la ligne (plus confortable que le seul texte).
      const z = scene.add.zone(cx, y + 2, 700, ROW_STEP - 6).setInteractive({ useHandCursor: true });
      z.on('pointerover', () => {
        if (this.shown) this.select(i);
      });
      z.on('pointerdown', () => {
        if (!this.ready()) return;
        this.select(i);
        this.cb.onPick(DIFFICULTY_ORDER[this.sel]);
      });
      this.kanjis.push(k);
      this.names.push(n);
      this.stats.push(s);
      rows.push(z, k, n, d, s);
    });
    const help = scene.add.text(cx, 632, '↑↓ choose  ·  Enter begin  ·  Esc back', { fontFamily: FONT_TEXT, fontSize: '15px', color: '#6b6359' }).setOrigin(0.5).setAlpha(0.85);
    this.root = put(scene.add.container(0, 0, [veil, this.panel, title, sub, this.mark, ...rows, help]).setDepth(200).setVisible(false), 'ui');
  }

  get visible(): boolean {
    return this.shown;
  }

  show(initial: DifficultyId): void {
    this.scene.tweens.killTweensOf([this.root, this.mark]);
    this.shown = true;
    this.readyAt = this.scene.time.now + INPUT_GUARD_MS;
    this.root.setVisible(true).setAlpha(0).setY(20);
    this.scene.tweens.add({ targets: this.root, alpha: 1, y: 0, duration: 450, ease: 'Sine.easeOut' });
    const i = DIFFICULTY_ORDER.indexOf(initial);
    this.select(i < 0 ? 2 : i, true);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.scene.tweens.killTweensOf([this.root, this.mark]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 300, onComplete: () => this.root.setVisible(false) });
  }

  key(code: string): void {
    if (!this.ready()) return;
    const n = DIFFICULTY_ORDER.length;
    if (code === 'ArrowUp' || code === 'KeyW') this.select((this.sel + n - 1) % n);
    else if (code === 'ArrowDown' || code === 'KeyS') this.select((this.sel + 1) % n);
    else if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') this.cb.onPick(DIFFICULTY_ORDER[this.sel]);
    else if (code === 'Escape') this.cb.onBack();
  }

  private ready(): boolean {
    return this.shown && this.scene.time.now >= this.readyAt;
  }

  private drawPanel(): void {
    const cx = this.scene.scale.width / 2;
    const r = seeded(53);
    const g = this.panel;
    const quad: Pt[] = [{ x: cx - 400, y: 62 }, { x: cx + 402, y: 58 }, { x: cx + 398, y: 662 }, { x: cx - 404, y: 658 }];
    gFill(g, quad, C.paper, 0.96);
    gStroke(g, [...quad, quad[0]], C.ink, 0.85, { width: 3.5, taperStart: 0.02, taperEnd: 0.04, jitter: 0.3 }, r);
    gStroke(g, [{ x: cx - 330, y: 204 }, { x: cx + 330, y: 206 }], C.ink, 0.55, { width: 2.4, taperStart: 0.1, taperEnd: 0.4 }, r);
    gStroke(g, [{ x: cx - 200, y: 606 }, { x: cx + 200, y: 605 }], C.ink, 0.3, { width: 1.8, taperStart: 0.3, taperEnd: 0.3 }, r);
  }

  private select(i: number, force = false): void {
    if (i === this.sel && !force) return;
    this.sel = i;
    this.kanjis.forEach((t, k) => t.setColor(k === i ? '#b8321f' : '#15120e').setAlpha(k === i ? 1 : 0.7));
    this.names.forEach((t, k) => t.setColor(k === i ? '#15120e' : '#6b6359'));
    this.stats.forEach((t, k) => t.setColor(k === i ? '#8e2416' : '#6b6359'));
    const cx = this.scene.scale.width / 2;
    const y = ROW_Y0 + i * ROW_STEP;
    const r = seeded(211 + i * 13);
    const g = this.mark;
    g.clear();
    // Lavis rouge très léger derrière la ligne, puis trait de pinceau sous la description.
    // Dessiné relativement au bord gauche pour « tracer » le trait via scaleX.
    const x0 = cx - 345;
    gFill(g, [{ x: 0, y: -34 }, { x: 680, y: -36 }, { x: 684, y: 36 }, { x: 4, y: 34 }], C.red, 0.07);
    gStroke(g, [{ x: 95, y: 34 }, { x: 380, y: 31 }, { x: 670, y: 33 }], C.red, 0.85, { width: 5, taperStart: 0.06, taperEnd: 0.55, jitter: 0.25 }, r, 4);
    gStroke(g, [{ x: 2, y: -26 }, { x: 0, y: 0 }, { x: 3, y: 28 }], C.red, 0.8, { width: 6, taperStart: 0.15, taperEnd: 0.5, jitter: 0.2 }, r, 3);
    g.setPosition(x0, y);
    this.scene.tweens.killTweensOf(g);
    g.setScale(0.1, 1).setAlpha(0.4);
    this.scene.tweens.add({ targets: g, scaleX: 1, alpha: 1, duration: 200, ease: 'Quad.easeOut' });
  }
}
