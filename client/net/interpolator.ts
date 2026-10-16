// Interpolation des entités distantes : elles sont affichées avec un léger recul (~100 ms),
// en glissant entre deux instantanés, au « tick de rendu » estimé à partir de l'horloge du serveur.
// Version de départ (fondations M2) : le dernier instantané reçu, tel quel.
import type { Snapshot } from '../../shared/net/protocol';
import type { Enemy, Orb, Player, Projectile } from '../../shared/types';

/** Entités distantes à afficher à un tick de rendu donné. */
export interface InterpSample {
  players: Player[];
  enemies: Enemy[];
  projectiles: Projectile[];
  orbs: Orb[];
}

export class Interpolator {
  private last: Snapshot | null = null;

  /** `now` : horloge en ms (injectable pour les tests). */
  constructor(readonly now: () => number) {}

  /** Instantané appliqué (dans l'ordre des ticks) ; `recvAt` : heure de réception (ms). */
  push(s: Snapshot, _recvAt: number): void {
    this.last = s;
  }

  /** Tick serveur à afficher pour les entités distantes, à l'instant `now` (ms). Fractionnaire. */
  renderTick(_now: number): number {
    return this.last ? this.last.t : 0;
  }

  /** Entités distantes au tick de rendu `tick` (le joueur `excludeId` est exclu : il est prédit). */
  sample(_tick: number, excludeId: number): InterpSample {
    const s = this.last;
    if (!s) return { players: [], enemies: [], projectiles: [], orbs: [] };
    return { players: s.others.filter((p) => p.id !== excludeId), enemies: s.enemies, projectiles: s.projectiles, orbs: s.orbs };
  }

  /** Ennemis tels qu'affichés au tick de vue `tick` : copies modifiables (prédiction des coups). */
  enemiesAt(_tick: number): Enemy[] {
    return this.last ? this.last.enemies.map((e) => ({ ...e })) : [];
  }

  reset(): void {
    this.last = null;
  }
}
