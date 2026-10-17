// Serveur en ligne de Ronin.io (la route partagée et le dojo).
// Lancer : npm run dev:server (développement) ou npm run build:server && npm run start:server.
// Variables (voir server/config.ts et docs/DEPLOY.md) : PORT, STATIC_DIR (fichiers du jeu, production), TRUST_PROXY,
// ALLOWED_ORIGINS, MATCHMAKE_PER_MIN / MATCHMAKE_BURST, MAX_CONN_PER_IP, MAX_ROOMS, STATS_EVERY_MS,
// LAG_MS / JITTER_MS (latence simulée, tests seulement).
import { lagFromEnv } from './lag';
import { startServer } from './app';
import { optionsFromEnv } from './config';

// Filet : une promesse rejetée sans gestionnaire (dans le framework) arrêterait le processus et toutes ses salles.
process.on('unhandledRejection', (reason) => console.error('[serveur] promesse rejetée non rattrapée', reason));

// Arrêt (Coolify redéploie par SIGTERM) : Colyseus ferme les salles proprement (code 4001 aux joueurs), mais la
// fermeture des WebSocket peut traîner ; sortie forcée avant le SIGKILL de Docker (10 s).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => setTimeout(() => process.exit(0), 8000).unref());
}

const opts = optionsFromEnv(process.env);
// Production (fichiers du jeu servis) : seule la méthode du client (joinOrCreate) ; en développement, toutes.
const running = await startServer({ ...opts, ...(opts.staticDir ? { matchmakeMethods: ['joinOrCreate'] } : {}), handleSignals: true });
running.server.onBeforeShutdown(() => console.log('[serveur] arrêt en cours…'));
running.server.onShutdown(() => console.log('[serveur] arrêté'));

const g = opts.guard;
const lag = lagFromEnv();
console.log(
  `[serveur] Ronin.io en écoute sur le port ${running.port}, toutes interfaces (salles 'coop' et 'dojo', santé : /health)` +
    (lag ? ` — latence simulée ${lag.lagMs} ms + 0 à ${lag.jitterMs} ms par sens` : ''),
);
if (running.site) console.log(`[serveur] statiques : ${running.site.files} fichiers, ${(running.site.bytes / 1024).toFixed(0)} Kio depuis ${opts.staticDir}`);
console.log(
  `[serveur] limites : ${g.matchmakePerMin ? `${g.matchmakePerMin} parties/min par IP (rafale ${g.matchmakeBurst})` : 'matchmaking illimité'}, ` +
    `${g.maxConnPerIp ? `${g.maxConnPerIp} connexions par IP` : 'connexions illimitées'} ; origines : ${g.allowedOrigins.join(', ') || 'toutes'} ; ` +
    `proxys de confiance : ${g.trustProxy}`,
);
if (process.env.NODE_ENV === 'production') {
  if (lag) console.warn('[serveur] attention : latence simulée (LAG_MS/JITTER_MS) active en production');
  if (g.trustProxy > 0 && !g.allowedOrigins.length) console.warn('[serveur] attention : ALLOWED_ORIGINS vide en production (aucun contrôle d\'origine)');
}
// Origine sans schéma (ronin.example.com au lieu de https://ronin.example.com) : aucune page ne correspondrait.
for (const o of g.allowedOrigins) {
  if (!/^https?:\/\//.test(o)) console.warn(`[serveur] attention : origine « ${o} » sans http:// ni https:// : elle ne correspondra à aucune page`);
}
