import { Hono } from "hono";
import type { GameRoom } from "./room";
import { sanitizeRoom } from "./protocol";

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/ws/:room", (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected websocket", 426);
  }
  const room = sanitizeRoom(c.req.param("room"));
  const stub = c.env.ROOMS.getByName(room);
  return stub.fetch(c.req.raw);
});

export default app;
export { GameRoom } from "./room";
