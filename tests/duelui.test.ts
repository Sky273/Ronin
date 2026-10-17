// Tests du modèle de vue des duels (invitation, phases, signal, résultats).
// Lancer : npm run test:duelui
import type Phaser from 'phaser';
import { DUEL, DUEL_WHY } from '../shared/constants';
import { findDuelSpot } from '../shared/duel';
import { stepInvites } from '../shared/duelInvite';
import { BTN } from '../shared/input';
import type { Duel, DuelPhase, GameEvent, World } from '../shared/types';
import { addPlayer, createWorld } from '../shared/world';
import { DuelOverlay } from '../client/ui/duel';
import {
  boutView, cancelText, createDuelMemo, duelView, endToast, inviteText, KAMAE_HELP, reactText, seriesText, whyLabel, winMarks,
} from '../client/ui/duelView';

export {};
let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

/** Monde coop à trois joueurs : Kenji (a), Aiko (b), Sora (spectateur). */
function setup(): { w: World; kenji: number; aiko: number; sora: number } {
  const w = createWorld(11, { mode: 'coop' });
  const kenji = addPlayer(w, 'Kenji', { color: 1 }).id;
  const aiko = addPlayer(w, 'Aiko', { color: 2 }).id;
  const sora = addPlayer(w, 'Sora', { color: 3 }).id;
  w.tick = 1000;
  return { w, kenji, aiko, sora };
}

function makeDuel(a: number, b: number, phase: DuelPhase, over: Partial<Duel> = {}): Duel {
  const side = (pid: number) => ({ pid, wins: 0, strikeT: -1, parryT: -1, foul: false, react: -1 });
  return {
    id: 7, a: side(a), b: side(b), x: 500, y: 300, gap: DUEL.GAP, phase, t: 0, round: 1, played: 0, sigTick: -1,
    stage: 0, last: -1, winner: -1, firstTo: 2, maxRounds: 5, draw: true, ...over,
  };
}

/** Texte Phaser factice : texte, position, échelle et visibilité tenus comme dans Phaser. */
class FakeText {
  x: number;
  y: number;
  text: string;
  style: { color: string; fontSize: string };
  visible = true;
  alpha = 1;
  scale = 1;
  constructor(x: number, y: number, text: string, style: { color?: string; fontSize?: string }) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.style = { color: style.color ?? '', fontSize: style.fontSize ?? '' };
  }
  get width(): number {
    return this.text.length * 10;
  }
  setText(s: string): this {
    this.text = s;
    return this;
  }
  setOrigin(): this {
    return this;
  }
  setDepth(): this {
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  setScale(k: number): this {
    this.scale = k;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setColor(c: string): this {
    this.style.color = c;
    return this;
  }
  setFontSize(f: string): this {
    this.style.fontSize = f;
    return this;
  }
  destroy(): void {}
}

/** DuelOverlay sur une scène Phaser factice : textes enregistrés, graphiques sans effet. */
function overlay(): { ov: DuelOverlay; texts: FakeText[] } {
  const texts: FakeText[] = [];
  const g: unknown = new Proxy({}, { get: () => () => g });
  const scene = {
    scale: { width: 1280, height: 720 },
    add: {
      text: (x: number, y: number, s: string, style: { color?: string; fontSize?: string }) => {
        const t = new FakeText(x, y, s, style);
        texts.push(t);
        return t;
      },
      graphics: () => g,
    },
  };
  return { ov: new DuelOverlay(scene as unknown as Phaser.Scene, ((o: unknown) => o) as never), texts };
}
const cam = { worldView: { x: -1e5, y: -1e5, right: 1e5, bottom: 1e5 } } as unknown as Phaser.Cameras.Scene2D.Camera;

// ─── Utilitaires ──────────────────────────────────────────────────────────
check('whyLabel : 一本', whyLabel(DUEL_WHY.IPPON).kanji === '一本');
check('whyLabel : 弾 / 反則 / 相打ち / 時間切れ', whyLabel(DUEL_WHY.PARRY).kanji === '弾' && whyLabel(DUEL_WHY.FOUL).kanji === '反則'
  && whyLabel(DUEL_WHY.AIUCHI).kanji === '相打ち' && whyLabel(DUEL_WHY.TIMEOUT).kanji === '時間切れ');
check('whyLabel : 降参 / 不戦勝 / 引き分け / 勝', whyLabel(DUEL_WHY.FORFEIT).kanji === '降参' && whyLabel(DUEL_WHY.DISCONNECT).kanji === '不戦勝'
  && whyLabel(DUEL_WHY.DRAW).kanji === '引き分け' && whyLabel(DUEL_WHY.WIN).kanji === '勝');
check('whyLabel : motifs lisibles', whyLabel(DUEL_WHY.DISTANCE).text === 'out of range' && whyLabel(DUEL_WHY.TERRAIN).text === 'no flat ground here'
  && whyLabel(DUEL_WHY.EXPIRED).text === 'expired');
check('whyLabel : code inconnu → vide', whyLabel(99).kanji === '' && whyLabel(-1).text === '');
{
  let all = true;
  for (const code of Object.values(DUEL_WHY)) if (!whyLabel(code).kanji || !whyLabel(code).text) all = false;
  check('whyLabel : tous les codes DUEL_WHY ont un libellé', all);
}
check('reactText : 13 ticks → 0.22 s', reactText(13) === '0.22 s', reactText(13));
check('reactText : -1 → —', reactText(-1) === '—');
check('winMarks : 1 sur 2 → 〇・', winMarks(1, 2) === '〇・');
check('winMarks : 0 sur 2 → ・・', winMarks(0, 2) === '・・');

// ─── Absence de duel ──────────────────────────────────────────────────────
{
  const w = createWorld(3);
  const me = addPlayer(w, 'Ronin').id;
  let ok = true;
  let v;
  try {
    v = duelView(w, me);
  } catch {
    ok = false;
  }
  check('solo : aucune exception', ok);
  check('solo : vue vide', !!v && !v.incoming && !v.outgoing && !v.mine && v.others.length === 0);
  w.duels = [];
  w.duelInvites = [];
  const v2 = duelView(w, me);
  check('listes vides : vue vide', !v2.incoming && !v2.outgoing && !v2.mine && v2.others.length === 0);
}

// ─── Invitations ──────────────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  w.duelInvites = [{ from: kenji, to: aiko, until: w.tick + 300, cd: false }];
  const inv = duelView(w, aiko);
  check('invité : défi reçu de Kenji', inv.incoming?.name === 'Kenji' && inv.incoming.pid === kenji && !inv.outgoing);
  check('invité : 5 s restantes', inv.incoming?.seconds === 5, String(inv.incoming?.seconds));
  check('invité : fraction de temps', Math.abs((inv.incoming?.frac ?? 0) - 300 / DUEL.INVITE_TICKS) < 1e-9);
  const snd = duelView(w, kenji);
  check('défieur : défi envoyé à Aiko', snd.outgoing?.name === 'Aiko' && !snd.incoming, String(snd.outgoing?.name));
  check('défieur : 5 s restantes', snd.outgoing?.seconds === 5);
  const spec = duelView(w, sora);
  check('spectateur : aucune invitation', !spec.incoming && !spec.outgoing);
  w.duelInvites = [{ from: kenji, to: aiko, until: w.tick + 1800, cd: true }];
  check('délai entre défis (cd) : pas une invitation', !duelView(w, aiko).incoming && !duelView(w, kenji).outgoing);
  w.duelInvites = [{ from: kenji, to: aiko, until: w.tick - 1, cd: false }];
  check('invitation expirée : ignorée', !duelView(w, aiko).incoming);
  w.duelInvites = [{ from: kenji, to: aiko, until: w.tick + 90, cd: false }, { from: sora, to: aiko, until: w.tick + 400, cd: false }];
  check('deux défis reçus : le plus récent', duelView(w, aiko).incoming?.name === 'Sora');
}

// ─── Phases ───────────────────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const d = makeDuel(kenji, aiko, 'enter', { t: 20 });
  w.duels = [d];
  let v = duelView(w, kenji);
  check('enter : duel du joueur local', !!v.mine && v.mine.mine && v.mine.me === 'a' && v.others.length === 0);
  check('enter : 決闘 et manche', v.mine?.title === '決闘' && v.mine.sub.includes('round 1') && v.mine.sub.includes('Kenji vs Aiko'));
  check('enter : cercle en cours de tracé', Math.abs((v.mine?.enterK ?? 0) - 20 / DUEL.ENTER_TICKS) < 1e-9);
  check('enter : noms et couleurs', v.mine?.a.name === 'Kenji' && v.mine.b.name === 'Aiko' && v.mine.a.color !== v.mine.b.color);
  check('enter : marques ・・', v.mine?.a.marks === '・・');
  check('côté b : me = b', duelView(w, aiko).mine?.me === 'b');

  d.phase = 'kamae';
  d.t = 30;
  d.sigTick = w.tick + 50;
  v = duelView(w, kenji);
  check('kamae : 構え et aide', v.mine?.title === '構え' && v.mine.sub === KAMAE_HELP && !v.mine.showSignal);
  const spec = duelView(w, sora);
  check('spectateur : pas de duel à soi', !spec.mine && spec.others.length === 1);
  check('spectateur : 構え sans aide', spec.others[0].title === '構え' && spec.others[0].sub === 'Kenji vs Aiko' && spec.others[0].me === null);

  // Signal : faux à sigTick − 1, vrai à sigTick (kamae comme open).
  w.tick = d.sigTick - 1;
  check('signal : faux à sigTick − 1', duelView(w, kenji).mine?.showSignal === false);
  check('signal : faux à sigTick − 1 (spectateur)', duelView(w, sora).others[0].showSignal === false);
  w.tick = d.sigTick;
  v = duelView(w, kenji);
  check('signal : vrai à sigTick', v.mine?.showSignal === true && v.mine.title === '斬' && v.mine.sigAge === 0);
  check('signal : vrai à sigTick (spectateur)', duelView(w, sora).others[0].showSignal === true);
  d.phase = 'open';
  w.tick = d.sigTick + 5;
  v = duelView(w, kenji);
  check('open : 斬 toujours visible', v.mine?.showSignal === true && v.mine.sigAge === 5);
  d.phase = 'enter';
  check('signal : jamais hors kamae/open', duelView(w, kenji).mine?.showSignal === false);
  d.phase = 'kamae';
  d.sigTick = -1;
  check('signal : sigTick −1 → faux', duelView(w, kenji).mine?.showSignal === false);
}

// ─── Résultats des manches ────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const d = makeDuel(kenji, aiko, 'resolve', { last: DUEL_WHY.IPPON, winner: kenji, sigTick: w.tick - 30 });
  d.a.react = 13;
  d.b.react = 16;
  d.a.wins = 1;
  w.duels = [d];
  let v = duelView(w, kenji);
  check('ippon : 一本', v.mine?.title === '一本' && v.mine.outcome === DUEL_WHY.IPPON && v.mine.winner === kenji);
  check('ippon : réactions', v.mine?.times === '0.22 s vs 0.27 s', v.mine?.times);
  check('ippon : vermillon pour le vainqueur', v.mine?.red === true && duelView(w, aiko).mine?.red === false);
  check('ippon : côté b, ses réactions d’abord', duelView(w, aiko).mine?.times === '0.27 s vs 0.22 s');
  check('ippon : marques 〇・', v.mine?.a.marks === '〇・' && v.mine.b.marks === '・・');
  check('ippon : texte', v.mine?.sub.includes('Kenji') === true && v.mine.sub.includes('ippon'));
  check('spectateur : 一本 aussi', duelView(w, sora).others[0].title === '一本');

  d.last = DUEL_WHY.PARRY;
  d.winner = aiko;
  v = duelView(w, kenji);
  check('parade : 弾', v.mine?.title === '弾' && v.mine.sub.includes('Aiko'));
  d.last = DUEL_WHY.FOUL;
  d.winner = aiko;
  d.a.react = d.b.react = -1;
  v = duelView(w, kenji);
  check('faute : 反則 et fautif nommé', v.mine?.title === '反則' && v.mine.sub.startsWith('Kenji false start'));
  check('faute : aucune réaction → pas de temps', v.mine?.times === '');
  d.last = DUEL_WHY.AIUCHI;
  d.winner = -1;
  check('相打ち', duelView(w, kenji).mine?.title === '相打ち');
  d.last = DUEL_WHY.TIMEOUT;
  check('時間切れ', duelView(w, kenji).mine?.title === '時間切れ');

  // Réactions et issue lues depuis le dernier événement duelRound quand le duel ne les porte plus.
  const memo = createDuelMemo();
  memo.rounds.set(d.id, { type: 'duelRound', id: d.id, round: 1, winner: kenji, why: DUEL_WHY.IPPON, ra: 12, rb: 18, wa: 1, wb: 0 });
  d.last = -1;
  d.winner = -1;
  v = duelView(w, kenji, memo);
  check('duelRound : issue et réactions', v.mine?.title === '一本' && v.mine.times === '0.20 s vs 0.30 s' && v.mine.winner === kenji, v.mine?.times);
}

// ─── Fin de série ─────────────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const d = makeDuel(kenji, aiko, 'end', { winner: kenji, last: DUEL_WHY.WIN });
  d.a.wins = 2;
  d.b.wins = 1;
  w.duels = [d];
  check('fin : 勝 pour le vainqueur', duelView(w, kenji).mine?.title === '勝' && duelView(w, kenji).mine?.sub === 'victory 2–1');
  check('fin : 負 pour le perdant', duelView(w, aiko).mine?.title === '負' && duelView(w, aiko).mine?.sub === 'defeat 1–2');
  const sp = duelView(w, sora).others[0];
  check('fin : spectateur', sp.title === '勝' && sp.sub === 'Kenji defeated Aiko 2–1', sp.sub);
  d.winner = -1;
  d.last = DUEL_WHY.DRAW;
  d.b.wins = 2;
  check('fin : 引き分け', duelView(w, kenji).mine?.title === '引き分け');
  const memo = createDuelMemo();
  memo.ends.set(d.id, { type: 'duelEnd', id: d.id, winner: kenji, wa: 1, wb: 0, why: DUEL_WHY.FORFEIT });
  check('fin : abandon adverse (duelEnd)', duelView(w, kenji, memo).mine?.title === '勝' && duelView(w, kenji, memo).mine?.sub.includes('降参') === true);
  check('fin : 降参 pour celui qui abandonne', duelView(w, aiko, memo).mine?.title === '降参');
  memo.ends.set(d.id, { type: 'duelEnd', id: d.id, winner: aiko, wa: 0, wb: 1, why: DUEL_WHY.DISCONNECT });
  check('fin : 不戦勝', duelView(w, aiko, memo).mine?.title === '不戦勝');

  const name = (pid: number) => (pid === kenji ? 'Kenji' : pid === aiko ? 'Aiko' : 'ronin');
  check('toast : victoire', endToast({ type: 'duelEnd', id: 1, winner: aiko, wa: 1, wb: 2, why: DUEL_WHY.WIN }, kenji, aiko, name) === 'Aiko defeated Kenji 2–1');
  check('toast : nul', endToast({ type: 'duelEnd', id: 1, winner: -1, wa: 2, wb: 2, why: DUEL_WHY.DRAW }, kenji, aiko, name) === 'Kenji and Aiko drew 2–2');
  check('série : interrompue', seriesText(kenji, aiko, -1, 1, 0, DUEL_WHY.INTERRUPT, kenji, name).title === '中断');
  const cancel = (why: number, from = kenji, to = aiko) => cancelText({ type: 'duelCancel', from, to, why }, aiko, name);
  check('annulation : hors de portée', cancel(DUEL_WHY.DISTANCE).includes('out of range'));
  check('annulation : terrain', cancel(DUEL_WHY.TERRAIN).includes('no flat ground here'));
  check('annulation : expirée (invité)', cancel(DUEL_WHY.EXPIRED) === "Kenji's challenge expired");
  check('annulation : expirée (défieur)', cancel(DUEL_WHY.EXPIRED, aiko, kenji) === 'Challenge to Kenji expired');
}

// ─── Plusieurs duels ──────────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const other = addPlayer(w, 'Ren').id;
  w.duels = [makeDuel(kenji, aiko, 'kamae', { id: 1 }), makeDuel(sora, other, 'enter', { id: 2 })];
  const v = duelView(w, sora);
  check('deux duels : le sien et un spectateur', v.mine?.id === 2 && v.others.length === 1 && v.others[0].id === 1);
  w.players = w.players.filter((p) => p.id !== aiko);
  const v2 = duelView(w, kenji);
  check('duelliste parti : marque au sol, absent', v2.mine?.b.present === false && v2.mine.b.x === 500 + DUEL.GAP / 2);
}

// ─── Forfait FLOOD ────────────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const name = (pid: number) => (pid === kenji ? 'Kenji' : pid === aiko ? 'Aiko' : 'ronin');
  const lose = seriesText(kenji, aiko, kenji, 0, 1, DUEL_WHY.FLOOD, aiko, name);
  check('FLOOD : le fautif voit 反則 « too many inputs — forfeit »', lose.title === '反則' && lose.sub === 'too many inputs — forfeit' && !lose.red, JSON.stringify(lose));
  const win = seriesText(kenji, aiko, kenji, 0, 1, DUEL_WHY.FLOOD, kenji, name);
  check('FLOOD : l\'autre voit une victoire par forfait (pas « victory 0–1 »)', win.title === '勝' && win.sub === 'Aiko disqualified · victory by forfeit' && win.red, JSON.stringify(win));
  const ev = { type: 'duelEnd', id: 7, winner: kenji, wa: 0, wb: 1, why: DUEL_WHY.FLOOD } as const;
  check('FLOOD : toast de salle', endToast(ev, kenji, aiko, name) === 'Kenji wins by forfeit — Aiko disqualified · 反則', endToast(ev, kenji, aiko, name));
  // Fin de série vue avec et sans l'événement duelEnd en mémoire (spectateur arrivé après).
  const d = makeDuel(kenji, aiko, 'end', { winner: kenji, last: DUEL_WHY.FLOOD });
  d.b.wins = 1;
  w.duels = [d];
  const memo = createDuelMemo();
  memo.ends.set(d.id, { ...ev });
  for (const m of [undefined, memo]) {
    const sp = boutView(w, d, sora, m);
    const me = boutView(w, d, aiko, m);
    check(`FLOOD, fin ${m ? 'avec' : 'sans'} duelEnd en mémoire : motif FLOOD, forfait annoncé`, sp.outcome === DUEL_WHY.FLOOD && sp.title === '反則'
      && sp.sub === endToast(ev, kenji, aiko, name) && me.title === '反則' && me.outcome === DUEL_WHY.FLOOD, `${sp.outcome} ${sp.title} « ${sp.sub} » / ${me.title}`);
  }
  // Toast des spectateurs par la surcouche.
  const { ov, texts } = overlay();
  ov.update(duelView(w, sora, ov.memo), w, cam, 1000);
  ov.onEvent({ type: 'duelStart', id: d.id, a: kenji, b: aiko }, sora);
  ov.onEvent({ ...ev }, sora);
  check('FLOOD : toast des spectateurs', texts.some((t) => t.visible && t.text === 'Kenji wins by forfeit — Aiko disqualified · 反則'), texts.filter((t) => t.visible).map((t) => t.text).join(' | '));
}

// ─── Défi tombé parce que la cible entre en duel (BUSY) ──────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const name = (pid: number) => (pid === kenji ? 'Kenji' : pid === aiko ? 'Aiko' : pid === sora ? 'Sora' : 'ronin');
  const ev = { type: 'duelCancel', from: sora, to: aiko, why: DUEL_WHY.BUSY } as const;
  check('BUSY : le défieur apprend que sa cible est en duel (pas « cancelled »)', cancelText(ev, sora, name) === 'Duel off — Aiko is in another duel', cancelText(ev, sora, name));
  check('BUSY : rien pour la cible, qui entre dans son duel (pas « Sora withdrew »)', cancelText(ev, aiko, name) === '', cancelText(ev, aiko, name));
  const { ov, texts } = overlay();
  ov.update(duelView(w, aiko), w, cam, 1000);
  ov.onEvent({ ...ev }, aiko);
  check('BUSY : aucun toast pour la cible', !texts.some((t) => t.visible), texts.filter((t) => t.visible).map((t) => t.text).join(' | '));
  ov.onEvent({ ...ev }, sora);
  check('BUSY : toast pour le défieur', texts.some((t) => t.visible && t.text === 'Duel off — Aiko is in another duel'));
}

// ─── Bandeau d'invitation : défi reçu et défi envoyé ensemble ─────────────
{
  const { w, kenji, aiko, sora } = setup();
  const iv = (pid: number, nm: string) => ({ pid, name: nm, seconds: 5, frac: 0.5 });
  check('bandeau : défi reçu seul → G to accept', inviteText(iv(sora, 'Sora'), null) === '決闘  Sora challenges you — G to accept');
  check('bandeau : défi envoyé seul → G to cancel', inviteText(null, iv(kenji, 'Kenji')) === 'Challenge sent to Kenji… G to cancel');
  check('bandeau : les deux → G annule d\'abord le défi envoyé', inviteText(iv(sora, 'Sora'), iv(kenji, 'Kenji')).includes('G: cancel your challenge to Kenji'));
  check('bandeau : défis croisés (même joueur) → acceptation', inviteText(iv(kenji, 'Kenji'), iv(kenji, 'Kenji')) === '決闘  Kenji challenges you — G to accept');
  check('bandeau : aucune invitation → vide', inviteText(null, null) === '');

  // Bout en bout : le bandeau de la surcouche annonce ce que fait l'appui sur G (stepInvites).
  w.enemies = [];
  const spot = findDuelSpot(w.level, w.level.spawn.x + 300, w.level.spawn.y, DUEL.GAP)!;
  for (const p of w.players) {
    p.x = spot.x;
    p.y = spot.y;
  }
  w.duelInvites = [{ from: aiko, to: kenji, until: w.tick + 500, cd: false }, { from: sora, to: aiko, until: w.tick + 550, cd: false }];
  const { ov, texts } = overlay();
  const banner = texts.find((t) => t.y === 128)!;
  const show = () => {
    ov.update(duelView(w, aiko, ov.memo), w, cam, 1000);
    return banner.visible ? banner.text : '';
  };
  const pressG = (): GameEvent[] => {
    for (const p of w.players) p.prevButtons = 0;
    stepInvites(w, new Map([[aiko, BTN.DUEL]]));
    const ev = w.events.slice();
    w.events.length = 0;
    return ev;
  };
  const b1 = show();
  check('bandeau d\'Aiko : défi de Sora reçu, défi à Kenji envoyé → G annule d\'abord', b1.includes('Sora challenges you') && b1.includes('G: cancel your challenge to Kenji') && !b1.includes('G to accept'), b1);
  const ev1 = pressG();
  const c1 = ev1.find((x) => x.type === 'duelCancel');
  check('… et G annule bien le défi envoyé à Kenji, sans duel', !!c1 && c1.type === 'duelCancel' && c1.from === aiko && c1.to === kenji && !ev1.some((x) => x.type === 'duelStart'), JSON.stringify(ev1));
  const b2 = show();
  check('bandeau d\'Aiko, défi annulé : Sora challenges you — G to accept', b2 === '決闘  Sora challenges you — G to accept', b2);
  const ev2 = pressG();
  check('… et G accepte alors le défi de Sora', ev2.some((x) => x.type === 'duelStart' && [x.a, x.b].includes(sora) && [x.a, x.b].includes(aiko)), JSON.stringify(ev2));
}

// ─── 斬 des spectateurs ───────────────────────────────────────────────────
{
  const { w, kenji, aiko, sora } = setup();
  const d = makeDuel(kenji, aiko, 'kamae', { sigTick: w.tick + 1 });
  w.duels = [d];
  const { ov, texts } = overlay();
  const above = () => texts.filter((t) => t.visible && t.x === d.x && t.y === d.y - 150);
  ov.update(duelView(w, sora), w, cam, 1000);
  check('spectateur : rien au-dessus du lieu avant le signal', above().length === 0);
  w.tick = d.sigTick;
  ov.update(duelView(w, sora), w, cam, 1016);
  const z = above();
  check('spectateur : 斬 affiché au-dessus du lieu au signal (texte non vide)', z.length === 1 && z[0].text === '斬', JSON.stringify(z.map((t) => t.text)));
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
} else console.log('\nTous les tests d’interface des duels passent.');
