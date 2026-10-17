// Musique procédurale et adaptative, gamme In (Miyako-bushi), sans aucun fichier audio.
// Un séquenceur à anticipation (lookahead) planifie des doubles-croches ; chaque
// ambiance active des pistes différentes, avec des fondus calés sur les mesures.
//
//  calm : koto en arpèges, nappe, claves ; shakuhachi et shinobue en question-réponse
//  tide : + taiko, ostinato de shamisen, basse, mélodie vive de shinobue
//  boss : taiko martelé et roulements, kane, shamisen agressif, shinobue perçant, cris de shakuhachi
//  rest : koto lent, nappe et quelques phrases de shinobue (bilan)

import { type MelodyNote, type Ornament, PHRASE_STEPS, phraseFor } from './melody';

export type Mood = 'calm' | 'tide' | 'boss' | 'rest';
type Track = 'pad' | 'koto' | 'flute' | 'shinobue' | 'drums' | 'shamisen' | 'bass';

const IN_SCALE = [0, 1, 5, 7, 8]; // ré, mi♭, sol, la, si♭
const ROOT_MIDI = 50; // ré 3
const PROG = [0, 0, -1, -2]; // ré, ré, si♭, la (en degrés de la gamme), 2 mesures chacun

const MOODS: Record<Mood, { bpm: number; mix: Record<Track, number> }> = {
  calm: { bpm: 112, mix: { pad: 0.55, koto: 0.7, flute: 0.7, shinobue: 0.6, drums: 0.3, shamisen: 0, bass: 0 } },
  tide: { bpm: 132, mix: { pad: 0.35, koto: 0.3, flute: 0.25, shinobue: 0.75, drums: 1, shamisen: 0.7, bass: 0.8 } },
  boss: { bpm: 144, mix: { pad: 0.3, koto: 0.2, flute: 0.5, shinobue: 0.7, drums: 1.15, shamisen: 0.9, bass: 1 } },
  rest: { bpm: 96, mix: { pad: 0.65, koto: 0.8, flute: 0.35, shinobue: 0.45, drums: 0, shamisen: 0, bass: 0 } },
};

// Motifs (degrés relatifs à l'accord, null = silence), 16 doubles-croches par mesure.
const _ = null;
const SHAMISEN: Record<'tide' | 'boss', (number | null)[][]> = {
  tide: [
    [0, _, 0, 1, 3, _, 2, _, 0, _, 0, 1, 4, 3, 2, 1],
    [0, _, 0, 1, 3, _, 5, _, 4, _, 3, _, 2, 1, 0, _],
  ],
  boss: [
    [0, 0, 5, 0, 4, 0, 3, 0, 0, 0, 5, 0, 6, 5, 4, 3],
    [0, 0, 5, 0, 4, 0, 3, 0, 2, 3, 4, 5, 7, 6, 5, 4],
  ],
};
const KOTO_ARPS = [
  [0, 2, 3, 5, 3, 2, 4, 2],
  [0, 3, 5, 7, 5, 3, 2, 3],
  [5, 3, 2, 0, 2, 3, 5, 6],
  [0, 2, 5, 3, 7, 5, 3, 2],
];
const DRUMS: Record<'tide' | 'boss', { odaiko: string; shime: string; kane: string }> = {
  tide: { odaiko: 'x.......x.x.....', shime: 'x.xx.x.xx.xx.x.x', kane: '................' },
  boss: { odaiko: 'x...x...x...x.x.', shime: 'xxx.xx.xxxx.xx.x', kane: '....x.......x...' },
};

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
function degreeMidi(deg: number, octave = 0): number {
  const o = Math.floor(deg / 5);
  const i = ((deg % 5) + 5) % 5;
  return ROOT_MIDI + 12 * (o + octave) + IN_SCALE[i];
}

/** PRNG déterministe : les variations se répètent d'un cycle à l'autre (on mémorise des phrases). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Music {
  private out: GainNode;
  private tracks = {} as Record<Track, GainNode>;
  private reverb: ConvolverNode;
  private noise: AudioBuffer;
  private plucks = new Map<string, { buf: AudioBuffer; rate: number }>();
  private flueCurve: Float32Array<ArrayBuffer>; // courbe de saturation douce : harmoniques du shinobue
  private padOscs: OscillatorNode[] = [];
  private padLfo: OscillatorNode | null = null;
  private timer = 0;
  private step = 0;
  private bar = 0;
  private nextTime = 0;
  private mood: Mood = 'calm';
  private wanted: Mood = 'calm';
  private enabled = true;
  private ducked = false;
  private readonly volume = 0.42;

  /** `enabled` : faux si la musique a été coupée (N) avant le déblocage de l'audio. */
  constructor(private ctx: AudioContext, dest: AudioNode, enabled = true) {
    this.enabled = enabled;
    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;
    this.out.connect(dest);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    this.reverb.connect(wet);
    wet.connect(this.out);

    const pans: Record<Track, number> = { pad: 0, koto: -0.3, flute: 0.15, shinobue: -0.12, drums: 0, shamisen: 0.3, bass: 0 };
    const sends: Record<Track, number> = { pad: 0.6, koto: 0.5, flute: 0.7, shinobue: 0.5, drums: 0.15, shamisen: 0.25, bass: 0 };
    for (const t of Object.keys(pans) as Track[]) {
      const g = ctx.createGain();
      g.gain.value = MOODS.calm.mix[t];
      const p = ctx.createStereoPanner();
      p.pan.value = pans[t];
      if (t === 'shinobue') {
        // Passe-haut : supprime la composante continue créée par la saturation.
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 160;
        g.connect(hp);
        hp.connect(p);
      } else g.connect(p);
      p.connect(this.out);
      const send = ctx.createGain();
      send.gain.value = sends[t];
      p.connect(send);
      send.connect(this.reverb);
      this.tracks[t] = g;
    }

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Polynômes de Tchebychev : un sinus devient fondamentale + 2e et 3e harmoniques,
    // qui suivent automatiquement les glissés et les trilles.
    const n = 1024;
    this.flueCurve = new Float32Array(new ArrayBuffer(n * 4));
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      // Courbe nulle en 0 (pas de tension continue au repos) ; le léger décalage qu'ajoute
      // le terme pair pendant une note est retiré par le passe-haut de la piste.
      this.flueCurve[i] = (x + 0.44 * x * x + 0.08 * (4 * x * x * x - 3 * x)) / 1.3;
    }

    this.startPad();
    this.nextTime = ctx.currentTime + 0.15;
    if (this.enabled) this.out.gain.setTargetAtTime(this.volume, ctx.currentTime, 1.2); // fondu d'entrée
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  setMood(m: Mood): void {
    this.wanted = m;
  }

  /** Baisse la musique (mort du joueur). */
  duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.applyVolume();
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.applyVolume();
    return this.enabled;
  }

  dispose(): void {
    window.clearInterval(this.timer);
    for (const o of this.padOscs) o.stop();
    this.padLfo?.stop();
  }

  private applyVolume(): void {
    const v = !this.enabled ? 0.0001 : this.ducked ? this.volume * 0.35 : this.volume;
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.4);
  }

  // ─── Séquenceur ──────────────────────────────────────────────────────────

  private schedule(): void {
    const ctx = this.ctx;
    if (this.nextTime < ctx.currentTime - 0.5) this.nextTime = ctx.currentTime + 0.05; // onglet en veille
    while (this.nextTime < ctx.currentTime + 0.2) {
      const s = this.step % 16;
      if (s === 0) this.onBar(this.nextTime);
      this.playStep(s, this.nextTime);
      this.nextTime += 60 / MOODS[this.mood].bpm / 4;
      this.step++;
    }
  }

  private onBar(t: number): void {
    this.bar++;
    if (this.wanted !== this.mood) {
      this.mood = this.wanted;
      const mix = MOODS[this.mood].mix;
      for (const k of Object.keys(mix) as Track[]) this.tracks[k].gain.setTargetAtTime(mix[k], t, 0.6);
      if (this.mood === 'tide' || this.mood === 'boss') this.odaiko(t, 1.1); // coup d'ouverture
    }
    // La nappe suit la progression d'accords toutes les deux mesures.
    if (this.bar % 2 === 0) {
      const root = this.chordDeg();
      const notes = [degreeMidi(root, -1), degreeMidi(root + 3, -1), degreeMidi(root, 0)];
      this.padOscs.forEach((o, i) => o.frequency.setTargetAtTime(midiToHz(notes[i % 3]) * (i >= 3 ? 1.004 : 1), t, 0.3));
    }
  }

  private chordDeg(): number {
    return PROG[Math.floor(this.bar / 2) % PROG.length];
  }

  private playStep(s: number, t: number): void {
    const m = this.mood;
    const mix = MOODS[m].mix;
    const chord = this.chordDeg();
    const phrase = Math.floor(this.bar / 2) % 4;
    const r = rng(this.bar * 97 + s * 13 + phrase * 7);

    // Koto : arpèges sur les croches (plus clairsemés au calme)
    if (mix.koto > 0 && s % 2 === 0) {
      const arp = KOTO_ARPS[(phrase + (m === 'rest' ? 2 : 0)) % KOTO_ARPS.length];
      const density = m === 'rest' ? 0.45 : m === 'calm' ? 0.8 : 0.55;
      if (s === 0 || r() < density) this.pluck('koto', degreeMidi(chord + arp[s / 2], 1), t, s === 0 ? 0.95 : 0.6);
    }

    // Shamisen : ostinato en doubles-croches
    if ((m === 'tide' || m === 'boss') && mix.shamisen > 0) {
      const motif = SHAMISEN[m][this.bar % 2];
      const deg = motif[s];
      if (deg !== null) this.pluck('shamisen', degreeMidi(chord + deg, 1), t, s % 4 === 0 ? 0.55 : 0.36);
    }

    // Basse
    if (mix.bass > 0) {
      const hits = m === 'boss' ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
      // Racine grave, saut d'octave et quinte en fin de mesure pour relancer le groove.
      if (hits.includes(s)) {
        const deg = s === 14 ? chord + 3 : chord;
        const oct = m === 'boss' && s === 8 ? 0 : -1;
        this.bass(midiToHz(degreeMidi(deg, oct)), t, s === 0 ? 0.5 : 0.35);
      }
    }

    // Percussions
    if (m === 'tide' || m === 'boss') {
      const pat = DRUMS[m];
      const fill = this.bar % 4 === 3 && s >= 12;
      if (fill || pat.odaiko[s] === 'x') this.odaiko(t, fill ? 0.55 + (s - 12) * 0.12 : s === 0 ? 1 : 0.7);
      if (pat.shime[s] === 'x') this.shime(t, s % 4 === 0 ? 0.5 : 0.3);
      if (pat.kane[s] === 'x') this.kane(t);
    } else if (m === 'calm') {
      if (s === 0 && this.bar % 2 === 0) this.hyoshigi(t);
      if (s === 8 && this.bar % 4 === 2) this.hyoshigi(t);
      if (s === 0 && this.bar % 4 === 0) this.odaiko(t, 0.35);
    }

    // Shinobue : la mélodie principale, phrase par phrase (planifiée mesure par mesure)
    if (mix.shinobue > 0 && s === 0) this.shinobueBar(t, chord);

    // Shakuhachi : longues phrases au calme (en alternance avec le shinobue), cris contre le gardien
    const section = Math.floor(this.bar / 8);
    if (mix.flute > 0 && s === 0) {
      if ((m === 'calm' || m === 'rest') && this.bar % 4 === 1 && section % 2 === 0) this.flutePhrase(t, chord, phrase);
      if (m === 'boss' && this.bar % 4 === 0) this.fluteNote(midiToHz(degreeMidi(chord + 7, 1)), t, this.stepDur() * 10, 0.16, true);
      if (m === 'tide' && this.bar % 8 === 4) this.fluteNote(midiToHz(degreeMidi(chord + 5, 1)), t, this.stepDur() * 12, 0.12, true);
    }
  }

  /** Le shinobue joue-t-il dans cette section ? (question-réponse avec le shakuhachi au calme) */
  private shinobueActive(section: number, slot: number): boolean {
    switch (this.mood) {
      case 'calm':
        return section % 2 === 1;
      case 'rest':
        return slot === 0 || slot === 3;
      default:
        return true;
    }
  }

  /** Planifie la moitié de phrase qui tombe dans la mesure qui commence à `t`. */
  private shinobueBar(t: number, chord: number): void {
    const section = Math.floor(this.bar / 8);
    const slot = Math.floor((this.bar % 8) / 2);
    if (!this.shinobueActive(section, slot)) return;
    const half = this.bar % 2;
    const sd = this.stepDur();
    const gain = this.mood === 'tide' ? 0.16 : this.mood === 'boss' ? 0.17 : this.mood === 'rest' ? 0.15 : 0.18;
    const notes: MelodyNote[] = phraseFor(section, slot, this.mood, chord);
    for (const nt of notes) {
      const local = nt.start - half * (PHRASE_STEPS / 2);
      if (local < 0 || local >= PHRASE_STEPS / 2) continue;
      const upper = midiToHz(degreeMidi(nt.deg + 1, 1));
      this.shinobueNote(midiToHz(degreeMidi(nt.deg, 1)), upper, t + local * sd, nt.len * sd * 0.92, gain, nt.orn);
    }
  }

  private stepDur(): number {
    return 60 / MOODS[this.mood].bpm / 4;
  }

  private flutePhrase(t: number, chord: number, phrase: number): void {
    const r = rng(phrase * 31 + 5);
    let at = t;
    const sd = this.stepDur();
    const durs = [6, 4, 6, 12];
    let deg = chord + 5 + Math.floor(r() * 3);
    for (const d of durs) {
      this.fluteNote(midiToHz(degreeMidi(deg, 1)), at, sd * d, 0.13, d >= 12);
      at += sd * d;
      deg += r() < 0.5 ? -1 : r() < 0.6 ? 1 : -2;
    }
  }

  // ─── Instruments ─────────────────────────────────────────────────────────

  /** Corde pincée Karplus-Strong (koto : doux et long ; shamisen : brillant et sec). */
  private pluck(kind: 'koto' | 'shamisen', midi: number, t: number, gain: number): void {
    const key = `${kind}:${midi}`;
    let p = this.plucks.get(key);
    if (!p) {
      p = this.karplus(midiToHz(midi), kind === 'koto' ? 2.2 : 0.7, kind === 'koto' ? 0.996 : 0.985, kind === 'koto' ? 0.6 : 1);
      this.plucks.set(key, p);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = p.buf;
    src.playbackRate.value = p.rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    if (kind === 'shamisen') {
      // « Sawari » : un léger bourdonnement dans les aigus
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'peaking';
      hp.frequency.value = 2400;
      hp.gain.value = 6;
      g.connect(hp);
      hp.connect(this.tracks.shamisen);
    } else g.connect(this.tracks.koto);
    src.start(t);
  }

  private karplus(freq: number, dur: number, damp: number, bright: number): { buf: AudioBuffer; rate: number } {
    const sr = this.ctx.sampleRate;
    const period = Math.max(2, Math.round(sr / freq));
    const n = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const ring = new Float32Array(period);
    let prev = 0;
    for (let i = 0; i < period; i++) {
      const x = Math.random() * 2 - 1;
      prev = prev + (x - prev) * bright; // excitation filtrée = attaque plus ou moins brillante
      ring[i] = prev;
    }
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const cur = ring[idx];
      const nxt = ring[(idx + 1) % period];
      ring[idx] = damp * 0.5 * (cur + nxt);
      d[i] = cur * Math.min(1, (n - i) / (sr * 0.05)); // court fondu de fin
      idx = (idx + 1) % period;
    }
    return { buf, rate: (freq * period) / sr }; // corrige l'arrondi de la période
  }

  /** Shakuhachi : sinus + souffle, glissé « meri » à l'attaque, vibrato qui s'élargit. */
  private fluteNote(freq: number, t: number, dur: number, gain: number, bend: boolean): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * (bend ? 0.94 : 0.985), t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.18);
    if (bend && dur > 0.8) o.frequency.setTargetAtTime(freq * 0.97, t + dur * 0.8, 0.08);
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq * 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(freq * 0.008, t + dur * 0.7);
    lfo.connect(lfoG);
    lfoG.connect(o.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.12);
    env.gain.setValueAtTime(gain, t + Math.max(0.13, dur - 0.25));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const h = ctx.createGain();
    h.gain.value = 0.07;
    o.connect(env);
    o2.connect(h);
    h.connect(env);
    env.connect(this.tracks.flute);
    // Souffle
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * 2;
    bp.Q.value = 1.5;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(gain * 0.35, t + 0.05);
    ng.gain.exponentialRampToValueAtTime(gain * 0.08, t + 0.3);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(this.tracks.flute);
    for (const s of [o, o2, lfo, n]) {
      s.start(t);
      s.stop(t + dur + 0.05);
    }
  }

  /**
   * Shinobue : sinus saturé (harmoniques), attaque soufflée « chiff », vibrato tardif,
   * et ornements : appoggiature (grace), trille, glissé montant (slide), chute finale (fall).
   */
  private shinobueNote(freq: number, upper: number, t: number, dur: number, gain: number, orn: Ornament): void {
    const ctx = this.ctx;
    const t0 = Math.max(ctx.currentTime, t);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = o.frequency;
    if (orn === 'grace') {
      f.setValueAtTime(upper, t0);
      f.setValueAtTime(freq, t0 + 0.05);
    } else if (orn === 'slide') {
      f.setValueAtTime(freq * 0.89, t0);
      f.exponentialRampToValueAtTime(freq, t0 + 0.14);
    } else f.setValueAtTime(freq, t0);
    if (orn === 'trill' && dur > 0.35) {
      // Trille vers la note supérieure, entre 30 % et 85 % de la durée.
      for (let k = 0, at = t0 + dur * 0.3; at < t0 + dur * 0.85; k++, at += 1 / 11) f.setValueAtTime(k % 2 ? freq : upper, at);
      f.setValueAtTime(freq, t0 + dur * 0.85);
    }
    if (orn === 'fall' && dur > 0.3) {
      f.setValueAtTime(freq, t0 + dur * 0.7);
      f.exponentialRampToValueAtTime(freq * 0.84, t0 + dur);
    }
    // Vibrato qui n'arrive qu'après l'attaque (jeu traditionnel)
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.2;
    const lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t0);
    lfoG.gain.setValueAtTime(0, t0 + Math.min(0.25, dur * 0.4));
    lfoG.gain.linearRampToValueAtTime(freq * 0.007, t0 + Math.max(0.3, dur * 0.8));
    lfo.connect(lfoG);
    lfoG.connect(f);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.flueCurve;
    shaper.oversample = '2x';
    // Enveloppe : événements toujours dans l'ordre chronologique, même pour une double-croche.
    const atk = Math.min(0.03, dur * 0.3);
    const rel = Math.min(0.08, dur * 0.4);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + atk);
    if (dur > atk + 0.09 + rel) {
      env.gain.exponentialRampToValueAtTime(gain * 0.8, t0 + atk + 0.09);
      env.gain.setValueAtTime(gain * 0.8, t0 + dur - rel);
    } else env.gain.setValueAtTime(gain, t0 + dur - rel);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(shaper);
    shaper.connect(env);
    env.connect(this.tracks.shinobue);
    // Souffle : bouffée à l'attaque, puis un filet d'air
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(9000, freq * 1.6);
    bp.Q.value = 1.2;
    const chiff = Math.min(0.015, dur * 0.15);
    const settle = Math.min(0.09, dur * 0.5);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.exponentialRampToValueAtTime(gain * 0.55, t0 + chiff);
    ng.gain.exponentialRampToValueAtTime(gain * 0.06, t0 + settle);
    ng.gain.setValueAtTime(gain * 0.06, t0 + Math.max(settle, dur - 0.06));
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(this.tracks.shinobue);
    o.start(t0);
    lfo.start(t0);
    n.start(t0, Math.random() * 0.5);
    for (const src of [o, lfo, n]) src.stop(t0 + dur + 0.05);
    // Libère le graphe de la note une fois jouée (la saturation n'est plus alimentée).
    o.onended = () => {
      for (const node of [o, lfo, lfoG, shaper, env, n, bp, ng]) node.disconnect();
    };
  }

  private bass(freq: number, t: number, gain: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(f);
    f.connect(g);
    g.connect(this.tracks.bass);
    o.start(t);
    o.stop(t + 0.35);
  }

  private odaiko(t: number, gain: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(92, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g);
    g.connect(this.tracks.drums);
    o.start(t);
    o.stop(t + 0.6);
    this.noiseHit(t, 'lowpass', 500, 0.08, 0.5 * gain);
  }

  private shime(t: number, gain: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(430, t);
    o.frequency.exponentialRampToValueAtTime(260, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g);
    g.connect(this.tracks.drums);
    o.start(t);
    o.stop(t + 0.12);
    this.noiseHit(t, 'highpass', 2500, 0.025, gain * 0.5);
  }

  private kane(t: number): void {
    for (const [f, a] of [[1730, 0.07], [2690, 0.05], [4110, 0.025]]) {
      const o = this.ctx.createOscillator();
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g);
      g.connect(this.tracks.drums);
      o.start(t);
      o.stop(t + 0.3);
    }
  }

  private hyoshigi(t: number): void {
    this.noiseHit(t, 'bandpass', 2600, 0.03, 0.35);
    const o = this.ctx.createOscillator();
    o.frequency.value = 1850;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(this.tracks.drums);
    o.start(t);
    o.stop(t + 0.06);
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, dur: number, gain: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.tracks.drums);
    src.start(t, Math.random() * 0.5, dur + 0.02);
  }

  /** Nappe continue : quintes graves légèrement désaccordées, filtrées. */
  private startPad(): void {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    f.connect(g);
    g.connect(this.tracks.pad);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 250;
    lfo.connect(lfoG);
    lfoG.connect(f.frequency);
    lfo.start();
    const notes = [degreeMidi(0, -1), degreeMidi(3, -1), degreeMidi(0, 0)];
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = midiToHz(notes[i % 3]) * (i >= 3 ? 1.004 : 1);
      o.connect(f);
      o.start();
      this.padOscs.push(o);
    }
    this.padLfo = lfo;
  }

  private impulse(seconds: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    }
    return buf;
  }
}
