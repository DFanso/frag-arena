# FPS Architecture Contract (locked decisions for the implementation plan)

This file fixes the exact interfaces, file responsibilities, config, and constants so
every task in the implementation plan stays consistent. The plan references this file.
Source of truth for *requirements*: `../specs/2026-06-03-cloudflare-multiplayer-fps-design.md`.

## Dependencies (package.json)

Runtime: `hono`, `three`.
Dev: `typescript`, `vite`, `@cloudflare/vite-plugin`, `wrangler` (>= 4.20 for the
`run_worker_first` array form), `vitest`, `@cloudflare/vitest-pool-workers`,
`@cloudflare/workers-types`, `@types/three`.

Scripts:
```
"dev": "vite dev",
"build": "vite build",
"deploy": "vite build && wrangler deploy",
"test": "vitest run",
"test:watch": "vitest",
"cf-typegen": "wrangler types"
```

## Config files

**wrangler.jsonc**
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-fps",
  "main": "worker/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/ws/*"]
  },
  "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "GameRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }],
  "observability": { "enabled": true }
}
```
> With `@cloudflare/vite-plugin`, do NOT set `assets.directory` — the plugin populates it
> from the client build output.

**vite.config.ts**
```ts
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
});
```

**vitest.config.ts**
```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

**tsconfig.json** (key options)
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "worker", "test", "*.ts"]
}
```

## File structure & responsibilities

```
index.html                  # Vite entry; mounts <canvas> + HUD overlay; loads src/main.ts
src/
  main.ts                   # bootstrap: nickname screen, read ?room, connect, run game loop
  net.ts                    # Net class: WS connect + reconnect/backoff, send(), onMessage dispatch
  controls.ts               # FpsControls: PointerLock + WASD/jump/gravity (uses physics for collision)
  physics.ts                # buildOctree(map), resolveCollision(collider, octree); pure-ish helpers
  player.ts                 # LocalPlayer (prediction) + RemotePlayer (snapshot buffer + interpolation)
  combat.ts                 # fireRay(camera, targets) hitscan; returns claimed hit; local feedback hook
  map.ts                    # buildArena(): THREE.Group of ground/walls/ramps/boxes (client-only geometry)
  hud.ts                    # Hud: crosshair, health bar, prompt, scoreboard (Tab), kill feed, hit marker
  audio.ts                  # Sfx: WebAudio shoot/hit/death (lazy-init on first user gesture)
  interp.ts                 # pure interpolation/vector math helpers (unit-tested)
worker/
  index.ts                  # Hono app: /api/health, /ws/:room forward; Env types; exports GameRoom
  room.ts                   # GameRoom Durable Object (authoritative)
  validate.ts               # validateShoot(...) + movement clamp; pure functions (unit-tested)
  protocol.ts               # SHARED types + constants (imported by BOTH worker and src)
test/
  protocol.test.ts
  validate.test.ts
  interp.test.ts
  room.test.ts              # vitest-pool-workers DO tests
  worker.test.ts            # vitest-pool-workers Hono routing tests
```

## protocol.ts — COMPLETE shared source (import from both `worker/*` and `src/*`)

```ts
// worker/protocol.ts — shared wire protocol + tunables. No runtime deps.

export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;      // 50
export const CLIENT_SEND_HZ = 15;
export const CLIENT_SEND_MS = 1000 / CLIENT_SEND_HZ;      // ~66.67
export const INTERP_DELAY_MS = 120;
export const MAX_PLAYERS_PER_ROOM = 10;
export const IDLE_TIMEOUT_MS = 30_000;
export const MAX_MESSAGE_BYTES = 1024;                    // app-level cap (platform max is 32 MiB)
export const RATE_LIMIT_MSGS_PER_SEC = 40;                // per connection
export const RESPAWN_MS = 3000;
export const SPAWN_PROTECTION_MS = 2500;
export const LAGCOMP_MAX_REWIND_MS = 500;
export const POSITION_BUFFER_MS = 1000;                   // keep ~1s of positions for rewind
export const MAX_HP = 100;
export const EYE_HEIGHT = 1.0;                            // capsule top y at spawn
export const AIM_CONE_DOT = Math.cos((4 * Math.PI) / 180); // ~4 degrees
export const MAX_MOVE_SPEED = 12;                         // units/sec
export const MOVE_SPEED_TOLERANCE = 1.6;                  // allow bursts (jump pads etc.)

export type Vec3 = [number, number, number];
export type Rot = [number, number];                       // [yaw, pitch] in radians

export interface Weapon {
  id: number; name: string; damage: number; headMult: number; maxRange: number; cooldownMs: number;
}
export const WEAPONS: readonly Weapon[] = [
  { id: 0, name: "rifle", damage: 25, headMult: 2, maxRange: 200, cooldownMs: 120 },
];

export const ST_DEAD = 0;
export const ST_ALIVE = 1;
export const ST_PROTECTED = 3;                            // alive + spawn protection
export type PlayerStateCode = typeof ST_DEAD | typeof ST_ALIVE | typeof ST_PROTECTED;

// Server-assigned spawn points (ground positions; capsule end y = EYE_HEIGHT).
export const SPAWN_POINTS: readonly Vec3[] = [
  [-24, EYE_HEIGHT, -24], [24, EYE_HEIGHT, -24], [24, EYE_HEIGHT, 24],
  [-24, EYE_HEIGHT, 24], [0, EYE_HEIGHT, -24], [0, EYE_HEIGHT, 24],
];

// ---- Client -> Server ----
export interface InMsg  { t: "in";    seq: number; ts: number; p: Vec3; r: Rot; v: Vec3; }
export interface ShootMsg { t: "shoot"; seq: number; ts: number; o: Vec3; d: Vec3; w: number; hit: number | null; head: boolean; }
export type ClientMsg = InMsg | ShootMsg;

// ---- Server -> Client ----
export interface PlayerSnap {
  id: number; name: string; p: Vec3; r: Rot; v: Vec3; hp: number; st: PlayerStateCode; frags: number; deaths: number;
}
export interface SnapMsg    { t: "snap";    tick: number; ts: number; ack: Record<number, number>; players: PlayerSnap[]; }
export interface WelcomeMsg { t: "welcome"; id: number; tickRate: number; players: PlayerSnap[]; }
export interface HitMsg     { t: "hit";     by: number; on: number; dmg: number; hp: number; head: boolean; }
export interface KillMsg    { t: "kill";    by: number; on: number; w: number; }
export interface SpawnMsg   { t: "spawn";   id: number; p: Vec3; prot: number; }
export interface LeaveMsg   { t: "leave";   id: number; }
export type ServerMsg = SnapMsg | WelcomeMsg | HitMsg | KillMsg | SpawnMsg | LeaveMsg;

export function encode(msg: ServerMsg | ClientMsg): string { return JSON.stringify(msg); }
export function decode<T>(raw: string): T | null { try { return JSON.parse(raw) as T; } catch { return null; } }

export function sanitizeRoom(code: string | undefined): string {
  if (!code) return "public";
  const c = code.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return c.length ? c : "public";
}
export function sanitizeName(name: string | undefined): string {
  const n = (name ?? "").trim().replace(/[^\x20-\x7e]/g, "").slice(0, 16);
  return n.length ? n : "anon";
}
```

## GameRoom DO — internal shape (so DO tasks agree)

```ts
interface PlayerRec {
  id: number;
  name: string;
  ws: WebSocket;
  p: Vec3; r: Rot; v: Vec3;
  hp: number;
  st: PlayerStateCode;
  frags: number; deaths: number;
  lastShotAt: number;        // ms epoch
  lastInputAt: number;       // ms epoch (idle detection)
  respawnAt: number;         // ms epoch when DEAD -> respawn
  protectedUntil: number;    // ms epoch
  lastSeq: number;           // last processed input seq (echoed in snap.ack)
  posBuf: { t: number; p: Vec3 }[]; // ring buffer for lag-comp rewind
  rate: { windowStart: number; count: number }; // per-connection rate limit
}
```
GameRoom fields: `players: Map<WebSocket, PlayerRec>`, `byId: Map<number, PlayerRec>`,
`nextId: number`, `tick: number`, `tickHandle: ReturnType<typeof setInterval> | undefined`.

Key methods (names fixed): `fetch(req)`, `webSocketMessage(ws, raw)`,
`webSocketClose(ws, ...)`, `webSocketError(ws, ...)`, `private addPlayer(ws)`,
`private removePlayer(ws)`, `private startLoop()`, `private stopLoopIfEmpty()`,
`private loopTick()`, `private broadcast(msg)`, `private send(ws, msg)`,
`private ingestInput(rec, m)`, `private handleShoot(rec, m)`, `private spawn(rec)`,
`private posAt(rec, ts)`.

Lifecycle rules:
- Accept via `this.ctx.acceptWebSocket(server)` (Hibernation API) + `setWebSocketAutoResponse('ping','pong')`.
- Tick via `setInterval(() => this.loopTick(), SERVER_TICK_MS)` — **never alarms**.
- `startLoop()` only if `tickHandle === undefined` and players exist.
- `stopLoopIfEmpty()`: when `players.size === 0`, `clearInterval(tickHandle)`, set undefined.
- Reject new connections when `players.size >= MAX_PLAYERS_PER_ROOM` (close code 1013).
- `loopTick()`: advance respawns/protection, drop idle players (now - lastInputAt > IDLE_TIMEOUT_MS),
  build one SnapMsg, send to all `this.ctx.getWebSockets()`.

## validate.ts — pure function signatures (so DO + tests agree)

```ts
import type { Vec3, Weapon } from "./protocol";

export type ShootReject =
  | "dead" | "firerate" | "notarget" | "target" | "range" | "aim";

export interface ShooterView { p: Vec3; st: number; lastShotAt: number; }
export interface TargetView  { p: Vec3; st: number; }

// Returns null if the shot is valid (caller applies damage), else a reject reason.
export function validateShoot(
  shooter: ShooterView, target: TargetView | null,
  dir: Vec3, weapon: Weapon, now: number,
): ShootReject | null;

// Clamp a claimed new position to a plausible distance from the last known one.
// Returns the accepted position (snapped if the move was implausible).
export function clampMove(prev: Vec3, next: Vec3, dtMs: number): Vec3;

// vector helpers (also reused via interp.ts on the client)
export function sub(a: Vec3, b: Vec3): Vec3;
export function dot(a: Vec3, b: Vec3): number;
export function len(a: Vec3): number;
export function norm(a: Vec3): Vec3;
```

## interp.ts — pure client math (so client tasks + tests agree)

```ts
import type { Vec3, Rot } from "../worker/protocol";

export function lerp(a: number, b: number, t: number): number;
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3;
export function lerpAngle(a: number, b: number, t: number): number; // shortest-path yaw
export function clamp(x: number, lo: number, hi: number): number;

export interface Snapshot { t: number; p: Vec3; r: Rot; }
// Pick interpolated {p,r} for renderTime from a time-sorted buffer; returns null if empty.
export function sampleBuffer(buf: Snapshot[], renderTime: number): { p: Vec3; r: Rot } | null;
```

## Client networking behavior (so net.ts + main.ts agree)

- `Net` connects to `wss?://<host>/ws/<room>` (ws:// on localhost). Exposes
  `on(type, handler)`, `send(msg: ClientMsg)`, `close()`. Buffers nothing while
  disconnected; reconnects with backoff 0.5s→8s; emits `"open"`/`"close"` events.
- Client sends `InMsg` at `CLIENT_SEND_MS` cadence (NOT per frame), with monotonic `seq`.
- `RemotePlayer` renders `INTERP_DELAY_MS` behind using `sampleBuffer`. `LocalPlayer`
  is predicted (never interpolated); on `snap.ack[myId]` it may reconcile if the server
  position differs beyond a threshold (snap to server pos for v1 simplicity).
- Send `ShootMsg` on left-click while pointer-locked; show local hit marker immediately;
  apply real damage only from server `hit`/`kill`.

## Arena (map.ts, client geometry) — fixed so collision matches visuals

- Ground: 60×60 plane centered at origin (y=0).
- Perimeter walls: 4 boxes, height 6, enclosing the 60×60 area.
- Cover: 4 boxes ~ size [4,3,4] at (±10, 1.5, ±10).
- Ramps: 2 inclined boxes giving access to a low platform (rotate a thin box ~20°).
- All map meshes merged into one `THREE.Group`; `physics.buildOctree(group)` builds the
  `Octree` from it. Collider = `Capsule(start=[0,0.35,0], end=[0,EYE_HEIGHT,0], r=0.35)`.
- Camera rides `collider.end`. No server-side LOS in v1 (geometry is client-only).

## Task breakdown (phases → tasks). Each task = TDD, complete code, commit.

- **Phase 0 — Scaffold:** T1 project init (package.json, configs, index.html, src/main.ts
  stub, worker/index.ts with /api/health + GameRoom stub export, .gitignore). Verify
  `npm run dev` serves page + `/api/health`. `npm test` runs (even if 0 tests).
- **Phase 1 — Protocol:** T2 `worker/protocol.ts` + `test/protocol.test.ts`
  (encode/decode round-trip, sanitizeRoom, sanitizeName).
- **Phase 2 — DO:** T3 GameRoom WS accept + addPlayer/welcome/join/leave + player cap;
  T4 ingestInput + clampMove + posBuf + posAt; T5 setInterval tick + snapshot broadcast +
  stop-on-empty + idle drop; T6 validate.ts + handleShoot (damage, hit/kill events);
  T7 death/respawn/spawn-protection/score; T8 rate-limit + message-size cap.
- **Phase 3 — Worker:** T9 Hono /ws/:room forward (raw request, getByName, 426/Upgrade),
  Env typing, worker.test.ts.
- **Phase 4 — Client:** T10 interp.ts + tests; T11 net.ts (+ small testable parts);
  T12 map.ts + physics.ts; T13 controls.ts; T14 player.ts (LocalPlayer/RemotePlayer);
  T15 combat.ts; T16 hud.ts + audio.ts; T17 main.ts wire-up (nickname, room, loop).
- **Phase 5 — Docs:** T18 README (run/test instructions) + manual multi-tab test checklist.

Client rendering tasks (T11–T17) use unit tests for pure helpers (interp, math) and
explicit MANUAL verification steps (open localhost:5173 in N tabs) where DOM/WebGL can't
be unit-tested under vitest-pool-workers.

---

# v2 Revision Decisions (authoritative — supersede anything above that conflicts)

These resolve the adversarial-review findings. All tasks MUST conform to these.

## D1. Toolchain & test API (verified against Cloudflare docs, June 2026)

- `package.json` devDependencies pin a COHERENT modern stack:
  `"vitest": "^4.1.0"`, `"@cloudflare/vitest-pool-workers": "^0.13.0"` (or newer compatible),
  `"@cloudflare/vite-plugin": "^1.0.0"`, `"wrangler": "^4.20.0"`, `"typescript": "^5.6.0"`,
  `"vite": "^6.0.0"`, `"@cloudflare/workers-types": "^4.20250101.0"`, `"@types/three": "^0.184.0"`.
  Runtime deps: `"hono": "^4.6.0"`, `"three": "^0.184.0"`.
- `vitest.config.ts` uses the `cloudflareTest()` plugin (already in this contract). Correct.
- **Test imports (modern API):**
  - DO tests (`test/room.test.ts`, `test/validate.test.ts` needs none of these): 
    `import { env } from "cloudflare:workers";` and `import { runInDurableObject } from "cloudflare:test";`
  - Worker routing test (`test/worker.test.ts`): `import { env, exports } from "cloudflare:workers";`
    and call the Worker via `exports.default.fetch(new Request(...), env, ctx?)` — **NOT** `SELF`
    (removed). `exports` does NOT serve static assets, which is fine (we only test `/api/*` and `/ws/*`).
- `package.json` test script: `"test": "vitest run --passWithNoTests"`.

## D2. T1 green gate (no `npm test` in T1)

T1 is scaffolding; its verification is: (a) `npm install` succeeds; (b) `npx wrangler types`
generates `worker-configuration.d.ts` (commit it or gitignore it — gitignore it); (c)
`npx tsc --noEmit` is clean; (d) `npm run build` (vite build) succeeds; (e) MANUAL: `npm run dev`,
`http://localhost:5173/` serves the shell + console logs `boot`, `curl http://localhost:5173/api/health`
returns `{"ok":true}`. Do NOT assert a vitest "no tests" banner. Add `worker-configuration.d.ts`
to `.gitignore`. If `cloudflare:workers` types fail to resolve under tsc, ensure `@cloudflare/workers-types`
is in tsconfig `types`; the generated `worker-configuration.d.ts` also augments these.

## D3. Durable Object class & Env

- `Env` interface is declared ONCE in `worker/index.ts` and imported as a TYPE elsewhere:
  `import type { Env } from "./index";` (type-only import avoids the runtime circular dep).
- `GameRoom extends DurableObject<Env>` in `worker/room.ts` (consistent with the T1 stub).
- **T3 moves the GameRoom export to `worker/room.ts` and rewrites `worker/index.ts` to
  `export { GameRoom } from "./room";` (deleting the T1 inline stub).** This makes the
  `ROOMS` binding resolve to the REAL class for all DO tests from T3 onward. T9 then only
  finalizes the Hono routes; it does NOT introduce a second `GameRoom`. Keep exactly ONE
  exported `GameRoom` (the migration `new_sqlite_classes:["GameRoom"]` binds to it). In
  `index.ts` use `import type { GameRoom } from "./room";` for the `DurableObjectNamespace<GameRoom>`
  generic, plus the value `export { GameRoom } from "./room";`.

## D4. PlayerRec (v2 — REMOVES posBuf; no lag-comp rewind in v1)

Lag-compensated rewind is **post-v1** (spec marked it optional). Combat validates against
CURRENT server-authoritative positions. Updated PlayerRec:

```ts
interface PlayerRec {
  id: number; name: string; ws: WebSocket;
  p: Vec3; r: Rot; v: Vec3;
  hp: number; st: PlayerStateCode;
  frags: number; deaths: number;
  lastShotAt: number; lastInputAt: number;
  respawnAt: number; protectedUntil: number;
  lastSeq: number;
  rate: { windowStart: number; count: number };
}
```
Remove `posBuf` and the `posAt` method everywhere. `validate.ts` signatures are unchanged
(they already take plain `p` values, no buffer).

## D5. Nickname via query param (no JoinMsg)

`ClientMsg` stays `InMsg | ShootMsg`. The name travels in the WS URL query:
- Client (`net-helpers.buildWsUrl`): `…/ws/<room>?name=<encodeURIComponent(name)>`.
- `GameRoom.fetch(req)` parses `const name = sanitizeName(new URL(req.url).searchParams.get("name") ?? undefined);`
  and calls `this.addPlayer(server, name)`. Method sig: `private addPlayer(ws: WebSocket, name: string)`.
- This makes `PlayerSnap.name` real, so nameplates/scoreboard/kill-feed show nicknames.

## D6. Single spawn helper

`private pickSpawn(id: number): Vec3 { return SPAWN_POINTS[(id - 1) % SPAWN_POINTS.length]!; }`
Used by BOTH `addPlayer` (initial) and `spawn` (respawn). (`!` because `noUncheckedIndexedAccess`.)

## D7. ingestInput uses SERVER wall-clock dt

```ts
private ingestInput(rec: PlayerRec, m: InMsg) {
  const now = Date.now();
  const dtMs = rec.lastInputAt ? Math.min(Math.max(now - rec.lastInputAt, 1), 250) : 50;
  rec.p = clampMove(rec.p, m.p, dtMs);   // anti-teleport uses TRUSTED dt, not client m.ts
  rec.r = m.r; rec.v = m.v;
  rec.lastInputAt = now; rec.lastSeq = m.seq;
}
```
`clampMove(prev, next, dtMs)` fallback for non-positive dt: `const dt = (dtMs > 0 ? dtMs : 50) / 1000;`
Test must include an inflated/garbage `m.ts` case proving the clamp uses server dt (a teleport
is still snapped).

## D8. handleShoot logic (current-position validation; drop protection on fire)

```ts
private handleShoot(rec: PlayerRec, m: ShootMsg) {
  const now = Date.now();
  const weapon = WEAPONS[m.w] ?? WEAPONS[0]!;
  const target = m.hit != null ? (this.byId.get(m.hit) ?? null) : null;
  const reject = validateShoot(
    { p: rec.p, st: rec.st, lastShotAt: rec.lastShotAt },
    target ? { p: target.p, st: target.st } : null,
    m.d, weapon, now,
  );
  if (reject === "dead" || reject === "firerate") return; // gun did not discharge
  rec.lastShotAt = now;                                    // gun fired
  if (rec.st === ST_PROTECTED) rec.st = ST_ALIVE;          // firing drops spawn protection
  if (reject) return;                                      // fired but no valid hit
  const dmg = m.head ? weapon.damage * weapon.headMult : weapon.damage;
  this.applyDamage(target!, dmg, rec, m.head);
}
```

## D9. applyDamage / death / respawn (T7)

```ts
private applyDamage(target: PlayerRec, dmg: number, killer: PlayerRec, head: boolean) {
  if (target.st === ST_DEAD || target.st === ST_PROTECTED) return;
  target.hp -= dmg;
  this.broadcast({ t: "hit", by: killer.id, on: target.id, dmg, hp: Math.max(0, target.hp), head });
  if (target.hp <= 0) {
    target.hp = 0; target.st = ST_DEAD; target.deaths++; target.respawnAt = Date.now() + RESPAWN_MS;
    killer.frags++;
    this.broadcast({ t: "kill", by: killer.id, on: target.id, w: 0 });
  }
}
private spawn(rec: PlayerRec) {
  const now = Date.now();
  rec.hp = MAX_HP; rec.st = ST_PROTECTED; rec.p = this.pickSpawn(rec.id);
  rec.protectedUntil = now + SPAWN_PROTECTION_MS;
  this.broadcast({ t: "spawn", id: rec.id, p: rec.p, prot: SPAWN_PROTECTION_MS });
}
```
`loopTick` (each tick, `const now = Date.now()`): for each rec — if `st===ST_DEAD && now>=respawnAt` →
`this.spawn(rec)`; else if `st===ST_PROTECTED && now>protectedUntil` → `rec.st=ST_ALIVE`. Then drop
idle players (see D10), then build+broadcast the SnapMsg.

## D10. Idle drop routes through removePlayer (broadcasts leave)

In `loopTick`, an idle player (`now - rec.lastInputAt > IDLE_TIMEOUT_MS`) is removed via
`this.removePlayer(rec.ws)` (which closes the socket, deletes from `players`+`byId`,
broadcasts `LeaveMsg`, and calls `stopLoopIfEmpty()`). Add a T5 test asserting a leave is
broadcast on idle drop. (Iterate a snapshot of players to avoid mutating during iteration.)

## D11. webSocketMessage stays synchronous

`webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void` (NOT async). Order: size cap
(`typeof raw === "string"` and byte length > `MAX_MESSAGE_BYTES` → `ws.close(1009)`), then
per-connection rate limit (drop silently), then `decode`, then route `in`→ingestInput,
`shoot`→handleShoot. Use `new TextEncoder().encode(raw).length` for byte length (so the cap is bytes).

## D12. DO test transport rule (no fake sockets + getWebSockets mixing)

Production broadcast iterates `this.ctx.getWebSockets()`. Tests therefore must use REAL sockets:
- Add reusable helpers at the top of `test/room.test.ts` (created in T3, reused by T4–T8):
  `connect(stub, name?)` → does `stub.fetch(new Request("https://x/ws/test?name="+(name??"p"), { headers: { Upgrade: "websocket" } }))`, takes `res.webSocket`, calls `ws.accept()`, returns `ws`;
  and `nextMessage(ws)` → a Promise resolving to the next parsed JSON message.
- For message-CONTENT assertions (welcome/snap/hit/kill/leave): connect real sockets and read.
- For internal-STATE assertions (players.size, st, hp, tickHandle): use
  `runInDurableObject(stub, (instance) => { ... })` and access members via `(instance as any)` for
  private fields/methods (TS `private` is compile-time only; cast to call `loopTick()` directly
  instead of waiting on real timers).
- Get the stub once: `const id = env.ROOMS.idFromName("test"); const stub = env.ROOMS.get(id);`
  (or `env.ROOMS.getByName("test")`).
- Cap test (1013): connect `MAX_PLAYERS_PER_ROOM` sockets, then assert via `runInDurableObject`
  that `players.size === MAX_PLAYERS_PER_ROOM` after one more connect attempt (deterministic;
  do not race the close event).
- Drive ticks deterministically: `await runInDurableObject(stub, (i) => (i as any).loopTick());`.

## D13. Test files: merge imports, never re-import (T4–T8)

`test/room.test.ts` is created in T3 with ALL its imports at the top. T4–T8 ADD `it()`/`describe()`
blocks and, when they need a new constant, EDIT the existing top import line to add the name —
they must NOT add a second `import { ... } from "..."` for an already-imported module (duplicate
identifier = SyntaxError). Each such task shows the full merged import line.

## D14. Message size boundary tests (T8)

Include BOTH: a string whose UTF-8 byteLength is exactly `MAX_MESSAGE_BYTES` (asserted processed)
and one at `MAX_MESSAGE_BYTES + 1` (asserted `ws.close(1009)`), to pin the `>` boundary.

## D15. Client module APIs (SOURCE OF TRUTH — T11–T17 must match exactly)

`src/net-helpers.ts` (DOM-free, unit-tested in `test/net.test.ts`):
```ts
import type { Vec3 } from "../worker/protocol";
export function buildWsUrl(loc: { protocol: string; host: string }, room: string, name: string): string;
// -> `${loc.protocol==="https:"?"wss:":"ws:"}//${loc.host}/ws/${room}?name=${encodeURIComponent(name)}`
export function backoff(attempt: number): number; // min(8000, 500 * 2**attempt)
```

`src/net.ts`:
```ts
import type { ClientMsg } from "../worker/protocol";
export class Net {
  constructor(room: string, name: string, loc?: { protocol: string; host: string });
  on(type: string, handler: (payload: any) => void): void; // type: a ServerMsg "t" OR "open"/"close"
  send(msg: ClientMsg): void;
  close(): void;
}
// Internally: connect with buildWsUrl, reconnect with backoff(attempt) 500..8000ms,
// on message JSON.parse and dispatch handlers registered for payload.t; emit "open"/"close".
```

`src/controls.ts`:
```ts
import type { Vec3, Rot } from "../worker/protocol";
export class FpsControls {
  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, octree: Octree);
  get isLocked(): boolean;
  lock(): void;
  onLockChange(cb: (locked: boolean) => void): void;  // fired on PointerLock 'lock'/'unlock'
  setPosition(p: Vec3): void;
  getPosition(): Vec3;
  getRotation(): Rot;        // [yaw, pitch] radians
  getVelocity(): Vec3;
  update(dtSec: number): void; // input + gravity + physics.resolveCollision(collider, octree, velocity)
}
```

`src/player.ts`:
```ts
import type { Vec3, Rot, InMsg } from "../worker/protocol";
export const RECONCILE_DIST = 2.0;
export class LocalPlayer {
  constructor(id: number);
  id: number;
  nextSeq(): number;                       // returns then increments an internal counter (start 1)
  buildInput(p: Vec3, r: Rot, v: Vec3, tsMs: number): InMsg; // {t:"in",seq:this.nextSeq(),ts:tsMs,p,r,v}
  reconcile(predicted: Vec3, server: Vec3): Vec3 | null;     // len(sub)>RECONCILE_DIST ? server : null
}
export class RemotePlayer {
  constructor(id: number, name: string);
  readonly id: number;
  readonly group: THREE.Group;   // add/remove to scene
  readonly body: THREE.Mesh;     // userData.playerId=id; the raycast target
  addSnapshot(s: { t: number; p: Vec3; r: Rot }): void;
  update(nowMs: number): void;   // sampleBuffer at nowMs - INTERP_DELAY_MS
  dispose(): void;
}
```

`src/combat.ts`:
```ts
import type { Vec3, ShootMsg } from "../worker/protocol";
export interface FireResult { hit: number | null; head: boolean; o: Vec3; d: Vec3; }
export function fireRay(camera: THREE.Camera, targets: THREE.Object3D[]): FireResult;
export interface ShootDeps {
  camera: THREE.Camera; dom: HTMLElement;
  getTargets: () => THREE.Object3D[];
  isLocked: () => boolean;
  nextSeq: () => number;
  send: (m: ShootMsg) => void;
  onLocalShoot: (hit: boolean) => void; // SFX + hit marker
  weaponId?: number;                    // default 0
}
export function wireShooting(deps: ShootDeps): () => void; // returns unsubscribe; left-click while locked
```

`src/main.ts` MUST use exactly those APIs:
- `import { MAX_HP, INTERP_DELAY_MS, CLIENT_SEND_MS, sanitizeRoom } from "../worker/protocol";` (no local MAX_HP).
- `controls.isLocked` / `controls.onLockChange(...)` / `controls.getPosition()/getRotation()/getVelocity()/setPosition(...)`.
- `local = new LocalPlayer(myId)` after `welcome`; reconcile with POSITIONS only:
  `const snapped = local.reconcile(controls.getPosition(), ps.p); if (snapped) controls.setPosition(snapped);`
- Remotes: `const rp = new RemotePlayer(ps.id, ps.name); scene.add(rp.group);` …
  `rp.addSnapshot({ t: m.ts, p: ps.p, r: ps.r });` … on leave `scene.remove(rp.group); rp.dispose();`
- Shooting: call `wireShooting({ camera, dom: renderer.domElement, getTargets: () => [...remotes.values()].map(rp => rp.body), isLocked: () => controls.isLocked, nextSeq: () => local.nextSeq(), send: (m) => net.send(m), onLocalShoot: (hit) => { sfx.shoot(); if (hit) hud.flashHitMarker(); } });`
- Send cadence: `let sendAccum = 0;` hoisted in `main()`; in `frame()` exactly one line:
  `sendAccum = sendInputIfDue(sendAccum, dt * 1000);` (no scratch/dead lines). `sendInputIfDue`
  accumulates ms and, when `>= CLIENT_SEND_MS` and locked, builds+sends an InMsg via
  `local.buildInput(controls.getPosition(), controls.getRotation(), controls.getVelocity(), Date.now())`
  and returns the leftover accumulator.

## D16. Misc

- T2 protocol test: state the EXACT count (11) or just assert "all pass" without a fabricated number.
- T9 expected-pass file list at end of T9: `protocol.test.ts`, `validate.test.ts`, `room.test.ts`,
  `worker.test.ts` (NOT `interp.test.ts`, which is created in T10).
- T13 prose must say `resolveCollision(collider, octree, velocity)` (3 args, velocity required).
- Every server-side task (at least T3 and T9) includes an `npx tsc --noEmit` step before commit.
- No `Co-Authored-By` trailer in any commit message.
