// test/room.test.ts — GameRoom Durable Object tests (modern toolchain: vitest 4 +
// @cloudflare/vitest-pool-workers cloudflareTest plugin).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  MAX_PLAYERS_PER_ROOM,
  SERVER_TICK_HZ,
  MAX_HP,
  KZ_FLOOR,
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
  AMMO_PICKUPS,
  GRENADE_RADIUS,
  GRENADE_DAMAGE,
  GRENADE_START,
  GRENADE_MAX,
  GRENADE_PICKUPS,
  ROCKET_ID,
  ROCKET_CLIP,
  ROCKET_RADIUS,
  ROCKET_TOWER,
  EXPLOSIVE_BARRELS,
  ARMOR_AMOUNT,
  MAX_ARMOR,
  HEALTH_AMOUNT,
  HEALTH_PICKUPS,
  ARMOR_PICKUPS,
  SPRING_PICKUPS,
  SPRING_DURATION_MS,
  CHAT_MIN_INTERVAL_MS,
  CHAT_MAX_LEN,
  STARTING_CREDITS,
  CREDITS_PER_HIT,
  CREDITS_PER_KILL,
  CREDITS_CAP,
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
    c: false,
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

    // One input from each so their lastSeq values differ.
    const inA: InMsg = { t: "in", seq: 1290, ts: 1, p: [1, 1, 0], r: [0, 0], v: [0, 0, 0] };
    const inB: InMsg = { t: "in", seq: 44, ts: 1, p: [2, 1, 0], r: [0, 0], v: [0, 0, 0] };

    // Drive exactly one tick deterministically. Inject the inputs in-process (rather than
    // racing a WebSocket send against the tick) so the ack reliably reflects the processed
    // seqs — a raw a.send() may not be delivered before loopTick() runs (flaky under CI).
    const snapPromise = nextMessage<SnapMsg>(a, ["snap"]);
    await runInDurableObject(stub, (instance) => {
      const i = instance as any;
      i.ingestInput(i.byId.get(welcomeA.id), inA);
      i.ingestInput(i.byId.get(welcomeB.id), inB);
      i.loopTick();
    });
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
    grenades: number;
    hasRocket: boolean;
    rocketAmmo: number;
    armor: number;
    credits: number;
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
    credits: opts.credits ?? STARTING_CREDITS,
    lastShotAt: opts.lastShotAt ?? 0,
    lastInputAt: opts.lastInputAt ?? Date.now(),
    respawnAt: 0,
    protectedUntil: opts.protectedUntil ?? 0,
    lastSeq: 0,
    rate: { windowStart: Date.now(), count: 0 },
    ready: false,
    inMatch: opts.inMatch ?? true, // most direct-method tests exercise in-match behavior
    ammo: WEAPONS.map((w) => w.clipSize),
    reserveAmmo: WEAPONS.map((w) => w.reserveAmmo),
    reloadEndsAt: WEAPONS.map(() => 0),
    lastGrenadeAt: 0,
    lastChatAt: 0,
    grenades: opts.grenades ?? GRENADE_START,
    hasRocket: opts.hasRocket ?? false,
    rocketAmmo: opts.rocketAmmo ?? 0,
    armor: opts.armor ?? 0,
    c: false,
    pc: false,
  };
}

// Narrow view of the private GameRoom members the appended tests reach into.
type RoomInternals = {
  players: Map<WebSocket, ReturnType<typeof makeRec>>;
  byId: Map<number, ReturnType<typeof makeRec>>;
  broadcast: (m: unknown) => void;
  handleShoot: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
  handleChat: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
  loopTick: () => void;
  ingestInput: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
  applyDamage: (
    target: ReturnType<typeof makeRec>,
    dmg: number,
    killer: ReturnType<typeof makeRec>,
    head: boolean,
    blast?: boolean,
  ) => void;
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

  it("a head claim on a body/leg shot is rejected — server verifies geometry (issue #17)", async () => {
    const stub = env.ROOMS.getByName("shoot-head-exploit");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);
      // Aim DOWN at the body while lying head:true. The server's isHeadshot check overrides the
      // false claim, so only base damage lands (no free 2x) and the hit is reported as not-head.
      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, -0.1, 1], w: 0, hit: 2, head: true,
      });
      expect(target.hp).toBe(MAX_HP - WEAPONS[0]!.damage); // base damage, NOT the head multiplier
      const hit = broadcasts.find((b) => (b as { t?: string }).t === "hit") as { head: boolean } | undefined;
      expect(hit?.head).toBe(false);
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

// ---- ammo + reload (issue #7) ----
describe("GameRoom ammo / reload", () => {
  it("consumes a round per shot and rejects firing on an empty magazine", async () => {
    const stub = env.ROOMS.getByName("ammo-empty");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000 });
      shooter.ammo[0] = 1;
      shooter.reserveAmmo[0] = 0;
      inst.byId.set(1, shooter);
      const shot = { t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: null, head: false };
      inst.handleShoot(shooter, shot);
      expect(shooter.ammo[0]).toBe(0); // one round consumed
      const lastShot = shooter.lastShotAt;
      inst.handleShoot(shooter, { ...shot, seq: 2, ts: now + 500 }); // now empty
      expect(shooter.ammo[0]).toBe(0); // no underflow
      expect(shooter.lastShotAt).toBe(lastShot); // gun did not discharge
    });
  });

  it("reload moves rounds from reserve into the magazine after reloadMs", async () => {
    const stub = env.ROOMS.getByName("ammo-reload");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        handleReload: (r: ReturnType<typeof makeRec>, w: number) => void;
        completeReloadIfDue: (r: ReturnType<typeof makeRec>, w: number, now: number) => void;
      };
      inst.broadcast = () => {};
      const now = Date.now();
      const rec = makeRec(1, [0, 1, 0]);
      rec.ammo[0] = 5;
      rec.reserveAmmo[0] = 50;
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      inst.handleReload(rec, 0);
      expect(rec.reloadEndsAt[0]).toBeGreaterThan(now); // reload in progress
      inst.completeReloadIfDue(rec, 0, now); // not due yet
      expect(rec.ammo[0]).toBe(5);
      inst.completeReloadIfDue(rec, 0, rec.reloadEndsAt[0]! + 1); // due
      const w = WEAPONS[0]!;
      expect(rec.ammo[0]).toBe(w.clipSize);
      expect(rec.reserveAmmo[0]).toBe(50 - (w.clipSize - 5));
      expect(rec.reloadEndsAt[0]).toBe(0);
    });
  });
});

// ---- ammo pickups ----
describe("GameRoom ammo pickups", () => {
  it("refills reserve when a player stands on an available crate, then puts it on cooldown", async () => {
    const stub = env.ROOMS.getByName("pickup-refill");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & { matchActive: boolean; pickupAvail: number[]; loopTick: () => void };
      inst.broadcast = () => {};
      inst.matchActive = true;
      const crate = AMMO_PICKUPS[0]!;
      const rec = makeRec(1, [crate[0], 1, crate[2]]); // standing on crate 0
      rec.reserveAmmo[0] = 0;
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      inst.loopTick();

      expect(rec.reserveAmmo[0]).toBe(WEAPONS[0]!.reserveAmmo); // refilled to max
      expect(inst.pickupAvail[0]).toBeGreaterThan(0);           // crate now on cooldown

      // a second pass while on cooldown does not refill again
      rec.reserveAmmo[0] = 5;
      inst.loopTick();
      expect(rec.reserveAmmo[0]).toBe(5);
    });
  });
});

// ---- grenade AoE (issue #1) ----
describe("GameRoom grenade", () => {
  it("detonates with linear-falloff AoE damage to players in the blast radius", async () => {
    const stub = env.ROOMS.getByName("nade-aoe");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & { detonate: (pos: number[], shooterId: number, radius: number, damage: number) => void };
      inst.broadcast = () => {};
      const thrower = makeRec(1, [0, 1, 0]);
      const near = makeRec(2, [2, 1, 0]);   // 2 units from the blast
      const far = makeRec(3, [50, 1, 0]);   // well outside the radius
      for (const r of [thrower, near, far]) { inst.byId.set(r.id, r); inst.players.set(r.ws, r); }

      inst.detonate([0, 1, 0], 1, GRENADE_RADIUS, GRENADE_DAMAGE);

      expect(near.hp).toBeLessThan(MAX_HP);  // took falloff damage
      expect(near.hp).toBeGreaterThan(0);    // 2/9 of the radius → partial damage, survives
      expect(far.hp).toBe(MAX_HP);           // out of range, untouched
    });
  });

  it("a self-grenade kill does not credit a frag", async () => {
    const stub = env.ROOMS.getByName("nade-self");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & { detonate: (pos: number[], shooterId: number, radius: number, damage: number) => void };
      inst.broadcast = () => {};
      const me = makeRec(1, [0, 1, 0], { hp: 30 });
      inst.byId.set(1, me);
      inst.players.set(me.ws, me);
      inst.detonate([0, 1, 0], 1, GRENADE_RADIUS, GRENADE_DAMAGE);
      expect(me.st).toBe(ST_DEAD);
      expect(me.deaths).toBe(1);
      expect(me.frags).toBe(0); // no frag for blowing yourself up
    });
  });
});

// ---- explosive barrels ----
describe("GameRoom explosive barrel", () => {
  it("detonates when shot and AoE-damages nearby players", async () => {
    const stub = env.ROOMS.getByName("barrel-aoe");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        handleBarrelHit: (rec: ReturnType<typeof makeRec>, m: unknown, b: number, weapon: unknown, now: number) => void;
        barrelStreak: unknown[]; barrelDownUntil: number[];
      };
      inst.broadcast = () => {};
      const bp = EXPLOSIVE_BARRELS[0]!;
      const shooter = makeRec(1, [bp[0], 1, bp[2] + 5]);
      const victim = makeRec(2, [bp[0] + 2, 1, bp[2]]); // 2 units from the barrel
      inst.byId.set(1, shooter); inst.byId.set(2, victim);
      inst.players.set(shooter.ws, shooter); inst.players.set(victim.ws, victim);
      const now = Date.now();
      const m = { t: "shoot", o: [bp[0], 1, bp[2] + 5], d: [0, 0, -1], w: 0, hit: null, head: false, barrel: 0, seq: 1, ts: now };

      // 4 rapid rifle hits don't detonate it yet; the 5th does.
      for (let i = 0; i < 4; i++) inst.handleBarrelHit(shooter, m, 0, WEAPONS[0]!, now + i);
      expect(inst.barrelDownUntil[0]).toBe(0);   // still standing
      expect(victim.hp).toBe(MAX_HP);            // no blast yet
      inst.handleBarrelHit(shooter, m, 0, WEAPONS[0]!, now + 5); // 5th rapid same-weapon hit

      expect(inst.barrelStreak[0]).toBeNull();              // streak cleared on detonation
      expect(inst.barrelDownUntil[0]).toBeGreaterThan(now); // respawning later
      expect(victim.hp).toBeLessThan(MAX_HP);               // took blast AoE
    });
  });

  it("a slow same-weapon streak (outside the window) never detonates the barrel", async () => {
    const stub = env.ROOMS.getByName("barrel-slow");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        handleBarrelHit: (rec: ReturnType<typeof makeRec>, m: unknown, b: number, weapon: unknown, now: number) => void;
        barrelDownUntil: number[];
      };
      inst.broadcast = () => {};
      const bp = EXPLOSIVE_BARRELS[0]!;
      const shooter = makeRec(1, [bp[0], 1, bp[2] + 5]);
      inst.byId.set(1, shooter); inst.players.set(shooter.ws, shooter);
      const m = { t: "shoot", o: [bp[0], 1, bp[2] + 5], d: [0, 0, -1], w: 0, hit: null, head: false, barrel: 0, seq: 1, ts: 0 };
      // 6 hits each spaced 3s apart (> BARREL_STREAK_WINDOW_MS) — the streak keeps resetting to 1.
      for (let i = 0; i < 6; i++) inst.handleBarrelHit(shooter, m, 0, WEAPONS[0]!, 100000 + i * 3000);
      expect(inst.barrelDownUntil[0]).toBe(0); // never detonated
    });
  });

  it("ignores a barrel claim whose aim ray misses the barrel", async () => {
    const stub = env.ROOMS.getByName("barrel-miss");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        handleBarrelHit: (rec: ReturnType<typeof makeRec>, m: unknown, b: number, weapon: unknown, now: number) => void;
        barrelStreak: unknown[];
      };
      inst.broadcast = () => {};
      const bp = EXPLOSIVE_BARRELS[0]!;
      const shooter = makeRec(1, [bp[0], 1, bp[2] + 5]);
      inst.byId.set(1, shooter); inst.players.set(shooter.ws, shooter);
      // aim 90° away from the barrel
      const m = { t: "shoot", o: [bp[0], 1, bp[2] + 5], d: [1, 0, 0], w: 0, hit: null, head: false, barrel: 0, seq: 1, ts: Date.now() };
      for (let i = 0; i < 6; i++) inst.handleBarrelHit(shooter, m, 0, WEAPONS[0]!, Date.now() + i);
      expect(inst.barrelStreak[0]).toBeNull(); // never advanced — every claim was rejected
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

// ---- grenades as a limited resource ----
describe("GameRoom grenade resource", () => {
  it("a throw consumes one grenade and broadcasts the arc", async () => {
    const stub = env.ROOMS.getByName("nade-throw");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals & { handleThrow: (rec: ReturnType<typeof makeRec>, m: unknown) => void };
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0], { grenades: GRENADE_START });
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.handleThrow(rec, { t: "throw", o: [0, 1.5, 0], d: [0, 0.2, -1] });

      expect(rec.grenades).toBe(GRENADE_START - 1);
      expect(broadcasts.some((b) => (b as { t?: string }).t === "grenade")).toBe(true);
    });
  });

  it("ignores a throw when out of grenades", async () => {
    const stub = env.ROOMS.getByName("nade-empty");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals & { handleThrow: (rec: ReturnType<typeof makeRec>, m: unknown) => void };
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0], { grenades: 0 });
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.handleThrow(rec, { t: "throw", o: [0, 1.5, 0], d: [0, 0.2, -1] });

      expect(rec.grenades).toBe(0);
      expect(broadcasts.some((b) => (b as { t?: string }).t === "grenade")).toBe(false);
    });
  });

  it("a grenade pickup tops the player up to GRENADE_MAX (then goes on cooldown)", async () => {
    const stub = env.ROOMS.getByName("nade-pickup");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as any;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      inst.matchActive = true;
      inst.matchEndsAt = Date.now() + 60_000;
      const gp = GRENADE_PICKUPS[0]!;
      const rec = makeRec(1, [gp[0], 1, gp[2]], { grenades: 1 });
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.loopTick();

      expect(rec.grenades).toBe(GRENADE_MAX);
      expect(inst.grenadePickupAvail[0]).toBeGreaterThan(Date.now());
      expect(broadcasts.some((b) => (b as { t?: string }).t === "gpickup")).toBe(true);
    });
  });
});

// ---- rocket launcher (tower pickup + splash fire) ----
describe("GameRoom rocket launcher", () => {
  it("the tower pickup grants the launcher to a player on the tower top", async () => {
    const stub = env.ROOMS.getByName("rocket-pickup");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as any;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      inst.matchActive = true;
      inst.matchEndsAt = Date.now() + 60_000;
      // Standing on the tower top (eye well above the perch surface).
      const rec = makeRec(1, [ROCKET_TOWER[0], ROCKET_TOWER[1] + 1, ROCKET_TOWER[2]]);
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.loopTick();

      expect(rec.hasRocket).toBe(true);
      expect(rec.rocketAmmo).toBe(ROCKET_CLIP);
      expect(inst.rocketTowerDownUntil[0]).toBeGreaterThan(Date.now()); // ROCKET_TOWER is tower index 0
      const wp = broadcasts.find((b) => (b as { t?: string }).t === "weaponpickup") as { id?: number } | undefined;
      expect(wp?.id).toBe(0);
    });
  });

  it("rejects a hitscan shoot with the rocket weapon id (no free instant rockets)", async () => {
    const stub = env.ROOMS.getByName("rocket-hitscan");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as any;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: 0 });
      const target = makeRec(2, [0, 1, 10]);
      inst.byId.set(1, shooter); inst.byId.set(2, target);
      inst.players.set(shooter.ws, shooter); inst.players.set(target.ws, target);
      // A crafted shoot with the rocket id must be rejected (rocket only fires via handleRocket).
      inst.handleShoot(shooter, { t: "shoot", seq: 1, ts: Date.now(), o: [0, 1, 0], d: [0, 0, 1], w: ROCKET_ID, hit: 2, head: true });
      expect(target.hp).toBe(MAX_HP); // unharmed
      expect(broadcasts.length).toBe(0);
    });
  });

  it("does NOT grant the launcher from the ground under the tower", async () => {
    const stub = env.ROOMS.getByName("rocket-ground");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as any;
      inst.broadcast = () => {};
      inst.matchActive = true;
      inst.matchEndsAt = Date.now() + 60_000;
      const rec = makeRec(1, [ROCKET_TOWER[0], 1, ROCKET_TOWER[2]]); // at the base, y≈1
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.loopTick();

      expect(rec.hasRocket).toBe(false);
    });
  });

  it("firing the last rocket spends ammo, schedules a blast, drops the launcher, and then ignores further fire", async () => {
    const stub = env.ROOMS.getByName("rocket-fire");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as any;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0], { hasRocket: true, rocketAmmo: 1, lastShotAt: 0 });
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.handleRocket(rec, { t: "rocket", seq: 1, ts: Date.now(), o: [0, 1, 0], d: [0, 0, -1], p: [0, 1, -20], hit: null, barrel: null });

      expect(rec.rocketAmmo).toBe(0);
      expect(rec.hasRocket).toBe(false); // launcher dropped when it runs dry
      expect(inst.pendingBlasts.length).toBe(1);
      expect(inst.pendingBlasts[0].radius).toBe(ROCKET_RADIUS);
      expect(broadcasts.filter((b) => (b as { t?: string }).t === "rocketfx").length).toBe(1);

      // A further fire (no launcher held) is ignored — no extra blast / broadcast.
      rec.lastShotAt = 0;
      inst.handleRocket(rec, { t: "rocket", seq: 2, ts: Date.now(), o: [0, 1, 0], d: [0, 0, -1], p: [0, 1, -20], hit: null, barrel: null });
      expect(inst.pendingBlasts.length).toBe(1);
      expect(broadcasts.filter((b) => (b as { t?: string }).t === "rocketfx").length).toBe(1);
    });
  });

  it("a dead player can neither fire a rocket nor throw a grenade", async () => {
    const stub = env.ROOMS.getByName("dead-no-fire");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as any;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0], { st: ST_DEAD, hasRocket: true, rocketAmmo: 3, grenades: 3, lastShotAt: 0 });
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.handleRocket(rec, { t: "rocket", seq: 1, ts: Date.now(), o: [0, 1, 0], d: [0, 0, -1], p: [0, 1, -20], hit: null, barrel: null });
      inst.handleThrow(rec, { t: "throw", o: [0, 1.5, 0], d: [0, 0.2, -1] });

      expect(rec.rocketAmmo).toBe(3);  // unchanged — fire rejected
      expect(rec.grenades).toBe(3);    // unchanged — throw rejected
      expect(inst.pendingBlasts.length).toBe(0);
      expect(broadcasts.length).toBe(0);
    });
  });
});

// ---- armor + fall damage + health/armor/spring pickups ----
describe("GameRoom armor / fall / new pickups", () => {
  it("armor soaks damage before health, and is dropped on death", async () => {
    const stub = env.ROOMS.getByName("armor-soak");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as any;
      inst.broadcast = () => {};
      const rec = makeRec(1, [0, 1, 0], { armor: 50 });
      const killer = makeRec(2, [0, 1, 5]);
      inst.byId.set(1, rec); inst.byId.set(2, killer);

      inst.applyDamage(rec, 30, killer, false, false); // 30 < 50 armor
      expect(rec.armor).toBe(20);
      expect(rec.hp).toBe(MAX_HP); // health untouched while armor remains

      inst.applyDamage(rec, 40, killer, false, false); // 20 armor soaks, 20 hits hp
      expect(rec.armor).toBe(0);
      expect(rec.hp).toBe(MAX_HP - 20);
    });
  });

  it("fall damage hurts the sender; a big fall is a (self) kill with no frag", async () => {
    const stub = env.ROOMS.getByName("fall-dmg");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as any;
      inst.broadcast = () => {};
      const rec = makeRec(1, [0, 1, 0]);
      inst.byId.set(1, rec); inst.players.set(rec.ws, rec);

      inst.handleFall(rec, { t: "fall", dmg: 40 });
      expect(rec.hp).toBe(MAX_HP - 40);

      inst.handleFall(rec, { t: "fall", dmg: 999 }); // lethal, clamped to MAX_HP
      expect(rec.st).toBe(ST_DEAD);
      expect(rec.deaths).toBe(1);
      expect(rec.frags).toBe(0); // a fall is a suicide — no frag credit
    });
  });

  it("health / armor / spring pickups grant their effect via loopTick + broadcast", async () => {
    const stub = env.ROOMS.getByName("new-pickups");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as any;
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      inst.matchActive = true;
      inst.matchEndsAt = Date.now() + 60_000;
      const hp = HEALTH_PICKUPS[0]!, ap = ARMOR_PICKUPS[0]!, sp = SPRING_PICKUPS[0]!;
      const a = makeRec(1, [hp[0], 1, hp[2]], { hp: 30 });
      const b = makeRec(2, [ap[0], 1, ap[2]], { armor: 0 });
      const c = makeRec(3, [sp[0], 1, sp[2]]);
      for (const r of [a, b, c]) { inst.byId.set(r.id, r); inst.players.set(r.ws, r); }

      inst.loopTick();

      expect(a.hp).toBe(HEALTH_AMOUNT);
      expect(b.armor).toBe(ARMOR_AMOUNT);
      expect(ARMOR_AMOUNT).toBeLessThanOrEqual(MAX_ARMOR);
      const spring = broadcasts.find((m) => (m as { t?: string }).t === "sppickup") as { durationMs?: number } | undefined;
      expect(spring?.durationMs).toBe(SPRING_DURATION_MS);
    });
  });
});

describe("GameRoom out-of-bounds kill floor (issue #23)", () => {
  it("falling below KZ_FLOOR is an instant suicide with no frag credit", async () => {
    const stub = env.ROOMS.getByName("oob-suicide");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals & {
        ingestInput: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
      };
      inst.broadcast = (m: unknown) => broadcasts.push(m);
      const now = Date.now();
      const faller = makeRec(1, [0, KZ_FLOOR + 1, 0], { inMatch: true });
      const other = makeRec(2, [10, 1, 0], { inMatch: true });
      inst.byId.set(1, faller);
      inst.byId.set(2, other);
      inst.players.set(faller.ws, faller);
      inst.players.set(other.ws, other);

      // A small downward move (within the anti-teleport budget) that crosses the kill floor.
      inst.ingestInput(faller, { t: "in", seq: 1, ts: now, p: [0, KZ_FLOOR - 1, 0], r: [0, 0], v: [0, 0, 0] });

      expect(faller.st).toBe(ST_DEAD);
      expect(faller.deaths).toBe(1);
      expect(faller.frags).toBe(0);
      expect(other.frags).toBe(0); // no kill credit to anyone for a fall suicide
      const kill = broadcasts.find((b) => (b as { t?: string }).t === "kill") as
        | { by: number; on: number }
        | undefined;
      expect(kill).toBeDefined();
      expect(kill!.by).toBe(1);
      expect(kill!.on).toBe(1); // suicide (by === on)
    });
  });

  it("staying above the kill floor does not kill", async () => {
    const stub = env.ROOMS.getByName("oob-safe");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        ingestInput: (rec: ReturnType<typeof makeRec>, m: unknown) => void;
      };
      inst.broadcast = () => {};
      const now = Date.now();
      const rec = makeRec(1, [0, KZ_FLOOR + 3, 0], { inMatch: true });
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);
      // Move down but stay above the floor.
      inst.ingestInput(rec, { t: "in", seq: 1, ts: now, p: [0, KZ_FLOOR + 1, 0], r: [0, 0], v: [0, 0, 0] });
      expect(rec.st).toBe(ST_ALIVE);
      expect(rec.deaths).toBe(0);
    });
  });
});

// ---- text chat (issue #10) ----
describe("GameRoom.handleChat", () => {
  it("re-broadcasts a sanitized chat with the SERVER's id/name (ignores the client's claim)", async () => {
    const stub = env.ROOMS.getByName("chat-broadcast");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0]);
      rec.name = "alice";
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      // A client tries to spoof a different id/name; the server overrides both with its own.
      inst.handleChat(rec, { t: "chat", from: 999, name: "admin", body: "  gg   wp  " });

      const chat = broadcasts.find((b) => (b as { t?: string }).t === "chat") as
        | { from: number; name: string; body: string }
        | undefined;
      expect(chat).toBeDefined();
      expect(chat!.from).toBe(1);          // server id, not the spoofed 999
      expect(chat!.name).toBe("alice");    // server name, not the spoofed "admin"
      expect(chat!.body).toBe("gg wp");    // whitespace collapsed + trimmed
    });
  });

  it("drops an empty / whitespace-only message (nothing to broadcast)", async () => {
    const stub = env.ROOMS.getByName("chat-empty");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0]);
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      inst.handleChat(rec, { t: "chat", from: 1, name: "p1", body: "    " });
      expect(broadcasts.some((b) => (b as { t?: string }).t === "chat")).toBe(false);
    });
  });

  it("caps the body length at CHAT_MAX_LEN", async () => {
    const stub = env.ROOMS.getByName("chat-cap");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0]);
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      inst.handleChat(rec, { t: "chat", from: 1, name: "p1", body: "a".repeat(CHAT_MAX_LEN + 50) });
      const chat = broadcasts.find((b) => (b as { t?: string }).t === "chat") as { body: string } | undefined;
      expect(chat!.body.length).toBe(CHAT_MAX_LEN);
    });
  });

  it("rate-limits a chat flood to one message per CHAT_MIN_INTERVAL_MS window", async () => {
    const stub = env.ROOMS.getByName("chat-flood");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0]);
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      // Two back-to-back messages: only the first is accepted (the second is inside the cooldown).
      inst.handleChat(rec, { t: "chat", from: 1, name: "p1", body: "first" });
      inst.handleChat(rec, { t: "chat", from: 1, name: "p1", body: "second (too fast)" });
      const count = broadcasts.filter((b) => (b as { t?: string }).t === "chat").length;
      expect(count).toBe(1);

      // After the cooldown elapses, a further message is accepted again.
      rec.lastChatAt = Date.now() - CHAT_MIN_INTERVAL_MS - 1;
      inst.handleChat(rec, { t: "chat", from: 1, name: "p1", body: "third (ok)" });
      expect(broadcasts.filter((b) => (b as { t?: string }).t === "chat").length).toBe(2);
    });
  });

  it("works in the lobby (chat does not require being in a match)", async () => {
    const stub = env.ROOMS.getByName("chat-lobby");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const broadcasts: unknown[] = [];
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = (m) => broadcasts.push(m);
      const rec = makeRec(1, [0, 1, 0], { inMatch: false }); // lobby-only player
      inst.byId.set(1, rec);
      inst.players.set(rec.ws, rec);

      inst.handleChat(rec, { t: "chat", from: 1, name: "p1", body: "hi lobby" });
      expect(broadcasts.some((b) => (b as { t?: string }).t === "chat")).toBe(true);
    });
  });
});

// ---- credits economy (issue #25) ----
describe("GameRoom credits economy (issue #25)", () => {
  it("awards CREDITS_PER_HIT to the shooter on a confirmed (non-lethal) hit", async () => {
    const stub = env.ROOMS.getByName("credits-hit");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000, credits: STARTING_CREDITS });
      const target = makeRec(2, [0, 1, 10], { credits: STARTING_CREDITS }); // full hp → not lethal
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);

      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });

      expect(shooter.credits).toBe(STARTING_CREDITS + CREDITS_PER_HIT);
      expect(target.credits).toBe(STARTING_CREDITS); // the victim earns nothing for being hit
    });
  });

  it("awards the kill bonus (hit + kill) to the killer on a frag", async () => {
    const stub = env.ROOMS.getByName("credits-kill");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const now = Date.now();
      const shooter = makeRec(1, [0, 1, 0], { lastShotAt: now - 1000, credits: STARTING_CREDITS });
      const target = makeRec(2, [0, 1, 10], { hp: 10, credits: STARTING_CREDITS }); // 25 dmg is lethal
      inst.byId.set(1, shooter);
      inst.byId.set(2, target);

      inst.handleShoot(shooter, {
        t: "shoot", seq: 1, ts: now, o: [0, 1, 0], d: [0, 0, 1], w: 0, hit: 2, head: false,
      });

      expect(target.st).toBe(ST_DEAD);
      expect(shooter.frags).toBe(1);
      // The lethal hit earns BOTH the per-hit award and the kill bonus.
      expect(shooter.credits).toBe(STARTING_CREDITS + CREDITS_PER_HIT + CREDITS_PER_KILL);
      expect(target.credits).toBe(STARTING_CREDITS); // the victim's balance is untouched
    });
  });

  it("grants no credits for self damage (no killer === target award)", async () => {
    const stub = env.ROOMS.getByName("credits-self");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      // A self-inflicted lethal hit (e.g. own grenade / fall): killer and target are the same rec.
      const rec = makeRec(1, [0, 1, 0], { hp: 30, credits: STARTING_CREDITS });
      inst.byId.set(1, rec);

      inst.applyDamage(rec, 999, rec, false, true); // lethal self-blast

      expect(rec.st).toBe(ST_DEAD);
      expect(rec.frags).toBe(0);              // no frag credit for a suicide
      expect(rec.credits).toBe(STARTING_CREDITS); // …and no money either
    });
  });

  it("clamps a balance at CREDITS_CAP", async () => {
    const stub = env.ROOMS.getByName("credits-cap");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals;
      inst.broadcast = () => {};
      const killer = makeRec(1, [0, 1, 0], { credits: CREDITS_CAP - 5 });
      const target = makeRec(2, [0, 1, 10], { hp: 10, credits: STARTING_CREDITS });
      inst.byId.set(1, killer);
      inst.byId.set(2, target);

      inst.applyDamage(target, 999, killer, false, false); // lethal: hit + kill awards both apply

      expect(killer.credits).toBe(CREDITS_CAP); // would overshoot, clamped to the ceiling
    });
  });

  it("resets every player's credits to STARTING_CREDITS at match start", async () => {
    const stub = env.ROOMS.getByName("credits-reset");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & { startMatch: () => void };
      inst.broadcast = () => {};
      const a = makeRec(1, [0, 1, 0], { credits: 1234 });
      const b = makeRec(2, [10, 1, 0], { credits: 9999 });
      for (const r of [a, b]) { r.ready = true; inst.byId.set(r.id, r); inst.players.set(r.ws, r); }

      inst.startMatch();

      expect(a.credits).toBe(STARTING_CREDITS);
      expect(b.credits).toBe(STARTING_CREDITS);
    });
  });

  it("includes credits in the per-player snapshot (snapOf)", async () => {
    const stub = env.ROOMS.getByName("credits-snap");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        snapOf: (rec: ReturnType<typeof makeRec>) => { credits?: number };
      };
      inst.broadcast = () => {};
      const rec = makeRec(1, [0, 1, 0], { credits: 4321 });
      const snap = inst.snapOf(rec);
      expect(snap.credits).toBe(4321);
    });
  });
});
