// Horloge serveur estimée : tick serveur (fractionnaire) à un instant local donné (ms),
// et délai d'interpolation adapté à la gigue mesurée. Aucune horloge en dur : l'heure est
// toujours passée en argument (horloge injectée par l'appelant).
import { clamp } from '../../shared/math';
import { INTERP_MAX_TICKS, INTERP_MIN_TICKS, INTERP_TICKS, NET_TICK, SNAP_EVERY } from '../../shared/net/protocol';

/** Ticks par milliseconde locale. */
const TICKS_PER_MS = NET_TICK / 1000;
/** Fenêtre glissante des mesures (ms) : maximum du décalage et percentile de la gigue. */
const WINDOW_MS = 2000;
/** Ajustement de vitesse maximal de l'horloge estimée (±5 %). */
const MAX_SKEW = 0.05;
/** Gain du recalage : vitesse corrigée de GAIN par tick d'écart (saturée à MAX_SKEW). */
const SKEW_GAIN = 0.05;
/** Écart (ticks) au-delà duquel l'horloge se recale d'un coup (onglet en arrière-plan, etc.). */
const SNAP_TICKS = 30;
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
      this.tick = recvAt * TICKS_PER_MS + max;
    }
  }

  /** Une mesure a-t-elle été reçue ? */
  get synced(): boolean {
    return !Number.isNaN(this.tickNow);
  }

  /**
   * Tick serveur estimé à l'heure locale `now` (ms), fractionnaire. Ne recule jamais :
   * l'écart à l'estimation est rattrapé par un ajustement de vitesse borné à ±5 %,
   * sauf écart énorme (> 30 ticks) où l'horloge saute (vers l'avant seulement).
   */
  tickAt(now: number): number {
    if (Number.isNaN(this.tickNow)) return 0;
    const dtMs = now - this.tickNow;
    if (!(dtMs > 0)) return this.tick; // même instant ou horloge qui recule : on ne bouge pas
    const want = now * TICKS_PER_MS + this.target;
    const free = this.tick + dtMs * TICKS_PER_MS;
    const err = want - free;
    if (Math.abs(err) > SNAP_TICKS) {
      this.tick = Math.max(this.tick, want);
    } else {
      const skew = clamp(err * SKEW_GAIN, -MAX_SKEW, MAX_SKEW);
      // Sur un long intervalle, ne pas dépasser la cible à cause de la correction.
      const adv = dtMs * TICKS_PER_MS * (1 + skew);
      const next = this.tick + adv;
      this.tick = err > 0 ? Math.min(next, Math.max(free, want)) : Math.max(next, Math.min(free, want), this.tick);
    }
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
    this.delay = INTERP_TICKS;
    this.delayTarget = INTERP_TICKS;
    this.lastObsAt = NaN;
    this.jitterTicks = 0;
  }
}
