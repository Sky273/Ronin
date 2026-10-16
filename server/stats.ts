// Mesures simples (durées de tick, tailles de messages) : percentiles sur une fenêtre.

export class Samples {
  private values: number[] = [];

  add(v: number): void {
    // Fenêtre bornée : au-delà, on garde la seconde moitié (mesures récentes).
    if (this.values.length >= 100_000) this.values = this.values.slice(50_000);
    this.values.push(v);
  }

  get count(): number {
    return this.values.length;
  }

  /** Percentile (0..100) ; 0 si aucune mesure. */
  percentile(p: number): number {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
  }

  get mean(): number {
    if (!this.values.length) return 0;
    let s = 0;
    for (const v of this.values) s += v;
    return s / this.values.length;
  }

  get max(): number {
    let m = 0;
    for (const v of this.values) if (v > m) m = v;
    return m;
  }

  reset(): void {
    this.values = [];
  }
}
