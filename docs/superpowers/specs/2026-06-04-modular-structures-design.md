# Design: Modular Structures (Castle Kit)

**Date:** 2026-06-04
**Status:** Built
**Owner:** DFanso

## Overview

Rebuild the arena structures' **visuals** from CC0 modular **stone/castle kit** pieces (Kenney
Castle Kit 2.0, battlemented walls/doors/columns/broken walls) instead of stone-textured boxes.
**Collision is unchanged** — the invisible solid boxes stay; only the visual layer is reassembled
from kit pieces. Every kit piece falls back to a stone box if its model is missing.

## Decisions

- Kit: **stone/castle** (Kenney Castle Kit 2.0, CC0 — one consistent kit, 1×1 grid).
- Scope: **all structures** (tower, broken houses, cover-bases, lane walls, ruins).

## Kit pieces (CC0, `public/models/kit_*.glb`)

- `kit_wall` — battlemented straight wall (main building block).
- `kit_broken` — half/damaged wall (ruins + collapsed house sides).
- `kit_column` — wall-pillar (tower corner turrets).
- `kit_door`, `kit_floor` (stone cube), `kit_stairs` (small) — acquired; doorways are done as
  wall-run gaps and decks/ramps stay stone boxes, so these are kept for future use.

## Approach

Probed each piece's fitted bounds at runtime to learn proportions/orientation. The walls are
battlemented panels (~1×1.31 native). Composition helpers in `map.ts`:

- `makeKit(model, tileW)` — fit a piece to a tile width, measure its bounds, and `place(x, baseY,
  z, rotY)` base-anchored (bottom at `baseY`). `WALL_TILE = 2.6` → walls ≈ 3.4 tall.
- `wallEdge(kit, x1,z1, x2,z2, baseY, skipMid?)` — tile wall pieces along an axis-aligned edge,
  auto-rotated for X vs Z runs; `skipMid` leaves a center gap (doorway).
- `ring(kit, cx,cz, w,d, baseY, door?)` — a battlemented walled rectangle with an optional door gap.

## Rebuild (visual; collision boxes preserved exactly)

- **Central tower:** ground `ring` (gateway facing the south ramp) + stone deck, upper `ring` +
  stone deck, `kit_column` turrets at the 4 corners; ramps stay stone boxes.
- **Broken houses:** `ring` with a doorway gap on the entrance and `kit_broken` on the collapsed
  side. **Collision keeps the doorway gap + low collapsed wall** so houses stay enterable.
- **Cover-bases:** L of `kit_wall` (crates kept). **Lane walls:** `wall_edge` runs. **Ruins:**
  `kit_broken` fragments. **Pillars:** stone columns (match the 6-tall collision exactly).
- Ground (grass texture), perimeter fences, props (crates/containers/rocks/barrels/logs), trees,
  and foliage are unchanged from the nature re-skin.

## Testing

`tsc --noEmit` + `vite build` + browser walkthrough (aerial + ground). Collision unchanged
(152 unit tests stay green; the structure collision boxes are the same `collOnly` boxes as before,
with the house doorway gap restored). Verified visually: the tower reads as a battlemented keep,
houses/cover-bases as stone enclosures, ruins as broken walls — all on the grassy field.

## Non-goals

Decks/ramps/pillars are still stone boxes (the floor cube + tiny stairs pieces don't tile as
cleanly); the perimeter stays as fences (kit-walling 100 u/side would be hundreds of pieces).
