// Configuration du serveur par variables d'environnement (production : image Docker et Coolify).
// Fonctions pures, testables : index.ts les applique à process.env. Sans variable, rien ne change (dev, tests).
import { resolve } from 'node:path';

/** Durcissement pour Internet (derrière le proxy de Coolify, Traefik). Valeurs nulles ou vides : aucun contrôle. */
export interface GuardOptions {
  /** Proxys de confiance devant le serveur (1 = Traefik), seulement si le pair TCP est privé ou local. */
  trustProxy: number;
  /** Origines autorisées (pages du jeu, ex. https://ronin.apps.cr1ms0n.cloud), nettoyées ; vide : toutes. */
  allowedOrigins: string[];
  /** Matchmaking par IP : jetons rechargés par minute (0 : illimité) et rafale permise. */
  matchmakePerMin: number;
  matchmakeBurst: number;
  /** WebSocket simultanés par IP (0 : illimité). */
  maxConnPerIp: number;
}

/** Aucun contrôle (développement, tests existants). */
export const NO_GUARD: GuardOptions = { trustProxy: 0, allowedOrigins: [], matchmakePerMin: 0, matchmakeBurst: 0, maxConnPerIp: 0 };

/** Options lues dans l'environnement (sous-ensemble de StartOptions de app.ts). */
export interface EnvOptions {
  port: number;
  /** Dossier du client construit (dist/) servi par le serveur ; absent : aucun fichier statique. */
  staticDir?: string;
  guard: GuardOptions;
}

/** Entier positif ou nul d'une variable, sinon le défaut (valeur absente, non numérique, négative ou fractionnaire). */
function count(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Origine nettoyée : minuscules, sans espaces ni « / » final (comparée à l'en-tête Origin du navigateur). */
export function cleanOrigin(o: string): string {
  return o.trim().toLowerCase().replace(/\/+$/, '');
}

/** Lit PORT, STATIC_DIR, TRUST_PROXY, ALLOWED_ORIGINS, MATCHMAKE_PER_MIN, MATCHMAKE_BURST, MAX_CONN_PER_IP. */
export function optionsFromEnv(env: Record<string, string | undefined>, cwd: string = process.cwd()): EnvOptions {
  const p = count(env.PORT, 2567);
  const port = p > 0 && p <= 65535 ? p : 2567;
  const dir = env.STATIC_DIR?.trim();
  const perMin = count(env.MATCHMAKE_PER_MIN, 0);
  return {
    port,
    ...(dir ? { staticDir: resolve(cwd, dir) } : {}),
    guard: {
      trustProxy: count(env.TRUST_PROXY, 0),
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map(cleanOrigin).filter(Boolean),
      matchmakePerMin: perMin,
      // Rafale par défaut : la moitié du débit par minute (au moins 1), si un débit est fixé.
      matchmakeBurst: count(env.MATCHMAKE_BURST, perMin ? Math.max(1, Math.ceil(perMin / 2)) : 0),
      maxConnPerIp: count(env.MAX_CONN_PER_IP, 0),
    },
  };
}
