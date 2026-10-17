import Phaser from 'phaser';
import { MAX_NAME, ROOMS, type RoomName, sanitizePlayerName } from '../../shared/net/protocol';
import { gFill, gStroke, seeded, type Pt } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT } from '../render/palette';

type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

/** Délai pendant lequel l'écran ignore touches et clics après son apparition. */
const INPUT_GUARD_MS = 300;
/** Caractères acceptés à la frappe : les mêmes que ceux conservés par sanitizePlayerName. */
const NAME_CHAR = /^[\p{L}\p{N} ._-]$/u;
const cpLen = (s: string): number => Array.from(s).length;
const COL_STATUS = '#4a433b';
const COL_ERROR = '#b8321f';

/** Textes du menu selon la salle visée : la route partagée (縁) ou le dojo (道場). */
const ROOM_TEXT: Record<RoomName, { kanji: string; title: string; sub: string; join: string }> = {
  [ROOMS.coop]: { kanji: '縁', title: 'Online — the shared road', sub: 'Up to twelve ronin walk the same path', join: 'Enter — Join a room' },
  [ROOMS.dojo]: { kanji: '道場', title: 'Dojo — the tournament', sub: 'Eight duelists, one bracket · bots fill the empty places', join: 'Enter — Enter the dojo' },
};

/**
 * Menu du mode en ligne : pseudo, puis rejoindre une salle de la route partagée (縁) ou du dojo (道場),
 * selon la salle passée à `show`.
 */
export class OnlineMenu {
  private root: Phaser.GameObjects.Container;
  private panel: Phaser.GameObjects.Graphics;
  private field: Phaser.GameObjects.Text;
  private counter: Phaser.GameObjects.Text;
  private cursor: Phaser.GameObjects.Graphics;
  private join: Phaser.GameObjects.Text;
  private back: Phaser.GameObjects.Text;
  private status: Phaser.GameObjects.Text;
  private kanji: Phaser.GameObjects.Text;
  private title: Phaser.GameObjects.Text;
  private sub: Phaser.GameObjects.Text;
  private roomName: RoomName = ROOMS.coop;
  private text = '';
  private shown = false;
  private busy = false;
  private readyAt = 0;

  constructor(private scene: Phaser.Scene, put: Put, private cb: { onJoin(name: string, room: RoomName): void; onBack(): void }) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const cx = W / 2;
    const veil = scene.add.rectangle(0, 0, W, H, C.paper, 0.55).setOrigin(0);
    this.panel = scene.add.graphics();
    this.drawPanel();
    const kanji = (this.kanji = scene.add.text(cx, 176, '縁', { fontFamily: FONT_BRUSH, fontSize: '96px', color: '#15120e' }).setOrigin(0.5));
    const title = (this.title = scene.add.text(cx, 250, 'Online — the shared road', { fontFamily: FONT_TEXT, fontSize: '24px', color: '#15120e' }).setOrigin(0.5));
    const sub = (this.sub = scene.add.text(cx, 284, 'Up to twelve ronin walk the same path', { fontFamily: FONT_TEXT, fontSize: '16px', color: '#6b6359' }).setOrigin(0.5));
    const label = scene.add.text(cx - 210, 344, 'Your name', { fontFamily: FONT_TEXT, fontSize: '16px', color: '#6b6359' }).setOrigin(0, 0.5);
    this.counter = scene.add.text(cx + 210, 344, '', { fontFamily: FONT_TEXT, fontSize: '15px', color: '#6b6359' }).setOrigin(1, 0.5);
    this.field = scene.add.text(cx - 206, 386, '', { fontFamily: FONT_BRUSH, fontSize: '32px', color: '#15120e' }).setOrigin(0, 0.5);
    this.cursor = scene.add.graphics();
    gStroke(this.cursor, [{ x: 0, y: -18 }, { x: 1, y: 0 }, { x: 0, y: 18 }], C.red, 0.9, { width: 3.5, taperStart: 0.1, taperEnd: 0.3, jitter: 0.2 }, seeded(5));

    this.join = scene.add.text(cx, 470, 'Enter — Join a room', { fontFamily: FONT_TEXT, fontSize: '22px', color: '#b8321f' }).setOrigin(0.5);
    this.join.setInteractive({ useHandCursor: true });
    this.join.on('pointerdown', () => this.keyText('Enter', 'Enter'));
    this.back = scene.add.text(cx, 512, 'Esc — Back', { fontFamily: FONT_TEXT, fontSize: '17px', color: '#6b6359' }).setOrigin(0.5);
    this.back.setInteractive({ useHandCursor: true });
    this.back.on('pointerdown', () => this.keyText('Escape', 'Escape'));
    this.status = scene.add.text(cx, 562, '', { fontFamily: FONT_TEXT, fontSize: '17px', color: COL_STATUS, align: 'center', wordWrap: { width: 540 } }).setOrigin(0.5);

    this.root = put(
      scene.add
        .container(0, 0, [veil, this.panel, kanji, title, sub, label, this.counter, this.field, this.cursor, this.join, this.back, this.status])
        .setDepth(210)
        .setVisible(false),
      'ui',
    );
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Texte brut saisi. */
  get name(): string {
    return this.text;
  }

  /** Salle vers laquelle mène le menu. */
  get room(): RoomName {
    return this.roomName;
  }

  /** Affiche le menu pour rejoindre la salle `room` (route partagée par défaut). */
  show(defaultName: string, room: RoomName = ROOMS.coop): void {
    this.scene.tweens.killTweensOf([this.root, this.cursor, this.join]);
    this.shown = true;
    this.roomName = room;
    const tx = ROOM_TEXT[room];
    this.kanji.setText(tx.kanji);
    this.title.setText(tx.title);
    this.sub.setText(tx.sub);
    this.join.setText(tx.join);
    this.busy = false;
    this.readyAt = this.scene.time.now + INPUT_GUARD_MS;
    this.text = Array.from(defaultName).slice(0, MAX_NAME).join('');
    this.setStatus('');
    this.refresh();
    this.root.setVisible(true).setAlpha(0).setY(20);
    this.scene.tweens.add({ targets: this.root, alpha: 1, y: 0, duration: 450, ease: 'Sine.easeOut' });
    this.cursor.setAlpha(1);
    this.scene.tweens.add({ targets: this.cursor, alpha: 0, duration: 480, yoyo: true, repeat: -1, ease: 'Stepped', easeParams: [1] });
    this.scene.tweens.add({ targets: this.join, alpha: { from: 0.45, to: 1 }, delay: 600, duration: 800, yoyo: true, repeat: -1 });
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.busy = false;
    this.scene.tweens.killTweensOf([this.root, this.cursor, this.join]);
    this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 300, onComplete: () => this.root.setVisible(false) });
  }

  /**
   * Ligne d'état sous les boutons (« Connecting… », erreur…). Une erreur rend la main au joueur
   * (il peut corriger son nom et réessayer) ; un texte vide efface la ligne.
   */
  setStatus(text: string, isError = false): void {
    this.status.setText(text).setColor(isError ? COL_ERROR : COL_STATUS);
    if (isError) this.busy = false;
  }

  /** Reçoit chaque touche en mode saisie (`e.key`, `e.code`). */
  keyText(key: string, code: string): void {
    if (!this.shown || this.scene.time.now < this.readyAt) return;
    if (code === 'Escape') {
      this.busy = false;
      this.cb.onBack();
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      if (this.busy) return; // une seule tentative à la fois
      this.busy = true;
      const name = sanitizePlayerName(this.text);
      this.text = name;
      this.refresh();
      this.setStatus('Connecting…');
      this.cb.onJoin(name, this.roomName);
      return;
    }
    if (this.busy) return; // nom figé pendant la connexion
    if (code === 'Backspace') {
      this.text = Array.from(this.text).slice(0, -1).join('');
    } else if (cpLen(key) === 1 && NAME_CHAR.test(key)) {
      if (cpLen(this.text) >= MAX_NAME) return;
      this.text += key;
    } else {
      return;
    }
    this.refresh();
  }

  /** Touches de menu hors mode saisie (clavier ou manette relayés par la scène). */
  key(code: string): void {
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') this.keyText('Enter', 'Enter');
    else if (code === 'Escape') this.keyText('Escape', 'Escape');
  }

  private refresh(): void {
    this.field.setText(this.text);
    this.counter.setText(`${cpLen(this.text)}/${MAX_NAME}`);
    this.cursor.setPosition(this.field.x + this.field.width + 5, this.field.y);
  }

  private drawPanel(): void {
    const cx = this.scene.scale.width / 2;
    const r = seeded(137);
    const g = this.panel;
    const quad: Pt[] = [{ x: cx - 300, y: 108 }, { x: cx + 302, y: 104 }, { x: cx + 298, y: 610 }, { x: cx - 304, y: 606 }];
    gFill(g, quad, C.paper, 0.96);
    gStroke(g, [...quad, quad[0]], C.ink, 0.85, { width: 3.5, taperStart: 0.02, taperEnd: 0.04, jitter: 0.3 }, r);
    // Ligne d'écriture du nom.
    gStroke(g, [{ x: cx - 214, y: 416 }, { x: cx, y: 418 }, { x: cx + 214, y: 415 }], C.ink, 0.7, { width: 2.6, taperStart: 0.05, taperEnd: 0.4, jitter: 0.25 }, r, 3);
    gStroke(g, [{ x: cx - 150, y: 312 }, { x: cx + 150, y: 313 }], C.ink, 0.25, { width: 1.6, taperStart: 0.3, taperEnd: 0.3 }, r);
    // Sceau rouge discret dans le coin du panneau.
    gFill(g, [{ x: cx + 228, y: 138 }, { x: cx + 268, y: 140 }, { x: cx + 266, y: 180 }, { x: cx + 226, y: 178 }], C.red, 0.85);
  }
}
