// Modèle de vue du tournoi du dojo (道場) : module pur (sans Phaser), testé par tests/dojoui.test.ts.
// Il traduit le tournoi du monde (w.tournament) en tableau prêt à dessiner (noms, 木人, scores,
// vainqueurs, partis, champion) et en lignes d'état ; BracketOverlay (bracket.ts) ne fait que les dessiner.
import { DOJO, DT, DUEL_WHY } from '../../shared/constants';
import type { DojoEntrant, DojoMatch, GameEvent, Tournament, TournamentPhase, World } from '../../shared/types';
import { playerColor } from '../render/palette';
import { BOT_MARK, whyLabel } from './duelView';

export { BOT_MARK };

export type DojoResultEvent = Extract<GameEvent, { type: 'dojoResult' }>;

/** Une place du tableau (participant). */
export interface BracketEntrantView {
  pid: number;
  /** Nom affiché, suffixé de 木人 pour un bot. */
  name: string;
  color: number; // teinte d'encre (hex)
  bot: boolean;
  gone: boolean; // a quitté la salle (nom gardé au tableau)
  ready: boolean; // attente : a appuyé sur G
  me: boolean;
}

/** Un match du tableau : quarts 0-3, demies 4-5, finale 6. */
export interface BracketMatchView {
  k: number;
  round: number;
  a: BracketEntrantView | null; // null : place encore à désigner par le tour précédent
  b: BracketEntrantView | null;
  state: DojoMatch['state'];
  winner: number;
  why: number;
  wa: number;
  wb: number;
  /** Manches gagnées par a et b (« 2 », « 1 ») ; vides sans duel joué (en attente, forfait au lancement). */
  sa: string;
  sb: string;
  /** Kanji d'une issue hors combat (不戦勝, 不在, 抽選, 反則, 降参), vide pour une victoire au sabre. */
  mark: string;
  mine: boolean;
}

export interface BracketModel {
  n: number;
  phase: TournamentPhase;
  round: number;
  /** « 道場 · Tournament 2 ». */
  title: string;
  /** État du tournoi : attente, « Quarterfinals in 4 s », « Semifinals », « 優勝 Champion: X ». */
  stage: string;
  /** Ligne propre au joueur local : « G: ready (2/3 ready) », « You face Musashi 木人 », « Eliminated by X ». */
  status: string;
  /** Ligne secondaire : touches utiles, délai du tournoi suivant. */
  detail: string;
  /** Attente : présents dans l'ordre d'arrivée ; après le tirage : les 8 places dans l'ordre du tableau. */
  entrants: BracketEntrantView[];
  /** 7 après le tirage, vide pendant l'attente. */
  matches: BracketMatchView[];
  champion: BracketEntrantView | null;
  /** Le joueur local est l'un des participants (sinon : il entrera au tournoi suivant). */
  entered: boolean;
  /** Son match du tour est en cours (le duel occupe l'écran : ni tableau ni panneau). */
  inMatch: boolean;
  eliminated: boolean;
  /** Signature du contenu dessiné (le tableau n'est redessiné que si elle change). */
  key: string;
}

/** Index du premier match et nombre de matchs de chaque tour. */
const FIRST: readonly number[] = [0, 4, 6];
const COUNT: readonly number[] = [4, 2, 1];
const ROUND_NAMES: readonly string[] = ['Quarterfinals', 'Semifinals', 'Final'];
const MATCH_NAMES: readonly string[] = ['quarterfinal', 'semifinal', 'final'];

/** Nom d'un tour : « Quarterfinals », « Semifinals », « Final » (vide hors tableau). */
export function roundName(round: number): string {
  return ROUND_NAMES[round] ?? '';
}

/** Secondes restantes (arrondies au supérieur, jamais négatives). */
const secs = (ticks: number): number => Math.max(0, Math.ceil(ticks * DT));

/** Nom affiché d'un participant : suffixé de 木人 pour un bot. */
export function entrantName(e: Pick<DojoEntrant, 'name' | 'bot'>): string {
  const n = e.name || 'ronin';
  return e.bot ? `${n} ${BOT_MARK}` : n;
}

/**
 * Courte mention d'une issue hors combat : « 不戦勝 opponent left », « 不在 absent », « 抽選 drawn by lot »,
 * « 反則 disqualified », « 降参 yielded » ; vide pour une victoire au sabre (ou un match sans issue).
 */
export function outcomeNote(why: number): string {
  switch (why) {
    case DUEL_WHY.WIN:
    case -1:
      return '';
    case DUEL_WHY.DISCONNECT:
      return '不戦勝 opponent left';
    case DUEL_WHY.ABSENT:
      return '不在 absent';
    case DUEL_WHY.LOT:
      return '抽選 drawn by lot';
    case DUEL_WHY.SUSPECT:
    case DUEL_WHY.FLOOD:
      return '反則 disqualified';
    case DUEL_WHY.FORFEIT:
      return '降参 yielded';
    default: {
      const l = whyLabel(why);
      return l.kanji ? `${l.kanji} ${l.text}` : '';
    }
  }
}

/** Kanji seul de cette issue (case du tableau). */
function outcomeMark(why: number): string {
  const s = outcomeNote(why);
  return s ? s.split(' ')[0] : '';
}

/**
 * Ligne d'attente complète : « Waiting for challengers 3/8 · 42 s · G: ready (2/3 ready) ».
 * Salle pleine, ou tous prêts : « The bracket is drawn in 3 s ».
 */
export function waitingLine(t: Tournament, tick: number, meId: number): string {
  const s = waitingStage(t, tick);
  const r = readyLine(t, meId);
  return r ? `${s} · ${r}` : s;
}

function waitingStage(t: Tournament, tick: number): string {
  const n = t.entrants.length;
  if (n === 0 || t.startAt < 0) return `Waiting for challengers ${n}/${DOJO.SIZE}`;
  const left = secs(t.startAt - tick);
  if (n >= DOJO.SIZE || t.entrants.every((e) => e.ready)) return `The bracket is drawn in ${left} s`;
  return `Waiting for challengers ${n}/${DOJO.SIZE} · ${left} s`;
}

/** « G: ready (2/3 ready) », ou « ready ✓ (2/3 ready) » une fois G pressé ; vide hors des participants. */
function readyLine(t: Tournament, meId: number): string {
  const me = t.entrants.find((e) => e.pid === meId);
  if (!me) return '';
  const n = t.entrants.length;
  const ready = t.entrants.filter((e) => e.ready).length;
  return `${me.ready ? 'ready ✓' : 'G: ready'} (${ready}/${n} ready)`;
}

/** Ligne du HUD : « 道場 · Tournament n · <état> ». */
export function dojoHudLine(t: Tournament, tick: number): string {
  return `道場 · Tournament ${t.n} · ${stageLine(t, tick)}`;
}

function nameIn(t: Tournament, pid: number): string {
  const e = t.entrants.find((x) => x.pid === pid);
  return e ? entrantName(e) : 'ronin';
}

function stageLine(t: Tournament, tick: number): string {
  switch (t.phase) {
    case 'waiting':
      return waitingStage(t, tick);
    case 'pause':
      return `${roundName(t.round)} in ${secs(DOJO.ROUND_PAUSE - t.t)} s`;
    case 'running':
      return roundName(t.round);
    case 'done':
      return t.champion >= 0 ? `優勝 Champion: ${nameIn(t, t.champion)}` : '優勝';
  }
}

/**
 * Match courant de `pid` : le plus avancé du tableau où il figure, sans dépasser le tour en cours (le
 * vainqueur d'une demie est inscrit en finale avant la fin de l'autre demie).
 */
function lastMatchOf(t: Tournament, pid: number): number {
  for (let k = t.matches.length - 1; k >= 0; k--) {
    const m = t.matches[k];
    if (m.round > t.round) continue;
    if (m.a === pid || m.b === pid) return k;
  }
  return -1;
}

/** Ligne propre au joueur local et ligne secondaire. */
function personal(t: Tournament, meId: number): { status: string; detail: string } {
  const tab = 'Tab: bracket';
  if (t.phase === 'waiting') {
    const r = readyLine(t, meId);
    if (!r) return { status: 'The bracket is full — you will enter the next tournament', detail: tab };
    return { status: r, detail: `${tab} · bots fill the empty places` };
  }
  const next = `next tournament in ${secs(DOJO.CHAMPION_TICKS - t.t)} s`;
  if (t.phase === 'done' && t.champion === meId) return { status: '優勝 You are the champion!', detail: next };
  const k = lastMatchOf(t, meId);
  if (k < 0) {
    return { status: 'The tournament is under way — you will enter the next one', detail: t.phase === 'done' ? next : tab };
  }
  const m = t.matches[k];
  const opp = m.a === meId ? m.b : m.a;
  const oppName = opp >= 0 ? nameIn(t, opp) : 'ronin';
  const detail = t.phase === 'done' ? next : tab;
  if (m.state !== 'done') {
    const gone = opp >= 0 && t.entrants.find((e) => e.pid === opp)?.gone === true;
    return { status: `You face ${oppName}${gone ? ' — they left' : ''}`, detail: `${MATCH_NAMES[m.round]} · ${detail}` };
  }
  const note = outcomeNote(m.why);
  if (m.winner === meId) {
    // Vainqueur d'un match dont le tour suivant n'est pas encore désigné (pause ou fin du tour en cours).
    const to = m.round < 2 ? ` to the ${ROUND_NAMES[m.round + 1].toLowerCase()}` : '';
    return { status: `You advance${to}${note ? ` · ${note}` : ''}`, detail };
  }
  const by = m.winner >= 0 ? nameIn(t, m.winner) : oppName;
  const score = m.wa + m.wb > 0 ? ` ${m.a === meId ? m.wa : m.wb}–${m.a === meId ? m.wb : m.wa}` : '';
  return { status: `Eliminated by ${by}${note ? ` · ${note}` : ''}`, detail: `${MATCH_NAMES[m.round]}${score} · ${detail}` };
}

function entrantView(e: DojoEntrant, meId: number): BracketEntrantView {
  return { pid: e.pid, name: entrantName(e), color: playerColor(e.color), bot: e.bot, gone: e.gone, ready: e.ready, me: e.pid === meId };
}

/** Modèle du tableau pour le joueur `meId` ; null hors du dojo. */
export function bracketView(w: World, meId: number): BracketModel | null {
  const t = w.tournament;
  if (!t) return null;
  const entrants = t.entrants.map((e) => entrantView(e, meId));
  const byPid = new Map(entrants.map((e) => [e.pid, e]));
  const at = (pid: number) => (pid >= 0 ? (byPid.get(pid) ?? null) : null);
  const matches = t.matches.map((m, k): BracketMatchView => {
    const played = m.state === 'live' || (m.state === 'done' && (m.wa + m.wb > 0 || (m.why !== DUEL_WHY.DISCONNECT && m.why !== DUEL_WHY.LOT)));
    return {
      k,
      round: m.round,
      a: at(m.a),
      b: at(m.b),
      state: m.state,
      winner: m.winner,
      why: m.why,
      wa: m.wa,
      wb: m.wb,
      sa: played ? String(m.wa) : '',
      sb: played ? String(m.wb) : '',
      mark: m.state === 'done' ? outcomeMark(m.why) : '',
      mine: m.a === meId || m.b === meId,
    };
  });
  const p = personal(t, meId);
  const entered = byPid.has(meId);
  const inMatch = t.phase === 'running' && t.matches.some((m) => m.state === 'live' && (m.a === meId || m.b === meId));
  const eliminated = t.matches.some((m) => m.state === 'done' && (m.a === meId || m.b === meId) && m.winner !== meId);
  const model: BracketModel = {
    n: t.n,
    phase: t.phase,
    round: t.round,
    title: `道場 · Tournament ${t.n}`,
    stage: stageLine(t, w.tick),
    status: p.status,
    detail: p.detail,
    entrants,
    matches,
    champion: at(t.champion),
    entered,
    inMatch,
    eliminated,
    key: '',
  };
  model.key = bracketKey(model);
  return model;
}

/** Signature de ce que dessine le grand tableau (hors lignes d'état, redessinées à part). */
function bracketKey(m: BracketModel): string {
  const es = m.entrants.map((e) => `${e.pid}${e.gone ? 'g' : ''}${e.ready ? 'r' : ''}`).join(',');
  const ms = m.matches.map((x) => `${x.a?.pid ?? -1}/${x.b?.pid ?? -1}/${x.state[0]}${x.winner}/${x.sa}${x.sb}`).join(',');
  return `${m.n}|${m.phase}|${m.round}|${es}|${ms}|${m.champion?.pid ?? -1}`;
}

/** Index des matchs d'un tour. */
export function roundMatches(round: number): number[] {
  const from = FIRST[round] ?? 0;
  return Array.from({ length: COUNT[round] ?? 0 }, (_, i) => from + i);
}

/** Le grand tableau s'ouvre de lui-même au tirage, pendant les pauses entre les tours et à la fin. */
export function autoOpen(m: BracketModel): boolean {
  return m.phase === 'pause' || m.phase === 'done';
}

/**
 * Ouverture du grand tableau : automatique (autoOpen), ou à la demande avec Tab. Tab referme aussi un
 * tableau ouvert de lui-même, jusqu'à la phase suivante. Jamais pendant le match du joueur local
 * (son duel occupe l'écran) : l'ouverture à la demande tombe alors.
 */
export class BracketToggle {
  private manual = false;
  private dismissed = '';

  /** Tab : ouvre ou referme, selon ce qui est affiché. */
  toggle(m: BracketModel | null): void {
    if (!m) return;
    if (this.isOpen(m)) {
      this.manual = false;
      if (autoOpen(m)) this.dismissed = phaseKey(m);
    } else if (!m.inMatch) {
      this.manual = true;
      this.dismissed = '';
    }
  }

  /** À appeler à chaque image : le grand tableau est-il ouvert ? */
  update(m: BracketModel | null): boolean {
    if (!m) return false;
    if (m.inMatch) this.manual = false;
    return this.isOpen(m);
  }

  reset(): void {
    this.manual = false;
    this.dismissed = '';
  }

  private isOpen(m: BracketModel): boolean {
    if (m.inMatch) return false;
    return this.manual || (autoOpen(m) && this.dismissed !== phaseKey(m));
  }
}

const phaseKey = (m: BracketModel): string => `${m.n}:${m.phase}:${m.round}`;

/**
 * Toast de salle pour le résultat d'un match d'autres joueurs, quand aucun duel ne l'a annoncé (forfait
 * au lancement du tour : « Musashi 木人 advances — Kenji left · 不戦勝 ») ou quand le tableau en décide
 * autrement que le duel (disqualification). Vide sinon : la surcouche des duels a déjà son toast.
 */
export function resultToast(ev: DojoResultEvent, t: Tournament, meId: number, dueled: boolean): string {
  const m = t.matches[ev.match];
  if (!m || m.a === meId || m.b === meId) return '';
  if (dueled && ev.why !== DUEL_WHY.SUSPECT) return '';
  const loser = ev.winner === m.a ? m.b : m.a;
  const W = nameIn(t, ev.winner);
  const L = loser >= 0 ? nameIn(t, loser) : 'ronin';
  switch (ev.why) {
    case DUEL_WHY.DISCONNECT:
      return `${W} advances — ${L} left · 不戦勝`;
    case DUEL_WHY.LOT:
      return `${W} advances over ${L} — drawn by lot · 抽選`;
    case DUEL_WHY.SUSPECT:
      return `${W} advances — ${L} disqualified · 反則`;
    case DUEL_WHY.ABSENT:
      return `${W} advances — ${L} absent · 不在`;
    default:
      return `${W} advances over ${L}`;
  }
}

/**
 * Bannière du joueur local pour le résultat de son match quand aucun duel ne l'a mis en scène (forfait
 * au lancement du tour) ; null sinon (la fin de série du duel s'en charge).
 */
export function resultBanner(
  ev: DojoResultEvent, t: Tournament, meId: number, dueled: boolean,
): { kanji: string; title: string; sub: string; red: boolean } | null {
  const m = t.matches[ev.match];
  if (dueled || !m || (m.a !== meId && m.b !== meId)) return null;
  const opp = m.a === meId ? m.b : m.a;
  const oppName = opp >= 0 ? nameIn(t, opp) : 'your opponent';
  const won = ev.winner === meId;
  const to = m.round < 2 ? `on to the ${ROUND_NAMES[m.round + 1].toLowerCase()}` : 'the final is yours';
  if (ev.why === DUEL_WHY.LOT) {
    return won
      ? { kanji: '抽選', title: 'You advance — drawn by lot', sub: to, red: true }
      : { kanji: '抽選', title: 'Eliminated — drawn by lot', sub: `${nameIn(t, ev.winner)} advances`, red: false };
  }
  if (won) return { kanji: '不戦勝', title: `You advance — ${oppName} left`, sub: to, red: true };
  return { kanji: '負', title: `Eliminated by ${nameIn(t, ev.winner)}`, sub: outcomeNote(ev.why), red: false };
}
