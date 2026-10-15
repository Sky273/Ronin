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

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'F3', 'F4']);

export class Controls {
  private held = 0;
  private latched = 0; // pressions brèves survenues entre deux ticks
  private mouse = 0;
  private handlers = new Map<string, () => void>();

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
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
