import { Hono } from "hono";
import {
  sanitizeRoom,
  WS_CONN_LIMIT_PER_IP,
  WS_CONN_WINDOW_MS,
} from "./protocol";
import { ConnRateLimiter } from "./ratelimit";

export interface Env {
  // Untyped namespace: GameRoom no longer `extends DurableObject` (its logic lives in the
  // runtime-agnostic GameRoomCore), so it doesn't carry the RPC brand the generic param
  // requires. We only ever call `.getByName(...).fetch(...)`, which the untyped namespace
  // types fine; the binding still resolves by class name via the wrangler migration.
  ROOMS: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// Per-IP WebSocket-upgrade flood guard. Lives in the isolate's memory (see ratelimit.ts) so it
// costs nothing extra against the free-tier request budget; the edge WAF rule documented in
// wrangler.jsonc is the authoritative backstop.
const wsLimiter = new ConnRateLimiter(WS_CONN_LIMIT_PER_IP, WS_CONN_WINDOW_MS);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/ws/:room", (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected websocket", 426);
  }
  // Throttle before admitting the socket. Behind Cloudflare CF-Connecting-IP is always present;
  // fall back to a shared bucket if it's somehow absent (fail closed onto one window, not open).
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  wsLimiter.sweep();
  if (!wsLimiter.hit(ip)) {
    return c.text("Too many connections", 429, {
      "Retry-After": String(Math.ceil(WS_CONN_WINDOW_MS / 1000)),
    });
  }
  const room = sanitizeRoom(c.req.param("room"));
  const stub = c.env.ROOMS.getByName(room);
  return stub.fetch(c.req.raw);
});

export default app;
export { GameRoom } from "./room";
