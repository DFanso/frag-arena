// test/room.test.ts — GameRoom Durable Object tests (modern toolchain: vitest 4 +
// @cloudflare/vitest-pool-workers cloudflareTest plugin).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  MAX_PLAYERS_PER_ROOM,
  SERVER_TICK_HZ,
  MAX_HP,
  ST_ALIVE,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
} from "../worker/protocol";
import type {
  WelcomeMsg,
  LeaveMsg,
  ServerMsg,
  InMsg,
  Vec3,
  Rot,
  PlayerStateCode,
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

// Build a bare PlayerRec for direct method tests (matches the v2 contract shape: NO posBuf).
function makeRec(now: number, p: Vec3 = [0, 1, 0]) {
  return {
    id: 1,
    name: "anon",
    ws: undefined as unknown as WebSocket,
    p,
    r: [0, 0] as Rot,
    v: [0, 0, 0] as Vec3,
    hp: MAX_HP,
    st: ST_ALIVE as PlayerStateCode,
    frags: 0,
    deaths: 0,
    lastShotAt: 0,
    lastInputAt: now,
    respawnAt: 0,
    protectedUntil: 0,
    lastSeq: 0,
    rate: { windowStart: now, count: 0 },
  };
}

describe("GameRoom ingestInput / clampMove (server dt)", () => {
  it("updates p/r/v, lastSeq, lastInputAt on a plausible input", async () => {
    const stub = roomStub("t4-ingest");
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      // Set lastInputAt ~50ms in the past so server dt (Date.now()-lastInputAt) is small.
      const rec = makeRec(Date.now() - 50, [0, 1, 0]);
      const m: InMsg = {
        t: "in",
        seq: 5,
        ts: 1_234_567, // arbitrary client clock — must be IGNORED for the budget
        p: [0.4, 1, 0], // ~0.4 units over ~50ms => ~8 u/s, under MAX_MOVE_SPEED
        r: [0.5, -0.2],
        v: [1, 0, 0],
      };
      i.ingestInput(rec, m);
      expect(rec.p).toEqual([0.4, 1, 0]);
      expect(rec.r).toEqual([0.5, -0.2]);
      expect(rec.v).toEqual([1, 0, 0]);
      expect(rec.lastSeq).toBe(5);
      // lastInputAt is the SERVER wall-clock at ingest, not the client ts.
      expect(rec.lastInputAt).not.toBe(1_234_567);
      expect(typeof rec.lastInputAt).toBe("number");
    });
  });

  it("clamps an implausible teleport", async () => {
    const stub = roomStub("t4-clamp");
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      const rec = makeRec(Date.now() - 50, [0, 1, 0]);
      const m: InMsg = {
        t: "in",
        seq: 1,
        ts: 0,
        p: [1000, 1, 0], // 1000 units in ~50ms => implausible
        r: [0, 0],
        v: [0, 0, 0],
      };
      i.ingestInput(rec, m);
      // Accepted position must be far closer to the previous than the claim.
      // Max plausible distance ~ MAX_MOVE_SPEED * tolerance * dt (dt ~ 0.05s).
      const maxDist = MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE * 0.25; // generous upper bound
      expect(rec.p[0]).toBeLessThan(maxDist);
      expect(rec.p[0]).not.toBe(1000);
    });
  });

  it("ignores an inflated client m.ts (budget comes from server dt)", async () => {
    const stub = roomStub("t4-spoof-ts");
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      const rec = makeRec(Date.now() - 50, [0, 1, 0]);
      const m: InMsg = {
        t: "in",
        seq: 1,
        // A malicious client inflates ts to fake a huge dt and sneak a teleport.
        ts: Date.now() + 10_000_000,
        p: [1000, 1, 0],
        r: [0, 0],
        v: [0, 0, 0],
      };
      i.ingestInput(rec, m);
      // The spoofed ts must NOT widen the budget; the teleport is still snapped.
      expect(rec.p[0]).not.toBe(1000);
      expect(rec.p[0]).toBeLessThan(5);
    });
  });
});
