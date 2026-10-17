// Tournoi du dojo : 8 places, élimination directe (quarts, demies, finale), matchs en duels iaidō BO3
// joués en parallèle dans chaque tour. Le tournoi part quand la salle est pleine ou que tous les présents
// sont prêts (G), sinon au bout de l'attente, des bots complétant les places. Déterministe (w.rng, hachages),
// donc simulable et testable sans réseau, comme le reste de la simulation.
import { DOJO, DUEL, DUEL_WHY } from './constants';
import { BOT_NAMES, botButtons } from './dojoBot';
import { dojoSpot } from './dojoLevel';
import { DOJO_DUEL_RULES, forfeit, stepDuels, stepForfeits, startDuel } from './duel';
import { BTN } from './input';
import { stageSeed as hash } from './math';
import { PLAYER_COLORS } from './net/protocol';
import { stepPlayer } from './player';
import type { DojoEntrant, DojoMatch, Player, Tournament, World } from './types';
import { addPlayer, removePlayer } from './world';

/** Tournoi vierge (attente, personne). */
export function createTournament(): Tournament {
  return { n: 1, phase: 'waiting', t: 0, startAt: -1, round: -1, entrants: [], matches: [], champion: -1 };
}

/** État serveur hors instantané : dernier appui de chaque humain, réactions suspectes, disqualifiés. */
interface Hidden {
  lastPress: Map<number, number>;
  fast: Map<number, number>;
  dq: Set<number>;
}
const hidden = new WeakMap<Tournament, Hidden>();
function hiddenOf(t: Tournament): Hidden {
  let h = hidden.get(t);
  if (!h) hidden.set(t, (h = { lastPress: new Map(), fast: new Map(), dq: new Set() }));
  return h;
}

/** Index des matchs d'un tour dans `matches` (quarts 0-3, demies 4-5, finale 6). */
const FIRST: readonly number[] = [0, 4, 6];
const COUNT: readonly number[] = [4, 2, 1];

const entrantOf = (t: Tournament, pid: number): DojoEntrant | undefined => t.entrants.find((e) => e.pid === pid);
const isBot = (t: Tournament, pid: number): boolean => entrantOf(t, pid)?.bot === true;

/**
 * Un pas du dojo (à la place du pas de la route) : boutons des bots, abandons tenus, joueurs, duels, puis
 * le tournoi. Ni ennemis, ni Marée, ni étapes.
 */
export function stepDojo(w: World, inputs: Map<number, number>): void {
  const t = (w.tournament ??= createTournament());
  w.duels ??= [];
  for (const e of t.entrants) if (e.bot && !e.gone) inputs.set(e.pid, botButtons(w, e.pid));
  // Fronts montants de G (prêt, en attente), avant que stepPlayer ne mette prevButtons à jour.
  const readied: number[] = [];
  const h = hiddenOf(t);
  for (const p of w.players) {
    const b = inputs.get(p.id) ?? 0;
    if (b & BTN.DUEL && !(p.prevButtons & BTN.DUEL)) readied.push(p.id);
    if (b !== 0) h.lastPress.set(p.id, w.tick);
  }
  stepForfeits(w, inputs);
  for (const p of w.players) stepPlayer(w, p, inputs.get(p.id) ?? 0);
  stepDuels(w);
  stepTournament(w, t, readied);
}

function stepTournament(w: World, t: Tournament, readied: number[]): void {
  t.t++;
  // Participants partis (forfait de leurs matchs ; nom et couleur restent au tableau).
  for (const e of t.entrants) if (!e.gone && !w.players.some((p) => p.id === e.pid)) e.gone = true;
  switch (t.phase) {
    case 'waiting':
      return stepWaiting(w, t, readied);
    case 'pause':
      if (t.t >= DOJO.ROUND_PAUSE) launchRound(w, t);
      return;
    case 'running':
      return stepRunning(w, t);
    case 'done':
      if (t.t >= DOJO.CHAMPION_TICKS) resetTournament(w, t);
      return;
  }
}

// ─── Attente ────────────────────────────────────────────────────────────────

function stepWaiting(w: World, t: Tournament, readied: number[]): void {
  // Les présents sont les participants (les partis sont retirés : rien n'a commencé).
  t.entrants = t.entrants.filter((e) => !e.gone);
  for (const p of w.players) {
    if (t.entrants.length >= DOJO.SIZE) break;
    if (!entrantOf(t, p.id)) t.entrants.push({ pid: p.id, name: p.name, color: p.color, bot: false, gone: false, ready: false });
  }
  for (const pid of readied) {
    const e = entrantOf(t, pid);
    if (e) e.ready = true;
  }
  if (!t.entrants.length) {
    t.startAt = -1;
    return;
  }
  if (t.startAt < 0) t.startAt = w.tick + DOJO.WAIT_TICKS;
  // Salle pleine, ou tous les présents prêts : départ anticipé.
  if (t.entrants.length >= DOJO.SIZE || t.entrants.every((e) => e.ready)) t.startAt = Math.min(t.startAt, w.tick + DOJO.FULL_DELAY);
  if (w.tick >= t.startAt) drawBracket(w, t);
}

/** Couleur libre parmi les joueurs présents (bots compris). */
function freeColor(w: World): number {
  for (let c = 0; c < PLAYER_COLORS; c++) if (!w.players.some((p) => p.color === c)) return c;
  return w.players.length % PLAYER_COLORS;
}

/** Fin de l'attente : des bots complètent les places, puis le tableau est tiré au sort (w.rng). */
function drawBracket(w: World, t: Tournament): void {
  const taken = new Set(w.players.map((p) => p.name));
  const names = BOT_NAMES.filter((n) => !taken.has(n));
  while (t.entrants.length < DOJO.SIZE) {
    const name = names.length ? names.splice(Math.floor(w.rng.next() * names.length), 1)[0] : `Kage ${t.entrants.length + 1}`;
    const p = addPlayer(w, name, { color: freeColor(w) });
    t.entrants.push({ pid: p.id, name: p.name, color: p.color, bot: true, gone: false, ready: false });
  }
  const es = t.entrants;
  for (let i = es.length - 1; i > 0; i--) {
    const j = Math.floor(w.rng.next() * (i + 1));
    [es[i], es[j]] = [es[j], es[i]];
  }
  for (const e of es) e.ready = false;
  const m = (round: number, a = -1, b = -1): DojoMatch => ({ round, a, b, state: 'pending', winner: -1, why: -1, wa: 0, wb: 0, duel: -1 });
  t.matches = [m(0, es[0].pid, es[1].pid), m(0, es[2].pid, es[3].pid), m(0, es[4].pid, es[5].pid), m(0, es[6].pid, es[7].pid), m(1), m(1), m(2)];
  t.round = 0;
  t.phase = 'pause';
  t.t = 0;
  t.startAt = -1;
  const h = hiddenOf(t);
  h.fast.clear();
  h.dq.clear();
  w.events.push({ type: 'dojoStart', n: t.n });
}

// ─── Tours ──────────────────────────────────────────────────────────────────

const present = (w: World, pid: number): Player | undefined => w.players.find((p) => p.id === pid);

/** Tirage au sort d'un match sans duel (les deux partis) : hachage du tournoi et du match. */
const lotOf = (t: Tournament, k: number, m: DojoMatch): number => (hash(t.n, k) & 1 ? m.a : m.b);

/** Lance les matchs du tour : un duel par match, ou un forfait sans duel si un participant est parti. */
function launchRound(w: World, t: Tournament): void {
  const from = FIRST[t.round];
  const h = hiddenOf(t);
  for (let k = from; k < from + COUNT[t.round]; k++) {
    const m = t.matches[k];
    if (m.state !== 'pending') continue;
    const pa = present(w, m.a);
    const pb = present(w, m.b);
    if (!pa || !pb) {
      finish(w, t, k, pa ? m.a : pb ? m.b : lotOf(t, k, m), pa || pb ? DUEL_WHY.DISCONNECT : DUEL_WHY.LOT, 0, 0);
      continue;
    }
    const d = startDuel(w, pa, pb, DOJO_DUEL_RULES, dojoSpot(t.round, k - from));
    if (!d) continue; // réessayé au pas suivant (le tour ne commence qu'une fois tous ses duels lancés)
    m.state = 'live';
    m.duel = d.id;
    h.lastPress.set(m.a, w.tick);
    h.lastPress.set(m.b, w.tick);
    w.events.push({ type: 'dojoMatch', match: k, a: m.a, b: m.b });
  }
  if (t.matches.slice(from, from + COUNT[t.round]).every((m) => m.state !== 'pending')) {
    t.phase = 'running';
    t.t = 0;
  }
}

function stepRunning(w: World, t: Tournament): void {
  const from = FIRST[t.round];
  const h = hiddenOf(t);
  for (let k = from; k < from + COUNT[t.round]; k++) {
    const m = t.matches[k];
    if (m.state !== 'live') continue;
    const d = w.duels?.find((x) => x.id === m.duel);
    if (!d) {
      // Duel disparu sans phase de fin observée (ne devrait pas arriver) : le présent passe.
      const winner = present(w, m.a) ? m.a : present(w, m.b) ? m.b : lotOf(t, k, m);
      finish(w, t, k, winner, DUEL_WHY.DISCONNECT, m.wa, m.wb);
      continue;
    }
    const wa = d.a.pid === m.a ? d.a.wins : d.b.wins;
    const wb = d.a.pid === m.a ? d.b.wins : d.a.wins;
    m.wa = wa;
    m.wb = wb;
    if (d.phase === 'end') {
      let winner = d.winner >= 0 ? d.winner : d.a.pid; // pas de nul au dojo (garde-fou)
      let why = d.last;
      // Disqualifié : il ne passe jamais, même s'il a gagné la série.
      if (h.dq.has(winner)) {
        winner = winner === m.a ? m.b : m.a;
        why = DUEL_WHY.SUSPECT;
      }
      finish(w, t, k, winner, why, wa, wb);
      continue;
    }
    // Fin d'une manche : réactions trop rapides d'un humain (DOJO.SUSPECT_LIMIT dans le tournoi : disqualifié).
    if (d.phase === 'resolve' && d.t === 0) {
      for (const s of [d.a, d.b]) {
        if (isBot(t, s.pid) || s.foul || s.react < 0 || s.react >= DUEL.SUSPECT_REACT) continue;
        const n = (h.fast.get(s.pid) ?? 0) + 1;
        h.fast.set(s.pid, n);
        if (n >= DOJO.SUSPECT_LIMIT && !h.dq.has(s.pid)) {
          h.dq.add(s.pid);
          forfeit(w, s.pid, DUEL_WHY.SUSPECT);
        }
      }
    }
    // Humain sans aucun bouton depuis ABSENT_TICKS : forfait.
    for (const pid of [m.a, m.b]) {
      if (isBot(t, pid)) continue; // (sans effet si le duel vient de finir : forfeit l'ignore)
      if (w.tick - (h.lastPress.get(pid) ?? w.tick) > DOJO.ABSENT_TICKS) forfeit(w, pid, DUEL_WHY.ABSENT);
    }
  }
  // Tour terminé quand tous ses matchs le sont et que les duellistes sont libérés.
  const round = t.matches.slice(from, from + COUNT[t.round]);
  if (round.every((m) => m.state === 'done') && !w.duels?.length) {
    if (t.round < 2) {
      t.round++;
      t.phase = 'pause';
    } else {
      t.phase = 'done';
      t.champion = t.matches[6].winner;
      w.events.push({ type: 'dojoChampion', pid: t.champion, n: t.n });
    }
    t.t = 0;
  }
}

/** Résultat d'un match ; le vainqueur prend sa place au tour suivant (le tableau progresse aussitôt). */
function finish(w: World, t: Tournament, k: number, winner: number, why: number, wa: number, wb: number): void {
  const m = t.matches[k];
  m.state = 'done';
  m.winner = winner;
  m.why = why;
  m.wa = wa;
  m.wb = wb;
  m.duel = -1;
  w.events.push({ type: 'dojoResult', match: k, winner, why, wa, wb });
  if (k < 6) {
    const next = t.matches[k < 4 ? 4 + (k >> 1) : 6];
    if (k % 2 === 0) next.a = winner;
    else next.b = winner;
  }
}

// ─── Fin du tournoi ─────────────────────────────────────────────────────────

/** Après le champion : les bots s'en vont, les présents attendent le tournoi suivant. */
function resetTournament(w: World, t: Tournament): void {
  for (const e of t.entrants) if (e.bot && present(w, e.pid)) removePlayer(w, e.pid);
  const n = t.n + 1;
  Object.assign(t, createTournament(), { n });
  hidden.delete(t);
  w.events.push({ type: 'dojoReset', n });
}

