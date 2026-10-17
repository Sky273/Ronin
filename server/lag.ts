// Latence simulée pour le développement : retarde les messages entrants et sortants.
// LAG_MS : délai appliqué dans chaque sens (aller-retour ≈ 2 × LAG_MS) ;
// JITTER_MS : variation aléatoire supplémentaire de 0 à JITTER_MS dans chaque sens.
// Désactivée (exécution immédiate) si aucune des deux variables n'est définie.
// L'ordre des messages est conservé par canal, comme sur une connexion TCP : une file par canal, un seul
// minuteur armé sur sa tête (un minuteur par message ne suffit pas : Node tronque les délais à la
// milliseconde et les compte depuis l'heure de boucle, deux messages de même échéance se croisaient).

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

/** Messages en attente d'un canal. */
interface Channel {
  /** Dans l'ordre d'arrivée, échéances croissantes par construction. */
  queue: { due: number; fn: () => void }[];
  /** Minuteur armé sur la tête de file (null : aucun). */
  timer: ReturnType<typeof setTimeout> | null;
}

export class LagLine {
  /** Canaux ayant des messages en attente (un canal vidé ou oublié est retiré). */
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly cfg: LagConfig | null) {}

  get enabled(): boolean {
    return this.cfg !== null;
  }

  /** Exécute `fn` après la latence simulée (immédiatement si désactivée), jamais avant les messages précédents du canal. */
  run(channel: string, fn: () => void): void {
    if (!this.cfg) {
      fn();
      return;
    }
    let ch = this.channels.get(channel);
    if (!ch) this.channels.set(channel, (ch = { queue: [], timer: null }));
    const tail = ch.queue[ch.queue.length - 1];
    // Un message retardé retient les suivants (blocage en tête de ligne, comme TCP) : l'échéance ne recule jamais.
    const due = Math.max(performance.now() + this.cfg.lagMs + Math.random() * this.cfg.jitterMs, tail?.due ?? 0);
    ch.queue.push({ due, fn });
    if (!ch.timer) this.arm(channel, ch);
  }

  /** Oublie un canal (client parti) : ses messages en attente sont abandonnés, son minuteur annulé. */
  forget(channel: string): void {
    const ch = this.channels.get(channel);
    if (!ch) return;
    if (ch.timer) clearTimeout(ch.timer);
    ch.timer = null;
    ch.queue.length = 0;
    this.channels.delete(channel);
  }

  /** Annule tous les messages en attente (fermeture de la salle). */
  clear(): void {
    for (const channel of [...this.channels.keys()]) this.forget(channel);
  }

  /** Arme le minuteur du canal sur l'échéance de sa tête (délai arrondi au-dessus : Node le tronque). */
  private arm(channel: string, ch: Channel): void {
    const wait = Math.max(0, Math.ceil(ch.queue[0].due - performance.now()));
    ch.timer = setTimeout(() => this.fire(channel, ch), wait);
  }

  /**
   * Exécute dans l'ordre tous les messages échus du canal, puis réarme sur la nouvelle tête. Le minuteur peut
   * partir un peu tôt (heure de boucle mise en cache) : tête pas encore échue, à 1 ms près, on réarme simplement.
   */
  private fire(channel: string, ch: Channel): void {
    try {
      while (ch.queue.length && ch.queue[0].due <= performance.now() + 1) ch.queue.shift()!.fn();
    } finally {
      // Minuteur tenu jusqu'ici : un run() du même canal pendant l'exécution n'en arme pas un second.
      ch.timer = null;
      // Canal oublié pendant l'exécution (départ, fermeture) : rien à réarmer.
      if (this.channels.get(channel) === ch) {
        if (ch.queue.length) this.arm(channel, ch);
        else this.channels.delete(channel);
      }
    }
  }
}
