// Adresse du serveur de jeu : fonction pure, sans dépendance au navigateur ni à Vite (testable sous Node).
// En production, le serveur Node sert la page et le WebSocket sur la même origine (un seul conteneur derrière Traefik).

/** Serveur local de développement (npm run dev:server). */
export const DEV_SERVER_URL = 'ws://localhost:2567';

/**
 * Choisit l'adresse WebSocket du serveur :
 * 1. la variable VITE_SERVER_URL si elle est définie et non vide (nettoyée) ;
 * 2. le serveur local en développement, ou hors navigateur (pas de page) ;
 * 3. sinon la même origine que la page : wss:// si la page est en https: (ws:// y serait bloqué en contenu mixte),
 *    ws:// en http:, l'hôte gardant son port éventuel.
 */
export function resolveServerUrl(envUrl: string | undefined, page: { protocol: string; host: string } | null, dev: boolean): string {
  const env = envUrl?.trim();
  if (env) return env;
  if (dev || !page || !page.host) return DEV_SERVER_URL;
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}`;
}
