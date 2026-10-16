// Latence simulée pour le développement : retarde les messages entrants et sortants.
// LAG_MS : délai appliqué dans chaque sens (aller-retour ≈ 2 × LAG_MS) ;
// JITTER_MS : variation aléatoire supplémentaire de 0 à JITTER_MS dans chaque sens.
// Désactivée (exécution immédiate) si aucune des deux variables n'est définie.
// L'ordre des messages est conservé par canal, comme sur une connexion TCP.

export interface LagConfig {
  lagMs: number;
  jitterMs: number;
}

function envMs(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 0;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : 0;
}

/** Lit LAG_MS et JITTER_MS ; null si la latence simulée est désactivée. */
export function lagFromEnv(): LagConfig | null {
  const lagMs = envMs('LAG_MS');
  const jitterMs = envMs('JITTER_MS');
  return lagMs || jitterMs ? { lagMs, jitterMs } : null;
}

export class LagLine {
  /** Heure de livraison du dernier message de chaque canal (ordre préservé). */
  private readonly last = new Map<string, number>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly cfg: LagConfig | null) {}

  get enabled(): boolean {
    return this.cfg !== null;
  }

  /** Exécute `fn` après la latence simulée (immédiatement si désactivée). */
  run(channel: string, fn: () => void): void {
    if (!this.cfg) {
      fn();
      return;
    }
    const now = performance.now();
    const due = Math.max(now + this.cfg.lagMs + Math.random() * this.cfg.jitterMs, this.last.get(channel) ?? 0);
    this.last.set(channel, due);
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, due - now);
    this.timers.add(t);
  }

  /** Oublie un canal (client parti). */
  forget(channel: string): void {
    this.last.delete(channel);
  }

  /** Annule tous les messages en attente (fermeture de la salle). */
  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.last.clear();
  }
}
