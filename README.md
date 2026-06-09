# frag-arena — a free 3D multiplayer FPS

A browser-based, low-poly first-person **deathmatch**. Players join a shared arena (or a
private room by code), run/jump/sprint/crouch, climb towers, parachute, ride ziplines, and
fight with a rifle, sniper, grenades and a tower-mounted rocket launcher. Health, armor,
damage, deaths, respawns, and score are decided by an **authoritative server**.

It runs **two ways from one codebase**:

- **Cloudflare's free tier** — a **Hono** Worker serves the **Three.js** client as static
  assets and forwards each `/ws/:room` WebSocket to a **Durable Object** (`GameRoom`) that is
  the authoritative server.
- **Self-hosted Node / Docker** (e.g. [Dokploy](https://dokploy.com)) — a plain Node process
  (`@hono/node-server` + `ws`) hosts the same game server.

The game logic is shared **verbatim** between both targets (`worker/game-core.ts`); only the
transport differs.

> Live demo: **https://fps.dfanso.dev**

Netcode: client-predicted movement, server-authoritative combat (with server-verified
headshots), remote-player interpolation (~45 ms behind), client input at 60 Hz, server
snapshots at 64 Hz. Your chosen nickname travels to the server in the WebSocket URL query, so
nameplates, the scoreboard, and the kill feed all show real names.

## Features

**Arsenal** — full-auto **rifle**, semi-auto scoped **sniper** (right-click ADS + scope
overlay), throwable **grenades** (limited; refill from pickups), and a **rocket launcher**
claimed from a tower. Per-weapon ammo with **reload** (R / auto), and a client fire-rate gate
kept in sync with the server.

**Movement** — sprint, **crouch** (hold C/Ctrl — smaller hitbox), jump, **ladders** up the
towers, **base-jump parachute** (E) from a height, **ziplines** (F) between tower tops, and
**fall damage** (with an out-of-bounds kill floor). **Spring boots** pickup for super-jumps.

**Pickups** — ammo crates, grenade crates, **health** syringes (heal to full), **armor**
(soaks damage first), and spring boots. All server-authoritative with timed respawns.

**Hazards & feedback** — shoot **explosive barrels** (rapid streak detonates them) for splash
kills, **blood** hit FX, a **damage-direction indicator** (arc points at your attacker),
damage vignette, hit markers, kill feed, and a ready-up **lobby** (a match starts only when
everyone is ready).

**First person** — a viewmodel with the held weapon **and gloved arms gripping it**, recoil,
and a muzzle-flash light. Remote players are animated GLTF characters (idle/run/shoot) with
nameplates + health bars.

## Controls

- **Mouse** — look (click the canvas to lock the pointer); **Right click** — aim down sights
- **WASD** — move · **Shift** — sprint · **C / Ctrl** — crouch · **Space** — jump
- **Hold left click** — fire (rifle is full-auto; sniper is one shot per click)
- **R** — reload · **1 / 2 / 3** or **mouse wheel** — switch weapon · **G** — throw grenade
- **E** — open parachute (when high enough) · **F** — ride a zipline (near a tower top)
- **Tab** (hold) — scoreboard

## Prerequisites

- **Node.js 20+** and npm.
- A free **Cloudflare account** — only needed if you want to *deploy to Cloudflare*. Local
  development, tests, and the Node/Docker target need **no** Cloudflare account.

## Install

```sh
git clone https://github.com/DFanso/frag-arena.git
cd frag-arena
npm install
```

## Run locally (multiplayer in multiple tabs)

```sh
npm run dev
```

This starts Vite at **http://localhost:5173**, serving the client, the Worker, and the
Durable Object together in-process (real `workerd` runtime via `@cloudflare/vite-plugin`).

To test multiplayer locally, open **http://localhost:5173 in 2–3 browser tabs**, enter a
different nickname in each, and click **Play**. All tabs join the default `public` room; in
the lobby, click **Ready** in each — the match starts once everyone is ready.

**Private room:** add `?room=<code>` to the URL, e.g.
**http://localhost:5173/?room=mygame** — only tabs using the same code share a room. Room
codes are sanitized to `[a-z0-9_-]`, max 24 chars; an empty/invalid code falls back to
`public`.

## Test

```sh
npm test
```

Runs the unit and Durable-Object suites once with **Vitest 4** (the Durable-Object and
Worker-routing tests run under `@cloudflare/vitest-pool-workers` against the real Workers
runtime). For a watch loop: `npm run test:watch`.

The suites cover the shared protocol, server validation/clamp/headshot helpers, the
`GameRoom` Durable Object (join/leave, tick snapshots, combat, ammo/pickups, barrels,
fall/OOB, rate-limit/size-cap), the Hono routing, and the client's pure helpers
(interpolation, prediction, combat hit-detection, fall damage, damage-direction angle, HUD).
DOM/WebGL behavior is verified manually (see the checklist below). **CI**
(`.github/workflows/ci.yml`) runs the typecheck + full test suite on every push.

## Deploy to Cloudflare (optional)

> You only need this if you want a public URL on Cloudflare. Everything above works offline,
> and you can self-host instead (next section).

1. **Log in** to Cloudflare once:
   ```sh
   npx wrangler login
   ```
2. **Deploy** (builds the client with Vite, then publishes the Worker + Durable Object; the
   SQLite DO migration auto-applies on first deploy):
   ```sh
   npm run deploy
   ```
3. Wrangler prints your live URL, e.g. `https://frag-arena.<your-subdomain>.workers.dev`.

To remove it later: `npx wrangler delete`.

### Free-tier notes (the honest cost model)

The Cloudflare target is designed to fit the **Workers Free plan** (SQLite-backed Durable
Objects):

- **The tick uses `setInterval`, never alarms.** Alarm invocations bill as DO *requests*; a
  high-frequency alarm tick would blow the 100,000 requests/day cap in hours. A `setInterval`
  tick runs inside the DO's active *duration* (GB-s) instead, so the tick frequency doesn't
  cost requests.
- **Outbound broadcasts are free.** Broadcasting snapshots to every player in a room costs
  **0 requests** — only duration + bandwidth.
- **Request budget ≈ player-hours.** Inbound WS messages are billed 20:1. The netcode is
  tuned for **self-hosted** low latency (**60 Hz** client send), which on Cloudflare's free
  tier means ~10,800 requests/hour/player, so a 100k/day budget ≈ **~9 player-hours/day**.
  Fine for a small demo; for more headroom on Cloudflare, lower `CLIENT_SEND_HZ`, or
  self-host (no per-request billing).
- **Duration budget ≈ one always-on room.** So the room **stops its tick loop and closes
  sockets when it empties**, and disconnects **idle** players (~30 s, broadcasting a `leave`).
- **Static assets are free & unlimited.**

Cost guards: `setInterval` tick · stop-on-empty · idle timeout · per-connection rate limiting
· app-level message-size cap · `setWebSocketAutoResponse` pings.

## Self-host on a dedicated server (Node / Docker / Dokploy)

The same repo runs as a plain **Node.js** process on any Docker host, without Cloudflare —
no per-request billing, so the high tick rate is free.

**Run the Node target locally:**

```sh
npm run build:node                  # build:client (-> dist/client) + build:server (-> dist/server)
PORT=8080 npm start                 # node dist/server/index.js   (PowerShell: $env:PORT=8080; npm start)
curl http://localhost:8080/api/health   # -> {"ok":true}
```

Then open **http://localhost:8080 in 2–3 tabs** — same play as local Vite, served by Node.

**Container:** the multi-stage `Dockerfile` builds the client and bundles the server into a
slim `node:22` image (port `8080`, healthcheck `/api/health`, no volume — room state is
in-memory and ephemeral, exactly like the DO). A GitHub Actions workflow
(`.github/workflows/docker-image.yml`) builds and pushes it to **GHCR** on every push to
`master`.

**Deploy on Dokploy:**

1. Create Project → **Application** → Provider **Docker (image)**.
2. Image `ghcr.io/dfanso/frag-arena:latest` (add a registry credential if the package is private).
3. Env: `PORT=8080`.
4. Domains: add your domain → container port **8080** → enable HTTPS/Let's Encrypt (Traefik
   proxies the WebSocket upgrade automatically — it shares the origin/port).
5. **Replicas = 1** — rooms live in one process's memory; multiple replicas would split a
   room's players across processes. (Scaling out later needs sticky-by-room routing.)
6. Health check path `/api/health`. No persistent volume.

## 3D Assets

Player models, the first-person weapon + arms, and arena props are CC0-licensed GLB files
served as static assets from `public/models/`. See
[`public/models/CREDITS.md`](public/models/CREDITS.md) for attribution.

## Project layout

```
index.html        # client entry (mounts <canvas id="game"> + HUD overlay)
src/              # Three.js client (TypeScript):
                  #   main, net, net-helpers, controls, physics, player, anim
                  #   combat, weapons, projectiles, viewmodel, models
                  #   map, pickups, barrels, blood, doors
                  #   hud, health-ui, death-ui, match-ui, colors, audio, interp, assets
worker/
  index.ts        # Hono app: /api/health, /ws/:room -> GameRoom; exports GameRoom; Env type
  game-core.ts    # transport-agnostic authoritative game server (shared by DO + Node)
  room.ts         # GameRoom Durable Object wrapper (64 Hz setInterval tick)
  validate.ts     # combat validation (fire-rate, range, aim, headshot) — pure
  match.ts        # match/scoreboard helpers — pure
  protocol.ts     # shared wire types + tunables (imported by client AND server)
server/
  index.ts        # Node host: @hono/node-server + ws, wraps game-core
test/             # Vitest 4 + @cloudflare/vitest-pool-workers suites
Dockerfile · .github/workflows/{ci,docker-image}.yml
wrangler.jsonc · vite.config*.ts · vitest.config.ts · tsconfig*.json
```

## Manual multi-tab acceptance checklist

Run `npm run dev`, open **http://localhost:5173 in 3 tabs**, give each a different nickname,
and **Ready** in each to start:

1. Each tab loads the nickname screen → Play → lobby → (all ready) → 3D arena.
2. Click the canvas: pointer locks, first shot plays a sound (audio unlocked).
3. All players see each other move smoothly, with nameplates showing real nicknames.
4. Shooting another player flashes a hit marker, plays a blip, and drops their health bar;
   a headshot does extra damage (server-verified).
5. A kill shows `A fragged B` in the kill feed (fades ~5 s); the victim respawns at full
   health (~3 s) with brief spawn protection.
6. Walk over pickups (ammo/health/armor/grenade/spring) and watch the HUD update; climb a
   tower, grab the rocket launcher, parachute (E) or zipline (F) off the top.
7. Hold **Tab**: scoreboard sorted by frags; close a tab → others remove that player.

## License

MIT (or your choice).
