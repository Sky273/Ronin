// Session du dojo : le tournoi de duels d'une salle, sans aucune dépendance réseau.
// Tout le tournoi (attente, tirage, bots, matchs, forfaits, disqualifications) est dans la simulation
// (shared/tournament.ts, lancé par stepWorld) ; la session de la route lui fournit les places, les files
// d'entrées et l'équité des duels (file stricte, FLOOD, arriérés), en un seul exemplaire.
import { PLAYER_COLORS, type WelcomeMsg } from '../shared/net/protocol';
import { DOJO } from '../shared/constants';
import type { Tournament, World } from '../shared/types';
import { createWorld } from '../shared/world';
import { CoopSession } from './session';

export class DojoSession extends CoopSession {
  /**
   * Monde du dojo, sans compensation de latence : elle ne juge que les échanges avec les ennemis et leurs projectiles,
   * absents ici. Les duels sont jugés au tick où chaque entrée est consommée, sans retour en arrière ; w.net n'y
   * changerait rien, sinon un historique enregistré pour rien à chaque pas.
   */
  protected override createWorld(seed: number): World {
    return createWorld(seed, { mode: 'dojo' });
  }

  /**
   * Couleur d'un arrivant : la première que ne porte aucun joueur du monde, bots compris (ils n'ont pas de place dans
   * la session). Toutes portées (arrivants qui avaient réservé leur place juste avant le verrou du tournoi, en plus des
   * bots) : la moins portée, la plus basse d'abord. Jamais −1 : la salle se borne à DOJO.SIZE places (join).
   */
  protected override pickColor(): number {
    const worn = new Array<number>(PLAYER_COLORS).fill(0);
    for (const p of this.world.players) if (p.color >= 0 && p.color < PLAYER_COLORS) worn[p.color]++;
    let best = 0;
    for (let c = 1; c < PLAYER_COLORS; c++) if (worn[c] < worn[best]) best = c;
    return best;
  }

  /** Ajoute un joueur ; au plus DOJO.SIZE places (les bots n'en prennent pas). Lève une erreur si la salle est pleine. */
  override join(name: unknown): { pid: number; color: number } {
    if (this.playerCount >= DOJO.SIZE) throw new Error('salle pleine');
    return super.join(name);
  }

  /** Accueil : règles du dojo (le client crée un monde dojo). */
  override welcomeFor(pid: number): WelcomeMsg {
    return { ...super.welcomeFor(pid), mode: 'dojo' };
  }

  /** Tournoi de la salle (toujours présent dans un monde dojo). */
  get tournament(): Tournament {
    return this.world.tournament!;
  }
}
