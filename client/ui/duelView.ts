// Modèle de vue des duels iaidō : module pur (sans Phaser), testé par tests/duelui.test.ts.
// Il traduit l'état du monde (duels, invitations) et les derniers événements reçus en textes
// et en grandeurs prêtes à afficher ; DuelOverlay (duel.ts) ne fait que les dessiner.
import { DT, DUEL, DUEL_WHY } from '../../shared/constants';
import { signalShown } from '../../shared/duel';
import type { Duel, DuelPhase, GameEvent, World } from '../../shared/types';
import { playerColor } from '../render/palette';

export type DuelRoundEvent = Extract<GameEvent, { type: 'duelRound' }>;
export type DuelEndEvent = Extract<GameEvent, { type: 'duelEnd' }>;

/** Mémoire des derniers événements de duel par id de duel, tenue par l'overlay. */
export interface DuelMemo {
  rounds: Map<number, DuelRoundEvent>;
  ends: Map<number, DuelEndEvent>;
  /** Noms connus des joueurs (pour ceux qui ont quitté la salle entre-temps). */
  names: Map<number, string>;
}

export function createDuelMemo(): DuelMemo {
  return { rounds: new Map(), ends: new Map(), names: new Map() };
}

/** Invitation en attente vue par le joueur local. */
export interface InviteView {
  pid: number; // l'autre joueur (défieur si reçue, cible si envoyée)
  name: string;
  seconds: number; // secondes restantes (arrondies au supérieur)
  frac: number; // fraction de temps restante, 0..1
}

export interface DuelSideView {
  pid: number;
  name: string;
  color: number; // teinte d'encre (hex)
  wins: number;
  marks: string; // 〇 par manche gagnée, ・ pour les manches restant à gagner
  x: number; // position au sol (joueur s'il est présent, sinon sa marque)
  y: number;
  present: boolean;
}

export interface DuelBoutView {
  id: number;
  mine: boolean;
  me: 'a' | 'b' | null;
  phase: DuelPhase;
  t: number;
  round: number;
  firstTo: number;
  x: number;
  y: number;
  gap: number;
  a: DuelSideView;
  b: DuelSideView;
  /** Le signal 斬 est visible à ce tick : exactement `signalShown(d, w.tick)`. */
  showSignal: boolean;
  /** Ticks écoulés depuis le signal (-1 s'il n'est pas visible). */
  sigAge: number;
  /** Avancement de la mise en place (0..1), pour le cercle d'encre. */
  enterK: number;
  /** Grand kanji de la phase (決闘, 構え, 斬, issue de la manche, fin de série). */
  title: string;
  /** Ligne d'explication en anglais. */
  sub: string;
  /** Réactions « 0.21 s vs 0.27 s » (dénouement et fin), sinon vide. */
  times: string;
  /** Code DUEL_WHY de l'issue affichée (-1 hors dénouement et fin). */
  outcome: number;
  /** Vainqueur de la manche (dénouement) ou de la série (fin), -1 si aucun. */
  winner: number;
  /** Le titre se lit à l'encre vermillon (signal, victoire du joueur local, faute adverse). */
  red: boolean;
}

export interface DuelViewModel {
  incoming: InviteView | null;
  outgoing: InviteView | null;
  mine: DuelBoutView | null;
  others: DuelBoutView[];
}

/** Aide affichée pendant la garde du joueur local. */
export const KAMAE_HELP = 'hold L · release at 斬 · K parry · early = foul';

const WHY: Record<number, { kanji: string; text: string }> = {
  [DUEL_WHY.IPPON]: { kanji: '一本', text: 'ippon' },
  [DUEL_WHY.PARRY]: { kanji: '弾', text: 'parried' },
  [DUEL_WHY.FOUL]: { kanji: '反則', text: 'false start' },
  [DUEL_WHY.AIUCHI]: { kanji: '相打ち', text: 'simultaneous strikes — round replayed' },
  [DUEL_WHY.TIMEOUT]: { kanji: '時間切れ', text: 'no strike — round replayed' },
  [DUEL_WHY.DOUBLE_FOUL]: { kanji: '反則', text: 'both false start — round replayed' },
  [DUEL_WHY.FORFEIT]: { kanji: '降参', text: 'forfeit' },
  [DUEL_WHY.DISCONNECT]: { kanji: '不戦勝', text: 'opponent left' },
  [DUEL_WHY.INTERRUPT]: { kanji: '中断', text: 'interrupted — the road moves on' },
  [DUEL_WHY.TERRAIN]: { kanji: '地', text: 'no flat ground here' },
  [DUEL_WHY.EXPIRED]: { kanji: '時間切れ', text: 'expired' },
  [DUEL_WHY.CANCEL]: { kanji: '取消', text: 'cancelled' },
  [DUEL_WHY.DISTANCE]: { kanji: '遠', text: 'out of range' },
  [DUEL_WHY.HIT]: { kanji: '中断', text: 'a blow broke the duel' },
  [DUEL_WHY.DRAW]: { kanji: '引き分け', text: 'draw' },
  [DUEL_WHY.WIN]: { kanji: '勝', text: 'victory' },
  [DUEL_WHY.TIDE]: { kanji: '潮', text: 'the Tide rises' },
  [DUEL_WHY.FLOOD]: { kanji: '反則', text: 'too many inputs — forfeit' },
};

/** Libellé d'un code DUEL_WHY : kanji et texte anglais (vides si le code est inconnu). */
export function whyLabel(code: number): { kanji: string; text: string } {
  return WHY[code] ?? { kanji: '', text: '' };
}

/** Temps de réaction lisible : « 0.21 s », ou « — » sans réaction (-1). */
export function reactText(ticks: number): string {
  if (!(ticks >= 0)) return '—';
  return `${(ticks * DT).toFixed(2)} s`;
}

type NameOf = (pid: number) => string;

function nameFrom(w: World, memo: DuelMemo | undefined): NameOf {
  return (pid) => {
    const p = w.players.find((q) => q.id === pid);
    if (p && p.name) return p.name;
    return memo?.names.get(pid) || 'ronin';
  };
}

/** Marques de victoire : 〇 par manche gagnée, ・ pour chaque manche restant à gagner. */
export function winMarks(wins: number, firstTo: number): string {
  const n = Math.max(0, Math.min(wins, 9));
  return '〇'.repeat(n) + '・'.repeat(Math.max(0, Math.min(9, firstTo) - n));
}

/**
 * Fin de série : titre et ligne d'explication. `wa`/`wb` : manches gagnées par `a` et `b`.
 * Vu par un duelliste (meId = a ou b) : 勝 / 負 / 引き分け / 降参 / 不戦勝 / 中断 ;
 * vu par un spectateur : 勝 avec « Kenji defeated Aiko 2–1 ».
 */
export function seriesText(
  a: number, b: number, winner: number, wa: number, wb: number, why: number, meId: number, nameOf: NameOf,
): { title: string; sub: string; red: boolean } {
  const mine = meId === a || meId === b;
  const draw = why === DUEL_WHY.DRAW || (winner !== a && winner !== b && why !== DUEL_WHY.INTERRUPT && why !== DUEL_WHY.HIT);
  if (why === DUEL_WHY.INTERRUPT || why === DUEL_WHY.HIT) {
    return { title: '中断', sub: `duel interrupted · ${whyLabel(why).text}`, red: false };
  }
  if (!mine) return { title: draw ? '引き分け' : WHY[why === DUEL_WHY.FORFEIT || why === DUEL_WHY.DISCONNECT ? why : DUEL_WHY.WIN].kanji, sub: endToast({ type: 'duelEnd', id: 0, winner, wa, wb, why }, a, b, nameOf), red: false };
  const myW = meId === a ? wa : wb;
  const opW = meId === a ? wb : wa;
  const opp = nameOf(meId === a ? b : a);
  if (draw) return { title: '引き分け', sub: `draw ${myW}–${opW}`, red: false };
  const won = winner === meId;
  if (why === DUEL_WHY.FORFEIT) {
    return won ? { title: '勝', sub: `${opp} yielded · 降参`, red: true } : { title: '降参', sub: 'you yielded', red: false };
  }
  if (why === DUEL_WHY.DISCONNECT) {
    return won ? { title: '不戦勝', sub: `${opp} left · victory by default`, red: true } : { title: '負', sub: 'you left the duel', red: false };
  }
  return won ? { title: '勝', sub: `victory ${myW}–${opW}`, red: true } : { title: '負', sub: `defeat ${myW}–${opW}`, red: false };
}

/** Toast de salle pour la fin d'un duel d'autres joueurs : « Kenji defeated Aiko 2–1 ». */
export function endToast(ev: DuelEndEvent, a: number, b: number, nameOf: NameOf): string {
  const win = ev.winner === b ? b : a;
  const lose = win === a ? b : a;
  const ww = win === a ? ev.wa : ev.wb;
  const lw = win === a ? ev.wb : ev.wa;
  const W = nameOf(win);
  const L = nameOf(lose);
  if (ev.why === DUEL_WHY.INTERRUPT || ev.why === DUEL_WHY.HIT) return `${nameOf(a)} vs ${nameOf(b)} — interrupted`;
  if (ev.why === DUEL_WHY.DRAW || (ev.winner !== a && ev.winner !== b)) return `${nameOf(a)} and ${nameOf(b)} drew ${ev.wa}–${ev.wb}`;
  if (ev.why === DUEL_WHY.FORFEIT) return `${L} yielded to ${W} · 降参`;
  if (ev.why === DUEL_WHY.DISCONNECT) return `${W} wins by default — ${L} left · 不戦勝`;
  return `${W} defeated ${L} ${ww}–${lw}`;
}

/** Motif lisible d'un duel ou d'une invitation annulés, vu par le joueur local (`from` ou `to`). */
export function cancelText(ev: Extract<GameEvent, { type: 'duelCancel' }>, meId: number, nameOf: NameOf): string {
  const sent = ev.from === meId;
  const other = nameOf(sent ? ev.to : ev.from);
  switch (ev.why) {
    case DUEL_WHY.EXPIRED:
      return sent ? `Challenge to ${other} expired` : `${other}'s challenge expired`;
    case DUEL_WHY.CANCEL:
      return sent ? 'Challenge cancelled' : `${other} withdrew the challenge`;
    case DUEL_WHY.DISTANCE:
      return `Duel off — out of range`;
    case DUEL_WHY.TERRAIN:
      return 'Duel off — no flat ground here';
    case DUEL_WHY.TIDE:
      return 'Duel off — the Tide rises';
    case DUEL_WHY.DISCONNECT:
      return `Duel off — ${other} left`;
    case DUEL_WHY.HIT:
      return 'Duel off — a blow was struck';
    case DUEL_WHY.INTERRUPT:
      return 'Duel off — the road moves on';
    default: {
      const t = whyLabel(ev.why).text;
      return t ? `Duel off — ${t}` : 'Duel off';
    }
  }
}

function side(w: World, d: Duel, s: 'a' | 'b', nameOf: NameOf): DuelSideView {
  const ds = d[s];
  const p = w.players.find((q) => q.id === ds.pid);
  const markX = d.x + (s === 'a' ? -1 : 1) * (d.gap / 2);
  return {
    pid: ds.pid,
    name: nameOf(ds.pid),
    color: playerColor(p?.color ?? 0),
    wins: ds.wins,
    marks: winMarks(ds.wins, d.firstTo),
    x: p ? p.x : markX,
    y: p ? p.y : d.y,
    present: !!p,
  };
}

/** Vue d'un duel (joueur local en duel, ou spectateur si `meId` n'en fait pas partie). */
export function boutView(w: World, d: Duel, meId: number, memo?: DuelMemo): DuelBoutView {
  const nameOf = nameFrom(w, memo);
  const me = d.a.pid === meId ? 'a' : d.b.pid === meId ? 'b' : null;
  const showSignal = signalShown(d, w.tick);
  const a = side(w, d, 'a', nameOf);
  const b = side(w, d, 'b', nameOf);
  const v: DuelBoutView = {
    id: d.id,
    mine: me !== null,
    me,
    phase: d.phase,
    t: d.t,
    round: d.round,
    firstTo: d.firstTo,
    x: d.x,
    y: d.y,
    gap: d.gap,
    a,
    b,
    showSignal,
    sigAge: showSignal ? w.tick - d.sigTick : -1,
    enterK: d.phase === 'enter' ? Math.max(0, Math.min(1, d.t / DUEL.ENTER_TICKS)) : 1,
    title: '',
    sub: '',
    times: '',
    outcome: -1,
    winner: -1,
    red: false,
  };
  const versus = `${a.name} vs ${b.name}`;

  // Réactions de la dernière manche : celles du duel, sinon celles du dernier événement duelRound.
  const ev = memo?.rounds.get(d.id);
  let ra = d.a.react;
  let rb = d.b.react;
  if (ra < 0 && rb < 0 && ev) {
    ra = ev.ra;
    rb = ev.rb;
  }
  const times = ra < 0 && rb < 0 ? '' : me === 'b' ? `${reactText(rb)} vs ${reactText(ra)}` : `${reactText(ra)} vs ${reactText(rb)}`;

  if (showSignal) {
    v.title = '斬';
    v.red = true;
    v.sub = me ? '' : versus;
    return v;
  }
  switch (d.phase) {
    case 'enter':
      v.title = '決闘';
      v.sub = `round ${d.round} · ${versus}`;
      break;
    case 'kamae':
      v.title = '構え';
      v.sub = me ? KAMAE_HELP : versus;
      break;
    case 'open':
      // Signal publié mais pas encore atteint à notre tick (ne devrait pas durer) : garde.
      v.title = '構え';
      v.sub = me ? KAMAE_HELP : versus;
      break;
    case 'resolve': {
      const why = d.last >= 0 ? d.last : ev ? ev.why : -1;
      const winner = d.winner >= 0 ? d.winner : ev ? ev.winner : -1;
      v.outcome = why;
      v.winner = winner;
      v.title = whyLabel(why).kanji;
      v.times = times;
      const wn = winner >= 0 ? nameOf(winner) : '';
      const loser = winner === d.a.pid ? d.b.pid : winner === d.b.pid ? d.a.pid : -1;
      if (why === DUEL_WHY.IPPON) v.sub = `${wn} strikes first · ippon`;
      else if (why === DUEL_WHY.PARRY) v.sub = `${wn} parries · 弾`;
      else if (why === DUEL_WHY.FOUL) v.sub = loser >= 0 ? `${nameOf(loser)} false start · point to ${wn}` : 'false start';
      else v.sub = whyLabel(why).text;
      // Vermillon : le joueur local emporte la manche (ou un spectateur voit un ippon).
      v.red = me ? winner === meId : why === DUEL_WHY.IPPON;
      break;
    }
    case 'end': {
      const end = memo?.ends.get(d.id);
      const winner = end ? end.winner : d.winner;
      const terminal = d.last === DUEL_WHY.FORFEIT || d.last === DUEL_WHY.DISCONNECT || d.last === DUEL_WHY.INTERRUPT || d.last === DUEL_WHY.HIT || d.last === DUEL_WHY.DRAW || d.last === DUEL_WHY.WIN;
      const why = end ? end.why : terminal ? d.last : winner >= 0 ? DUEL_WHY.WIN : DUEL_WHY.DRAW;
      const s = seriesText(d.a.pid, d.b.pid, winner, end ? end.wa : d.a.wins, end ? end.wb : d.b.wins, why, meId, nameOf);
      v.outcome = why;
      v.winner = winner;
      v.title = s.title;
      v.sub = s.sub;
      v.red = s.red;
      v.times = times;
      break;
    }
  }
  return v;
}

function inviteView(w: World, pid: number, until: number, nameOf: NameOf): InviteView {
  const left = Math.max(0, until - w.tick);
  return {
    pid,
    name: nameOf(pid),
    seconds: Math.ceil(left * DT),
    frac: Math.max(0, Math.min(1, left / DUEL.INVITE_TICKS)),
  };
}

/**
 * Modèle de vue des duels pour le joueur `meId` : invitation reçue ou envoyée, son duel, et les
 * duels des autres joueurs (l'overlay ne montre que ceux qui sont dans le champ). En solo
 * (`w.duels` et `w.duelInvites` absents), tout est vide.
 */
export function duelView(w: World, meId: number, memo?: DuelMemo): DuelViewModel {
  const out: DuelViewModel = { incoming: null, outgoing: null, mine: null, others: [] };
  const nameOf = nameFrom(w, memo);
  const invs = w.duelInvites;
  if (invs) {
    let inUntil = -Infinity;
    let outUntil = -Infinity;
    for (const inv of invs) {
      if (inv.cd || inv.until < w.tick) continue;
      // Plusieurs défis reçus : le plus récent (expiration la plus lointaine) est montré.
      if (inv.to === meId && inv.until > inUntil) {
        inUntil = inv.until;
        out.incoming = inviteView(w, inv.from, inv.until, nameOf);
      } else if (inv.from === meId && inv.until > outUntil) {
        outUntil = inv.until;
        out.outgoing = inviteView(w, inv.to, inv.until, nameOf);
      }
    }
  }
  const ds = w.duels;
  if (ds) {
    for (const d of ds) {
      const v = boutView(w, d, meId, memo);
      if (v.mine && !out.mine) out.mine = v;
      else out.others.push(v);
    }
  }
  return out;
}
