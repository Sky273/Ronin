import type { GameEvent, World } from '../../shared/types';

/**
 * Source du monde affiché par la scène : locale (le client simule, mode solo) ou en ligne
 * (le serveur simule, le client applique des instantanés). Le rendu lit `world` dans les deux cas.
 */
export interface WorldSource {
  readonly kind: 'local' | 'online';
  readonly world: World;
  /** Id du joueur contrôlé par ce client. */
  readonly meId: number;
  /**
   * Fait avancer le monde de `dt` secondes réelles. `sample` lit les boutons du joueur local ;
   * `beforeStep` est appelé juste avant chaque mise à jour (mémorisation des positions pour l'interpolation).
   * Renvoie les événements survenus (effets, sons).
   */
  advance(dt: number, sample: () => number, beforeStep: () => void): GameEvent[];
  /** Interpolation de rendu entre l'état précédent et l'état courant (0..1). */
  alpha(): number;
  dispose(): void;
}
