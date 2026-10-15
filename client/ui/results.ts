import Phaser from 'phaser';
import { TICK_RATE } from '../../shared/constants';
import type { StageState } from '../../shared/types';
import { gFill, gStroke, seeded } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

const GRADES = [
  { kanji: '優', name: 'Excellent' },
  { kanji: '良', name: 'Honorable' },
  { kanji: '可', name: 'Passable' },
];

/** Écran de bilan de fin d'étape (結果), avec note tamponnée au hanko. */
export class Results {
  private root: Phaser.GameObjects.Container;
  private panel: Phaser.GameObjects.Graphics;
  private stamp: Phaser.GameObjects.Container;
  private stampG: Phaser.GameObjects.Graphics;
  private stampKanji: Phaser.GameObjects.Text;
  private gradeName: Phaser.GameObjects.Text;
  private labels: Phaser.GameObjects.Text[] = [];
  private values: Phaser.GameObjects.Text[] = [];
  private footer: Phaser.GameObjects.Text;
  private subtitle: Phaser.GameObjects.Text;
  visible = false;

  constructor(private scene: Phaser.Scene, put: Put, private onStamp: () => void) {
    const W = scene.scale.width;
    const cx = W / 2;
    this.panel = scene.add.graphics();
    const title = scene.add.text(cx - 150, 150, '結果', { fontFamily: FONT_BRUSH, fontSize: '84px', color: '#15120e' }).setOrigin(0.5);
    this.subtitle = scene.add.text(cx - 150, 212, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#4a433b' }).setOrigin(0.5);
    // Une ligne de texte par statistique : libellé et valeur restent alignés.
    for (let i = 0; i < 6; i++) {
      const y = 262 + i * 34;
      this.labels.push(scene.add.text(cx - 270, y, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: '#3a342d' }).setOrigin(0, 0.5));
      this.values.push(scene.add.text(cx - 30, y, '', { fontFamily: FONT_BRUSH, fontSize: '23px', color: '#15120e' }).setOrigin(1, 0.5));
    }
    this.stampG = scene.add.graphics();
    this.stampKanji = scene.add.text(0, 0, '', { fontFamily: FONT_BRUSH, fontSize: '96px', color: '#f0e7d3' }).setOrigin(0.5);
    this.stamp = scene.add.container(cx + 170, 260, [this.stampG, this.stampKanji]);
    this.gradeName = scene.add.text(cx + 170, 360, '', { fontFamily: FONT_TEXT, fontSize: '20px', color: '#8e2416', align: 'center' }).setOrigin(0.5, 0);
    this.footer = scene.add.text(cx, 492, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: '#b8321f', align: 'center' }).setOrigin(0.5);
    this.root = put(
      scene.add.container(0, 0, [this.panel, title, this.subtitle, ...this.labels, ...this.values, this.stamp, this.gradeName, this.footer]).setDepth(115).setVisible(false),
      'ui',
    );
  }

  show(st: StageState): void {
    const W = this.scene.scale.width;
    const r = seeded(st.loop * 31 + 7);
    const g = this.panel;
    g.clear();
    gFill(g, [{ x: W / 2 - 330, y: 92 }, { x: W / 2 + 332, y: 88 }, { x: W / 2 + 328, y: 528 }, { x: W / 2 - 334, y: 524 }], C.paper, 0.95);
    gStroke(g, [{ x: W / 2 - 330, y: 92 }, { x: W / 2 + 332, y: 88 }, { x: W / 2 + 328, y: 528 }, { x: W / 2 - 334, y: 524 }, { x: W / 2 - 330, y: 92 }], C.ink, 0.85, { width: 3.5, taperStart: 0.02, taperEnd: 0.04, jitter: 0.3 }, r);
    gStroke(g, [{ x: W / 2 - 280, y: 236 }, { x: W / 2 - 20, y: 237 }], C.ink, 0.6, { width: 2.4, taperStart: 0.05, taperEnd: 0.4 }, r);

    const secs = Math.floor(st.time / TICK_RATE);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    this.subtitle.setText(`Étape 1 · la forêt de bambous · 周 ${st.loop + 1}`);
    const rows: [string, string | number][] = [
      ['Temps', time],
      ['Ennemis tranchés', st.kills],
      ['Combo maximal', st.bestCombo],
      ['Parades réussies', st.parries],
      ['Morts', st.deaths],
      ['Honneur gagné', st.honor],
    ];
    rows.forEach(([label, value], i) => {
      this.labels[i].setText(label);
      this.values[i].setText(String(value));
    });
    const gr = GRADES[st.grade];
    this.stampKanji.setText(gr.kanji);
    this.gradeName.setText(`${gr.name}\n+${st.bonus} honneur`).setAlpha(0);
    const sg = this.stampG;
    sg.clear();
    gFill(sg, [{ x: -62, y: -64 }, { x: 64, y: -60 }, { x: 60, y: 64 }, { x: -64, y: 60 }], C.red, 0.92);
    gStroke(sg, [{ x: -54, y: -54 }, { x: 55, y: -51 }, { x: 52, y: 54 }, { x: -55, y: 51 }, { x: -54, y: -54 }], C.paper, 0.5, { width: 3, taperStart: 0, taperEnd: 0, jitter: 0.4 }, r);
    this.footer.setText(`Espace — reprendre la route  ·  周 ${st.loop + 2} : l’ennemi sera plus redoutable`).setAlpha(0);

    this.visible = true;
    this.root.setVisible(true).setAlpha(0).setY(20);
    this.stamp.setScale(3).setAlpha(0).setAngle(-18);
    this.scene.tweens.add({ targets: this.root, alpha: 1, y: 0, duration: 500, ease: 'Sine.easeOut' });
    this.scene.tweens.add({
      targets: this.stamp, scale: 1, alpha: 1, angle: -6, delay: 900, duration: 220, ease: 'Quad.easeIn',
      onComplete: () => this.onStamp(),
    });
    this.scene.tweens.add({ targets: [this.gradeName], alpha: 1, delay: 1150, duration: 400 });
    this.scene.tweens.add({ targets: this.footer, alpha: { from: 0.35, to: 1 }, delay: 1600, duration: 800, yoyo: true, repeat: -1 });
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.scene.tweens.killTweensOf([this.root, this.stamp, this.gradeName, this.footer]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 300, onComplete: () => this.root.setVisible(false) });
  }
}
