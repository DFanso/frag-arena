# Design: Real Building Models (enterable, mesh collision)

**Date:** 2026-06-04
**Status:** Built
**Owner:** DFanso

## Problem

The castle-kit-assembled structures looked like "too many castles" and clipped/trapped the
player (thin kit-wall visuals offset from box collision + enterable hollows). Feedback:
fewer structures, use complete real building models (like the trees/rocks), and fix clipping.

## Decisions

- Replace the assembled kit structures with a **handful of complete CC0 building models**.
- Buildings: **tower/fort + 2 houses + 2 sheds** (5 total), spread out.
- Collision: **mesh-accurate** — the building's real geometry is fed into the Octree, so the
  capsule hits the real walls and you can walk in through real doorways (enterable). This
  replaces bounding-box collision, which made buildings solid blocks you couldn't approach.

## Assets (CC0, `public/models/building_*.glb`, all Quaternius via Poly Pizza)

`building_tower` (watch tower / keep), `building_house1` (cottage), `building_house2` (house),
`building_shed`, `building_shed2` (huts). All verified glTF, credited in CREDITS.md.

## Approach (`map.ts`)

- `deco(model, footprintW, x, z, rotY)` — clone, fit to a footprint width, **base-anchor** on
  the ground, add to the visual group.
- `building(...)` — `deco()` for the visual, then add a `clone(true)` of the placed object to the
  **collision group**. `buildOctree(collision)` triangulates it → accurate, enterable collision.
  Falls back to a solid box if the model is missing.
- `solidProp(...)` — small convex cover (crates/rocks/barrels/containers/logs) keeps cheap
  bounding-box collision.

## Layout

- `bTower` center (0,0). Houses at (-22,-22)/(22,22), sheds at (22,-22)/(-22,22).
- 2 climbable stone platforms with ramps at (0,±26) for verticality (box collision, glitch-free).
- Mid/low cover: 2 containers (±14,0), 4 crates (±12,±12), 4 rocks, 4 barrels, 2 logs.
- Ambiance: corner trees, scattered grass/bush/fern foliage, perimeter fences, grass ground.
- Spawn points unchanged (radius ~38); all buildings sit within radius ~28 so spawns stay clear.

## Removed

The castle-kit wall assembly (rings/edges), the broken-house builder, the cover-base enclosures,
the ruins, the lane walls, and the stone pillars. Kit GLBs remain in the repo but are unused.

## Testing

`tsc` + `vite build` + 152 unit tests. In-browser **collision probe** (capsule vs Octree)
confirmed: all 8 spawn points clear (no spawn-stuck), and building interiors are open
(tower 12/25, house1 11/25, house2 25/25, shed 9/25, shed2 15/25 sample cells open) — i.e. the
oversized solid box is gone and buildings are enterable. Buildings/props render (ground shots).

## Trade-offs / non-goals

Performance: ~40k building triangles enter the Octree (total scene ~106k); within the
games_fps-style budget. Interior walkability varies by model (house2 fully open, sheds tighter) —
that's accurate to each model rather than hand-authored.
