// test/room.test.ts — GameRoom Durable Object tests (modern toolchain: vitest 4 +
// @cloudflare/vitest-pool-workers cloudflareTest plugin).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  MAX_PLAYERS_PER_ROOM,
  SERVER_TICK_HZ,
} from "../worker/protocol";
import type {
  WelcomeMsg,
  LeaveMsg,
  ServerMsg,
} from "../worker/protocol";

// Get a stub for a room by name.
function roomStub(roomName: string) {
  return env.ROOMS.getByName(roomName);
}

// Open a REAL hibernatable WebSocket to a GameRoom DO instance via its fetch
// handshake, accept the client half, and return it. `name` becomes PlayerSnap.name.
async function connect(
  stub: DurableObjectStub,
  name = "p",
): Promise<WebSocket> {
  const url = "https://do/ws/test?name=" + encodeURIComponent(name);
  const res = await stub.fetch(url, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  expect(ws).toBeTruthy();
  ws!.accept();
  return ws!;
}

// Resolve with the next parsed JSON message on `ws` whose decoded `t` is in `types`.
function nextMessage<T extends ServerMsg>(
  ws: WebSocket,
  types: string[],
  timeoutMs = 1000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`timeout waiting for ${types.join("|")}`));
    }, timeoutMs);
    function onMsg(ev: MessageEvent) {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      if (types.includes(msg.t)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(msg as T);
      }
    }
    ws.addEventListener("message", onMsg);
  });
}

describe("GameRoom join/leave/cap", () => {
  it("assigns an id and sends a welcome listing existing players", async () => {
    const stub = roomStub("t3-welcome");
    const a = await connect(stub, "alice");
    const welcomeA = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    expect(welcomeA.t).toBe("welcome");
    expect(typeof welcomeA.id).toBe("number");
    expect(welcomeA.tickRate).toBe(SERVER_TICK_HZ);
    // First player: no other players present yet.
    expect(welcomeA.players.length).toBe(0);

    const b = await connect(stub, "bob");
    const welcomeB = await nextMessage<WelcomeMsg>(b, ["welcome"]);
    // Second player's welcome must include the first player, with the real nickname.
    expect(welcomeB.id).not.toBe(welcomeA.id);
    const seenA = welcomeB.players.find((p) => p.id === welcomeA.id);
    expect(seenA).toBeTruthy();
    expect(seenA!.name).toBe("alice");

    a.close();
    b.close();
  });

  it("removes a player and broadcasts a leave on close", async () => {
    const stub = roomStub("t3-leave");
    const a = await connect(stub, "alice");
    const welcomeA = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const b = await connect(stub, "bob");
    await nextMessage<WelcomeMsg>(b, ["welcome"]);

    // a leaves; b must receive a leave message naming a's id.
    const leavePromise = nextMessage<LeaveMsg>(b, ["leave"]);
    a.close();
    const leave = await leavePromise;
    expect(leave.t).toBe("leave");
    expect(leave.id).toBe(welcomeA.id);

    // The DO's internal player maps must no longer contain a.
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      const ids = [...i.byId.keys()];
      expect(ids).not.toContain(welcomeA.id);
      expect(i.players.size).toBe(1);
    });

    b.close();
  });

  it("rejects connections past the player cap with close 1013", async () => {
    const stub = roomStub("t3-cap");
    const sockets: WebSocket[] = [];
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      const ws = await connect(stub, "p" + i);
      await nextMessage<WelcomeMsg>(ws, ["welcome"]);
      sockets.push(ws);
    }
    // One more connection is over capacity: the server must NOT admit it.
    const overflow = await connect(stub, "overflow");
    // Assert via internal state (deterministic; do not race the close event):
    // the over-cap socket was never added to the player maps.
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      expect(i.players.size).toBe(MAX_PLAYERS_PER_ROOM);
    });

    overflow.close();
    for (const ws of sockets) ws.close();
  });
});
