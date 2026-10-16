import Phaser from 'phaser';
import { DIFFICULTY_TEXT, fmtScore } from './difficultyText';
import { DIFFICULTY_ORDER, type DifficultyId } from '../../shared/difficulty';
import { gBlob, gFill, gStroke, seeded, type Pt } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';
import { MAX_SCORES, type ScoreTable } from '../scores/types';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

const INPUT_GUARD_MS = 300;
/** Intervalle du défilement automatique entre onglets (secondes). */
const AUTO_CYCLE_S = 6;

const TAB_Y = 178;
const TAB_STEP = 150;
const ROW_Y0 = 284;
const ROW_STEP = 31;

const INK = '#15120e';
const SOFT = '#3a342d';
const WASH = '#6b6359';
const RED = '#b8321f';

interface Row {
  box: Phaser.GameObjects.Container;
  rank: Phaser.GameObjects.Text;
  name: Phaser.GameObjects.Text;
  score: Phaser.GameObjects.Text;
  loop: Phaser.GameObjects.Text;
  kills: Phaser.GameObjects.Text;
  hanko: Phaser.GameObjects.Container;
}

/** Tableau d'honneur (誉) présenté sur un rouleau makimono, un onglet par difficulté. */
export class Scoreboard {
  private root: Phaser.GameObjects.Container;
  private tabMark: Phaser.GameObjects.Graphics;
  private tabKanji: Phaser.GameObjects.Text[] = [];
  private tabName: Phaser.GameObjects.Text[] = [];
  private rows: Row[] = [];
  private empty: Phaser.GameObjects.Text;
  private header: Phaser.GameObjects.Text[] = [];
  private titleK: Phaser.GameObjects.Text;
  private titleT: Phaser.GameObjects.Text;
  private table: ScoreTable | null = null;
  private focus: DifficultyId = 'normal';
  private highlight = -1;
  private tab = 0;
  private auto = true;
  private autoT = 0;
  private shown = false;
  private readyAt = 0;

  constructor(private scene: Phaser.Scene, put: Put, private cb: { onPlayAgain(): void; onTitle(): void }) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const cx = W / 2;
    const veil = scene.add.rectangle(0, 0, W, H, C.paper, 0.6).setOrigin(0);
    const scroll = scene.add.graphics();
    this.drawScroll(scroll);

    this.titleK = scene.add.text(cx - 110, 112, '誉', { fontFamily: FONT_BRUSH, fontSize: '60px', color: INK }).setOrigin(0.5);
    this.titleT = scene.add.text(cx - 70, 116, 'Hall of Honor', { fontFamily: FONT_TEXT, fontSize: '30px', color: SOFT }).setOrigin(0, 0.5);

    // Onglets : kanji + nom, cliquables ; le soulignement rouge suit l'onglet courant.
    this.tabMark = scene.add.graphics();
    const tabs: Phaser.GameObjects.GameObject[] = [];
    DIFFICULTY_ORDER.forEach((id, i) => {
      const x = cx + (i - 2) * TAB_STEP;
      const k = scene.add.text(x, TAB_Y - 8, DIFFICULTY_TEXT[id].kanji, { fontFamily: FONT_BRUSH, fontSize: '32px', color: WASH }).setOrigin(0.5);
      const n = scene.add.text(x, TAB_Y + 22, DIFFICULTY_TEXT[id].name, { fontFamily: FONT_TEXT, fontSize: '14px', color: WASH }).setOrigin(0.5);
      const z = scene.add.zone(x, TAB_Y + 6, TAB_STEP - 14, 64).setInteractive({ useHandCursor: true });
      z.on('pointerdown', () => {
        if (!this.ready()) return;
        this.auto = false;
        this.setTab(i);
      });
      this.tabKanji.push(k);
      this.tabName.push(n);
      tabs.push(z, k, n);
    });

    const hy = ROW_Y0 - 30;
    const hs = { fontFamily: FONT_TEXT, fontSize: '13px', color: WASH };
    this.header = [
      scene.add.text(cx - 330, hy, 'Rank', hs).setOrigin(0.5),
      scene.add.text(cx - 280, hy, 'Name', hs).setOrigin(0, 0.5),
      scene.add.text(cx + 110, hy, 'Score', hs).setOrigin(1, 0.5),
      scene.add.text(cx + 200, hy, 'Stage', hs).setOrigin(0.5),
      scene.add.text(cx + 310, hy, 'Kills', hs).setOrigin(1, 0.5),
    ];

    for (let i = 0; i < MAX_SCORES; i++) {
      const rank = scene.add.text(-330, 0, String(i + 1), { fontFamily: FONT_BRUSH, fontSize: '22px', color: INK }).setOrigin(0.5);
      const name = scene.add.text(-280, 0, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: INK }).setOrigin(0, 0.5);
      const score = scene.add.text(110, 0, '', { fontFamily: FONT_BRUSH, fontSize: '22px', color: INK }).setOrigin(1, 0.5);
      const loop = scene.add.text(200, 0, '', { fontFamily: FONT_BRUSH, fontSize: '18px', color: SOFT }).setOrigin(0.5);
      const kills = scene.add.text(310, 0, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: SOFT }).setOrigin(1, 0.5);
      // Petit hanko marquant le nom tout juste inscrit.
      const hg = scene.add.graphics();
      const hr = seeded(401 + i);
      gFill(hg, [{ x: -13, y: -13 }, { x: 13, y: -12 }, { x: 12, y: 13 }, { x: -13, y: 12 }], C.red, 0.92);
      gStroke(hg, [{ x: -10, y: -10 }, { x: 10, y: -9 }, { x: 9, y: 10 }, { x: -10, y: 9 }, { x: -10, y: -10 }], C.paper, 0.5, { width: 1.4, taperStart: 0, taperEnd: 0, jitter: 0.4 }, hr);
      const hk = scene.add.text(0, 0, '新', { fontFamily: FONT_BRUSH, fontSize: '18px', color: '#f0e7d3' }).setOrigin(0.5);
      const hanko = scene.add.container(362, 0, [hg, hk]).setAngle(-6).setVisible(false);
      const box = scene.add.container(cx, ROW_Y0 + i * ROW_STEP, [rank, name, score, loop, kills, hanko]);
      this.rows.push({ box, rank, name, score, loop, kills, hanko });
    }
    this.empty = scene.add.text(cx, ROW_Y0 + 4.5 * ROW_STEP, 'No names inscribed yet', { fontFamily: FONT_TEXT, fontSize: '20px', color: WASH }).setOrigin(0.5).setVisible(false);
    // Aide + deux actions cliquables (souris), équivalentes à Entrée et Échap.
    const help = scene.add.text(cx, 622, '←→ browse', { fontFamily: FONT_TEXT, fontSize: '15px', color: WASH }).setOrigin(0.5).setAlpha(0.85);
    const action = (x: number, label: string, fn: () => void) => {
      const t = scene.add.text(x, 622, label, { fontFamily: FONT_TEXT, fontSize: '18px', color: RED }).setOrigin(0.5);
      t.setInteractive({ useHandCursor: true });
      t.on('pointerover', () => t.setColor(INK));
      t.on('pointerout', () => t.setColor(RED));
      t.on('pointerdown', () => {
        if (this.ready()) fn();
      });
      return t;
    };
    const playBtn = action(cx - 230, 'Enter — play', () => this.cb.onPlayAgain());
    const titleBtn = action(cx + 230, 'Esc — title', () => this.cb.onTitle());

    this.root = put(
      scene.add
        .container(0, 0, [veil, scroll, this.titleK, this.titleT, this.tabMark, ...tabs, ...this.header, ...this.rows.map((r) => r.box), this.empty, help, playBtn, titleBtn])
        .setDepth(200)
        .setVisible(false),
      'ui',
    );
  }

  get visible(): boolean {
    return this.shown;
  }

  /** `highlightRank` : rang 0-based du nom à mettre en valeur dans l'onglet `focus`, -1 pour aucun. */
  show(table: ScoreTable, focus: DifficultyId, highlightRank: number): void {
    this.scene.tweens.killTweensOf(this.root);
    this.table = table;
    this.focus = focus;
    this.highlight = highlightRank;
    this.shown = true;
    this.readyAt = this.scene.time.now + INPUT_GUARD_MS;
    this.auto = true;
    // Le titre est recentré ici : la police web est normalement chargée à ce stade.
    const cx = this.scene.scale.width / 2;
    const total = this.titleK.width + 14 + this.titleT.width;
    this.titleK.setX(cx - total / 2 + this.titleK.width / 2);
    this.titleT.setX(cx - total / 2 + this.titleK.width + 14);
    this.root.setVisible(true).setAlpha(0).setY(16);
    this.scene.tweens.add({ targets: this.root, alpha: 1, y: 0, duration: 450, ease: 'Sine.easeOut' });
    const i = DIFFICULTY_ORDER.indexOf(focus);
    this.setTab(i < 0 ? 2 : i);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.scene.tweens.killTweensOf([this.root, this.tabMark, this.empty, ...this.rows.map((r) => r.box)]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 300, onComplete: () => this.root.setVisible(false) });
  }

  key(code: string): void {
    if (!this.ready()) return;
    const n = DIFFICULTY_ORDER.length;
    if (code === 'ArrowLeft' || code === 'KeyA') {
      this.auto = false;
      this.setTab((this.tab + n - 1) % n);
    } else if (code === 'ArrowRight' || code === 'KeyD') {
      this.auto = false;
      this.setTab((this.tab + 1) % n);
    } else if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') this.cb.onPlayAgain();
    else if (code === 'Escape') this.cb.onTitle();
  }

  /** À appeler chaque image (dt en secondes) : défilement automatique des onglets. */
  update(dt: number): void {
    if (!this.shown || !this.auto) return;
    this.autoT += dt;
    if (this.autoT >= AUTO_CYCLE_S) this.setTab((this.tab + 1) % DIFFICULTY_ORDER.length);
  }

  private ready(): boolean {
    return this.shown && this.scene.time.now >= this.readyAt;
  }

  private setTab(i: number): void {
    this.tab = i;
    this.autoT = 0;
    const id = DIFFICULTY_ORDER[i];
    this.tabKanji.forEach((t, k) => t.setColor(k === i ? RED : WASH));
    this.tabName.forEach((t, k) => t.setColor(k === i ? INK : WASH));

    // Soulignement rouge sous l'onglet courant, « tracé » depuis la gauche.
    const cx = this.scene.scale.width / 2;
    const x = cx + (i - 2) * TAB_STEP;
    const g = this.tabMark;
    g.clear();
    gStroke(g, [{ x: 0, y: 1 }, { x: 52, y: -1 }, { x: 104, y: 1 }], C.red, 0.85, { width: 4.5, taperStart: 0.08, taperEnd: 0.5, jitter: 0.25 }, seeded(307 + i * 11), 4);
    g.setPosition(x - 52, TAB_Y + 40);
    this.scene.tweens.killTweensOf(g);
    g.setScale(0.1, 1).setAlpha(0.4);
    this.scene.tweens.add({ targets: g, scaleX: 1, alpha: 1, duration: 200, ease: 'Quad.easeOut' });

    const entries = this.table?.[id] ?? [];
    const hl = id === this.focus ? this.highlight : -1;
    const isEmpty = entries.length === 0;
    this.scene.tweens.killTweensOf(this.empty);
    this.empty.setVisible(isEmpty).setAlpha(0);
    this.header.forEach((h) => h.setVisible(!isEmpty));
    if (isEmpty) this.scene.tweens.add({ targets: this.empty, alpha: 1, duration: 400, delay: 100 });

    this.rows.forEach((row, k) => {
      const e = entries[k];
      const on = k === hl && !!e;
      const col = on ? RED : INK;
      row.rank.setColor(on ? RED : e ? INK : WASH);
      row.name.setText(e ? e.name : '—').setColor(e ? col : WASH);
      row.score.setText(e ? fmtScore(e.score) : '—').setColor(e ? col : WASH);
      row.loop.setText(e ? `${e.loop + 1}` : '—').setColor(on ? RED : e ? SOFT : WASH);
      row.kills.setText(e ? String(e.kills) : '—').setColor(on ? RED : e ? SOFT : WASH);
      row.hanko.setVisible(on);
      // Entrée en défilant : chaque ligne glisse depuis la droite, décalée de la précédente.
      const box = row.box;
      this.scene.tweens.killTweensOf(box);
      box.setVisible(!isEmpty).setX(cx + 46).setAlpha(0);
      if (isEmpty) return;
      this.scene.tweens.add({ targets: box, x: cx, alpha: e ? 1 : 0.55, delay: 60 + k * 55, duration: 280, ease: 'Cubic.easeOut' });
    });
  }

  private drawScroll(g: Phaser.GameObjects.Graphics): void {
    const cx = this.scene.scale.width / 2;
    const r = seeded(613);
    const top = 70;
    const bot = 650;
    // Papier du rouleau, légèrement plus étroit que les baguettes.
    const quad: Pt[] = [{ x: cx - 430, y: top }, { x: cx + 432, y: top + 2 }, { x: cx + 428, y: bot }, { x: cx - 432, y: bot - 2 }];
    gFill(g, quad, C.paper, 0.97);
    gFill(g, [{ x: cx - 430, y: top }, { x: cx + 432, y: top + 2 }, { x: cx + 432, y: top + 16 }, { x: cx - 430, y: top + 14 }], C.paperDark, 0.6);
    gFill(g, [{ x: cx - 432, y: bot - 16 }, { x: cx + 428, y: bot - 14 }, { x: cx + 428, y: bot }, { x: cx - 432, y: bot - 2 }], C.paperDark, 0.6);
    gStroke(g, [{ x: cx - 430, y: top }, { x: cx - 432, y: bot - 2 }], C.ink, 0.7, { width: 2.6, taperStart: 0.05, taperEnd: 0.1, jitter: 0.3 }, r);
    gStroke(g, [{ x: cx + 432, y: top + 2 }, { x: cx + 428, y: bot }], C.ink, 0.7, { width: 2.6, taperStart: 0.05, taperEnd: 0.1, jitter: 0.3 }, r);
    // Baguettes (jiku) en haut et en bas, avec leurs embouts.
    for (const y of [top - 2, bot + 1]) {
      gStroke(g, [{ x: cx - 462, y: y + 1 }, { x: cx, y: y - 1 }, { x: cx + 462, y: y + 1 }], C.ink, 0.92, { width: 15, taperStart: 0.01, taperEnd: 0.01, jitter: 0.12 }, r, 3);
      gBlob(g, cx - 470, y, 11, C.inkSoft, 0.95, r, 0.12);
      gBlob(g, cx + 470, y, 11, C.inkSoft, 0.95, r, 0.12);
    }
    // Petit cordon rouge noué sur la baguette du haut.
    gStroke(g, [{ x: cx + 380, y: top + 4 }, { x: cx + 388, y: top + 30 }, { x: cx + 378, y: top + 52 }], C.red, 0.8, { width: 3, taperStart: 0.1, taperEnd: 0.6, jitter: 0.2 }, r, 3);
    // Filets d'encre : sous les onglets et au-dessus de l'aide.
    gStroke(g, [{ x: cx - 360, y: 232 }, { x: cx + 360, y: 234 }], C.ink, 0.5, { width: 2.2, taperStart: 0.1, taperEnd: 0.4 }, r);
    gStroke(g, [{ x: cx - 220, y: 598 }, { x: cx + 220, y: 597 }], C.ink, 0.28, { width: 1.6, taperStart: 0.3, taperEnd: 0.3 }, r);
  }
}
