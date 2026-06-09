// worker/room.ts — Cloudflare Durable Object adapter over GameRoomCore.
//
// All game logic lives in GameRoomCore (worker/game-core.ts), shared verbatim with the Node
// server (server/index.ts). This class only wires the Cloudflare Hibernation WebSocket API to
// the core's transport-agnostic entry points (accept / routeMessage / removePlayer).
//
// It deliberately does NOT `extends DurableObject`: the runtime DO contract is a
// `constructor(ctx, env)` + the hibernation handler methods + a named export, and the
// `new_sqlite_classes:["GameRoom"]` migration binds by class NAME. Extending the core (rather
// than DurableObject) keeps loopTick / byId / handleShoot / etc. on the instance, so the
// existing DO test suite (test/room.test.ts) reaches them unchanged. We declare `ctx` ourselves
// (exactly what the DurableObject base class would have assigned).
import { GameRoomCore } from "./game-core";
import type { Env } from "./index";

export class GameRoom extends GameRoomCore {
  constructor(private ctx: DurableObjectState, _env: Env) {
    super();
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: do NOT call server.accept(). Auto-respond to pings for free (keeps the
    // socket alive without waking the DO from hibernation).
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    // Nickname travels in the WS URL query (?name=...). The core sanitizes it.
    const name = new URL(req.url).searchParams.get("name") ?? undefined;
    if (!this.accept(server, name)) {
      // Room full: accept then immediately close so the client sees a clean 1013. The socket is
      // never added to players/byId.
      server.close(1013, "room full");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation handlers — the runtime calls these on the instance by name; each delegates to
  // the inherited core. A CF `WebSocket` structurally satisfies the core's `Conn` seam.
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    this.routeMessage(ws, raw);
  }

  webSocketClose(ws: WebSocket): void {
    this.removePlayer(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.removePlayer(ws);
  }
}
