# Image de production de Ronin.io : un seul conteneur, le serveur Node sert le client construit (dist/)
# et le WebSocket sur la même origine, derrière le proxy de Coolify (Traefik, TLS).
# Alpine : son wget (busybox) sert au healthcheck ; le lockfile contient les binaires musl de rollup,
# esbuild est un binaire statique (linux-x64) et msgpackr-extract est optionnel (repli en JavaScript).

# --- Étape 1 : construction du client (Vite) et du serveur (esbuild) ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

# --- Étape 2 : exécution, dépendances de production seulement ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=2567 \
    STATIC_DIR=/app/dist \
    TRUST_PROXY=1 \
    MATCHMAKE_PER_MIN=20 \
    MATCHMAKE_BURST=10 \
    MAX_CONN_PER_IP=8 \
    STATS_EVERY_MS=60000 \
    MAX_ROOMS=50
COPY package.json package-lock.json ./
# express (pair de @colyseus/ws-transport, importé au chargement) est installé : --omit=dev garde les pairs.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/health || exit 1
# node en PID 1 (forme exec) : il reçoit directement le SIGTERM de Docker et ferme les salles proprement.
CMD ["node", "dist-server/index.mjs"]
