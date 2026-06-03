import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<GameRoom>;
}

// Placeholder authoritative game-room Durable Object. The real implementation lands
// in T3 (worker/room.ts), at which point this file becomes `export { GameRoom } from
// "./room";` and this inline stub is deleted. Exported here so the wrangler v1
// migration (new_sqlite_classes:["GameRoom"]) resolves to a real class.
export class GameRoom extends DurableObject<Env> {
  override fetch(_req: Request): Response {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
