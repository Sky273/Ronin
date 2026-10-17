import { BTN } from '../../shared/input';

// On lit `event.code` (position physique de la touche) : ZQSD sur AZERTY et
// WASD sur QWERTY tombent donc sur les mêmes boutons, sans configuration.
// Les raccourcis mnémoniques (H, M, N) se lisent au contraire par la lettre produite (onChar),
// à défaut par leur position (Dvorak : h et n tombent sur des touches de jeu).
const KEYMAP: Record<string, number> = {
  ArrowLeft: BTN.LEFT,
  KeyA: BTN.LEFT,
  ArrowRight: BTN.RIGHT,
  KeyD: BTN.RIGHT,
  ArrowUp: BTN.UP,
  KeyW: BTN.UP,
  ArrowDown: BTN.DOWN,
  KeyS: BTN.DOWN,
  Space: BTN.JUMP,
  KeyJ: BTN.ATTACK,
  KeyK: BTN.PARRY,
  KeyL: BTN.IAI,
  ShiftLeft: BTN.DASH,
  ShiftRight: BTN.DASH,
  KeyI: BTN.DASH,
  Digit1: BTN.PICK1,
  Digit2: BTN.PICK2,
  Digit3: BTN.PICK3,
  Numpad1: BTN.PICK1,
  Numpad2: BTN.PICK2,
  Numpad3: BTN.PICK3,
  KeyG: BTN.DUEL,
};

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'F3', 'F4', 'F7', 'Escape', 'Backspace', 'Tab']);

// Touches dont le comportement navigateur gênerait la saisie d'un nom (retour arrière, défilement, focus).
const TEXT_PREVENT = new Set(['Backspace', 'Space', 'Enter', 'NumpadEnter', 'Tab']);

type TextFn = (key: string, code: string) => void;

/**
 * Lettre (a–z) d'un raccourci mnémonique : celle que produit la touche selon la disposition
 * (M est sur « ; » en AZERTY) ; pour une lettre d'une autre écriture (cyrillique, grec…),
 * celle de la position physique, comme avant. '' sinon (« , », chiffres, touches spéciales).
 */
export function shortcutChar(key: string, code: string): string {
  const k = key.length === 1 ? key.toLowerCase() : '';
  if (k >= 'a' && k <= 'z') return k;
  if (/^\p{L}$/u.test(key) && /^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return '';
}

export class Controls {
  private held = 0;
  private latched = 0; // pressions brèves survenues entre deux ticks
  private mouse = 0;
  private handlers = new Map<string, () => void>();
  private charHandlers = new Map<string, () => void>();
  private anyKey: (() => void) | null = null;
  private textFn: TextFn | null = null; // mode saisie : toutes les touches vont au champ texte
  private textDown = new Set<string>(); // touches pressées depuis l'entrée en saisie (seules à pouvoir s'y répéter)
  // Heure du dernier reset() : le clic alors en cours (ex. « Hard ») ne doit pas devenir une attaque.
  private resetAt = -Infinity;
  private padPrev = 0; // boutons de menu de la manette au tick précédent (fronts montants)

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (this.textFn) {
        // En saisie, ni boutons de jeu ni raccourcis (H, M, N…) : la touche n'appartient qu'au champ.
        if (TEXT_PREVENT.has(e.code)) e.preventDefault();
        // Répétition autorisée (effacer en maintenant Retour arrière), sauf pour valider, et seulement
        // d'une touche pressée dans le champ : celle qui a passé l'écran 討死, encore tenue, n'y tape rien.
        if (!e.repeat) this.textDown.add(e.code);
        else if (!this.textDown.has(e.code) || e.code === 'Enter' || e.code === 'NumpadEnter') return;
        // Raccourcis (Ctrl+V, ⌘+A…) : ne pas insérer la lettre. AltGr (Ctrl+Alt) reste permis.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.length === 1) return;
        this.textFn(e.key, e.code);
        return;
      }
      if (e.repeat) return;
      const b = KEYMAP[e.code];
      if (b) {
        this.held |= b;
        this.latched |= b;
      }
      this.handlers.get(e.code)?.();
      // Une touche de jeu ne déclenche jamais de raccourci (en Colemak, J produit « n »). Repli par
      // position si la touche produit une lettre sans raccourci : en Colemak, N produit « k », d'où N.
      // « , » (position M en AZERTY) n'est pas une lettre : pas de repli, la lettre M est ailleurs.
      if (!b) {
        const ch = shortcutChar(e.key, e.code);
        const at = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
        (this.charHandlers.get(ch) ?? (ch ? this.charHandlers.get(at) : undefined))?.();
      }
      this.anyKey?.();
    });
    window.addEventListener('keyup', (e) => {
      const b = KEYMAP[e.code];
      if (b) this.held &= ~b;
    });
    window.addEventListener('blur', () => {
      this.held = 0;
      this.mouse = 0;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('mousedown', (e) => {
      // Événement antérieur au reset() : c'est le clic qui l'a provoqué (Phaser l'a traité avant nous).
      if (this.textFn || e.timeStamp <= this.resetAt) return;
      const b = e.button === 0 ? BTN.ATTACK : e.button === 2 ? BTN.PARRY : e.button === 1 ? BTN.IAI : 0;
      this.mouse |= b;
      this.latched |= b;
    });
    window.addEventListener('mouseup', (e) => {
      const b = e.button === 0 ? BTN.ATTACK : e.button === 2 ? BTN.PARRY : e.button === 1 ? BTN.IAI : 0;
      this.mouse &= ~b;
    });
  }

  onKey(code: string, fn: () => void): void {
    this.handlers.set(code, fn);
  }

  /**
   * Raccourci mnémonique, par la lettre produite (insensible à la casse), hors touches de jeu ;
   * à défaut, par la position de la lettre (KeyN), si cette touche produit une lettre sans raccourci.
   */
  onChar(ch: string, fn: () => void): void {
    this.charHandlers.set(ch.toLowerCase(), fn);
  }

  /** Appelé à chaque touche pressée (hors répétition et hors saisie), après ses autres actions. */
  onAnyKey(fn: () => void): void {
    this.anyKey = fn;
  }

  /**
   * Active (callback) ou désactive (null) le mode saisie de texte.
   * Les états de boutons sont remis à zéro pour qu'aucune pression ne « fuie » vers le jeu ;
   * une touche déjà tenue ne se répète pas dans le champ (il faut la relâcher et la represser).
   */
  setTextMode(fn: TextFn | null): void {
    this.textFn = fn;
    this.textDown.clear();
    this.reset();
  }

  /** Oublie toutes les touches et clics en cours (changement d'écran, pause…) ; le clic suivant compte. */
  reset(): void {
    this.held = 0;
    this.latched = 0;
    this.mouse = 0;
    this.resetAt = performance.now();
    this.padPrev = padMenuBits();
  }

  /** Codes de menu (ArrowUp, Enter, Escape…) correspondant aux boutons de manette tout juste pressés. */
  padMenu(): string[] {
    const now = padMenuBits();
    const pressed = now & ~this.padPrev;
    this.padPrev = now;
    return PAD_MENU.filter((m) => pressed & m.bit).map((m) => m.code);
  }

  /** Bouton Select / View (8) d'une manette standard tenu (quitter la salle en ligne, en le maintenant). */
  padQuitHeld(): boolean {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) if (gp && gp.mapping === 'standard' && gp.buttons[8]?.pressed) return true;
    return false;
  }

  sample(): number {
    const b = this.held | this.mouse | this.latched | gamepadButtons();
    this.latched = 0;
    return b;
  }
}

function gamepadButtons(): number {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let b = 0;
  for (const gp of pads) {
    // Seules les manettes au mapping standard : joysticks de vol, pédaliers, etc.
    // exposent des boutons/axes arbitraires (souvent « enfoncés » au repos).
    if (!gp || gp.mapping !== 'standard') continue;
    const btn = (i: number) => !!gp.buttons[i]?.pressed;
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    if (ax < -0.35 || btn(14)) b |= BTN.LEFT;
    if (ax > 0.35 || btn(15)) b |= BTN.RIGHT;
    if (ay < -0.5 || btn(12)) b |= BTN.UP;
    if (ay > 0.5 || btn(13)) b |= BTN.DOWN;
    if (btn(0)) b |= BTN.JUMP;
    if (btn(2)) b |= BTN.ATTACK;
    if (btn(1) || btn(7)) b |= BTN.DASH;
    if (btn(3)) b |= BTN.IAI;
    if (btn(4) || btn(5) || btn(6)) b |= BTN.PARRY;
    if (btn(11)) b |= BTN.DUEL; // R3 (clic du stick droit) : défier, accepter, tenir pour abandonner
  }
  return b;
}

// ─── Navigation des menus à la manette ─────────────────────────────────────
const PAD_MENU = [
  { bit: 1, code: 'ArrowUp' },
  { bit: 2, code: 'ArrowDown' },
  { bit: 4, code: 'ArrowLeft' },
  { bit: 8, code: 'ArrowRight' },
  { bit: 16, code: 'Enter' }, // A
  { bit: 32, code: 'Escape' }, // B
];

function padMenuBits(): number {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let b = 0;
  for (const gp of pads) {
    if (!gp || gp.mapping !== 'standard') continue;
    const btn = (i: number) => !!gp.buttons[i]?.pressed;
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    if (ay < -0.5 || btn(12)) b |= 1;
    if (ay > 0.5 || btn(13)) b |= 2;
    if (ax < -0.5 || btn(14)) b |= 4;
    if (ax > 0.5 || btn(15)) b |= 8;
    if (btn(0) || btn(9)) b |= 16;
    if (btn(1) || btn(8)) b |= 32;
  }
  return b;
}
