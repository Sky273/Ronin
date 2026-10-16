// Banc réseau virtuel : une session serveur et N sources distantes reliées par des liens simulés
// (latence + gigue tirées d'une graine, ordre conservé comme TCP, vrai encodage msgpack),
// sur une horloge virtuelle. Aucune attente réelle : tout est déterministe et rapide.
import { pack, unpack } from 'msgpackr';
import { RemoteSource } from '../../client/net/remoteSource';
import type { Transport } from '../../client/net/transport';
import { CoopSession } from '../../server/session';
import { Rng } from '../../shared/math';
import type { SnapshotWire } from '../../shared/net/codec';
import { SNAP_EVERY, type InputMsg, type WelcomeMsg } from '../../shared/net/protocol';
import type { Player } from '../../shared/types';

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
  /** Octets transmis (après msgpack). */
  bytes = 0;
  messages = 0;

  constructor(private clock: VirtualClock, private opts: LinkOptions) {
    this.rng = new Rng(opts.seed);
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

  /** Livre les messages arrivés à l'heure courante. */
  flush(): void {
    while (this.queue.length && this.queue[0].at <= this.clock.t) {
      const m = this.queue.shift()!;
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
}

export interface BenchOptions {
  seed?: number;
  lagMs?: number;
  jitterMs?: number;
  /** Durée d'une image client (ms). */
  frameMs?: number;
}

/** Métriques relevées pendant `run`. */
export interface BenchMetrics {
  /** Taille (octets msgpack) de chaque instantané envoyé. */
  snapBytes: number[];
  frames: number;
}

/** Serveur + clients sur horloge virtuelle. */
export class NetBench {
  readonly clock = new VirtualClock();
  readonly session: CoopSession;
  readonly clients: BenchClient[] = [];
  readonly metrics: BenchMetrics = { snapBytes: [], frames: 0 };
  private stepsSinceSnap = 0;
  private linkSeed: number;
  readonly frameMs: number;

  constructor(private opts: BenchOptions = {}) {
    this.session = new CoopSession(opts.seed ?? 1);
    this.linkSeed = (opts.seed ?? 1) * 7919;
    this.frameMs = opts.frameMs ?? 1000 / 60;
  }

  /** Ajoute un client : arrivée dans la session, accueil envoyé par le lien descendant. */
  addClient(name: string): BenchClient {
    const link = (): VirtualLink => new VirtualLink(this.clock, { lagMs: this.opts.lagMs ?? 0, jitterMs: this.opts.jitterMs ?? 0, seed: this.linkSeed++ });
    const { pid } = this.session.join(name);
    const transport = new LinkTransport(this.clock, link(), link(), (m) => this.session.pushInput(pid, m));
    const src = new RemoteSource(transport, { now: this.clock.now });
    const c: BenchClient = { pid, src, transport, lastButtons: 0 };
    this.clients.push(c);
    transport.deliverWelcome(this.session.welcomeFor(pid));
    return c;
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
        c.src.advance(this.frameMs / 1000, () => (c.lastButtons = input(i, frame)), () => undefined);
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
