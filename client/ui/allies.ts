import type Phaser from 'phaser';
import { TILE } from '../../shared/constants';
import { arenaInside } from '../../shared/level';
import type { World } from '../../shared/types';
import { C, FONT_BRUSH, FONT_TEXT, hexCss, playerColor } from '../render/palette';

type Text = Phaser.GameObjects.Text;
type Put = <T extends Phaser.GameObjects.GameObject>(obj: T, layer: 'bg' | 'world' | 'ui') => T;

/** Écart vertical minimal entre deux marqueurs d'un même bord (px écran). */
const GAP = 22;
/** Retrait horizontal des marqueurs par rapport au bord de l'écran (px). */
const EDGE = 18;
/** Bande verticale autorisée (px écran) : sous le HUD du haut, au-dessus du bas de l'écran. */
const TOP = 130;
const BOTTOM_MARGIN = 70;
/** Hauteur visée au-dessus des pieds (px monde) : à peu près le buste. */
const CHEST = 30;
/** Clé du marqueur d'entrée de l'arène dans le pool (aucun id de joueur n'est négatif). */
const KEKKAI = -1;

interface Slot {
  key: number;
  t: Text;
  right: boolean;
  y: number; // hauteur voulue, puis hauteur retenue après empilement
}

/**
 * Repères des coéquipiers hors de la vue (coop) : flèche ◀ ou ▶ à leur couleur au bord de
 * l'écran, avec leur nom et leur distance en tuiles ; repère « 結界 » vers l'entrée de l'arène
 * quand elle est fermée et que le joueur local est resté dehors. Les textes sont réutilisés
 * d'une image à l'autre (pool par id).
 */
export class AllyMarkers {
  private pool = new Map<number, Text>();
  private slots: Slot[] = [];

  constructor(
    private scene: Phaser.Scene,
    private put: Put,
  ) {}

  /** À appeler à chaque image pendant une partie ; masque tout hors du mode coop. */
  update(world: World, meId: number, cam: Phaser.Cameras.Scene2D.Camera): void {
    const me = world.players.find((p) => p.id === meId);
    if (world.mode !== 'coop' || !me) {
      this.hide();
      return;
    }
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const v = cam.worldView;
    const cx = v.x + v.width / 2;
    const toScreenY = (y: number) => ((y - v.y) / v.height) * H;
    const slots = this.slots;
    slots.length = 0;
    const used = new Set<number>();

    for (const p of world.players) {
      if (p.id === meId || p.out) continue;
      const y = p.y - CHEST;
      if (p.x >= v.x && p.x <= v.right && y >= v.y && y <= v.bottom) continue;
      const right = p.x > cx;
      const dist = Math.round(Math.abs(p.x - me.x) / TILE);
      const name = p.name || 'ronin';
      const label = right ? `${name}  ${dist} ▶` : `◀ ${dist}  ${name}`;
      const t = this.text(p.id, false);
      const color = hexCss(playerColor(p.color));
      if (t.text !== label) t.setText(label);
      if (t.style.color !== color) t.setColor(color);
      t.setAlpha(p.state === 'dead' || world.away?.includes(p.id) ? 0.35 : 0.95);
      slots.push({ key: p.id, t, right, y: toScreenY(y) });
      used.add(p.id);
    }

    // Arène fermée et joueur local dehors : direction et distance de l'entrée du kekkai.
    const l = world.level;
    const entry = (l.arena.col + 1) * TILE;
    if (world.stage.state === 'arena' && !arenaInside(l, me.x) && (entry < v.x || entry > v.right)) {
      const right = entry > me.x;
      const dist = Math.max(1, Math.ceil(Math.abs(entry - me.x) / TILE));
      const label = right ? `結界 ▶ ${dist}` : `◀ ${dist} 結界`;
      const t = this.text(KEKKAI, true);
      if (t.text !== label) t.setText(label);
      t.setAlpha(0.95);
      slots.push({ key: KEKKAI, t, right, y: toScreenY(l.arena.rows * TILE - 60) });
      used.add(KEKKAI);
    }

    this.layout(slots.filter((s) => !s.right), W, H);
    this.layout(slots.filter((s) => s.right), W, H);

    for (const [id, t] of this.pool) if (!used.has(id)) t.setVisible(false);
    // Coéquipiers partis : leur texte est libéré (rare, pas à chaque image).
    for (const [id, t] of this.pool) {
      if (id !== KEKKAI && !world.players.some((p) => p.id === id)) {
        t.destroy();
        this.pool.delete(id);
      }
    }
  }

  /** Masque tous les repères (solo, menus) sans libérer le pool. */
  hide(): void {
    for (const t of this.pool.values()) if (t.visible) t.setVisible(false);
  }

  /** Libère tous les repères (changement de source, nouvelle partie). */
  clear(): void {
    for (const t of this.pool.values()) t.destroy();
    this.pool.clear();
  }

  /** Empile les repères d'un bord : triés par hauteur voulue, écartés d'au moins GAP, bornés à l'écran. */
  private layout(side: Slot[], W: number, H: number): void {
    if (side.length === 0) return;
    const top = TOP;
    const bottom = Math.max(top, H - BOTTOM_MARGIN);
    side.sort((a, b) => a.y - b.y || a.key - b.key);
    // Descente : chaque repère au moins GAP sous le précédent.
    let prev = -Infinity;
    for (const s of side) {
      s.y = Math.max(top, Math.min(bottom, s.y), prev + GAP);
      prev = s.y;
    }
    // Remontée : si la pile déborde en bas, on la repousse vers le haut.
    let next = Infinity;
    for (let i = side.length - 1; i >= 0; i--) {
      const s = side[i];
      s.y = Math.min(s.y, bottom, next - GAP);
      next = s.y;
    }
    for (const s of side) {
      s.t.setOrigin(s.right ? 1 : 0, 0.5).setPosition(s.right ? W - EDGE : EDGE, Math.round(s.y)).setVisible(true);
    }
  }

  private text(key: number, kekkai: boolean): Text {
    let t = this.pool.get(key);
    if (!t) {
      t = this.put(
        this.scene.add
          .text(0, 0, '', {
            fontFamily: kekkai ? FONT_BRUSH : FONT_TEXT,
            fontSize: kekkai ? '22px' : '16px',
            color: kekkai ? hexCss(C.redDeep) : '#15120e',
            stroke: hexCss(C.paper),
            strokeThickness: 4,
          })
          .setDepth(102)
          .setVisible(false),
        'ui',
      );
      this.pool.set(key, t);
    }
    return t;
  }
}
