# Design: Map Expansion + Richer Environment

**Date:** 2026-06-04
**Status:** Approved
**Owner:** DFanso

## Overview

Grow the arena from 60×60 to **100×100** and replace the sparse layout with a **structured
arena** (central tower, quadrant cover-bases, mid platforms, pillars, lane walls) dressed with
reused CC0 props (crate, barrel) plus new CC0 props (container, rock, tree). Collision keeps the
existing `{collision, visual}` split — structures are solid; small decor is visual-only. No
netcode/protocol behavior changes beyond more spawn points.

## Layout (numbers are world units; ground centered at origin)

- **Arena:** 100×100 ground, 4 perimeter walls height 8, thickness 1.
- **Central tower (solid):** lower platform 16×3×16 (top y=3) + upper deck 8×3×8 (top y=6),
  with 2 ramps (north/south) up to the lower platform.
- **4 quadrant cover-bases (solid)** at (±28, ±28): each a cluster of 2–3 crates + a low
  L-shaped wall (two segments, height 2.5).
- **2 mid platforms (solid)** 10×2.5×10 at (24,-24) and (-24,24), each with a ramp.
- **Pillars (solid):** 6 thin towers 2×6×2 scattered (e.g. (±15,±15), (0,±35)).
- **Lane walls (solid):** 2 long low walls 14×3×1 breaking central sightlines.
- **Containers (solid, CC0 `container.glb`):** 2 large containers as big cover (e.g. (±36,0,0))
  with matching collision boxes sized to the model footprint.

## Props

- **Collidable cover:** crates (`crate.glb`) at cover-bases, containers (`container.glb`) — each
  backed by a collision box in the `collision` group.
- **Decorative (visual-only, NOT in collision):** barrels (`barrel.glb`, ~6), rocks
  (`rock.glb`, ~5), trees (`tree.glb`, ~4 near the perimeter). All `userData.noHit`.
- Every prop has a **box fallback** if its GLB is missing (per the existing `assets` pattern).

## Spawns

`SPAWN_POINTS` 6 → **8**, spread at radius ~38 around the larger arena (4 corners + 4 edge
midpoints) at `y = EYE_HEIGHT`, away from the central tower — keeps smart-spawn effective.

## Collision (unchanged mechanism)

`buildArena()` still returns `{ collision, visual }`. The `collision` group gets a box for every
solid structure (walls, tower tiers, ramps, cover crates, L-walls, mid platforms + ramps,
pillars, lane walls, container footprints). `physics.buildOctree(collision)` consumes it as today.
Decorative barrels/rocks/trees are added only to `visual`. Movement/clamp logic is untouched.

## Lighting

Widen the directional-shadow frustum to cover the bigger map (`sun.shadow.camera` ±55,
`far` ~220) and push fog out (`Fog(color, 80, 180)`). Hemisphere light unchanged.

## Files

- `src/map.ts` — bulk: 100×100 arena + structures + props (collision + visual).
- `worker/protocol.ts` — 8 `SPAWN_POINTS`.
- `src/assets.ts` — registry gains `container`, `rock`, `tree`.
- `src/main.ts` — shadow/fog bounds.
- `public/models/{container,rock,tree}.glb` + `CREDITS.md` (already added, CC0).

## Testing

`map.ts`/`assets.ts`/`main.ts` are WebGL — verified by `tsc --noEmit` + `npm run build` + a
browser walk-through (bigger arena renders, structures + props appear, shadows cover the map,
you cannot walk through solid structures, spawns spread out). All existing unit tests stay green
(no pure-logic changes except the spawn-point data, already covered by `spawn.test.ts` which only
asserts membership/validity).

## Non-goals

No destructible environment, no moving platforms/hazards, no minimap, no new map themes/rotation.
