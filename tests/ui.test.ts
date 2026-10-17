// Tests de l'interface sans navigateur : entrées (Controls), audio (Sfx), HUD et bilan sur une
// fausse scène Phaser (hud.ts et results.ts n'utilisent Phaser que pour leurs types).
// Lancer : npm run test:ui
import { BTN } from '../shared/input';
import { gainHonor } from '../shared/interactions';
import type { Player, World } from '../shared/types';
import { addPlayer, createWorld } from '../shared/world';
import { Sfx } from '../client/audio/sfx';
import { Controls, shortcutChar } from '../client/input/controls';
import { Hud } from '../client/ui/hud';
import { Results } from '../client/ui/results';
import { buildRoster } from '../client/ui/roster';

export {}; // module isolé (déclarations locales au fichier)
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Une partie qui lève compte comme un échec, sans empêcher les suivantes de tourner. */
function section(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    check(`${name} : exception`, false, (e as Error).message);
  }
}

// ─── Faux DOM : fenêtre, cible des clics, AudioContext ──────────────────────

type Ev = Record<string, unknown>;

class FakeTarget {
  private ls = new Map<string, ((e: Ev) => void)[]>();
  addEventListener(type: string, fn: (e: Ev) => void): void {
    const l = this.ls.get(type) ?? [];
    l.push(fn);
    this.ls.set(type, l);
  }
  fire(type: string, e: Ev): void {
    for (const fn of this.ls.get(type) ?? []) fn(e);
  }
}

class FakeParam {
  value = 0;
  setValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  setTargetAtTime(): this {
    return this;
  }
}

class FakeNode {
  connect(): void {}
}

/** Lecture d'un tampon : départ dans le tampon, durée demandée, longueur du tampon (s). */
interface BufferStart {
  offset: number;
  duration: number;
  length: number;
  loop: boolean;
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  sampleRate = 48000;
  currentTime = 0;
  destination = new FakeNode();
  starts: BufferStart[] = [];
  constructor() {
    FakeAudioContext.last = this;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  createBuffer(_channels: number, len: number, rate: number) {
    const data = new Float32Array(len);
    return { duration: len / rate, length: len, getChannelData: () => data };
  }
  createBufferSource() {
    const starts = this.starts;
    const src = Object.assign(new FakeNode(), {
      buffer: null as { duration: number } | null,
      loop: false,
      start(_t = 0, offset = 0, duration = Infinity) {
        starts.push({ offset, duration, length: src.buffer?.duration ?? 0, loop: src.loop });
      },
    });
    return src;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: '', Q: new FakeParam(), frequency: new FakeParam() });
  }
  createOscillator() {
    return Object.assign(new FakeNode(), { type: '', frequency: new FakeParam(), start() {}, stop() {} });
  }
}

const win = Object.assign(new FakeTarget(), { AudioContext: FakeAudioContext });
(globalThis as unknown as { window: unknown }).window = win;

/** Touche pressée puis relâchée (`key` : caractère produit selon la disposition). */
function press(code: string, key: string, over: Ev = {}): void {
  const e = { code, key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...over };
  win.fire('keydown', e);
  win.fire('keyup', e);
}
/** Bouton gauche enfoncé sur le canevas ; `timeStamp` : création de l'événement (par défaut, maintenant). */
function mouseDown(canvas: FakeTarget, timeStamp = performance.now() + 1): void {
  canvas.fire('mousedown', { button: 0, timeStamp });
}
function mouseUp(): void {
  win.fire('mouseup', { button: 0 });
}

// ─── 16 : reset() n'avale que le clic en cours ─────────────────────────────
section('16', () => {
  const canvas = new FakeTarget();
  const c = new Controls(canvas as never);
  c.reset(); // départ au clavier, game over : aucun bouton tenu
  mouseDown(canvas);
  mouseUp();
  check('16 : après reset() sans clic en cours, le premier clic attaque', (c.sample() & BTN.ATTACK) !== 0);
  // Clic sur « Hard » : Phaser le traite (et lance la partie, donc reset) avant que Controls ne le voie.
  const t0 = performance.now();
  c.reset();
  mouseDown(canvas, t0);
  check('16 : le clic qui a provoqué reset() ne devient pas une attaque', (c.sample() & BTN.ATTACK) === 0);
  mouseUp();
  mouseDown(canvas);
  mouseUp();
  check('16 : … et le clic suivant attaque', (c.sample() & BTN.ATTACK) !== 0);
  // Clic déjà vu par Controls et encore tenu au moment du reset() : oublié.
  mouseDown(canvas);
  c.reset();
  check('16 : clic tenu pendant reset() oublié', c.sample() === 0);
  mouseUp();
  // Sortie de la saisie du nom au clavier : le premier clic compte.
  c.setTextMode(() => {});
  c.setTextMode(null);
  mouseDown(canvas);
  mouseUp();
  check('16 : après la saisie du nom, le premier clic attaque', (c.sample() & BTN.ATTACK) !== 0);
});

// ─── 18 : raccourcis H, M, N par la lettre produite ─────────────────────────
section('18', () => {
  const c = new Controls(new FakeTarget() as never);
  const n = { m: 0, n: 0, h: 0 };
  c.onChar('m', () => n.m++);
  c.onChar('N', () => n.n++);
  c.onChar('h', () => n.h++);
  press('Semicolon', 'm');
  check('18 : AZERTY, lettre M (position Semicolon) → son', n.m === 1, `${n.m}`);
  press('KeyM', ',');
  check('18 : AZERTY, touche « , » (position KeyM) → rien', n.m === 1, `${n.m}`);
  press('KeyM', 'm');
  press('KeyM', 'M');
  check('18 : QWERTY, m puis M (insensible à la casse)', n.m === 3, `${n.m}`);
  press('KeyN', 'n');
  press('KeyH', 'H');
  check('18 : N et H', n.n === 1 && n.h === 1, `n ${n.n} · h ${n.h}`);
  c.sample();
  press('KeyJ', 'n'); // Colemak : J (attaque) produit « n »
  check('18 : une touche de jeu ne déclenche aucun raccourci (Colemak, J = « n »)', n.n === 1 && (c.sample() & BTN.ATTACK) !== 0, `n ${n.n}`);
  press('KeyM', 'ь'); // russe : lettre d'une autre écriture → position physique, comme avant
  check('18 : disposition non latine : position physique', n.m === 4, `${n.m}`);
  press('Semicolon', 'm', { repeat: true });
  check('18 : répétition ignorée', n.m === 4, `${n.m}`);
  const typed: string[] = [];
  c.setTextMode((key) => typed.push(key));
  press('Semicolon', 'm');
  press('KeyH', 'h');
  press('KeyN', 'n');
  c.setTextMode(null);
  check('18 : pendant la saisie du nom, ni M ni H ni N', n.m === 4 && n.h === 1 && n.n === 1 && typed.join('') === 'mhn', `saisi « ${typed.join('')} »`);
  press('KeyH', 'm'); // Colemak-DH : la lettre M est en position H
  check('18 : la lettre d\'un raccourci prime sur le repli par position', n.m === 5 && n.h === 1, `m ${n.m} · h ${n.h}`);
  check(
    '18 : shortcutChar',
    shortcutChar('m', 'Semicolon') === 'm' && shortcutChar(',', 'KeyM') === '' && shortcutChar('Enter', 'Enter') === ''
      && shortcutChar('é', 'Digit2') === '' && shortcutChar('ж', 'Semicolon') === '' && shortcutChar('Ь', 'KeyM') === 'm',
  );
  // Les trois rangées de lettres, tapées dans chaque disposition : H, M et N doivent rester joignables
  // (repli par position quand leur lettre tombe sur une touche de jeu), jamais par une touche de jeu.
  const rows = ['KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight', 'KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote', 'KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash'].flatMap((r) => r.split(' '));
  const layouts: [string, string, string][] = [
    // Disposition, caractère produit par chaque position de `rows`, positions attendues de H, M et N.
    ['QWERTY', "qwertyuiop[]asdfghjkl;'zxcvbnm,./", 'KeyH KeyM KeyN'],
    ['AZERTY', 'azertyuiop^$qsdfghjklmùwxcvbn,;:!', 'KeyH Semicolon KeyN'], // « , » en KeyM : rien (défaut 18)
    ['Dvorak', "',.pyfgcrl/=aoeuidhtns-;qjkxbmwvz", 'KeyH KeyM KeyN'], // h et n sur J et L (attaque, iai)
    ['Colemak', "qwfpgjluy;[]arstdhneio'zxcvbkm,./", 'KeyH KeyM KeyN'], // n sur J (attaque)
  ];
  for (const [name, keys, want] of layouts) {
    const lc = new Controls(new FakeTarget() as never);
    const by: Record<string, string[]> = { h: [], m: [], n: [] };
    let at = '';
    for (const ch of 'hmn') lc.onChar(ch, () => by[ch].push(at));
    const count = () => by.h.length + by.m.length + by.n.length;
    let games = 0;
    const leaks: string[] = [];
    [...keys].forEach((key, i) => {
      at = rows[i];
      const before = count();
      press(at, key);
      if (lc.sample() === 0) return;
      games++; // touche de jeu : le bouton est enregistré
      if (count() !== before) leaks.push(`${at} « ${key} »`);
    });
    const got = [by.h, by.m, by.n].map((l) => l.join('+') || 'aucune').join(' ');
    check(`18 : ${name}, H, M et N joignables, une touche chacun`, got === want, got);
    check(`18 : ${name}, aucune touche de jeu ne déclenche de raccourci`, games === 9 && leaks.length === 0, `${games} touches de jeu${leaks.length ? ` · ${leaks.join(', ')}` : ''}`);
  }
});

// ─── 19 : « press any key » ─────────────────────────────────────────────────
section('19', () => {
  const c = new Controls(new FakeTarget() as never);
  let any = 0;
  const order: string[] = [];
  c.onKey('Enter', () => order.push('code'));
  c.onChar('m', () => order.push('char'));
  c.onAnyKey(() => {
    any++;
    order.push('any');
  });
  for (const [code, key] of [['KeyE', 'e'], ['KeyR', 'r'], ['Backspace', 'Backspace'], ['Tab', 'Tab'], ['KeyJ', 'j'], ['F5', 'F5']]) press(code, key);
  check('19 : toute touche est signalée (lettres, Retour arrière, Tab, touche de jeu, F5)', any === 6, `${any}`);
  press('KeyE', 'e', { repeat: true });
  check('19 : répétition non signalée', any === 6, `${any}`);
  order.length = 0;
  press('Enter', 'Enter');
  press('Semicolon', 'm');
  check('19 : signalée après les autres actions de la touche', order.join(',') === 'code,any,char,any', order.join(','));
  c.setTextMode(() => {});
  press('KeyE', 'e');
  c.setTextMode(null);
  check('19 : rien pendant la saisie du nom', any === 8, `${any}`);
  // La touche qui passe l'écran (leaveGameOver ouvre le champ dans son keydown), si elle reste
  // enfoncée, ne se répète pas dans le champ ; une touche pressée dans le champ s'y répète.
  const field: string[] = [];
  const toField = () => c.setTextMode((key) => field.push(key));
  const down = (code: string, key: string, repeat = false) => win.fire('keydown', { code, key, repeat, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
  const up = (code: string, key: string) => win.fire('keyup', { code, key });
  const hold = (code: string, key: string, repeats: number) => {
    down(code, key);
    for (let i = 0; i < repeats; i++) down(code, key, true);
    up(code, key);
  };
  c.onAnyKey(toField);
  hold('KeyE', 'e', 8);
  check('19 : E tenu pour passer l\'écran : rien dans le champ', field.length === 0, `saisi « ${field.join('')} »`);
  hold('KeyE', 'e', 2);
  check('19 : … relâché puis repressé dans le champ : saisi et répété', field.join('') === 'eee', `saisi « ${field.join('')} »`);
  c.setTextMode(null);
  field.length = 0;
  hold('Backspace', 'Backspace', 8);
  check('19 : Retour arrière tenu pour passer l\'écran : nom prérempli intact', field.length === 0, `${field.length} touches`);
  hold('Backspace', 'Backspace', 3);
  check('19 : … pressé dans le champ : répétition gardée', field.length === 4 && field.every((k) => k === 'Backspace'), field.join(','));
  c.setTextMode(null);
  field.length = 0;
  c.onAnyKey(() => {});
  down('KeyJ', 'j'); // tenue depuis la mort jusqu'au départ automatique (GAME_OVER_HOLD)
  toField();
  for (let i = 0; i < 8; i++) down('KeyJ', 'j', true);
  up('KeyJ', 'j');
  hold('Enter', 'Enter', 3);
  c.setTextMode(null);
  check('19 : touche tenue au départ automatique : rien ; Entrée pressée dans le champ : une fois', field.join(',') === 'Enter', field.join(','));
});

// ─── 17 et 27 : sourdine avant le déblocage, bruit borné au tampon ──────────
section('17', () => {
  const gain = (s: Sfx) => (s.output!.dest as unknown as { gain: { value: number } }).gain.value;
  const s = new Sfx();
  s.toggleMute(); // M sur le titre, avant tout geste de menu
  s.init();
  check('17 : M pressé avant le déblocage de l\'audio → gain 0 à la création', gain(s) === 0, `gain ${gain(s)}`);
  s.toggleMute();
  check('17 : M de nouveau → son rétabli', gain(s) > 0, `gain ${gain(s)}`);
  const t = new Sfx();
  t.init();
  check('17 : sans M, son audible', gain(t) > 0, `gain ${gain(t)}`);
});

section('27', () => {
  const s = new Sfx();
  s.init();
  const ctx = FakeAudioContext.last!;
  const sounds: [string, () => void][] = [
    ['roar', () => s.roar()], ['slam', () => s.slam(true)], ['swing', () => s.swing(true)], ['hit', () => s.hit(true)],
    ['slice', () => s.slice()], ['iai', () => s.iai(true)], ['dash', () => s.dash()], ['spawn', () => s.spawn()],
    ['guardBreak', () => s.guardBreak()], ['drum', () => s.drum(0, true)], ['smoke', () => s.smoke()], ['zan', () => s.zan()],
  ];
  const rnd = Math.random;
  const over: string[] = [];
  try {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      Math.random = () => r;
      for (const [name, play] of sounds) {
        const from = ctx.starts.length;
        play();
        for (const st of ctx.starts.slice(from)) {
          if (!st.loop && st.offset + st.duration > st.length + 1e-9) over.push(`${name}@${r} : ${st.offset.toFixed(3)} + ${st.duration.toFixed(2)} > ${st.length}`);
        }
      }
    }
  } finally {
    Math.random = rnd;
  }
  check('27 : aucun bruit ne dépasse la fin du tampon (roar compris)', over.length === 0, over.slice(0, 3).join(' ; '));
  const roar = ctx.starts.filter((st) => Math.abs(st.duration - 0.95) < 1e-9);
  check('27 : le bruit de roar() est lu en entier (0,95 s)', roar.length === 4, `${roar.length} lectures`);
});

// ─── Fausse scène Phaser ────────────────────────────────────────────────────

type Pt = { x: number; y: number };

/** Texte, graphisme ou conteneur : setters chaînables, état lisible par les tests. */
class FakeObj {
  alpha = 1;
  visible = true;
  scale = 1;
  style: { color: string };
  /** Appels à setColor (chacun redessine le texte et sa texture dans Phaser). */
  colorSets = 0;
  parent: FakeObj | null = null;
  polys: Pt[][] = [];
  constructor(public x = 0, public y = 0, public text = '', style: { color?: string } = {}) {
    this.style = { color: style.color ?? '#fff' };
  }
  get width(): number {
    return this.text.length * 9;
  }
  /** Affiché : lui et tous ses conteneurs. */
  get shown(): boolean {
    return this.visible && (this.parent ? this.parent.shown : true);
  }
  /** Position des conteneurs parents (les points d'un graphisme sont relatifs à elle). */
  get origin(): Pt {
    const o = this.parent ? this.parent.origin : { x: 0, y: 0 };
    return this.parent ? { x: o.x + this.parent.x, y: o.y + this.parent.y } : o;
  }
  setText(t: string): this {
    this.text = String(t);
    return this;
  }
  setColor(c: string): this {
    this.style.color = c;
    this.colorSets++;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setScale(s: number): this {
    this.scale = s;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setY(y: number): this {
    this.y = y;
    return this;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(): this {
    return this;
  }
  setFontSize(): this {
    return this;
  }
  setAngle(): this {
    return this;
  }
  add(o: FakeObj | FakeObj[]): this {
    for (const c of ([] as FakeObj[]).concat(o)) c.parent = this;
    return this;
  }
  clear(): this {
    this.polys = [];
    return this;
  }
  fillStyle(): this {
    return this;
  }
  fillPoints(pts: Pt[]): this {
    this.polys.push(pts.map((p) => ({ x: p.x, y: p.y })));
    return this;
  }
}

function fakeScene() {
  return {
    scale: { width: 1280, height: 720 },
    time: { now: 0 },
    add: {
      text: (x: number, y: number, s: string, style: { color?: string } = {}) => new FakeObj(x, y, s, style),
      graphics: () => new FakeObj(),
      container: (x = 0, y = 0, children: FakeObj[] = []) => new FakeObj(x, y).add(children),
    },
    tweens: {
      // Tweens sans délai : valeur d'arrivée tout de suite (bannière affichée, panneau en place).
      add(cfg: Record<string, unknown>): void {
        if (cfg.delay || cfg.repeat || cfg.yoyo) return;
        for (const t of ([] as FakeObj[]).concat(cfg.targets as FakeObj | FakeObj[])) {
          for (const k of ['alpha', 'x', 'y', 'scale'] as const) if (typeof cfg[k] === 'number') t[k] = cfg[k] as number;
        }
      },
      killTweensOf(): void {},
    },
  };
}
const put = <T>(o: T): T => o;
const cam = { worldView: { x: 0, y: 0, width: 914, height: 514, right: 914, bottom: 514 } };

/** Champs internes du HUD et du bilan lus par les tests. */
interface HudView {
  cardRoot: FakeObj;
  help: FakeObj;
  wave: FakeObj;
  combo: FakeObj;
  bannerTitle: FakeObj;
  cards: { g: FakeObj }[];
}
interface ResultsView {
  root: FakeObj;
  panel: FakeObj;
  footer: FakeObj;
}

/** HUD sur une fausse scène ; `frame(play)` : une image de 16 ms. */
function hudBench(w: World, me: Player) {
  const scene = fakeScene();
  const hud = new Hud(scene as never, put as never);
  const v = hud as unknown as HudView;
  const frame = (play = true) => {
    scene.time.now += 16;
    hud.update(me, w, 0, 1 / 60, scene.time.now, cam as never, play);
  };
  return { scene, hud, v, frame };
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
function bounds(pts: Pt[], at: Pt): Rect {
  const xs = pts.map((p) => p.x + at.x);
  const ys = pts.map((p) => p.y + at.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const fmt = (r: Rect) => `x ${Math.round(r.x0)}–${Math.round(r.x1)}, y ${Math.round(r.y0)}–${Math.round(r.y1)}`;
/** Rectangles écran des cartes affichées (fond de chaque carte). */
const cardRects = (v: HudView): Rect[] => v.cards.filter((c) => c.g.shown && c.g.polys.length > 0).map((c) => bounds(c.g.polys[0], c.g.origin));

// ─── 15 et 21 : cartes seulement quand le choix est possible ; aide effacée pendant le choix ─
section('15', () => {
  const w = createWorld(5);
  const me = addPlayer(w, 'Ronin');
  const { hud, v, frame } = hudBench(w, me);
  frame();
  check('21 : aide affichée par défaut', v.help.visible);
  gainHonor(w, me, 40); // niveau 1 : une offre de 3 cartes
  frame();
  check('15 : en jeu, vivant : cartes affichées', me.offer.length === 3 && v.cardRoot.visible, `offre ${me.offer.length}`);
  check('21 : aide effacée pendant le choix (plus de chevauchement avec les cartes)', !v.help.visible);
  me.state = 'dead';
  frame();
  check('15 : 討死 d\'une mort ordinaire (1 2 3 ignorés) : cartes masquées', !v.cardRoot.visible);
  me.out = true;
  frame(false);
  check('15 : fin de partie (joueur sorti) : cartes masquées', !v.cardRoot.visible);
  me.state = 'normal';
  me.out = false;
  frame(false);
  check('15 : hors de l\'écran de jeu (titre, saisie du nom, tableau) : cartes masquées', !v.cardRoot.visible);
  frame();
  check('15 : de retour en jeu : cartes', v.cardRoot.visible);
  me.offer = [];
  frame();
  check('21 : choix fait : l\'aide revient', v.help.visible && !v.cardRoot.visible);
  hud.toggleHelp();
  check('21 : H masque l\'aide', !v.help.visible);
  gainHonor(w, me, 60);
  frame();
  me.offer = [];
  frame();
  check('21 : aide masquée par H : elle le reste après un choix', !v.help.visible);
  hud.toggleHelp();
  check('21 : H la réaffiche', v.help.visible);
});

// ─── 46 : bilan coop, cartes hors du panneau (pied de page du vote, tableau) ─
section('46', () => {
  const w = createWorld(9, { mode: 'coop' });
  const players = Array.from({ length: 12 }, (_, i) => addPlayer(w, `Ronin${i}`, { color: i }));
  const me = players[0];
  const { scene, v, frame } = hudBench(w, me);
  const results = new Results(scene as never, put as never, () => {});
  const r = results as unknown as ResultsView;
  gainHonor(w, me, 40);
  w.stage.state = 'cleared';
  results.show(w.stage, me, { stage: 0, biome: w.level.biome }, buildRoster(w, me.id));
  for (let i = 0; i < 30; i++) frame();
  const panel = bounds(r.panel.polys[0], { x: r.root.x, y: r.root.y });
  const footerY = r.footer.y + r.root.y;
  const cards = cardRects(v);
  check('46 : bilan coop à 12 : pied de page dans le panneau', footerY > panel.y0 && footerY < panel.y1, `pied ${footerY}, panneau ${fmt(panel)}`);
  check(
    '46 : bilan coop : les 3 cartes restent affichées, hors du panneau (pied de page, tableau)',
    v.cardRoot.visible && cards.length === 3 && cards.every((c) => !overlaps(c, panel)),
    `panneau ${fmt(panel)} · cartes ${cards.map(fmt).join(' | ')}`,
  );
  check('46 : cartes entièrement à l\'écran, sous le HUD du haut', cards.every((c) => c.x0 >= 0 && c.x1 <= 1280 && c.y0 >= 150 && c.y1 <= 720), cards.map(fmt).join(' | '));
  // Étape suivante : la rangée revient en bas de l'écran.
  w.stage.state = 'playing';
  results.hide();
  for (let i = 0; i < 30; i++) frame();
  const row = cardRects(v);
  check('46 : en jeu, rangée centrée en bas', row.length === 3 && row.every((c) => c.y1 <= 720 && c.y0 > 500) && Math.abs((row[0].x0 + row[2].x1) / 2 - 640) < 4, row.map(fmt).join(' | '));
});

section('46 solo', () => {
  const w = createWorld(9);
  const me = addPlayer(w, 'Ronin');
  const { v, frame } = hudBench(w, me);
  gainHonor(w, me, 40);
  w.stage.state = 'cleared'; // bilan solo : panneau jusqu'à 528, la rangée ne gêne pas
  for (let i = 0; i < 30; i++) frame();
  const row = cardRects(v);
  check('46 : bilan solo : rangée inchangée en bas', row.length === 3 && row.every((c) => c.y0 > 500), row.map(fmt).join(' | '));
});

// ─── 20 et 45 : bannières ───────────────────────────────────────────────────
section('20', () => {
  const w = createWorld(3);
  const me = addPlayer(w, 'Ronin');
  const { scene, hud, v, frame } = hudBench(w, me);
  me.level = 2;
  frame();
  // Porte franchie : le bilan s'ouvre (bannières coupées) et son bonus fait passer un rang.
  hud.banner('開', 'The gate is open', '', '#b8321f', 2000);
  w.stage.state = 'cleared';
  hud.clearBanner();
  me.level = 3;
  frame();
  check('20 : bilan ouvert : bannière en cours coupée', v.bannerTitle.alpha === 0, `« ${v.bannerTitle.text} » alpha ${v.bannerTitle.alpha}`);
  for (let i = 0; i < 200; i++) frame();
  check('20 : bilan ouvert : pas de bannière de rang par-dessus', v.bannerTitle.alpha === 0 || !v.bannerTitle.text.startsWith('Rank'), `« ${v.bannerTitle.text} »`);
  // Étape suivante : sa bannière d'abord, le rang ensuite.
  w.stage.state = 'playing';
  hud.banner('焔', 'Stage 2 · the burning village', '', '#15120e', 2400);
  frame();
  check('20 : étape suivante : sa bannière n\'est pas coupée par le rang', v.bannerTitle.text.startsWith('Stage 2'), `« ${v.bannerTitle.text} »`);
  scene.time.now += 2400;
  frame();
  check('20 : … puis le rang est annoncé', v.bannerTitle.text === 'Rank attained: Samurai' && v.bannerTitle.alpha === 1, `« ${v.bannerTitle.text} »`);
  // Rang passé hors de l'écran de jeu : jamais annoncé.
  scene.time.now += 5000;
  me.level = 6;
  frame(false);
  scene.time.now += 5000;
  frame();
  check('20 : rang passé hors jeu : pas d\'annonce', v.bannerTitle.text === 'Rank attained: Samurai', `« ${v.bannerTitle.text} »`);
});

section('45', () => {
  const w = createWorld(3);
  const me = addPlayer(w, 'Ronin');
  const { scene, hud, v, frame } = hudBench(w, me);
  me.level = 2;
  frame();
  let gate = 'gateOpen';
  // Mort du gardien et ouverture de la porte au même tick ; ses orbes font passer un rang.
  hud.banner('討', 'Akaoni has fallen!', '+420 honor', '#b8321f', 2400);
  hud.queueBanner('開', 'The gate is open', 'pass through the torii to end the stage', '#b8321f', 2000, () => gate === 'gateOpen');
  frame();
  me.level = 3;
  for (let i = 0; i < 100; i++) frame();
  check('45 : « Akaoni has fallen! » et son gain d\'Honneur restent affichés', v.bannerTitle.text === 'Akaoni has fallen!' && v.bannerTitle.alpha === 1, `« ${v.bannerTitle.text} »`);
  scene.time.now += 2400;
  frame();
  check('45 : la porte est annoncée ensuite', v.bannerTitle.text === 'The gate is open', `« ${v.bannerTitle.text} »`);
  scene.time.now += 2000;
  frame();
  check('45 : puis le rang', v.bannerTitle.text === 'Rank attained: Samurai', `« ${v.bannerTitle.text} »`);
  // Porte franchie avant la fin de la bannière du gardien : l'annonce est abandonnée.
  scene.time.now += 5000;
  hud.banner('討', 'Akaoni has fallen!', '+420 honor', '#b8321f', 2400);
  hud.queueBanner('開', 'The gate is open', '', '#b8321f', 2000, () => gate === 'gateOpen');
  gate = 'cleared';
  scene.time.now += 2400;
  frame();
  check('45 : porte déjà franchie : annonce abandonnée', v.bannerTitle.text === 'Akaoni has fallen!', `« ${v.bannerTitle.text} »`);
  // Rien en cours : une bannière en file passe tout de suite.
  scene.time.now += 5000;
  hud.queueBanner('縁', 'The shared road', '', '#15120e', 2400);
  frame();
  check('45 : file vide et écran libre : affichage immédiat', v.bannerTitle.text === 'The shared road', `« ${v.bannerTitle.text} »`);
});

// ─── 26 : setColor seulement quand la couleur change ────────────────────────
section('26', () => {
  const w = createWorld(4);
  const me = addPlayer(w, 'Ronin');
  const { v, frame } = hudBench(w, me);
  for (let i = 0; i < 180; i++) {
    w.wave.t++;
    frame();
  }
  check('26 : texte de vague (calme, 3 s) : setColor au plus une fois', v.wave.colorSets <= 1 && v.wave.style.color === '#4a433b', `${v.wave.colorSets} appels, ${v.wave.style.color}`);
  w.wave.phase = 'tide';
  frame();
  check('26 : changement de phase : nouvelle couleur appliquée', v.wave.style.color === '#8e2416', v.wave.style.color);
  me.combo = 4;
  me.comboTimer = 60;
  for (let i = 0; i < 60; i++) frame();
  check('26 : combo (1 s) : setColor au plus une fois', v.combo.colorSets <= 1 && v.combo.style.color === '#15120e', `${v.combo.colorSets} appels`);
  me.combo = 12;
  frame();
  check('26 : combo ≥ 10 : vermillon', v.combo.style.color === '#b8321f', v.combo.style.color);
});

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de l\'interface passent.');
