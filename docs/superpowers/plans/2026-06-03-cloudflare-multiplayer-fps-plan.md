# Cloudflare 3D Multiplayer FPS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally verify a free-tier Cloudflare 3D first-person-shooter deathmatch (Three.js client + Hono Worker + authoritative GameRoom Durable Object), playable across multiple browser tabs.

**Architecture:** Single Cloudflare Workers project. A Hono Worker serves the Vite-built Three.js client as static assets and forwards `/ws/:room` WebSocket upgrades to a per-room `GameRoom` Durable Object. Netcode model A: client-authoritative movement (predicted locally, sent at 15 Hz), server-authoritative combat (hitscan, client-reported + server-validated). Server ticks/broadcasts at 20 Hz via `setInterval` (never alarms — alarm invocations bill as requests). Remote players are entity-interpolated ~120 ms behind.

**Tech Stack:** TypeScript, Three.js r184, Hono, Cloudflare Workers + Durable Objects (SQLite backend, free plan), @cloudflare/vite-plugin, Wrangler, Vitest 4 + @cloudflare/vitest-pool-workers (cloudflareTest plugin).

**Reference docs (read before starting):**
- Requirements spec: `docs/superpowers/specs/2026-06-03-cloudflare-multiplayer-fps-design.md`
- Architecture contract — EXACT types, signatures, configs, constants; its **v2 Revision Decisions** section is authoritative: `docs/superpowers/plans/2026-06-03-fps-architecture-contract.md`

**Task index:** T1–T2 scaffold + shared protocol · T3–T5 GameRoom DO core (WS, input, tick) · T6–T8 DO combat (validation, death/respawn/score, rate-limit) · T9 Hono Worker routing · T10–T12 client core (interp, net, map/physics) · T13–T15 client play (controls, players, combat) · T16–T18 HUD/audio, wire-up, docs.

---

### Task T1: Project scaffold (package.json, configs, index.html, worker stub)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\package.json`
- Create: `F:\Git\deploy-on-cloudflare\vite.config.ts`
- Create: `F:\Git\deploy-on-cloudflare\vitest.config.ts`
- Create: `F:\Git\deploy-on-cloudflare\tsconfig.json`
- Create: `F:\Git\deploy-on-cloudflare\wrangler.jsonc`
- Create: `F:\Git\deploy-on-cloudflare\.gitignore`
- Create: `F:\Git\deploy-on-cloudflare\index.html`
- Create: `F:\Git\deploy-on-cloudflare\src\main.ts`
- Create: `F:\Git\deploy-on-cloudflare\worker\index.ts`

> Note: T1 is pure scaffolding — there is no behavior to drive with a vitest unit test (the first real vitest file is added in T2). Per contract decision **D2**, the green gate for T1 is therefore NOT `npm test`. It is: (a) `npm install` succeeds, (b) `npx wrangler types` generates `worker-configuration.d.ts`, (c) `npx tsc --noEmit` is clean, (d) `npm run build` (vite build) succeeds, and (e) a MANUAL dev-server + `/api/health` check. We do NOT assert a vitest "no tests" banner here.

- [ ] **Step 1: Create the directory layout and `.gitignore` (the "red" state — nothing builds yet)**

  Run these commands from the repo root `F:\Git\deploy-on-cloudflare`:
  ```powershell
  New-Item -ItemType Directory -Force -Path "F:\Git\deploy-on-cloudflare\src"
  New-Item -ItemType Directory -Force -Path "F:\Git\deploy-on-cloudflare\worker"
  New-Item -ItemType Directory -Force -Path "F:\Git\deploy-on-cloudflare\test"
  ```

  Create `F:\Git\deploy-on-cloudflare\.gitignore` (per **D2**, the generated `worker-configuration.d.ts` is gitignored):
  ```gitignore
  node_modules
  dist
  .wrangler
  worker-configuration.d.ts
  ```

- [ ] **Step 2: Verify the scaffold does NOT yet work (verify it fails)**

  Run:
  ```powershell
  npm install
  ```
  Expected failure (no `package.json` exists yet):
  ```
  npm error code ENOENT
  npm error syscall open
  npm error path F:\Git\deploy-on-cloudflare\package.json
  npm error errno -4058
  npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open 'F:\Git\deploy-on-cloudflare\package.json'
  ```

- [ ] **Step 3: Implement — create all config files, `index.html`, the client stub, and the worker stub**

  Create `F:\Git\deploy-on-cloudflare\package.json` (versions pinned to the COHERENT modern stack per **D1**: vitest 4 + `@cloudflare/vitest-pool-workers` 0.13+, which is the first version exporting the `cloudflareTest()` plugin and requires vitest `^4.1.0`):
  ```json
  {
    "name": "cf-fps",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "vite dev",
      "build": "vite build",
      "deploy": "vite build && wrangler deploy",
      "test": "vitest run --passWithNoTests",
      "test:watch": "vitest",
      "cf-typegen": "wrangler types"
    },
    "dependencies": {
      "hono": "^4.6.0",
      "three": "^0.184.0"
    },
    "devDependencies": {
      "@cloudflare/vite-plugin": "^1.0.0",
      "@cloudflare/vitest-pool-workers": "^0.13.0",
      "@cloudflare/workers-types": "^4.20250101.0",
      "@types/three": "^0.184.0",
      "typescript": "^5.6.0",
      "vite": "^6.0.0",
      "vitest": "^4.1.0",
      "wrangler": "^4.20.0"
    }
  }
  ```

  Create `F:\Git\deploy-on-cloudflare\vite.config.ts`:
  ```ts
  import { defineConfig } from "vite";
  import { cloudflare } from "@cloudflare/vite-plugin";

  export default defineConfig({
    plugins: [cloudflare()],
  });
  ```

  Create `F:\Git\deploy-on-cloudflare\vitest.config.ts` (uses the `cloudflareTest()` plugin from `@cloudflare/vitest-pool-workers` 0.13+; this is the config the whole test suite from T2 onward depends on):
  ```ts
  import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  });
  ```

  Create `F:\Git\deploy-on-cloudflare\tsconfig.json`:
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

  Create `F:\Git\deploy-on-cloudflare\wrangler.jsonc`:
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

  Create `F:\Git\deploy-on-cloudflare\index.html`:
  ```html
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>CF FPS</title>
      <style>
        html, body { margin: 0; height: 100%; overflow: hidden; background: #87a; }
        #game { display: block; width: 100vw; height: 100vh; }
        #hud { position: fixed; inset: 0; pointer-events: none; }
      </style>
    </head>
    <body>
      <canvas id="game"></canvas>
      <div id="hud"></div>
      <script type="module" src="/src/main.ts"></script>
    </body>
  </html>
  ```

  Create `F:\Git\deploy-on-cloudflare\src\main.ts`:
  ```ts
  console.log("boot");
  ```

  Create `F:\Git\deploy-on-cloudflare\worker\index.ts`. Per **D3**: `Env` is declared ONCE here; the `GameRoom` stub `extends DurableObject<Env>`; the `ROOMS` binding is typed `DurableObjectNamespace<GameRoom>`. (The stub is removed in T3, which rewrites this file to `export { GameRoom } from "./room";` — there must remain exactly ONE exported `GameRoom` that the wrangler migration `new_sqlite_classes:["GameRoom"]` binds to.)
  ```ts
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
  ```

- [ ] **Step 4: Install deps and verify the toolchain resolves to a COMPATIBLE pair**

  Run:
  ```powershell
  npm install
  ```
  Expected: completes with `added <N> packages` and no error exit code.

  Verify the resolved test toolchain is the compatible modern pair (vitest 4 with vitest-pool-workers 0.13+):
  ```powershell
  npm ls vitest @cloudflare/vitest-pool-workers
  ```
  Expected (versions resolve inside the pinned ranges; vitest is 4.x, pool-workers is 0.13.x or newer):
  ```
  cf-fps@0.1.0 F:\Git\deploy-on-cloudflare
  ├── @cloudflare/vitest-pool-workers@0.13.x
  └── vitest@4.1.x
  ```

- [ ] **Step 5: Generate Worker types (`worker-configuration.d.ts`)**

  Run:
  ```powershell
  npx wrangler types
  ```
  Expected: prints the generated runtime/env types and writes the file. Confirm it exists:
  ```powershell
  Test-Path "F:\Git\deploy-on-cloudflare\worker-configuration.d.ts"
  ```
  Expected output:
  ```
  True
  ```
  (This file is gitignored per Step 1 / **D2**; it augments `@cloudflare/workers-types` so `cloudflare:workers` and the `Env`/binding types resolve under tsc.)

- [ ] **Step 6: Typecheck and build (the green gate — per D2)**

  Run the typecheck:
  ```powershell
  npx tsc --noEmit
  ```
  Expected: no output and exit code 0 (a clean typecheck).

  Then run the production build:
  ```powershell
  npm run build
  ```
  Expected: vite build completes; it prints the emitted client assets and the built worker, e.g.:
  ```
  vite v6.x.x building for production...
  ✓ ... modules transformed.
  dist/client/index.html              ...
  dist/client/assets/main-*.js        ...
  ✓ built in <N>ms
  ```
  Build exits with code 0.

- [ ] **Step 7: Manual verification (dev server + index shell + /api/health)**

  Start the dev server in one terminal:
  ```powershell
  npm run dev
  ```
  Expected: Vite prints a Local URL, e.g. `Local:   http://localhost:5173/`.

  1. Open `http://localhost:5173/` in a browser. Confirm the page loads (purple-ish background, no console errors) and DevTools Console shows `boot`.
  2. In a second terminal, verify the index shell is served:
     ```powershell
     curl.exe http://localhost:5173/
     ```
     Expected: the HTML shell is returned (contains `<canvas id="game">` and `<title>CF FPS</title>`).
  3. Verify the health endpoint returns JSON:
     ```powershell
     curl.exe http://localhost:5173/api/health
     ```
     Expected output:
     ```
     {"ok":true}
     ```
  Stop the dev server with `Ctrl+C`.

  > Note (per tdd-quality finding): `worker.test.ts` (T9) calls the Worker via `exports.default.fetch(...)`, which does NOT serve static assets. SPA/asset serving therefore has no automated test and is verified ONLY via `npm run dev` here in T1 and again manually in T17. The `/api/*` and `/ws/*` Worker routes ARE unit-tested in T9.

- [ ] **Step 8: Commit**

  ```powershell
  git add package.json vite.config.ts vitest.config.ts tsconfig.json wrangler.jsonc .gitignore index.html src/main.ts worker/index.ts
  git commit -m "T1: project scaffold (configs, index.html, worker /api/health + GameRoom stub)"
  ```

---

### Task T2: Shared wire protocol (`worker/protocol.ts`) + tests

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\worker\protocol.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\protocol.test.ts`

> Note (per **D5**): the player nickname does NOT travel in a `ClientMsg`. There is NO `JoinMsg`. `ClientMsg` stays `InMsg | ShootMsg`. The nickname reaches the server via the WS URL query param (`?name=…`), parsed by `GameRoom.fetch` in T3. `sanitizeName` (defined and tested here) is therefore used server-side in T3 — it is NOT dead code.

- [ ] **Step 1: Write the failing test**

  Create `F:\Git\deploy-on-cloudflare\test\protocol.test.ts` (pure module under test; uses only `vitest`, no `cloudflare:test`/`cloudflare:workers` imports — these are pure functions):
  ```ts
  import { describe, it, expect } from "vitest";
  import {
    encode,
    decode,
    sanitizeRoom,
    sanitizeName,
    SERVER_TICK_HZ,
    type InMsg,
    type ShootMsg,
    type SnapMsg,
  } from "../worker/protocol";

  describe("encode/decode round-trip", () => {
    it("round-trips an InMsg", () => {
      const msg: InMsg = {
        t: "in",
        seq: 1287,
        ts: 1717430000123,
        p: [1, 2, 3],
        r: [0.5, -0.25],
        v: [0, 0, -1],
      };
      const raw = encode(msg);
      expect(typeof raw).toBe("string");
      const back = decode<InMsg>(raw);
      expect(back).toEqual(msg);
    });

    it("round-trips a ShootMsg", () => {
      const msg: ShootMsg = {
        t: "shoot",
        seq: 42,
        ts: 1717430000150,
        o: [0, 1, 0],
        d: [0, 0, -1],
        w: 0,
        hit: 7,
        head: true,
      };
      const raw = encode(msg);
      const back = decode<ShootMsg>(raw);
      expect(back).toEqual(msg);
    });

    it("round-trips a SnapMsg", () => {
      const msg: SnapMsg = {
        t: "snap",
        tick: 48213,
        ts: 1717430000200,
        ack: { 7: 1290 },
        players: [
          {
            id: 7,
            name: "neo",
            p: [10, 1, -4],
            r: [0.1, 0.2],
            v: [0, 0, 0],
            hp: 74,
            st: 1,
            frags: 3,
            deaths: 1,
          },
        ],
      };
      const raw = encode(msg);
      const back = decode<SnapMsg>(raw);
      expect(back).toEqual(msg);
    });
  });

  describe("decode error handling", () => {
    it("returns null on invalid JSON", () => {
      expect(decode<InMsg>("not json {")).toBeNull();
    });
  });

  describe("sanitizeRoom", () => {
    it("defaults undefined/empty to 'public'", () => {
      expect(sanitizeRoom(undefined)).toBe("public");
      expect(sanitizeRoom("")).toBe("public");
    });
    it("lowercases and strips disallowed characters", () => {
      expect(sanitizeRoom("Hello World!")).toBe("helloworld");
      expect(sanitizeRoom("Room_42-x")).toBe("room_42-x");
    });
    it("falls back to 'public' when nothing survives stripping", () => {
      expect(sanitizeRoom("!!!@@@")).toBe("public");
    });
    it("caps length at 24 characters", () => {
      const long = "a".repeat(40);
      expect(sanitizeRoom(long)).toBe("a".repeat(24));
      expect(sanitizeRoom(long).length).toBe(24);
    });
  });

  describe("sanitizeName", () => {
    it("defaults undefined/empty to 'anon'", () => {
      expect(sanitizeName(undefined)).toBe("anon");
      expect(sanitizeName("")).toBe("anon");
      expect(sanitizeName("   ")).toBe("anon");
    });
    it("trims and strips non-ascii characters", () => {
      expect(sanitizeName("  héllo  ")).toBe("hllo");
      expect(sanitizeName("ab\u{1F600}cd")).toBe("abcd");
    });
    it("caps length at 16 characters", () => {
      const long = "x".repeat(30);
      expect(sanitizeName(long)).toBe("x".repeat(16));
      expect(sanitizeName(long).length).toBe(16);
    });
  });

  describe("constants", () => {
    it("exposes SERVER_TICK_HZ", () => {
      expect(SERVER_TICK_HZ).toBe(20);
    });
  });
  ```

- [ ] **Step 2: Run the test, verify it fails**

  Run:
  ```powershell
  npx vitest run test/protocol.test.ts
  ```
  Expected failure (the module under test does not exist yet):
  ```
  Error: Failed to resolve import "../worker/protocol" from "test/protocol.test.ts". Does the file exist?
  ```

- [ ] **Step 3: Implement — author `worker/protocol.ts` VERBATIM from the contract**

  Create `F:\Git\deploy-on-cloudflare\worker\protocol.ts`:
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

- [ ] **Step 4: Run the test, verify it passes**

  Run:
  ```powershell
  npx vitest run test/protocol.test.ts
  ```
  Expected PASS — the file contains exactly 11 `it(...)` cases (round-trip 3 + decode-error 1 + sanitizeRoom 4 + sanitizeName 3 + constants 1 = 11):
  ```
   ✓ test/protocol.test.ts (11 tests)

   Test Files  1 passed (1)
        Tests  11 passed (11)
  ```

- [ ] **Step 5: Typecheck**

  Run:
  ```powershell
  npx tsc --noEmit
  ```
  Expected: no output and exit code 0.

- [ ] **Step 6: Commit**

  ```powershell
  git add worker/protocol.ts test/protocol.test.ts
  git commit -m "T2: shared wire protocol (protocol.ts) + encode/decode + sanitize tests"
  ```

### Task T3: GameRoom DO — WebSocket accept, nickname, join/welcome, leave, player cap

**Depends on:** T1 (scaffold: `wrangler.jsonc` with the `ROOMS` binding + `GameRoom` migration, `vitest.config.ts`, `tsconfig.json`, and the inline `GameRoom` stub in `worker/index.ts`) and T2 (`worker/protocol.ts` with the exact exports). This task creates `worker/room.ts`, **rewrites `worker/index.ts` to re-export `GameRoom` from `./room` (deleting the T1 inline stub)** so the `ROOMS` binding resolves to the REAL class for every DO test from T3 onward, and creates `test/room.test.ts`.

Per **v2 D3**: `Env` is declared ONCE in `worker/index.ts` and imported as a TYPE elsewhere; `GameRoom extends DurableObject<Env>`. There is exactly ONE exported `GameRoom` (the migration `new_sqlite_classes: ["GameRoom"]` binds to it). T9 later only finalizes the Hono routes; it does NOT introduce a second `GameRoom`.

Per **v2 D4**: `PlayerRec` has NO `posBuf` field and there is NO `posAt` method (lag-comp rewind is post-v1). Per **v2 D5**: the nickname travels in the WS URL query (`?name=...`); `addPlayer(ws, name)`. Per **v2 D6**: a single `pickSpawn(id)` helper is used by both initial spawn and respawn.

**Files:**
- Create: `worker/room.ts`
- Modify: `worker/index.ts` (delete the T1 inline `GameRoom` stub; re-export from `./room`)
- Test: `test/room.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/room.test.ts`. This is the SINGLE room-test file for the whole DO phase: **all of its imports live at the top from now on** (T4 and T5 only ADD `it()`/`describe()` blocks and MERGE new constants into these import lines — they never add a second `import` for an already-imported module, per **v2 D13**). The transport follows **v2 D12**: message-CONTENT assertions use REAL sockets via `connect()`/`nextMessage()`; internal-STATE assertions use `runInDurableObject` and cast `(instance as any)` for private members; the cap test asserts `players.size` via `runInDurableObject` (deterministic — no racing the close event).

```ts
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
```

- [ ] **Step 2: Run the test, verify it fails**

Command:
```
npx vitest run test/room.test.ts
```
Expected failure: `worker/room.ts` does not exist yet (the T1 inline stub does not implement WS accept / welcome / leave / cap). Expected error message similar to:
```
Error: Failed to resolve import "../worker/protocol" ... 
```
or, once `room.ts` is missing the real behaviour:
```
Error: timeout waiting for welcome
```

- [ ] **Step 3a: Declare `Env` once in `worker/index.ts` and re-export `GameRoom` from `./room`**

Rewrite `worker/index.ts` so it (1) declares the single `Env` interface, (2) DELETES the T1 inline `GameRoom` stub class, and (3) re-exports the real `GameRoom` from `./room`. The Hono routes are finalized in T9; for now `index.ts` keeps the `/api/health` route from T1 and the binding/typing. Per **v2 D3** use a type-only import of `GameRoom` for the `DurableObjectNamespace<GameRoom>` generic, plus the value re-export.

```ts
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
```

- [ ] **Step 3b: Implement `worker/room.ts`**

Create `worker/room.ts`. This implements WS accept via the Hibernation API, reads the nickname from the query (**D5**), `addPlayer(ws, name)` (assign `nextId`, `pickSpawn(id)` per **D6**, build a `PlayerRec` with NO `posBuf` per **D4**, send `WelcomeMsg`), `webSocketClose`/`webSocketError` → `removePlayer` + broadcast `LeaveMsg`, and the player cap (the over-cap socket is closed with `1013` and never added to the maps). The tick loop methods (`startLoop`/`loopTick`/`stopLoopIfEmpty`) are stubbed here and fleshed out in T5; `webSocketMessage`/`ingestInput` arrive in T4. `GameRoom extends DurableObject<Env>` per **D3**.

```ts
// worker/room.ts — authoritative game-room Durable Object.
import { DurableObject } from "cloudflare:workers";
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  ST_ALIVE,
  SPAWN_POINTS,
  encode,
  sanitizeName,
} from "./protocol";
import type {
  Vec3,
  Rot,
  PlayerStateCode,
  PlayerSnap,
  ServerMsg,
  WelcomeMsg,
  LeaveMsg,
} from "./protocol";
import type { Env } from "./index";

interface PlayerRec {
  id: number;
  name: string;
  ws: WebSocket;
  p: Vec3;
  r: Rot;
  v: Vec3;
  hp: number;
  st: PlayerStateCode;
  frags: number;
  deaths: number;
  lastShotAt: number;
  lastInputAt: number;
  respawnAt: number;
  protectedUntil: number;
  lastSeq: number;
  rate: { windowStart: number; count: number };
}

export class GameRoom extends DurableObject<Env> {
  private players = new Map<WebSocket, PlayerRec>();
  private byId = new Map<number, PlayerRec>();
  private nextId = 1;
  private tick = 0;
  private tickHandle: ReturnType<typeof setInterval> | undefined;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (this.players.size >= MAX_PLAYERS_PER_ROOM) {
      // Accept then immediately close so the client sees a clean 1013.
      // The socket is NEVER added to players/byId.
      this.ctx.acceptWebSocket(server);
      server.close(1013, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Nickname travels in the WS URL query (?name=...). Sanitize before use.
    const name = sanitizeName(
      new URL(req.url).searchParams.get("name") ?? undefined,
    );

    // Hibernation API: do NOT call server.accept(). Auto-respond to pings for free.
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.addPlayer(server, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Single spawn helper used by BOTH addPlayer (initial) and spawn (respawn).
  private pickSpawn(id: number): Vec3 {
    return SPAWN_POINTS[(id - 1) % SPAWN_POINTS.length]!;
  }

  private addPlayer(ws: WebSocket, name: string): void {
    const id = this.nextId++;
    const spawn = this.pickSpawn(id);
    const now = Date.now();
    const rec: PlayerRec = {
      id,
      name,
      ws,
      p: [spawn[0], spawn[1], spawn[2]],
      r: [0, 0],
      v: [0, 0, 0],
      hp: MAX_HP,
      st: ST_ALIVE,
      frags: 0,
      deaths: 0,
      lastShotAt: 0,
      lastInputAt: now,
      respawnAt: 0,
      protectedUntil: 0,
      lastSeq: 0,
      rate: { windowStart: now, count: 0 },
    };

    // Welcome carries the snapshots of players already in the room.
    const existing: PlayerSnap[] = [];
    for (const other of this.players.values()) existing.push(this.snapOf(other));

    this.players.set(ws, rec);
    this.byId.set(id, rec);

    const welcome: WelcomeMsg = {
      t: "welcome",
      id,
      tickRate: SERVER_TICK_HZ,
      players: existing,
    };
    this.send(ws, welcome);

    this.startLoop();
  }

  private removePlayer(ws: WebSocket): void {
    const rec = this.players.get(ws);
    if (!rec) return;
    this.players.delete(ws);
    this.byId.delete(rec.id);
    try {
      ws.close(1000, "bye");
    } catch {
      // socket may already be closed; ignore.
    }
    const leave: LeaveMsg = { t: "leave", id: rec.id };
    this.broadcast(leave);
    this.stopLoopIfEmpty();
  }

  webSocketClose(ws: WebSocket): void {
    this.removePlayer(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.removePlayer(ws);
  }

  // --- tick loop (filled in by T5; defined here so add/remove can call it) ---

  private startLoop(): void {
    if (this.tickHandle !== undefined) return;
    if (this.players.size === 0) return;
    // NEVER use ctx.storage alarms for the tick: alarm invocations bill as
    // requests (1 each), which would blow the free-tier request budget. setInterval
    // runs inside the DO's active duration (GB-s only), so it is free.
    this.tickHandle = setInterval(() => this.loopTick(), SERVER_TICK_MS);
  }

  private stopLoopIfEmpty(): void {
    if (this.players.size === 0 && this.tickHandle !== undefined) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
  }

  private loopTick(): void {
    // Implemented in T5: advance respawn/protection timers, drop idle players,
    // build + broadcast a SnapMsg.
    this.tick++;
  }

  // --- helpers ---

  private snapOf(rec: PlayerRec): PlayerSnap {
    return {
      id: rec.id,
      name: rec.name,
      p: rec.p,
      r: rec.r,
      v: rec.v,
      hp: rec.hp,
      st: rec.st,
      frags: rec.frags,
      deaths: rec.deaths,
    };
  }

  private broadcast(msg: ServerMsg): void {
    const raw = encode(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(raw);
      } catch {
        // socket may be closing; ignore.
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(encode(msg));
    } catch {
      // ignore send on a closing socket.
    }
  }
}
```

- [ ] **Step 4: Type-check (server-side gate, per v2 D16)**

Command:
```
npx tsc --noEmit
```
Expected output (clean — no diagnostics):
```
(no output)
```

- [ ] **Step 5: Run the test, verify it passes**

Command:
```
npx vitest run test/room.test.ts
```
Expected output (PASS):
```
 ✓ test/room.test.ts (3)
   ✓ GameRoom join/leave/cap (3)
     ✓ assigns an id and sends a welcome listing existing players
     ✓ removes a player and broadcasts a leave on close
     ✓ rejects connections past the player cap with close 1013

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

- [ ] **Step 6: Commit**

```
git add worker/index.ts worker/room.ts test/room.test.ts
git commit -m "T3: GameRoom WS accept, nickname via query, join/welcome, leave, player cap"
```

---

### Task T4: ingestInput + clampMove (server wall-clock dt)

**Depends on:** T3 (`worker/room.ts` exists with `PlayerRec`, `players`/`byId`, `send`/`broadcast`, `Env` re-exported from `worker/index.ts`). This task also depends on `worker/validate.ts` (formally completed in **T6**). Since T6 is not yet implemented, this task creates a **minimal `worker/validate.ts`** containing ONLY the `clampMove` export with the EXACT contract signature (`export function clampMove(prev: Vec3, next: Vec3, dtMs: number): Vec3`). T6 will extend the same file with `validateShoot` and the vector helpers and MUST keep this `clampMove` body verbatim (same non-positive-dt fallback), so the interim and final behaviour are identical. If T6 already ran, skip creating `validate.ts` here and only verify the `clampMove` signature matches.

Per **v2 D4**: there is NO `posBuf` and NO `posAt` — this task only adds `webSocketMessage` routing for `in` and the `ingestInput` method. Per **v2 D7**: `ingestInput` uses SERVER wall-clock dt (NOT the client `m.ts`), so an inflated/garbage `m.ts` cannot widen the move budget. Per **v2 D11**: `webSocketMessage` is synchronous; `shoot` routing is added in T6. Per **v2 D13**: this task only MERGES the new constants into the existing top-of-file import line in `test/room.test.ts` and ADDS one `describe` block — it does NOT re-import already-imported modules.

**Files:**
- Create: `worker/validate.ts` (minimal `clampMove` only — extended in T6)
- Modify: `worker/room.ts` (add `webSocketMessage` + `ingestInput`; route `in` messages)
- Test: `test/room.test.ts` (merge constants into the existing import; append a new `describe` block)

- [ ] **Step 1: Write the failing test**

First, MERGE the new constants into the EXISTING `../worker/protocol` import lines at the top of `test/room.test.ts` (do NOT add a second import). After the merge the two protocol imports read EXACTLY:

```ts
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
```

Then append the following `describe` block (no new module imports — `env`, `runInDurableObject`, `describe`/`it`/`expect` are already imported at the top). These tests drive `ingestInput` directly via `runInDurableObject` against a constructed `PlayerRec`, asserting that a normal input updates `p`/`r`/`v`/`lastSeq`/`lastInputAt`, that an implausible teleport is clamped, and — critically per **D7** — that an inflated/garbage `m.ts` does NOT widen the budget (the move is still clamped because the dt is taken from server wall-clock, not the client timestamp).

```ts
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
```

- [ ] **Step 2: Run the test, verify it fails**

Command:
```
npx vitest run test/room.test.ts
```
Expected failure: `worker/validate.ts` does not exist (or `ingestInput` is not yet a method on `GameRoom`). Expected error message similar to:
```
Error: Failed to resolve import "./validate" from "worker/room.ts"
```
or, if `validate.ts` exists but the method is missing:
```
TypeError: i.ingestInput is not a function
```

- [ ] **Step 3a: Implement the minimal `worker/validate.ts`**

Create `worker/validate.ts` with ONLY `clampMove` (the exact contract signature). T6 extends this same file later — do NOT remove or change this export then; keep this body verbatim so the non-positive-dt fallback (`dtMs > 0 ? dtMs : 50`, divided by 1000 once) is identical between the interim and final versions.

```ts
// worker/validate.ts — pure validation/clamp helpers (extended in T6).
import { MAX_MOVE_SPEED, MOVE_SPEED_TOLERANCE } from "./protocol";
import type { Vec3 } from "./protocol";

// Clamp a claimed new position to a plausible distance from the last known one.
// Returns the accepted position (snapped toward `prev` if the move was implausible).
export function clampMove(prev: Vec3, next: Vec3, dtMs: number): Vec3 {
  const dt = (dtMs > 0 ? dtMs : 50) / 1000; // seconds; fallback ~one server tick
  const dx = next[0] - prev[0];
  const dy = next[1] - prev[1];
  const dz = next[2] - prev[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const maxDist = MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE * dt;
  if (dist <= maxDist || dist === 0) return [next[0], next[1], next[2]];
  const scale = maxDist / dist;
  return [prev[0] + dx * scale, prev[1] + dy * scale, prev[2] + dz * scale];
}
```

- [ ] **Step 3b: Implement `webSocketMessage` routing + `ingestInput` in `worker/room.ts`**

In `worker/room.ts`, add the new imports, then add the synchronous `webSocketMessage` handler and the `ingestInput` method.

First, add these import lines near the top of `worker/room.ts` (below the existing `./protocol` imports). MERGE `decode` into the value import and add the type import — do NOT duplicate any name already imported:

```ts
import { decode } from "./protocol";
import { clampMove } from "./validate";
import type { ClientMsg, InMsg } from "./protocol";
```

(The existing value import from `./protocol` keeps `SERVER_TICK_MS, SERVER_TICK_HZ, MAX_PLAYERS_PER_ROOM, MAX_HP, ST_ALIVE, SPAWN_POINTS, encode, sanitizeName`; add `decode` to it OR keep the separate `import { decode } from "./protocol";` line shown above — either is valid as long as `decode` is imported exactly once.)

Then add the handler and method to the `GameRoom` class body (place after `webSocketError`). Per **v2 D11** the handler is synchronous (`void`, not async) and routes `in` → `ingestInput`; `shoot` routing is added in T6. Per **v2 D7** the move budget uses TRUSTED server wall-clock dt, not the client `m.ts`:

```ts
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    const rec = this.players.get(ws);
    if (!rec) return;
    // (Size cap + rate limit are added in T8, ahead of decode.)
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const msg = decode<ClientMsg>(text);
    if (!msg) return;
    if (msg.t === "in") {
      this.ingestInput(rec, msg);
    }
    // "shoot" handling is added in T6.
  }

  private ingestInput(rec: PlayerRec, m: InMsg): void {
    const now = Date.now();
    // Anti-teleport uses TRUSTED server dt (not the client-controlled m.ts).
    const dtMs = rec.lastInputAt
      ? Math.min(Math.max(now - rec.lastInputAt, 1), 250)
      : 50;
    rec.p = clampMove(rec.p, m.p, dtMs);
    rec.r = [m.r[0], m.r[1]];
    rec.v = [m.v[0], m.v[1], m.v[2]];
    rec.lastInputAt = now;
    rec.lastSeq = m.seq;
  }
```

- [ ] **Step 4: Type-check (per v2 D16)**

Command:
```
npx tsc --noEmit
```
Expected output (clean — no diagnostics):
```
(no output)
```

- [ ] **Step 5: Run the test, verify it passes**

Command:
```
npx vitest run test/room.test.ts
```
Expected output (PASS):
```
 ✓ test/room.test.ts (6)
   ✓ GameRoom join/leave/cap (3)
   ✓ GameRoom ingestInput / clampMove (server dt) (3)
     ✓ updates p/r/v, lastSeq, lastInputAt on a plausible input
     ✓ clamps an implausible teleport
     ✓ ignores an inflated client m.ts (budget comes from server dt)

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

- [ ] **Step 6: Commit**

```
git add worker/validate.ts worker/room.ts test/room.test.ts
git commit -m "T4: ingestInput with clampMove using trusted server wall-clock dt"
```

---

### Task T5: setInterval tick — snapshot broadcast, ack map, idle drop (via removePlayer), stop-on-empty

**Depends on:** T3 + T4 (`worker/room.ts` with `players`/`byId`/`tick`/`tickHandle`, `snapOf`, `broadcast`, `send`, `removePlayer`, `startLoop`/`stopLoopIfEmpty`, `ingestInput`). This task fills in `loopTick` and adds the snapshot/idle/stop behaviour, plus the `ts` and `ack` fields on `SnapMsg`.

Per **v2 D9**: each tick advances respawn/protection timers first (the actual `spawn`/`applyDamage` bodies arrive in T7; here we leave a clearly-marked hook so T7 only fills it). Per **v2 D10**: an idle player is removed via `this.removePlayer(rec.ws)` (which closes the socket, deletes from `players`+`byId`, broadcasts `LeaveMsg`, and calls `stopLoopIfEmpty()`) — iterate a SNAPSHOT of the players to avoid mutating during iteration. Per **v2 D12**: production broadcast iterates `this.ctx.getWebSockets()`, so the tests use REAL sockets via `connect()`/`nextMessage()` for content and `runInDurableObject` (+ a direct `loopTick()` call) for deterministic state, never fake sockets mixed with `getWebSockets()`.

**Files:**
- Modify: `worker/room.ts` (implement `loopTick` fully; idle-drop via `removePlayer`)
- Test: `test/room.test.ts` (merge constants into the existing import; append a new `describe` block)

> **Timer note (why we call `loopTick` directly):** under `@cloudflare/vitest-pool-workers` the `setInterval` callback fires on wall-clock time, which is non-deterministic for assertions. We therefore drive the loop deterministically by calling `(instance as any).loopTick()` inside `runInDurableObject`, and separately assert that `startLoop()` sets `tickHandle` and `stopLoopIfEmpty()` clears it. Snapshot CONTENT is verified by reading from REAL connected sockets (per **v2 D12**), since `loopTick` broadcasts via `this.ctx.getWebSockets()`.

- [ ] **Step 1: Write the failing test**

First, MERGE the new constant into the EXISTING `../worker/protocol` value import line at the top of `test/room.test.ts` (do NOT add a second import) and add `SnapMsg` to the existing type import. After the merge the two protocol imports read EXACTLY:

```ts
import {
  MAX_PLAYERS_PER_ROOM,
  SERVER_TICK_HZ,
  MAX_HP,
  ST_ALIVE,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  IDLE_TIMEOUT_MS,
} from "../worker/protocol";
import type {
  WelcomeMsg,
  LeaveMsg,
  ServerMsg,
  InMsg,
  Vec3,
  Rot,
  PlayerStateCode,
  SnapMsg,
} from "../worker/protocol";
```

Then append the following `describe` block (no new module imports). The first test connects TWO real sockets, ingests one input on each (so `lastSeq` differs), drives a single `loopTick()` via `runInDurableObject`, and reads the resulting `SnapMsg` off a real socket — asserting shape, `tick`, `ts`, the `ack` map, the player list, and the per-player snap fields. The second test seeds an idle player and asserts a `LeaveMsg` is broadcast on idle drop (per **D10**) and that the player is gone. The third asserts `startLoop` sets `tickHandle` and `stopLoopIfEmpty` clears it when empty.

```ts
describe("GameRoom loopTick / idle / stop-on-empty", () => {
  it("broadcasts a SnapMsg with tick, ts, ack, and all players", async () => {
    const stub = roomStub("t5-snap");
    const a = await connect(stub, "alice");
    const welcomeA = await nextMessage<WelcomeMsg>(a, ["welcome"]);
    const b = await connect(stub, "bob");
    const welcomeB = await nextMessage<WelcomeMsg>(b, ["welcome"]);

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
      st: ST_ALIVE,
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
```

- [ ] **Step 2: Run the test, verify it fails**

Command:
```
npx vitest run test/room.test.ts
```
Expected failure: `loopTick` only increments `tick` (the T3 stub) and never broadcasts a snapshot or drops idle players. Expected error message similar to:
```
Error: timeout waiting for snap
```
and the idle-drop test fails with:
```
Error: timeout waiting for leave
```

- [ ] **Step 3: Implement `loopTick`**

Replace the stub `loopTick` body in `worker/room.ts` with the full implementation. Per **v2 D9** advance respawn/protection timers first (T7 fills the `spawn`/state bodies — leave the marked hook), per **v2 D10** drop idle players via `removePlayer` over a SNAPSHOT of the players, then build one `SnapMsg` (advance `tick`, build the `ack` map from each `lastSeq`, gather player snaps) and broadcast it via `this.broadcast(snap)` (which iterates `this.ctx.getWebSockets()`).

Replace this existing method:
```ts
  private loopTick(): void {
    // Implemented in T5: advance respawn/protection timers, drop idle players,
    // build + broadcast a SnapMsg.
    this.tick++;
  }
```
with:
```ts
  private loopTick(): void {
    const now = Date.now();

    // 1) Advance respawn/protection timers. (Bodies arrive in T7; this is the hook.)
    //    T7 replaces this block with: DEAD && now>=respawnAt -> this.spawn(rec);
    //    PROTECTED && now>protectedUntil -> rec.st = ST_ALIVE.

    // 2) Drop idle players via removePlayer (broadcasts LeaveMsg + stopLoopIfEmpty).
    //    Iterate a SNAPSHOT so removePlayer can mutate the maps during iteration.
    for (const rec of [...this.players.values()]) {
      if (now - rec.lastInputAt > IDLE_TIMEOUT_MS) {
        this.removePlayer(rec.ws);
      }
    }
    if (this.players.size === 0) return;

    // 3) Build + broadcast a SnapMsg.
    this.tick++;
    const ack: Record<number, number> = {};
    const snaps: PlayerSnap[] = [];
    for (const rec of this.players.values()) {
      ack[rec.id] = rec.lastSeq;
      snaps.push(this.snapOf(rec));
    }
    const snap: SnapMsg = {
      t: "snap",
      tick: this.tick,
      ts: now,
      ack,
      players: snaps,
    };
    this.broadcast(snap);
  }
```

Then MERGE the two newly-referenced names into the EXISTING `worker/protocol` imports in `worker/room.ts` (do NOT add duplicate imports). Add `IDLE_TIMEOUT_MS` to the existing value import line and `SnapMsg` to the existing type import line so they read:

```ts
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  ST_ALIVE,
  SPAWN_POINTS,
  IDLE_TIMEOUT_MS,
  encode,
  sanitizeName,
} from "./protocol";
import type {
  Vec3,
  Rot,
  PlayerStateCode,
  PlayerSnap,
  ServerMsg,
  WelcomeMsg,
  LeaveMsg,
  SnapMsg,
} from "./protocol";
```

(`decode` from T4 stays imported exactly once, whether merged into the value import above or kept on its own `import { decode } from "./protocol";` line.)

- [ ] **Step 4: Type-check (per v2 D16)**

Command:
```
npx tsc --noEmit
```
Expected output (clean — no diagnostics):
```
(no output)
```

- [ ] **Step 5: Run the test, verify it passes**

Command:
```
npx vitest run test/room.test.ts
```
Expected output (PASS):
```
 ✓ test/room.test.ts (9)
   ✓ GameRoom join/leave/cap (3)
   ✓ GameRoom ingestInput / clampMove (server dt) (3)
   ✓ GameRoom loopTick / idle / stop-on-empty (3)
     ✓ broadcasts a SnapMsg with tick, ts, ack, and all players
     ✓ drops an idle player and broadcasts a leave (via removePlayer)
     ✓ startLoop sets tickHandle; stopLoopIfEmpty clears it when empty

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

- [ ] **Step 6: Commit**

```
git add worker/room.ts test/room.test.ts
git commit -m "T5: setInterval tick loop, snapshot broadcast, ack map, idle drop via removePlayer, stop-on-empty"
```

### Task T6: validate.ts (validateShoot + clampMove + vector helpers) and GameRoom.handleShoot

**Files:**
- Modify: `worker/validate.ts` (extend the minimal `clampMove` from T4 with `validateShoot` + vector helpers)
- Test: `test/validate.test.ts`
- Modify: `worker/room.ts` (add `handleShoot` + `applyDamage`, route `shoot` in `webSocketMessage`)
- Modify: `test/room.test.ts`

> Context for the engineer: tasks T1–T5 are already done per the v2 contract.
> `worker/protocol.ts` exports all the constants/types referenced below (`Vec3`, `Weapon`,
> `WEAPONS`, `AIM_CONE_DOT`, `MAX_MOVE_SPEED`, `MOVE_SPEED_TOLERANCE`, `ST_DEAD`, `ST_ALIVE`,
> `ST_PROTECTED`, `MAX_HP`, `HitMsg`, `ShootMsg`, etc.). `worker/room.ts` already exports
> `export class GameRoom extends DurableObject<Env>` with fields
> `players: Map<WebSocket, PlayerRec>`, `byId: Map<number, PlayerRec>`, `nextId`, `tick`,
> `tickHandle`, and methods `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`,
> `addPlayer`, `removePlayer`, `startLoop`, `stopLoopIfEmpty`, `loopTick`, `broadcast`, `send`,
> `pickSpawn`, `ingestInput`. Per v2 contract decision **D4 there is NO `posBuf` and NO `posAt`** —
> combat validates against CURRENT server-authoritative positions, not a rewind buffer. The
> `PlayerRec` shape is exactly the v2 D4 shape (no `posBuf`). `webSocketMessage(ws, raw): void` is
> **synchronous** (D11); it already parses with `decode` and routes `in` → `ingestInput(rec, m)`.
> You are adding the `shoot` branch. `worker/validate.ts` already exports `clampMove` (created in T4);
> you EXTEND that same file here without changing the `clampMove` signature.

- [ ] **Step 1: Write the failing test for the vector helpers + validateShoot + clampMove**

Create `test/validate.test.ts` with the COMPLETE contents (these are pure functions, so no Workers
runtime is needed beyond what the pool already provides):

```ts
import { describe, it, expect } from "vitest";
import {
  sub,
  dot,
  len,
  norm,
  validateShoot,
  clampMove,
  type ShooterView,
  type TargetView,
} from "../worker/validate";
import {
  WEAPONS,
  AIM_CONE_DOT,
  ST_ALIVE,
  ST_DEAD,
  ST_PROTECTED,
  type Vec3,
  type Weapon,
} from "../worker/protocol";

const RIFLE: Weapon = WEAPONS[0]!;

describe("vector helpers", () => {
  it("sub subtracts component-wise", () => {
    expect(sub([3, 5, 9], [1, 2, 3])).toEqual([2, 3, 6]);
  });

  it("dot computes the dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(1 * 4 + 2 * 5 + 3 * 6);
  });

  it("len computes the Euclidean length", () => {
    expect(len([3, 4, 0])).toBe(5);
    expect(len([0, 0, 0])).toBe(0);
  });

  it("norm returns a unit vector preserving direction", () => {
    const n = norm([0, 0, 5]);
    expect(n[0]).toBeCloseTo(0, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(1, 6);
    expect(len(n)).toBeCloseTo(1, 6);
  });

  it("norm of a zero vector returns a zero vector (no NaN)", () => {
    expect(norm([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("validateShoot", () => {
  const aliveShooter = (over: Partial<ShooterView> = {}): ShooterView => ({
    p: [0, 1, 0],
    st: ST_ALIVE,
    lastShotAt: 0,
    ...over,
  });
  const aliveTarget = (over: Partial<TargetView> = {}): TargetView => ({
    p: [0, 1, 10],
    st: ST_ALIVE,
    ...over,
  });
  // direction straight down +z toward the target at [0,1,10]
  const dirToTarget: Vec3 = [0, 0, 1];
  const NOW = 1_000_000;

  it("returns null for a clean valid shot", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBeNull();
  });

  it("rejects 'dead' when the shooter is dead", () => {
    expect(
      validateShoot(aliveShooter({ st: ST_DEAD, lastShotAt: NOW - 1000 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBe("dead");
  });

  it("rejects 'dead' when the shooter is still spawn-protected (st !== ST_ALIVE)", () => {
    // validateShoot only treats ST_ALIVE as able-to-fire; protection is dropped by
    // handleShoot BEFORE validation in real flow, so a raw protected shooter rejects.
    expect(
      validateShoot(aliveShooter({ st: ST_PROTECTED, lastShotAt: NOW - 1000 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBe("dead");
  });

  it("rejects 'firerate' when now - lastShotAt < cooldownMs - 25", () => {
    // cooldownMs = 120, threshold = 95ms. 50ms elapsed => reject.
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 50 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBe("firerate");
  });

  it("allows a shot exactly at the cooldown grace boundary", () => {
    // 95ms elapsed == cooldownMs - 25; NOT less-than, so allowed.
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 95 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBeNull();
  });

  it("rejects 'notarget' when target is null", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), null, dirToTarget, RIFLE, NOW),
    ).toBe("notarget");
  });

  it("rejects 'target' when the target is dead", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget({ st: ST_DEAD }), dirToTarget, RIFLE, NOW),
    ).toBe("target");
  });

  it("rejects 'target' when the target is spawn-protected", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget({ st: ST_PROTECTED }), dirToTarget, RIFLE, NOW),
    ).toBe("target");
  });

  it("rejects 'range' when distance exceeds the weapon max range", () => {
    expect(
      validateShoot(
        aliveShooter({ lastShotAt: NOW - 1000 }),
        aliveTarget({ p: [0, 1, RIFLE.maxRange + 5] }),
        dirToTarget,
        RIFLE,
        NOW,
      ),
    ).toBe("range");
  });

  it("rejects 'aim' when the reported direction is outside the aim cone", () => {
    // target at +z but the player claims to fire along +x => well outside ~4 degrees
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget(), [1, 0, 0], RIFLE, NOW),
    ).toBe("aim");
  });

  it("accepts a shot just inside the aim cone", () => {
    // tiny lateral offset still inside ~4 degrees of the +z axis
    const slightlyOff: Vec3 = [0.02, 0, 1];
    const result = validateShoot(
      aliveShooter({ lastShotAt: NOW - 1000 }),
      aliveTarget(),
      slightlyOff,
      RIFLE,
      NOW,
    );
    expect(result).toBeNull();
  });

  it("the aim-cone uses AIM_CONE_DOT as the threshold (dot below => reject)", () => {
    // build a dir that is just outside the cone boundary -> reject
    const angle = Math.acos(AIM_CONE_DOT) + 0.01; // just outside the cone
    const off: Vec3 = [Math.sin(angle), 0, Math.cos(angle)];
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget(), off, RIFLE, NOW),
    ).toBe("aim");
  });
});

describe("clampMove", () => {
  it("accepts a plausible move within speed budget", () => {
    // MAX_MOVE_SPEED 12, tolerance 1.6 => ~19.2 u/s. Over 100ms => ~1.92 u allowed.
    const next: Vec3 = [1, 1, 0];
    expect(clampMove([0, 1, 0], next, 100)).toEqual(next);
  });

  it("snaps an implausible teleport back toward the previous position", () => {
    // 1000 units in 100ms is way over budget -> result must be closer than the claim
    const prev: Vec3 = [0, 1, 0];
    const next: Vec3 = [1000, 1, 0];
    const out = clampMove(prev, next, 100);
    expect(out).not.toEqual(next);
    expect(len(sub(out, prev))).toBeLessThan(len(sub(next, prev)));
  });

  it("treats a non-positive dtMs as a one-tick (50ms) budget (no divide-by-zero)", () => {
    const prev: Vec3 = [0, 1, 0];
    const next: Vec3 = [1000, 1, 0];
    const out = clampMove(prev, next, 0);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(out).not.toEqual(next);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command:

```
npx vitest run test/validate.test.ts
```

Expected failure: `worker/validate.ts` exports only `clampMove` (from T4); the named imports
`sub`, `dot`, `len`, `norm`, `validateShoot`, `ShooterView`, `TargetView` do not exist yet, so
vitest reports something like
`No matching export in "worker/validate.ts" for import "validateShoot"`
(or `does not provide an export named 'validateShoot'`), and every test in the file errors at
import. No tests pass.

- [ ] **Step 3: Extend `worker/validate.ts` with the vector helpers + `validateShoot`**

Open `worker/validate.ts` (it currently contains only the T4 `clampMove`). Replace its ENTIRE
contents with the COMPLETE version below. This keeps the T4 `clampMove` signature and behavior
identical (D9: `dt = dtMs > 0 ? dtMs : 50`, divided by 1000 once) and adds the helpers + reject
logic:

```ts
// worker/validate.ts — pure combat + movement validation. No runtime deps.
import {
  AIM_CONE_DOT,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  ST_ALIVE,
  type Vec3,
  type Weapon,
} from "./protocol";

export type ShootReject =
  | "dead"
  | "firerate"
  | "notarget"
  | "target"
  | "range"
  | "aim";

export interface ShooterView {
  p: Vec3;
  st: number;
  lastShotAt: number;
}
export interface TargetView {
  p: Vec3;
  st: number;
}

// ---- vector helpers ----
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function len(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function norm(a: Vec3): Vec3 {
  const l = len(a);
  if (l === 0) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Returns null if the shot is valid (caller applies damage), else a reject reason.
export function validateShoot(
  shooter: ShooterView,
  target: TargetView | null,
  dir: Vec3,
  weapon: Weapon,
  now: number,
): ShootReject | null {
  if (shooter.st !== ST_ALIVE) return "dead";
  if (now - shooter.lastShotAt < weapon.cooldownMs - 25) return "firerate";
  if (target === null) return "notarget";
  if (target.st !== ST_ALIVE) return "target";

  const toTarget = sub(target.p, shooter.p);
  const dist = len(toTarget);
  if (dist > weapon.maxRange) return "range";

  if (dot(norm(dir), norm(toTarget)) < AIM_CONE_DOT) return "aim";

  return null;
}

// Clamp a claimed new position to a plausible distance from the last known one.
// Returns the accepted position (snapped toward `prev` if the move was implausible).
// dtMs is the SERVER wall-clock delta between accepted inputs (see ingestInput / D7);
// a non-positive dt falls back to one server tick (50ms) so we never divide by zero.
export function clampMove(prev: Vec3, next: Vec3, dtMs: number): Vec3 {
  const dt = (dtMs > 0 ? dtMs : 50) / 1000; // seconds
  const maxDist = MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE * dt;
  const delta = sub(next, prev);
  const dist = len(delta);
  if (dist <= maxDist || dist === 0) return [next[0], next[1], next[2]];
  const scale = maxDist / dist;
  return [
    prev[0] + delta[0] * scale,
    prev[1] + delta[1] * scale,
    prev[2] + delta[2] * scale,
  ];
}
```

- [ ] **Step 4: Run the test, verify it passes**

Command:

```
npx vitest run test/validate.test.ts
```

Expected: `Test Files  1 passed (1)` and all `validate.test.ts` cases pass (vector helpers; the
full `validateShoot` reject matrix returning `null`/`dead`/`firerate`/`notarget`/`target`/`range`/`aim`,
including the protected-shooter → `"dead"` case and the AIM_CONE_DOT boundary; and clampMove
plausible/teleport/zero-dt cases).

- [ ] **Step 5: Commit**

```
git add worker/validate.ts test/validate.test.ts
git commit -m "T6: extend validate.ts (validateShoot + vector helpers) with tests"
```

- [ ] **Step 6: Write the failing room test for a valid hit and a rejected shot**

`test/room.test.ts` was created in T3 with ALL its imports at the top. Per v2 contract **D13 you
MUST NOT add a second `import` for an already-imported module** (duplicate identifier = SyntaxError).
This task needs `WEAPONS` and `MAX_HP` from `../worker/protocol` and `GameRoom` as a type. The
existing top-of-file value import from `../worker/protocol` (created across T3–T5) already brings in
`MAX_PLAYERS_PER_ROOM`, `MAX_HP`, `ST_ALIVE`, `IDLE_TIMEOUT_MS`, `POSITION_BUFFER_MS` is removed in
v2 (no posBuf), etc. **Edit** that existing value-import line so it ALSO includes `WEAPONS`, and add
the new type import for `GameRoom`. The merged value-import line must read EXACTLY:

```ts
import {
  MAX_PLAYERS_PER_ROOM,
  SERVER_TICK_HZ,
  MAX_HP,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  ST_ALIVE,
  IDLE_TIMEOUT_MS,
  WEAPONS,
} from "../worker/protocol";
```

Add this single new import line near the other `../worker` imports at the top of the file (it is a
new module, so it is a NEW import, not a duplicate):

```ts
import type { GameRoom } from "../worker/room";
```

Then append the following at the END of `test/room.test.ts`. It defines the reusable `makeRec`
helper (v2 PlayerRec shape — **no `posBuf`**, per D4) used by T6/T7/T8, plus the `handleShoot`
content tests. Per v2 contract **D12**, these are internal-STATE assertions: we run inside
`runInDurableObject`, override the private `broadcast` to capture messages, seed records directly,
and call the private `handleShoot` via an `(instance as any)`-style cast (TS `private` is
compile-time only):

```ts
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
```

- [ ] **Step 7: Run the room test, verify it fails**

Command:

```
npx vitest run test/room.test.ts
```

Expected failure: the new `GameRoom.handleShoot` suite fails because `handleShoot` is not yet a
method on `GameRoom` (only `in` is routed). The valid-hit test fails with `target.hp` still
`MAX_HP` (`expected 100 to be 75`) and the `hit` broadcast is `undefined`, so
`expect(hit).toBeDefined()` throws. (Calling a missing private method via the cast throws
`inst.handleShoot is not a function`.)

- [ ] **Step 8: Implement `handleShoot` + `applyDamage` and wire the `shoot` route in `worker/room.ts`**

First add the names needed by `handleShoot` to the EXISTING `./protocol` value import in
`worker/room.ts` (per D13 — merge into the existing import, do NOT add a second
`import { ... } from "./protocol"`). After T3–T5 that value import brings in
`SERVER_TICK_MS, SERVER_TICK_HZ, MAX_PLAYERS_PER_ROOM, MAX_HP, ST_ALIVE, SPAWN_POINTS,
IDLE_TIMEOUT_MS, decode, encode`. Edit it to ALSO include `WEAPONS` and `ST_PROTECTED`, and edit
the existing `import type { ... } from "./protocol"` line to ALSO include `ShootMsg` and `HitMsg`.
The merged lines must read:

```ts
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  ST_ALIVE,
  ST_PROTECTED,
  SPAWN_POINTS,
  IDLE_TIMEOUT_MS,
  WEAPONS,
  decode,
  encode,
} from "./protocol";
import type {
  Vec3,
  Rot,
  PlayerStateCode,
  PlayerSnap,
  ServerMsg,
  WelcomeMsg,
  LeaveMsg,
  SnapMsg,
  ClientMsg,
  InMsg,
  ShootMsg,
  HitMsg,
} from "./protocol";
```

Add `validateShoot` to the EXISTING `./validate` import line (it already imports `clampMove` from
T4). The merged line must read:

```ts
import { clampMove, validateShoot } from "./validate";
```

Then add the `handleShoot` and `applyDamage` methods inside the `GameRoom` class (place them next
to `ingestInput`). Per v2 contract **D4 there is NO `posAt`/rewind** — combat uses the target's
CURRENT authoritative position. Per **D8**, `handleShoot` returns early on `dead`/`firerate`
(the gun never discharged), otherwise records `lastShotAt`, drops the shooter's own spawn
protection, and applies damage only when the shot is otherwise valid:

```ts
  private handleShoot(rec: PlayerRec, m: ShootMsg): void {
    const now = Date.now();
    const weapon = WEAPONS[m.w] ?? WEAPONS[0]!;
    const target = m.hit === null ? null : (this.byId.get(m.hit) ?? null);

    // Combat validates against CURRENT server-authoritative positions (no lag-comp
    // rewind in v1, per contract D4).
    const reject = validateShoot(
      { p: rec.p, st: rec.st, lastShotAt: rec.lastShotAt },
      target === null ? null : { p: target.p, st: target.st },
      m.d,
      weapon,
      now,
    );

    // "dead" / "firerate" mean the gun did NOT discharge: leave lastShotAt untouched.
    if (reject === "dead" || reject === "firerate") return;

    // The gun fired. Record the shot time and drop our own spawn protection.
    rec.lastShotAt = now;
    if (rec.st === ST_PROTECTED) {
      rec.st = ST_ALIVE;
      rec.protectedUntil = 0;
    }

    // Fired, but the claimed hit was not valid (no/dead/protected target, range, aim).
    if (reject !== null || target === null) return;

    const dmg = m.head ? weapon.damage * weapon.headMult : weapon.damage;
    this.applyDamage(target, dmg, rec, m.head);
  }

  // Apply damage and broadcast a hit. (T7 extends this with death/respawn/scoring.)
  private applyDamage(target: PlayerRec, dmg: number, killer: PlayerRec, head: boolean): void {
    if (target.st === ST_DEAD || target.st === ST_PROTECTED) return;
    target.hp -= dmg;
    const hit: HitMsg = {
      t: "hit",
      by: killer.id,
      on: target.id,
      dmg,
      hp: Math.max(0, target.hp),
      head,
    };
    this.broadcast(hit);
  }
```

> Note: `applyDamage` references `ST_DEAD`. If the existing `./protocol` value import does not yet
> include `ST_DEAD` (it is added in T7 as well), add `ST_DEAD` to the merged value-import line above
> now — it must appear exactly once.

Finally, route `shoot` in `webSocketMessage`. The method stays SYNCHRONOUS (`: void`, per D11).
Find the existing branch that dispatches `in` → `ingestInput` and add the `shoot` case so it reads:

```ts
    if (msg.t === "in") {
      this.ingestInput(rec, msg);
      return;
    }
    if (msg.t === "shoot") {
      this.handleShoot(rec, msg);
      return;
    }
```

- [ ] **Step 9: Type-check, then run the room test, verify it passes**

Commands:

```
npx tsc --noEmit
npx vitest run test/room.test.ts
```

Expected: `npx tsc --noEmit` exits 0 (no type errors). Then `Test Files  1 passed (1)`. The
`GameRoom.handleShoot` suite passes: a valid hit reduces hp by `WEAPONS[0].damage` (to 75) and
broadcasts a `hit` with correct `by/on/dmg/hp`; a headshot applies `headMult`; the
firerate/range/aim rejected shots leave `hp === MAX_HP` with no `hit` broadcast; and a missing
target id discharges the gun (sets `lastShotAt`) without broadcasting a hit.

- [ ] **Step 10: Commit**

```
git add worker/room.ts test/room.test.ts
git commit -m "T6: GameRoom.handleShoot + applyDamage (current-position validation, hit broadcast)"
```

---

### Task T7: Death, respawn, spawn-protection, and score in GameRoom

**Files:**
- Modify: `worker/room.ts` (add `spawn`; extend `applyDamage` with death/scoring; advance respawn/protection in `loopTick`)
- Modify: `test/room.test.ts`

> Context: T6 is done — `handleShoot` validates and calls `applyDamage`, which currently only
> reduces hp and broadcasts `hit`. This task adds the death→respawn→protection lifecycle and
> scoring. Per the v2 contract (D6, D9): on `hp<=0` → `st=ST_DEAD`, `deaths++`, killer `frags++`,
> broadcast `KillMsg`; `loopTick` advances `DEAD`→respawn after `RESPAWN_MS` via `spawn(rec)`;
> `spawn` resets `hp=MAX_HP`, `st=ST_PROTECTED`, picks a position via the SINGLE `pickSpawn(id)`
> helper (D6 — same helper `addPlayer` uses, so initial spawn and respawn agree), sets
> `protectedUntil=now+SPAWN_PROTECTION_MS`, broadcasts `SpawnMsg`; `ST_PROTECTED`→`ST_ALIVE` when
> `now>protectedUntil` (or immediately when the player fires — already handled in T6's
> `handleShoot`). Spawn-protected targets take no damage (already handled by T6's `applyDamage`
> guard). There is NO `posBuf`/`posAt` (D4), so `spawn` does not touch any buffer.

- [ ] **Step 1: Write the failing tests for death/respawn/protection/score**

`test/room.test.ts` already imports `WEAPONS`, `MAX_HP`, `MAX_PLAYERS_PER_ROOM`, `MAX_MOVE_SPEED`,
`ST_ALIVE`, `IDLE_TIMEOUT_MS` from `../worker/protocol` (merged in T6). Per **D13**, do NOT add a
second `import { ... } from "../worker/protocol"`. **Edit** that existing value-import line to ALSO
include `RESPAWN_MS`, `SPAWN_PROTECTION_MS`, `SPAWN_POINTS`, `ST_DEAD`, `ST_PROTECTED`. The merged
value-import line must now read EXACTLY:

```ts
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
} from "../worker/protocol";
```

(The `Vec3` type and `GameRoom` type are already imported at the top from T4/T6.) Append this
`describe` block to the END of `test/room.test.ts` (it reuses the `makeRec` helper and
`RoomInternals` type defined in T6):

```ts
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

  it("respawn uses the same pickSpawn slot as the initial join (D6)", async () => {
    const stub = env.ROOMS.getByName("t7-pickspawn");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const inst = instance as unknown as RoomInternals & {
        pickSpawn: (id: number) => Vec3;
        spawn: (rec: ReturnType<typeof makeRec>) => void;
      };
      inst.broadcast = () => {};
      const now = Date.now();
      const dead = makeRec(3, [99, 99, 99], { st: ST_DEAD, hp: 0, lastInputAt: now });
      dead.respawnAt = now - 1;
      inst.byId.set(3, dead);
      inst.players.set(dead.ws, dead);

      const expected = inst.pickSpawn(3);
      inst.loopTick();
      expect(dead.p).toEqual(expected);
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
```

- [ ] **Step 2: Run the test, verify it fails**

Command:

```
npx vitest run test/room.test.ts
```

Expected failure: the new T7 suite fails. The lethal-hit test fails because `target.st` is still
`ST_ALIVE` (no death handling) — `expect(target.st).toBe(ST_DEAD)` throws `expected 1 to be 0` —
and the `kill` broadcast is `undefined`. The respawn test fails because `loopTick` does not yet
call `spawn` (`spawn` does not exist as a method), leaving `dead.st === ST_DEAD`. The pickSpawn
test throws because `inst.spawn`/`inst.pickSpawn` are reached but `loopTick` never respawns.

- [ ] **Step 3: Implement `spawn`, extend `applyDamage` with death/scoring, and advance respawn/protection in `loopTick`**

Add the names needed by T7 to the EXISTING `./protocol` value import in `worker/room.ts` (per D13 —
merge, never re-import). After T6 that import includes
`SERVER_TICK_MS, SERVER_TICK_HZ, MAX_PLAYERS_PER_ROOM, MAX_HP, ST_ALIVE, ST_PROTECTED, ST_DEAD,
SPAWN_POINTS, IDLE_TIMEOUT_MS, WEAPONS, decode, encode`. Edit it to ALSO include `RESPAWN_MS` and
`SPAWN_PROTECTION_MS`, and edit the `import type { ... } from "./protocol"` line to ALSO include
`KillMsg` and `SpawnMsg`. The merged lines must read:

```ts
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  ST_ALIVE,
  ST_PROTECTED,
  ST_DEAD,
  SPAWN_POINTS,
  IDLE_TIMEOUT_MS,
  WEAPONS,
  RESPAWN_MS,
  SPAWN_PROTECTION_MS,
  decode,
  encode,
} from "./protocol";
import type {
  Vec3,
  Rot,
  PlayerStateCode,
  PlayerSnap,
  ServerMsg,
  WelcomeMsg,
  LeaveMsg,
  SnapMsg,
  ClientMsg,
  InMsg,
  ShootMsg,
  HitMsg,
  KillMsg,
  SpawnMsg,
} from "./protocol";
```

Add the `spawn` method to the `GameRoom` class (place it next to `addPlayer`/`pickSpawn`). Per
**D6** it uses the SINGLE `pickSpawn(id)` helper that `addPlayer` also uses (so initial spawn and
respawn agree); per **D9** it resets hp/state/protection and broadcasts `SpawnMsg`:

```ts
  private spawn(rec: PlayerRec): void {
    const now = Date.now();
    rec.p = this.pickSpawn(rec.id);
    rec.v = [0, 0, 0];
    rec.hp = MAX_HP;
    rec.st = ST_PROTECTED;
    rec.protectedUntil = now + SPAWN_PROTECTION_MS;
    rec.respawnAt = 0;
    const msg: SpawnMsg = { t: "spawn", id: rec.id, p: rec.p, prot: SPAWN_PROTECTION_MS };
    this.broadcast(msg);
  }
```

Extend `applyDamage` (from T6) with death/scoring per **D9**. Replace the T6 `applyDamage` body so
that, after the `hit` broadcast, a lethal blow flips the target to `ST_DEAD`, increments
`deaths`/`frags`, schedules the respawn, and broadcasts a `KillMsg`. The full method now reads:

```ts
  private applyDamage(target: PlayerRec, dmg: number, killer: PlayerRec, head: boolean): void {
    if (target.st === ST_DEAD || target.st === ST_PROTECTED) return;
    target.hp -= dmg;
    const hit: HitMsg = {
      t: "hit",
      by: killer.id,
      on: target.id,
      dmg,
      hp: Math.max(0, target.hp),
      head,
    };
    this.broadcast(hit);

    if (target.hp <= 0) {
      target.hp = 0;
      target.st = ST_DEAD;
      target.deaths += 1;
      target.respawnAt = Date.now() + RESPAWN_MS;
      killer.frags += 1;
      const kill: KillMsg = { t: "kill", by: killer.id, on: target.id, w: 0 };
      this.broadcast(kill);
    }
  }
```

Update `loopTick` to advance respawns and clear expired protection BEFORE the idle-drop and
snapshot steps. `loopTick` already declares `const now = Date.now();` from T5 — do NOT redeclare it.
Insert this loop using the existing `now`, immediately after that declaration and BEFORE the
idle-drop loop:

```ts
    // Advance respawn / spawn-protection timers (T7).
    for (const rec of this.players.values()) {
      if (rec.st === ST_DEAD && rec.respawnAt !== 0 && now >= rec.respawnAt) {
        this.spawn(rec);
      } else if (rec.st === ST_PROTECTED && now > rec.protectedUntil) {
        rec.st = ST_ALIVE;
      }
    }
```

> Note: this respawn/protection loop iterates `this.players.values()` directly (it only mutates
> fields on existing records; it never adds or removes map entries), so it is safe to run before the
> idle-drop loop. The idle-drop loop (T5/D10) iterates a SNAPSHOT (`[...this.players.values()]`)
> because it removes entries.

- [ ] **Step 4: Type-check, then run the test, verify it passes**

Commands:

```
npx tsc --noEmit
npx vitest run test/room.test.ts
```

Expected: `npx tsc --noEmit` exits 0. Then `Test Files  1 passed (1)`. The T7 suite passes: a
lethal hit sets `ST_DEAD`/`deaths=1`/`frags=1` and broadcasts `kill`; `loopTick` respawns a due
DEAD player (restores `hp=MAX_HP`, `st=ST_PROTECTED`, a `SPAWN_POINTS` position equal to
`pickSpawn(id)`, `protectedUntil` in the future, broadcasts `spawn` with
`prot=SPAWN_PROTECTION_MS`); a not-yet-due DEAD player stays DEAD; expired protection becomes
`ST_ALIVE`; a protected target takes no damage; and firing while protected drops the shooter's own
protection while the shot still lands.

- [ ] **Step 5: Commit**

```
git add worker/room.ts test/room.test.ts
git commit -m "T7: death/respawn/spawn-protection/score in GameRoom"
```

---

### Task T8: Per-connection rate limiting + message-size cap in webSocketMessage

**Files:**
- Modify: `worker/room.ts` (size cap + rate limiter at the top of `webSocketMessage`)
- Modify: `test/room.test.ts`

> Context: T3–T7 are done. `webSocketMessage(ws, raw): void` is SYNCHRONOUS (D11): it looks up the
> `PlayerRec` via `this.players.get(ws)`, parses with `decode`, and routes `in`/`shoot`. This task
> adds two guards per **D11**, in this order: (1) size cap — if `raw` is a string whose UTF-8 byte
> length (`new TextEncoder().encode(raw).length`) exceeds `MAX_MESSAGE_BYTES`, `ws.close(1009)` and
> return; (2) per-connection sliding 1-second rate limit using `rec.rate` (`{ windowStart, count }`)
> that silently drops (returns without processing) any message beyond `RATE_LIMIT_MSGS_PER_SEC` in
> the current window. Per **D14** the size-cap boundary is pinned with BOTH an at-cap message
> (processed) and an over-cap message (closed 1009). The method stays synchronous.

- [ ] **Step 1: Write the failing tests for the size cap + rate limiter**

`test/room.test.ts` already imports `MAX_HP`, `ST_ALIVE`, `WEAPONS`, etc. from `../worker/protocol`
(merged in T6/T7). Per **D13**, do NOT add a second `import { ... } from "../worker/protocol"`.
**Edit** the existing value-import line to ALSO include `MAX_MESSAGE_BYTES` and
`RATE_LIMIT_MSGS_PER_SEC`. The merged value-import line must now read EXACTLY:

```ts
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
} from "../worker/protocol";
```

Append this `describe` block to the END of `test/room.test.ts` (it reuses the `makeRec` helper and
`RoomInternals` type from T6). These tests drive the public `webSocketMessage` directly and
override the private `ingestInput` to count processed messages, per **D12** (internal-state path):

```ts
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
```

- [ ] **Step 2: Run the test, verify it fails**

Command:

```
npx vitest run test/room.test.ts
```

Expected failure: the T8 suite fails. The over-cap test fails because `closedWith` is `undefined`
(no size cap yet) and `processed` is `1` instead of `0`. The rate-limit test fails because
`processed` equals `RATE_LIMIT_MSGS_PER_SEC + 5` (45) instead of `RATE_LIMIT_MSGS_PER_SEC` (40),
since no limiter is applied. (The at-cap and window-reset tests fail for the same reasons — no cap,
no limiter.)

- [ ] **Step 3: Implement the size cap + rate limiter at the top of `webSocketMessage`**

Add the two new constant names to the EXISTING `./protocol` value import in `worker/room.ts` (per
D13 — merge, never re-import). Edit the value-import line that already includes
`..., WEAPONS, RESPAWN_MS, SPAWN_PROTECTION_MS, decode, encode` to ALSO include
`MAX_MESSAGE_BYTES` and `RATE_LIMIT_MSGS_PER_SEC`. The merged value-import line must read:

```ts
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  ST_ALIVE,
  ST_PROTECTED,
  ST_DEAD,
  SPAWN_POINTS,
  IDLE_TIMEOUT_MS,
  WEAPONS,
  RESPAWN_MS,
  SPAWN_PROTECTION_MS,
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MSGS_PER_SEC,
  decode,
  encode,
} from "./protocol";
```

At the very top of the `webSocketMessage` method body — BEFORE the existing `rec` lookup / `decode`
/ routing logic — insert the guards. The method stays SYNCHRONOUS (`: void`, per D11). The size cap
runs first (before the `rec` lookup) so an oversized frame is closed even if the socket has no
record yet; the rate limiter runs after `rec` is found. The method should begin like this (keep the
existing parse-and-route body that follows, but remove any DUPLICATE `const rec = this.players.get(ws);`
that previously appeared lower in the method — `rec` must be declared exactly once):

```ts
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    // App-level message-size cap (string messages only; binary is unused in v1).
    // Use UTF-8 byte length, not character count, so the cap is in bytes.
    if (typeof raw === "string" && new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) {
      ws.close(1009, "message too large");
      return;
    }

    const rec = this.players.get(ws);
    if (!rec) return;

    // Per-connection sliding 1-second rate limit. Silently drop excess.
    const now = Date.now();
    if (now - rec.rate.windowStart >= 1000) {
      rec.rate.windowStart = now;
      rec.rate.count = 0;
    }
    if (rec.rate.count >= RATE_LIMIT_MSGS_PER_SEC) {
      return; // dropped: budget for this window exhausted
    }
    rec.rate.count += 1;

    // ----- existing parse + route logic continues below (decode -> in/shoot) -----
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const msg = decode<ClientMsg>(text);
    if (!msg) return;
    if (msg.t === "in") {
      this.ingestInput(rec, msg);
      return;
    }
    if (msg.t === "shoot") {
      this.handleShoot(rec, msg);
      return;
    }
  }
```

> Important: the snippet above shows the COMPLETE final `webSocketMessage`. If the T4/T6 version of
> the method already declared `const rec`/`const text`/`const msg` and routed `in`/`shoot`, replace
> the whole method body with the version above so `rec` and `now` are each declared exactly once and
> the guards run before parsing.

- [ ] **Step 4: Type-check, then run the test, verify it passes**

Commands:

```
npx tsc --noEmit
npx vitest run test/room.test.ts
```

Expected: `npx tsc --noEmit` exits 0. Then `Test Files  1 passed (1)`. The T8 suite passes: an
over-cap string message (`MAX_MESSAGE_BYTES + 1` bytes) triggers `ws.close(1009)` and is not
processed; an exactly-at-cap message (`MAX_MESSAGE_BYTES` bytes) decodes to a valid `in` and is
processed (pinning the `>` boundary); sending `RATE_LIMIT_MSGS_PER_SEC + 5` messages in one window
processes exactly `RATE_LIMIT_MSGS_PER_SEC` and drops the rest; and a stale window (>1s old) resets
so the next message is processed and `rec.rate.count === 1`.

- [ ] **Step 5: Commit**

```
git add worker/room.ts test/room.test.ts
git commit -m "T8: per-connection rate limit + message-size cap in webSocketMessage"
```

### Task T9: Worker Hono app finalize (`/api/health` + `/ws/:room` forward) + worker routing tests

**Context (read before starting):** By the time this task runs, the following files already exist and are correct (built in earlier tasks T1–T8):

- `worker/protocol.ts` — exports the shared wire protocol and tunables, including `sanitizeRoom`.
- `worker/room.ts` — exports `class GameRoom extends DurableObject<Env>` (per D3): a Durable Object that accepts WebSocket upgrades via `this.ctx.acceptWebSocket(server)`, reads the nickname from the `?name=` query param in `fetch(req)` (per D5), sends a `WelcomeMsg` on join, and broadcasts a `SnapMsg` each tick (`setInterval`, never alarms).
- `worker/index.ts` — was rewritten in **T3** to `export { GameRoom } from "./room";` plus the Hono `/api/health` route and the `Env` interface. The T1 inline `GameRoom` stub no longer exists anywhere (T3 moved the class to `worker/room.ts`); there is exactly ONE exported `GameRoom`, which the `wrangler.jsonc` migration `new_sqlite_classes: ["GameRoom"]` binds to.
- `wrangler.jsonc` — binds DO namespace `ROOMS` → class `GameRoom`, lists `/api/*` and `/ws/*` in `assets.run_worker_first`.
- `vitest.config.ts` — uses `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` (modern toolchain per D1: vitest 4 + `@cloudflare/vitest-pool-workers` >= 0.13).
- `test/room.test.ts` — created in T3 (reused by T4–T8) with `import { env } from "cloudflare:workers";` and `import { runInDurableObject } from "cloudflare:test";` and real-socket `connect`/`nextMessage` helpers (per D12).

This task adds the **final `/ws/:room` forward route** to `worker/index.ts` (the `Env` interface and the `GameRoom` re-export already added in T3 stay; do NOT add a second `Env`, a second `GameRoom`, or a value-level `import { GameRoom }`). It also adds the routing tests in `test/worker.test.ts`. Do NOT modify `worker/room.ts` or `worker/protocol.ts`.

**Authoritative decisions applied here:** D1 (modern test API — `exports.default.fetch`, NOT `SELF`), D3 (single `Env` in `index.ts`; `import type { GameRoom }` for the generic, value-level `export { GameRoom } from "./room"`), D5 (room/name travel in the WS URL/query), D16 (server-side task runs `npx tsc --noEmit` before commit; expected-pass file list excludes `interp.test.ts`; no `Co-Authored-By` trailer).

**Files:**
- Modify: `F:\Git\deploy-on-cloudflare\worker\index.ts`
- Create: `F:\Git\deploy-on-cloudflare\test\worker.test.ts`

---

- [ ] **Step 1: Read the current `worker/index.ts` so you EDIT (not rewrite-blindly)**

Run from `F:\Git\deploy-on-cloudflare`:

```
npx wrangler types
```

Expected: regenerates/updates `worker-configuration.d.ts` (gitignored per D2), confirming the `ROOMS` binding type is in scope. Then open `worker/index.ts`; it should currently contain exactly (the T3 result):

```ts
import { Hono } from "hono";
import type { GameRoom } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
export { GameRoom } from "./room";
```

Key facts (do not change them):
- `Env` is declared ONCE here and imported elsewhere via `import type { Env } from "./index";` (D3). Do not duplicate it.
- The `GameRoom` import is **type-only** (`import type { GameRoom }`) — used solely for the `DurableObjectNamespace<GameRoom>` generic. The value-level binding for the DO comes from `export { GameRoom } from "./room";`. Under `verbatimModuleSyntax: true`, a value-level `import { GameRoom }` that is only referenced in a type position would be an error / unused value, so it MUST stay type-only.
- There is no `ASSETS` field in `Env`: `wrangler.jsonc` configures `assets` with `run_worker_first` but does NOT give the assets a `binding` name, so `wrangler types` generates no `ASSETS` Fetcher. Static/SPA serving for all non-`/api/*`, non-`/ws/*` paths is handled by the assets layer outside the Worker code; the Hono app never references `c.env.ASSETS`.

---

- [ ] **Step 2: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\worker.test.ts` with the COMPLETE contents below.

These tests use the modern `@cloudflare/vitest-pool-workers` API (D1): the Worker is driven via `exports.default.fetch(...)` (the named `exports` from `cloudflare:workers`), which routes through real `workerd` and exercises the Hono app end-to-end including the `/ws/:room` DO forward. `SELF` and the `env`/`exports` re-exports from `cloudflare:test` were removed in v0.13.0, so we import `env` and `exports` from `cloudflare:workers`. `exports.default.fetch` does NOT serve static assets (per Cloudflare docs), which is fine — these tests only hit the Worker routes `/api/*` and `/ws/*`.

```ts
import { describe, it, expect } from "vitest";
import { env, exports } from "cloudflare:workers";

// Helper: drive the Worker's default export through real workerd routing.
function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(input, init), env, {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);
}

describe("worker routing", () => {
  it("GET /api/health returns { ok: true }", async () => {
    const res = await fetchWorker("https://example.com/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it("GET /ws/public without an Upgrade header returns 426", async () => {
    const res = await fetchWorker("https://example.com/ws/public");
    expect(res.status).toBe(426);
  });

  it("WebSocket upgrade to /ws/test returns 101 and yields a welcome or snap", async () => {
    const res = await fetchWorker("https://example.com/ws/test?name=tester", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);

    const ws = res.webSocket;
    expect(ws).toBeTruthy();
    if (!ws) throw new Error("no webSocket on the 101 response");
    ws.accept();

    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no message within 2s")),
        2000,
      );
      ws.addEventListener("message", (event: MessageEvent) => {
        clearTimeout(timer);
        resolve(typeof event.data === "string" ? event.data : "");
      });
      // Send a valid InMsg so the room is exercised; welcome/snap arrives regardless.
      ws.send(
        JSON.stringify({
          t: "in",
          seq: 1,
          ts: Date.now(),
          p: [0, 1, 0],
          r: [0, 0],
          v: [0, 0, 0],
        }),
      );
    });

    const parsed = JSON.parse(first) as { t: string };
    expect(["welcome", "snap"]).toContain(parsed.t);

    ws.close();
  });
});
```

Notes on why this matches the locked toolchain:
- Imports come from `cloudflare:workers` (`env`, `exports`), not `cloudflare:test` — `SELF`/`env` were removed from `cloudflare:test` in the same v0.13.0 release that added the `cloudflareTest()` plugin used in `vitest.config.ts`.
- The third arg to `exports.default.fetch` is the `ExecutionContext`; a minimal `waitUntil`/`passThroughOnException` stub satisfies the type and the Hono app does not depend on it.
- The upgrade request carries `?name=tester` so the DO's `fetch(req)` populates the nickname from the query param (D5); the routing assertions here do not depend on the name, but it keeps the request shape identical to the real client URL.

---

- [ ] **Step 3: Run the test, verify it fails**

Run from `F:\Git\deploy-on-cloudflare`:

```
npx vitest run test/worker.test.ts
```

Expected failure: `worker/index.ts` (as left by T3) implements only `/api/health`, so the two `/ws/...` assertions fail. The `/api/health` test passes; the 426 test fails (Hono returns 404 for the unrouted `/ws/public`, e.g. `expected 404 to be 426`) and the upgrade test fails (e.g. `expected 404 to be 101` or `no webSocket on the 101 response`). The test file compiles and runs under the pool; only the two `/ws/...` assertions fail.

---

- [ ] **Step 4: Implement — add the `/ws/:room` forward route to `worker/index.ts`**

Edit `F:\Git\deploy-on-cloudflare\worker\index.ts` so its COMPLETE contents are exactly:

```ts
import { Hono } from "hono";
import type { GameRoom } from "./room";
import { sanitizeRoom } from "./protocol";

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
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
```

Why this is correct and build-clean:
- **Single `Env` (D3):** declared once here; other worker files use `import type { Env } from "./index";`. No second declaration.
- **Single `GameRoom` (D3 + review):** `import type { GameRoom }` is type-only (used only in `DurableObjectNamespace<GameRoom>`), and the value-level binding the migration resolves to is `export { GameRoom } from "./room";`. There is NO value-level `import { GameRoom }` — that would be an unused value under `verbatimModuleSyntax: true` and would risk a duplicate/unused-export error. Exactly one `GameRoom` is exported; the T1 inline stub was already removed in T3.
- **Upgrade gate:** `Upgrade !== "websocket"` → `c.text("Expected websocket", 426)`, per the contract.
- **`sanitizeRoom` reuse:** `sanitizeRoom(c.req.param("room"))` uses the shared helper from `worker/protocol.ts`; do not reimplement it.
- **Raw request forward (D5):** `c.env.ROOMS.getByName(room)` then `return stub.fetch(c.req.raw)` passes the **raw** `Request` so the `Upgrade` header AND the `?name=...` query survive into `GameRoom.fetch(req)`, and the DO's `webSocket` on the 101 response is returned to the client.
- **Assets:** static/SPA serving for non-`/api/*`, non-`/ws/*` paths is handled by the assets layer (`assets` + `run_worker_first` in `wrangler.jsonc`); no catch-all Hono route is needed, and `exports.default.fetch()` in the test cannot exercise the assets path (per Cloudflare docs) — that path is verified manually via `npm run dev` in T1 and in T17, not in CI.

---

- [ ] **Step 5: Typecheck (server-side task gate per D16)**

Run from `F:\Git\deploy-on-cloudflare`:

```
npx tsc --noEmit
```

Expected output: no errors (clean exit, no printed diagnostics). This catches any unused/duplicate-export error, a stray value-level `import { GameRoom }`, or a missing `worker-configuration.d.ts` binding before the test run. If `cloudflare:workers` types fail to resolve, confirm `@cloudflare/workers-types` is in tsconfig `types` and that `npx wrangler types` (Step 1) has generated `worker-configuration.d.ts`.

---

- [ ] **Step 6: Run the test, verify it passes**

Run from `F:\Git\deploy-on-cloudflare`:

```
npx vitest run test/worker.test.ts
```

Expected output: all 3 tests pass, e.g.:

```
 ✓ test/worker.test.ts (3)
   ✓ worker routing > GET /api/health returns { ok: true }
   ✓ worker routing > GET /ws/public without an Upgrade header returns 426
   ✓ worker routing > WebSocket upgrade to /ws/test returns 101 and yields a welcome or snap

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Then run the full suite to confirm no regressions:

```
npx vitest run
```

Expected: all test files that exist by the end of T9 pass — `protocol.test.ts`, `validate.test.ts`, `room.test.ts`, `worker.test.ts`. (`interp.test.ts` does not exist yet; it is created in T10, so it is NOT in this list.)

---

- [ ] **Step 7: Commit**

Run from `F:\Git\deploy-on-cloudflare`:

```
git add worker/index.ts test/worker.test.ts
git commit -m "T9: add Hono /ws/:room forward + worker routing tests"
```

The commit message has NO `Co-Authored-By` trailer (per D16).

### Task T10: interp.ts — pure interpolation/vector math helpers

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\interp.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\interp.test.ts`

This is a pure TypeScript module (no DOM, no WebGL, no Three.js) — fully unit-tested with vitest. It implements EXACTLY the signatures fixed in the contract's `interp.ts` section:

```ts
import type { Vec3, Rot } from "../worker/protocol";
export function lerp(a: number, b: number, t: number): number;
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3;
export function lerpAngle(a: number, b: number, t: number): number; // shortest-path yaw
export function clamp(x: number, lo: number, hi: number): number;
export interface Snapshot { t: number; p: Vec3; r: Rot; }
export function sampleBuffer(buf: Snapshot[], renderTime: number): { p: Vec3; r: Rot } | null;
```

`Vec3 = [number, number, number]` and `Rot = [number, number]` (`[yaw, pitch]`) are imported from `worker/protocol.ts` (already created in T2). Do NOT redefine them.

The test runs on the modern toolchain (contract D1): vitest 4 + the `cloudflareTest()` plugin. This file is pure and DOM-free, so it needs only vitest imports — it does NOT import `cloudflare:workers` or `cloudflare:test`.

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\interp.test.ts` with this COMPLETE content:

```ts
import { describe, it, expect } from "vitest";
import {
  lerp,
  lerpVec3,
  lerpAngle,
  clamp,
  sampleBuffer,
  type Snapshot,
} from "../src/interp";

describe("lerp", () => {
  it("returns a at t=0 and b at t=1", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });
  it("returns the midpoint at t=0.5", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(-4, 4, 0.5)).toBe(0);
  });
});

describe("lerpVec3", () => {
  it("interpolates each component at the midpoint", () => {
    expect(lerpVec3([0, 0, 0], [2, 4, 6], 0.5)).toEqual([1, 2, 3]);
  });
  it("returns the endpoints at t=0 and t=1", () => {
    expect(lerpVec3([1, 2, 3], [9, 8, 7], 0)).toEqual([1, 2, 3]);
    expect(lerpVec3([1, 2, 3], [9, 8, 7], 1)).toEqual([9, 8, 7]);
  });
});

describe("lerpAngle (shortest-path yaw)", () => {
  it("interpolates linearly when no wrap is needed", () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 6);
  });
  it("wraps the short way across +/-PI instead of the long way", () => {
    // from 170deg (~2.967) to -170deg (~-2.967): shortest path crosses PI
    // (a 20deg gap), NOT the 340deg gap the other direction.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    // midpoint of the short arc sits at exactly 180deg == PI (or -PI).
    const dist = Math.abs(Math.atan2(Math.sin(mid - Math.PI), Math.cos(mid - Math.PI)));
    expect(dist).toBeCloseTo(0, 5);
  });
  it("is symmetric: wrapping the other direction also takes the short arc", () => {
    const a = (-170 * Math.PI) / 180;
    const b = (170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    const dist = Math.abs(Math.atan2(Math.sin(mid - Math.PI), Math.cos(mid - Math.PI)));
    expect(dist).toBeCloseTo(0, 5);
  });
});

describe("clamp", () => {
  it("passes through values within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps below lo and above hi", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("sampleBuffer", () => {
  it("returns null on an empty buffer", () => {
    expect(sampleBuffer([], 1000)).toBeNull();
  });

  it("returns the single sample when the buffer has length 1", () => {
    const buf: Snapshot[] = [{ t: 1000, p: [1, 2, 3], r: [0.5, -0.2] }];
    expect(sampleBuffer(buf, 5000)).toEqual({ p: [1, 2, 3], r: [0.5, -0.2] });
  });

  it("interpolates between two samples that straddle renderTime", () => {
    const buf: Snapshot[] = [
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 20, 30], r: [Math.PI / 2, 0] },
    ];
    const out = sampleBuffer(buf, 1500);
    expect(out).not.toBeNull();
    expect(out!.p[0]).toBeCloseTo(5, 6);
    expect(out!.p[1]).toBeCloseTo(10, 6);
    expect(out!.p[2]).toBeCloseTo(15, 6);
    expect(out!.r[0]).toBeCloseTo(Math.PI / 4, 6);
    expect(out!.r[1]).toBeCloseTo(0, 6);
  });

  it("clamps to the oldest sample when renderTime is before the buffer", () => {
    const buf: Snapshot[] = [
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 10, 10], r: [1, 1] },
    ];
    expect(sampleBuffer(buf, 500)).toEqual({ p: [0, 0, 0], r: [0, 0] });
  });

  it("clamps to the newest sample when renderTime is after the buffer", () => {
    const buf: Snapshot[] = [
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 10, 10], r: [1, 1] },
    ];
    expect(sampleBuffer(buf, 9999)).toEqual({ p: [10, 10, 10], r: [1, 1] });
  });

  it("drops stale samples and interpolates within the remaining window", () => {
    // older than the straddling pair must not be selected.
    const buf: Snapshot[] = [
      { t: 0, p: [-100, -100, -100], r: [3, 3] },
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 10, 10], r: [0, 0] },
      { t: 3000, p: [20, 20, 20], r: [0, 0] },
    ];
    const out = sampleBuffer(buf, 2500);
    expect(out).not.toBeNull();
    expect(out!.p[0]).toBeCloseTo(15, 6);
    expect(out!.p[1]).toBeCloseTo(15, 6);
    expect(out!.p[2]).toBeCloseTo(15, 6);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npx vitest run test/interp.test.ts
```
Expected failure: the run errors during collection / module resolution because `../src/interp` does not exist yet. The output contains:
```
Error: Failed to load url ../src/interp (resolved id: .../src/interp) ... Does the file exist?
```
(equivalently: `Cannot find module '../src/interp'`). No tests pass.

- [ ] **Step 3: Implement**

Create `F:\Git\deploy-on-cloudflare\src\interp.ts` with this COMPLETE content:

```ts
// src/interp.ts — pure interpolation + vector math helpers (no DOM / no THREE).
import type { Vec3, Rot } from "../worker/protocol";

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// Shortest-path angular interpolation (radians). Wraps across +/-PI correctly.
export function lerpAngle(a: number, b: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  // Smallest signed delta in (-PI, PI].
  let diff = (b - a) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  else if (diff < -Math.PI) diff += TWO_PI;
  return a + diff * t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface Snapshot {
  t: number;
  p: Vec3;
  r: Rot;
}

// Pick interpolated {p,r} for renderTime from a time-sorted (ascending t) buffer.
// Returns null if the buffer is empty. Clamps to the ends when renderTime is
// outside the buffered window. Stale samples (older than the straddling pair) are
// simply never selected because we scan to the latest pair bracketing renderTime.
export function sampleBuffer(
  buf: Snapshot[],
  renderTime: number,
): { p: Vec3; r: Rot } | null {
  if (buf.length === 0) return null;

  const first = buf[0]!;
  const last = buf[buf.length - 1]!;

  if (buf.length === 1 || renderTime <= first.t) {
    return { p: [...first.p] as Vec3, r: [...first.r] as Rot };
  }
  if (renderTime >= last.t) {
    return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
  }

  // Find the adjacent pair (lo, hi) such that lo.t <= renderTime < hi.t.
  for (let i = 1; i < buf.length; i++) {
    const hi = buf[i]!;
    if (renderTime < hi.t) {
      const lo = buf[i - 1]!;
      const span = hi.t - lo.t;
      const t = span > 0 ? (renderTime - lo.t) / span : 0;
      return {
        p: lerpVec3(lo.p, hi.p, t),
        r: [lerpAngle(lo.r[0], hi.r[0], t), lerpAngle(lo.r[1], hi.r[1], t)],
      };
    }
  }

  // Unreachable (renderTime < last.t guaranteed above), but keep TS happy.
  return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Command:
```
npx vitest run test/interp.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  15 passed (15)` (lerp 2, lerpVec3 2, lerpAngle 3, clamp 2, sampleBuffer 6). Exit code 0.

- [ ] **Step 5: Commit**

```
git add src/interp.ts test/interp.test.ts
git commit -m "T10: add interp.ts pure interpolation/vector math helpers + tests"
```

---

### Task T11: net-helpers.ts (pure buildWsUrl/backoff) + net.ts (Net WebSocket client)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\net-helpers.ts`
- Create: `F:\Git\deploy-on-cloudflare\src\net.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\net.test.ts`

The DOM `WebSocket` itself is NOT unit-testable under the workers pool, so per the contract (D15) the two PURE helpers live in a **separate DOM-free module** `src/net-helpers.ts` that the unit test imports directly. `src/net.ts` (which references `window`/`WebSocket`) is NOT imported by the test, so the workers test runtime never evaluates DOM globals.

Contract-fixed APIs (D5, D15 — SOURCE OF TRUTH, match EXACTLY):

`src/net-helpers.ts`:
```ts
import type { Vec3 } from "../worker/protocol";
export function buildWsUrl(loc: { protocol: string; host: string }, room: string, name: string): string;
// -> `${loc.protocol==="https:"?"wss:":"ws:"}//${loc.host}/ws/${room}?name=${encodeURIComponent(name)}`
export function backoff(attempt: number): number; // min(8000, 500 * 2**attempt)
```
(The `Vec3` import is part of the contract-stated module header; it is re-exported as a convenience type so callers can import shared shapes from one place. It is referenced by the `LocationLike` doc shape below.)

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

Key differences from a naive design (these are contract-mandated, do NOT deviate):
- `buildWsUrl` takes THREE args `(loc, room, name)` and appends `?name=encodeURIComponent(name)` so the nickname reaches the server via the WS URL query (D5 — there is NO JoinMsg; `ClientMsg` stays `InMsg | ShootMsg`). `GameRoom.fetch` reads `searchParams.get("name")`.
- `Net` constructor takes `(room, name, loc?)`; the name is baked into the URL at construction.
- `on(type, handler)` returns `void` (not `this`).

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\net.test.ts` with this COMPLETE content. It imports ONLY from the DOM-free `../src/net-helpers` (never `../src/net`), so the workers test runtime never loads `window`/`WebSocket`:

```ts
import { describe, it, expect } from "vitest";
import { buildWsUrl, backoff } from "../src/net-helpers";

describe("buildWsUrl", () => {
  it("uses wss:// when the page is served over https", () => {
    const loc = { protocol: "https:", host: "cf-fps.example.workers.dev" };
    expect(buildWsUrl(loc, "public", "alice")).toBe(
      "wss://cf-fps.example.workers.dev/ws/public?name=alice",
    );
  });

  it("uses ws:// when the page is served over http (localhost dev)", () => {
    const loc = { protocol: "http:", host: "localhost:5173" };
    expect(buildWsUrl(loc, "arena1", "bob")).toBe(
      "ws://localhost:5173/ws/arena1?name=bob",
    );
  });

  it("includes the room code in the path", () => {
    const loc = { protocol: "https:", host: "h" };
    expect(buildWsUrl(loc, "my-room", "carol")).toBe(
      "wss://h/ws/my-room?name=carol",
    );
  });

  it("url-encodes the nickname query value", () => {
    const loc = { protocol: "https:", host: "h" };
    expect(buildWsUrl(loc, "public", "a b&c=d")).toBe(
      "wss://h/ws/public?name=a%20b%26c%3Dd",
    );
  });
});

describe("backoff", () => {
  it("starts at 500ms for attempt 0 and doubles for attempt 1", () => {
    expect(backoff(0)).toBe(500);
    expect(backoff(1)).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(backoff(2)).toBe(2000);
    expect(backoff(3)).toBe(4000);
    expect(backoff(4)).toBe(8000);
  });

  it("caps at 8000ms", () => {
    expect(backoff(5)).toBe(8000);
    expect(backoff(50)).toBe(8000);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (from `F:\Git\deploy-on-cloudflare`):
```
npx vitest run test/net.test.ts
```
Expected failure: module cannot be resolved because `../src/net-helpers` does not exist yet. Output contains:
```
Error: Failed to load url ../src/net-helpers (resolved id: .../src/net-helpers) ... Does the file exist?
```
(equivalently `Cannot find module '../src/net-helpers'`). No tests pass.

- [ ] **Step 3: Implement the pure helpers**

Create `F:\Git\deploy-on-cloudflare\src\net-helpers.ts` with this COMPLETE content:

```ts
// src/net-helpers.ts — DOM-free WS helpers (unit-tested; no window / no WebSocket).
import type { Vec3 } from "../worker/protocol";

// Re-export the shared Vec3 type so callers can pull wire shapes from one place.
export type { Vec3 };

export interface LocationLike {
  protocol: string; // "http:" | "https:"
  host: string; // "host:port"
}

// Build the WebSocket URL for a room. wss:// over https, ws:// otherwise.
// The nickname travels as a url-encoded `?name=` query (contract D5 — no JoinMsg).
export function buildWsUrl(loc: LocationLike, room: string, name: string): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/ws/${room}?name=${encodeURIComponent(name)}`;
}

// Exponential backoff: 500ms, 1000, 2000, 4000, 8000, capped at 8000ms.
export function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Command:
```
npx vitest run test/net.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  7 passed (7)` (buildWsUrl 4, backoff 3). Exit code 0.

- [ ] **Step 5: Implement the Net class (DOM WebSocket; not unit-tested — verified manually in T17)**

Create `F:\Git\deploy-on-cloudflare\src\net.ts` with this COMPLETE content. It imports the pure helpers from `net-helpers.ts` (single source of truth) and `encode`/`decode` from the shared protocol:

```ts
// src/net.ts — WebSocket transport: connect, reconnect/backoff, send, dispatch.
import {
  encode,
  decode,
  type ClientMsg,
  type ServerMsg,
} from "../worker/protocol";
import { buildWsUrl, backoff, type LocationLike } from "./net-helpers";

type Handler = (payload: any) => void;

export class Net {
  private url: string;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  // The nickname is baked into the URL query (contract D5 — no JoinMsg).
  constructor(
    room: string,
    name: string,
    loc: LocationLike = window.location,
  ) {
    this.url = buildWsUrl(loc, room, name);
    this.open();
  }

  // Register a handler for a server message "t", or the synthetic "open"/"close".
  on(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  // JSON-encode and send a client message (no-op while disconnected).
  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }

  // Permanently close: stop reconnecting and shut the socket.
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private emit(type: string, payload: any): void {
    const list = this.handlers.get(type);
    if (list) for (const h of list) h(payload);
  }

  private open(): void {
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      this.attempt = 0;
      this.emit("open", undefined);
    });

    this.ws.addEventListener("message", (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      const msg = decode<ServerMsg>(raw);
      if (msg && typeof (msg as { t?: unknown }).t === "string") {
        this.emit((msg as { t: string }).t, msg);
      }
    });

    this.ws.addEventListener("close", () => {
      this.emit("close", undefined);
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // Let the subsequent "close" event drive reconnection.
      if (this.ws) this.ws.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = backoff(this.attempt);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.open();
    }, delay);
  }
}
```

- [ ] **Step 6: Type-check the whole client surface so far**

Command:
```
npx tsc --noEmit
```
Expected: no output, exit code 0. (Confirms `net.ts`/`net-helpers.ts` agree with the shared protocol types and the contract signatures; the DOM-coupled `Net` class type-checks against `@cloudflare/workers-types` + DOM lib without being executed under the workers pool.)

- [ ] **Step 7: Re-run the unit test to confirm no regression**

Command:
```
npx vitest run test/net.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  7 passed (7)`. Exit code 0.

- [ ] **Step: Manual verification (real connection deferred to T17)**

The DOM `WebSocket` path of `Net` (connect, reconnect/backoff, `on`/`send`/`close`, `"open"`/`"close"` emission, `?name=` query carrying the nickname to the server) is NOT unit-tested here. It is exercised end-to-end in **T17 (main.ts wire-up)**: after `npm run dev`, open `http://localhost:5173` in two tabs — confirm DevTools Network shows `101 Switching Protocols` to `ws://localhost:5173/ws/public?name=<your-nick>`, that each tab's chosen nickname appears on the other tab's nameplate/scoreboard (proving the query name reached the server), that snapshots flow, and that killing then restarting the dev server triggers an automatic reconnect (backoff visible in the Console). No additional manual action is required for T11 beyond the passing unit tests + clean `tsc`.

- [ ] **Step 8: Commit**

```
git add src/net-helpers.ts src/net.ts test/net.test.ts
git commit -m "T11: add net-helpers.ts pure buildWsUrl/backoff + net.ts Net WebSocket client + tests"
```

---

### Task T12: map.ts (buildArena) + physics.ts (buildOctree / makePlayerCollider / resolveCollision)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\map.ts`
- Create: `F:\Git\deploy-on-cloudflare\src\physics.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\physics.test.ts`

These modules are WebGL-adjacent (Three.js geometry + Octree/Capsule collision). The Octree/collision-resolution path needs a real arena mesh and is verified via an explicit MANUAL step (after T17 wires them in). We DO unit-test the one piece of pure logic that does not need WebGL: `makePlayerCollider()` (it returns a `Capsule` of plain `Vector3`s with fixed numeric coordinates straight from the contract).

The test runs on the modern toolchain (D1): vitest 4 + `cloudflareTest()`. It imports only `three`'s `Capsule` addon and the shared `EYE_HEIGHT` constant — no DOM, no `cloudflare:workers`/`cloudflare:test` imports.

Exact import paths (from the Three.js `games_fps` example):
- `import * as THREE from "three";`
- `import { Octree } from "three/addons/math/Octree.js";`
- `import { Capsule } from "three/addons/math/Capsule.js";`

Contract-fixed geometry (map.ts): ground 60×60 plane at y=0; 4 perimeter walls height 6; 4 cover boxes ~`[4,3,4]` at `(±10, 1.5, ±10)`; 2 ramps to a low platform; everything merged into one `THREE.Group`.

Contract-fixed collider (physics.ts): `Capsule(start=[0,0.35,0], end=[0,EYE_HEIGHT,0], r=0.35)` where `EYE_HEIGHT` is imported from `worker/protocol.ts`. `buildOctree(group)` = `new Octree().fromGraphNode(group)`. `resolveCollision(collider, octree, velocity)` takes 3 args with `velocity` REQUIRED (matches T13 usage per contract D16), follows the games_fps `capsuleIntersect` resolution and **returns `onFloor: boolean`**.

> Decoupling note: vitest only loads `test/physics.test.ts` (which imports `src/physics.ts`). `src/physics.ts` must NOT import `src/map.ts` (map.ts pulls in arena geometry unneeded for the collider unit test). Keep them decoupled — `physics.ts` operates on a `THREE.Object3D` and `Octree` passed in by the caller (`main.ts`, T17).

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\physics.test.ts` with this COMPLETE content:

```ts
import { describe, it, expect } from "vitest";
import { makePlayerCollider } from "../src/physics";
import { EYE_HEIGHT } from "../worker/protocol";

describe("makePlayerCollider", () => {
  it("builds a Capsule with the contract-fixed start, end and radius", () => {
    const c = makePlayerCollider();
    expect(c.start.x).toBeCloseTo(0, 6);
    expect(c.start.y).toBeCloseTo(0.35, 6);
    expect(c.start.z).toBeCloseTo(0, 6);
    expect(c.end.x).toBeCloseTo(0, 6);
    expect(c.end.y).toBeCloseTo(EYE_HEIGHT, 6);
    expect(c.end.z).toBeCloseTo(0, 6);
    expect(c.radius).toBeCloseTo(0.35, 6);
  });

  it("returns a fresh, independent collider each call", () => {
    const a = makePlayerCollider();
    const b = makePlayerCollider();
    expect(a).not.toBe(b);
    a.start.x = 999;
    expect(b.start.x).toBeCloseTo(0, 6);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (from `F:\Git\deploy-on-cloudflare`):
```
npx vitest run test/physics.test.ts
```
Expected failure: module cannot be resolved because `../src/physics` does not exist yet. Output contains:
```
Error: Failed to load url ../src/physics (resolved id: .../src/physics) ... Does the file exist?
```
(equivalently `Cannot find module '../src/physics'`). No tests pass.

- [ ] **Step 3: Implement physics.ts**

Create `F:\Git\deploy-on-cloudflare\src\physics.ts` with this COMPLETE content:

```ts
// src/physics.ts — Octree/Capsule collision vs the arena (games_fps pattern).
import * as THREE from "three";
import { Octree } from "three/addons/math/Octree.js";
import { Capsule } from "three/addons/math/Capsule.js";
import { EYE_HEIGHT } from "../worker/protocol";

// Build the collision Octree from the merged arena group.
export function buildOctree(group: THREE.Object3D): Octree {
  return new Octree().fromGraphNode(group);
}

// Player collider: capsule from feet to eye height (contract-fixed).
export function makePlayerCollider(): Capsule {
  return new Capsule(
    new THREE.Vector3(0, 0.35, 0),
    new THREE.Vector3(0, EYE_HEIGHT, 0),
    0.35,
  );
}

// Resolve the collider against the world Octree, adjusting `velocity` along the
// contact normal and pushing the collider out of penetration. `velocity` is
// REQUIRED. Returns whether the player is standing on a (sufficiently
// upward-facing) floor.
export function resolveCollision(
  collider: Capsule,
  octree: Octree,
  velocity: THREE.Vector3,
): boolean {
  const result = octree.capsuleIntersect(collider);
  let onFloor = false;

  if (result) {
    // A near-upward normal means we can stand on the surface.
    onFloor = result.normal.y > 0;

    if (!onFloor) {
      // Cancel the inbound velocity component along the wall normal (slide).
      velocity.addScaledVector(result.normal, -result.normal.dot(velocity));
    }

    // Push the capsule out of the geometry by the penetration depth.
    if (result.depth >= 1e-10) {
      collider.translate(result.normal.clone().multiplyScalar(result.depth));
    }
  }

  return onFloor;
}
```

- [ ] **Step 4: Implement map.ts**

Create `F:\Git\deploy-on-cloudflare\src\map.ts` with this COMPLETE content:

```ts
// src/map.ts — blocky arena geometry merged into a single THREE.Group.
// Ground 60x60, 4 perimeter walls (h6), 4 cover boxes, 2 ramps to a low platform.
import * as THREE from "three";

const ARENA = 60; // ground is 60 x 60, centered at origin
const HALF = ARENA / 2; // 30
const WALL_H = 6;
const WALL_T = 1; // wall thickness

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildArena(): THREE.Group {
  const group = new THREE.Group();

  // Ground: a 60x60 slab (thin box so the Octree has a solid floor volume).
  const groundT = 1;
  const ground = box(ARENA, groundT, ARENA, 0x556b2f, 0, -groundT / 2, 0);
  group.add(ground);

  // 4 perimeter walls (height 6) enclosing the 60x60 area.
  const wy = WALL_H / 2;
  group.add(box(ARENA, WALL_H, WALL_T, 0x8899aa, 0, wy, -HALF)); // north (-z)
  group.add(box(ARENA, WALL_H, WALL_T, 0x8899aa, 0, wy, HALF)); // south (+z)
  group.add(box(WALL_T, WALL_H, ARENA, 0x8899aa, -HALF, wy, 0)); // west (-x)
  group.add(box(WALL_T, WALL_H, ARENA, 0x8899aa, HALF, wy, 0)); // east (+x)

  // 4 cover boxes ~ [4,3,4] at (+-10, 1.5, +-10).
  const coverColor = 0xcc8844;
  group.add(box(4, 3, 4, coverColor, -10, 1.5, -10));
  group.add(box(4, 3, 4, coverColor, 10, 1.5, -10));
  group.add(box(4, 3, 4, coverColor, 10, 1.5, 10));
  group.add(box(4, 3, 4, coverColor, -10, 1.5, 10));

  // A low platform near the center to reach via ramps.
  const platW = 8;
  const platH = 2;
  const platD = 8;
  const platColor = 0x6677aa;
  group.add(box(platW, platH, platD, platColor, 0, platH / 2, 0));

  // 2 ramps: thin boxes rotated ~20 degrees giving access to the platform.
  const rampAngle = (20 * Math.PI) / 180;
  const rampLen = 10;
  const rampColor = 0xaaaaaa;

  const ramp1 = box(4, 0.4, rampLen, rampColor, 0, platH / 2 - 0.2, platD / 2 + 4);
  ramp1.rotation.x = rampAngle;
  group.add(ramp1);

  const ramp2 = box(4, 0.4, rampLen, rampColor, 0, platH / 2 - 0.2, -(platD / 2 + 4));
  ramp2.rotation.x = -rampAngle;
  group.add(ramp2);

  return group;
}
```

- [ ] **Step 5: Run the test, verify it passes**

Command:
```
npx vitest run test/physics.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  2 passed (2)`. Exit code 0.

- [ ] **Step 6: Type-check**

Command:
```
npx tsc --noEmit
```
Expected: no output, exit code 0. (Confirms the `three`/`three/addons` types resolve and `resolveCollision`'s 3-arg `(collider, octree, velocity)` signature with required `velocity` is well-typed, matching the T13 call site per contract D16.)

- [ ] **Step: Manual verification (arena render + collision; WebGL not unit-testable)**

The geometry (`buildArena`), Octree build (`buildOctree`), and runtime collision (`resolveCollision`) require a real WebGL canvas and are verified manually once `main.ts` (T17) wires them in. After T17 is complete, run:
```
npm run dev
```
Open `http://localhost:5173`, click to pointer-lock, and confirm:
1. The arena renders: a 60×60 green ground, four grey perimeter walls (~6 tall), four orange cover boxes at the four `(±10, ±10)` corners, a central raised platform, and two ramps leading up to it.
2. Walk into a wall — you stop and slide along it; you cannot pass through it or leave the 60×60 area.
3. Walk forward off any edge or onto the ground — you do NOT fall through the floor (the capsule rests on the ground slab; `onFloor` is true so gravity stops pulling you down).
4. Walk up a ramp — you smoothly rise onto the central platform; walk off it and you land back on the ground without clipping.

- [ ] **Step 7: Commit**

```
git add src/map.ts src/physics.ts test/physics.test.ts
git commit -m "T12: add map.ts buildArena + physics.ts Octree/Capsule collision + collider test"
```

### Task T13: src/controls.ts — FpsControls (PointerLock + WASD/jump/gravity)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\controls.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\controls.test.ts`

`FpsControls` wraps `PointerLockControls` from `three/addons/controls/PointerLockControls.js` (note: `getObject()` was removed in modern Three.js — use the camera / `controls.object` directly). It tracks WASD + jump key state, integrates gravity and movement into a velocity vector each frame with a **clamped delta**, and calls `physics.resolveCollision(collider, octree, velocity)` **every frame** — the T12 signature is `resolveCollision(collider: Capsule, octree: Octree, velocity: THREE.Vector3): boolean` with **`velocity` REQUIRED (3 args)**; it returns `onFloor`. The class exposes the EXACT public API fixed in the contract (D15): `lock()`, `get isLocked()`, `onLockChange(cb)`, `setPosition(p)`, `getPosition()`, `getRotation()`, `getVelocity()`, `update(dtSec)`. Movement tunables (`GRAVITY`, `JUMP_SPEED`, `MOVE_SPEED`, `MAX_DELTA`) are pure client-only constants declared in this file (they are NOT part of the locked wire `protocol.ts`, which only holds shared types/wire constants). `EYE_HEIGHT` IS imported from the shared protocol.

The genuinely testable part of this module is the pure delta-clamp helper `clampDelta(rawSeconds)` and the pure key→intent mapping `axisFromKeys(keys)`. The full WASD/mouse/gravity behavior requires DOM + WebGL and is covered by a manual step. These pure helpers have no Three.js dependency and import cleanly under the modern vitest 4 / `cloudflareTest` workers pool (the test imports ONLY from `vitest` and `../src/controls`).

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\controls.test.ts` with this COMPLETE content:

```ts
// test/controls.test.ts
import { describe, it, expect } from "vitest";
import { clampDelta, axisFromKeys, MAX_DELTA } from "../src/controls";

describe("clampDelta", () => {
  it("passes a normal frame delta through unchanged", () => {
    expect(clampDelta(0.016)).toBeCloseTo(0.016, 6);
  });

  it("clamps a huge delta (e.g. after a tab switch) to MAX_DELTA", () => {
    expect(clampDelta(5)).toBe(MAX_DELTA);
  });

  it("never returns a negative delta", () => {
    expect(clampDelta(-1)).toBe(0);
  });

  it("returns 0 for a non-finite delta", () => {
    expect(clampDelta(Number.NaN)).toBe(0);
    expect(clampDelta(Number.POSITIVE_INFINITY)).toBe(MAX_DELTA);
  });
});

describe("axisFromKeys", () => {
  it("returns zero intent when no keys are held", () => {
    expect(axisFromKeys({ w: false, a: false, s: false, d: false })).toEqual({ fwd: 0, right: 0 });
  });

  it("maps W to forward +1 and S to forward -1", () => {
    expect(axisFromKeys({ w: true, a: false, s: false, d: false })).toEqual({ fwd: 1, right: 0 });
    expect(axisFromKeys({ w: false, a: false, s: true, d: false })).toEqual({ fwd: -1, right: 0 });
  });

  it("maps D to right +1 and A to right -1", () => {
    expect(axisFromKeys({ w: false, a: false, s: false, d: true })).toEqual({ fwd: 0, right: 1 });
    expect(axisFromKeys({ w: false, a: true, s: false, d: false })).toEqual({ fwd: 0, right: -1 });
  });

  it("cancels opposing keys to zero", () => {
    expect(axisFromKeys({ w: true, a: true, s: true, d: true })).toEqual({ fwd: 0, right: 0 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npx vitest run test/controls.test.ts
```
Expected failure (module does not exist yet); the output contains:
```
Error: Failed to load url ../src/controls (resolved id: .../src/controls.ts) ... Does the file exist?
```
(equivalently `Cannot find module '../src/controls'`). No tests pass.

- [ ] **Step 3: Implement**

Create `F:\Git\deploy-on-cloudflare\src\controls.ts` with this COMPLETE content:

```ts
// src/controls.ts
// First-person controls: PointerLock mouse-look + WASD/jump/gravity with clamped delta.
// Movement tunables here are CLIENT-ONLY (not shared wire constants in worker/protocol.ts).
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { Octree } from "three/addons/math/Octree.js";
import { Capsule } from "three/addons/math/Capsule.js";
import { resolveCollision } from "./physics";
import { EYE_HEIGHT, type Vec3, type Rot } from "../worker/protocol";

// ---- Pure client-only movement tunables ----
export const GRAVITY = 30;          // units/sec^2 (downward)
export const JUMP_SPEED = 9;        // initial upward velocity on jump
export const MOVE_SPEED = 40;       // ground acceleration factor
export const DAMPING_GROUND = 8;    // velocity damping per second while grounded
export const DAMPING_AIR = 0.2;     // velocity damping per second while airborne
export const MAX_DELTA = 0.1;       // clamp render delta (seconds) after tab switches

export interface KeyState { w: boolean; a: boolean; s: boolean; d: boolean; }
export interface MoveAxis { fwd: number; right: number; }

// Pure: clamp a raw frame delta (seconds) into [0, MAX_DELTA].
export function clampDelta(rawSeconds: number): number {
  if (Number.isNaN(rawSeconds) || rawSeconds < 0) return 0;
  return Math.min(rawSeconds, MAX_DELTA);
}

// Pure: map held keys to a normalized movement intent (opposing keys cancel).
export function axisFromKeys(keys: KeyState): MoveAxis {
  const fwd = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const right = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  return { fwd, right };
}

export class FpsControls {
  readonly controls: PointerLockControls;
  readonly collider: Capsule;
  private octree: Octree;
  private camera: THREE.PerspectiveCamera;
  private velocity = new THREE.Vector3();
  private onFloor = false;
  private keys: KeyState = { w: false, a: false, s: false, d: false };
  private wantJump = false;
  private lockChangeCbs: ((locked: boolean) => void)[] = [];

  // scratch vectors (avoid per-frame allocation)
  private fwdDir = new THREE.Vector3();
  private rightDir = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, octree: Octree) {
    this.camera = camera;
    this.octree = octree;
    this.controls = new PointerLockControls(camera, dom);
    // getObject() was removed: PointerLockControls IS the camera-holder now.
    // Collider rides from feet to eye; camera sits on collider.end.
    this.collider = new Capsule(
      new THREE.Vector3(0, 0.35, 0),
      new THREE.Vector3(0, EYE_HEIGHT, 0),
      0.35,
    );
    this.syncCameraToCollider();

    this.controls.addEventListener("lock", this.onLock);
    this.controls.addEventListener("unlock", this.onUnlock);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
  }

  lock(): void { this.controls.lock(); }
  get isLocked(): boolean { return this.controls.isLocked; }

  // Subscribe to PointerLock lock/unlock transitions (true = locked).
  onLockChange(cb: (locked: boolean) => void): void {
    this.lockChangeCbs.push(cb);
  }

  // Teleport the player (used by reconciliation / spawn).
  setPosition(p: Vec3): void {
    const dy = this.collider.end.y - this.collider.start.y;
    this.collider.end.set(p[0], p[1], p[2]);
    this.collider.start.set(p[0], p[1] - dy, p[2]);
    this.velocity.set(0, 0, 0);
    this.syncCameraToCollider();
  }

  getPosition(): Vec3 {
    return [this.collider.end.x, this.collider.end.y, this.collider.end.z];
  }
  getRotation(): Rot {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    return [e.y, e.x];
  }
  getVelocity(): Vec3 {
    return [this.velocity.x, this.velocity.y, this.velocity.z];
  }

  // Advance one frame. `dtSec` is the raw render delta in SECONDS; it is clamped
  // internally (defensive) so a tab-switch spike cannot teleport the player.
  update(dtSec: number): void {
    const dt = clampDelta(dtSec);
    if (dt === 0) return;

    // Gravity + damping.
    if (!this.onFloor) {
      this.velocity.y -= GRAVITY * dt;
    }
    const damping = Math.exp(-(this.onFloor ? DAMPING_GROUND : DAMPING_AIR) * dt) - 1;
    this.velocity.addScaledVector(this.velocity, damping);

    // Horizontal movement intent relative to look direction.
    if (this.isLocked) {
      const axis = axisFromKeys(this.keys);
      this.getForwardVector(this.fwdDir);
      this.getRightVector(this.rightDir);
      const accel = MOVE_SPEED * (this.onFloor ? 1 : 0.3);
      this.velocity.addScaledVector(this.fwdDir, axis.fwd * accel * dt);
      this.velocity.addScaledVector(this.rightDir, axis.right * accel * dt);
      if (this.wantJump && this.onFloor) {
        this.velocity.y = JUMP_SPEED;
      }
    }
    this.wantJump = false;

    // Integrate then resolve against the world each frame (velocity REQUIRED).
    const step = this.velocity.clone().multiplyScalar(dt);
    this.collider.translate(step);
    this.onFloor = resolveCollision(this.collider, this.octree, this.velocity);

    // Fell out of the world: respawn at origin-ish.
    if (this.collider.end.y < -25) {
      this.setPosition([0, EYE_HEIGHT, 0]);
    }
    this.syncCameraToCollider();
  }

  dispose(): void {
    this.controls.removeEventListener("lock", this.onLock);
    this.controls.removeEventListener("unlock", this.onUnlock);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
  }

  private onLock = (): void => {
    for (const cb of this.lockChangeCbs) cb(true);
  };
  private onUnlock = (): void => {
    for (const cb of this.lockChangeCbs) cb(false);
  };

  private syncCameraToCollider(): void {
    this.camera.position.copy(this.collider.end);
  }

  private getForwardVector(out: THREE.Vector3): THREE.Vector3 {
    this.camera.getWorldDirection(out);
    out.y = 0;
    out.normalize();
    return out;
  }
  private getRightVector(out: THREE.Vector3): THREE.Vector3 {
    this.camera.getWorldDirection(out);
    out.y = 0;
    out.normalize();
    out.cross(this.camera.up);
    return out;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keys.w = true; break;
      case "KeyA": this.keys.a = true; break;
      case "KeyS": this.keys.s = true; break;
      case "KeyD": this.keys.d = true; break;
      case "Space": this.wantJump = true; break;
    }
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keys.w = false; break;
      case "KeyA": this.keys.a = false; break;
      case "KeyS": this.keys.s = false; break;
      case "KeyD": this.keys.d = false; break;
    }
  };
}
```

> Note for the implementer: `resolveCollision` is the T12 export with the signature `resolveCollision(collider: Capsule, octree: Octree, velocity: THREE.Vector3): boolean` — **`velocity` is REQUIRED (3 args)** and the return is `onFloor`. The single call site above passes all three arguments; `setPosition` does not collide (it teleports and zeroes velocity). The pure helpers under test (`clampDelta`, `axisFromKeys`, `MAX_DELTA`) have no Three.js dependency and import cleanly under the workers pool. `onLockChange` is the lock-state hook `main.ts` (T17) uses to grab/release the nickname overlay; it is fired by the PointerLockControls `lock`/`unlock` events.

- [ ] **Step 4: Run the test, verify it passes**

Command:
```
npx vitest run test/controls.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  9 passed (9)` (clampDelta 4, axisFromKeys 5). Exit code 0.

- [ ] **Step: Manual verification** (WebGL/DOM behavior not unit-testable under the workers pool; requires T17 wired in)

1. Run `npm run dev` and open `http://localhost:5173`.
2. Click the canvas to engage pointer lock; confirm the cursor disappears and moving the mouse rotates the view (mouse-look works), and that `onLockChange(true)` fires (the nickname/start overlay hides).
3. Hold `W`/`A`/`S`/`D`: confirm you move forward/left/back/right **relative to where you are looking**.
4. Press `Space`: confirm the player jumps and gravity pulls it back down to the floor (you stop falling on the ground plane; `onFloor` becomes true).
5. Walk into a cover box / perimeter wall: confirm you are blocked (collision resolves, you do not pass through).
6. Walk up a ramp: confirm you smoothly climb onto the low platform and `onFloor` keeps you grounded (no jitter).
7. Switch to another tab for ~5 seconds, switch back: confirm you do NOT teleport a huge distance (delta is clamped to `MAX_DELTA`).
8. Press `Esc` to release pointer lock: confirm `onLockChange(false)` fires (the overlay reappears).

- [ ] **Step 5: Commit**

```
git add src/controls.ts test/controls.test.ts
git commit -m "T13: FpsControls (PointerLock + WASD/jump/gravity, clamped delta, 3-arg collision each frame, onLockChange hook)"
```

---

### Task T14: src/player.ts — LocalPlayer (prediction/reconcile) + RemotePlayer (interpolation)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\player.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\player.test.ts`

`LocalPlayer` owns the monotonic input `seq` counter and the reconciliation decision. Its public API is fixed by the contract (D15): `constructor(id)`, the `id` field, `nextSeq()` (returns the current seq THEN increments; starts at 1), `buildInput(p, r, v, tsMs): InMsg` (builds `{ t:"in", seq:this.nextSeq(), ts:tsMs, p, r, v }`), and `reconcile(predicted, server): Vec3 | null` (returns the server position to snap to when `len(sub(predicted, server)) > RECONCILE_DIST`, else `null`). `RECONCILE_DIST = 2.0` is exported (D15 name — NOT `RECONCILE_THRESHOLD`).

`RemotePlayer` builds a blocky body mesh + nameplate `Sprite`, accepts snapshots via `addSnapshot(s: { t, p, r })`, and on `update(nowMs)` samples its buffer at `nowMs - INTERP_DELAY_MS` using `interp.sampleBuffer` to set mesh position/rotation. Its public members are exactly those fixed by D15: `readonly id`, `readonly group` (add/remove to scene), `readonly body` (the raycast target; `userData.playerId = id`), `addSnapshot`, `update`, `dispose`. The nameplate is excluded from raycast (`userData.noHit = true`).

All imported names are verbatim from the contract: `INTERP_DELAY_MS`, `Vec3`, `Rot`, `InMsg` from `../worker/protocol`, and `sampleBuffer` / `Snapshot` from `./interp` (T10). The pure helpers under test have no Three.js dependency, so the test imports ONLY from `vitest`, `../src/player`, and `../worker/protocol` (type-only) — it never loads WebGL.

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\player.test.ts` with this COMPLETE content:

```ts
// test/player.test.ts
import { describe, it, expect } from "vitest";
import { LocalPlayer, RECONCILE_DIST } from "../src/player";
import type { InMsg } from "../worker/protocol";

describe("LocalPlayer.nextSeq", () => {
  it("returns 1 first, then increments monotonically", () => {
    const lp = new LocalPlayer(3);
    expect(lp.nextSeq()).toBe(1);
    expect(lp.nextSeq()).toBe(2);
    expect(lp.nextSeq()).toBe(3);
  });

  it("stores the id passed to the constructor", () => {
    expect(new LocalPlayer(7).id).toBe(7);
  });
});

describe("LocalPlayer.buildInput", () => {
  it("builds an InMsg with an incrementing seq from nextSeq", () => {
    const lp = new LocalPlayer(1);
    const m1: InMsg = lp.buildInput([1, 2, 3], [0.5, -0.2], [0, 0, 1], 1000);
    expect(m1).toEqual({ t: "in", seq: 1, ts: 1000, p: [1, 2, 3], r: [0.5, -0.2], v: [0, 0, 1] });

    const m2: InMsg = lp.buildInput([4, 5, 6], [0, 0], [0, 0, 0], 1066);
    expect(m2.seq).toBe(2);
    expect(m2.ts).toBe(1066);
    expect(m2.t).toBe("in");
  });

  it("copies the position/rotation/velocity arrays (no shared reference)", () => {
    const lp = new LocalPlayer(1);
    const p: [number, number, number] = [1, 2, 3];
    const r: [number, number] = [0, 0];
    const v: [number, number, number] = [0, 0, 0];
    const m = lp.buildInput(p, r, v, 0);
    expect(m.p).not.toBe(p);
    expect(m.r).not.toBe(r);
    expect(m.v).not.toBe(v);
    expect(m.p).toEqual([1, 2, 3]);
  });
});

describe("LocalPlayer.reconcile", () => {
  it("returns null when predicted and server positions are within RECONCILE_DIST", () => {
    const lp = new LocalPlayer(1);
    expect(lp.reconcile([0, 1, 0], [0.1, 1, 0.1])).toBeNull();
  });

  it("returns the server position when divergence exceeds RECONCILE_DIST", () => {
    const lp = new LocalPlayer(1);
    const server: [number, number, number] = [0, 1, RECONCILE_DIST + 1];
    expect(lp.reconcile([0, 1, 0], server)).toEqual(server);
  });

  it("uses 3D distance (diagonal) for the decision", () => {
    const lp = new LocalPlayer(1);
    const d = RECONCILE_DIST; // sqrt(3*d^2) = d*sqrt(3) > RECONCILE_DIST
    const server: [number, number, number] = [d, d, d];
    expect(lp.reconcile([0, 0, 0], server)).toEqual(server);
  });

  it("returns null for identical positions", () => {
    const lp = new LocalPlayer(1);
    expect(lp.reconcile([5, 5, 5], [5, 5, 5])).toBeNull();
  });

  it("returns a copy of the server position, not the passed reference", () => {
    const lp = new LocalPlayer(1);
    const server: [number, number, number] = [0, 0, RECONCILE_DIST + 5];
    const snapped = lp.reconcile([0, 0, 0], server);
    expect(snapped).not.toBe(server);
    expect(snapped).toEqual(server);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (from `F:\Git\deploy-on-cloudflare`):
```
npx vitest run test/player.test.ts
```
Expected failure (module does not exist yet); the output contains:
```
Error: Failed to load url ../src/player (resolved id: .../src/player.ts) ... Does the file exist?
```
(equivalently `Cannot find module '../src/player'`). No tests pass.

- [ ] **Step 3: Implement**

Create `F:\Git\deploy-on-cloudflare\src\player.ts` with this COMPLETE content:

```ts
// src/player.ts
// LocalPlayer: client prediction + reconciliation (seq counter, InMsg builder).
// RemotePlayer: snapshot interpolation (blocky body + nameplate sprite).
import * as THREE from "three";
import { INTERP_DELAY_MS, type Vec3, type Rot, type InMsg } from "../worker/protocol";
import { sampleBuffer, type Snapshot } from "./interp";

// Snap the local player to the server position only when divergence exceeds this (world units).
export const RECONCILE_DIST = 2.0;

// Owns the input seq counter and the reconciliation decision for the net layer.
export class LocalPlayer {
  id: number;
  private seq = 0;

  constructor(id: number) {
    this.id = id;
  }

  // Return the current seq, THEN increment (first call returns 1).
  nextSeq(): number {
    return ++this.seq;
  }

  // Build the next InMsg from explicit p/r/v + timestamp, bumping the seq counter.
  buildInput(p: Vec3, r: Rot, v: Vec3, tsMs: number): InMsg {
    return {
      t: "in",
      seq: this.nextSeq(),
      ts: tsMs,
      p: [p[0], p[1], p[2]],
      r: [r[0], r[1]],
      v: [v[0], v[1], v[2]],
    };
  }

  // Returns the server position to snap to (3D distance beyond RECONCILE_DIST), else null.
  reconcile(predicted: Vec3, server: Vec3): Vec3 | null {
    const dx = predicted[0] - server[0];
    const dy = predicted[1] - server[1];
    const dz = predicted[2] - server[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return dist > RECONCILE_DIST ? [server[0], server[1], server[2]] : null;
  }
}

// A remote player: blocky body (raycast target) + nameplate sprite (excluded from raycast).
export class RemotePlayer {
  readonly id: number;
  readonly group: THREE.Group;
  readonly body: THREE.Mesh;
  private nameplate: THREE.Sprite;
  private buffer: Snapshot[] = [];

  constructor(id: number, name: string) {
    this.id = id;
    this.group = new THREE.Group();

    // Blocky body, roughly capsule-sized so visuals match the server collider.
    const geo = new THREE.BoxGeometry(0.7, 1.0, 0.7);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff5544 });
    this.body = new THREE.Mesh(geo, mat);
    this.body.position.y = 0.5; // box center at half-height above feet
    this.body.userData.playerId = id; // tag for raycasting (climb parents to find this)
    this.group.add(this.body);

    this.nameplate = RemotePlayer.makeNameplate(name);
    this.nameplate.position.y = 1.6;
    this.nameplate.userData.noHit = true; // excluded from raycast targets
    this.group.add(this.nameplate);
  }

  // Push a timestamped snapshot into the interpolation buffer (kept time-sorted).
  addSnapshot(s: Snapshot): void {
    this.buffer.push(s);
    // Drop anything older than ~1s behind the newest sample.
    const newest = s.t;
    while (this.buffer.length > 2 && this.buffer[0]!.t < newest - 1000) {
      this.buffer.shift();
    }
  }

  // Render this remote player INTERP_DELAY_MS in the past.
  update(nowMs: number): void {
    const sample = sampleBuffer(this.buffer, nowMs - INTERP_DELAY_MS);
    if (!sample) return;
    this.group.position.set(sample.p[0], sample.p[1], sample.p[2]);
    this.group.rotation.y = sample.r[0]; // yaw only for the body
  }

  dispose(): void {
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    const tex = (this.nameplate.material as THREE.SpriteMaterial).map;
    if (tex) tex.dispose();
    this.nameplate.material.dispose();
  }

  private static makeNameplate(name: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 32px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.375, 1);
    return sprite;
  }
}
```

> Note for the implementer: `addSnapshot` takes a `Snapshot` (`{ t, p, r }`) exactly as defined in `src/interp.ts` (T10) — `main.ts` (T17) calls `rp.addSnapshot({ t: m.ts, p: ps.p, r: ps.r })`. The body mesh carries `userData.playerId`; `combat.ts` (T15) climbs parents to read it and skips meshes whose `userData.noHit` is true (the nameplate). The public API is exactly the D15 set — `constructor(id, name)`, `id`, `group`, `body`, `addSnapshot`, `update`, `dispose` — so `scene.add(rp.group)` / `scene.remove(rp.group)` and `rp.body` (raycast target) are the only handles the rest of the client needs. The pure parts under test (`LocalPlayer`, `RECONCILE_DIST`) have no Three.js dependency.

- [ ] **Step 4: Run the test, verify it passes**

Command:
```
npx vitest run test/player.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  10 passed (10)` (nextSeq 2, buildInput 2, reconcile 6). Exit code 0.

- [ ] **Step: Manual verification** (WebGL rendering not unit-testable under the workers pool; requires T17 wired in)

1. Run `npm run dev`, open `http://localhost:5173` in **two** browser tabs, join the same room with two different nicknames.
2. In tab A, confirm the other player (tab B) appears as a blocky body with a **nameplate showing tab B's nickname** floating above it (proves `PlayerSnap.name` carries the real name via the `?name=` query, per D5).
3. Move tab B around: confirm in tab A the remote body moves **smoothly** (interpolated `INTERP_DELAY_MS` behind real time), not teleporting per-snapshot.
4. Briefly throttle tab B's network (DevTools → Network → add latency/packet loss): confirm the remote body in tab A keeps moving smoothly through the gap rather than freezing/snapping.
5. Confirm the nameplate is not selectable by aiming/shooting at it (only the body registers a hit — verified in T15).

- [ ] **Step 5: Commit**

```
git add src/player.ts test/player.test.ts
git commit -m "T14: LocalPlayer (nextSeq/buildInput/reconcile, RECONCILE_DIST) + RemotePlayer (snapshot interpolation + nameplate)"
```

---

### Task T15: src/combat.ts — fireRay hitscan + left-click wiring (ShootMsg, hit marker, SFX)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\combat.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\combat.test.ts`

`fireRay(camera, targets)` builds a `THREE.Raycaster`, calls `setFromCamera(new THREE.Vector2(0, 0), camera)` (NDC center), `intersectObjects(targets, true)`, climbs the hit object's parents to find `userData.playerId`, and returns the contract-fixed `FireResult { hit: number | null; head: boolean; o: Vec3; d: Vec3 }` — `hit` is the player id or `null`, `head` is true when the impact point is above the head threshold relative to the player's base, `o` is the camera world position, and `d` is the camera world direction. The pure, unit-tested parts are the parent-climb (`findPlayerId`) and head-detection (`isHead`) helpers operating on mock objects.

`wireShooting(deps)` attaches the left-click handler that — only while pointer-locked — runs `fireRay`, builds a `ShootMsg`, sends it via `deps.send`, and triggers `deps.onLocalShoot(hit)` (local hit marker + shoot SFX). `ShootDeps` is the EXACT D15 shape: `{ camera; dom: HTMLElement; getTargets; isLocked; nextSeq; send; onLocalShoot; weaponId? }` — the DOM element field is named **`dom`** (not `domElement`) and `weaponId` is **optional, default 0**. `wireShooting` returns an unsubscribe function.

Imported names are verbatim from the contract: `Vec3`, `ShootMsg`, `WEAPONS` from `../worker/protocol`. The pure helpers under test have no Three.js dependency, so the test imports ONLY from `vitest` and `../src/combat`.

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\combat.test.ts` with this COMPLETE content:

```ts
// test/combat.test.ts
import { describe, it, expect } from "vitest";
import { findPlayerId, isHead, HEAD_THRESHOLD } from "../src/combat";

// Minimal mock matching the bits of THREE.Object3D that findPlayerId reads.
interface MockObj {
  userData: Record<string, unknown>;
  parent: MockObj | null;
}
function obj(userData: Record<string, unknown>, parent: MockObj | null = null): MockObj {
  return { userData, parent };
}

describe("findPlayerId", () => {
  it("returns the playerId from the hit object itself", () => {
    expect(findPlayerId(obj({ playerId: 7 }))).toBe(7);
  });

  it("climbs parents until it finds a playerId", () => {
    const root = obj({ playerId: 9 });
    const mid = obj({}, root);
    const leaf = obj({}, mid);
    expect(findPlayerId(leaf)).toBe(9);
  });

  it("returns null when no ancestor carries a playerId", () => {
    const root = obj({});
    const leaf = obj({}, root);
    expect(findPlayerId(leaf)).toBeNull();
  });

  it("treats playerId 0 as a valid id (not falsy-skipped)", () => {
    expect(findPlayerId(obj({ playerId: 0 }))).toBe(0);
  });
});

describe("isHead", () => {
  it("is true when the impact point is above the head threshold over the player base", () => {
    // player base (feet) at y = 1, impact near the top of the body
    expect(isHead(1 + HEAD_THRESHOLD + 0.1, 1)).toBe(true);
  });

  it("is false when the impact point is a body shot below the head threshold", () => {
    expect(isHead(1 + HEAD_THRESHOLD - 0.1, 1)).toBe(false);
  });

  it("is false exactly at the threshold boundary", () => {
    expect(isHead(1 + HEAD_THRESHOLD, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (from `F:\Git\deploy-on-cloudflare`):
```
npx vitest run test/combat.test.ts
```
Expected failure (module does not exist yet); the output contains:
```
Error: Failed to load url ../src/combat (resolved id: .../src/combat.ts) ... Does the file exist?
```
(equivalently `Cannot find module '../src/combat'`). No tests pass.

- [ ] **Step 3: Implement**

Create `F:\Git\deploy-on-cloudflare\src\combat.ts` with this COMPLETE content:

```ts
// src/combat.ts
// Hitscan raycast from the crosshair (NDC center) + left-click shoot wiring.
import * as THREE from "three";
import { type Vec3, type ShootMsg, WEAPONS } from "../worker/protocol";

// Impact this far (or more) above the player's feet counts as a headshot.
export const HEAD_THRESHOLD = 0.8;

export interface FireResult {
  hit: number | null; // claimed target player id
  head: boolean;      // headshot claim
  o: Vec3;            // ray origin (camera world position)
  d: Vec3;            // ray direction (camera forward, normalized)
}

// Minimal shape of what findPlayerId reads — lets it be unit-tested with mocks.
interface HasUserData { userData: Record<string, unknown>; parent: HasUserData | null; }

// Pure: climb parents until an ancestor carries a numeric userData.playerId.
export function findPlayerId(start: HasUserData | null): number | null {
  let node: HasUserData | null = start;
  while (node) {
    const id = node.userData["playerId"];
    if (typeof id === "number") return id;
    node = node.parent;
  }
  return null;
}

// Pure: is the impact y far enough above the player's base y to be a headshot?
export function isHead(impactY: number, playerBaseY: number): boolean {
  return impactY - playerBaseY > HEAD_THRESHOLD;
}

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Cast from the crosshair (screen center) against the given meshes; return the claim.
export function fireRay(camera: THREE.Camera, targets: THREE.Object3D[]): FireResult {
  _raycaster.setFromCamera(_center, camera);

  camera.getWorldPosition(_origin);
  camera.getWorldDirection(_dir);
  const o: Vec3 = [_origin.x, _origin.y, _origin.z];
  const d: Vec3 = [_dir.x, _dir.y, _dir.z];

  const intersects = _raycaster.intersectObjects(targets, true);
  for (const it of intersects) {
    if (it.object.userData["noHit"]) continue; // skip nameplates etc.
    const id = findPlayerId(it.object as unknown as HasUserData);
    if (id === null) continue;
    // The target group origin is at the player's feet (base y).
    const playerBaseY = findGroupBaseY(it.object) ?? it.point.y;
    return { hit: id, head: isHead(it.point.y, playerBaseY), o, d };
  }
  return { hit: null, head: false, o, d };
}

// Walk up to the topmost ancestor (the RemotePlayer group) to read its world feet y.
function findGroupBaseY(obj: THREE.Object3D): number | null {
  let node: THREE.Object3D | null = obj;
  let top: THREE.Object3D | null = null;
  while (node) {
    if (typeof node.userData["playerId"] === "number") top = node.parent ?? node;
    node = node.parent;
  }
  if (!top) return null;
  const pos = top.getWorldPosition(new THREE.Vector3());
  return pos.y;
}

// Dependencies the wiring needs (kept narrow so main.ts supplies the real instances).
// Field names match the contract D15 exactly: `dom` (not domElement), optional `weaponId`.
export interface ShootDeps {
  camera: THREE.Camera;
  dom: HTMLElement;
  getTargets: () => THREE.Object3D[];
  isLocked: () => boolean;
  nextSeq: () => number;
  send: (m: ShootMsg) => void;
  onLocalShoot: (hit: boolean) => void; // hud hit-marker + shoot SFX
  weaponId?: number;                    // default 0
}

// Attach the left-click handler. Returns an unsubscribe function.
export function wireShooting(deps: ShootDeps): () => void {
  const weaponId = deps.weaponId ?? 0;
  const weapon = WEAPONS[weaponId] ?? WEAPONS[0]!;
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;       // left-click only
    if (!deps.isLocked()) return;     // only while pointer-locked
    const res = fireRay(deps.camera, deps.getTargets());
    const msg: ShootMsg = {
      t: "shoot",
      seq: deps.nextSeq(),
      ts: Date.now(),
      o: res.o,
      d: res.d,
      w: weapon.id,
      hit: res.hit,
      head: res.head,
    };
    deps.send(msg);
    deps.onLocalShoot(res.hit !== null); // immediate local feedback (marker + SFX)
  };
  deps.dom.addEventListener("mousedown", onMouseDown);
  return () => deps.dom.removeEventListener("mousedown", onMouseDown);
}
```

> Note for the implementer: `wireShooting` is the SINGLE shoot-wiring entry point — `main.ts` (T17) calls it directly (no hand-rolled mousedown handler), passing `{ camera, dom: renderer.domElement, getTargets: () => [...remotes.values()].map(rp => rp.body), isLocked: () => controls.isLocked, nextSeq: () => local.nextSeq(), send: (m) => net.send(m), onLocalShoot: (hit) => { sfx.shoot(); if (hit) hud.flashHitMarker(); } }`. `getTargets()` returns the array of `RemotePlayer.body` meshes (T14); since those bodies carry `userData.playerId` and nameplates carry `userData.noHit`, `fireRay` already filters correctly. `nextSeq` here shares the SAME `LocalPlayer.nextSeq()` counter as movement input, so shot and input seqs stay monotonic on one connection. The pure helpers under test (`findPlayerId`, `isHead`, `HEAD_THRESHOLD`) have no Three.js dependency.

- [ ] **Step 4: Run the test, verify it passes**

Command:
```
npx vitest run test/combat.test.ts
```
Expected: `Test Files  1 passed (1)` and `Tests  7 passed (7)` (findPlayerId 4, isHead 3). Exit code 0.

- [ ] **Step: Manual verification** (shooting feel / WebGL not unit-testable under the workers pool; requires T16/T17 wired in)

1. Run `npm run dev`, open `http://localhost:5173` in **two** tabs in the same room.
2. In tab A, engage pointer lock and **left-click**: confirm you hear the shoot SFX every click (`onLocalShoot` fires).
3. Aim the crosshair at tab B's body and left-click: confirm the **hit marker** flashes on the crosshair and (after the server confirms via a `hit` message) tab B's health bar drops.
4. Aim at the **upper** part of tab B's body and click: confirm the server applies the head multiplier (larger damage chunk — verify via tab B's HP / kill feed).
5. Aim directly at tab B's **nameplate** (and nothing else) and click: confirm it does NOT register as a hit (nameplate excluded from raycast via `userData.noHit`).
6. Click while NOT pointer-locked (cursor visible): confirm no `shoot` is sent and no SFX plays.
7. Click rapidly: confirm the server fire-rate cooldown gates damage (rapid clicks do not all deal damage), while local SFX still plays per click.

- [ ] **Step 5: Commit**

```
git add src/combat.ts test/combat.test.ts
git commit -m "T15: combat fireRay hitscan (parent-climb + head detection) + wireShooting ShootMsg/hit-marker/SFX (dom + weaponId)"
```

### Task T16: HUD overlay (`src/hud.ts`) + WebAudio SFX (`src/audio.ts`)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\src\hud.ts`
- Create: `F:\Git\deploy-on-cloudflare\src\audio.ts`
- Test: `F:\Git\deploy-on-cloudflare\test\hud.test.ts`

This task builds two client-only UI/feedback modules. The DOM/WebGL pieces cannot run under
`@cloudflare/vitest-pool-workers` (no `document`, no WebAudio), so the **pure helpers**
(scoreboard sort, kill-feed expiry pruning) are factored out as exported functions and
unit-tested; the visual/audio behavior gets an explicit **manual verification** step.

The pure helpers operate on the EXACT contract types: `PlayerSnap` (which carries
`id, name, frags, deaths, ...`) and `KillMsg` (`{ t:"kill"; by; on; w }`). The single value
import is `MAX_HP` from `../worker/protocol` (the locked constant — never re-declare `100`
locally; this matches D15 "no local MAX_HP"). All other protocol names are type-only imports.

- [ ] **Step 1: Write the failing test**

Create `F:\Git\deploy-on-cloudflare\test\hud.test.ts` with the COMPLETE contents below. It
imports only the pure, environment-free helpers from `src/hud.ts` (no DOM is touched), so it
runs fine under the workers pool.

```ts
import { describe, it, expect } from "vitest";
import { sortScoreboard, pruneKillFeed, KILL_FEED_TTL_MS, type KillFeedEntry } from "../src/hud";
import type { PlayerSnap } from "../worker/protocol";

function snap(id: number, name: string, frags: number, deaths: number): PlayerSnap {
  return { id, name, p: [0, 0, 0], r: [0, 0], v: [0, 0, 0], hp: 100, st: 1, frags, deaths };
}

describe("sortScoreboard", () => {
  it("returns empty array for empty input", () => {
    expect(sortScoreboard([])).toEqual([]);
  });

  it("sorts by frags descending", () => {
    const out = sortScoreboard([snap(1, "a", 1, 0), snap(2, "b", 5, 0), snap(3, "c", 3, 0)]);
    expect(out.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it("breaks ties by fewer deaths first", () => {
    const out = sortScoreboard([snap(1, "a", 5, 9), snap(2, "b", 5, 2), snap(3, "c", 5, 4)]);
    expect(out.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it("breaks remaining ties by lower id (stable, deterministic)", () => {
    const out = sortScoreboard([snap(7, "a", 2, 2), snap(3, "b", 2, 2), snap(5, "c", 2, 2)]);
    expect(out.map((p) => p.id)).toEqual([3, 5, 7]);
  });

  it("does not mutate the input array", () => {
    const input = [snap(1, "a", 1, 0), snap(2, "b", 5, 0)];
    const copy = input.slice();
    sortScoreboard(input);
    expect(input).toEqual(copy);
  });
});

describe("pruneKillFeed", () => {
  const e = (at: number, text: string): KillFeedEntry => ({ at, text });

  it("exposes a 5000ms TTL", () => {
    expect(KILL_FEED_TTL_MS).toBe(5000);
  });

  it("keeps entries younger than the TTL", () => {
    const now = 10_000;
    const out = pruneKillFeed([e(9000, "fresh")], now);
    expect(out).toEqual([e(9000, "fresh")]);
  });

  it("drops entries at or past the TTL", () => {
    const now = 10_000;
    const out = pruneKillFeed([e(5000, "old"), e(4999, "older"), e(6000, "keep")], now);
    expect(out.map((x) => x.text)).toEqual(["keep"]);
  });

  it("returns empty when all entries expired", () => {
    expect(pruneKillFeed([e(0, "x"), e(100, "y")], 10_000)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [e(9000, "a"), e(1000, "b")];
    const copy = input.slice();
    pruneKillFeed(input, 10_000);
    expect(input).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npm test -- test/hud.test.ts
```
Expected failure: vitest cannot resolve the module, e.g.
```
Error: Failed to resolve import "../src/hud" from "test/hud.test.ts". Does the file exist?
```
The run ends with `FAIL test/hud.test.ts` (non-zero exit).

- [ ] **Step 3: Implement**

Create `F:\Git\deploy-on-cloudflare\src\hud.ts` with the COMPLETE contents below. The pure
helpers (`sortScoreboard`, `pruneKillFeed`, `KILL_FEED_TTL_MS`, `KillFeedEntry`) are exported
at module top so the test imports them without instantiating DOM. The `Hud` class owns all
DOM: crosshair, health bar (bound to local hp / `MAX_HP`), "click to play" prompt shown when
not pointer-locked, scoreboard overlay (visible only while Tab is held) built from the latest
snapshot, kill feed from `KillMsg` with 5s expiry, and a hit-marker flash method.

```ts
// src/hud.ts — HUD overlay: crosshair, health bar, prompt, scoreboard, kill feed, hit marker.
import { MAX_HP } from "../worker/protocol";
import type { PlayerSnap, KillMsg } from "../worker/protocol";

export const KILL_FEED_TTL_MS = 5000;

export interface KillFeedEntry {
  at: number; // ms epoch when the kill happened
  text: string;
}

/**
 * Pure: return a NEW array sorted for scoreboard display.
 * Order: frags desc, then deaths asc, then id asc (deterministic tie-break).
 */
export function sortScoreboard(players: PlayerSnap[]): PlayerSnap[] {
  return players.slice().sort((a, b) => {
    if (b.frags !== a.frags) return b.frags - a.frags;
    if (a.deaths !== b.deaths) return a.deaths - b.deaths;
    return a.id - b.id;
  });
}

/**
 * Pure: return a NEW array containing only entries younger than KILL_FEED_TTL_MS.
 * An entry expires when (now - at) >= KILL_FEED_TTL_MS.
 */
export function pruneKillFeed(entries: KillFeedEntry[], now: number): KillFeedEntry[] {
  return entries.filter((e) => now - e.at < KILL_FEED_TTL_MS);
}

export class Hud {
  private root: HTMLDivElement;
  private healthFill: HTMLDivElement;
  private healthText: HTMLSpanElement;
  private prompt: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private scoreboard: HTMLDivElement;
  private killFeedEl: HTMLDivElement;
  private feed: KillFeedEntry[] = [];
  private scoreboardVisible = false;
  private latestPlayers: PlayerSnap[] = [];
  private myId = -1;
  private hitMarkerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement = document.body) {
    const root = document.createElement("div");
    root.id = "hud-overlay";
    root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;font-family:monospace;z-index:10;";

    // Crosshair (center cross).
    const cross = document.createElement("div");
    cross.style.cssText =
      "position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;";
    cross.innerHTML =
      '<div style="position:absolute;left:8px;top:0;width:2px;height:18px;background:#fff;opacity:.7"></div>' +
      '<div style="position:absolute;top:8px;left:0;height:2px;width:18px;background:#fff;opacity:.7"></div>';
    root.appendChild(cross);

    // Hit marker (hidden until flashed).
    const hit = document.createElement("div");
    hit.style.cssText =
      "position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;" +
      "opacity:0;transition:opacity .05s;";
    hit.innerHTML =
      '<div style="position:absolute;left:0;top:0;width:8px;height:2px;background:#f33;transform:rotate(45deg);transform-origin:left"></div>' +
      '<div style="position:absolute;right:0;top:0;width:8px;height:2px;background:#f33;transform:rotate(-45deg);transform-origin:right"></div>' +
      '<div style="position:absolute;left:0;bottom:0;width:8px;height:2px;background:#f33;transform:rotate(-45deg);transform-origin:left"></div>' +
      '<div style="position:absolute;right:0;bottom:0;width:8px;height:2px;background:#f33;transform:rotate(45deg);transform-origin:right"></div>';
    root.appendChild(hit);
    this.hitMarker = hit;

    // Health bar (bottom-left).
    const healthWrap = document.createElement("div");
    healthWrap.style.cssText =
      "position:absolute;left:18px;bottom:18px;width:240px;height:22px;" +
      "background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.25);";
    const fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:100%;background:#3c9;transition:width .1s;";
    const text = document.createElement("span");
    text.style.cssText =
      "position:absolute;left:8px;top:2px;color:#fff;font-size:14px;text-shadow:0 1px 2px #000;";
    text.textContent = `${MAX_HP} / ${MAX_HP}`;
    healthWrap.appendChild(fill);
    healthWrap.appendChild(text);
    root.appendChild(healthWrap);
    this.healthFill = fill;
    this.healthText = text;

    // "Click to play" prompt (centered overlay).
    const prompt = document.createElement("div");
    prompt.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.55);color:#fff;font-size:24px;text-align:center;";
    prompt.textContent = "Click to play  ·  WASD move · Space jump · Mouse aim · Click shoot · Tab scores";
    root.appendChild(prompt);
    this.prompt = prompt;

    // Kill feed (top-right).
    const feedEl = document.createElement("div");
    feedEl.style.cssText =
      "position:absolute;right:18px;top:18px;color:#fff;font-size:14px;text-align:right;" +
      "text-shadow:0 1px 2px #000;line-height:1.5;";
    root.appendChild(feedEl);
    this.killFeedEl = feedEl;

    // Scoreboard (centered, hidden until Tab held).
    const sb = document.createElement("div");
    sb.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;" +
      "min-width:360px;background:rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.25);" +
      "color:#fff;font-size:14px;padding:14px 18px;";
    root.appendChild(sb);
    this.scoreboard = sb;

    parent.appendChild(root);
    this.root = root;

    // Tab toggles scoreboard while held (default Tab focus-cycling is suppressed).
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  /** Tell the HUD which player id is the local player (highlighted in scoreboard). */
  setMyId(id: number): void {
    this.myId = id;
  }

  /** Update the health bar from the local player's hp (0..MAX_HP). */
  setHealth(hp: number): void {
    const clamped = Math.max(0, Math.min(MAX_HP, hp));
    const pct = (clamped / MAX_HP) * 100;
    this.healthFill.style.width = `${pct}%`;
    this.healthFill.style.background = clamped > 30 ? "#3c9" : "#e44";
    this.healthText.textContent = `${Math.round(clamped)} / ${MAX_HP}`;
  }

  /** Show/hide the "click to play" prompt based on pointer-lock state. */
  setLocked(locked: boolean): void {
    this.prompt.style.display = locked ? "none" : "flex";
  }

  /** Flash the hit marker for a short moment (call on a confirmed local hit). */
  flashHitMarker(): void {
    this.hitMarker.style.opacity = "1";
    if (this.hitMarkerTimer !== undefined) clearTimeout(this.hitMarkerTimer);
    this.hitMarkerTimer = setTimeout(() => {
      this.hitMarker.style.opacity = "0";
    }, 90);
  }

  /** Cache the latest snapshot's player list (used for scoreboard + kill-feed names). */
  setPlayers(players: PlayerSnap[]): void {
    this.latestPlayers = players;
    if (this.scoreboardVisible) this.renderScoreboard();
  }

  /** Push a kill into the feed, resolving ids to names via the latest snapshot players. */
  addKill(msg: KillMsg, now: number = Date.now()): void {
    const nameOf = (id: number): string =>
      this.latestPlayers.find((p) => p.id === id)?.name ?? `#${id}`;
    this.feed.push({ at: now, text: `${nameOf(msg.by)} fragged ${nameOf(msg.on)}` });
    this.renderKillFeed(now);
  }

  /** Re-render the kill feed, pruning expired entries (call each frame). */
  renderKillFeed(now: number = Date.now()): void {
    this.feed = pruneKillFeed(this.feed, now);
    this.killFeedEl.innerHTML = this.feed.map((e) => `<div>${escapeHtml(e.text)}</div>`).join("");
  }

  /** Rebuild the scoreboard rows from the cached snapshot (only renders DOM when visible). */
  private renderScoreboard(): void {
    if (!this.scoreboardVisible) return;
    const rows = sortScoreboard(this.latestPlayers)
      .map((p) => {
        const me = p.id === this.myId ? "color:#fd5;" : "";
        return (
          `<tr style="${me}">` +
          `<td style="text-align:left;padding:2px 12px 2px 0">${escapeHtml(p.name)}</td>` +
          `<td style="text-align:right;padding:2px 12px">${p.frags}</td>` +
          `<td style="text-align:right;padding:2px 0">${p.deaths}</td>` +
          `</tr>`
        );
      })
      .join("");
    this.scoreboard.innerHTML =
      '<table style="width:100%;border-collapse:collapse">' +
      '<tr style="opacity:.6"><th style="text-align:left">PLAYER</th>' +
      '<th style="text-align:right">FRAGS</th><th style="text-align:right">DEATHS</th></tr>' +
      rows +
      "</table>";
  }

  /** Detach listeners and remove the overlay (for teardown/tests). */
  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (this.hitMarkerTimer !== undefined) clearTimeout(this.hitMarkerTimer);
    this.root.remove();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== "Tab") return;
    e.preventDefault();
    if (!this.scoreboardVisible) {
      this.scoreboardVisible = true;
      this.scoreboard.style.display = "block";
      this.renderScoreboard();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== "Tab") return;
    e.preventDefault();
    this.scoreboardVisible = false;
    this.scoreboard.style.display = "none";
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

Create `F:\Git\deploy-on-cloudflare\src\audio.ts` with the COMPLETE contents below. `Sfx`
lazily creates the `AudioContext` on the first user gesture (and resumes a suspended context),
then synthesizes short blips for shoot/hit/death.

```ts
// src/audio.ts — WebAudio SFX: lazily-created context + short synthesized blips.

export class Sfx {
  private ctx: AudioContext | undefined;

  /**
   * Create (or resume) the AudioContext. MUST be called from a user gesture handler
   * (e.g. the first pointer-lock click) or browsers will keep it suspended.
   */
  unlock(): void {
    if (this.ctx === undefined) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  shoot(): void {
    this.blip("square", 320, 140, 0.18, 0.05);
  }

  hit(): void {
    this.blip("triangle", 880, 660, 0.22, 0.06);
  }

  death(): void {
    this.blip("sawtooth", 260, 60, 0.28, 0.22);
  }

  /**
   * Play one short tone: oscillator sweeping freqStart -> freqEnd over `dur` seconds,
   * with a quick gain envelope so it sounds like a blip and never clicks.
   */
  private blip(
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    gain: number,
    dur: number,
  ): void {
    if (this.ctx === undefined || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), now + dur);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npm test -- test/hud.test.ts
```
Expected: all assertions pass, e.g.
```
 ✓ test/hud.test.ts (10 tests)
   ✓ sortScoreboard > returns empty array for empty input
   ✓ sortScoreboard > sorts by frags descending
   ✓ sortScoreboard > breaks ties by fewer deaths first
   ✓ sortScoreboard > breaks remaining ties by lower id (stable, deterministic)
   ✓ sortScoreboard > does not mutate the input array
   ✓ pruneKillFeed > exposes a 5000ms TTL
   ✓ pruneKillFeed > keeps entries younger than the TTL
   ✓ pruneKillFeed > drops entries at or past the TTL
   ✓ pruneKillFeed > returns empty when all entries expired
   ✓ pruneKillFeed > does not mutate the input array

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

- [ ] **Step 5: Type-check**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npx tsc --noEmit
```
Expected: no output (exit 0). This confirms `src/hud.ts` and `src/audio.ts` type-check against
the DOM lib and `../worker/protocol` types.

- [ ] **Step: Manual verification** (visuals/audio — done together with T17's running app)

After T17 wires the HUD/Sfx into the game loop, run `npm run dev` and open
`http://localhost:5173`. Confirm:
1. Before clicking, the centered "Click to play …" prompt is visible; the crosshair and a
   full green health bar (`100 / 100`) show at center / bottom-left.
2. Click the canvas → pointer locks → the prompt disappears (no overlay) and a shoot blip
   plays on the first click (proves the AudioContext unlocked on the gesture).
3. Shoot a remote player: the red hit marker flashes at center and a higher "hit" blip plays;
   when you get a kill, a "death" blip plays and a "<you> fragged <name>" line appears
   top-right, then disappears after ~5 seconds.
4. Take damage from another tab: the health bar shrinks and turns red below 30; on death it
   reaches `0 / 100`.
5. Hold **Tab**: the scoreboard appears centered, rows sorted by frags desc (then fewer
   deaths, then lower id), with your own row highlighted yellow; release Tab → it hides; the
   browser does NOT shift focus while Tab is held (preventDefault works).

- [ ] **Step 6: Commit**
```
git add src/hud.ts src/audio.ts test/hud.test.ts
git commit -m "T16: HUD overlay (crosshair, health, prompt, scoreboard, kill feed, hit marker) + WebAudio SFX, with pure-helper tests"
```

---

### Task T17: Game bootstrap & wire-up (`src/main.ts`)

**Files:**
- Modify: `F:\Git\deploy-on-cloudflare\src\main.ts` (replaces the T1 `console.log("boot")` stub)
- (No new automated test — every module `main.ts` composes is already unit-tested in
  T10–T16; `main.ts` itself is pure DOM/WebGL/live-WebSocket glue that cannot run under
  `@cloudflare/vitest-pool-workers`. This is a **manual-verification** task with a precise
  multi-tab checklist. Its build gate is `npm run build`.)

This task is the top-level composition root. It uses the EXACT names fixed by the contract and
the D15 client-module API signatures. Imports from `../worker/protocol`: the value `MAX_HP`
(single source of truth — NO local `MAX_HP_INIT`), `INTERP_DELAY_MS`, `CLIENT_SEND_MS`,
`EYE_HEIGHT`, `sanitizeRoom`, `sanitizeName`, and the type-only message names
`WelcomeMsg`/`SnapMsg`/`HitMsg`/`KillMsg`/`SpawnMsg`/`LeaveMsg`/`PlayerSnap`. The composed
modules use their D15 signatures EXACTLY:

- `Net(room, name, loc?)` — constructor takes `(room, name)` (D5/D15: the nickname rides the
  WS URL query, there is NO JoinMsg); `.on(type, handler)` for each `ServerMsg.t` plus
  `"open"`/`"close"`; `.send(msg)`; `.close()`.
- `FpsControls`: `isLocked` (getter), `lock()`, `onLockChange(cb)`, `setPosition(p: Vec3)`,
  `getPosition(): Vec3`, `getRotation(): Rot`, `getVelocity(): Vec3`, `update(dtSec)`.
- `LocalPlayer(id)`: `nextSeq()`, `buildInput(p, r, v, tsMs): InMsg`,
  `reconcile(predicted: Vec3, server: Vec3): Vec3 | null`.
- `RemotePlayer(id, name)`: `.group`, `.body`, `addSnapshot({ t, p, r })`, `update(nowMs)`,
  `dispose()`.
- `wireShooting(deps)` (the SINGLE shoot-wiring entry point — D15; main.ts does NOT hand-roll a
  mousedown handler).
- `buildArena(): THREE.Group` (map.ts), `buildOctree(group): Octree` (physics.ts).

- [ ] **Step 1: Write the failing test** — N/A (manual-verification task)

There is no automated unit test for `main.ts`: it is DOM + WebGL + live-WebSocket glue with no
extractable pure logic (all pure logic already lives in the tested helpers `interp`,
`net-helpers`, `player`, `combat`, `hud`). The acceptance gate is `npm run build` (Step 4) plus
the multi-tab checklist in the Manual verification step. (Per the contract: "Client rendering
tasks … use unit tests for pure helpers and explicit MANUAL verification steps where DOM/WebGL
can't be unit-tested under vitest-pool-workers.")

- [ ] **Step 2: Build-check the baseline before wiring**

Command (run from `F:\Git\deploy-on-cloudflare`, BEFORE editing — captures the baseline):
```
npm run build
```
Expected: the current state builds cleanly (`vite build` prints `✓ built in …`). If it already
fails, fix that first — do not start wiring on a broken build.

- [ ] **Step 3: Implement**

Replace the entire contents of `F:\Git\deploy-on-cloudflare\src\main.ts` with the COMPLETE
code below. Every call site matches the D15 signatures exactly; there is no dead/scratch code.

```ts
// src/main.ts — bootstrap: nickname screen, read ?room, connect Net (name in WS query),
// build the scene, run the rAF game loop, and route server messages to players/HUD/SFX.
import * as THREE from "three";
import {
  MAX_HP,
  INTERP_DELAY_MS,
  CLIENT_SEND_MS,
  EYE_HEIGHT,
  sanitizeRoom,
  sanitizeName,
} from "../worker/protocol";
import type {
  WelcomeMsg,
  SnapMsg,
  HitMsg,
  KillMsg,
  SpawnMsg,
  LeaveMsg,
  PlayerSnap,
} from "../worker/protocol";
import { Net } from "./net";
import { buildArena } from "./map";
import { buildOctree } from "./physics";
import { FpsControls } from "./controls";
import { LocalPlayer, RemotePlayer } from "./player";
import { wireShooting } from "./combat";
import { Hud } from "./hud";
import { Sfx } from "./audio";

// ---- nickname entry screen --------------------------------------------------

function showNicknameScreen(): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:14px;background:#111;color:#fff;font-family:monospace;z-index:100;";
    overlay.innerHTML =
      '<h1 style="margin:0">CF-FPS</h1>' +
      '<p style="opacity:.7;margin:0">Enter a nickname and press Play.</p>';
    const input = document.createElement("input");
    input.maxLength = 16;
    input.placeholder = "nickname";
    input.value = localStorage.getItem("cf-fps-name") ?? "";
    input.style.cssText = "font:16px monospace;padding:8px 10px;width:220px;text-align:center;";
    const btn = document.createElement("button");
    btn.textContent = "Play";
    btn.style.cssText = "font:16px monospace;padding:8px 22px;cursor:pointer;";
    overlay.appendChild(input);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
    input.focus();

    const submit = (): void => {
      const name = sanitizeName(input.value);
      localStorage.setItem("cf-fps-name", name);
      overlay.remove();
      resolve(name);
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  });
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const name = await showNicknameScreen();

  const params = new URLSearchParams(location.search);
  const room = sanitizeRoom(params.get("room") ?? undefined);

  // Renderer + canvas (#game from index.html).
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Scene + lights.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a7c0);
  scene.fog = new THREE.Fog(0x87a7c0, 40, 90);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(20, 40, 10);
  scene.add(sun);

  // Camera (rides the capsule top at EYE_HEIGHT).
  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  camera.position.set(0, EYE_HEIGHT, 0);

  // Arena geometry + collision octree.
  const arena = buildArena();
  scene.add(arena);
  const octree = buildOctree(arena);

  // Controls, HUD, SFX. LocalPlayer is created once we know our id (on welcome).
  const controls = new FpsControls(camera, renderer.domElement, octree);
  const hud = new Hud();
  const sfx = new Sfx();
  let local: LocalPlayer | undefined;

  // Reflect pointer-lock state into the HUD and unlock audio on first lock (user gesture).
  controls.onLockChange((locked: boolean) => {
    hud.setLocked(locked);
    if (locked) sfx.unlock();
  });

  // Click the canvas (while not locked) to engage pointer lock.
  renderer.domElement.addEventListener("click", () => {
    if (!controls.isLocked) controls.lock();
  });

  // Remote players registry + the latest snapshot's player list (kill-feed names + scoreboard).
  const remotes = new Map<number, RemotePlayer>();
  let myId = -1;

  function ensureRemote(ps: PlayerSnap): RemotePlayer {
    let rp = remotes.get(ps.id);
    if (rp === undefined) {
      rp = new RemotePlayer(ps.id, ps.name);
      scene.add(rp.group);
      remotes.set(ps.id, rp);
    }
    return rp;
  }

  // ---- networking (name travels in the WS URL query — D5) -------------------

  const net = new Net(room, name);

  net.on("welcome", (m: WelcomeMsg) => {
    myId = m.id;
    local = new LocalPlayer(myId);
    hud.setMyId(myId);
    for (const ps of m.players) {
      if (ps.id !== myId) ensureRemote(ps);
    }
  });

  net.on("snap", (m: SnapMsg) => {
    hud.setPlayers(m.players);
    for (const ps of m.players) {
      if (ps.id === myId) {
        hud.setHealth(ps.hp);
        // Reconcile local prediction against the server POSITION only (never rotation).
        if (local !== undefined) {
          const snapped = local.reconcile(controls.getPosition(), ps.p);
          if (snapped) controls.setPosition(snapped);
        }
      } else {
        const rp = ensureRemote(ps);
        rp.addSnapshot({ t: m.ts, p: ps.p, r: ps.r });
      }
    }
  });

  net.on("hit", (m: HitMsg) => {
    if (m.on === myId) hud.setHealth(m.hp);
    if (m.by === myId) {
      hud.flashHitMarker();
      sfx.hit();
    }
  });

  net.on("kill", (m: KillMsg) => {
    hud.addKill(m);
    if (m.on === myId) sfx.death();
  });

  net.on("spawn", (m: SpawnMsg) => {
    if (m.id === myId) {
      hud.setHealth(MAX_HP);
      controls.setPosition(m.p);
    }
  });

  net.on("leave", (m: LeaveMsg) => {
    const rp = remotes.get(m.id);
    if (rp !== undefined) {
      scene.remove(rp.group);
      rp.dispose();
      remotes.delete(m.id);
    }
  });

  // ---- shooting (single owner: combat.wireShooting — D15) -------------------

  wireShooting({
    camera,
    dom: renderer.domElement,
    getTargets: () => [...remotes.values()].map((rp) => rp.body),
    isLocked: () => controls.isLocked,
    nextSeq: () => (local ? local.nextSeq() : 0),
    send: (m) => net.send(m),
    onLocalShoot: (hit) => {
      sfx.shoot();
      if (hit) hud.flashHitMarker();
    },
  });

  // ---- resize --------------------------------------------------------------

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- game loop -----------------------------------------------------------

  let lastFrame = performance.now();
  let sendAccum = 0;

  function sendInputIfDue(accum: number, dtMs: number): number {
    const a = accum + dtMs;
    if (a >= CLIENT_SEND_MS && controls.isLocked && local !== undefined) {
      const msg = local.buildInput(
        controls.getPosition(),
        controls.getRotation(),
        controls.getVelocity(),
        Date.now(),
      );
      net.send(msg);
      return 0;
    }
    return a;
  }

  function frame(): void {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000); // clamp after tab-switches
    lastFrame = now;

    // Local predicted movement.
    controls.update(dt);

    // Send InMsg at CLIENT_SEND_MS cadence (NOT per frame) — exactly one cadence line.
    sendAccum = sendInputIfDue(sendAccum, dt * 1000);

    // Interpolate remote players ~INTERP_DELAY_MS in the past.
    const renderTime = Date.now() - INTERP_DELAY_MS;
    for (const rp of remotes.values()) rp.update(renderTime);

    // HUD upkeep (prune expired kill-feed lines).
    hud.renderKillFeed();

    renderer.render(scene, camera);
  }

  frame();
}

void main();
```

- [ ] **Step 4: Build the client, verify it compiles & bundles**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npm run build
```
Expected: `vite build` completes with `✓ built in …` and no TypeScript errors. Because
`main.ts` has no unit test, this build (which type-checks every call site against the real T11–
T16 exports) is the deterministic correctness gate. All call sites above already match the D15
signatures, so a clean build is expected with no further edits.

- [ ] **Step 5: Type-check**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npx tsc --noEmit
```
Expected: no output (exit 0).

- [ ] **Step: Manual verification** (3-tab multiplayer checklist)

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npm run dev
```
Then open `http://localhost:5173` in **three** separate browser tabs (or windows). In each tab:

1. **Nickname + room.** Each tab shows the nickname screen. Enter a DIFFERENT nickname per tab
   (e.g. `alpha`, `bravo`, `charlie`) and click Play. Leave the URL as-is for all three (all
   join the default `public` room). Confirm: clicking Play removes the nickname overlay and
   shows the 3D arena with the "Click to play" prompt.
2. **Pointer lock + audio unlock.** Click the canvas in tab `alpha`. Confirm the prompt
   disappears, the mouse controls the camera, and the FIRST shot (left-click) produces a sound
   (proves `Sfx.unlock()` fired on the `onLockChange(true)` gesture).
3. **Mutual visibility + movement + nicknames.** Move `alpha` with WASD and look around with
   the mouse. Switch to `bravo` and confirm `alpha`'s player mesh + nameplate showing the
   nickname `alpha` is visible and moves smoothly (interpolated ~120 ms behind). The nickname
   proves the name reached the server via the WS query (D5) and populated `PlayerSnap.name`.
   Repeat for `charlie`. All three should see the other two move with correct nicknames.
4. **Shooting reduces health.** Aim `alpha`'s crosshair at `bravo` and left-click. Confirm:
   `alpha` sees a red hit-marker flash and hears the hit blip; `bravo`'s health bar drops (and
   turns red below 30). Keep firing until `bravo` dies.
5. **Death / kill feed / respawn.** On `bravo`'s death: `bravo` hears the death blip and its
   health hits `0 / 100`; ALL three tabs show a kill-feed line `alpha fragged bravo` top-right
   that fades after ~5 s. After ~3 s (`RESPAWN_MS`) `bravo` respawns at a spawn point with full
   health and brief spawn protection (cannot be damaged immediately).
6. **Scoreboard (Tab).** Hold **Tab** in any tab. Confirm a centered scoreboard appears with
   all three players (real nicknames), sorted frags desc (then fewer deaths, then lower id),
   the local player's row highlighted yellow; release Tab to hide it; focus does not leave the
   canvas while held.
7. **Leave.** Close the `charlie` tab. Within a moment (on a `leave` event, or the DO's idle
   drop which also broadcasts `leave` — D10), `alpha` and `bravo` see `charlie`'s mesh +
   nameplate removed, and `charlie` disappears from the scoreboard.
8. **Idle/empty (optional).** Close all tabs and confirm the dev console shows no errors — the
   DO stops its `setInterval` tick when empty (validated in DO tests; here just confirm no
   runaway logging).

If any step fails, debug the corresponding module (controls/player/net/combat/hud) — `main.ts`
only routes; the per-module behavior is owned by T11–T16.

- [ ] **Step 6: Commit**
```
git add src/main.ts
git commit -m "T17: wire up nickname screen, room, Net handlers (name via WS query), wireShooting, and rAF game loop in main.ts"
```

---

### Task T18: README & multi-tab test checklist (`README.md`)

**Files:**
- Create: `F:\Git\deploy-on-cloudflare\README.md`
- (Docs-only task — no automated test. The "verification" is that every command quoted in the
  README actually exists in `package.json` scripts / `wrangler.jsonc`, checked in Step 2.)

- [ ] **Step 1: Write the failing test** — N/A (documentation task)

There is no automated test for a README. The correctness gate is Step 2: every command and
file path the README references must match the real project (`package.json` scripts,
`wrangler.jsonc` name, default room behavior). That check is performed before committing.

- [ ] **Step 2: Verify the commands the README will reference actually exist**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npm run
```
Expected: the script list includes exactly `dev`, `build`, `deploy`, `test`, `test:watch`,
`cf-typegen` (the names fixed by the contract's `package.json` section; note `test` is
`vitest run --passWithNoTests` per D1, but `npm test` is the invocation the README quotes).
Also confirm the worker name with:
```
npm pkg get name
```
(and open `wrangler.jsonc` to confirm `"name": "cf-fps"`). The deploy URL the README quotes
(`https://cf-fps.<your-subdomain>.workers.dev`) is derived from that `name`. If `name` differs,
update the README URL to match before committing.

- [ ] **Step 3: Implement**

Create `F:\Git\deploy-on-cloudflare\README.md` with the COMPLETE contents below.

````md
# CF-FPS — a free 3D multiplayer FPS on Cloudflare

A browser-based, low-poly first-person **deathmatch** that runs **entirely on Cloudflare's
free tier**. Players join a shared arena (or a private room by code), run/jump/look around,
and fight with a hitscan rifle. Health, damage, deaths, respawns, and score are decided by an
authoritative server.

The whole thing is **one Cloudflare Workers project**:

- a **Hono** Worker serves the **Three.js** client as static assets, and
- forwards each `/ws/:room` WebSocket to a **Durable Object** (`GameRoom`) that is the
  authoritative game server (20 Hz tick, combat validation, scoring).

Netcode: client-predicted movement, server-authoritative combat, remote-player interpolation
(~120 ms behind), client input at 15 Hz, server snapshots at 20 Hz. Your chosen nickname
travels to the server in the WebSocket URL query, so nameplates, the scoreboard, and the kill
feed all show real names.

## Controls

- **Mouse** — look (click the canvas to lock the pointer)
- **WASD** — move
- **Space** — jump
- **Left click** — shoot
- **Tab** (hold) — scoreboard

## Prerequisites

- **Node.js 20+** and npm.
- A free **Cloudflare account** — only needed when you want to *deploy*. Local development
  and tests need **no** account.

## Install

```sh
npm install
```

## Run locally (multiplayer in multiple tabs)

```sh
npm run dev
```

This starts Vite at **http://localhost:5173**, serving the client, the Worker, and the
Durable Object together in-process (real `workerd` runtime via `@cloudflare/vite-plugin`).

To test multiplayer locally, open **http://localhost:5173 in 2–3 browser tabs**, enter a
different nickname in each, and click **Play**. All tabs join the default `public` room and
should see each other move, shoot, take damage, die, and respawn.

**Private room:** add `?room=<code>` to the URL, e.g.
**http://localhost:5173/?room=mygame** — only tabs using the same code share a room. Room
codes are sanitized to `[a-z0-9_-]`, max 24 chars; an empty/invalid code falls back to
`public`.

## Test

```sh
npm test
```

Runs the unit and Durable-Object test suites once with **Vitest 4** (the Durable-Object and
Worker-routing tests run under `@cloudflare/vitest-pool-workers` against the real Workers
runtime). For a watch loop:

```sh
npm run test:watch
```

The suites cover the shared protocol, the server validation/clamp helpers, the `GameRoom`
Durable Object (WebSocket join/leave, tick snapshots, combat, rate-limit/size-cap), the Hono
worker routing, and the client's pure helpers (interpolation, net URL/backoff, prediction,
combat hit-detection, HUD scoreboard/kill-feed). DOM/WebGL behavior is verified manually (see
the checklist below).

## Deploy (optional — when you're ready to go live)

> You only need this section if you want a public URL. Everything above works offline.

1. **Log in** to Cloudflare once (opens a browser to authorize Wrangler):
   ```sh
   npx wrangler login
   ```
2. **Deploy** (builds the client with Vite, then publishes the Worker + Durable Object; the
   `v1` SQLite DO migration auto-applies on first deploy):
   ```sh
   npm run deploy
   ```
3. Wrangler prints your live URL, which looks like:
   ```
   https://cf-fps.<your-subdomain>.workers.dev
   ```
   Open it (and share it) — same multi-tab play as local, now over the internet.

To remove it later: `npx wrangler delete`.

## Free-tier notes (the honest cost model)

This project is designed to fit the **Workers Free plan** (SQLite-backed Durable Objects).
The design makes specific choices so it stays free:

- **The 20 Hz tick uses `setInterval`, never alarms.** Alarm invocations bill as DO
  *requests*; a 20 Hz alarm tick would blow the 100,000 requests/day cap in ~1.4 hours. A
  `setInterval` tick runs inside the DO's active *duration* (GB-s) instead.
- **Outbound broadcasts are free.** Broadcasting 20 Hz snapshots to every player in a room
  costs **0 requests** — only duration + bandwidth — so the server broadcasts generously.
- **Request budget ≈ player-hours.** Inbound WS messages are billed 20:1. At the **15 Hz**
  client send rate, one player ≈ 3,600 requests/hour, so a 100k/day budget ≈ **~37
  player-hours/day** (e.g. four players for ~7–9 hours). Plenty for a hobby/demo; production
  would need the paid plan.
- **Duration budget ≈ one always-on room.** A continuously active room ≈ **~85%** of the
  13,000 GB-s/day duration cap. So the room **stops its tick loop and closes sockets when it
  empties** (the DO then evicts and stops billing), and disconnects **idle** players
  (~30 s, which also broadcasts a `leave` so other clients clean up). Several short-lived
  rooms under budget are fine; many *simultaneous* always-on rooms would exceed the cap.
- **Static assets are free & unlimited.** The Three.js client bundle is served from the free
  static-asset layer (static-asset hits don't count against Workers requests).

Cost guards baked in: `setInterval` tick · stop-on-empty · idle timeout · 15 Hz client send ·
per-connection rate limiting · app-level message-size cap · `setWebSocketAutoResponse` pings.

## Project layout

```
index.html        # client entry (mounts <canvas id="game"> + HUD overlay)
src/              # Three.js client (TypeScript):
                  #   main, net, net-helpers, controls, physics, player,
                  #   combat, map, hud, audio, interp
worker/
  index.ts        # Hono app: /api/health, /ws/:room -> GameRoom; exports GameRoom; Env type
  room.ts         # GameRoom Durable Object (authoritative, 20 Hz setInterval tick)
  validate.ts     # combat validation (fire-rate, range, aim-cone) — pure
  protocol.ts     # shared wire types + tunables (imported by client AND worker)
test/             # Vitest 4 + @cloudflare/vitest-pool-workers suites
wrangler.jsonc · vite.config.ts · vitest.config.ts · tsconfig.json
```

## Manual multi-tab acceptance checklist

Run `npm run dev`, open **http://localhost:5173 in 3 tabs**, give each a different nickname:

1. Each tab loads the nickname screen → Play → 3D arena + "Click to play" prompt.
2. Click the canvas: pointer locks, prompt hides, first shot plays a sound (audio unlocked).
3. All three players see each other move smoothly, with nameplates showing real nicknames.
4. Shooting another player flashes a hit marker, plays a hit blip, and drops their health bar.
5. A kill plays a death blip, shows `A fragged B` in the top-right kill feed (fades ~5 s),
   and the victim respawns at full health (~3 s later) with brief spawn protection.
6. Hold **Tab**: scoreboard appears, sorted by frags (then fewer deaths, then lower id), own
   row highlighted; release to hide.
7. Close a tab: the other tabs remove that player's mesh, nameplate, and scoreboard row.

## License

MIT (or your choice).
````

- [ ] **Step 4: Verify the README renders and its commands match the project**

Command (run from `F:\Git\deploy-on-cloudflare`):
```
npm run build
```
Expected: still `✓ built in …` (sanity that the documented `npm run build` works). Then
eyeball `README.md` in your editor's Markdown preview and confirm: the fenced code blocks
render, the command names match the `npm run` output from Step 2, and the deploy URL host
matches the `name` in `wrangler.jsonc` (`cf-fps` → `cf-fps.<subdomain>.workers.dev`).

- [ ] **Step 5: Commit**
```
git add README.md
git commit -m "T18: add README (overview, install, dev/test, optional deploy, free-tier notes, multi-tab checklist)"
```

