// Effets sonores synthétisés en WebAudio (aucun fichier audio requis).
// Placeholders soignés : à remplacer en phase 4 par de vrais enregistrements.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private muted = false;
  private readonly volume = 0.55;

  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const comp = this.ctx.createDynamicsCompressor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.wind();
  }

  /** Contexte et bus maître partagés avec la musique (le mute coupe tout). */
  get output(): { ctx: AudioContext; dest: AudioNode } | null {
    return this.ctx ? { ctx: this.ctx, dest: this.master } : null;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  private env(t: number, attack: number, peak: number, decay: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.master);
    return g;
  }

  private tone(type: OscillatorType, f0: number, f1: number, delay: number, dur: number, peak: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    o.connect(this.env(t, 0.005, peak, dur));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private whoosh(delay: number, dur: number, f0: number, f1: number, q: number, peak: number, kind: BiquadFilterType = 'bandpass'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = kind;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    src.connect(f);
    f.connect(this.env(t, dur * 0.25, peak, dur * 0.75));
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  swing(heavy: boolean): void {
    this.whoosh(0, heavy ? 0.22 : 0.13, 700, heavy ? 2600 : 3800, 1.3, heavy ? 0.55 : 0.38);
  }
  hit(heavy: boolean): void {
    this.tone('sine', 150, 45, 0, heavy ? 0.22 : 0.14, heavy ? 0.8 : 0.5);
    this.whoosh(0, 0.07, 1800, 600, 0.7, heavy ? 0.5 : 0.35, 'lowpass');
  }
  slice(): void {
    this.whoosh(0, 0.2, 3000, 7000, 2.5, 0.28);
    this.tone('triangle', 1900, 1300, 0, 0.12, 0.07);
  }
  parry(): void {
    [1240, 1890, 2710, 3640].forEach((f, i) => this.tone('sine', f, f * 0.996, 0, 0.9 - i * 0.15, 0.22 / (i + 1)));
    this.whoosh(0, 0.04, 5000, 3000, 1, 0.4, 'highpass');
  }
  deflect(): void {
    [1600, 2450].forEach((f, i) => this.tone('sine', f, f, 0, 0.4, 0.1 / (i + 1)));
  }
  iai(full: boolean): void {
    this.whoosh(0, 0.32, 400, 6000, 1.1, full ? 0.75 : 0.55);
    this.tone('sine', 2400, 2360, 0.04, full ? 1.6 : 1.0, 0.12);
    this.tone('sine', 75, 38, 0, 0.5, full ? 0.75 : 0.5);
  }
  iaiCharge(): void {
    this.whoosh(0, 0.05, 4000, 2500, 2, 0.15, 'highpass');
    this.tone('triangle', 520, 880, 0, 0.08, 0.05);
  }
  iaiReady(): void {
    this.tone('sine', 3100, 3100, 0, 0.6, 0.07);
    this.tone('sine', 4650, 4650, 0.02, 0.4, 0.03);
  }
  jump(double: boolean): void {
    this.whoosh(0, double ? 0.16 : 0.08, 300, double ? 1500 : 900, 0.8, double ? 0.2 : 0.12);
  }
  land(heavy: boolean): void {
    this.tone('sine', 95, 40, 0, heavy ? 0.28 : 0.1, heavy ? 0.6 : 0.2);
  }
  dash(): void {
    this.whoosh(0, 0.18, 2200, 300, 0.9, 0.38);
  }
  hurt(): void {
    this.tone('sawtooth', 220, 80, 0, 0.22, 0.12);
    this.tone('sine', 120, 50, 0, 0.18, 0.5);
  }
  death(): void {
    [98, 196.6, 293.1, 415.3].forEach((f, i) => this.tone('sine', f, f * 0.99, 0, 2.6 - i * 0.4, 0.3 / (i + 1)));
  }
  tick(): void {
    this.tone('square', 1500, 1500, 0, 0.025, 0.03);
  }
  bow(): void {
    this.tone('triangle', 260, 170, 0, 0.16, 0.18);
    this.whoosh(0, 0.12, 2000, 3200, 2, 0.1);
  }
  spawn(): void {
    this.whoosh(0, 0.45, 200, 700, 0.6, 0.1);
  }

  block(): void {
    [880, 1320, 2050].forEach((f, i) => this.tone('square', f, f * 0.98, 0, 0.18 - i * 0.04, 0.05));
    this.tone('sine', 160, 70, 0, 0.12, 0.4);
  }
  guardBreak(): void {
    this.whoosh(0, 0.25, 1500, 300, 0.8, 0.6, 'lowpass');
    this.tone('sawtooth', 300, 60, 0, 0.3, 0.2);
  }
  /** Carillon pentatonique qui monte avec la série de ramassages. */
  orb(step: number, lost: boolean): void {
    const scale = [0, 2, 4, 7, 9];
    const n = step % 15;
    const f = 660 * Math.pow(2, (scale[n % 5] + 12 * Math.floor(n / 5)) / 12);
    this.tone('sine', f, f, 0, lost ? 0.35 : 0.18, lost ? 0.07 : 0.045);
  }
  levelUp(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone('sine', f, f, i * 0.07, 0.6, 0.09));
  }
  pick(): void {
    this.tone('sine', 1568, 1568, 0, 0.9, 0.08);
    this.tone('sine', 2350, 2350, 0.02, 0.6, 0.04);
  }
  bell(): void {
    [392, 784.6, 1176].forEach((f, i) => this.tone('sine', f, f * 0.998, 0, 2 - i * 0.5, 0.12 / (i + 1)));
  }
  drum(delay = 0, big = false): void {
    this.tone('sine', big ? 85 : 110, 42, delay, big ? 0.5 : 0.3, big ? 0.9 : 0.6);
    this.whoosh(delay, 0.08, 900, 200, 0.7, big ? 0.35 : 0.2, 'lowpass');
  }
  /** Taiko : roulement d'annonce de la Marée. */
  taiko(boss: boolean): void {
    const pattern = boss ? [0, 0.5, 1, 1.25, 1.5, 1.75, 2] : [0, 0.45, 0.9, 1.15, 1.4];
    pattern.forEach((t, i) => this.drum(t, i === pattern.length - 1 || i === 0));
  }
  gong(): void {
    [110, 164.8, 220.4, 331].forEach((f, i) => this.tone('sine', f, f * 0.995, 0, 3 - i * 0.5, 0.18 / (i + 1)));
  }
  horn(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(98, t);
    o.frequency.linearRampToValueAtTime(110, t + 0.3);
    o.frequency.linearRampToValueAtTime(104, t + 1.3);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    o.connect(f);
    f.connect(this.env(t, 0.15, 0.3, 1.2));
    o.start(t);
    o.stop(t + 1.5);
  }
  roar(): void {
    this.whoosh(0, 0.9, 300, 120, 0.6, 0.8, 'lowpass');
    this.tone('sawtooth', 90, 55, 0, 0.9, 0.2);
  }
  slam(big: boolean): void {
    this.tone('sine', big ? 70 : 110, 30, 0, big ? 0.6 : 0.3, big ? 1 : 0.6);
    this.whoosh(0, big ? 0.4 : 0.2, 800, 100, 0.6, big ? 0.6 : 0.35, 'lowpass');
  }
  smoke(): void {
    this.whoosh(0, 0.25, 2500, 600, 0.5, 0.18);
  }
  shuriken(): void {
    this.whoosh(0, 0.12, 4000, 6000, 4, 0.12);
  }
  /** Signal 斬 d'un duel : claquement sec de hyōshigi et souffle bref (plus discret en spectateur). */
  zan(soft = false): void {
    const k = soft ? 0.35 : 1;
    this.tone('square', 2100, 1900, 0, 0.035, 0.12 * k);
    this.tone('sine', 880, 860, 0, 0.12, 0.25 * k);
    this.whoosh(0, 0.09, 6000, 2500, 1.5, 0.3 * k, 'highpass');
  }
  /** Défi reçu : deux notes graves de koto. */
  duelInvite(): void {
    this.tone('triangle', 392, 388, 0, 0.35, 0.12);
    this.tone('triangle', 294, 292, 0.14, 0.5, 0.12);
  }

  /** Vent d'ambiance très discret. */
  private wind(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start();
    lfo.start();
  }
}
