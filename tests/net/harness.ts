// Banc réseau virtuel : une session serveur et N sources distantes reliées par des liens simulés
// (latence + gigue tirées d'une graine, ordre conservé comme TCP, vrai encodage msgpack),
// sur une horloge virtuelle. Aucune attente réelle : tout est déterministe et rapide.
import { pack, unpack } from 'msgpackr';
import { RemoteSource } from '../../client/net/remoteSource';
import type { Transport } from '../../client/net/transport';
import { CoopSession } from '../../server/session';
import { DojoSession } from '../../server/dojoSession';
import { Rng } from '../../shared/math';
import type { SnapshotWire } from '../../shared/net/codec';
import { SNAP_EVERY, type InputMsg, type WelcomeMsg } from '../../shared/net/protocol';
import type { GameEvent, Player } from '../../shared/types';

/** Horloge virtuelle (ms). */
export class VirtualClock {
  t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface LinkOptions {
  /** Latence fixe par sens (ms). */
  lagMs: number;
  /** Gigue ajoutée, uniforme dans [0, jitterMs] (ms). */
  jitterMs: number;
  seed: number;
}

/** Un sens de communication : les messages arrivent dans l'ordre d'envoi, après latence et gigue. */
export class VirtualLink {
  private queue: { at: number; data: Uint8Array; deliver: (msg: unknown) => void }[] = [];
  private last = 0;
  private rng: Rng;
  /** Fin de la coupure en cours (ms) : rien n'est livré avant. */
  private until = -Infinity;
  /** Octets transmis (après msgpack). */
  bytes = 0;
  messages = 0;
  /** Messages retenus par une coupure (ils seraient arrivés avant sa fin). */
  delayed = 0;

  constructor(private clock: VirtualClock, private opts: LinkOptions) {
    this.rng = new Rng(opts.seed);
  }

  /**
   * Coupure (TCP) : rien ne passe pendant `ms`, ni les messages déjà en route ni ceux envoyés entre-temps ; à la fin,
   * tout ce qui aurait dû arriver arrive d'un coup, dans l'ordre.
   */
  cut(ms: number): void {
    this.until = Math.max(this.until, this.clock.t + ms);
  }

  send(msg: unknown, deliver: (msg: unknown) => void): number {
    const data = pack(msg);
    this.bytes += data.byteLength;
    this.messages++;
    const at = Math.max(this.last, this.clock.t + this.opts.lagMs + this.rng.next() * this.opts.jitterMs);
    this.last = at;
    this.queue.push({ at, data, deliver });
    return data.byteLength;
  }

  /** Livre les messages arrivés à l'heure courante (aucun pendant une coupure). */
  flush(): void {
    if (this.clock.t < this.until) return;
    while (this.queue.length && this.queue[0].at <= this.clock.t) {
      const m = this.queue.shift()!;
      if (m.at < this.until) this.delayed++;
      m.deliver(unpack(m.data));
    }
  }
}

/** Transport d'une source distante branché sur le banc. */
export class LinkTransport implements Transport {
  rtt = 0;
  private welcomeCb: ((m: WelcomeMsg) => void) | null = null;
  private snapCb: ((m: SnapshotWire) => void) | null = null;
  left = false;
  sent: InputMsg[] = [];

  constructor(
    private clock: VirtualClock,
    readonly up: VirtualLink,
    readonly down: VirtualLink,
    private toServer: (msg: InputMsg) => void,
  ) {}

  onWelcome(cb: (m: WelcomeMsg) => void): void {
    this.welcomeCb = cb;
  }
  onSnapshot(cb: (m: SnapshotWire) => void): void {
    this.snapCb = cb;
  }
  onClose(): void {}
  sendInput(msg: InputMsg): void {
    if (this.left) return;
    this.sent.push(msg);
    this.up.send(msg, (m) => this.toServer(m as InputMsg));
  }
  ping(): void {
    const t0 = this.clock.t;
    this.up.send({ t: t0 }, (m) =>
      this.down.send(m, (back) => {
        const sample = this.clock.t - (back as { t: number }).t;
        this.rtt = this.rtt === 0 ? sample : this.rtt + (sample - this.rtt) * 0.2;
      }),
    );
  }
  leave(): void {
    this.left = true;
  }
  /** Côté serveur : messages vers ce client. */
  deliverWelcome(m: WelcomeMsg): void {
    this.down.send(m, (x) => this.welcomeCb?.(x as WelcomeMsg));
  }
  deliverSnapshot(m: SnapshotWire): number {
    return this.down.send(m, (x) => this.snapCb?.(x as SnapshotWire));
  }
}

export interface BenchClient {
  pid: number;
  src: RemoteSource;
  transport: LinkTransport;
  /** Boutons échantillonnés à chaque image (dernier appel à sample). */
  lastButtons: number;
  /**
   * Cadence d'envoi simulée (Hz) : absente, une image = un appel à `advance` (60 Hz).
   * Sinon, autant d'appels à `advance(1/60)` par image que nécessaire pour envoyer `sendHz` entrées
   * par seconde de temps réel (client accéléré : boucle doublée, accélérateur de vitesse).
   */
  sendHz?: number;
  /** Événements rendus par la source à chaque image (affichage), dans l'ordre. */
  events: GameEvent[];
}

export interface BenchOptions {
  seed?: number;
  lagMs?: number;
  jitterMs?: number;
  /** Salle simulée : la route partagée (défaut) ou le dojo (DojoSession, tournoi). */
  mode?: 'coop' | 'dojo';
  /** Durée d'une image client (ms). */
  frameMs?: number;
}

/** Métriques relevées pendant `run`. */
export interface BenchMetrics {
  /** Taille (octets msgpack) de chaque instantané envoyé. */
  snapBytes: number[];
  frames: number;
}

/** Lien d'un client : mêmes réglages dans les deux sens, ou réglages par sens (montant, descendant). */
export type ClientLink = Partial<LinkOptions> | { up?: Partial<LinkOptions>; down?: Partial<LinkOptions> };

/** Le réglage est-il donné par sens ? */
function perDirection(l: ClientLink): l is { up?: Partial<LinkOptions>; down?: Partial<LinkOptions> } {
  return 'up' in l || 'down' in l;
}

/** Serveur + clients sur horloge virtuelle. */
export class NetBench {
  readonly clock = new VirtualClock();
  readonly session: CoopSession;
  readonly clients: BenchClient[] = [];
  readonly metrics: BenchMetrics = { snapBytes: [], frames: 0 };
  private stepsSinceSnap = 0;
  private linkSeed: number;
  /** Dernière séquence envoyée en rafale, par joueur. */
  private burstSeq = new Map<number, number>();
  readonly frameMs: number;

  constructor(private opts: BenchOptions = {}) {
    this.session = opts.mode === 'dojo' ? new DojoSession(opts.seed ?? 1) : new CoopSession(opts.seed ?? 1);
    this.linkSeed = (opts.seed ?? 1) * 7919;
    this.frameMs = opts.frameMs ?? 1000 / 60;
  }

  /**
   * Ajoute un client : arrivée dans la session, accueil envoyé par le lien descendant.
   * `link` : latence et gigue de ce client (les deux sens, ou `{ up, down }` par sens) ;
   * les valeurs absentes sont celles du banc.
   */
  addClient(name: string, link: ClientLink = {}): BenchClient {
    const upOpts = perDirection(link) ? link.up ?? {} : link;
    const downOpts = perDirection(link) ? link.down ?? {} : link;
    const make = (o: Partial<LinkOptions>): VirtualLink =>
      new VirtualLink(this.clock, {
        lagMs: o.lagMs ?? this.opts.lagMs ?? 0,
        jitterMs: o.jitterMs ?? this.opts.jitterMs ?? 0,
        seed: o.seed ?? this.linkSeed++,
      });
    const { pid } = this.session.join(name);
    const transport = new LinkTransport(this.clock, make(upOpts), make(downOpts), (m) => this.session.pushInput(pid, m, this.clock.t));
    const src = new RemoteSource(transport, { now: this.clock.now });
    const c: BenchClient = { pid, src, transport, lastButtons: 0, events: [] };
    this.clients.push(c);
    transport.deliverWelcome(this.session.welcomeFor(pid));
    return c;
  }

  /** Tick prédit du client : tick de consommation serveur de sa prochaine entrée (équité des duels). */
  predictedTick(c: BenchClient): number {
    return c.src.predictor.tick;
  }

  /**
   * Rafale (test anti-triche) : pousse d'un coup plusieurs entrées dans le lien montant du client,
   * hors de sa source. Un nombre devient `{ s, b, v }` avec la séquence suivante et `v` = tick de rendu
   * courant du client (sauf `v` donné) ; un `InputMsg` est envoyé tel quel.
   * Attention : le serveur ignore ensuite les entrées de la source dont la séquence n'est pas plus grande.
   * Renvoie les messages envoyés.
   */
  burst(c: BenchClient, inputs: readonly (number | InputMsg)[], v?: number): InputMsg[] {
    const out: InputMsg[] = [];
    const view = v ?? Math.max(0, Math.floor(c.src.interp.renderTick(this.clock.t)));
    let s = Math.max(c.src.inputSeq, this.burstSeq.get(c.pid) ?? 0);
    for (const x of inputs) {
      const msg: InputMsg = typeof x === 'number' ? { s: ++s, b: x, v: view } : x;
      if (typeof x !== 'number') s = Math.max(s, x.s);
      out.push(msg);
      c.transport.up.send(msg, (m) => this.session.pushInput(c.pid, m as InputMsg, this.clock.t));
    }
    this.burstSeq.set(c.pid, s);
    return out;
  }

  /**
   * Appelle `cb(tick)` après chaque pas du serveur, avec le tick qui vient d'être simulé (celui où
   * les entrées ont été consommées, avant w.tick++). Observation seule : le serveur n'est pas modifié.
   */
  onServerStep(cb: (tick: number) => void): void {
    const s = this.session as unknown as { step(): void };
    const orig = s.step.bind(this.session);
    s.step = () => {
      const t = this.session.world.tick;
      orig();
      cb(t);
    };
  }

  /**
   * Gel du serveur pendant `ms` (boucle bloquée : ramasse-miettes, machine chargée) : ni pas ni
   * instantané, les clients continuent de tourner. À la reprise (premier update suivant), un seul appel
   * rattrape au plus MAX_STEPS_PER_UPDATE pas, comme CoopRoom.tick : le reste du temps est perdu et la
   * chronologie du serveur recule d'autant par rapport aux horloges des clients.
   */
  freezeServer(ms: number, input: (i: number, frame: number) => number, onFrame?: (frame: number) => void): void {
    const s = this.session as unknown as { update(elapsedMs: number): number };
    const orig = s.update;
    let owed = 0;
    s.update = (elapsedMs) => {
      owed += elapsedMs;
      return 0;
    };
    this.run(ms, input, onFrame);
    s.update = (elapsedMs) => {
      s.update = orig;
      return orig.call(this.session, elapsedMs + owed);
    };
  }

  /**
   * Coupure du lien d'un client pendant `ms` (VirtualLink.cut) : montant (ses entrées), descendant (instantanés, échos)
   * ou les deux. Les clients et le serveur continuent de tourner.
   */
  cut(c: BenchClient, ms: number, dir: 'up' | 'down' | 'both' = 'up'): void {
    if (dir !== 'down') c.transport.up.cut(ms);
    if (dir !== 'up') c.transport.down.cut(ms);
  }

  /** Joueur du serveur (état de référence). */
  serverPlayer(pid: number): Player | undefined {
    return this.session.world.players.find((p) => p.id === pid);
  }

  /** Joueur affiché par un client. */
  shownPlayer(c: BenchClient, pid = c.pid): Player | undefined {
    return c.src.world.players.find((p) => p.id === pid);
  }

  /**
   * Fait tourner le banc pendant `ms`. `input(i, frame)` : boutons du client i à cette image.
   * `onFrame` est appelé après chaque image (relevés).
   */
  run(ms: number, input: (i: number, frame: number) => number, onFrame?: (frame: number) => void): void {
    const end = this.clock.t + ms;
    while (this.clock.t < end) {
      this.clock.advance(this.frameMs);
      for (const c of this.clients) c.transport.up.flush();
      // Serveur : pas fixes, instantané tous les SNAP_EVERY pas.
      this.stepsSinceSnap += this.session.update(this.frameMs);
      if (this.stepsSinceSnap >= SNAP_EVERY) {
        this.stepsSinceSnap %= SNAP_EVERY;
        for (const c of this.clients) this.metrics.snapBytes.push(c.transport.deliverSnapshot(this.session.snapshotFor(c.pid)));
        this.session.flushEvents();
      }
      for (const c of this.clients) c.transport.down.flush();
      const frame = this.metrics.frames++;
      this.clients.forEach((c, i) => {
        if (c.sendHz === undefined) {
          for (const ev of c.src.advance(this.frameMs / 1000, () => (c.lastButtons = input(i, frame)), () => undefined)) c.events.push(ev);
          return;
        }
        // Client accéléré : n pas d'entrée de 1/60 s pendant cette image de temps réel.
        const per = (c.sendHz * this.frameMs) / 1000;
        const n = Math.floor((frame + 1) * per + 1e-9) - Math.floor(frame * per + 1e-9);
        for (let k = 0; k < n; k++) for (const ev of c.src.advance(1 / 60, () => (c.lastButtons = input(i, frame)), () => undefined)) c.events.push(ev);
      });
      onFrame?.(frame);
    }
  }
}

/** Moyenne et percentile simples. */
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
