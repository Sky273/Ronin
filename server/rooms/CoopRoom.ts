// Salle coopérative « la route partagée » : 12 joueurs, serveur autoritaire.
// Aucun état Schema : le serveur envoie des instantanés msgpack explicites (MSG.snap).
import { CloseCode, getMessageBytes, matchMaker, Protocol, Room, type Client, type RoomException, type RoomMethodName } from '@colyseus/core';
import { AWAY_CLOSE_CODE, MSG, NET_TICK, PLAYER_COLORS, SNAP_EVERY, type InputMsg, type PingMsg } from '../../shared/net/protocol';
import { DUEL, DUEL_WHY } from '../../shared/constants';
import { isDueling } from '../../shared/duel';
import { LagLine, lagFromEnv } from '../lag';
import { CoopSession } from '../session';
import { Samples } from '../stats';

/** Débit permis (messages par seconde réelle) : le seau de chaque client en est crédité en continu… */
export const RATE_LIMIT_PER_S = 120;
/** … et en garde au plus ce nombre de secondes d'avance : une rafale de rattrapage (coupure, gel) passe. */
export const RATE_LIMIT_BURST_S = 3;
/** Seau vide : messages ignorés ; un excès cumulé de ce nombre de secondes de débit permis → expulsion. */
export const RATE_LIMIT_SECONDS = 2;
/** Intervalle des statistiques dans les logs (ms) ; 0 pour les désactiver. */
const STATS_EVERY_MS = Number(process.env.STATS_EVERY_MS ?? 10_000);
/** Plafond de salles par processus (création de salles en masse par le matchmaking anonyme). */
export const MAX_ROOMS = Math.max(1, Number(process.env.MAX_ROOMS) || 50);

interface RateState {
  tokens: number; // messages encore permis (négatif : excès cumulé au-delà de la réserve)
  at: number; // heure du dernier crédit (ms)
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export class CoopRoom extends Room {
  maxClients = PLAYER_COLORS;
  // Garde-fou du framework (coupure immédiate) bien au-dessus de notre propre limite.
  maxMessagesPerSecond = RATE_LIMIT_PER_S * 4;
  // Pas d'état Schema : pas de boucle de patchs.
  patchRate = null;

  private session!: CoopSession;
  private readonly pids = new Map<string, number>();
  private readonly rates = new Map<string, RateState>();
  private readonly lag = new LagLine(lagFromEnv());
  private ticksSinceSnap = 0;
  private readonly tickMs = new Samples(); // durée d'un pas de simulation
  private readonly sendMs = new Samples(); // construction + encodage des instantanés
  private readonly snapBytes = new Samples();
  private bytesOut = 0;
  private statsSince = 0;
  private lastTickAt = 0;

  onCreate(): void {
    // La salle en cours de création n'est pas encore comptée (roomCount n'augmente qu'après onCreate).
    if (matchMaker.stats.local.roomCount >= MAX_ROOMS) throw new Error('server full');
    // Graine aléatoire : Math.random est permis côté serveur (jamais dans shared/).
    // Les options de création viennent du client : elles sont volontairement ignorées.
    const seed = Math.floor(Math.random() * 0x7fffffff);
    this.session = new CoopSession(seed);

    this.onMessage(MSG.input, (client: Client, msg: unknown) => {
      // Duelliste : entrée jamais ignorée (sa file stricte suppose qu'aucune ne manque), mais comptée ; la session
      // borne déjà cette file (cadence cumulée FLOOD, retrait au-delà de QUEUE_MAX, plafond dur DUEL_QUEUE_HARD).
      const dueling = isDueling(this.session.world, this.pids.get(client.sessionId) ?? -1);
      if (!this.allow(client, dueling)) return;
      if (!msg || typeof msg !== 'object') return;
      const { s, b, v } = msg as Partial<InputMsg>;
      if (!isInt(s) || !isInt(b) || s < 0) return;
      const input: InputMsg = { s, b };
      // Tick de vue (compensation de latence) : entier ≥ 0, sinon ignoré (l'entrée reste valide, L = 0).
      if (isInt(v) && v >= 0) input.v = v;
      this.lag.run(`in:${client.sessionId}`, () => {
        const pid = this.pids.get(client.sessionId);
        if (pid !== undefined) this.session.pushInput(pid, input, performance.now());
      });
    });

    this.onMessage(MSG.ping, (client: Client, msg: unknown) => {
      if (!this.allow(client)) return;
      // Écho pour la mesure du RTT : seul `{ t }` avec un nombre fini est renvoyé (sinon t = 0).
      const t = (msg as { t?: unknown } | null)?.t;
      const echo: PingMsg = { t: typeof t === 'number' && Number.isFinite(t) ? t : 0 };
      this.lag.run(`in:${client.sessionId}`, () => this.deliver(client, MSG.ping, echo));
    });

    // Types inconnus : comptés dans la limite de débit, ignorés sans log (pas d'inondation des journaux).
    this.onMessage('*', (client: Client) => {
      this.allow(client);
    });

    this.statsSince = performance.now();
    // Le temps écoulé est mesuré ici : clock.deltaTime n'est pas fiable sans boucle de patchs
    // (le framework fait alors avancer l'horloge par un autre minuteur).
    this.lastTickAt = performance.now();
    this.setTimestep(() => this.tick(), 1000 / NET_TICK);
    if (STATS_EVERY_MS > 0) this.clock.setInterval(() => this.report(), STATS_EVERY_MS);
    console.log(`[coop ${this.roomId}] salle créée (graine ${seed}${this.lag.enabled ? ', latence simulée' : ''})`);
  }

  onJoin(client: Client, options?: { name?: unknown }): void {
    const { pid, color } = this.session.join(options?.name);
    this.pids.set(client.sessionId, pid);
    this.rates.set(client.sessionId, { tokens: RATE_LIMIT_PER_S * RATE_LIMIT_BURST_S, at: performance.now() });
    this.deliver(client, MSG.welcome, this.session.welcomeFor(pid));
    const p = this.session.world.players.find((q) => q.id === pid);
    console.log(`[coop ${this.roomId}] + ${p?.name ?? '?'} (pid ${pid}, couleur ${color}) — ${this.session.playerCount} joueur(s)`);
  }

  onLeave(client: Client): void {
    const pid = this.pids.get(client.sessionId);
    this.pids.delete(client.sessionId);
    this.rates.delete(client.sessionId);
    this.lag.forget(`in:${client.sessionId}`);
    this.lag.forget(`out:${client.sessionId}`);
    if (pid === undefined) return;
    this.session.leave(pid);
    console.log(`[coop ${this.roomId}] - pid ${pid} — ${this.session.playerCount} joueur(s)`);
  }

  /**
   * Exception dans un rappel de la salle (tick, message…) : sans ce gestionnaire, Colyseus la laisse
   * remonter au processus, qui s'arrête avec toutes ses salles. On ne ferme que la salle fautive.
   */
  onUncaughtException(error: RoomException, methodName: RoomMethodName): void {
    console.error(`[coop ${this.roomId}] exception dans ${methodName} : salle fermée`, error);
    // Pendant onCreate, le framework jette lui-même la salle et renvoie l'erreur au client (« server full ») ;
    // disconnect y lèverait une autre exception, qui remplacerait ce message.
    if (methodName === 'onCreate') return;
    this.disconnect(CloseCode.WITH_ERROR).catch(() => undefined);
  }

  onDispose(): void {
    this.lag.clear();
    // Création refusée (salle jamais ouverte) : pas de session, rien à résumer.
    if (!this.session) return;
    this.report();
    console.log(`[coop ${this.roomId}] salle fermée`);
  }

  /** Session de la salle (tests). */
  get coop(): CoopSession {
    return this.session;
  }

  /**
   * Limite de débit, jugée en cumul : seau crédité de RATE_LIMIT_PER_S messages par seconde réelle, réserve de
   * RATE_LIMIT_BURST_S s. Après une coupure, la rafale de rattrapage ne fait que rendre le temps écoulé : elle passe
   * entière (une fenêtre d'une seconde la jetait, et décalait la file stricte d'un duelliste). Seau vide : message
   * ignoré (sauf `keep`), l'excès s'accumule ; RATE_LIMIT_SECONDS s de débit permis en excès → expulsion.
   */
  private allow(client: Client, keep = false): boolean {
    const r = this.rates.get(client.sessionId);
    if (!r) return false;
    const now = performance.now();
    r.tokens = Math.min(RATE_LIMIT_PER_S * RATE_LIMIT_BURST_S, r.tokens + ((now - r.at) * RATE_LIMIT_PER_S) / 1000);
    r.at = now;
    if (--r.tokens >= 0) return true;
    if (r.tokens <= -RATE_LIMIT_PER_S * RATE_LIMIT_SECONDS) {
      console.warn(`[coop ${this.roomId}] client ${client.sessionId} expulsé (trop de messages)`);
      this.rates.delete(client.sessionId);
      client.leave(CloseCode.WITH_ERROR, 'trop de messages');
      return false;
    }
    return keep; // messages excédentaires ignorés
  }

  /** Envoi d'un message (avec latence simulée éventuelle) ; renvoie la taille encodée (0 si rien n'est envoyé). */
  private deliver(client: Client, type: string, message: unknown): number {
    // Client parti (écho d'un ping retardé, exécuté après onLeave) : rien à envoyer, son canal n'est pas recréé.
    if (!this.pids.has(client.sessionId)) return 0;
    // Encodage identique à client.send(), mais une seule fois et mesurable.
    const bytes = getMessageBytes.raw(Protocol.ROOM_DATA, type, message);
    this.lag.run(`out:${client.sessionId}`, () => {
      if (this.pids.has(client.sessionId)) client.enqueueRaw(bytes);
    });
    return bytes.byteLength;
  }

  /** Renvoie les joueurs absents depuis trop longtemps : leur place revient à d'autres. */
  private kickIdle(): void {
    const idle = this.session.idleOut();
    if (!idle.length) return;
    for (const client of this.clients) {
      const pid = this.pids.get(client.sessionId);
      if (pid === undefined || !idle.includes(pid)) continue;
      console.log(`[coop ${this.roomId}] pid ${pid} renvoyé (absent)`);
      this.pids.delete(client.sessionId);
      this.session.leave(pid);
      client.leave(AWAY_CLOSE_CODE, 'away');
    }
  }

  /**
   * Journal des duels : fin de série, et réactions anormalement rapides (< SUSPECT_REACT ticks, ~130 ms),
   * signe possible d'un script (le signal est connu à l'avance). Les sanctions viendront avec le dojo.
   */
  private logDuels(): void {
    for (const ev of this.session.pendingEvents) {
      if (ev.type === 'duelRound') {
        if (ev.why === DUEL_WHY.FOUL || ev.why === DUEL_WHY.DOUBLE_FOUL) continue; // anticipation honnête
        const d = this.session.world.duels?.find((x) => x.id === ev.id);
        for (const [pid, r] of [[d?.a.pid ?? -1, ev.ra], [d?.b.pid ?? -1, ev.rb]] as const) {
          if (r >= 0 && r < DUEL.SUSPECT_REACT) console.warn(`[coop ${this.roomId}] duel ${ev.id} : réaction suspecte du joueur ${pid} : ${Math.round((r * 1000) / NET_TICK)} ms`);
        }
      } else if (ev.type === 'duelEnd') {
        console.log(`[coop ${this.roomId}] duel ${ev.id} terminé : ${ev.wa}–${ev.wb}, vainqueur ${ev.winner}, issue ${ev.why}`);
      }
    }
  }

  private tick(): void {
    const t0 = performance.now();
    const elapsed = t0 - this.lastTickAt;
    this.lastTickAt = t0;
    // Salle vide (places réservées, dernier départ) : le monde attend sans consommer de CPU.
    if (this.session.playerCount === 0) return;
    const steps = this.session.update(elapsed);
    if (!steps) return;
    this.kickIdle();
    const t1 = performance.now();
    const perStep = (t1 - t0) / steps;
    for (let i = 0; i < steps; i++) this.tickMs.add(perStep);

    this.ticksSinceSnap += steps;
    if (this.ticksSinceSnap < SNAP_EVERY) return;
    this.ticksSinceSnap %= SNAP_EVERY;
    for (const client of this.clients) {
      const pid = this.pids.get(client.sessionId);
      if (pid === undefined) continue;
      const n = this.deliver(client, MSG.snap, this.session.snapshotFor(pid));
      this.snapBytes.add(n);
      this.bytesOut += n;
    }
    this.logDuels();
    this.session.flushEvents();
    this.sendMs.add(performance.now() - t1);
  }

  private report(): void {
    const now = performance.now();
    const secs = Math.max(0.001, (now - this.statsSince) / 1000);
    const lag = this.session.lagStats;
    if (this.tickMs.count) {
      const f = (v: number) => v.toFixed(3);
      console.log(
        `[coop ${this.roomId}] ${this.session.playerCount} joueur(s) | ${(this.tickMs.count / secs).toFixed(1)} pas/s | tick p50 ${f(this.tickMs.percentile(50))} ms, p99 ${f(this.tickMs.percentile(99))} ms, max ${f(this.tickMs.max)} ms` +
          ` | envoi p50 ${f(this.sendMs.percentile(50))} ms, p99 ${f(this.sendMs.percentile(99))} ms` +
          ` | instantané moy. ${Math.round(this.snapBytes.mean)} o, ${(this.bytesOut / secs / 1024).toFixed(1)} Kio/s sortants` +
          ` | retard L p50 ${lag.percentile(50)}, p95 ${lag.percentile(95)} ticks`,
      );
    }
    lag.reset();
    this.tickMs.reset();
    this.sendMs.reset();
    this.snapBytes.reset();
    this.bytesOut = 0;
    this.statsSince = now;
  }
}
