// Déclencheur « maintenir pour valider » (ex. quitter la salle en ligne à la manette).
// Pur et sans horloge propre : l'appelant fournit l'heure (testable, tests/policy.test.ts).

export class HoldTrigger {
  private since: number | null = null;
  private fired = false;

  /** `ms` : durée de maintien nécessaire. */
  constructor(private readonly ms: number) {}

  /**
   * À appeler à chaque image avec l'état du bouton. Renvoie vrai une seule fois, quand le
   * maintien atteint la durée ; il faut relâcher le bouton pour réarmer.
   */
  update(held: boolean, now: number): boolean {
    if (!held) {
      this.since = null;
      this.fired = false;
      return false;
    }
    if (this.since === null) this.since = now;
    if (this.fired || now - this.since < this.ms) return false;
    this.fired = true;
    return true;
  }

  /** Progression du maintien (0..1), pour un éventuel indicateur. */
  progress(now: number): number {
    if (this.since === null || this.fired) return 0;
    return Math.min(1, (now - this.since) / this.ms);
  }

  reset(): void {
    this.since = null;
    this.fired = false;
  }
}
