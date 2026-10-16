import { BTN } from '../../shared/input';

// On lit `event.code` (position physique de la touche) : ZQSD sur AZERTY et
// WASD sur QWERTY tombent donc sur les mêmes boutons, sans configuration.
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
};

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'F3', 'F4', 'F7', 'Escape', 'Backspace', 'Tab']);

// Touches dont le comportement navigateur gênerait la saisie d'un nom (retour arrière, défilement, focus).
const TEXT_PREVENT = new Set(['Backspace', 'Space', 'Enter', 'NumpadEnter', 'Tab']);

type TextFn = (key: string, code: string) => void;

export class Controls {
  private held = 0;
  private latched = 0; // pressions brèves survenues entre deux ticks
  private mouse = 0;
  private handlers = new Map<string, () => void>();
  private textFn: TextFn | null = null; // mode saisie : toutes les touches vont au champ texte
  private muteMouse = false; // après reset() : le clic en cours (ex. « Hard ») ne doit pas devenir une attaque
  private padPrev = 0; // boutons de menu de la manette au tick précédent (fronts montants)

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (this.textFn) {
        // En saisie, ni boutons de jeu ni raccourcis (H, M, N…) : la touche n'appartient qu'au champ.
        if (TEXT_PREVENT.has(e.code)) e.preventDefault();
        // Répétition autorisée (effacer en maintenant Retour arrière), sauf pour valider.
        if (e.repeat && (e.code === 'Enter' || e.code === 'NumpadEnter')) return;
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
      if (this.textFn || this.muteMouse) return;
      const b = e.button === 0 ? BTN.ATTACK : e.button === 2 ? BTN.PARRY : e.button === 1 ? BTN.IAI : 0;
      this.mouse |= b;
      this.latched |= b;
    });
    window.addEventListener('mouseup', (e) => {
      this.muteMouse = false;
      const b = e.button === 0 ? BTN.ATTACK : e.button === 2 ? BTN.PARRY : e.button === 1 ? BTN.IAI : 0;
      this.mouse &= ~b;
    });
  }

  onKey(code: string, fn: () => void): void {
    this.handlers.set(code, fn);
  }

  /**
   * Active (callback) ou désactive (null) le mode saisie de texte.
   * Les états de boutons sont remis à zéro pour qu'aucune pression ne « fuie » vers le jeu.
   */
  setTextMode(fn: TextFn | null): void {
    this.textFn = fn;
    this.reset();
  }

  /** Oublie toutes les touches et clics en cours (changement d'écran, pause…). */
  reset(): void {
    this.held = 0;
    this.latched = 0;
    this.mouse = 0;
    this.muteMouse = true;
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
