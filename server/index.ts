// server/index.ts — Node host for the self-hosted (Dokploy) deployment.
//
// Serves the built client (dist/client) over HTTP and drives a GameRoomCore per room over a
// `ws` WebSocket. This is the Node counterpart of the Cloudflare worker (worker/index.ts +
// worker/room.ts): same game logic (GameRoomCore), different transport. The Cloudflare deploy
// is untouched — this file is only used by `npm run build:server` / `npm start`.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";
import { join } from "node:path";
import { GameRoomCore } from "../worker/game-core";
import {
  sanitizeRoom,
  WS_CONN_LIMIT_PER_IP,
  WS_CONN_WINDOW_MS,
} from "../worker/protocol";
import type { Conn } from "../worker/protocol";
import { ConnRateLimiter } from "../worker/ratelimit";

const PORT = Number(process.env.PORT ?? 8080);
// Static root, cwd-relative. The Dockerfile sets WORKDIR /app and copies the client to
// /app/dist/client, so the default works; override with STATIC_ROOT if running elsewhere.
const STATIC_ROOT = process.env.STATIC_ROOT ?? "dist/client";

// ---- HTTP (Hono on @hono/node-server) ----
const app = new Hono();
// Security headers on every response. The Cloudflare deploy gets these from public/_headers
// (served by the Workers Assets binding); the Node host serves the same client, so it must set
// the identical set itself. Keep the CSP in sync with public/_headers.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; " +
  "worker-src 'self' blob:; manifest-src 'self'; base-uri 'self'; form-action 'self'; " +
  "object-src 'none'; frame-ancestors 'none'";
app.use("/*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CSP);
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});
app.get("/api/health", (c) => c.json({ ok: true }));
// Real static files (hashed JS/CSS, models, textures, and index.html for "/").
app.use("/*", serveStatic({ root: STATIC_ROOT }));
// SPA fallback: any other GET serves index.html (mirrors the CF
// not_found_handling:"single-page-application"). /api/* matched above; /ws/* never reaches Hono
// (it arrives as an HTTP upgrade, handled below).
app.get("*", serveStatic({ path: join(STATIC_ROOT, "index.html") }));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`cf-fps node server listening on :${info.port} (static root: ${STATIC_ROOT})`);
});

// ---- Rooms (in-process; one GameRoomCore per room code) ----
const rooms = new Map<string, GameRoomCore>();
function getRoom(code: string): GameRoomCore {
  let room = rooms.get(code);
  if (!room) {
    room = new GameRoomCore();
    rooms.set(code, room);
  }
  return room;
}

// ---- WebSocket upgrade (we own it; @hono/node-server doesn't see upgrade events) ----
// noServer mode + an explicit path guard so we never hijack a non-/ws upgrade.
const wss = new WebSocketServer({ noServer: true });
// Heartbeat liveness (replaces the DO's setWebSocketAutoResponse keep-alive + dead-socket
// reaping). Browsers auto-answer protocol pings; a socket that misses a round is terminated.
const alive = new WeakMap<WsSocket, boolean>();
// Per-IP WebSocket-upgrade flood guard (issue #15), mirroring the Cloudflare worker. Behind a
// reverse proxy (Dokploy) the client IP is the first X-Forwarded-For hop; fall back to the raw
// socket address. Reuses the shared pure limiter.
const wsLimiter = new ConnRateLimiter(WS_CONN_LIMIT_PER_IP, WS_CONN_WINDOW_MS);
function clientIp(req: import("node:http").IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

server.on("upgrade", (req, socket, head) => {
  let pathname: string;
  let params: URLSearchParams;
  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    pathname = u.pathname;
    params = u.searchParams;
  } catch {
    socket.destroy();
    return;
  }
  const m = /^\/ws\/([^/?]+)$/.exec(pathname);
  if (!m) {
    socket.destroy(); // not our path — refuse the upgrade
    return;
  }
  // Throttle before the upgrade handshake. Refuse floods with a 429 then drop the socket.
  wsLimiter.sweep();
  if (!wsLimiter.hit(clientIp(req))) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const roomCode = sanitizeRoom(decodeURIComponent(m[1]!));
  const name = params.get("name") ?? undefined;
  wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws, roomCode, name));
});

function handleSocket(ws: WsSocket, roomCode: string, name: string | undefined): void {
  const core = getRoom(roomCode);
  // Adapt the ws socket to the transport-agnostic Conn seam the core speaks.
  const conn: Conn = {
    send: (data) => {
      try {
        ws.send(data);
      } catch {
        /* socket closing; ignore */
      }
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed; ignore */
      }
    },
  };

  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // v1 protocol is text-only
    core.routeMessage(conn, data.toString());
  });
  const onGone = () => {
    core.removePlayer(conn);
    if (core.isEmpty()) rooms.delete(roomCode); // drop the empty room (mirrors DO eviction)
  };
  ws.on("close", onGone);
  ws.on("error", onGone);

  if (!core.accept(conn, name)) {
    ws.close(1013, "room full"); // never registered; onGone cleans the (still-empty) room
  }
}

const HEARTBEAT_MS = 30_000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_MS).unref();
