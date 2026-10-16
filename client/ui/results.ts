import Phaser from 'phaser';
import { biomeForStage, type BiomeId } from '../../shared/biomes';
import { COOP_CLEARED_TICKS, TICK_RATE } from '../../shared/constants';
import type { Player, StageState } from '../../shared/types';
import { fmtScore, livesLabel } from './difficultyText';
import { gBlob, gFill, gStroke, seeded } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT, playerColor } from '../render/palette';
import { ROSTER_MAX, type RosterRow, type readyInfo } from './roster';
import { stageTitle } from './texts';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

const GRADES = [
  { kanji: '優', name: 'Excellent' },
  { kanji: '良', name: 'Honorable' },
  { kanji: '可', name: 'Passable' },
];

type ReadyInfo = ReturnType<typeof readyInfo>;

// Bilan coop : tout le panneau remonte de COOP_DY pour loger le tableau de la salle.
const COOP_DY = -36;
const COOP_BOTTOM = 718; // bas du panneau en coop (528 en solo), avant décalage
const TABLE_HEAD_Y = 466;
const TABLE_Y0 = 484;
const TABLE_STEP = 17.5;
const NAME_MAX = 12;
// Colonnes du tableau, relatives au centre de l'écran.
const COL_CHIP = -270;
const COL_NAME = -256;
const COL_KILLS = 10;
const COL_DEATHS = 80;
const COL_PARRIES = 150;
const COL_GRADE = 218;
const COL_READY = 270;

/** Objets texte d'une ligne du tableau de la salle. */
interface TableRow {
  name: Phaser.GameObjects.Text;
  kills: Phaser.GameObjects.Text;
  deaths: Phaser.GameObjects.Text;
  parries: Phaser.GameObjects.Text;
  grade: Phaser.GameObjects.Text;
  ready: Phaser.GameObjects.Text;
  sig: string; // contenu affiché (hors ✓), pour ne rien redessiner sans changement
  readySig: string;
}

/** Nom tronqué à NAME_MAX caractères (points de code, pas unités UTF-16). */
function shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join('') : name;
}

/** Pied de page du vote coop. */
function readyFooter(meReady: boolean, info: ReadyInfo): string {
  const head = meReady ? 'Ready ✓' : 'Space — ready';
  return `${head} · ${info.ready}/${info.present} ready (${info.needed} needed) · next stage in ${info.secondsLeft}`;
}

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
  // Coop : note de la salle et tableau des joueurs (masqués en solo).
  private coop: Phaser.GameObjects.Container;
  private roomGradeText: Phaser.GameObjects.Text;
  private tableG: Phaser.GameObjects.Graphics;
  private table: TableRow[] = [];
  private tableSeed = 0;
  private coopShown = false;
  private footerSig = '';
  visible = false;

  constructor(private scene: Phaser.Scene, put: Put, private onStamp: () => void) {
    const W = scene.scale.width;
    const cx = W / 2;
    this.panel = scene.add.graphics();
    const title = scene.add.text(cx - 150, 150, '結果', { fontFamily: FONT_BRUSH, fontSize: '84px', color: '#15120e' }).setOrigin(0.5);
    this.subtitle = scene.add.text(cx - 150, 212, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#4a433b' }).setOrigin(0.5);
    // Une ligne de texte par statistique : libellé et valeur restent alignés.
    for (let i = 0; i < 7; i++) {
      const y = 258 + i * 31;
      this.labels.push(scene.add.text(cx - 270, y, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: '#3a342d' }).setOrigin(0, 0.5));
      this.values.push(scene.add.text(cx - 30, y, '', { fontFamily: FONT_BRUSH, fontSize: '23px', color: '#15120e' }).setOrigin(1, 0.5));
    }
    this.stampG = scene.add.graphics();
    this.stampKanji = scene.add.text(0, 0, '', { fontFamily: FONT_BRUSH, fontSize: '96px', color: '#f0e7d3' }).setOrigin(0.5);
    this.stamp = scene.add.container(cx + 170, 260, [this.stampG, this.stampKanji]);
    this.gradeName = scene.add.text(cx + 170, 360, '', { fontFamily: FONT_TEXT, fontSize: '20px', color: '#8e2416', align: 'center' }).setOrigin(0.5, 0);
    this.footer = scene.add.text(cx, 492, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: '#b8321f', align: 'center' }).setOrigin(0.5);

    // Coop : note de la salle sous le tampon, puis tableau compact sous les statistiques.
    this.roomGradeText = scene.add.text(cx + 170, 426, '', { fontFamily: FONT_TEXT, fontSize: '16px', color: '#6b6359' }).setOrigin(0.5);
    this.tableG = scene.add.graphics();
    const head = (x: number, label: string): Phaser.GameObjects.Text =>
      scene.add.text(cx + x, TABLE_HEAD_Y, label, { fontFamily: FONT_BRUSH, fontSize: '17px', color: '#6b6359' }).setOrigin(0.5);
    const headers = [
      scene.add.text(cx + COL_NAME, TABLE_HEAD_Y, 'Room', { fontFamily: FONT_TEXT, fontSize: '14px', color: '#6b6359' }).setOrigin(0, 0.5),
      head(COL_KILLS, '斬'),
      head(COL_DEATHS, '死'),
      head(COL_PARRIES, '弾'),
      head(COL_GRADE, '評'),
      head(COL_READY, '備'),
    ];
    const cell = (x: number, y: number, font: string, size: number, ox = 0.5): Phaser.GameObjects.Text =>
      scene.add.text(cx + x, y, '', { fontFamily: font, fontSize: `${size}px`, color: '#15120e' }).setOrigin(ox, 0.5);
    const cells: Phaser.GameObjects.Text[] = [];
    for (let i = 0; i < ROSTER_MAX; i++) {
      const y = TABLE_Y0 + i * TABLE_STEP;
      const row: TableRow = {
        name: cell(COL_NAME, y, FONT_TEXT, 15, 0),
        kills: cell(COL_KILLS, y, FONT_TEXT, 15),
        deaths: cell(COL_DEATHS, y, FONT_TEXT, 15),
        parries: cell(COL_PARRIES, y, FONT_TEXT, 15),
        grade: cell(COL_GRADE, y, FONT_BRUSH, 16),
        ready: cell(COL_READY, y, FONT_TEXT, 16),
        sig: '',
        readySig: '',
      };
      row.ready.setColor('#b8321f');
      this.table.push(row);
      cells.push(row.name, row.kills, row.deaths, row.parries, row.grade, row.ready);
    }
    this.coop = scene.add.container(0, 0, [this.roomGradeText, this.tableG, ...headers, ...cells]).setVisible(false);

    this.root = put(
      scene.add.container(0, 0, [this.panel, title, this.subtitle, ...this.labels, ...this.values, this.stamp, this.gradeName, this.footer, this.coop]).setDepth(115).setVisible(false),
      'ui',
    );
  }

  /**
   * `level` : étape terminée et son biome (par défaut, déduits de la boucle).
   * `room` (coop) : tableau de la salle ; absent, la mise en page solo est inchangée.
   */
  show(st: StageState, p: Player, level?: { stage: number; biome: BiomeId }, room?: RosterRow[]): void {
    const stage = level?.stage ?? st.loop;
    const biome = level?.biome ?? biomeForStage(stage);
    const W = this.scene.scale.width;
    const r = seeded(st.loop * 31 + 7);
    const g = this.panel;
    // Coop : panneau prolongé vers le bas pour le tableau (le solo garde 528).
    const bottom = room ? COOP_BOTTOM : 528;
    g.clear();
    gFill(g, [{ x: W / 2 - 330, y: 92 }, { x: W / 2 + 332, y: 88 }, { x: W / 2 + 328, y: bottom }, { x: W / 2 - 334, y: bottom - 4 }], C.paper, 0.95);
    gStroke(g, [{ x: W / 2 - 330, y: 92 }, { x: W / 2 + 332, y: 88 }, { x: W / 2 + 328, y: bottom }, { x: W / 2 - 334, y: bottom - 4 }, { x: W / 2 - 330, y: 92 }], C.ink, 0.85, { width: 3.5, taperStart: 0.02, taperEnd: 0.04, jitter: 0.3 }, r);
    gStroke(g, [{ x: W / 2 - 280, y: 236 }, { x: W / 2 - 20, y: 237 }], C.ink, 0.6, { width: 2.4, taperStart: 0.05, taperEnd: 0.4 }, r);
    if (room) gStroke(g, [{ x: W / 2 - 284, y: TABLE_HEAD_Y + 10 }, { x: W / 2 + 290, y: TABLE_HEAD_Y + 11 }], C.ink, 0.45, { width: 1.8, taperStart: 0.04, taperEnd: 0.3 }, r);

    const secs = Math.floor(st.time / TICK_RATE);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    this.subtitle.setText(stageTitle(stage, biome));
    // Coop : statistiques personnelles (byPlayer) ; solo : celles de l'étape.
    const mine = room ? st.byPlayer?.[p.id] : undefined;
    const rows: [string, string | number][] = [
      ['Time', time],
      ['Foes slain', mine?.kills ?? st.kills],
      ['Best combo', mine?.bestCombo ?? st.bestCombo],
      ['Perfect parries', mine?.parries ?? st.parries],
      ['Deaths', mine?.deaths ?? st.deaths],
      ['Lives left', livesLabel(p.lives)],
      ['Score', fmtScore(p.score)],
    ];
    rows.forEach(([label, value], i) => {
      this.labels[i].setText(label);
      this.values[i].setText(String(value));
    });
    // Coop : note personnelle (ligne `me`) ; la note médiane de la salle passe en petit.
    const meRow = room?.find((row) => row.me);
    const gr = GRADES[meRow?.grade ?? st.grade] ?? GRADES[2];
    this.stampKanji.setText(gr.kanji);
    this.gradeName.setText(`${gr.name}\n+${mine?.bonus ?? st.bonus} honor`).setAlpha(0);
    const sg = this.stampG;
    sg.clear();
    gFill(sg, [{ x: -62, y: -64 }, { x: 64, y: -60 }, { x: 60, y: 64 }, { x: -64, y: 60 }], C.red, 0.92);
    gStroke(sg, [{ x: -54, y: -54 }, { x: 55, y: -51 }, { x: 52, y: 54 }, { x: -55, y: 51 }, { x: -54, y: -54 }], C.paper, 0.5, { width: 3, taperStart: 0, taperEnd: 0, jitter: 0.4 }, r);
    if (room) {
      this.coopShown = true;
      this.tableSeed = st.loop * 53 + 11;
      for (const row of this.table) row.sig = row.readySig = '';
      this.footerSig = '';
      this.roomGradeText.setText(`Room grade ${(GRADES[st.grade] ?? GRADES[2]).kanji}`);
      this.coop.setVisible(true);
      this.footer.setY(COOP_BOTTOM - 18).setFontSize(17);
      // Premier pied de page d'après le tableau ; update() prend le relais à chaque image.
      this.update(room, {
        ready: room.filter((row) => row.ready).length,
        needed: Math.floor(room.length / 2) + 1,
        present: room.length,
        secondsLeft: Math.max(0, Math.ceil((COOP_CLEARED_TICKS - st.t) / TICK_RATE)),
      });
      this.footer.setAlpha(0);
    } else {
      this.coopShown = false;
      this.coop.setVisible(false);
      this.footer.setY(492).setFontSize(19);
      this.footer.setText(`Space — continue to ${stageTitle(stage + 1, biomeForStage(stage + 1))}`).setAlpha(0);
    }

    this.visible = true;
    const dy = room ? COOP_DY : 0;
    this.root.setVisible(true).setAlpha(0).setY(dy + 20);
    this.stamp.setScale(3).setAlpha(0).setAngle(-18);
    this.scene.tweens.add({ targets: this.root, alpha: 1, y: dy, duration: 500, ease: 'Sine.easeOut' });
    this.scene.tweens.add({
      targets: this.stamp, scale: 1, alpha: 1, angle: -6, delay: 900, duration: 220, ease: 'Quad.easeIn',
      onComplete: () => this.onStamp(),
    });
    this.scene.tweens.add({ targets: [this.gradeName], alpha: 1, delay: 1150, duration: 400 });
    this.scene.tweens.add({ targets: this.footer, alpha: { from: 0.35, to: 1 }, delay: 1600, duration: 800, yoyo: true, repeat: -1 });
  }

  /**
   * Coop, à chaque image du bilan : lignes du tableau, ✓ des joueurs prêts et pied de page.
   * Ne touche aux objets Phaser que si le contenu affiché change. Sans effet en solo.
   */
  update(room: RosterRow[], info: ReadyInfo): void {
    if (!this.coopShown) return;
    let dirty = false;
    let meReady = false;
    for (let i = 0; i < this.table.length; i++) {
      const t = this.table[i];
      const row = i < room.length ? room[i] : undefined;
      if (row?.me && row.ready) meReady = true;
      const sig = row ? `${row.id}|${row.name}|${row.color}|${row.kills}|${row.deaths}|${row.parries}|${row.grade}|${row.me ? 1 : 0}` : '';
      if (sig !== t.sig) {
        t.sig = sig;
        dirty = true;
        t.name.setText(row ? shortName(row.name) : '').setColor(row?.me ? '#15120e' : '#3a342d');
        t.kills.setText(row ? String(row.kills) : '');
        t.deaths.setText(row ? String(row.deaths) : '');
        t.parries.setText(row ? String(row.parries) : '');
        const gr = row ? (GRADES[row.grade] ?? GRADES[2]) : null;
        t.grade.setText(gr ? gr.kanji : '').setColor(row?.grade === 0 ? '#b8321f' : '#15120e');
      }
      const readySig = row?.ready ? '✓' : '';
      if (readySig !== t.readySig) {
        t.readySig = readySig;
        t.ready.setText(readySig);
      }
    }
    if (dirty) this.drawTable(room);
    const footer = readyFooter(meReady, info);
    if (footer !== this.footerSig) {
      this.footerSig = footer;
      this.footer.setText(footer);
    }
  }

  /** Puces de couleur des joueurs, lavis et trait vermillon sous la ligne du joueur local. */
  private drawTable(room: RosterRow[]): void {
    const cx = this.scene.scale.width / 2;
    const g = this.tableG;
    const r = seeded(this.tableSeed);
    g.clear();
    const n = Math.min(room.length, this.table.length);
    for (let i = 0; i < n; i++) {
      const row = room[i];
      const y = TABLE_Y0 + i * TABLE_STEP;
      if (row.me) {
        const h = TABLE_STEP / 2;
        gFill(g, [{ x: cx - 284, y: y - h + 1 }, { x: cx + 290, y: y - h }, { x: cx + 288, y: y + h }, { x: cx - 286, y: y + h - 1 }], C.washLight, 0.3);
        const nameW = this.table[i].name.width;
        gStroke(g, [{ x: cx + COL_NAME, y: y + 8 }, { x: cx + COL_NAME + nameW, y: y + 8.5 }], C.red, 0.75, { width: 1.8, taperStart: 0.05, taperEnd: 0.5 }, r);
      }
      gBlob(g, cx + COL_CHIP, y, 5.5, playerColor(row.color), 0.95, r);
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.scene.tweens.killTweensOf([this.root, this.stamp, this.gradeName, this.footer]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 300, onComplete: () => this.root.setVisible(false) });
  }
}
