// Tests de l'horloge serveur estimée face aux décrochages : gel du serveur (pas perdus, chronologie
// reculée), hausse de latence, coupure du lien descendant (rafale TCP), pic de latence passager.
// Vérifie : le rendu ne dépasse jamais les instantanés reçus, se recale en moins d'une seconde après un
// recul de la chronologie (sans jamais reculer), et le tick de vue envoyé au serveur est celui de l'état
// réellement affiché (compensation de latence juste).
// Lancer : npx esbuild tests/clock.test.ts --bundle --platform=node --format=esm --log-level=warning --outfile=node_modules/.cache/clock.test.mjs && node node_modules/.cache/clock.test.mjs
export {};
import { ServerClock } from '../client/net/clock';
import { BTN } from '../shared/input';
import { NET_TICK } from '../shared/net/protocol';
import { NetBench } from './net/harness';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const TICKS_PER_MS = NET_TICK / 1000;
const FRAME_MS = 1000 / 60;
/** Extrapolation maximale de l'interpolateur au-delà du dernier instantané (ticks). */
const MAX_EXTRAP = 3;

// ---------------------------------------------------------------------------
// 1. Horloge seule : plafond, recul de la chronologie, rafale, trou de mesures.
// ---------------------------------------------------------------------------
{
  // 1a. Plafond : l'horloge s'y arrête sans reculer ; levé, le retard est repris d'un coup.
  const c = new ServerClock();
  c.observe(0, 0);
  let prev = c.tickAt(0, 10);
  let mono = true;
  let over = -Infinity;
  for (let t = FRAME_MS; t <= 500; t += FRAME_MS) {
    const v = c.tickAt(t, 10);
    if (v < prev) mono = false;
    over = Math.max(over, v - 10);
    prev = v;
  }
  check('plafond : l’horloge s’arrête au tick plafond, sans recul', mono && over <= 1e-9 && Math.abs(prev - 10) < 1e-9, `dépassement max ${over.toFixed(2)} tick, final ${prev.toFixed(2)}`);
  const t1 = 500 + FRAME_MS;
  const back = c.tickAt(t1);
  check('plafond levé : retard repris d’un coup (instantanés retardés, chronologie intacte)', Math.abs(back - t1 * TICKS_PER_MS) < 0.05, `${back.toFixed(2)} pour ${(t1 * TICKS_PER_MS).toFixed(2)}`);
}
{
  // 1b. Chronologie reculée de 25 ticks (pas perdus) : recalage en moins d'une seconde, jamais de recul.
  // Instantanés tous les 50 ms, 50 ms de latence ; recul à T0.
  const SHIFT = 25;
  const T0 = 3000;
  const c = new ServerClock();
  const snapAt = (at: number): number => (at - 50) * TICKS_PER_MS - (at > T0 ? SHIFT : 0);
  let next = 0;
  let prev = -Infinity;
  let mono = true;
  let lastAhead = -1;
  for (let t = 0; t <= 8000; t += FRAME_MS) {
    while (next <= t) {
      c.observe(snapAt(next), next);
      next += 50;
    }
    const v = c.tickAt(t);
    if (v < prev) mono = false;
    prev = v;
    // En avance de plus d'un tick sur la nouvelle estimation : le rendu dépasserait les instantanés.
    if (t > T0 && v > (t - 50) * TICKS_PER_MS - SHIFT + 1) lastAhead = t;
  }
  check('chronologie reculée de 25 ticks : horloge recalée en moins de 1 s', lastAhead - T0 < 1000, `encore en avance ${(lastAhead - T0).toFixed(0)} ms après le recul`);
  check('… sans jamais reculer', mono);
}
{
  // 1c. Rafale sans recul de chronologie (lien bloqué 500 ms puis tout arrive d'un coup, en retard) :
  // ce n'est pas un recul, l'estimation est gardée (l'horloge reste sur la chronologie du serveur).
  const c = new ServerClock();
  let worst = 0;
  const sent: number[] = [];
  for (let at = 0; at <= 6000; at += 50) sent.push(at);
  let k = 0;
  for (let t = 0; t <= 6000; t += FRAME_MS) {
    // Envoyés entre 3000 et 3500 ms : reçus ensemble à 3500 ms ; sinon 50 ms après l'envoi.
    while (k < sent.length && (sent[k] >= 3000 && sent[k] < 3500 ? 3500 : sent[k] + 50) <= t) {
      const recv = sent[k] >= 3000 && sent[k] < 3500 ? 3500 : sent[k] + 50;
      c.observe(sent[k] * TICKS_PER_MS, recv);
      k++;
    }
    const v = c.tickAt(t);
    if (t > 3500) worst = Math.max(worst, Math.abs(v - (t - 50) * TICKS_PER_MS));
  }
  check('rafale (coupure puis tout d’un coup) : estimation gardée, horloge à moins d’un tick', worst < 1, `écart max ${worst.toFixed(2)} tick`);
}
for (const G of [2000, 3000, 5000]) {
  // 1d. Trou de mesures plus long que la fenêtre (gel du serveur de G ms, reprise plafonnée à 5 pas) :
  // la fenêtre est vidée, le recul n'y est pas vu. Plafond de l'interpolateur (dernier instantané +
  // extrapolation + délai) : l'estimation, en avance pendant le trou, revient sur la nouvelle chronologie.
  const SHIFT = G * TICKS_PER_MS - 5;
  const T0 = 3000;
  const c = new ServerClock();
  const snapAt = (at: number): number => at * TICKS_PER_MS - (at >= T0 + G ? SHIFT : 0);
  let sent = 0;
  let newest = -Infinity;
  let prev = -Infinity;
  let mono = true;
  let over = -Infinity;
  const T1 = T0 + G + 50; // première mesure après le trou
  let lastOff = T1;
  for (let t = 50; t <= T1 + 3000; t += FRAME_MS) {
    while (sent + 50 <= t) {
      if (sent < T0 || sent >= T0 + G) {
        c.observe(snapAt(sent), sent + 50);
        newest = snapAt(sent);
      }
      sent += 50;
    }
    const cap = newest + MAX_EXTRAP + c.delayTicks();
    const v = c.tickAt(t, cap);
    if (v < prev) mono = false;
    prev = v;
    over = Math.max(over, v - cap);
    if (t >= T1 && Math.abs(v - snapAt(t - 50)) > 1) lastOff = t;
  }
  check(`trou de mesures de ${G} ms (fenêtre vidée) : horloge à ±1 tick de la nouvelle chronologie en moins de 1 s`, lastOff - T1 < 1000, `écart > 1 tick jusqu’à ${(lastOff - T1).toFixed(0)} ms après la reprise`);
  check(`… sans jamais reculer ni dépasser le plafond`, mono && over <= 1e-9, `dépassement max ${over.toFixed(2)} tick`);
}

// ---------------------------------------------------------------------------
// 2. Banc réseau : B regarde A (50 ms + gigue 10 ms) pendant un décrochage.
// ---------------------------------------------------------------------------
type Kind = 'gel du serveur' | 'latence en hausse' | 'coupure' | 'pic de latence';
interface Outcome {
  /** Images de B en sous-alimentation après la fin de l'événement, et délai de la dernière (ms). */
  under: number;
  lastUnderMs: number;
  /** Tick de vue envoyé au-delà de l'état affiché (dernier instantané + extrapolation), en ticks. */
  viewOver: number;
  backwards: number;
  /** Retard de l'horloge (tick serveur − tick de rendu − délai) : avant l'événement, et pire écart à ce retard de 1,5 s à 4 s après. */
  behind0: number;
  behindDrift: number;
  /** Délai après la fin de l'événement jusqu'au retour durable du retard à ±1 tick de son niveau d'avant (ms). */
  settleMs: number;
}
/** `ms` : durée de l'événement, ou hausse de la latence (latence en hausse) ; `upMs` : hausse pendant un pic de latence. */
function decrochage(kind: Kind, ms: number, upMs = ms, seed = 3): Outcome {
  const bench = new NetBench({ seed, lagMs: 50, jitterMs: 10 });
  bench.addClient('A');
  const B = bench.addClient('B');
  const w = bench.session.world;
  const calm = (): void => {
    w.spawnTimer = 1e6;
    for (const p of w.players) p.iframes = 1e6;
  };
  // A va et vient ; B ne bouge pas.
  const input = (i: number, f: number): number => (i === 0 ? (Math.floor(f / 90) % 2 ? BTN.LEFT : BTN.RIGHT) : 0);
  // Dernier instantané appliqué par B, et tick de vue de chacune de ses entrées (envoyées avant les instantanés de l'image).
  let newest = -1;
  const push = B.src.interp.push.bind(B.src.interp);
  B.src.interp.push = (s, at) => {
    newest = Math.max(newest, s.t);
    push(s, at);
  };
  let viewOver = -Infinity;
  const send = B.transport.sendInput.bind(B.transport);
  B.transport.sendInput = (m) => {
    if (m.v !== undefined && newest >= 0) viewOver = Math.max(viewOver, m.v - (newest + MAX_EXTRAP));
    send(m);
  };
  let lastR = -Infinity;
  let backwards = 0;
  let behind: number[] = [];
  const track = (): void => {
    calm();
    const r = B.src.interp.renderTick(bench.clock.t);
    if (r < lastR) backwards++;
    lastR = r;
    // Retard de l'horloge elle-même : le délai d'interpolation, qui suit la gigue mesurée, est retiré.
    behind.push(bench.session.world.tick - r - B.src.interp.clock.delayTicks());
  };
  bench.run(5000, input, track);
  const behind0 = behind.slice(-120).reduce((a, b) => a + b, 0) / 120;
  const down = B.transport.down as unknown as { opts: { lagMs: number }; flush(): void };
  if (kind === 'gel du serveur') bench.freezeServer(ms, input, track);
  else if (kind === 'latence en hausse') down.opts.lagMs = 50 + ms;
  else if (kind === 'pic de latence') {
    down.opts.lagMs = 50 + upMs;
    bench.run(ms, input, track);
    down.opts.lagMs = 50;
  } else {
    // Lien descendant bloqué (TCP) : rien n'arrive, puis tout d'un coup.
    const flush = down.flush;
    down.flush = () => undefined;
    bench.run(ms, input, track);
    down.flush = flush;
  }
  const u0 = B.src.interp.underruns;
  const f0 = bench.metrics.frames;
  let seen = u0;
  let lastUnder = -1;
  let lastOff = -1;
  behind = [];
  bench.run(4000, input, (f) => {
    track();
    if (Math.abs(behind[behind.length - 1] - behind0) > 1) lastOff = f;
    if (B.src.interp.underruns !== seen) {
      seen = B.src.interp.underruns;
      lastUnder = f;
    }
  });
  const drift = Math.max(...behind.slice(90).map((x) => Math.abs(x - behind0)));
  return {
    under: B.src.interp.underruns - u0,
    lastUnderMs: lastUnder < 0 ? 0 : (lastUnder - f0 + 1) * FRAME_MS,
    viewOver,
    backwards,
    behind0,
    behindDrift: drift,
    settleMs: lastOff < 0 ? 0 : (lastOff - f0 + 1) * FRAME_MS,
  };
}
const fmt = (o: Outcome): string =>
  `${o.under} sous-alimentation(s) ensuite, la dernière ${o.lastUnderMs.toFixed(0)} ms après, v − affiché max ${o.viewOver}, retard d’horloge ${o.behind0.toFixed(1)} ticks, écart ensuite ${o.behindDrift.toFixed(1)}, à ±1 tick ${o.settleMs.toFixed(0)} ms après`;
// Au-delà de ~1,9 s, la fenêtre de mesures est vidée par le trou : le recul n'y est pas vu.
for (const ms of [250, 500, 1000, 2000, 3000, 5000]) {
  const o = decrochage('gel du serveur', ms);
  check(`gel du serveur ${ms} ms : interpolation rétablie en moins de 1 s après la reprise`, o.lastUnderMs < 1000, fmt(o));
  check(`gel du serveur ${ms} ms : horloge revenue à ±1 tick de la chronologie en moins de 1 s`, o.settleMs < 1000, fmt(o));
  check(`gel du serveur ${ms} ms : tick de vue jamais au-delà de l’état affiché, rendu monotone`, o.viewOver <= 0 && o.backwards === 0, fmt(o));
}
for (const ms of [150, 250]) {
  const o = decrochage('latence en hausse', ms);
  check(`latence descendante 50 → ${50 + ms} ms : interpolation rétablie en moins de 1 s`, o.lastUnderMs < 1000 && o.viewOver <= 0 && o.backwards === 0, fmt(o));
}
// Témoins sans recul de la chronologie : rien n'est perdu, l'horloge y revient vite.
for (const ms of [250, 500, 1000]) {
  const o = decrochage('coupure', ms);
  check(`coupure du lien descendant ${ms} ms (rafale) : horloge revenue sur la chronologie (< 1 tick d’écart dès 1,5 s)`, o.behindDrift < 1 && o.viewOver <= 0 && o.backwards === 0, fmt(o));
}
// Pics courts, et plus longs que la fenêtre de mesures (2 s) : le recul supposé reste dû, repris d'un coup au retour.
for (const [ms, up] of [[250, 250], [500, 500], [2500, 200], [3000, 200]]) {
  const o = decrochage('pic de latence', ms, up);
  check(`pic de latence passager +${up} ms pendant ${ms} ms : horloge revenue à ±1 tick de la chronologie en moins de 1 s (pas de rattrapage lent à +5 %)`, o.settleMs < 1000 && o.behindDrift < 1 && o.viewOver <= 0 && o.backwards === 0, fmt(o));
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests de l’horloge face aux décrochages passent.');
