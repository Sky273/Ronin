// Tests du module des high scores locaux (aucun rendu, aucune dépendance).
// Lancer : npm run test:scores
import {
  compareEntries,
  emptyTable,
  insertScore,
  loadPrefs,
  loadScores,
  qualifies,
  sanitizeName,
  sanitizeTable,
  savePrefs,
  saveScores,
  type KV,
} from '../client/scores/highscores';
import { DEFAULT_NAME, MAX_NAME, MAX_SCORES, type ScoreEntry } from '../client/scores/types';
import { DIFFICULTY_ORDER } from '../shared/difficulty';

let failures = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failures++;
}

const entry = (score: number, date = 0, name = 'A'): ScoreEntry => ({ name, score, loop: 0, kills: 0, date });
const scoresOf = (l: ScoreEntry[]): string => l.map((e) => e.score).join(',');

/** Faux storage en mémoire. */
function memStorage(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}
const throwing: KV = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};
const noThrow = (fn: () => unknown): boolean => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

// ─── emptyTable ─────────────────────────────────────────────────────────────
{
  const t = emptyTable();
  check('emptyTable : 5 listes vides', DIFFICULTY_ORDER.every((id) => Array.isArray(t[id]) && t[id].length === 0) && Object.keys(t).length === 5);
}

// ─── Tri et insertion ───────────────────────────────────────────────────────
{
  const l = [entry(50, 1), entry(300, 2), entry(100, 3)].sort(compareEntries);
  check('tri décroissant par score', scoresOf(l) === '300,100,50', scoresOf(l));
  const tie = [entry(100, 20, 'new'), entry(100, 10, 'old')].sort(compareEntries);
  check('égalité : la plus ancienne devant (compareEntries)', tie[0].name === 'old', tie.map((e) => e.name).join(','));

  let list: ScoreEntry[] = [];
  const ranks: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const r = insertScore(list, entry(i * 10, i));
    list = r.list;
    ranks.push(r.rank);
  }
  check('insertion : top 10 tronqué', list.length === MAX_SCORES && list[0].score === 120 && list[9].score === 30, scoresOf(list));
  check('insertion : meilleur score → rang 0', ranks[11] === 0, String(ranks));
  const low = insertScore(list, entry(5, 99));
  check('insertion hors top → rang -1, liste inchangée', low.rank === -1 && scoresOf(low.list) === scoresOf(list));
  const mid = insertScore(list, entry(75, 99));
  check('insertion au milieu → rang correct', mid.rank === 5 && mid.list[5].score === 75 && mid.list.length === 10, `rang ${mid.rank}`);

  const before = JSON.stringify(list);
  insertScore(list, entry(1000, 100));
  check('liste d\'entrée non modifiée', JSON.stringify(list) === before);

  const tieIns = insertScore([entry(200, 1, 'x'), entry(100, 1, 'old'), entry(50, 1, 'y')], entry(100, 5, 'new'));
  check('égalité : la nouvelle entrée après l\'ancienne', tieIns.rank === 2 && tieIns.list[1].name === 'old' && tieIns.list[2].name === 'new', `rang ${tieIns.rank}`);
  const tieFull = insertScore(list, entry(list[9].score, 500));
  check('égalité avec le dernier d\'une liste pleine → -1', tieFull.rank === -1);

  check('insertion score 0 → -1', insertScore([], entry(0)).rank === -1);
  check('insertion liste vide → rang 0', insertScore([], entry(10)).rank === 0);

  // qualifies
  check('qualifies : score 0 non qualifiant', !qualifies([], 0));
  check('qualifies : score négatif non qualifiant', !qualifies([], -5));
  check('qualifies : NaN non qualifiant', !qualifies([], NaN));
  check('qualifies : liste non pleine → oui', qualifies([entry(500)], 1));
  check('qualifies : liste pleine, score égal au dernier → non', !qualifies(list, list[9].score));
  check('qualifies : liste pleine, score inférieur → non', !qualifies(list, list[9].score - 1));
  check('qualifies : liste pleine, score supérieur → oui', qualifies(list, list[9].score + 1));
  check('qualifies : max personnalisé', !qualifies([entry(10), entry(9)], 5, 2) && qualifies([entry(10)], 5, 2));
}

// ─── Noms ───────────────────────────────────────────────────────────────────
{
  check('nom vide → Ronin', sanitizeName('') === DEFAULT_NAME);
  check('nom blanc → Ronin', sanitizeName('   \t ') === DEFAULT_NAME);
  const long = sanitizeName('a'.repeat(30));
  check('30 caractères → 12', long.length === MAX_NAME, String(long.length));
  check('caractères de contrôle retirés', sanitizeName('\u0000Bo\u0007b\u001b') === 'Bob', JSON.stringify(sanitizeName('\u0000Bo\u0007b\u001b')));
  check('emoji retirés', sanitizeName('Musashi🗡️😀') === 'Musashi', sanitizeName('Musashi🗡️😀'));
  check('seulement des emoji → Ronin', sanitizeName('😀😀') === DEFAULT_NAME);
  check('espaces de bord retirés', sanitizeName('   Kenji  ') === 'Kenji');
  check('espaces multiples réduits', sanitizeName('a    b') === 'a b');
  check('accents conservés (Hélène)', sanitizeName('Hélène') === 'Hélène');
  check('NFC : Hélène décomposé recomposé', sanitizeName('Hélène') === 'Hélène', sanitizeName('Hélène'));
  check('japonais conservé (武蔵)', sanitizeName('武蔵') === '武蔵');
  check('ponctuation autorisée - _ .', sanitizeName('a-b_c.d') === 'a-b_c.d');
  check('symboles retirés', sanitizeName('<b>x</b>!') === 'bxb', sanitizeName('<b>x</b>!'));
  const astral = sanitizeName('𠀀'.repeat(20)); // idéogrammes hors BMP (2 unités UTF-16 chacun)
  check('troncature en points de code', Array.from(astral).length === MAX_NAME, String(Array.from(astral).length));
  check('pas d\'espace final après troncature', sanitizeName('abcdefghijk lmn') === 'abcdefghijk', sanitizeName('abcdefghijk lmn'));
}

// ─── sanitizeTable ──────────────────────────────────────────────────────────
{
  const isEmpty = (t: ReturnType<typeof sanitizeTable>): boolean =>
    DIFFICULTY_ORDER.every((id) => Array.isArray(t[id]) && t[id].length === 0);
  check('sanitizeTable : nombre → vide', isEmpty(sanitizeTable(42)));
  check('sanitizeTable : chaîne → vide', isEmpty(sanitizeTable('{"v":1}')));
  check('sanitizeTable : tableau → vide', isEmpty(sanitizeTable([1, 2])));
  check('sanitizeTable : null → vide', isEmpty(sanitizeTable(null)));
  check('sanitizeTable : undefined → vide', isEmpty(sanitizeTable(undefined)));
  check('sanitizeTable : mauvaise version → vide', isEmpty(sanitizeTable({ v: 2, tables: { normal: [entry(10)] } })));
  check('sanitizeTable : tables manquantes → vide', isEmpty(sanitizeTable({ v: 1 })));
  check('sanitizeTable : tables non objet → vide', isEmpty(sanitizeTable({ v: 1, tables: 'x' })));

  const good = entry(100, 5, 'Ok');
  const t = sanitizeTable({
    v: 1,
    tables: {
      normal: [
        good,
        { name: 42, score: 10, loop: 0, kills: 0, date: 0 },
        { name: 'a', score: '10', loop: 0, kills: 0, date: 0 },
        { name: 'a', score: NaN, loop: 0, kills: 0, date: 0 },
        { name: 'a', score: -1, loop: 0, kills: 0, date: 0 },
        { name: 'a', score: Infinity, loop: 0, kills: 0, date: 0 },
        { name: 'a', score: 1.5, loop: 0, kills: 0, date: 0 },
        { name: 'a', score: 10, loop: -1, kills: 0, date: 0 },
        { name: 'a', score: 10, loop: 0, kills: null, date: 0 },
        { name: 'a', score: 10, loop: 0, kills: 0, date: NaN },
        { name: 'a', score: 10, loop: 0, kills: 0 },
        null,
        'x',
      ],
      hard: 'pas une liste',
      nightmare: [entry(999)],
    },
  });
  check('sanitizeTable : seules les entrées valides gardées', t.normal.length === 1 && t.normal[0].score === 100, scoresOf(t.normal));
  check('sanitizeTable : liste non tableau → vide', t.hard.length === 0);
  check('sanitizeTable : difficulté inconnue ignorée', !('nightmare' in t) && Object.keys(t).length === 5);
  const n = sanitizeTable({ v: 1, tables: { easy: [{ name: ' 😀 ', score: 3, loop: 1, kills: 2, date: 7 }] } });
  check('sanitizeTable : nom nettoyé', n.easy[0]?.name === DEFAULT_NAME);

  const many = Array.from({ length: 15 }, (_, i) => entry((i * 37) % 15 + 1, i));
  const m = sanitizeTable({ v: 1, tables: { veryHard: many } });
  check('sanitizeTable : >10 entrées → tronqué', m.veryHard.length === MAX_SCORES);
  check('sanitizeTable : trié décroissant', m.veryHard.every((e, i, a) => i === 0 || a[i - 1].score >= e.score) && m.veryHard[0].score === 15, scoresOf(m.veryHard));
}

// ─── Stockage ───────────────────────────────────────────────────────────────
{
  const s = memStorage();
  const t = emptyTable();
  t.normal = [entry(300, 1, 'Musashi'), entry(200, 2, '武蔵')];
  t.veryHard = [entry(50, 3, 'Hélène')];
  check('saveScores → true', saveScores(t, s));
  check('clé de stockage', s.data.has('ronin.io/highscores/v1'));
  const raw = JSON.parse(s.data.get('ronin.io/highscores/v1') as string) as { v: number };
  check('format stocké { v: 1, tables }', raw.v === 1 && 'tables' in raw);
  const back = loadScores(s);
  check('aller-retour save/load', JSON.stringify(back) === JSON.stringify(t));
  check('loadScores storage vide → table vide', DIFFICULTY_ORDER.every((id) => loadScores(memStorage())[id].length === 0));

  const bad = memStorage();
  bad.setItem('ronin.io/highscores/v1', '{pas du json');
  check('JSON invalide → table vide', noThrow(() => loadScores(bad)) && loadScores(bad).normal.length === 0);

  check('getItem qui lève → pas d\'exception', noThrow(() => loadScores(throwing)));
  check('getItem qui lève → table vide', loadScores(throwing).normal.length === 0);
  check('setItem qui lève → false sans exception', noThrow(() => saveScores(t, throwing)) && saveScores(t, throwing) === false);
  check('storage null → table vide', loadScores(null).normal.length === 0);
  check('storage null → save false', saveScores(t, null) === false);
  check('storage par défaut (absent en node) → pas d\'exception', noThrow(() => loadScores()) && noThrow(() => saveScores(t)));

  // Préférences
  const p = memStorage();
  const def = loadPrefs(p);
  check('prefs par défaut', def.difficulty === 'normal' && def.name === '');
  check('savePrefs → true', savePrefs({ difficulty: 'hard', name: '  Hélène  ' }, p));
  check('clé des prefs', p.data.has('ronin.io/prefs/v1'));
  const lp = loadPrefs(p);
  check('aller-retour prefs', lp.difficulty === 'hard' && lp.name === 'Hélène', JSON.stringify(lp));
  p.setItem('ronin.io/prefs/v1', JSON.stringify({ v: 1, difficulty: 'nightmare', name: 7 }));
  const inv = loadPrefs(p);
  check('prefs : difficulté invalide → normal', inv.difficulty === 'normal' && inv.name === '', JSON.stringify(inv));
  p.setItem('ronin.io/prefs/v1', 'null');
  check('prefs : null stocké → défaut', loadPrefs(p).difficulty === 'normal');
  check('prefs : storage qui lève → défaut sans exception', noThrow(() => loadPrefs(throwing)) && loadPrefs(throwing).difficulty === 'normal');
  check('prefs : setItem qui lève → false', savePrefs({ difficulty: 'easy', name: 'x' }, throwing) === false);
  check('prefs : storage null → défaut / false', loadPrefs(null).difficulty === 'normal' && savePrefs(def, null) === false);
}

// ─── Robustesse complémentaire ──────────────────────────────────────────────
{
  check('nom non-chaîne → Ronin', sanitizeName(null as unknown as string) === DEFAULT_NAME && sanitizeName(42 as unknown as string) === DEFAULT_NAME);
  check('retour à la ligne → espace', sanitizeName('Ken\nji') === 'Ken ji', JSON.stringify(sanitizeName('Ken\nji')));
  const raw = (score: unknown, date: unknown = 1) => ({ v: 1, tables: { normal: [{ name: 'x', score, loop: 0, kills: 0, date }] } });
  const kept = (r: unknown) => sanitizeTable(r).normal.length;
  check(
    'entrées invalides rejetées (score décimal, Infinity, négatif, chaîne, date NaN)',
    kept(raw(1.5)) === 0 && kept(raw(Infinity)) === 0 && kept(raw(-3)) === 0 && kept(raw('100')) === 0 && kept(raw(10, NaN)) === 0 && kept(raw(10)) === 1,
  );
  const proto = JSON.parse('{"v":1,"tables":{"__proto__":{"normal":[{"name":"x","score":5,"loop":0,"kills":0,"date":1}]}}}') as unknown;
  const tp = sanitizeTable(proto);
  check('clé __proto__ dans les tables : ignorée, pas de pollution', tp.normal.length === 0 && ({} as Record<string, unknown>).normal === undefined);
  const longName = sanitizeTable({ v: 1, tables: { easy: [{ name: 'abcdefghijklmnopqrstuvwxyz', score: 5, loop: 0, kills: 0, date: 1 }] } });
  check('nom trop long en stockage → tronqué à 12', Array.from(longName.easy[0]?.name ?? '').length === MAX_NAME);

  // Cohérence qualifies / insertScore sur des listes pseudo-aléatoires (déterministes).
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let coherent = true;
  let sortedAfter = true;
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(rnd() * 12);
    const list = Array.from({ length: n }, (_, k) => entry(Math.floor(rnd() * 20), k)).sort(compareEntries).slice(0, MAX_SCORES);
    const sc = Math.floor(rnd() * 22) - 1;
    const res = insertScore(list, entry(sc, 1000));
    if (qualifies(list, sc) !== res.rank >= 0) coherent = false;
    if (res.rank >= 0 && res.list[res.rank].date !== 1000) coherent = false;
    if (!res.list.every((e, k, a) => k === 0 || compareEntries(a[k - 1], e) <= 0) || res.list.length > MAX_SCORES) sortedAfter = false;
  }
  check('qualifies ⇔ insertScore rang ≥ 0 (500 cas)', coherent);
  check('insertScore : liste toujours triée et ≤ 10 (500 cas)', sortedAfter);

  // Flux de fin de partie : insertion à égalité, sauvegarde, relecture → la ligne surlignée est bien la nouvelle.
  const s = memStorage();
  const t = emptyTable();
  t.hard = [100, 90, 80, 80, 70, 60, 50, 40, 30, 20].map((v, k) => entry(v, k + 1, `p${k}`));
  t.easy = [entry(5, 1, 'autre')];
  const { list, rank } = insertScore(t.hard, entry(80, 50, 'nouveau'));
  saveScores({ ...t, hard: list }, s);
  const back = loadScores(s);
  check(
    'égalité → sauvegarde → relecture : rang surligné = nouvelle entrée',
    rank === 4 && back.hard[rank]?.name === 'nouveau' && back.hard.length === MAX_SCORES && back.hard[9].score === 30,
    `rang=${rank} ligne=${back.hard[rank]?.name}`,
  );
  check('insertion dans une difficulté : les autres tables intactes', back.easy.length === 1 && back.easy[0].name === 'autre' && back.normal.length === 0);
}

console.log(failures === 0 ? '\nTous les tests des high scores passent.' : `\n${failures} échec(s).`);
if (failures > 0) (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
