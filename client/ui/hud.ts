import Phaser from 'phaser';
import { honorForLevel, PLAYER as P } from '../../shared/constants';
import type { Player, World } from '../../shared/types';
import { calmLength } from '../../shared/world';
import { UPGRADE_MAX } from '../../shared/upgrades';
import { gBlob, gFill, gStroke, type Rand, seeded } from '../render/brush';
import { BOSS_NAME } from '../render/enemies';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';
import { rankOf, UPGRADE_TEXT } from './texts';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;
type Text = Phaser.GameObjects.Text;

const HELP = [
  '←→ / Q D   se déplacer          Espace   sauter (double saut, saut mural)',
  '↓ / S   se baisser · ↓ en courant : glissade · ↓ + Espace : traverser',
  'J / clic   katana (combo ×3) · ↑+J   coupe montante · ↓+J en l’air   plongeon',
  'Maj   dash · K / clic droit   parade · L (maintenir)   iai, dégainer-frapper',
  '1 2 3   choisir une amélioration · H   aide · M   son · N   musique · F1   hitbox',
];

interface Card {
  g: Phaser.GameObjects.Graphics;
  kanji: Text;
  name: Text;
  desc: Text;
  lvl: Text;
  key: Text;
}

export class Hud {
  private g: Phaser.GameObjects.Graphics;
  private rank: Text;
  private rankName: Text;
  private honor: Text;
  private kills: Text;
  private record: Text;
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
  private offerKey = '';
  private cardsIn = 0;
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
    txt(W - 40, 26, '討', { fontFamily: FONT_BRUSH, fontSize: '40px', color: '#b8321f' }).setOrigin(1, 0);
    this.kills = txt(W - 92, 22, '0', { fontFamily: FONT_BRUSH, fontSize: '48px', color: '#15120e' }).setOrigin(1, 0);
    this.record = txt(W - 40, 84, '', { fontFamily: FONT_TEXT, fontSize: '15px', color: '#4a433b' }).setOrigin(1, 0);
    this.combo = txt(W - 60, 250, '', { fontFamily: FONT_BRUSH, fontSize: '56px', color: '#15120e', align: 'right' }).setOrigin(1, 0.5);
    this.wave = txt(W / 2, 22, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#15120e' }).setOrigin(0.5, 0);
    this.bossName = txt(W / 2, 50, '', { fontFamily: FONT_BRUSH, fontSize: '24px', color: '#8e2416' }).setOrigin(0.5, 0);
    this.help = txt(30, H - 24, HELP.join('\n'), { fontFamily: FONT_TEXT, fontSize: '14px', color: '#3a342d', lineSpacing: 4 }).setOrigin(0, 1).setAlpha(0.85);
    // Bannières dans le tiers haut : l'action reste lisible en dessous.
    this.bannerKanji = txt(W / 2, 175, '', { fontFamily: FONT_BRUSH, fontSize: '100px', color: '#15120e' }).setOrigin(0.5).setAlpha(0).setDepth(140);
    this.bannerTitle = txt(W / 2, 248, '', { fontFamily: FONT_TEXT, fontSize: '26px', color: '#15120e' }).setOrigin(0.5).setAlpha(0).setDepth(140);
    this.bannerSub = txt(W / 2, 280, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#4a433b' }).setOrigin(0.5).setAlpha(0).setDepth(140);
    this.lostMark = txt(0, 0, '誉', { fontFamily: FONT_BRUSH, fontSize: '30px', color: '#b8321f' }).setOrigin(0.5).setVisible(false);

    this.cardRoot = put(scene.add.container(0, 0).setDepth(120), 'ui');
    for (let i = 0; i < 3; i++) {
      const cx = W / 2 + (i - 1) * 190;
      const cy = H - 120;
      const g = scene.add.graphics();
      const kanji = scene.add.text(cx, cy - 38, '', { fontFamily: FONT_BRUSH, fontSize: '44px', color: '#15120e' }).setOrigin(0.5);
      const name = scene.add.text(cx, cy + 4, '', { fontFamily: FONT_TEXT, fontSize: '16px', color: '#15120e' }).setOrigin(0.5);
      const desc = scene.add.text(cx, cy + 34, '', { fontFamily: FONT_TEXT, fontSize: '12px', color: '#3a342d', align: 'center' }).setOrigin(0.5);
      const lvl = scene.add.text(cx + 64, cy - 62, '', { fontFamily: FONT_TEXT, fontSize: '11px', color: '#4a433b' }).setOrigin(1, 0);
      const key = scene.add.text(cx - 66, cy - 66, String(i + 1), { fontFamily: FONT_BRUSH, fontSize: '22px', color: '#b8321f' });
      this.cardRoot.add([g, kanji, name, desc, lvl, key]);
      this.cards.push({ g, kanji, name, desc, lvl, key });
    }
    this.cardRoot.setVisible(false);
  }

  toggleHelp(): void {
    this.help.setVisible(!this.help.visible);
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
  }

  update(p: Player, w: World, best: number, dt: number, time: number, cam: Phaser.Cameras.Scene2D.Camera): void {
    const g = this.g;
    g.clear();
    const r = seeded(Math.floor(time / 120));
    const W = this.scene.scale.width;

    // Rang
    const rk = rankOf(p.level);
    if (rk.kanji !== this.lastRank) {
      if (rk.level > 0 && p.level > 0) this.banner(rk.kanji, `Rang atteint : ${rk.name}`, '', '#b8321f', 1300);
      this.lastRank = rk.kanji;
    }
    this.rank.setText(rk.kanji);
    this.rankName.setText(`${rk.name} · niveau ${p.level}`);

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
    gStroke(g, [{ x: bx, y: 76 }, { x: bx + 140, y: 76 }], C.wash, 0.25, { width: 5, taperStart: 0.05, taperEnd: 0.1 }, r);
    if (prog > 0.01) gStroke(g, [{ x: bx, y: 76 }, { x: bx + 140 * prog, y: 76 }], C.ink, 0.85, { width: 4, taperStart: 0.05, taperEnd: 0.2 }, r);

    // Dash et charge d'iai
    gBlob(g, x0 + 5, 101, 5, p.dashCd <= 0 ? C.ink : C.washLight, p.dashCd <= 0 ? 0.85 : 0.4, r);
    if (p.state === 'iaiCharge') {
      const c = Math.min(1, p.iaiCharge / P.IAI_FULL_CHARGE);
      gStroke(g, [{ x: x0, y: 122 }, { x: x0 + 140 * c, y: 122 }], c >= 1 ? C.red : C.ink, 0.85, { width: 5, taperStart: 0.05, taperEnd: 0.3 }, r);
    }

    this.kills.setText(String(p.kills));
    this.record.setText(best > 0 ? `record ${best} · combo max ${p.bestCombo}` : '');

    // Combo
    if (p.combo > this.lastCombo) this.comboPop = 1;
    this.lastCombo = p.combo;
    this.comboPop = Math.max(0, this.comboPop - dt * 5);
    if (p.combo >= 2) {
      this.combo.setText(`${p.combo}\n連撃`);
      this.combo.setAlpha(Math.min(1, p.comboTimer / 30));
      this.combo.setScale(1 + this.comboPop * 0.35);
      this.combo.setColor(p.combo >= 10 ? '#b8321f' : '#15120e');
    } else this.combo.setText('');

    this.updateWave(w, g, r);
    this.updateCards(p, dt, time);
    this.updateLostMarker(p, cam, W, time);
  }

  private updateWave(w: World, g: Phaser.GameObjects.Graphics, r: Rand): void {
    const wv = w.wave;
    const st = w.stage;
    const W = this.scene.scale.width;
    const boss = w.enemies.find((e) => e.type === 'boss');
    const loop = st.loop > 0 ? `周 ${st.loop + 1}  ·  ` : '';
    if (st.state === 'arena') this.wave.setText(`${loop}門  le gardien barre la route`).setColor('#8e2416');
    else if (st.state === 'gateOpen') this.wave.setText(`${loop}門  la porte est ouverte — avancez →`).setColor('#b8321f');
    else if (st.state === 'cleared') this.wave.setText('');
    else if (wv.phase === 'tide') this.wave.setText(`${loop}潮  Marée ${wv.n}   ${Math.min(wv.kills, wv.quota)} / ${wv.quota}`).setColor('#8e2416');
    else if (wv.phase === 'calm') {
      const left = Math.max(0, (calmLength(w) - wv.t) / 60);
      this.wave.setText(`${loop}凪  accalmie — la Marée dans ${Math.ceil(left)} s`).setColor('#4a433b');
    } else this.wave.setText(`${loop}潮  la Marée monte…`).setColor('#8e2416');

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

  private updateCards(p: Player, dt: number, time: number): void {
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
      for (let i = 0; i < 3; i++) {
        const vis = i < p.offer.length;
        const c = this.cards[i];
        for (const o of [c.g, c.kanji, c.name, c.desc, c.lvl, c.key]) o.setVisible(vis);
      }
    }
    const show = p.offer.length > 0;
    this.cardRoot.setVisible(show);
    if (!show) return;
    this.cardsIn = Math.min(1, this.cardsIn + dt * 4);
    const e = 1 - Math.pow(1 - this.cardsIn, 3);
    this.cardRoot.setY((1 - e) * 140).setAlpha(e);
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const r = seeded(Math.floor(time / 140));
    for (let i = 0; i < p.offer.length; i++) {
      const g = this.cards[i].g;
      g.clear();
      const cx = W / 2 + (i - 1) * 190;
      const cy = H - 120;
      gFill(g, [{ x: cx - 80, y: cy - 74 }, { x: cx + 80, y: cy - 76 }, { x: cx + 82, y: cy + 62 }, { x: cx - 81, y: cy + 64 }], C.paper, 0.94);
      const border = [{ x: cx - 80, y: cy - 74 }, { x: cx + 80, y: cy - 76 }, { x: cx + 82, y: cy + 62 }, { x: cx - 81, y: cy + 64 }, { x: cx - 80, y: cy - 74 }];
      gStroke(g, border, C.ink, 0.85, { width: 2.6, taperStart: 0.02, taperEnd: 0.05, jitter: 0.25 }, r);
      gBlob(g, cx - 58, cy - 54, 13, C.red, 0.12, r, 0.2);
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
