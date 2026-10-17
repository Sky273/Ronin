import Phaser from 'phaser';
import { honorForLevel, PLAYER as P } from '../../shared/constants';
import { DIFFICULTIES } from '../../shared/difficulty';
import type { Player, World } from '../../shared/types';
import { calmLength } from '../../shared/world';
import { UPGRADE_MAX } from '../../shared/upgrades';
import { gBlob, gFill, gStroke, type Rand, ringPoints, seeded } from '../render/brush';
import { BOSS_NAME } from '../render/enemies';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';
import { dojoHudLine } from './bracketView';
import { netLabel, netQualityColor, type NetInfo } from './netQuality';
import { DIFFICULTY_TEXT, fmtScore } from './difficultyText';
import { rankOf, UPGRADE_TEXT } from './texts';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;
type Text = Phaser.GameObjects.Text;

const HELP = [
  '← → / A D (Q D on AZERTY)   move          Space   jump (double jump, wall jump)',
  '↓ / S   crouch · ↓ while running: slide · ↓ + Space: drop through',
  'J / click   katana (combo ×3) · ↑+J   rising cut · ↓+J in the air   plunge',
  'Shift   dash · K / right click   parry · L (hold)   iai, draw-and-strike',
  '1 2 3   choose an upgrade · H   help · M   sound · N   music · F1   hitboxes',
  'Esc or hold Select (gamepad)   quit to the title · online: leave the room',
  'G   challenge / accept a duel (online) · hold G to forfeit',
];

/** Aide du dojo : ni route ni améliorations, les duels du tournoi et le tableau. */
const HELP_DOJO = [
  '← → / A D (Q D on AZERTY)   move          Space   jump',
  'L (hold)   kamae · release at 斬 · K   parry · releasing early = foul',
  'G   ready (while waiting) · hold G to forfeit a match',
  'Tab   bracket · Esc or hold Select (gamepad)   leave the dojo',
  'H   help · M   sound · N   music · F1   hitboxes',
];
const HELP_TEXT = HELP.join('\n');
const HELP_DOJO_TEXT = HELP_DOJO.join('\n');

// Cartes d'amélioration : rangée centrée en bas de l'écran ; pendant le bilan coop, dont le panneau
// descend jusqu'en bas (x de W/2 - 334 à W/2 + 332, voir results.ts), colonne dans la marge de gauche.
const CARD_STEP = 190;
const CARD_ROW_DY = 120; // centre de la rangée, depuis le bas de l'écran
const CARD_COL_X = 153; // milieu de la marge de gauche du bilan (0 à 306 px)
const CARD_COL_Y0 = 246; // sous le rang, la vie et l'Honneur
const CARD_COL_STEP = 150;

/** Une carte, dessinée autour de l'origine de son conteneur. */
interface Card {
  root: Phaser.GameObjects.Container;
  g: Phaser.GameObjects.Graphics;
  kanji: Text;
  name: Text;
  desc: Text;
  lvl: Text;
  key: Text;
}

interface Banner {
  kanji: string;
  title: string;
  sub: string;
  color: string;
  hold: number;
  /** Encore d'actualité au moment de l'afficher ? */
  still?: () => boolean;
  rank?: boolean;
}

/** setColor redessine le texte (et sa texture) à chaque appel : seulement si la couleur change. */
function recolor(t: Text, color: string): void {
  if (t.style.color !== color) t.setColor(color);
}

export class Hud {
  private g: Phaser.GameObjects.Graphics;
  private rank: Text;
  private rankName: Text;
  private honor: Text;
  private kills: Text;
  private killMark: Text;
  private record: Text;
  private score: Text;
  private net: Text;
  private netLabel = '';
  private netColor = '';
  private combo: Text;
  private wave: Text;
  private bossName: Text;
  private help: Text;
  private bannerKanji: Text;
  private bannerTitle: Text;
  private bannerSub: Text;
  private lostMark: Text;
  private cards: Card[] = [];
  private cardRoot: Phaser.GameObjects.Container;
  private cardColumn = false;
  private offerKey = '';
  private cardsIn = 0;
  private helpOn = true;
  /** Fin de la tenue de la bannière en cours (scene.time.now) ; celles en attente passent ensuite. */
  private bannerUntil = 0;
  private queue: Banner[] = [];
  private lastCombo = 0;
  private comboPop = 0;
  private shownHp = P.MAX_HP;
  private shownBoss = 1;
  private lastRank = '浪人';

  constructor(private scene: Phaser.Scene, put: Put) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const txt = (x: number, y: number, s: string, style: Phaser.Types.GameObjects.Text.TextStyle) => put(scene.add.text(x, y, s, style).setDepth(101), 'ui');
    this.g = put(scene.add.graphics().setDepth(100), 'ui');
    this.rank = txt(34, 20, '浪人', { fontFamily: FONT_BRUSH, fontSize: '34px', color: '#15120e' });
    this.rankName = txt(36, 64, '', { fontFamily: FONT_TEXT, fontSize: '14px', color: '#4a433b' });
    this.honor = txt(150, 70, '', { fontFamily: FONT_BRUSH, fontSize: '22px', color: '#15120e' });
    this.killMark = txt(W - 40, 26, '討', { fontFamily: FONT_BRUSH, fontSize: '40px', color: '#b8321f' }).setOrigin(1, 0);
    this.kills = txt(W - 92, 22, '0', { fontFamily: FONT_BRUSH, fontSize: '48px', color: '#15120e' }).setOrigin(1, 0);
    this.record = txt(W - 40, 84, '', { fontFamily: FONT_TEXT, fontSize: '15px', color: '#4a433b' }).setOrigin(1, 0);
    this.score = txt(W - 40, 106, '', { fontFamily: FONT_BRUSH, fontSize: '20px', color: '#15120e' }).setOrigin(1, 0);
    this.net = txt(W - 40, 134, '', { fontFamily: FONT_TEXT, fontSize: '14px', color: '#4a433b' }).setOrigin(1, 0).setVisible(false);
    this.combo = txt(W - 60, 250, '', { fontFamily: FONT_BRUSH, fontSize: '56px', color: '#15120e', align: 'right' }).setOrigin(1, 0.5);
    this.wave = txt(W / 2, 22, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#15120e' }).setOrigin(0.5, 0);
    this.bossName = txt(W / 2, 50, '', { fontFamily: FONT_BRUSH, fontSize: '24px', color: '#8e2416' }).setOrigin(0.5, 0);
    this.help = txt(30, H - 24, HELP_TEXT, { fontFamily: FONT_TEXT, fontSize: '14px', color: '#3a342d', lineSpacing: 4 }).setOrigin(0, 1).setAlpha(0.85);
    // Bannières dans le tiers haut : l'action reste lisible en dessous.
    this.bannerKanji = txt(W / 2, 175, '', { fontFamily: FONT_BRUSH, fontSize: '100px', color: '#15120e' }).setOrigin(0.5).setAlpha(0).setDepth(140);
    this.bannerTitle = txt(W / 2, 248, '', { fontFamily: FONT_TEXT, fontSize: '26px', color: '#15120e' }).setOrigin(0.5).setAlpha(0).setDepth(140);
    this.bannerSub = txt(W / 2, 280, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#4a433b' }).setOrigin(0.5).setAlpha(0).setDepth(140);
    this.lostMark = txt(0, 0, '誉', { fontFamily: FONT_BRUSH, fontSize: '30px', color: '#b8321f' }).setOrigin(0.5).setVisible(false);

    this.cardRoot = put(scene.add.container(0, 0).setDepth(120), 'ui');
    for (let i = 0; i < 3; i++) {
      const g = scene.add.graphics();
      const kanji = scene.add.text(0, -38, '', { fontFamily: FONT_BRUSH, fontSize: '44px', color: '#15120e' }).setOrigin(0.5);
      const name = scene.add.text(0, 4, '', { fontFamily: FONT_TEXT, fontSize: '16px', color: '#15120e' }).setOrigin(0.5);
      const desc = scene.add.text(0, 34, '', { fontFamily: FONT_TEXT, fontSize: '12px', color: '#3a342d', align: 'center' }).setOrigin(0.5);
      const lvl = scene.add.text(64, -62, '', { fontFamily: FONT_TEXT, fontSize: '11px', color: '#4a433b' }).setOrigin(1, 0);
      const key = scene.add.text(-66, -66, String(i + 1), { fontFamily: FONT_BRUSH, fontSize: '22px', color: '#b8321f' });
      const root = scene.add.container(0, 0, [g, kanji, name, desc, lvl, key]);
      this.cardRoot.add(root);
      this.cards.push({ root, g, kanji, name, desc, lvl, key });
    }
    this.placeCards();
    this.cardRoot.setVisible(false);
  }

  /** Cartes en rangée en bas de l'écran, ou en colonne à gauche du panneau du bilan coop. */
  private placeCards(): void {
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.cards.forEach((c, i) => {
      if (this.cardColumn) c.root.setPosition(CARD_COL_X, CARD_COL_Y0 + i * CARD_COL_STEP);
      else c.root.setPosition(W / 2 + (i - 1) * CARD_STEP, H - CARD_ROW_DY);
    });
  }

  /** Connexion en ligne (null hors ligne) : nombre de joueurs et latence, colorée selon la qualité. */
  setNet(n: NetInfo | null): void {
    if (!n) {
      if (this.net.visible) this.net.setVisible(false);
      return;
    }
    // Redessin du texte (et de sa texture) seulement quand il change.
    const label = netLabel(n);
    const color = netQualityColor(n);
    if (label !== this.netLabel) this.net.setText((this.netLabel = label));
    if (color !== this.netColor) this.net.setColor((this.netColor = color));
    if (!this.net.visible) this.net.setVisible(true);
  }

  /** Nouvelle partie : oublie l'état affiché de la précédente. */
  reset(): void {
    this.clearBanner();
    this.queue = [];
    this.offerKey = '';
    this.cardsIn = 0;
    this.lastCombo = 0;
    this.comboPop = 0;
    this.shownHp = P.MAX_HP;
    this.shownBoss = 1;
    this.lastRank = '浪人';
    this.cardRoot.setVisible(false);
  }

  /** Aide affichée ou non (H) ; elle reste effacée tant que des cartes d'amélioration sont proposées. */
  toggleHelp(): void {
    this.helpOn = !this.helpOn;
    this.help.setVisible(this.helpOn && !this.cardRoot.visible);
  }

  /** Grande bannière calligraphiée au centre de l'écran. */
  banner(kanji: string, title: string, sub = '', color = '#15120e', hold = 1600): void {
    const els = [this.bannerKanji, this.bannerTitle, this.bannerSub];
    this.scene.tweens.killTweensOf(els);
    this.bannerKanji.setText(kanji).setColor(color).setScale(1.4);
    this.bannerTitle.setText(title);
    this.bannerSub.setText(sub);
    for (const e of els) e.setAlpha(0);
    this.scene.tweens.add({ targets: els, alpha: 1, duration: 220, ease: 'Sine.easeOut' });
    this.scene.tweens.add({ targets: this.bannerKanji, scale: 1, duration: 300, ease: 'Back.easeOut' });
    this.scene.tweens.add({ targets: els, alpha: 0, delay: hold, duration: 700, ease: 'Sine.easeIn' });
    this.bannerUntil = this.scene.time.now + hold;
  }

  /**
   * Bannière montrée une fois la bannière en cours tenue jusqu'au bout (et jamais sur le bilan),
   * si `still()` est encore vrai à ce moment.
   */
  queueBanner(kanji: string, title: string, sub: string, color: string, hold: number, still?: () => boolean): void {
    this.queue.push({ kanji, title, sub, color, hold, still });
  }

  /** Efface la bannière en cours (ouverture du bilan) ; celles en attente le restent. */
  clearBanner(): void {
    const els = [this.bannerKanji, this.bannerTitle, this.bannerSub];
    this.scene.tweens.killTweensOf(els);
    for (const e of els) e.setAlpha(0);
    this.bannerUntil = 0;
  }

  /** Bannières en attente : la suivante encore d'actualité, quand l'écran est libre. */
  private flushBanners(free: boolean): void {
    while (free && this.queue.length > 0 && this.scene.time.now >= this.bannerUntil) {
      const b = this.queue.shift()!;
      if (!b.still || b.still()) this.banner(b.kanji, b.title, b.sub, b.color, b.hold);
    }
  }

  /** `play` : écran de jeu (hors menus et 討死 de fin de partie : ni cartes ni annonce de rang). */
  update(p: Player, w: World, best: number, dt: number, time: number, cam: Phaser.Cameras.Scene2D.Camera, play: boolean): void {
    const g = this.g;
    g.clear();
    const r = seeded(Math.floor(time / 120));
    const W = this.scene.scale.width;
    // Dojo : ni vies, ni Honneur, ni score, ni Marée, ni étape ; une ligne de tournoi à la place.
    const dojo = w.mode === 'dojo';
    const helpText = dojo ? HELP_DOJO_TEXT : HELP_TEXT;
    if (this.help.text !== helpText) this.help.setText(helpText);
    for (const t of [this.honor, this.kills, this.killMark, this.record, this.score]) if (t.visible === dojo) t.setVisible(!dojo);

    // Rang : annoncé sans couper une autre bannière, ni passer par-dessus le bilan d'étape.
    const rk = rankOf(p.level);
    if (rk.kanji !== this.lastRank) {
      this.queue = this.queue.filter((b) => !b.rank);
      if (play && rk.level > 0 && p.level > 0) this.queue.push({ kanji: rk.kanji, title: `Rank attained: ${rk.name}`, sub: '', color: '#b8321f', hold: 1300, rank: true });
      this.lastRank = rk.kanji;
    }
    this.flushBanners(play && w.stage.state !== 'cleared');
    this.rank.setText(rk.kanji);
    this.rankName.setText(`${rk.name} · level ${p.level}`);

    // Vie : trait vermillon sur un trait de lavis (s'allonge avec la Vitalité)
    this.shownHp += (p.hp - this.shownHp) * Math.min(1, dt * 6);
    const x0 = 34 + this.rank.width + 18;
    const y0 = 44;
    const len = 240 * Math.min(1.6, p.maxHp / P.MAX_HP);
    gStroke(g, [{ x: x0, y: y0 }, { x: x0 + len, y: y0 + 1 }], C.wash, 0.25, { width: 12, taperStart: 0.03, taperEnd: 0.1 }, r);
    const k = Math.max(0, this.shownHp / p.maxHp);
    if (k > 0.01) gStroke(g, [{ x: x0, y: y0 }, { x: x0 + len * k, y: y0 + 1 }], C.red, 0.92, { width: 10, taperStart: 0.03, taperEnd: 0.12, jitter: 0.1 }, r);
    gStroke(g, [{ x: x0 - 4, y: y0 + 9 }, { x: x0 + len + 6, y: y0 + 10 }], C.ink, 0.7, { width: 2, taperStart: 0.05, taperEnd: 0.3 }, r);

    // Honneur et progression vers le niveau suivant
    const lo = honorForLevel(p.level);
    const hi = honorForLevel(p.level + 1);
    const prog = Math.max(0, Math.min(1, (p.honor - lo) / (hi - lo)));
    this.honor.setText(`誉 ${p.honor}`).setPosition(x0, 62);
    this.rankName.setPosition(x0 + 16, 92);
    const bx = x0 + this.honor.width + 14;
    if (!dojo) {
      gStroke(g, [{ x: bx, y: 76 }, { x: bx + 140, y: 76 }], C.wash, 0.25, { width: 5, taperStart: 0.05, taperEnd: 0.1 }, r);
      if (prog > 0.01) gStroke(g, [{ x: bx, y: 76 }, { x: bx + 140 * prog, y: 76 }], C.ink, 0.85, { width: 4, taperStart: 0.05, taperEnd: 0.2 }, r);
    }

    // Dash et charge d'iai
    gBlob(g, x0 + 5, 101, 5, p.dashCd <= 0 ? C.ink : C.washLight, p.dashCd <= 0 ? 0.85 : 0.4, r);
    // Vies restantes : une goutte d'encre pleine par vie, vide pour les vies perdues.
    // En ligne (coop, dojo), pas de vies : on renaît sans fin.
    const maxLives = w.mode !== 'solo' ? 0 : Math.max(p.lives, DIFFICULTIES[w.difficulty].lives);
    for (let i = 0; i < maxLives; i++) {
      const lx = x0 + 6 + i * 15;
      if (i < p.lives) gBlob(g, lx, 124, 5, C.red, 0.85, r, 0.25);
      else gStroke(g, ringPoints(lx, 124, 4.5, 0, Math.PI * 2, 10), C.ink, 0.45, { width: 1.4, taperStart: 0, taperEnd: 0 }, r);
    }
    if (p.state === 'iaiCharge') {
      const c = Math.min(1, p.iaiCharge / P.IAI_FULL_CHARGE);
      gStroke(g, [{ x: x0, y: 144 }, { x: x0 + 140 * c, y: 144 }], c >= 1 ? C.red : C.ink, 0.85, { width: 5, taperStart: 0.05, taperEnd: 0.3 }, r);
    }

    this.kills.setText(String(p.kills));
    this.record.setText(best > 0 ? `best ${best} · best combo ${p.bestCombo}` : '');
    this.score.setText(`${fmtScore(p.score)} · ${DIFFICULTY_TEXT[w.difficulty].name}`);

    // Combo
    if (p.combo > this.lastCombo) this.comboPop = 1;
    this.lastCombo = p.combo;
    this.comboPop = Math.max(0, this.comboPop - dt * 5);
    if (p.combo >= 2) {
      this.combo.setText(`${p.combo}\n連撃`);
      this.combo.setAlpha(Math.min(1, p.comboTimer / 30));
      this.combo.setScale(1 + this.comboPop * 0.35);
      recolor(this.combo, p.combo >= 10 ? '#b8321f' : '#15120e');
    } else this.combo.setText('');

    this.updateWave(w, g, r);
    this.updateCards(p, w, play, dt, time);
    if (dojo) {
      if (this.lostMark.visible) this.lostMark.setVisible(false);
    } else this.updateLostMarker(p, cam, W, time);
  }

  private updateWave(w: World, g: Phaser.GameObjects.Graphics, r: Rand): void {
    const wv = w.wave;
    const st = w.stage;
    const W = this.scene.scale.width;
    if (w.tournament) {
      recolor(this.wave.setText(dojoHudLine(w.tournament, w.tick)), w.tournament.phase === 'done' ? '#b8321f' : '#15120e');
      this.bossName.setText('');
      return;
    }
    const boss = w.enemies.find((e) => e.type === 'boss');
    const stagePrefix = `Stage ${st.loop + 1}  ·  `;
    if (st.state === 'arena') recolor(this.wave.setText(`${stagePrefix}門  the guardian bars the way`), '#8e2416');
    else if (st.state === 'gateOpen') recolor(this.wave.setText(`${stagePrefix}門  the gate is open — press on →`), '#b8321f');
    else if (st.state === 'cleared') this.wave.setText('');
    else if (wv.phase === 'tide') recolor(this.wave.setText(`${stagePrefix}潮  Tide ${wv.n}   ${Math.min(wv.kills, wv.quota)} / ${wv.quota}`), '#8e2416');
    else if (wv.phase === 'calm') {
      const left = Math.max(0, (calmLength(w) - wv.t) / 60);
      recolor(this.wave.setText(`${stagePrefix}凪  calm — the Tide comes in ${Math.ceil(left)} s`), '#4a433b');
    } else recolor(this.wave.setText(`${stagePrefix}潮  the Tide is rising…`), '#8e2416');

    if (boss) {
      this.shownBoss += (boss.hp / boss.maxHp - this.shownBoss) * 0.15;
      this.bossName.setText(BOSS_NAME + (boss.phase2 ? '  —  怒' : ''));
      const len = 460;
      const x = W / 2 - len / 2;
      gStroke(g, [{ x, y: 92 }, { x: x + len, y: 92 }], C.wash, 0.3, { width: 14, taperStart: 0.02, taperEnd: 0.02 }, r);
      if (this.shownBoss > 0.005) gStroke(g, [{ x, y: 92 }, { x: x + len * this.shownBoss, y: 92 }], C.redDeep, 0.95, { width: 12, taperStart: 0.02, taperEnd: 0.06, jitter: 0.1 }, r);
      gStroke(g, [{ x: x - 6, y: 101 }, { x: x + len + 6, y: 102 }], C.ink, 0.7, { width: 2, taperStart: 0.05, taperEnd: 0.2 }, r);
    } else {
      this.bossName.setText('');
      this.shownBoss = 1;
    }
  }

  private updateCards(p: Player, w: World, play: boolean, dt: number, time: number): void {
    const key = p.offer.join(',');
    if (key !== this.offerKey) {
      this.offerKey = key;
      this.cardsIn = 0;
      p.offer.forEach((id, i) => {
        const t = UPGRADE_TEXT[id];
        const c = this.cards[i];
        c.kanji.setText(t.kanji);
        c.name.setText(t.name);
        c.desc.setText(t.desc);
        c.lvl.setText(`${p.up[id]} / ${UPGRADE_MAX[id]}`);
      });
      for (let i = 0; i < 3; i++) this.cards[i].root.setVisible(i < p.offer.length);
    }
    // Choix possible seulement en jeu et vivant (1 2 3 sont ignorés pendant 討死, et hors partie).
    const show = play && p.offer.length > 0 && p.state !== 'dead' && !p.out;
    this.cardRoot.setVisible(show);
    // L'aide, en bas à gauche, s'efface pendant le choix : les cartes portent leurs touches 1 2 3.
    const help = this.helpOn && !show;
    if (this.help.visible !== help) this.help.setVisible(help);
    if (!show) {
      this.cardsIn = 0;
      return;
    }
    // Bilan coop : son pied de page et le tableau de la salle passeraient sous la rangée.
    const column = w.mode === 'coop' && w.stage.state === 'cleared';
    if (column !== this.cardColumn) {
      this.cardColumn = column;
      this.placeCards();
      this.cardsIn = 0;
    }
    this.cardsIn = Math.min(1, this.cardsIn + dt * 4);
    const e = 1 - Math.pow(1 - this.cardsIn, 3);
    this.cardRoot.setY((1 - e) * 140).setAlpha(e);
    const r = seeded(Math.floor(time / 140));
    const quad = [{ x: -80, y: -74 }, { x: 80, y: -76 }, { x: 82, y: 62 }, { x: -81, y: 64 }];
    for (let i = 0; i < p.offer.length; i++) {
      const g = this.cards[i].g;
      g.clear();
      gFill(g, quad, C.paper, 0.94);
      gStroke(g, [...quad, quad[0]], C.ink, 0.85, { width: 2.6, taperStart: 0.02, taperEnd: 0.05, jitter: 0.25 }, r);
      gBlob(g, -58, -54, 13, C.red, 0.12, r, 0.2);
    }
  }

  private updateLostMarker(p: Player, cam: Phaser.Cameras.Scene2D.Camera, W: number, time: number): void {
    if (Number.isNaN(p.lostX) || p.state === 'dead') {
      this.lostMark.setVisible(false);
      return;
    }
    const v = cam.worldView;
    if (p.lostX > v.x && p.lostX < v.x + v.width) {
      this.lostMark.setVisible(false);
      return;
    }
    const left = p.lostX < v.x;
    const dist = Math.round(Math.abs(p.lostX - p.x) / 32);
    this.lostMark
      .setVisible(true)
      .setText(left ? `◀ 誉 ${dist}` : `誉 ${dist} ▶`)
      .setFontSize(22)
      .setPosition(left ? 70 : W - 70, 300 + Math.sin(time * 0.004) * 4);
  }
}
