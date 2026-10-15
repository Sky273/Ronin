// ─── High scores locaux : top 10 par difficulté ─────────────────────────────
// Module pur (ni Phaser ni DOM au chargement). Le stockage est injectable pour
// les tests ; par défaut on utilise localStorage s'il est accessible.

import { DIFFICULTY_ORDER, type DifficultyId } from '../../shared/difficulty';
import { DEFAULT_NAME, MAX_NAME, MAX_SCORES, type ScoreEntry, type ScoreTable } from './types';

export type KV = Pick<Storage, 'getItem' | 'setItem'>;

export interface Prefs {
  difficulty: DifficultyId;
  name: string;
}

const SCORES_KEY = 'ronin.io/highscores/v1';
const PREFS_KEY = 'ronin.io/prefs/v1';
const VERSION = 1;

// ─── Fonctions pures ────────────────────────────────────────────────────────

/** Table vide : une liste vide par difficulté. */
export function emptyTable(): ScoreTable {
  const t = {} as ScoreTable;
  for (const id of DIFFICULTY_ORDER) t[id] = [];
  return t;
}

const isDifficulty = (v: unknown): v is DifficultyId =>
  typeof v === 'string' && (DIFFICULTY_ORDER as string[]).includes(v);

/** Nettoie un nom sans appliquer le nom par défaut (peut renvoyer ''). */
function cleanName(s: string): string {
  const kept = s
    .normalize('NFC')
    .replace(/\s/gu, ' ') // tabulations, retours… deviennent des espaces
    .replace(/[^\p{L}\p{N} ._-]/gu, '') // contrôles, emoji, symboles retirés
    .replace(/ {2,}/g, ' ')
    .trim();
  // Coupe en points de code (pas en unités UTF-16), puis retire l'espace final éventuel.
  return Array.from(kept).slice(0, MAX_NAME).join('').trim();
}

/** Nom affichable : caractères autorisés seulement, MAX_NAME max, DEFAULT_NAME si vide. */
export function sanitizeName(s: string): string {
  return cleanName(typeof s === 'string' ? s : '') || DEFAULT_NAME;
}

/** Score décroissant ; à égalité, la plus ancienne devant. */
export function compareEntries(a: ScoreEntry, b: ScoreEntry): number {
  return b.score - a.score || a.date - b.date;
}

/** Entier sûr, positif et borné : une valeur trafiquée (1e300…) ne peut pas squatter le tableau. */
const MAX_COUNT = 1e9;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT;

/** Valide une entrée brute ; null si invalide. */
function sanitizeEntry(raw: unknown): ScoreEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;
  if (!isCount(r.score) || !isCount(r.loop) || !isCount(r.kills)) return null;
  if (typeof r.date !== 'number' || !Number.isFinite(r.date)) return null;
  return { name: sanitizeName(r.name), score: r.score, loop: r.loop, kills: r.kills, date: r.date };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reconstruit une table saine depuis le format stocké `{ v: 1, tables }` ; sinon table vide. */
export function sanitizeTable(raw: unknown): ScoreTable {
  const table = emptyTable();
  if (!isPlainObject(raw) || raw.v !== VERSION) return table;
  const tables = raw.tables;
  if (!isPlainObject(tables)) return table;
  for (const id of DIFFICULTY_ORDER) {
    // hasOwnProperty : ne pas lire une éventuelle clé héritée du prototype
    const list = Object.prototype.hasOwnProperty.call(tables, id) ? tables[id] : undefined;
    if (!Array.isArray(list)) continue;
    const entries: ScoreEntry[] = [];
    for (const e of list) {
      const ok = sanitizeEntry(e);
      if (ok) entries.push(ok);
    }
    entries.sort(compareEntries);
    table[id] = entries.slice(0, MAX_SCORES);
  }
  return table;
}

/** Le score entre-t-il dans la liste (supposée triée) ? */
export function qualifies(list: ScoreEntry[], score: number, max = MAX_SCORES): boolean {
  if (!(score > 0)) return false;
  if (list.length < max) return true;
  return score > list[max - 1].score;
}

/**
 * Insère une entrée dans une copie de la liste (supposée triée).
 * À égalité de score, la nouvelle entrée se place après les anciennes.
 * Rang 0-based, -1 si l'entrée ne figure pas dans le top (dont score ≤ 0,
 * cohérent avec qualifies).
 */
export function insertScore(
  list: ScoreEntry[],
  entry: ScoreEntry,
  max = MAX_SCORES,
): { list: ScoreEntry[]; rank: number } {
  const copy = list.slice(0, max);
  if (!(entry.score > 0)) return { list: copy, rank: -1 };
  let idx = copy.findIndex((e) => e.score < entry.score);
  if (idx === -1) idx = copy.length;
  if (idx >= max) return { list: copy, rank: -1 };
  copy.splice(idx, 0, entry);
  return { list: copy.slice(0, max), rank: idx };
}

// ─── Accès au stockage ──────────────────────────────────────────────────────

/** localStorage si accessible (l'accès lui-même peut lever en navigation privée), sinon null. */
function defaultStorage(): KV | null {
  try {
    const ls = (globalThis as { localStorage?: KV }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/** undefined → storage par défaut ; null → aucun storage. */
const resolve = (storage: KV | null | undefined): KV | null =>
  storage === undefined ? defaultStorage() : storage;

function readJson(storage: KV | null | undefined, key: string): unknown {
  try {
    const s = resolve(storage);
    if (!s) return null;
    const txt = s.getItem(key);
    return txt == null ? null : (JSON.parse(txt) as unknown);
  } catch {
    return null;
  }
}

function writeJson(storage: KV | null | undefined, key: string, value: unknown): boolean {
  try {
    const s = resolve(storage);
    if (!s) return false;
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Charge les high scores ; table vide en cas de problème, sans jamais lever. */
export function loadScores(storage?: KV | null): ScoreTable {
  return sanitizeTable(readJson(storage, SCORES_KEY));
}

/** Enregistre les high scores ; false si l'écriture échoue (quota, absence…), ne lève jamais. */
export function saveScores(table: ScoreTable, storage?: KV | null): boolean {
  return writeJson(storage, SCORES_KEY, { v: VERSION, tables: table });
}

/** Préférences : difficulté et nom ; valeurs invalides remplacées par les défauts. */
export function loadPrefs(storage?: KV | null): Prefs {
  const prefs: Prefs = { difficulty: 'normal', name: '' };
  const raw = readJson(storage, PREFS_KEY);
  if (!isPlainObject(raw) || raw.v !== VERSION) return prefs;
  if (isDifficulty(raw.difficulty)) prefs.difficulty = raw.difficulty;
  // Le nom reste '' s'il est vide après nettoyage (DEFAULT_NAME s'applique à l'enregistrement du score).
  if (typeof raw.name === 'string') prefs.name = cleanName(raw.name);
  return prefs;
}

/** Enregistre les préférences (format `{ v: 1, difficulty, name }`) ; ne lève jamais. */
export function savePrefs(p: Prefs, storage?: KV | null): boolean {
  const difficulty = isDifficulty(p?.difficulty) ? p.difficulty : 'normal';
  const name = typeof p?.name === 'string' ? cleanName(p.name) : '';
  return writeJson(storage, PREFS_KEY, { v: VERSION, difficulty, name });
}
