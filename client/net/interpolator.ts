// Interpolation des entités distantes : elles sont affichées avec un léger recul (~100 ms),
// en glissant entre deux instantanés, au « tick de rendu » estimé à partir de l'horloge du serveur.
import { NET_TICK, type Snapshot } from '../../shared/net/protocol';
import type { Enemy, Orb, Player, Projectile } from '../../shared/types';
import { ServerClock } from './clock';

/** Entités distantes à afficher à un tick de rendu donné. */
export interface InterpSample {
  players: Player[];
  enemies: Enemy[];
  projectiles: Projectile[];
  orbs: Orb[];
}

/** Durée conservée dans le tampon (ticks, ~1 s). */
const BUFFER_TICKS = 60;
/** Extrapolation maximale au-delà du dernier instantané (ticks). */
const MAX_EXTRAP_TICKS = 3;
/** Saut entre deux instantanés au-delà duquel on ne glisse pas : téléportation (px). */
const TELEPORT_PX = 120;
/** Borne dure du tampon (instantanés), même si le rendu prend du retard. */
const MAX_BUFFERED = 120;
const TICK_S = 1 / NET_TICK;

/** Entité interpolable : position et vitesse, identifiée par `id`. */
interface Entity {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Copie indépendante : les tableaux et objets imbriqués sont dupliqués (un niveau). */
function clone<T extends object>(e: T): T {
  const c = { ...e } as Record<string, unknown>;
  for (const k in c) {
    const v = c[k];
    if (Array.isArray(v)) c[k] = v.slice();
    else if (v !== null && typeof v === 'object') c[k] = { ...(v as object) };
  }
  return c as T;
}

/** Interpolation d'angle par le plus court chemin. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Avance `stateT` de `dt` ticks si l'entité n'est pas figée (hit-stop). */
function advanceStateT(c: Record<string, unknown>, dt: number): void {
  if (typeof c.stateT === 'number' && (typeof c.freeze !== 'number' || c.freeze === 0)) c.stateT = c.stateT + dt;
}

/** Copie de `e` extrapolée de `dt` ticks par sa vitesse. */
function extrapolate<T extends Entity>(e: T, dt: number): T {
  const c = clone(e);
  if (dt > 0) {
    c.x += c.vx * dt * TICK_S;
    c.y += c.vy * dt * TICK_S;
    advanceStateT(c as unknown as Record<string, unknown>, dt);
  }
  return c;
}

/**
 * Entités d'une liste au tick `r`, entre `a` (instantané s0, tick t0) et `b` (s1, tick t1), t0 ≤ r < t1.
 * Champs discrets : ceux de s0. Entité absente de s1 : encore là (elle disparaît à t1).
 * Entité absente de s0 : pas encore là (elle apparaît à t1).
 */
function between<T extends Entity>(a: readonly T[], b: readonly T[], t0: number, t1: number, r: number, skip = -1): T[] {
  const next = new Map<number, T>();
  for (const e of b) next.set(e.id, e);
  const k = (r - t0) / (t1 - t0);
  const dt = r - t0;
  const out: T[] = [];
  for (const e0 of a) {
    if (e0.id === skip) continue;
    const e1 = next.get(e0.id);
    if (!e1) {
      out.push(extrapolate(e0, Math.min(dt, MAX_EXTRAP_TICKS)));
      continue;
    }
    const c = clone(e0);
    if (Math.hypot(e1.x - e0.x, e1.y - e0.y) <= TELEPORT_PX) {
      c.x = e0.x + (e1.x - e0.x) * k;
      c.y = e0.y + (e1.y - e0.y) * k;
      c.vx = e0.vx + (e1.vx - e0.vx) * k;
      c.vy = e0.vy + (e1.vy - e0.vy) * k;
      const rc = c as unknown as Record<string, unknown>;
      const r0 = e0 as unknown as Record<string, unknown>;
      const r1 = e1 as unknown as Record<string, unknown>;
      if (typeof r0.aimAng === 'number' && typeof r1.aimAng === 'number') rc.aimAng = lerpAngle(r0.aimAng, r1.aimAng, k);
      if (r0.state === r1.state) advanceStateT(rc, dt);
    }
    // Sinon téléportation : la position reste celle de s0 jusqu'à t1, puis bascule.
    out.push(c);
  }
  return out;
}

export class Interpolator {
  /** Instantanés reçus, par tick strictement croissant (~1 s). */
  private buf: Snapshot[] = [];
  private lastR = -Infinity;
  /** Horloge serveur estimée (publique pour le HUD et les tests). */
  readonly clock = new ServerClock();
  /** Appels à `sample` dont le tick de rendu dépasse le dernier instantané reçu. */
  underruns = 0;

  /** `now` : horloge en ms (injectable pour les tests). */
  constructor(readonly now: () => number) {}

  /** Instantané appliqué (dans l'ordre des ticks) ; `recvAt` : heure de réception (ms). */
  push(s: Snapshot, recvAt: number): void {
    const last = this.buf[this.buf.length - 1];
    if (last && s.t <= last.t) return; // doublon ou retardataire
    // Nouvelle étape : jamais d'interpolation d'un niveau à l'autre (l'horloge est gardée).
    if (last && s.stage !== last.stage) this.buf.length = 0;
    this.buf.push(s);
    this.clock.observe(s.t, recvAt);
    // On garde ~1 s, et toujours l'instantané qui encadre le tick de rendu courant.
    const keepFrom = Number.isFinite(this.lastR) ? Math.min(s.t - BUFFER_TICKS, this.lastR) : s.t - BUFFER_TICKS;
    while (this.buf.length > 2 && (this.buf[1].t <= keepFrom || this.buf.length > MAX_BUFFERED)) this.buf.shift();
  }

  /**
   * Tick serveur à afficher pour les entités distantes, à l'instant `now` (ms). Fractionnaire, monotone,
   * jamais au-delà de ce qui est réellement affiché (dernier instantané + extrapolation) : faute
   * d'instantané, l'horloge s'arrête (c'est aussi le tick de vue jugé par la compensation de latence).
   */
  renderTick(now: number): number {
    if (!this.buf.length) return 0;
    const shown = this.buf[this.buf.length - 1].t + MAX_EXTRAP_TICKS;
    const d = this.clock.delayTicks();
    const r = Math.min(this.clock.tickAt(now, shown + d) - d, shown);
    if (r > this.lastR) this.lastR = r;
    return Math.max(0, this.lastR);
  }

  /** Entités distantes au tick de rendu `tick` (le joueur `excludeId` est exclu : il est prédit). */
  sample(tick: number, excludeId: number): InterpSample {
    const buf = this.buf;
    if (!buf.length) return { players: [], enemies: [], projectiles: [], orbs: [] };
    const newest = buf[buf.length - 1];
    if (tick > newest.t) this.underruns++;
    const at = this.bracket(tick);
    if (!at) {
      // Avant le premier instantané ou au-delà du dernier : extrapolation bornée puis figé.
      const s = tick >= newest.t ? newest : buf[0];
      const dt = tick >= newest.t ? Math.min(tick - newest.t, MAX_EXTRAP_TICKS) : 0;
      return {
        players: s.others.filter((p) => p.id !== excludeId).map((p) => extrapolate(p, dt)),
        enemies: s.enemies.map((e) => extrapolate(e, dt)),
        projectiles: s.projectiles.map((a) => extrapolate(a, dt)),
        orbs: s.orbs.map((o) => extrapolate(o, dt)),
      };
    }
    const [s0, s1] = at;
    return {
      players: between(s0.others, s1.others, s0.t, s1.t, tick, excludeId),
      enemies: between(s0.enemies, s1.enemies, s0.t, s1.t, tick),
      projectiles: between(s0.projectiles, s1.projectiles, s0.t, s1.t, tick),
      orbs: between(s0.orbs, s1.orbs, s0.t, s1.t, tick),
    };
  }

  /** Ennemis tels qu'affichés au tick de vue `tick` : copies modifiables (prédiction des coups). */
  enemiesAt(tick: number): Enemy[] {
    const buf = this.buf;
    if (!buf.length) return [];
    const at = this.bracket(tick);
    if (!at) {
      const newest = buf[buf.length - 1];
      const s = tick >= newest.t ? newest : buf[0];
      const dt = tick >= newest.t ? Math.min(tick - newest.t, MAX_EXTRAP_TICKS) : 0;
      return s.enemies.map((e) => extrapolate(e, dt));
    }
    const [s0, s1] = at;
    return between(s0.enemies, s1.enemies, s0.t, s1.t, tick);
  }

  /** Les deux instantanés qui encadrent `r` (s0.t ≤ r < s1.t), ou null hors du tampon. */
  private bracket(r: number): [Snapshot, Snapshot] | null {
    const buf = this.buf;
    if (buf.length < 2 || r < buf[0].t || r >= buf[buf.length - 1].t) return null;
    for (let i = buf.length - 2; i >= 0; i--) if (buf[i].t <= r) return [buf[i], buf[i + 1]];
    return null;
  }

  reset(): void {
    this.buf = [];
    this.lastR = -Infinity;
    this.clock.reset();
    this.underruns = 0;
  }
}
