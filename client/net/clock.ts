// Horloge serveur estimée : tick serveur (fractionnaire) à un instant local donné (ms),
// et délai d'interpolation adapté à la gigue mesurée. Aucune horloge en dur : l'heure est
// toujours passée en argument (horloge injectée par l'appelant).
import { clamp } from '../../shared/math';
import { INTERP_MAX_TICKS, INTERP_MIN_TICKS, INTERP_TICKS, NET_TICK, SNAP_EVERY } from '../../shared/net/protocol';

/** Ticks par milliseconde locale. */
const TICKS_PER_MS = NET_TICK / 1000;
/** Fenêtre glissante des mesures (ms) : maximum du décalage et percentile de la gigue. */
const WINDOW_MS = 2000;
/** Ajustement de vitesse maximal de l'horloge estimée près de la cible (±5 %). */
const MAX_SKEW = 0.05;
/** Gain du recalage : vitesse corrigée de GAIN par tick d'écart (saturée à MAX_SKEW). */
const SKEW_GAIN = 0.05;
/**
 * En avance de plus de SLOW_FROM ticks sur la cible : ralentissement fort, de SLOW_GAIN par tick
 * d'écart en plus, jusqu'à l'arrêt (jamais de recul). Le rendu dépasserait sinon les instantanés reçus.
 */
const SLOW_FROM = 1;
const SLOW_GAIN = 0.25;
/** Écart (ticks) au-delà duquel l'horloge se recale d'un coup (onglet en arrière-plan, etc.). */
const SNAP_TICKS = 30;
/**
 * Recul de la chronologie du serveur (pas perdus après un gel, latence en hausse) : les SHIFT_SAMPLES
 * dernières mesures, reçues sur au moins SHIFT_SPAN_MS (pas une rafale), sont toutes en retard de plus
 * que ce que le délai absorbe.
 */
const SHIFT_SAMPLES = 4;
const SHIFT_SPAN_MS = 100;
/**
 * Durée (ms) pendant laquelle un recul supposé reste dû : un pic de latence de quelques secondes est
 * repris d'un coup à son retour. Au-delà, le recul est tenu pour acquis (gel du serveur : pas perdus),
 * et une baisse de latence ultérieure est rattrapée en douceur, pas par un saut.
 */
const OWED_MS = 10000;
/** Vitesse d'évolution du délai d'interpolation (ticks par seconde) : vite à la hausse, lentement à la baisse. */
const DELAY_UP_PER_S = 1;
const DELAY_DOWN_PER_S = 0.25;
/** Marge ajoutée au délai (ticks). */
const DELAY_MARGIN = 1;

interface Sample {
  at: number; // heure locale de réception (ms)
  offset: number; // tick serveur − heure locale en ticks
}

export class ServerClock {
  private samples: Sample[] = [];
  /** Décalage cible : maximum glissant (le message le moins retardé). NaN tant qu'aucune mesure. */
  private target = NaN;
  /** Dernier tick rendu par tickAt et l'heure correspondante. */
  private tick = 0;
  private tickNow = NaN;
  /** Estimation sans plafond : en avance sur `tick` tant que le plafond de tickAt retient l'horloge. */
  private est = 0;
  /** Recul de chronologie supposé (ticks) : repris d'un coup s'il est démenti avant `owedUntil` (pic passager, arriéré d'une coupure). */
  private owed = 0;
  private owedUntil = -Infinity;
  private delay: number = INTERP_TICKS;
  private delayTarget: number = INTERP_TICKS;
  private lastObsAt = NaN;
  /** Gigue mesurée (p95 du retard relatif, ticks). */
  jitterTicks = 0;

  /** Un instantané du tick `snapT` est arrivé à l'heure locale `recvAt` (ms). */
  observe(snapT: number, recvAt: number): void {
    const offset = snapT - recvAt * TICKS_PER_MS;
    this.samples.push({ at: recvAt, offset });
    const from = recvAt - WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].at < from) this.samples.shift();

    let max = -Infinity;
    for (const s of this.samples) if (s.offset > max) max = s.offset;
    // Chronologie du serveur en recul : l'ancien maximum n'est pas retenu toute la fenêtre, seules les
    // dernières mesures comptent ; le retard pris sous le plafond n'est plus dû (le serveur l'a perdu).
    const n = this.samples.length;
    if (n > SHIFT_SAMPLES && recvAt - this.samples[n - SHIFT_SAMPLES].at >= SHIFT_SPAN_MS) {
      const slack = this.delay - SNAP_EVERY;
      let late = true;
      for (let i = n - SHIFT_SAMPLES; i < n && late; i++) late = max - this.samples[i].offset > slack;
      if (late) {
        const before = max;
        this.samples.splice(0, n - SHIFT_SAMPLES);
        max = -Infinity;
        for (const s of this.samples) if (s.offset > max) max = s.offset;
        this.est = this.tick;
        this.owed = (recvAt < this.owedUntil ? this.owed : 0) + before - max;
        this.owedUntil = recvAt + OWED_MS;
      }
    }
    this.target = max;

    // Gigue : p95 du retard relatif au message le moins retardé de la fenêtre.
    const rel = this.samples.map((s) => max - s.offset).sort((a, b) => a - b);
    this.jitterTicks = rel[Math.min(rel.length - 1, Math.floor(0.95 * rel.length))];
    this.delayTarget = clamp(SNAP_EVERY + this.jitterTicks + DELAY_MARGIN, INTERP_MIN_TICKS, INTERP_MAX_TICKS);

    // Le délai suit sa cible à vitesse bornée (pas d'à-coups).
    if (Number.isNaN(this.lastObsAt)) {
      this.delay = clamp(this.delay, INTERP_MIN_TICKS, INTERP_MAX_TICKS);
    } else {
      const dtS = clamp((recvAt - this.lastObsAt) / 1000, 0, 0.2);
      const d = this.delayTarget - this.delay;
      this.delay += d > 0 ? Math.min(d, DELAY_UP_PER_S * dtS) : Math.max(d, -DELAY_DOWN_PER_S * dtS);
    }
    this.lastObsAt = recvAt;

    // Première mesure : l'horloge part directement de l'estimation.
    if (Number.isNaN(this.tickNow)) {
      this.tickNow = recvAt;
      this.tick = this.est = recvAt * TICKS_PER_MS + max;
    }
  }

  /** Une mesure a-t-elle été reçue ? */
  get synced(): boolean {
    return !Number.isNaN(this.tickNow);
  }

  /**
   * Tick serveur estimé à l'heure locale `now` (ms), fractionnaire. Ne recule jamais :
   * l'écart à l'estimation est rattrapé par un ajustement de vitesse borné à ±5 % près de la cible ;
   * en avance de plus d'un tick, l'horloge ralentit fortement, jusqu'à s'arrêter. Écart énorme
   * (> 30 ticks) : l'horloge saute (vers l'avant seulement).
   * `cap` : tick à ne pas dépasser (le rendu atteindrait la fin des instantanés reçus) ; l'estimation
   * continue sans lui, et le retard ainsi pris est repris d'un coup dès que les instantanés arrivent.
   */
  tickAt(now: number, cap = Infinity): number {
    if (Number.isNaN(this.tickNow)) return 0;
    const dtMs = now - this.tickNow;
    if (!(dtMs > 0)) return this.tick; // même instant ou horloge qui recule : on ne bouge pas
    const want = now * TICKS_PER_MS + this.target;
    // Recul démenti par les mesures suivantes (pic de latence passager) : repris d'un coup, pas à +5 %.
    if (this.owed > 0 && now < this.owedUntil) {
      const back = Math.min(this.owed, want - this.est - dtMs * TICKS_PER_MS - SLOW_FROM);
      if (back > 0) {
        this.est += back;
        this.owed -= back;
      }
    }
    const free = this.est + dtMs * TICKS_PER_MS;
    const err = want - free;
    if (Math.abs(err) > SNAP_TICKS) {
      // En arrière, l'estimation revient sur la cible sans passer sous le tick déjà rendu : recul de
      // chronologie que la fenêtre n'a pas vu (trou de mesures plus long qu'elle, gel du serveur).
      const e0 = this.est;
      this.est = Math.max(err > 0 ? this.est : this.tick, want);
      // Comme le recul vu par observe(), il reste dû : si la cible remonte (arriéré d'une coupure livré
      // progressivement, chronologie intacte), il est repris d'un coup ; après un vrai gel, elle ne remonte pas.
      if (e0 > this.est) {
        this.owed = (now < this.owedUntil ? this.owed : 0) + e0 - this.est;
        this.owedUntil = now + OWED_MS;
      }
    } else {
      const skew = err < -SLOW_FROM ? Math.max(-1, -MAX_SKEW + (err + SLOW_FROM) * SLOW_GAIN) : clamp(err * SKEW_GAIN, -MAX_SKEW, MAX_SKEW);
      // Sur un long intervalle, ne pas dépasser la cible à cause de la correction.
      const adv = dtMs * TICKS_PER_MS * (1 + skew);
      const next = this.est + adv;
      this.est = err > 0 ? Math.min(next, Math.max(free, want)) : Math.max(next, Math.min(free, want), this.est);
    }
    this.tick = Math.max(this.tick, Math.min(this.est, cap));
    this.tickNow = now;
    return this.tick;
  }

  /** Délai d'interpolation (ticks) : intervalle des instantanés + gigue (p95) + marge, borné et lissé. */
  delayTicks(): number {
    return this.delay;
  }

  reset(): void {
    this.samples = [];
    this.target = NaN;
    this.tick = 0;
    this.tickNow = NaN;
    this.est = 0;
    this.owed = 0;
    this.owedUntil = -Infinity;
    this.delay = INTERP_TICKS;
    this.delayTarget = INTERP_TICKS;
    this.lastObsAt = NaN;
    this.jitterTicks = 0;
  }
}
