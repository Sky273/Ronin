// Surcouche des duels iaidō : invitation, cercle d'encre, noms et marques de victoire, garde,
// signal 斬, issue des manches, fin de série, toasts de salle. Toute la logique de présentation
// des duels vit ici ; GameScene se contente d'appeler update / onEvent / hide / clear.
import type Phaser from 'phaser';
import { DUEL, DUEL_WHY } from '../../shared/constants';
import type { GameEvent, World } from '../../shared/types';
import type { Sfx } from '../audio/sfx';
import { gStroke, hash2, type Pt, ringPoints, seeded } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT, hexCss } from '../render/palette';
import {
  cancelText, createDuelMemo, type DuelBoutView, type DuelMemo, type DuelSideView, type DuelViewModel, endToast, inviteText, seriesText,
} from './duelView';

type Text = Phaser.GameObjects.Text;
type G = Phaser.GameObjects.Graphics;
type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

/** Branchements optionnels fournis par la scène (son, tremblement de caméra). */
export interface DuelHooks {
  sfx?: Sfx;
  shake?: (amount: number) => void;
}

/** Hauteur des noms au-dessus des pieds (px monde), comme les noms de la scène. */
const NAME_UP = 64;
const MARK_UP = 82;
/** Durée d'affichage d'un toast (s) et de la fin de série une fois le duel retiré (s). */
const TOAST_S = 3.2;
const FINALE_S = 2.6;
/** Marge de visibilité d'un duel spectateur autour de la vue (px monde). */
const VIEW_MARGIN = 120;

interface Slot {
  nameA: Text;
  nameB: Text;
  markA: Text;
  markB: Text;
  zan: Text; // 斬 au-dessus du lieu (spectateurs)
  sig: boolean; // signal visible à l'image précédente
  zanAt: number; // instant d'apparition du signal (ms)
  used: boolean; // affiché à cette image
  alive: boolean; // présent dans le monde à cette image
}

const setT = (t: Text, s: string): void => {
  if (t.text !== s) t.setText(s);
};

/**
 * Surcouche des duels. Aucune allocation d'objet Phaser par image : textes en pool par duel,
 * `setText` seulement quand le texte change, cercles redessinés au rythme du « frémissement ».
 */
export class DuelOverlay {
  /** Derniers événements par duel (lus par duelView). */
  readonly memo: DuelMemo = createDuelMemo();
  private slots = new Map<number, Slot>();
  private pairs = new Map<number, { a: number; b: number }>();
  private owned = new Set<number>();
  private gRing: G;
  private gUi: G;
  private ketsu: Text;
  private invite: Text;
  private title: Text;
  private sub: Text;
  private times: Text;
  private zan: Text;
  private toast: Text;
  private toastLeft = 0;
  private finale = { title: '', sub: '', red: false, left: 0 };
  private mySig = false;
  private zanAt = 0;
  private flash = 0;
  private lastTime = -1;
  private ringKey = -1;
  private lastWorld: World | null = null;
  private visible = false;

  constructor(
    private scene: Phaser.Scene,
    private put: Put,
    private hooks: DuelHooks = {},
  ) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const paper = hexCss(C.paper);
    this.gRing = put(scene.add.graphics().setDepth(4), 'world');
    this.gUi = put(scene.add.graphics().setDepth(96), 'ui');
    this.ketsu = put(
      scene.add.text(0, 0, '決', { fontFamily: FONT_BRUSH, fontSize: '30px', color: hexCss(C.red), stroke: paper, strokeThickness: 4 })
        .setOrigin(0.5, 1).setDepth(26).setVisible(false),
      'world',
    );
    this.invite = put(
      scene.add.text(W / 2, 128, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: hexCss(C.ink), stroke: paper, strokeThickness: 4 })
        .setOrigin(0.5).setDepth(130).setVisible(false),
      'ui',
    );
    this.title = put(
      scene.add.text(W / 2, H * 0.25, '', { fontFamily: FONT_BRUSH, fontSize: '72px', color: hexCss(C.ink), stroke: paper, strokeThickness: 6 })
        .setOrigin(0.5).setDepth(130).setVisible(false),
      'ui',
    );
    this.sub = put(
      scene.add.text(W / 2, H * 0.25 + 58, '', { fontFamily: FONT_TEXT, fontSize: '19px', color: '#2e2924', stroke: paper, strokeThickness: 4 })
        .setOrigin(0.5).setDepth(130).setVisible(false),
      'ui',
    );
    this.times = put(
      scene.add.text(W / 2, H * 0.25 + 86, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#4a433b', stroke: paper, strokeThickness: 4 })
        .setOrigin(0.5).setDepth(130).setVisible(false),
      'ui',
    );
    this.zan = put(
      scene.add.text(W / 2, H * 0.4, '斬', { fontFamily: FONT_BRUSH, fontSize: '210px', color: hexCss(C.red), stroke: paper, strokeThickness: 8 })
        .setOrigin(0.5).setDepth(135).setVisible(false),
      'ui',
    );
    this.toast = put(
      scene.add.text(W / 2, H - 170, '', { fontFamily: FONT_TEXT, fontSize: '18px', color: hexCss(C.ink), stroke: paper, strokeThickness: 4 })
        .setOrigin(0.5).setDepth(130).setVisible(false),
      'ui',
    );
  }

  /** Encore quelque chose à montrer ou à libérer sans duel dans le monde (toast, fin de série, pool). */
  get busy(): boolean {
    return this.toastLeft > 0 || this.finale.left > 0 || this.slots.size > 0;
  }

  /** Le nom de ce joueur est-il déjà affiché par un duel (la scène masque alors le sien) ? */
  ownsName(pid: number): boolean {
    return this.owned.has(pid);
  }

  /** À appeler à chaque image pendant une partie. `time` : horloge de la scène (ms). */
  update(view: DuelViewModel, world: World, cam: Phaser.Cameras.Scene2D.Camera, time: number): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(0.05, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;
    this.lastWorld = world;
    this.visible = true;
    const g = this.gUi;
    g.clear();
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;

    // ─── Invitations ─────────────────────────────────────────────────────
    // Défi reçu et défi envoyé ensemble : le bandeau dit que G annule d'abord le second.
    const mine = view.mine;
    const inc = mine ? null : view.incoming;
    const out = mine ? null : view.outgoing;
    if (inc || out) {
      const iv = (inc ?? out)!;
      this.rememberName(iv.pid, iv.name);
      setT(this.invite, inviteText(inc, out));
      this.invite.setVisible(true);
      // Barre de temps restant, sous le bandeau.
      const bw = Math.max(220, this.invite.width);
      const x0 = W / 2 - bw / 2;
      const y0 = this.invite.y + 18;
      g.fillStyle(C.wash, 0.25);
      g.fillRect(x0, y0, bw, 4);
      g.fillStyle(inc ? C.red : C.inkSoft, 0.85);
      g.fillRect(x0, y0, bw * iv.frac, 4);
    } else if (this.invite.visible) this.invite.setVisible(false);
    // 決 au-dessus du défieur.
    const challenger = inc ? world.players.find((p) => p.id === inc.pid) : undefined;
    if (challenger && challenger.state !== 'dead') {
      this.ketsu.setPosition(challenger.x, challenger.y - MARK_UP - 6 + Math.sin(time * 0.006) * 3).setVisible(true);
    } else if (this.ketsu.visible) this.ketsu.setVisible(false);

    // ─── Duels dans le monde (cercle, noms, marques, 斬 des spectateurs) ──
    for (const s of this.slots.values()) s.used = s.alive = false;
    this.owned.clear();
    const v = cam.worldView;
    let ringKey = Math.floor(time / 85) * 31;
    let rings = 0;
    const visit = (b: DuelBoutView): void => {
      if (!this.pairs.has(b.id)) this.pairs.set(b.id, { a: b.a.pid, b: b.b.pid });
      this.rememberName(b.a.pid, b.a.name);
      this.rememberName(b.b.pid, b.b.name);
      const slot = this.slot(b.id);
      slot.alive = true;
      const half = b.gap / 2 + VIEW_MARGIN;
      const inView = b.x + half > v.x && b.x - half < v.right && b.y + 60 > v.y && b.y - 260 < v.bottom;
      if (!b.mine && !inView) return;
      slot.used = true;
      this.placeSide(slot.nameA, slot.markA, b.a, b);
      this.placeSide(slot.nameB, slot.markB, b.b, b);
      // Signal : le son part à l'image même où il devient visible.
      if (b.showSignal && !slot.sig) {
        slot.zanAt = time;
        this.hooks.sfx?.zan(!b.mine);
      }
      slot.sig = b.showSignal;
      if (!b.mine && b.showSignal) {
        const k = 1 + 0.5 * Math.exp(-(time - slot.zanAt) / 70);
        slot.zan.setPosition(b.x, b.y - 150).setScale(k).setVisible(true);
      } else if (slot.zan.visible) slot.zan.setVisible(false);
      ringKey = (Math.imul(ringKey, 33) + b.id * 7 + Math.round(b.enterK * 24) + (b.mine ? 1 : 0)) | 0;
      rings++;
    };
    if (mine) visit(mine);
    for (const o of view.others) visit(o);
    for (const [id, s] of this.slots) {
      if (!s.alive) {
        this.destroySlot(s);
        this.slots.delete(id);
      } else if (!s.used) this.hideSlot(s);
    }
    // Mémoire des duels disparus : libérée (la fin de série a déjà été retenue dans `finale`).
    for (const id of this.pairs.keys()) {
      if (!this.slots.has(id)) {
        this.pairs.delete(id);
        this.memo.rounds.delete(id);
        this.memo.ends.delete(id);
      }
    }
    if (rings === 0) ringKey = -2;
    if (ringKey !== this.ringKey) {
      this.ringKey = ringKey;
      this.gRing.clear();
      if (mine) this.drawRing(mine, time);
      for (const o of view.others) if (this.slots.get(o.id)?.used) this.drawRing(o, time);
    }

    // ─── Duel du joueur local : textes, 斬, effets d'écran ───────────────
    this.finale.left = Math.max(0, this.finale.left - dt);
    this.flash = Math.max(0, this.flash - dt);
    if (mine) {
      this.drawMine(mine, time, W, H);
    } else {
      if (this.zan.visible) this.zan.setVisible(false);
      this.mySig = false;
      if (this.finale.left > 0) {
        this.showTitle(this.finale.title, this.finale.sub, '', this.finale.red, Math.min(1, this.finale.left / 0.6), 96);
      } else this.hideTitle();
    }
    if (this.flash > 0) {
      g.fillStyle(C.paper, Math.min(0.55, this.flash * 3.5));
      g.fillRect(0, 0, W, H);
    }

    // ─── Toast de salle ──────────────────────────────────────────────────
    if (this.toastLeft > 0) {
      this.toastLeft -= dt;
      this.toast.setAlpha(Math.max(0, Math.min(1, this.toastLeft / 0.5))).setVisible(this.toastLeft > 0);
    } else if (this.toast.visible) this.toast.setVisible(false);
  }

  /** Événements de duel (les cinq types) ; les autres sont ignorés. */
  onEvent(ev: GameEvent, meId: number): void {
    const sfx = this.hooks.sfx;
    switch (ev.type) {
      case 'duelInvite':
        if (ev.to === meId) sfx?.duelInvite();
        else if (ev.from === meId) sfx?.tick();
        break;
      case 'duelCancel': {
        const s = ev.from === meId || ev.to === meId ? cancelText(ev, meId, this.nameOf) : '';
        if (s) this.showToast(s);
        break;
      }
      case 'duelStart':
        this.memo.rounds.delete(ev.id);
        this.memo.ends.delete(ev.id);
        this.pairs.set(ev.id, { a: ev.a, b: ev.b });
        if (ev.a === meId || ev.b === meId) {
          this.finale.left = 0;
          sfx?.drum(0, true);
        }
        break;
      case 'duelRound': {
        this.memo.rounds.set(ev.id, ev);
        const pair = this.pairs.get(ev.id);
        if (!pair || (pair.a !== meId && pair.b !== meId)) break;
        if (ev.why === DUEL_WHY.IPPON || ev.why === DUEL_WHY.FOUL) {
          this.flash = 0.16;
          this.hooks.shake?.(ev.why === DUEL_WHY.IPPON ? 8 : 4);
          sfx?.drum(0, true);
        } else if (ev.why === DUEL_WHY.PARRY) {
          this.flash = 0.1;
          this.hooks.shake?.(5);
          sfx?.drum(0, false);
        } else sfx?.tick();
        break;
      }
      case 'duelEnd': {
        this.memo.ends.set(ev.id, ev);
        const pair = this.pairs.get(ev.id);
        if (!pair) break;
        if (pair.a === meId || pair.b === meId) {
          const s = seriesText(pair.a, pair.b, ev.winner, ev.wa, ev.wb, ev.why, meId, this.nameOf);
          this.finale.title = s.title;
          this.finale.sub = s.sub;
          this.finale.red = s.red;
          this.finale.left = FINALE_S;
          if (ev.winner === meId) sfx?.bell();
          else sfx?.drum(0, true);
        } else this.showToast(endToast(ev, pair.a, pair.b, this.nameOf));
        break;
      }
    }
  }

  /** Masque tout (solo, menus) sans libérer le pool. */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    for (const s of this.slots.values()) this.hideSlot(s);
    for (const t of [this.ketsu, this.invite, this.title, this.sub, this.times, this.zan, this.toast]) if (t.visible) t.setVisible(false);
    this.gRing.clear();
    this.gUi.clear();
    this.ringKey = -1;
    this.owned.clear();
    this.lastTime = -1;
  }

  /** Libère tout l'état (changement de source, nouvelle partie). */
  clear(): void {
    this.visible = true;
    this.hide();
    for (const s of this.slots.values()) this.destroySlot(s);
    this.slots.clear();
    this.pairs.clear();
    this.memo.rounds.clear();
    this.memo.ends.clear();
    this.memo.names.clear();
    this.finale.left = 0;
    this.toastLeft = 0;
    this.flash = 0;
    this.mySig = false;
    this.lastWorld = null;
  }

  // ─── Détails ──────────────────────────────────────────────────────────

  private nameOf = (pid: number): string => {
    const p = this.lastWorld?.players.find((q) => q.id === pid);
    return (p && p.name) || this.memo.names.get(pid) || 'ronin';
  };

  private rememberName(pid: number, name: string): void {
    if (name && name !== 'ronin' && this.memo.names.get(pid) !== name) this.memo.names.set(pid, name);
  }

  private showToast(s: string): void {
    setT(this.toast, s);
    this.toastLeft = TOAST_S;
    this.toast.setAlpha(1).setVisible(true);
  }

  private drawMine(b: DuelBoutView, time: number, W: number, H: number): void {
    const g = this.gUi;
    // Bandes d'encre en haut et en bas : le monde se resserre sur le face-à-face.
    const fade = b.phase === 'end' ? Math.max(0, Math.min(1, (DUEL.END_TICKS - b.t) / 30)) : 1;
    const band = 22 * (b.phase === 'enter' ? b.enterK : 1) * fade;
    if (band > 0.5) {
      g.fillStyle(C.ink, 0.82);
      g.fillRect(0, 0, W, band);
      g.fillRect(0, H - band, W, band);
    }
    if (b.phase === 'kamae' && !b.showSignal) {
      // Garde : le lavis gagne lentement les bords (tension), sans rien cacher de l'action.
      const k = Math.min(1, b.t / 120) * 0.1;
      g.fillStyle(C.ink, k);
      g.fillRect(0, band, 26, H - 2 * band);
      g.fillRect(W - 26, band, 26, H - 2 * band);
    }

    if (b.showSignal) {
      if (!this.mySig) {
        this.zanAt = time;
        this.flash = 0.12;
        this.hooks.shake?.(3);
      }
      const age = time - this.zanAt;
      this.zan.setScale(1 + 0.6 * Math.exp(-age / 70)).setAlpha(1).setVisible(true);
      // Trait vermillon derrière le kanji, le temps de son apparition seulement.
      if (age < 400) {
        const r = seeded(hash2(b.id, b.round + 17));
        const cx = W / 2;
        const cy = this.zan.y;
        const k = Math.min(1, age / 90);
        const pts: Pt[] = [{ x: cx - 220, y: cy + 70 }, { x: cx - 220 + 440 * k, y: cy + 70 - 140 * k }];
        gStroke(g, pts, C.redDeep, 0.35 * (1 - age / 400), { width: 26, taperStart: 0.1, taperEnd: 0.5, jitter: 0.3 }, r);
      }
      this.hideTitle();
    } else {
      if (this.zan.visible) this.zan.setVisible(false);
      const size = b.phase === 'resolve' || b.phase === 'end' ? 96 : 72;
      this.showTitle(b.title, b.sub, b.times, b.red, fade, size);
    }
    this.mySig = b.showSignal;
  }

  private showTitle(title: string, sub: string, times: string, red: boolean, alpha: number, size: number): void {
    setT(this.title, title);
    const color = red ? hexCss(C.red) : hexCss(C.ink);
    if (this.title.style.color !== color) this.title.setColor(color);
    const fs = `${size}px`;
    if (this.title.style.fontSize !== fs) this.title.setFontSize(fs);
    setT(this.sub, sub);
    setT(this.times, times);
    this.title.setAlpha(alpha).setVisible(title !== '');
    this.sub.setAlpha(alpha).setVisible(sub !== '');
    this.times.setAlpha(alpha).setVisible(times !== '');
  }

  private hideTitle(): void {
    for (const t of [this.title, this.sub, this.times]) if (t.visible) t.setVisible(false);
  }

  private placeSide(name: Text, mark: Text, s: DuelSideView, b: DuelBoutView): void {
    if (!s.present) {
      if (name.visible) name.setVisible(false);
      if (mark.visible) mark.setVisible(false);
      return;
    }
    this.owned.add(s.pid);
    setT(name, s.name);
    const color = hexCss(s.color);
    if (name.style.color !== color) name.setColor(color);
    setT(mark, s.marks);
    const alpha = b.phase === 'end' ? Math.max(0, Math.min(1, (DUEL.END_TICKS - b.t) / 30)) : 1;
    name.setPosition(s.x, s.y - NAME_UP).setAlpha(alpha).setVisible(true);
    mark.setPosition(s.x, s.y - MARK_UP).setAlpha(alpha).setVisible(true);
  }

  /** Ensō aplati autour du lieu du duel, tracé à mesure de la mise en place, et deux marques au sol. */
  private drawRing(b: DuelBoutView, time: number): void {
    const g = this.gRing;
    const r = seeded(hash2(b.id, Math.floor(time / 85)));
    const rx = b.gap / 2 + 50;
    const ry = 46;
    const cy = b.y - 28;
    const a0 = -Math.PI / 2 - 0.35;
    const span = Math.PI * 2 * 0.93 * b.enterK;
    const fade = b.phase === 'end' ? Math.max(0, Math.min(1, (DUEL.END_TICKS - b.t) / 30)) : 1;
    const alpha = (b.mine ? 0.42 : 0.28) * fade;
    if (span > 0.05 && alpha > 0.01) {
      const pts = ringPoints(b.x, 0, rx, a0, a0 + span, 28);
      for (const p of pts) p.y = cy + p.y * (ry / rx);
      gStroke(g, pts, C.ink, alpha, { width: b.mine ? 7 : 5, taperStart: 0.06, taperEnd: 0.35, jitter: 0.35 }, r, 2);
    }
    if (b.enterK > 0.5 && fade > 0.01) {
      for (const sx of [-1, 1]) {
        const x = b.x + sx * (b.gap / 2);
        gStroke(g, [{ x: x - 12, y: b.y + 1 }, { x: x + 12, y: b.y }], C.red, 0.6 * fade, { width: 4, taperStart: 0.2, taperEnd: 0.4 }, r);
      }
    }
  }

  private slot(id: number): Slot {
    let s = this.slots.get(id);
    if (!s) {
      const paper = hexCss(C.paper);
      const mk = (size: number, brush: boolean, color: string): Text =>
        this.put(
          this.scene.add.text(0, 0, '', {
            fontFamily: brush ? FONT_BRUSH : FONT_TEXT, fontSize: `${size}px`, color, stroke: paper, strokeThickness: 3,
          }).setOrigin(0.5, 1).setDepth(26).setVisible(false),
          'world',
        );
      const red = hexCss(C.red);
      s = {
        nameA: mk(13, false, hexCss(C.ink)),
        nameB: mk(13, false, hexCss(C.ink)),
        markA: mk(15, true, red),
        markB: mk(15, true, red),
        zan: mk(54, true, red).setOrigin(0.5).setText('斬'),
        sig: false,
        zanAt: 0,
        used: false,
        alive: false,
      };
      this.slots.set(id, s);
    }
    return s;
  }

  private hideSlot(s: Slot): void {
    for (const t of [s.nameA, s.nameB, s.markA, s.markB, s.zan]) if (t.visible) t.setVisible(false);
    s.sig = false;
  }

  private destroySlot(s: Slot): void {
    for (const t of [s.nameA, s.nameB, s.markA, s.markB, s.zan]) t.destroy();
  }
}
