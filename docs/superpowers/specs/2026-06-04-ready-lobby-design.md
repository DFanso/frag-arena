# Design: Ready-up Lobby + Match Lifecycle

**Date:** 2026-06-04
**Status:** Approved — to build
**Owner:** DFanso

## Goal

Matches should start only when **every connected player has clicked Ready** (no countdown
fallback). Players who join while a match is running **wait in the lobby** until the next match.

## Decisions (confirmed)

- Start rule: **100% ready, no fallback.** Solo = you ready → it starts.
- Mid-match join: **wait in lobby**, spawn only when the next match starts.

## Server (`worker/room.ts`)

- `PlayerRec` gains `ready: boolean` and `inMatch: boolean`.
- Room phase tracked by `matchActive: boolean`.
- **Join:** send `welcome`; `ready=false`, `inMatch=false`; do NOT spawn, do NOT auto-start.
  Broadcast `lobby`. Start the loop (keeps the DO resident while ≥1 player is connected).
- **`ready` message:** if `!matchActive`, set `rec.ready`; broadcast `lobby`; if all connected
  players are ready (and ≥1) → `startMatch()`.
- **`startMatch`:** `matchActive=true`; for every player `ready=false`, `inMatch=true`, spawn;
  broadcast `matchstart`.
- **`loopTick`:** when `!matchActive`, only run idle-drop + keepalive (no snaps). When active,
  only `inMatch` players appear in snaps, respawn, and the match-end check.
- **`endMatch`:** `matchActive=false`; every player `inMatch=false`, `ready=false`; broadcast
  `matchover` then `lobby`. **Keep the loop running** while players remain (so in-memory state
  survives — fixes the hibernation-eviction caveat); stop only when the room empties.
- **Combat:** only `matchActive` + `inMatch` shooters/targets.
- Replace the `playagain` message with `ready` (the results screen's button readies up).

## Protocol (`worker/protocol.ts`)

- `ReadyMsg { t: "ready"; ready: boolean }` (client→server).
- `LobbyPlayer { id; name; ready }`, `LobbyMsg { t: "lobby"; players: LobbyPlayer[]; matchActive: boolean }`
  (server→client), sent on join / ready change / leave / match end.
- Remove `PlayAgainMsg`.

## Client (`src/main.ts` + lobby UI)

- After `welcome` → show a **lobby overlay**: roster with ready ticks, a **Ready** button
  (toggles), and a "waiting for the current match…" note when `matchActive` and you're a late joiner.
- `lobby` msg → re-render the roster.
- `matchstart` → hide lobby, reveal the game ("click to play"); spawn via the existing `SpawnMsg`.
- `matchover` → show the results board; its button → return to the lobby overlay (ready up again).
- The local player is not spawned/locked until a match starts.

## Infra note

Keeping the loop running while any player is connected means the DO is billed for the
session (lobby + match), and evicts only when the room empties — which keeps in-memory state
consistent. This is the right trade for correctness; idle (empty) rooms still cost nothing.

## Testing

`tsc` + `vite build` + Vitest. Update the lifecycle tests in `test/room.test.ts` /
`test/match.test.ts`: join no longer auto-starts; `ready` gates `startMatch`; mid-match joiners
stay out of snaps until the next match; `endMatch` resets ready/inMatch and keeps the loop while
players remain. Browser walk-through of the full load → lobby → ready → match → results → lobby loop.
