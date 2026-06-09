import { Hono } from "hono";
import { sanitizeRoom } from "./protocol";

export interface Env {
  // Untyped namespace: GameRoom no longer `extends DurableObject` (its logic lives in the
  // runtime-agnostic GameRoomCore), so it doesn't carry the RPC brand the generic param
  // requires. We only ever call `.getByName(...).fetch(...)`, which the untyped namespace
  // types fine; the binding still resolves by class name via the wrangler migration.
  ROOMS: DurableObjectNamespace;
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
