# Design: Free 3D Multiplayer FPS on Cloudflare

**Date:** 2026-06-03
**Status:** Approved (pending written-spec review)
**Owner:** DFanso

## 1. Overview

A browser-based 3D first-person shooter deathmatch (Krunker-style, blocky/low-poly),
deployed **entirely on Cloudflare's free tier**. Players join a shared public arena
(or a private room via a code), run/jump/look around a small arena, and shoot each
other with a hitscan weapon. Health, damage, deaths, respawns, and score are decided
by an authoritative server. v1 is a "lean + polish" deathmatch: genuinely fun and
finished-feeling, but scoped to one weapon, one map, and a small player count.

The whole system is one Cloudflare Workers project: a **Hono** Worker serves the
**Three.js** client as static assets and forwards WebSocket connections to a
**Durable Object** that acts as the authoritative game-room server.

## 2. Goals

- Deploy 100% free on Cloudflare (Workers Free plan, SQLite-backed Durable Objects).
- Real-time multiplayer 3D FPS that feels responsive (client prediction + interpolation).
- One public arena + private rooms by code (`/?room=abc`).
- "Lean + polish": nameplates, scoreboard, hit markers, sound effects, a map with
  ramps and box cover, and a kill feed.
- Server-authoritative combat with lightweight anti-cheat checks.
- Clean module boundaries so v1 can grow toward the bigger roadmap later.

## 3. Non-goals (v1 — YAGNI)

- No accounts/auth/persistence (pick a nickname per session; no database of users).
- No multiple weapons, maps, skins, or advanced movement tech (post-v1 roadmap).
- No full server-side physics simulation (movement is client-authoritative).
- No matchmaking/ranking/lobbies beyond "public arena + room code".
- No mobile/touch controls (desktop pointer-lock first).
- No production-grade anti-cheat (casual deterrents only).

## 4. Free-tier feasibility & cost model (the honest numbers)

All figures verified against current Cloudflare docs (June 2026). Durable Objects on
the **Workers Free plan** are SQLite-backed only, with these daily limits (reset 00:00 UTC):

| Metric | Free limit | What costs it here |
|---|---|---|
| DO **requests** | 100,000 / day | WS handshakes (1 each) + **inbound** WS messages billed **20:1** (20 msgs = 1 request) + **alarm invocations (1 each)** |
| DO **duration** | 13,000 GB-s / day | Wall-clock time the DO is active (128 MB = 0.128 GB-s per active second) |
| SQL rows | 5M read / 100k write / day | We barely use storage (in-memory game state) |
| Storage | 5 GB | n/a for v1 |
| Static assets | free & unlimited requests; 20,000 files; 25 MiB/file | Three.js client bundle |
| Workers requests | 100,000 / day | Page/API hits (static-asset hits are free and excluded) |

**Key consequences that shape the design:**

1. **Tick loop must be `setInterval`, NOT alarms.** Alarm invocations count as
   requests. A 20 Hz alarm tick = 72,000 requests/hour → blows the 100k/day cap in
   ~1.4 hours. A `setInterval` tick is *not* a separate request — it runs inside the
   DO's active duration, so it only costs GB-s. **Decision: drive the 20 Hz tick with
   `setInterval`.** (Do not "optimize" this into an alarm — it would break the free tier.)

2. **Outbound broadcasts are free** (no request cost). Broadcasting 20 Hz snapshots
   to all clients in a room costs **0 requests** — only duration + bandwidth. So we can
   broadcast generously; the request budget is driven almost entirely by *inbound*
   client messages.

3. **Request budget ≈ player-hours.** At a 20 Hz client send rate, one player =
   20 msg/s × 3600 = 72,000 msgs/hr = **3,600 requests/hr**. Budget 100k/day →
   **~27 player-hours/day**. Dropping the client send rate to **15 Hz → ~37 player-hours/day**.
   (E.g. four players for ~7-9 hours/day.) Plenty for a hobby/demo; production would need
   the paid plan. **Decision: client send rate = 15 Hz** (server still broadcasts at 20 Hz,
   which is free).

4. **Duration budget ≈ one always-on room.** A continuously active room ≈ 0.128 ×
   86,400 ≈ **11,059 GB-s/day (~85% of 13,000)**. So we **must stop the tick loop and
   close sockets when a room empties** (then the DO evicts and stops billing), and add an
   **idle-disconnect timeout**. Several short-lived rooms summing under budget are fine;
   multiple *simultaneous* always-on rooms would exceed the duration cap.

These mitigations (setInterval tick, stop-on-empty, idle timeout, 15 Hz send, per-connection
rate limiting, app-level message-size cap) are first-class requirements, not afterthoughts.

## 5. Architecture

```
Browser (Three.js client)                 Cloudflare edge
┌────────────────────────┐
│ Three.js renderer       │  HTTPS GET /      ┌─────────────────────────────┐
│ PointerLock FPS controls│ ───────────────▶  │ Static Assets (free)        │
│ Prediction + interp     │  (index.html,js)  │  client bundle (Vite build) │
│ HUD / scoreboard / SFX  │ ◀───────────────  └─────────────────────────────┘
│ WebSocket client        │
└─────────┬──────────────┘   WSS /ws/:room    ┌─────────────────────────────┐
          │ ───────────────────────────────▶  │ Worker (Hono)               │
          │  input(15Hz) / shoot(events)      │  /api/*  routes             │
          │ ◀───────────────────────────────  │  /ws/:room → forward to DO  │
          │  snapshot(20Hz) / events          └─────────────┬───────────────┘
          │                                                  │ stub.fetch(raw)
          │                                    ┌─────────────▼───────────────┐
          │                                    │ Durable Object: GameRoom    │
          └───────────────  WebSocket  ──────▶ │  (one per room code)        │
                                               │  authoritative game state    │
                                               │  20Hz setInterval tick       │
                                               │  combat validation + score   │
                                               │  hibernatable WS, stop-empty │
                                               └─────────────────────────────┘
```

**Components & responsibilities:**

- **Client (`src/`)** — Three.js scene, FPS controls, local prediction, remote-player
  interpolation, hitscan raycast + instant hit feedback, HUD/scoreboard/kill-feed/SFX,
  WebSocket transport. Knows nothing about other rooms; it just connects to one.
- **Worker / Hono (`worker/index.ts`)** — serves the client (via `ASSETS`), exposes
  `/api/*`, and forwards `/ws/:room` upgrades to the right `GameRoom` DO. Stateless.
- **Durable Object `GameRoom` (`worker/room.ts`)** — the single source of truth for one
  room: connected players, positions (relayed), health, deaths/respawns, score; runs the
  tick loop; validates combat; broadcasts snapshots and events; manages its own lifecycle
  (start loop on first join, stop on empty).

Each unit has a narrow interface: the client speaks only the WS message protocol (§7);
the Worker only routes; the DO owns all authoritative rules.

## 6. Tech stack, tooling & project layout

- **Runtime:** Cloudflare Workers + Durable Objects (SQLite backend, free plan).
- **Server framework:** Hono.
- **Client:** Three.js `^0.184` (r184), TypeScript, no game engine.
- **Build/dev:** **`@cloudflare/vite-plugin`** (the current 2026 idiom) — one project
  builds the client *and* the Worker, with HMR against the real `workerd` runtime.
- **Local dev:** `npm run dev` → `vite dev` at `http://localhost:5173` (serves client +
  Worker + DO in-process). Open multiple tabs for manual multiplayer testing.
- **Tests:** `@cloudflare/vitest-pool-workers` via the `cloudflareTest()` plugin; import
  `env` from `cloudflare:workers`, DO helpers (`runInDurableObject`, etc.) from `cloudflare:test`.
- **Deploy:** `npm run deploy` → `vite build` then `wrangler deploy` to
  `*.workers.dev` (free subdomain). Migrations auto-apply.

**Directory layout:**

```
/
├─ index.html                 # client entry (Vite)
├─ src/                       # Three.js client (TypeScript)
│  ├─ main.ts                 # bootstrap: scene, loop, wire-up
│  ├─ net.ts                  # WebSocket client + protocol (en/decode)
│  ├─ controls.ts             # PointerLock + WASD/jump/gravity
│  ├─ physics.ts              # Octree/Capsule collision vs map
│  ├─ player.ts               # local prediction + RemotePlayer interpolation
│  ├─ combat.ts               # hitscan raycast + hit feedback
│  ├─ map.ts                  # blocky arena geometry (ground, ramps, cover)
│  ├─ hud.ts                  # crosshair, health, ammo, scoreboard, kill feed
│  └─ audio.ts                # WebAudio SFX (shoot/hit/death)
├─ worker/
│  ├─ index.ts                # Hono app + Env types; exports GameRoom
│  ├─ room.ts                 # GameRoom Durable Object (authoritative)
│  ├─ protocol.ts             # shared message types/constants (imported by client too)
│  └─ validate.ts             # combat sanity checks (fire-rate, range, aim-cone, …)
├─ test/                      # vitest-pool-workers tests
├─ wrangler.jsonc
├─ vite.config.ts
└─ tsconfig.json
```

`worker/protocol.ts` is shared by client and server so message shapes and constants
(tick rate, weapon stats, limits) never drift between the two sides.

**`wrangler.jsonc` (key parts):**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-fps",
  "main": "worker/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    // directory is auto-populated by @cloudflare/vite-plugin — do NOT set it.
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/ws/*"]   // array form needs Wrangler v4.20.0+
  },
  "durable_objects": {
    "bindings": [{ "name": "ROOMS", "class_name": "GameRoom" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }],  // NOT new_classes (Paid-only)
  "observability": { "enabled": true }
}
```

## 7. Netcode design (model "A": client-authoritative movement, server-authoritative combat)

**Rates:**
- Client → server **input**: 15 Hz (budget lever; movement state, latest-wins).
- Client → server **shoot**: event-driven (on click), not on a clock.
- Server tick + **snapshot** broadcast: 20 Hz (50 ms) via `setInterval` (outbound = free).
- Remote-player **interpolation delay**: ~120 ms (≈2-3 snapshots) so a dropped packet
  still has buffered data to interpolate between.

**Local player** is predicted (inputs applied immediately for zero-latency feel) and
**never interpolated**. **Remote players** are rendered with entity interpolation
(buffer of timestamped snapshots, rendered ~120 ms in the past). Inputs carry a monotonic
`seq`; the server echoes the last-processed `seq` so the client can correct/reconcile if
the server nudges an out-of-bounds position.

**Message protocol** (JSON for v1; can switch hot paths to binary later). Defined once in
`worker/protocol.ts`:

```jsonc
// client → server: input/state (15 Hz, latest-wins)
{ "t":"in", "seq":1287, "ts":1717430000123, "p":[x,y,z], "r":[yaw,pitch], "v":[x,y,z] }

// client → server: shoot (event; client did the raycast, reports the claim)
{ "t":"shoot", "seq":1290, "ts":..., "o":[x,y,z], "d":[x,y,z], "w":0, "hit":7, "head":false }

// server → clients: world snapshot (20 Hz broadcast)
{ "t":"snap", "tick":48213, "ts":..., "ack":{"7":1290},
  "players":[ {"id":7,"p":[..],"r":[..],"v":[..],"hp":74,"st":1,"name":"..","frags":3,"deaths":1}, ... ] }
  // st: 0=DEAD, 1=ALIVE, 3=ALIVE+SPAWN_PROTECTED

// server → clients: discrete events (sent immediately, not only on tick)
{ "t":"hit",   "by":7, "on":9, "dmg":26, "hp":74, "head":false }
{ "t":"kill",  "by":7, "on":9, "w":0 }
{ "t":"spawn", "id":9, "p":[..], "prot":2500 }
{ "t":"welcome", "id":7, "tickRate":20, "players":[...] }  // on join; map is static/hardcoded in the client
```

**Server-side combat validation** (cheap, no full physics sim) — reject a shot unless it
passes all of: shooter alive; fire-rate cooldown elapsed; target exists, alive, not
spawn-protected; distance ≤ weapon max range; reported aim direction within ~4° of the
shooter→target vector; (optional) coarse line-of-sight against static geometry; timestamp
clamped to a ≤500 ms rewind window compared against the target's recent buffered position.
On pass: apply server-authoritative damage (head multiplier if `head`), broadcast `hit`;
on death, broadcast `kill`, increment `frags`/`deaths`, start respawn timer.

**Movement bounds:** even though movement is client-authoritative, the server clamps
egregious teleports/speed (reject/snap positions implying speed > maxSpeed × tolerance)
and always uses *server-validated* positions for combat checks.

## 8. Durable Object `GameRoom` design

**State (in-memory, per active room):**
- `players: Map<WebSocket, PlayerState>` — id, name, pos/rot/vel, hp, state (ALIVE/DEAD/
  PROTECTED), frags, deaths, lastShotAt, lastInputAt, a small position ring-buffer (for
  lag-comp rewind), input `seq` tracking, rate-limit counters.
- `tickHandle` — the `setInterval` handle (undefined when no loop running).
- `nextId` — incrementing player id.

**Lifecycle:**
- **Connect:** Worker forwards the upgrade; DO `fetch()` creates a `WebSocketPair`, calls
  `ctx.acceptWebSocket(server)` (Hibernation API — *not* `server.accept()`), registers
  `setWebSocketAutoResponse('ping','pong')` (free keep-alive that doesn't wake the DO),
  assigns id + spawn point, sends `welcome`, and **starts the `setInterval` tick if not
  already running.** Enforce a hard cap (~8-12 players/room).
- **Message:** `webSocketMessage(ws, raw)` — app-level size cap (close if oversized);
  per-connection rate-limit (drop excess); parse; route `in` → store latest input,
  `shoot` → validate + apply.
- **Tick (20 Hz `setInterval`):** advance respawn timers / spawn protection, clamp
  movement, build one snapshot, `for (ws of ctx.getWebSockets()) ws.send(snap)`.
- **Disconnect / idle:** `webSocketClose` removes the player and broadcasts a leave; an
  idle player (no input for ~30 s) is dropped. **When the room is empty: `clearInterval`
  and ensure all sockets are closed** so the DO evicts and stops accruing duration.

**Why setInterval + Hibernation API together:** during active play the `setInterval`
pins the DO in memory (unavoidable for a real-time loop; billed as duration). Accepting
sockets via the Hibernation API means that once the room empties and we `clearInterval` +
close sockets, the DO has no pending events and can evict immediately — stopping duration
billing. (Alarms are rejected for the tick because alarm invocations bill as requests; see §4.)

## 9. Worker / Hono design

- `GET /api/health` → `{ ok: true }` (and any future small APIs).
- `GET /ws/:room` → if `Upgrade: websocket` header present, `stub = env.ROOMS.getByName(room)`
  then `return stub.fetch(c.req.raw)` (pass the **raw** request so the Upgrade header and
  the returned `webSocket` survive). Else `426`. Room code defaults to `"public"`;
  `/?room=abc` maps the client to room `abc`. Validate/sanitize room codes (length, charset).
- Everything else is served by the static `ASSETS` layer (SPA fallback). `/api/*` and
  `/ws/*` are listed in `run_worker_first` so they reach the Worker instead of the SPA fallback.
- `Env` types: `ASSETS: Fetcher`, `ROOMS: DurableObjectNamespace<GameRoom>` (generate via
  `wrangler types`).

## 10. Client design (Three.js)

- **Scene/map (`map.ts`)** — blocky arena: ground plane, perimeter walls, a few box covers
  and ramps. Geometry merged into a map mesh used both for rendering and for building the
  collision `Octree`.
- **Controls (`controls.ts`)** — `PointerLockControls` (`three/addons/controls/PointerLockControls.js`)
  for mouse-look (note: `getObject()` was removed in modern Three.js — use `camera`/
  `controls.object` directly). WASD + jump + gravity handled manually with a velocity vector
  and clamped `delta` time.
- **Physics (`physics.ts`)** — `Octree` + `Capsule` (`three/addons/math/`), the official
  `games_fps` pattern: `worldOctree.capsuleIntersect(playerCollider)` resolves the player
  against boxes and ramps with no physics engine. Camera rides the capsule top (eye height).
- **Local player (`player.ts`)** — predicted movement applied immediately; sends `in` at
  15 Hz; reconciles against server `ack` if corrected.
- **Remote players (`player.ts`)** — `RemotePlayer` buffers snapshots and renders ~120 ms
  in the past (lerp position, slerp rotation). Each remote mesh tags `userData.playerId`.
- **Combat (`combat.ts`)** — on click, `Raycaster.setFromCamera(new Vector2(0,0), camera)`
  (NDC center) against the array of remote-player meshes; instant local hit marker + SFX;
  send `shoot` with claimed target; trust the server's `hit`/`kill` for actual damage.
- **Polish:**
  - **Nameplates** — `Sprite` + `CanvasTexture` above each remote player (cheap, in-WebGL;
    excluded from raycast targets).
  - **Scoreboard** — HTML overlay, toggled with **Tab**, built from snapshot `frags`/`deaths`.
  - **Kill feed** — top-right "A fragged B" from `kill` events.
  - **Hit markers** — crosshair flash on confirmed hit; **SFX** (`audio.ts`, WebAudio) for
    shoot/hit/death.
  - **HUD** — crosshair, health bar, "click to play" prompt (HTML/CSS overlay). The
    single gun has infinite ammo; firing is gated by the server fire-rate cooldown (no
    reload mechanic in v1).

## 11. Data flow (join → play → leave)

1. Browser loads `/` (static asset, free). User enters a nickname; client reads
   `?room=` (default `public`).
2. Client opens `wss://…/ws/:room`. Worker validates the Upgrade and forwards to
   `GameRoom.getByName(room)`.
3. DO accepts (Hibernation API), assigns id + spawn, sends `welcome`, starts the 20 Hz
   `setInterval` if it wasn't running.
4. Client sends `in` at 15 Hz; on click sends `shoot`.
5. DO ticks at 20 Hz: updates timers, clamps movement, broadcasts `snap`; sends `hit`/
   `kill`/`spawn` events immediately as they happen.
6. Client predicts local player, interpolates remotes ~120 ms behind, renders HUD/feed
   from authoritative state.
7. On tab close/disconnect (or 30 s idle), DO removes the player and broadcasts leave;
   when the room is empty it `clearInterval`s and closes sockets so the DO evicts.

## 12. Error handling, abuse & cost protection

- **Client:** WebSocket reconnect with exponential backoff; clamp render `delta` after
  tab-switches; gracefully handle `welcome`/`snap` arriving out of order.
- **Server:** ignore malformed/oversized messages (app-level size cap; platform max is
  32 MiB but we cap far lower); **per-connection rate-limit** inbound messages (drop, don't
  process — protects the request budget and the room from a flooding client); reject shots
  from dead players; clamp lag-comp rewind window; cap players per room.
- **Cost guards (from §4):** `setInterval` tick (not alarms); stop loop + close sockets on
  empty; idle-disconnect; 15 Hz client send; `setWebSocketAutoResponse` for pings.

## 13. Testing strategy

- **DO logic (`@cloudflare/vitest-pool-workers`):** damage/death/respawn state machine;
  combat validation (fire-rate, range, aim-cone, dead/protected gating, rewind clamp);
  player join/leave + player cap; tick produces a well-formed snapshot; loop stops when the
  room empties. Use `runInDurableObject` with a stub from `env.ROOMS`.
- **Pure helpers (unit):** interpolation/lerp/slerp math, vector helpers, protocol
  encode/decode, rate-limiter.
- **Manual:** `npm run dev`, open several tabs at `localhost:5173`, verify movement,
  shooting, damage, respawns, scoreboard, kill feed, nameplates, SFX across tabs.

## 14. Deployment

1. Free Cloudflare account; `wrangler login` once; ensure a `*.workers.dev` subdomain.
2. `npm run deploy` (`vite build` → `wrangler deploy`); DO migration auto-applies.
3. Live at `https://cf-fps.<subdomain>.workers.dev`.

## 15. Risks & open questions

- **Request budget is the real ceiling** (~27-37 player-hours/day). Acceptable for a
  hobby/demo; documented clearly. Lever: client send rate / batching.
- **Client-authoritative movement is spoofable.** Accepted for casual play; server still
  bounds movement and owns all combat. Hardening toward full server-authority is a
  post-v1 option.
- **Single always-on room ≈ 85% of duration budget.** Mitigated by stop-on-empty + idle
  timeout; many simultaneous always-on rooms are out of scope for free.
- **Three.js bundle size vs 20,000-file asset cap** — bundle/compress; a single arena is
  tiny, so low risk.

## 16. Post-v1 roadmap (not in this spec)

Multiple weapons; more maps; player skins; advanced movement; spectator mode; richer
anti-cheat (server-side movement simulation / hit verification); binary wire protocol;
optional paid-plan scaling. Each is its own spec → plan → implementation cycle.
