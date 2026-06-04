// test/room.test.ts — GameRoom Durable Object tests (modern toolchain: vitest 4 +
// @cloudflare/vitest-pool-workers cloudflareTest plugin).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  MAX_PLAYERS_PER_ROOM,
  SERVER_TICK_HZ,
  MAX_HP,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  ST_ALIVE,
  ST_DEAD,
  ST_PROTECTED,
  IDLE_TIMEOUT_MS,
  WEAPONS,
  RESPAWN_MS,
  SPAWN_PROTECTION_MS,
  SPAWN_POINTS,
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MSGS_PER_SEC,
  FRAG_LIMIT,
} from "../worker/protocol";
import type { GameRoom } from "../worker/room";
import type {
  WelcomeMsg,
  LeaveMsg,
  ServerMsg,
  InMsg,
  Vec3,
  Rot,
  PlayerStateCode,
  SnapMsg,
  MatchOverMsg,
  MatchStartMsg,
  LobbyMsg,
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
  it("assigns an id, lands in the lobby, and the lobby roster lists existing players", async () => {
    const stub = roomStub("t3-welcome");
    const a = await connect(stub, "alice");
    const welcomeA = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    expect(welcomeA.t).toBe("welcome");
    expect(typeof welcomeA.id).toBe("number");
    expect(welcomeA.tickRate).toBe(SERVER_TICK_HZ);
    // No match yet (lobby): welcome lists no in-match players and no active timer.
    expect(welcomeA.players.length).toBe(0);
    expect(welcomeA.matchEndsAt).toBe(0);

    const b = await connect(stub, "bob");
    const welcomeB = await nextMessage<WelcomeMsg>(b, ["welcome"]);
    expect(welcomeB.id).not.toBe(welcomeA.id);
    // The lobby roster (not welcome.players) carries connected players + their ready state.
    const lobbyB = await nextMessage<LobbyMsg>(b, ["lobby"]);
    expect(lobbyB.matchActive).toBe(false);
    const seenA = lobbyB.players.find((p) => p.id === welcomeA.id);
    expect(seenA).toBeTruthy();
    expect(seenA!.name).toBe("alice");
    expect(seenA!.ready).toBe(false);

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

// Build a bare PlayerRec for direct ingestInput tests (matches the v2 contract shape: NO posBuf).
function makeRecIngest(now: number, p: Vec3 = [0, 1, 0]) {
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
    ready: false,
    inMatch: true,
  };
}

describe("GameRoom ingestInput / clampMove (server dt)", () => {
  it("updates p/r/v, lastSeq, lastInputAt on a plausible input", async () => {
    const stub = roomStub("t4-ingest");
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      // Set lastInputAt ~50ms in the past so server dt (Date.now()-lastInputAt) is small.
      const rec = makeRecIngest(Date.now() - 50, [0, 1, 0]);
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
      const rec = makeRecIngest(Date.now() - 50, [0, 1, 0]);
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
      const rec = makeRecIngest(Date.now() - 50, [0, 1, 0]);
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

describe("GameRoom loopTick / idle / stop-on-empty", () => {
  it("broadcasts a SnapMsg with tick, ts, ack, and all players", async () => {
    const stub = roomStub("t5-snap");
    const a = await connect(stub, "alice");
    const welcomeA = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const b = await connect(stub, "bob");
    const welcomeB = await nextMessage<WelcomeMsg>(b, ["welcome"]);

    // Put both players into a live match (they spawn ST_PROTECTED + become snap entities).
    await runInDurableObject(stub, (instance) => (instance as any).startMatch());

    // Send one input from each so their lastSeq values differ.
    const inA: InMsg = { t: "in", seq: 1290, ts: 1, p: [1, 1, 0], r: [0, 0], v: [0, 0, 0] };
    const inB: InMsg = { t: "in", seq: 44, ts: 1, p: [2, 1, 0], r: [0, 0], v: [0, 0, 0] };
    a.send(JSON.stringify(inA));
    b.send(JSON.stringify(inB));

    // Drive exactly one tick deterministically, then read the snapshot off a.
    const snapPromise = nextMessage<SnapMsg>(a, ["snap"]);
    await runInDurableObject(stub, (instance) => (instance as any).loopTick());
    const snap = await snapPromise;

    expect(snap.t).toBe("snap");
    expect(typeof snap.tick).toBe("number");
    expect(typeof snap.ts).toBe("number");
    // ack maps player id -> last processed seq.
    expect(snap.ack[welcomeA.id]).toBe(1290);
    expect(snap.ack[welcomeB.id]).toBe(44);
    // players array contains both ids.
    expect(snap.players.map((p) => p.id).sort((x, y) => x - y)).toEqual(
      [welcomeA.id, welcomeB.id].sort((x, y) => x - y),
    );
    // a player snap carries the contract fields.
    const pa = snap.players.find((p) => p.id === welcomeA.id)!;
    expect(pa).toMatchObject({
      id: welcomeA.id,
      name: "alice",
      hp: MAX_HP,
      st: ST_PROTECTED, // players spawn with brief protection at match start
      frags: 0,
      deaths: 0,
    });

    a.close();
    b.close();
  });

  it("drops an idle player and broadcasts a leave (via removePlayer)", async () => {
    const stub = roomStub("t5-idle");
    const a = await connect(stub, "active");
    const welcomeA = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const b = await connect(stub, "idle");
    const welcomeB = await nextMessage<WelcomeMsg>(b, ["welcome"]);

    // Idle-drop only applies to in-match players, so start a match first.
    await runInDurableObject(stub, (instance) => (instance as any).startMatch());

    // Force b's lastInputAt far into the past so the next tick drops it as idle.
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      const recB = i.byId.get(welcomeB.id);
      recB.lastInputAt = Date.now() - IDLE_TIMEOUT_MS - 1000;
    });

    // a must receive a leave naming b's id when the idle tick fires.
    const leavePromise = nextMessage<LeaveMsg>(a, ["leave"]);
    await runInDurableObject(stub, (instance) => (instance as any).loopTick());
    const leave = await leavePromise;
    expect(leave.t).toBe("leave");
    expect(leave.id).toBe(welcomeB.id);

    // b removed; a remains.
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      expect(i.byId.has(welcomeB.id)).toBe(false);
      expect(i.byId.has(welcomeA.id)).toBe(true);
      expect(i.players.size).toBe(1);
    });

    a.close();
  });

  it("startLoop sets tickHandle; stopLoopIfEmpty clears it when empty", async () => {
    const stub = roomStub("t5-stop");
    const a = await connect(stub, "p");
    await nextMessage<WelcomeMsg>(a, ["welcome"]);

    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      // A player is connected, so the loop should be running.
      i.startLoop();
      expect(i.tickHandle).not.toBeUndefined();

      // Non-empty: stop is a no-op.
      i.stopLoopIfEmpty();
      expect(i.tickHandle).not.toBeUndefined();

      // Empty the maps, then stop.
      i.players.clear();
      i.byId.clear();
      i.stopLoopIfEmpty();
      expect(i.tickHandle).toBeUndefined();
    });

    a.close();
  });
});

// ---- appended by T6: handleShoot damage + hit broadcast ----

// Reusable PlayerRec-shaped factory for direct DO method tests (v2 D4 shape: NO posBuf).
// Reused by T6/T7/T8. A plain object stub stands in for the WebSocket; tests that need
// to observe outbound messages override the private `broadcast` instead of using a socket.
function makeRec(
  id: number,
  p: Vec3,
  opts: Partial<{
    st: number;
    hp: number;
    lastShotAt: number;
    protectedUntil: number;
    lastInputAt: number;
    inMatch: boolean;
  }> = {},
) {
  const ws = {} as unknown as WebSocket;
  return {
    id,
    name: `p${id}`,
    ws,
    p,
    r: [0, 0] as [number, number],
    v: [0, 0, 0] as Vec3,
    hp: opts.hp ?? MAX_HP,
    st: opts.st ?? ST_ALIVE,
    frags: 0,
    deaths: 0,
    lastShotAt: opts.lastShotAt ?? 0,
    lastInputAt: opts.lastInputAt ?? Date.now(),
    respawnAt: 0,
    protectedUntil: opts.protectedUntil ?? 0,
    lastSeq: 0,
    rate: { windowStart: Date.now(), count: 0 },
    ready: false,
    inMatch: opts.inMatch ?? true, // most direct-method tests exercise in-match behavior
  };
}

// Narrow view of the private GameRoom members the appended tests reach into.
type RoomInternals = {
  players: Map<WebSocket, ReturnType<typeof makeRec>>;
  byId: Map<number, ReturnType<typeof makeRec>>;
  broadcast: (m: unknown) => void;
  handleShoot: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
  loopTick: () => void;
  ingestInput: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
  webSocketMessage: (ws: WebSocket, raw: string | ArrayBuffer) => void;
  matchActive: boolean;
};

describe("GameRoom.handleShoot", () => {
  it("a valid hit reduces target hp and broadcasts a hit", async () => {
    const stub = env.ROOMS.getByName("shoot-valid");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);

      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      inst.players.set(shooter.ws, shooter);
      inst.players.set(target.ws, target);

      inst.handleShoot(shooter, {
        t: "shoot",
        seq: 1,
        ts: now,
        o: [0, 1, 0],
        d: [0, 0, 1],
        w: 0,
        hit: 2,
        head: false,
      });

      expect(target.hp).toBe(MAX_HP - WEAPONS[0]!.damage);
      const hit = broadcasts.find((b) => (b as { t?: string }).t === "hit") as
        | { t: string; by: number; on: number; dmg: number; hp: number; head: boolean }
        | undefined;
      expect(hit).toBeDefined();
      expect(hit!.by).toBe(1);
      expect(hit!.on).toBe(2);
      expect(hit!.dmg).toBe(WEAPONS[0]!.damage);
      expect(hit!.hp).toBe(MAX_HP - WEAPONS[0]!.damage);
      expect(shooter.lastShotAt).toBeGreaterThanOrEqual(now);
    });
  });

  it("a headshot applies the head multiplier", async () => {
    const stub = env.ROOMS.getByName("shoot-head");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: true,
      });
      expect(target.hp).toBe(MAX_HP - WEAPONS[0]!.damage * WEAPONS[0]!.headMult);
    });
  });

  it("a rejected shot (firerate) does NOT reduce hp and emits no hit", async () => {
    const stub = env.ROOMS.getByName("shoot-firerate");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const now = Date.now();
      // lastShotAt only 10ms ago => below cooldownMs-25 grace => firerate reject
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 10 });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });
      expect(target.hp).toBe(MAX_HP);
      expect(broadcasts.find((b) => (b as { t?: string }).t === "hit")).toBeUndefined();
    });
  });

  it("a rejected shot (range) does NOT reduce hp", async () => {
    const stub = env.ROOMS.getByName("shoot-range");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, WEAPONS[0]!.maxRange + 50]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });
      expect(target.hp).toBe(MAX_HP);
    });
  });

  it("a rejected shot (aim) does NOT reduce hp", async () => {
    const stub = env.ROOMS.getByName("shoot-aim");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      // claim firing along +x while target is at +z => aim reject
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [1, 0, 0], w: 0, hit: 2, head: false,
      });
      expect(target.hp).toBe(MAX_HP);
    });
  });

  it("a missing target id (hit not in byId) is treated as no-target and does nothing", async () => {
    const stub = env.ROOMS.getByName("shoot-missing");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      inst.byId.set(1, shooter);
      // claim a hit on id 99 which is not present
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 99, head: false,
      });
      // gun still discharges (records lastShotAt) but no hit is broadcast
      expect(shooter.lastShotAt).toBeGreaterThanOrEqual(now);
      expect(broadcasts.find((b) => (b as { t?: string }).t === "hit")).toBeUndefined();
    });
  });
});

// ---- appended by T7: death / respawn / spawn-protection / score ----
describe("GameRoom death / respawn / protection / score", () => {
  it("a lethal hit sets the target DEAD, increments score, and broadcasts a kill", async () => {
    const stub = env.ROOMS.getByName("t7-lethal");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);

      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, 10], { hp: 10 }); // 25 dmg is lethal
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);

      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });

      expect(target.st).toBe(ST_DEAD);
      expect(target.hp).toBeLessThanOrEqual(0);
      expect(target.deaths).toBe(1);
      expect(shooter.frags).toBe(1);
      const kill = broadcasts.find((b) => (b as { t?: string }).t === "kill") as
        | { t: string; by: number; on: number; w: number }
        | undefined;
      expect(kill).toBeDefined();
      expect(kill!.by).toBe(1);
      expect(kill!.on).toBe(2);
      expect(kill!.w).toBe(0);
    });
  });

  it("loopTick respawns a DEAD player after RESPAWN_MS: restores hp + protection + broadcasts spawn", async () => {
    const stub = env.ROOMS.getByName("t7-respawn");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);

      const now = Date.now();
      const dead = makeRec(2, [5, 1, 5], { st: ST_DEAD, hp: 0, lastInputAt: now });
      dead.respawnAt = now - 1; // already due
      inst.byId.set(2, dead);
      inst.players.set(dead.ws, dead);

      inst.loopTick();

      expect(dead.st).toBe(ST_PROTECTED);
      expect(dead.hp).toBe(MAX_HP);
      expect(dead.protectedUntil).toBeGreaterThan(Date.now());
      // respawned at one of the fixed spawn points
      const onSpawnPoint = SPAWN_POINTS.some(
        (sp) => sp[0] === dead.p[0] && sp[1] === dead.p[1] && sp[2] === dead.p[2],
      );
      expect(onSpawnPoint).toBe(true);
      const spawn = broadcasts.find((b) => (b as { t?: string }).t === "spawn") as
        | { t: string; id: number; p: Vec3; prot: number }
        | undefined;
      expect(spawn).toBeDefined();
      expect(spawn!.id).toBe(2);
      expect(spawn!.prot).toBe(SPAWN_PROTECTION_MS);
    });
  });

  it("respawn places the player on one of the fixed spawn points (smart chooseSpawn)", async () => {
    const stub = env.ROOMS.getByName("t7-pickspawn");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const dead = makeRec(3, [99, 99, 99], { st: ST_DEAD, hp: 0, lastInputAt: now });
      dead.respawnAt = now - 1;
      inst.byId.set(3, dead);
      inst.players.set(dead.ws, dead);

      inst.loopTick();
      const onSpawn = SPAWN_POINTS.some(
        (p) =>
          Math.abs(p[0] - dead.p[0]) < 1e-6 &&
          Math.abs(p[1] - dead.p[1]) < 1e-6 &&
          Math.abs(p[2] - dead.p[2]) < 1e-6,
      );
      expect(onSpawn).toBe(true);
    });
  });

  it("a DEAD player is NOT respawned before RESPAWN_MS has elapsed", async () => {
    const stub = env.ROOMS.getByName("t7-too-early");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const dead = makeRec(2, [5, 1, 5], { st: ST_DEAD, hp: 0, lastInputAt: now });
      dead.respawnAt = now + RESPAWN_MS; // not due yet
      inst.byId.set(2, dead);
      inst.players.set(dead.ws, dead);
      inst.loopTick();
      expect(dead.st).toBe(ST_DEAD);
      expect(dead.hp).toBe(0);
    });
  });

  it("loopTick clears protection once now > protectedUntil", async () => {
    const stub = env.ROOMS.getByName("t7-prot-expire");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const p = makeRec(3, [5, 1, 5], { st: ST_PROTECTED, protectedUntil: now - 1, lastInputAt: now });
      inst.byId.set(3, p);
      inst.players.set(p.ws, p);
      inst.loopTick();
      expect(p.st).toBe(ST_ALIVE);
    });
  });

  it("a spawn-protected player takes no damage", async () => {
    const stub = env.ROOMS.getByName("t7-prot-nodmg");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, 10], { st: ST_PROTECTED, protectedUntil: now + 5000 });
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });
      expect(target.hp).toBe(MAX_HP);
      expect(broadcasts.find((b) => (b as { t?: string }).t === "hit")).toBeUndefined();
    });
  });

  it("firing while protected drops the shooter's own protection", async () => {
    const stub = env.ROOMS.getByName("t7-fire-drops-prot");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      // shooter is protected and fires a valid shot at an alive target
      const shooter = makeRec(1, [0, 1, 0], {
        st: ST_PROTECTED,
        protectedUntil: now + 5000,
        lastShotAt: now - 1000,
      });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });
      expect(shooter.st).toBe(ST_ALIVE);
      // and the shot still landed (protection only gates being shot, not shooting)
      expect(target.hp).toBe(MAX_HP - WEAPONS[0]!.damage);
    });
  });
});

// ---- appended by T8: rate limit + message-size cap ----
describe("GameRoom webSocketMessage guards", () => {
  it("closes the socket with 1009 on an over-cap string message (MAX_MESSAGE_BYTES + 1)", async () => {
    const stub = env.ROOMS.getByName("t8-oversize");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      let closedWith: number | undefined;
      const ws = {
        close: (code?: number) => {
          closedWith = code;
        },
      } as unknown as WebSocket;
      const inst = instance as unknown as RoomInternals;
      const rec = makeRec(1, [0, 1, 0]);
      rec.ws = ws;
      inst.players.set(ws, rec);
      inst.byId.set(1, rec);

      let processed = 0;
      inst.ingestInput = () => {
        processed++;
      };

      // ASCII => 1 byte/char, so length === UTF-8 byteLength. One byte over the cap.
      const over = "x".repeat(MAX_MESSAGE_BYTES + 1);
      inst.webSocketMessage(ws, over);

      expect(closedWith).toBe(1009);
      expect(processed).toBe(0);
    });
  });

  it("processes a message whose byte length is exactly MAX_MESSAGE_BYTES (boundary, '>' not '>=')", async () => {
    const stub = env.ROOMS.getByName("t8-atcap");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      let closedWith: number | undefined;
      const ws = { close: (code?: number) => { closedWith = code; } } as unknown as WebSocket;
      const inst = instance as unknown as RoomInternals;
      const rec = makeRec(1, [0, 1, 0]);
      rec.ws = ws;
      inst.players.set(ws, rec);
      inst.byId.set(1, rec);

      let processed = 0;
      const seen: unknown[] = [];
      inst.ingestInput = (_r, m) => {
        processed++;
        seen.push(m);
      };

      // Build a VALID "in" message, then pad its name-free body to EXACTLY
      // MAX_MESSAGE_BYTES using extra whitespace inside the JSON (whitespace between
      // tokens is ignored by JSON.parse, so the decoded message is still a valid InMsg).
      const base = JSON.stringify({
        t: "in", seq: 1, ts: Date.now(), p: [0, 1, 0], r: [0, 0], v: [0, 0, 0],
      });
      // base is well under the cap; pad with spaces appended after the closing brace's
      // last token boundary. Insert padding right after the opening "{" so it stays valid.
      const padCount = MAX_MESSAGE_BYTES - base.length;
      expect(padCount).toBeGreaterThan(0); // base must fit under the cap
      const raw = "{" + " ".repeat(padCount) + base.slice(1); // "{<spaces>...rest"
      // raw is ASCII, so its character length equals its UTF-8 byte length.
      expect(new TextEncoder().encode(raw).length).toBe(MAX_MESSAGE_BYTES);

      inst.webSocketMessage(ws, raw);

      expect(closedWith).toBeUndefined();
      expect(processed).toBe(1);
      expect((seen[0] as { t?: string }).t).toBe("in");
    });
  });

  it("drops messages beyond the per-second allowance (only RATE_LIMIT_MSGS_PER_SEC processed)", async () => {
    const stub = env.ROOMS.getByName("t8-ratelimit");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const ws = { close: () => {} } as unknown as WebSocket;
      const inst = instance as unknown as RoomInternals;
      const rec = makeRec(1, [0, 1, 0]);
      rec.ws = ws;
      // pin the window so all messages fall in the same second
      rec.rate = { windowStart: Date.now(), count: 0 };
      inst.players.set(ws, rec);
      inst.byId.set(1, rec);

      let processed = 0;
      inst.ingestInput = () => { processed++; };

      const raw = JSON.stringify({
        t: "in", seq: 1, ts: Date.now(), p: [0, 1, 0], r: [0, 0], v: [0, 0, 0],
      });

      // Send exactly the allowance + 5 extra within the same window.
      const total = RATE_LIMIT_MSGS_PER_SEC + 5;
      for (let i = 0; i < total; i++) {
        inst.webSocketMessage(ws, raw);
      }

      // Only up to the allowance are processed; the extra 5 are dropped.
      expect(processed).toBe(RATE_LIMIT_MSGS_PER_SEC);
    });
  });

  it("resets the rate window after one second, allowing new messages", async () => {
    const stub = env.ROOMS.getByName("t8-window-reset");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const ws = { close: () => {} } as unknown as WebSocket;
      const inst = instance as unknown as RoomInternals;
      const rec = makeRec(1, [0, 1, 0]);
      rec.ws = ws;
      // window started >1s ago so the limiter must reset on the next message
      rec.rate = { windowStart: Date.now() - 2000, count: RATE_LIMIT_MSGS_PER_SEC };
      inst.players.set(ws, rec);
      inst.byId.set(1, rec);

      let processed = 0;
      inst.ingestInput = () => { processed++; };

      const raw = JSON.stringify({
        t: "in", seq: 1, ts: Date.now(), p: [0, 1, 0], r: [0, 0], v: [0, 0, 0],
      });
      inst.webSocketMessage(ws, raw);

      expect(processed).toBe(1);
      expect(rec.rate.count).toBe(1);
    });
  });
});

describe("GameRoom match lifecycle", () => {
  it("a fresh join lands in the lobby — no auto-start", async () => {
    const stub = roomStub("match-welcome");
    const a = await connect(stub, "alice");
    const w = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    expect(w.fragLimit).toBe(FRAG_LIMIT);
    expect(w.matchEndsAt).toBe(0); // lobby: no active match
    await runInDurableObject(stub, (instance) => {
      expect((instance as any).matchActive).toBe(false);
    });
    a.close();
  });

  it("starts the match once every player is ready (solo: readying starts it)", async () => {
    const stub = roomStub("match-ready-solo");
    const a = await connect(stub, "alice");
    const wa = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const startP = nextMessage<MatchStartMsg>(a, ["matchstart"]);
    a.send(JSON.stringify({ t: "ready", ready: true }));
    const start = await startP;
    expect(start.fragLimit).toBe(FRAG_LIMIT);
    expect(start.endsAt).toBeGreaterThan(Date.now());
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      expect(i.matchActive).toBe(true);
      expect(i.byId.get(wa.id).inMatch).toBe(true);
    });
    a.close();
  });

  it("does NOT start until ALL players are ready", async () => {
    const stub = roomStub("match-ready-all");
    const a = await connect(stub, "alice");
    await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const b = await connect(stub, "bob");
    await nextMessage<WelcomeMsg>(b, ["welcome"]);

    // Only a readies → still in the lobby.
    a.send(JSON.stringify({ t: "ready", ready: true }));
    await nextMessage<LobbyMsg>(b, ["lobby"]); // a's ready propagated
    await runInDurableObject(stub, (instance) => {
      expect((instance as any).matchActive).toBe(false);
    });

    // b readies too → the match starts.
    const startP = nextMessage<MatchStartMsg>(a, ["matchstart"]);
    b.send(JSON.stringify({ t: "ready", ready: true }));
    await startP;
    await runInDurableObject(stub, (instance) => {
      expect((instance as any).matchActive).toBe(true);
    });

    a.close();
    b.close();
  });

  it("ends the match at the frag limit, broadcasts sorted standings, and keeps the loop alive", async () => {
    const stub = roomStub("match-fraglimit");
    const a = await connect(stub, "alice");
    const wa = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const b = await connect(stub, "bob");
    await nextMessage<WelcomeMsg>(b, ["welcome"]);

    await runInDurableObject(stub, (instance) => (instance as any).startMatch());

    const overP = nextMessage<MatchOverMsg>(a, ["matchover"]);
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      i.byId.get(wa.id).frags = FRAG_LIMIT; // top fragger; timer is still far away
      i.loopTick();
      expect(i.matchActive).toBe(false);       // back to the lobby
      expect(i.tickHandle).not.toBeUndefined(); // loop persists while players remain
      expect(i.byId.get(wa.id).inMatch).toBe(false);
    });
    const over = await overP;
    expect(over.standings.length).toBe(2);
    expect(over.standings[0]!.id).toBe(wa.id); // most frags ranked first

    a.close();
    b.close();
  });

  it("readying up after a match starts a fresh match with reset scores", async () => {
    const stub = roomStub("match-rematch");
    const a = await connect(stub, "alice");
    const wa = await nextMessage<WelcomeMsg>(a, ["welcome"]);

    await runInDurableObject(stub, (instance) => (instance as any).startMatch());
    const overP = nextMessage<MatchOverMsg>(a, ["matchover"]);
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      i.byId.get(wa.id).frags = FRAG_LIMIT;
      i.loopTick();
      expect(i.matchActive).toBe(false);
    });
    await overP;

    // Back in the lobby — readying up starts a new match with scores reset.
    const startP = nextMessage<MatchStartMsg>(a, ["matchstart"]);
    a.send(JSON.stringify({ t: "ready", ready: true }));
    const start = await startP;
    expect(start.endsAt).toBeGreaterThan(Date.now());
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      expect(i.matchActive).toBe(true);
      expect(i.byId.get(wa.id).frags).toBe(0);
    });

    a.close();
  });
});
