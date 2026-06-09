# Multi-stage build for the self-hosted (Dokploy / Node) target.
# The Cloudflare deploy does NOT use this file — it ships via `npm run deploy` (wrangler).

# ---- Stage 1: build the client + bundle the server ----
FROM node:22-slim AS build
WORKDIR /app

# Install all deps (incl. dev) from the lockfile for the build.
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources (.dockerignore trims node_modules/dist/tests/etc).
COPY . .

# Typecheck the Node target (esbuild itself does not typecheck), then build.
RUN npm run typecheck:node
RUN npm run build:client      # -> dist/client (index.html, hashed assets, models, textures)
RUN npm run build:server      # -> dist/server/index.js (esbuild bundle, deps external)

# ---- Stage 2: slim runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_ROOT=/app/dist/client

# Only production deps (ws, @hono/node-server, hono — kept external by the esbuild bundle).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Built artifacts only.
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/dist/server ./dist/server

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
