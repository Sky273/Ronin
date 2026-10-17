// Salle du dojo : tournoi de duels à 8 places, serveur autoritaire. Mêmes messages, limites de débit, latence
// simulée et instantanés que la route partagée (CoopRoom) ; seuls changent la session, le nombre de places
// et le verrou de la salle pendant un tournoi.
import { DOJO, DUEL_WHY } from '../../shared/constants';
import type { CoopSession } from '../session';
import { DojoSession } from '../dojoSession';
import { CoopRoom, MAX_ROOMS } from './CoopRoom';

/**
 * Salles dojo au plus (moitié du plafond commun) : un dojo se verrouille pendant tout un tournoi et chaque arrivant
 * en ouvre alors un autre ; sans sous-plafond, une affluence au dojo épuiserait MAX_ROOMS et fermerait la coop.
 */
export const MAX_DOJO_ROOMS = Math.max(1, Math.ceil(MAX_ROOMS / 2));
let dojoRooms = 0;

/** Nom d'un tour du tableau (index de match : quarts 0-3, demies 4-5, finale 6). */
const roundName = (match: number): string => (match < 4 ? 'quart' : match < 6 ? 'demie' : 'finale');

export class DojoRoom extends CoopRoom {
  maxClients = DOJO.SIZE;
  /** Comptée parmi les salles dojo ouvertes (création acceptée). */
  private counted = false;

  override onCreate(): void {
    if (dojoRooms >= MAX_DOJO_ROOMS) throw new Error('server full');
    super.onCreate();
    dojoRooms++;
    this.counted = true;
  }

  override onDispose(): void {
    if (this.counted) dojoRooms--;
    this.counted = false;
    super.onDispose();
  }

  /** Salles dojo ouvertes dans ce processus (tests, diagnostics). */
  static get open(): number {
    return dojoRooms;
  }
  protected override readonly label: string = 'dojo';
  /**
   * Verrou explicite posé par la salle : tournoi en cours (pas de spectateurs extérieurs, un arrivant va dans une
   * nouvelle salle), ou salle pleine en attente. Colyseus verrouille seul une salle pleine, mais la déverrouille aussi
   * seul au premier départ si le verrou n'est pas explicite (@colyseus/core 0.18 : #_decrementClientCount) : un
   * départ en plein tournoi rouvrirait la salle. Un verrou explicite n'est levé que par unlock().
   */
  private held = false;
  /** Tournoi qui a verrouillé la salle (0 : aucun), pour le journal. */
  private lockedFor = 0;

  protected override createSession(seed: number): CoopSession {
    return new DojoSession(seed);
  }

  /** Session du dojo (tests). */
  get dojo(): DojoSession {
    return this.session as DojoSession;
  }

  /**
   * Renvoi des absents (COOP_KICK_TICKS sans bouton) en attente seulement : pendant un tournoi, la salle est
   * verrouillée (une place libérée ne servirait à personne) et un éliminé ou un arrivant regarde sans jouer.
   * Un participant inactif en match perd déjà par forfait (DOJO.ABSENT_TICKS).
   */
  protected override kickIdle(): void {
    if (this.dojo.tournament.phase === 'waiting') super.kickIdle();
  }

  protected override tick(): void {
    super.tick();
    this.syncLock();
  }

  /**
   * Verrou voulu : tournoi en cours (hors attente), ou salle pleine (places réservées comprises). Levé seulement salle
   * non pleine : déverrouillée pleine, le matchmaking y enverrait encore des arrivants, refusés à la réservation.
   * Les places réservées juste avant le verrou restent valides : leurs joueurs regardent ce tournoi et jouent le suivant.
   */
  private syncLock(): void {
    const t = this.dojo.tournament;
    const running = t.phase !== 'waiting';
    const want = running || this.hasReachedMaxClients();
    if (running && this.lockedFor !== t.n) {
      this.lockedFor = t.n;
      console.log(`[${this.label} ${this.roomId}] salle verrouillée (tournoi n° ${t.n})`);
    }
    if (want === this.held) return;
    this.held = want;
    // Synchrone jusqu'à la mise à jour de l'annonce (pilote local) : aucun arrivant ne passe entre deux.
    const done = want ? this.lock() : this.unlock();
    done.catch((err: unknown) => console.error(`[${this.label} ${this.roomId}] ${want ? 'verrouillage' : 'déverrouillage'} impossible`, err));
    if (!want && this.lockedFor) {
      console.log(`[${this.label} ${this.roomId}] salle ouverte (attente du tournoi n° ${t.n})`);
      this.lockedFor = 0;
    }
  }

  /** Journal des duels (réactions suspectes, fins de série), puis du tournoi : début, résultats, champion, disqualifications. */
  protected override logDuels(): void {
    super.logDuels();
    const t = this.dojo.tournament;
    const name = (pid: number): string => {
      const e = t.entrants.find((x) => x.pid === pid);
      return e ? `${e.name}${e.bot ? ' (bot)' : ''}` : `pid ${pid}`;
    };
    const tag = `[${this.label} ${this.roomId}]`;
    for (const ev of this.session.pendingEvents) {
      switch (ev.type) {
        case 'dojoStart': {
          const bots = t.entrants.filter((e) => e.bot).length;
          console.log(`${tag} tournoi n° ${ev.n} : début, ${t.entrants.length - bots} humain(s), ${bots} bot(s) — ${t.entrants.map((e) => name(e.pid)).join(', ')}`);
          break;
        }
        case 'dojoResult': {
          const m = t.matches[ev.match];
          const loser = m ? (ev.winner === m.a ? m.b : m.a) : -1;
          const score = m ? `${name(m.a)} ${ev.wa}–${ev.wb} ${name(m.b)}` : `${ev.wa}–${ev.wb}`;
          console.log(`${tag} ${roundName(ev.match)} (match ${ev.match}) : ${score}, vainqueur ${name(ev.winner)}, issue ${ev.why}`);
          if (ev.why === DUEL_WHY.SUSPECT) console.warn(`${tag} ${name(loser)} disqualifié (réactions suspectes répétées)`);
          break;
        }
        case 'dojoChampion':
          console.log(`${tag} tournoi n° ${ev.n} : champion ${name(ev.pid)}`);
          break;
        case 'dojoReset':
          console.log(`${tag} retour en attente (tournoi n° ${ev.n})`);
          break;
      }
    }
  }
}
