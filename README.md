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

## 3D Assets

Player models, the first-person weapon, and arena props (crates, barrels) are CC0-licensed
GLB files served as static assets from `public/models/`. See
[`public/models/CREDITS.md`](public/models/CREDITS.md) for attribution details.

- **Animated players** — remote players are GLTF characters driven by `AnimationMixer`
  (Idle/Running blend, shoot cue). The invisible box proxy is preserved for hit-detection so
  combat is unchanged from v1.
- **First-person gun** — a viewmodel attached to the camera with recoil and muzzle-flash
  point-light on fire.
- **Smart respawn** — on death a "Fragged by X" overlay appears with a 3→2→1 countdown.
  Respawn placement uses `chooseSpawn`: the spawn point that maximises the distance to the
  nearest living enemy, so you don't land on top of your killer.

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

## Self-host on a dedicated server (Dokploy)

The same repo also runs as a plain **Node.js** process on any Docker host (e.g.
[Dokploy](https://dokploy.com)), without Cloudflare. The game logic is shared verbatim between
both targets (`worker/game-core.ts`); only the transport differs — the Node host
(`server/index.ts`) uses `@hono/node-server` + `ws` instead of the Durable Object. The Cloudflare
deploy above keeps working unchanged.

**Run the Node target locally:**

```sh
npm run build:node                  # build:client (-> dist/client) + build:server (-> dist/server)
PORT=8080 npm start                 # node dist/server/index.js   (PowerShell: $env:PORT=8080; npm start)
curl http://localhost:8080/api/health   # -> {"ok":true}
```

Then open **http://localhost:8080 in 2–3 tabs** and run the manual checklist below — same play as
local Vite, just served by Node.

**Container:** the multi-stage `Dockerfile` builds the client and bundles the server into a slim
`node:22` image (port `8080`, healthcheck `/api/health`, no volume — room state is in-memory and
ephemeral, exactly like the DO). A GitHub Actions workflow
(`.github/workflows/docker-image.yml`) builds and pushes it to **GHCR** on every push to `master`.

**Deploy on Dokploy:**

1. Create Project → **Application** → Provider **Docker (image)**.
2. Image `ghcr.io/<owner>/<repo>:latest` (add a registry credential if the package is private).
3. Env: `PORT=8080`.
4. Domains: add your domain → container port **8080** → enable HTTPS/Let's Encrypt (Traefik
   proxies the WebSocket upgrade automatically — it shares the origin/port).
5. **Replicas = 1** — rooms live in one process's memory; multiple replicas would split a room's
   players across processes. (Scaling out later needs sticky-by-room routing.)
6. Health check path `/api/health`. No persistent volume.

## License

MIT (or your choice).
