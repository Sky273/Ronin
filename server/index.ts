// Serveur en ligne de Ronin.io (mode coopératif « la route partagée »).
// Lancer : npm run dev:server (développement) ou npm run build:server && npm run start:server.
// Variables : PORT (défaut 2567), LAG_MS / JITTER_MS (latence simulée), STATS_EVERY_MS (logs de mesures).
import { lagFromEnv } from './lag';
import { startServer } from './app';

const envPort = Number(process.env.PORT || 2567);
const port = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : 2567;

const running = await startServer({ port, handleSignals: true });
// L'arrêt propre (SIGINT/SIGTERM) est géré par Colyseus : verrouillage et fermeture des salles, puis sortie.
running.server.onBeforeShutdown(() => console.log('[serveur] arrêt en cours…'));
running.server.onShutdown(() => console.log('[serveur] arrêté'));

const lag = lagFromEnv();
console.log(
  `[serveur] Ronin.io en écoute sur ws://localhost:${running.port} (salle 'coop', santé : /health)` +
    (lag ? ` — latence simulée ${lag.lagMs} ms + 0 à ${lag.jitterMs} ms par sens` : ''),
);
