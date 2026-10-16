// Construction du serveur Colyseus (partagée par l'exécutable et les tests).
import type { AddressInfo } from 'node:net';
import { createEndpoint, createRouter, defineRoom, defineServer, matchMaker, type Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { CoopRoom } from './rooms/CoopRoom';

/** Taille maximale d'un message client (octets) : les entrées font une dizaine d'octets. */
export const MAX_PAYLOAD = 4096;

export interface StartOptions {
  /** Port d'écoute ; 0 pour un port libre choisi par le système. */
  port: number;
  /** Arrêt propre sur SIGINT/SIGTERM (et sortie du processus). */
  handleSignals?: boolean;
  /** Bannière Colyseus au démarrage. */
  greet?: boolean;
}

export interface RunningServer {
  server: Server;
  port: number;
  /** Arrêt propre sans quitter le processus. */
  stop(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const transport = new WebSocketTransport({ maxPayload: MAX_PAYLOAD });
  const server = defineServer({
    transport,
    greet: opts.greet ?? false,
    gracefullyShutdown: opts.handleSignals ?? false,
    rooms: { coop: defineRoom(CoopRoom) },
    routes: createRouter({
      // Sonde de santé : nombre de salles et de joueurs de ce processus.
      health: createEndpoint('/health', { method: 'GET' }, async () => {
        const { roomCount, ccu } = matchMaker.stats.local;
        return new Response(JSON.stringify({ ok: true, rooms: roomCount, players: ccu }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    }),
  });
  await server.listen(opts.port);
  const addr = transport.server?.address() as AddressInfo | null;
  const port = addr && typeof addr === 'object' ? addr.port : opts.port;
  return { server, port, stop: () => server.gracefullyShutdown(false) };
}
