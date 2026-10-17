// Surcouche du tournoi du dojo (道場) : petit panneau d'état hors de son propre match, grand tableau
// (quarts, demies, finale, champion) ouvert de lui-même au tirage, pendant les pauses et à la fin, ou à
// la demande avec Tab, et toasts des résultats que les duels n'annoncent pas. Toute la présentation du
// tableau vit ici ; GameScene se contente d'appeler update / tab / onEvent / hide / clear.
import type Phaser from 'phaser';
import type { GameEvent, World } from '../../shared/types';
import { gFill, gStroke, hash2, type Pt, seeded } from '../render/brush';
import { C, FONT_BRUSH, FONT_TEXT, hexCss } from '../render/palette';
import { type BracketEntrantView, type BracketModel, BracketToggle, resultToast } from './bracketView';

type Text = Phaser.GameObjects.Text;
type G = Phaser.GameObjects.Graphics;
type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

/** Grand tableau : panneau dans la moitié basse de l'écran (les bannières gardent le tiers haut). */
const PX0 = 150;
const PX1 = 1130;
const PY0 = 300;
const PY1 = 706;
/** Rangées des quarts (px écran) et colonnes des tours (bord gauche des noms). */
const ROW0 = 384;
const ROW_STEP = 38;
const COLS: readonly number[] = [190, 440, 690];
const CELL_W = 200;
const CHAMP_X = 940;
/** Durée d'affichage d'un toast (s). */
const TOAST_S = 3.2;
/** Rythme du « frémissement » de l'encre du tableau (ms). */
const BOIL_MS = 170;

const COL_INK = hexCss(C.ink);
const COL_SOFT = '#4a433b';
const COL_FAINT = '#9d9487';
const COL_RED = hexCss(C.red);

interface Cell {
  name: Text;
  score: Text;
  x: number;
  y: number;
}

const setT = (t: Text, s: string): void => {
  if (t.text !== s) t.setText(s);
};
const recolor = (t: Text, c: string): void => {
  if (t.style.color !== c) t.setColor(c);
};

/** Hauteur (px écran) de la place `i` d'un tour : quarts en rangées, puis au milieu de chaque paire (tour 3 : le champion). */
function slotY(round: number, i: number): number {
  if (round === 0) return ROW0 + i * ROW_STEP;
  return (slotY(round - 1, 2 * i) + slotY(round - 1, 2 * i + 1)) / 2;
}

/**
 * Surcouche du tournoi. Aucune allocation d'objet Phaser par image : 15 places et 7 mentions créées une
 * fois, `setText` seulement quand le texte change, tableau redessiné quand son contenu change et au
 * rythme du frémissement de l'encre.
 */
export class BracketOverlay {
  private toggle = new BracketToggle();
  private last: BracketModel | null = null;
  /** Matchs du tournoi en cours qui ont donné lieu à un duel (leur fin est annoncée par la surcouche des duels). */
  private dueledSet = new Set<number>();
  private dueledN = -1;
  // Petit panneau.
  private status: Text;
  private detail: Text;
  // Grand tableau.
  private root: Phaser.GameObjects.Container;
  private g: G;
  private title: Text;
  private stage: Text;
  private foot: Text;
  private hint: Text;
  private champKanji: Text;
  private champ: Text;
  private cells: Cell[][] = [];
  private marks: Text[] = [];
  private drawKey = '';
  private open = false;
  // Toast.
  private toastT: Text;
  private toastLeft = 0;
  private lastTime = -1;
  private visible = false;

  constructor(scene: Phaser.Scene, put: Put) {
    const W = scene.scale.width;
    const H = scene.scale.height;
    const paper = hexCss(C.paper);
    const text = (x: number, y: number, size: number, brush: boolean, color: string, stroke = 0): Text =>
      scene.add.text(x, y, '', { fontFamily: brush ? FONT_BRUSH : FONT_TEXT, fontSize: `${size}px`, color, stroke: paper, strokeThickness: stroke });
    this.status = put(text(W / 2, 62, 19, false, COL_INK, 4).setOrigin(0.5).setDepth(103).setVisible(false), 'ui');
    this.detail = put(text(W / 2, 88, 14, false, COL_SOFT, 3).setOrigin(0.5).setDepth(103).setVisible(false), 'ui');
    this.toastT = put(text(W / 2, H - 205, 18, false, COL_INK, 4).setOrigin(0.5).setDepth(130).setVisible(false), 'ui');

    this.g = scene.add.graphics();
    this.title = text(PX0 + 40, PY0 + 28, 28, true, COL_INK).setOrigin(0, 0.5);
    this.stage = text(PX1 - 40, PY0 + 30, 18, false, COL_SOFT).setOrigin(1, 0.5);
    this.foot = text(PX0 + 40, PY1 - 26, 16, false, COL_INK).setOrigin(0, 0.5);
    this.hint = text(PX1 - 40, PY1 - 26, 14, false, COL_SOFT).setOrigin(1, 0.5);
    this.champKanji = text(CHAMP_X + 70, slotY(3, 0) - 14, 40, true, COL_FAINT).setOrigin(0.5, 1).setText('優勝');
    this.champ = text(CHAMP_X, slotY(3, 0), 17, false, COL_INK).setOrigin(0, 0.5);
    const children: Phaser.GameObjects.GameObject[] = [this.g, this.title, this.stage, this.foot, this.hint, this.champKanji, this.champ];
    for (let round = 0; round < 3; round++) {
      const col: Cell[] = [];
      for (let i = 0; i < 8 >> round; i++) {
        const x = COLS[round];
        const y = slotY(round, i);
        const name = text(x, y, 15, false, COL_INK).setOrigin(0, 0.5);
        const score = text(x + CELL_W, y, 17, true, COL_INK).setOrigin(1, 0.5);
        col.push({ name, score, x, y });
        children.push(name, score);
      }
      this.cells.push(col);
    }
    for (let k = 0; k < 7; k++) {
      const t = text(0, 0, 13, true, COL_RED).setOrigin(1, 0.5);
      this.marks.push(t);
      children.push(t);
    }
    // Tous les enfants sont créés avant `put` : les autres caméras ignorent le conteneur entier.
    this.root = put(scene.add.container(0, 0, children).setDepth(125).setVisible(false), 'ui');
  }

  /** Le grand tableau est-il affiché ? */
  get isOpen(): boolean {
    return this.open;
  }

  /** Encore quelque chose à montrer sans tournoi dans le monde (toast). */
  get busy(): boolean {
    return this.toastLeft > 0;
  }

  /** Tab : ouvre ou referme le grand tableau. */
  tab(): void {
    this.toggle.toggle(this.last);
  }

  /** Ce match a-t-il donné lieu à un duel (sa fin a alors été annoncée par la surcouche des duels) ? */
  dueled(k: number): boolean {
    return this.dueledSet.has(k);
  }

  /** À appeler à chaque image pendant une partie ; `m` null hors du dojo. `time` : horloge de la scène (ms). */
  update(m: BracketModel | null, time: number): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(0.05, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;
    this.visible = true;
    this.last = m;
    if (m) {
      if (m.n !== this.dueledN) {
        this.dueledN = m.n;
        this.dueledSet.clear();
      }
      for (const x of m.matches) if (x.state === 'live') this.dueledSet.add(x.k);
    }
    this.open = this.toggle.update(m);

    // ─── Petit panneau : état personnel, hors de son match et du grand tableau ─
    const compact = !!m && !this.open && !m.inMatch;
    if (compact) {
      setT(this.status, m.status);
      recolor(this.status, m.phase === 'done' && m.champion?.me ? COL_RED : COL_INK);
      setT(this.detail, m.detail);
    }
    if (this.status.visible !== compact) this.status.setVisible(compact);
    if (this.detail.visible !== compact) this.detail.setVisible(compact);

    // ─── Grand tableau ───────────────────────────────────────────────────
    if (this.root.visible !== this.open) this.root.setVisible(this.open);
    if (this.open && m) this.drawBracket(m, time);

    // ─── Toast ───────────────────────────────────────────────────────────
    if (this.toastLeft > 0) {
      this.toastLeft -= dt;
      this.toastT.setAlpha(Math.max(0, Math.min(1, this.toastLeft / 0.5))).setVisible(this.toastLeft > 0);
    } else if (this.toastT.visible) this.toastT.setVisible(false);
  }

  /** Événements du tournoi (dojo*) ; les autres sont ignorés. `w` : le monde, à jour de l'événement. */
  onEvent(ev: GameEvent, w: World, meId: number): void {
    switch (ev.type) {
      case 'dojoStart':
      case 'dojoReset':
        this.dueledSet.clear();
        this.dueledN = ev.n;
        break;
      case 'dojoMatch':
        this.dueledSet.add(ev.match);
        break;
      case 'dojoResult': {
        const t = w.tournament;
        const s = t ? resultToast(ev, t, meId, this.dueledSet.has(ev.match)) : '';
        if (s) this.showToast(s);
        break;
      }
    }
  }

  /** Masque tout (solo, menus) sans rien oublier. */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    for (const t of [this.status, this.detail, this.toastT]) if (t.visible) t.setVisible(false);
    if (this.root.visible) this.root.setVisible(false);
    this.open = false;
    this.lastTime = -1;
  }

  /** Oublie tout l'état (changement de source, nouvelle partie). */
  clear(): void {
    this.visible = true;
    this.hide();
    this.toggle.reset();
    this.last = null;
    this.dueledSet.clear();
    this.dueledN = -1;
    this.toastLeft = 0;
    this.drawKey = '';
  }

  // ─── Détails ──────────────────────────────────────────────────────────

  private showToast(s: string): void {
    setT(this.toastT, s);
    this.toastLeft = TOAST_S;
    this.toastT.setAlpha(1).setVisible(true);
  }

  private drawBracket(m: BracketModel, time: number): void {
    setT(this.title, m.title);
    setT(this.stage, m.stage);
    setT(this.foot, m.status);
    recolor(this.foot, m.phase === 'done' && m.champion?.me ? COL_RED : COL_INK);
    setT(this.hint, m.phase === 'waiting' ? 'Tab: close · G: ready' : 'Tab: close');
    const boil = Math.floor(time / BOIL_MS);
    const key = `${m.key}|${boil}`;
    if (key === this.drawKey) return;
    const contentChanged = !this.drawKey.startsWith(`${m.key}|`);
    this.drawKey = key;
    if (contentChanged) this.fillCells(m);
    this.paint(m, boil);
  }

  /** Noms, scores et mentions des places (seulement quand le contenu change). */
  private fillCells(m: BracketModel): void {
    const put = (c: Cell, e: BracketEntrantView | null, score: string, state: 'win' | 'lose' | 'live' | 'open', red: boolean): void => {
      const name = e ? (e.gone ? `${e.name} · left` : e.name) : '—';
      setT(c.name, name);
      recolor(c.name, e ? hexCss(e.color) : COL_FAINT);
      c.name.setAlpha(!e ? 0.5 : state === 'lose' || e.gone ? 0.42 : 1);
      setT(c.score, score);
      recolor(c.score, red ? COL_RED : COL_INK);
      c.score.setAlpha(state === 'lose' ? 0.5 : 1);
    };
    if (m.matches.length === 0) {
      // Attente : les présents dans l'ordre d'arrivée, coche des prêts ; le reste du tableau est à venir.
      this.cells[0].forEach((c, i) => {
        const e = m.entrants[i] ?? null;
        put(c, e, e?.ready ? '✓' : '', 'open', !!e?.ready);
      });
      for (const r of [1, 2]) for (const c of this.cells[r]) put(c, null, '', 'open', false);
      for (const t of this.marks) setT(t, '');
    } else {
      for (const x of m.matches) {
        const i = x.k - (x.round === 0 ? 0 : x.round === 1 ? 4 : 6);
        const ca = this.cells[x.round][2 * i];
        const cb = this.cells[x.round][2 * i + 1];
        const st = (pid: number | undefined): 'win' | 'lose' | 'live' | 'open' =>
          x.state === 'live' ? 'live' : x.state === 'done' ? (pid === x.winner ? 'win' : 'lose') : 'open';
        put(ca, x.a, x.sa, st(x.a?.pid), x.state === 'live' || (x.state === 'done' && x.winner === x.a?.pid && x.a?.me === true));
        put(cb, x.b, x.sb, st(x.b?.pid), x.state === 'live' || (x.state === 'done' && x.winner === x.b?.pid && x.b?.me === true));
        const mk = this.marks[x.k];
        setT(mk, x.mark);
        mk.setPosition(ca.x + CELL_W, (ca.y + cb.y) / 2);
      }
    }
    const ch = m.champion;
    setT(this.champ, ch ? ch.name : '');
    if (ch) recolor(this.champ, hexCss(ch.color));
    recolor(this.champKanji, ch ? COL_RED : COL_FAINT);
    this.champKanji.setAlpha(ch ? 1 : 0.45);
  }

  /** Panneau, filets sous les noms, traits du tableau (le chemin des vainqueurs à l'encre pleine). */
  private paint(m: BracketModel, boil: number): void {
    const g = this.g;
    g.clear();
    const r = seeded(hash2(311, boil));
    const quad: Pt[] = [{ x: PX0, y: PY0 + 2 }, { x: PX1 + 2, y: PY0 }, { x: PX1, y: PY1 }, { x: PX0 - 2, y: PY1 - 2 }];
    gFill(g, quad, C.paper, 0.96);
    gStroke(g, [...quad, quad[0]], C.ink, 0.85, { width: 3.2, taperStart: 0.02, taperEnd: 0.04, jitter: 0.3 }, r);
    gStroke(g, [{ x: PX0 + 36, y: PY0 + 54 }, { x: PX1 - 36, y: PY0 + 55 }], C.ink, 0.22, { width: 1.6, taperStart: 0.3, taperEnd: 0.3 }, r);
    // Sceau vermillon dans le coin, comme les autres panneaux.
    gFill(g, [{ x: PX1 - 34, y: PY0 + 12 }, { x: PX1 - 12, y: PY0 + 13 }, { x: PX1 - 13, y: PY0 + 35 }, { x: PX1 - 35, y: PY0 + 34 }], C.red, 0.85);

    // Filets sous les noms ; vermillon sous le joueur local.
    const line = (c: Cell, me: boolean): void => {
      gStroke(g, [{ x: c.x - 4, y: c.y + 11 }, { x: c.x + CELL_W + 4, y: c.y + 12 }], me ? C.red : C.wash, me ? 0.8 : 0.3, { width: me ? 2.4 : 1.4, taperStart: 0.1, taperEnd: 0.3 }, r);
    };
    // Occupant de la place `i` d'un tour : présent (attente, quarts seulement) ou participant d'un match.
    const occupant = (round: number, i: number): BracketEntrantView | null | undefined => {
      if (m.matches.length === 0) return round === 0 ? m.entrants[i] : null;
      const x = m.matches[(round === 0 ? 0 : round === 1 ? 4 : 6) + (i >> 1)];
      return i & 1 ? x?.b : x?.a;
    };
    for (let round = 0; round < 3; round++) this.cells[round].forEach((c, i) => line(c, occupant(round, i)?.me === true));
    gStroke(g, [{ x: CHAMP_X - 4, y: slotY(3, 0) + 11 }, { x: CHAMP_X + 160, y: slotY(3, 0) + 12 }], m.champion?.me ? C.red : C.wash, 0.4, { width: 1.6, taperStart: 0.1, taperEnd: 0.3 }, r);

    // Traits de chaque match : deux branches et le trait vers la place suivante.
    for (let k = 0; k < 7; k++) {
      const round = k < 4 ? 0 : k < 6 ? 1 : 2;
      const i = k - (round === 0 ? 0 : round === 1 ? 4 : 6);
      const ya = slotY(round, 2 * i);
      const yb = slotY(round, 2 * i + 1);
      const ym = (ya + yb) / 2;
      const x0 = COLS[round] + CELL_W + 8;
      const xj = x0 + 20;
      const xn = (round < 2 ? COLS[round + 1] : CHAMP_X) - 8;
      const x = m.matches[k];
      const done = x?.state === 'done';
      const live = x?.state === 'live';
      const aWon = done && x.winner === x.a?.pid;
      const bWon = done && x.winner === x.b?.pid;
      const branch = (y: number, won: boolean): void => {
        gStroke(g, [{ x: x0, y }, { x: xj, y: y + 0.5 }, { x: xj, y: ym }], won ? C.ink : C.wash, won ? 0.85 : 0.35, { width: won ? 2.6 : 1.6, taperStart: 0.05, taperEnd: 0.05, jitter: 0.25 }, r);
      };
      branch(ya, aWon);
      branch(yb, bWon);
      gStroke(g, [{ x: xj, y: ym }, { x: xn, y: ym + 0.5 }], done ? C.ink : C.wash, done ? 0.85 : 0.35, { width: done ? 2.6 : 1.6, taperStart: 0.05, taperEnd: 0.2 }, r);
      // Match en cours : touche vermillon à la jonction.
      if (live) gFill(g, [{ x: xj - 4, y: ym - 4 }, { x: xj + 4, y: ym - 3 }, { x: xj + 3, y: ym + 4 }, { x: xj - 3, y: ym + 3 }], C.red, 0.9);
    }
  }
}
