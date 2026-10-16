// Bots de charge : N clients @colyseus/sdk qui jouent dans la salle 'coop'.
// Lancer : npm run bots -- 12 [--url ws://localhost:2567] [--seconds 20]
import { Client, type Room } from '@colyseus/sdk';
import { BTN } from '../shared/input';
import { MSG, NET_TICK, type SnapshotMsg, type WelcomeMsg } from '../shared/net/protocol';

interface Args {
  count: number;
  url: string;
  seconds: number; // 0 : jusqu'à Ctrl+C
}

function parseArgs(argv: string[]): Args {
  const args: Args = { count: 12, url: process.env.SERVER_URL ?? 'ws://localhost:2567', seconds: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, inline] = a.split('=', 2);
    const value = () => inline ?? argv[++i];
    if (key === '--url') args.url = value();
    else if (key === '--seconds') args.seconds = Math.max(0, Number(value()) || 0);
    else if (/^\d+$/.test(a)) args.count = Math.max(1, Math.min(64, Number(a)));
  }
  return args;
}

/** Un bot : comportement simple mais plausible (courir, sauter, frapper, parfois rien). */
class Bot {
  room: Room | null = null;
  pid = -1;
  seq = 0;
  snaps = 0;
  bytes = 0;
  lastAck = -1;
  rtt: number[] = [];
  private mode: 'right' | 'left' | 'idle' = 'right';
  private modeT = 0;
  private tick = 0;

  constructor(readonly index: number) {}

  async connect(client: Client): Promise<void> {
    const room = await client.joinOrCreate('coop', { name: `bot-${this.index}` });
    this.room = room;
    // Compte les octets reçus (trames brutes, avant décodage).
    const events = room.connection.events;
    const orig = events.onmessage;
    events.onmessage = (ev: { data: ArrayBuffer }) => {
      this.bytes += ev.data.byteLength;
      orig?.(ev);
    };
    room.onMessage(MSG.welcome, (w: WelcomeMsg) => {
      this.pid = w.pid;
    });
    room.onMessage(MSG.snap, (s: SnapshotMsg) => {
      this.snaps++;
      this.lastAck = s.ack;
    });
    room.onMessage(MSG.ping, (t: number) => {
      this.rtt.push(performance.now() - t);
    });
  }

  /** Boutons du tick courant. */
  buttons(): number {
    this.tick++;
    if (--this.modeT <= 0) {
      const r = Math.random();
      this.mode = r < 0.6 ? 'right' : r < 0.8 ? 'left' : 'idle';
      this.modeT = 30 + Math.floor(Math.random() * 120);
    }
    let b = this.mode === 'right' ? BTN.RIGHT : this.mode === 'left' ? BTN.LEFT : 0;
    if (this.mode !== 'idle') {
      // Appuis brefs (quelques ticks) : saut, attaque, parfois parade ou course.
      const phase = (this.tick + this.index * 7) % 90;
      if (phase < 6 && Math.random() < 0.8) b |= BTN.JUMP;
      if (phase >= 40 && phase < 44) b |= BTN.ATTACK;
      if (phase === 70 && Math.random() < 0.3) b |= BTN.PARRY;
      if (phase === 80 && Math.random() < 0.2) b |= BTN.DASH;
    }
    return b;
  }

  sendInput(): void {
    this.room?.send(MSG.input, { s: this.seq++, b: this.buttons() });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[bots] ${args.count} bot(s) → ${args.url}`);
  const client = new Client(args.url);
  const bots = Array.from({ length: args.count }, (_, i) => new Bot(i + 1));
  const results = await Promise.allSettled(bots.map((b) => b.connect(client)));
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length) console.error(`[bots] ${failed.length} connexion(s) échouée(s) : ${String(failed[0].reason?.message ?? failed[0].reason)}`);
  const live = bots.filter((b) => b.room);
  if (!live.length) process.exit(1);
  let closed = 0;
  for (const b of live) b.room!.onLeave(() => closed++);

  // Entrées à 60 Hz réels : les timers Windows ont une granularité d'environ 15,6 ms,
  // on envoie donc autant d'entrées que le temps écoulé en exige (au plus 4 d'un coup).
  const t0 = performance.now();
  let sent = 0;
  const inputTimer = setInterval(() => {
    const due = Math.floor(((performance.now() - t0) * NET_TICK) / 1000);
    if (due - sent > 4) sent = due - 4; // retard trop grand (processus suspendu) : on l'abandonne
    for (; sent < due; sent++) for (const b of live) b.sendInput();
  }, 1000 / NET_TICK);

  const pingTimer = setInterval(() => {
    for (const b of live) b.room?.send(MSG.ping, performance.now());
  }, 1000);

  // Statistiques périodiques.
  let lastT = performance.now();
  let lastSnaps = 0;
  let lastBytes = 0;
  const report = (final = false) => {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    const snaps = live.reduce((s, b) => s + b.snaps, 0);
    const bytes = live.reduce((s, b) => s + b.bytes, 0);
    const dSnaps = snaps - lastSnaps;
    const dBytes = bytes - lastBytes;
    const rtts = live.flatMap((b) => b.rtt.splice(0)).sort((a, b) => a - b);
    const rtt = rtts.length ? `${rtts[Math.floor(rtts.length / 2)].toFixed(1)} ms` : '—';
    const lag = live.map((b) => b.seq - 1 - b.lastAck);
    console.log(
      `[bots] ${live.length - closed}/${args.count} connecté(s) | ${(dSnaps / dt / live.length).toFixed(1)} instantanés/s par bot` +
        ` | taille moy. ${dSnaps ? Math.round(dBytes / dSnaps) : 0} o | ${(dBytes / dt / 1024).toFixed(1)} Kio/s reçus au total` +
        ` (${(dBytes / dt / live.length / 1024).toFixed(1)} par bot) | RTT médian ${rtt} | entrées en attente max ${Math.max(...lag)}` +
        (final ? ` | total ${snaps} instantanés` : ''),
    );
    lastT = now;
    lastSnaps = snaps;
    lastBytes = bytes;
  };
  const statsTimer = setInterval(report, 5000);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(inputTimer);
    clearInterval(pingTimer);
    clearInterval(statsTimer);
    report(true);
    await Promise.allSettled(live.map((b) => b.room!.leave()));
    console.log('[bots] terminé');
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (args.seconds > 0) setTimeout(stop, args.seconds * 1000);
}

main().catch((err) => {
  console.error('[bots] erreur :', err);
  process.exit(1);
});
