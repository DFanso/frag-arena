# Design: Rooms UI + Match Lifecycle

**Date:** 2026-06-04
**Status:** Approved
**Owner:** DFanso
**Builds on:** the shipped FPS (v1 + v1.1 + polish). See prior specs in this folder.

## 1. Overview

Add a room create/join UI and a full match lifecycle (5-minute timed matches, end on time
or 25-frag limit, an end-of-match results board ranking the best players, and a Play-again
restart). The backend already supports per-room isolation via `GameRoom.getByName(code)`; this
spec adds the *UI* for rooms and the *match state machine* in the Durable Object plus the small
protocol messages to drive it.

## 2. Decisions (locked)

- Match length: **5 minutes** (`MATCH_DURATION_MS = 300_000`).
- End condition: **time OR frag limit, whichever first** (`FRAG_LIMIT = 25`); most frags wins.
- Post-match: **results board stays until "Play again"** (a player click starts the next match).
- Rooms: client UI only; backend room routing already exists (`?room=CODE`).

## 3. Rooms UI (client only — no backend change)

The nickname screen becomes a small menu returning `{ name, room }`:
- **Quick Play** → `room = "public"` (the shared arena).
- **Create Private Room** → generate a short random code (e.g. 5 chars base36), join it, and show
  a **Copy link** button for `${location.origin}/?room=CODE`.
- **Join Room** → a code input → join `room = sanitizeRoom(code)`.

`main()` connects with the chosen room (`new Net(room, name)`). The room still maps to its own DO
via the existing `?room=`/`getByName` path. `sanitizeRoom` (already in protocol) cleans codes.

## 4. Match lifecycle (authoritative in `GameRoom`)

States: `PLAYING → OVER → (Play again) → PLAYING`. Room-level fields: `matchEndsAt: number`
(server epoch ms; 0 = no match), `matchOver: boolean`.

- **startMatch()**: reset every player's `frags`/`deaths` to 0 and `spawn()` them (hp/pos/protection
  reset); set `matchEndsAt = Date.now() + MATCH_DURATION_MS`; `matchOver = false`; broadcast
  `matchstart`; `startLoop()`.
- **addPlayer()**: add the player; if `matchOver || matchEndsAt === 0` (no active match) →
  `startMatch()` (resets all, including the joiner); else just join the ongoing match. The
  `welcome` carries the current `matchEndsAt` + `fragLimit`.
- **loopTick()**: after the existing respawn/idle/snapshot work, if `!matchOver` and
  `matchOutcome(now, matchEndsAt, maxFrags, FRAG_LIMIT)` is true → `endMatch()`.
- **endMatch()**: `matchOver = true`; build `standings = rankPlayers(players)`; broadcast
  `matchover { standings }`; **stop the tick loop** (`clearInterval`) so an idle results screen
  accrues no free-tier duration. Sockets stay open to show results.
- **playagain message** (client→server) while `OVER` → `startMatch()`.
- A new player joining during `OVER` triggers `startMatch()` (late join restarts).

Free-tier: the loop runs only during `PLAYING`; `OVER` is idle (no ticks). Empty room still
evicts via the existing `stopLoopIfEmpty`/`webSocketClose` path.

## 5. Protocol additions (small, additive — no breaking changes)

```ts
// constants
export const MATCH_DURATION_MS = 300_000;
export const FRAG_LIMIT = 25;

// WelcomeMsg gains:  matchEndsAt: number; fragLimit: number;

export interface Standing { id: number; name: string; frags: number; deaths: number; }
export interface MatchStartMsg { t: "matchstart"; endsAt: number; fragLimit: number; }
export interface MatchOverMsg  { t: "matchover";  standings: Standing[]; }
// ServerMsg |= MatchStartMsg | MatchOverMsg

export interface PlayAgainMsg { t: "playagain"; }
// ClientMsg |= PlayAgainMsg
```

**Clock-skew-free timer:** the client never trusts its own clock for the countdown. It computes
`remaining = matchEndsAt − latestSnap.ts` (both are server-clock values; `latestSnap.ts` is the
`ts` of the most recent `snap`). During `OVER` (no snaps) the timer just shows `0:00`/hidden.

## 6. Pure logic (worker/match.ts — no deps, unit-tested)

```ts
import type { Standing } from "./protocol";
export function matchOutcome(now: number, endsAt: number, maxFrags: number, fragLimit: number): boolean;
//   -> now >= endsAt || maxFrags >= fragLimit
export function rankPlayers(players: Standing[]): Standing[];
//   -> sorted: frags desc, then deaths asc, then id asc (stable, returns a new array)
```

## 7. Client UI

- **Match timer** (`hud.ts`): top-center `M:SS`, turns red under 30 s, hidden when no match.
  Fed each frame with `matchEndsAt − latestSnapTs`. Pure `formatClock(ms): string` helper
  (three/DOM-free, unit-tested).
- **Results overlay** (`hud.ts`): `showResults(standings, myId, onPlayAgain)` / `hideResults()`.
  Full-screen ranked list — rank, per-player color swatch (`playerColor(id)`), name, `frags/deaths`,
  winner highlighted, your own row emphasized — plus a **Play again** button (`pointer-events:auto`)
  that calls `onPlayAgain`. Shown on `matchover`, hidden on `matchstart`.
- On `matchover`, `main` calls `controls.unlock()` (new passthrough to PointerLockControls) so the
  cursor is free to click **Play again**.

## 8. Data flow

Join → `welcome` (carries `matchEndsAt`+`fragLimit`) → play; timer counts down from
`matchEndsAt − snap.ts`. Time/frag limit hit → server `endMatch` → `matchover` → client shows
results + unlocks pointer. Click **Play again** → `playagain` → server `startMatch` → `matchstart`
→ client hides results; new match begins (scores reset, everyone respawns).

## 9. Error handling

- `playagain` while `PLAYING` is ignored (only acts in `OVER`).
- Late joiner during `PLAYING` gets the correct remaining time via `welcome.matchEndsAt`.
- Malformed `playagain` handled by the existing decode guard.
- Empty `OVER` room evicts normally (no ticks running anyway).

## 10. Testing

- **Pure (vitest workers pool):** `matchOutcome` (time end, frag-limit end, neither), `rankPlayers`
  (frags desc / deaths asc / id tiebreak, immutability), `formatClock` (`5:00`, `0:09`, `0:00`, clamp).
- **DO (vitest):** match starts on first join (welcome has `matchEndsAt`+`fragLimit`); reaching the
  frag limit ends the match and broadcasts sorted `matchover`; `playagain` while over resets
  scores + broadcasts `matchstart`; a join during `OVER` restarts.
- **Build + manual multi-tab:** create/join a room via link, watch the timer, end a match (lower
  `FRAG_LIMIT` locally if needed to test fast), see the results board + winner, Play again.

## 11. File map

- New: `worker/match.ts`, `test/match.test.ts`, `src/match-ui.ts` (`formatClock`), `test/match-ui.test.ts`.
- Changed: `worker/protocol.ts` (consts/messages), `worker/room.ts` (match state machine),
  `src/main.ts` (room menu wiring, match handlers, timer feed, unlock-on-over),
  `src/hud.ts` (match timer + results overlay), `test/room.test.ts` (match DO tests).

## 12. Non-goals (YAGNI)

No teams, no map rotation between matches, no persistent leaderboards/accounts, no spectator mode,
no lobby/ready-up countdown before a match (matches start immediately on join/Play-again).
