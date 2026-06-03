// worker/index.ts — Worker entry: Env types, /api/health, and the single GameRoom export.
import { Hono } from "hono";
import type { GameRoom } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// /ws/:room forwarding is finalized in T9.

export default app;

// Exactly ONE exported GameRoom; the migration new_sqlite_classes:["GameRoom"] binds here.
export { GameRoom } from "./room";
