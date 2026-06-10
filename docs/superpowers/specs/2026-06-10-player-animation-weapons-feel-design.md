# Player Animation, Held Weapons & Movement Feel — Design

**Date:** 2026-06-10
**Status:** Approved (user picked Approach B: full overhaul + realistic FPS arms)
**Problem:** Remote players skate across the ground in two clips (Idle/Run), punch the air
when shooting, and hold no weapon. The first-person viewmodel is a GLB rifle gripped by
procedural box-hands. Remote motion stutters. Local movement has no game-feel (no bob, FOV
kick, or landing response). The user verdict: "movement and weapon holding looks fake."

## Key discovery (drives the whole design)

The shipped GLBs already contain almost everything needed:

- `character_swat.glb` (active player model, Quaternius CC0) has unused clips:
  `Idle_Gun`, `Idle_Gun_Shoot`, `Idle_Gun_Pointing`, `Gun_Shoot`, `Run_Shoot`,
  `Run`, `Run_Back`, `Run_Left`, `Run_Right`, `Walk`, `Death`, `HitRecieve`, …
  and a full hand rig (`Wrist.R`, finger bones) to socket a weapon into.
- `character_soldier.glb` (Quaternius CC0, currently unused) contains real weapon meshes:
  `AK`, `Sniper`, `SMG`, `Shotgun`, `RocketLauncher`, `Pistol`, `GrenadeLauncher`, …

Only one external asset is needed: a realistic first-person arms rig (CC0/CC-BY).

## Scope: two PRs

### PR-1 — Third-person players + interpolation

1. **Held weapons on remote players**
   - At asset load, extract `AK`, `Sniper`, `RocketLauncher` meshes from
     `character_soldier.glb` into an "armory" registry (weapon id → template Object3D).
   - Each `RemotePlayer` clones the template for its current weapon and attaches it to the
     SWAT rig's `Wrist.R` bone with a hand-tuned local offset/rotation (one constant per
     weapon). Weapon meshes are `noHit` (never raycast targets).
   - **Protocol:** `InMsg` gains optional `w` (held weapon id). Server clamps to
     `[0, WEAPONS.length)` integer, stores on `PlayerRec`, echoes via `PlayerSnap.w`.
     Remote clients swap the held mesh when `w` changes. Bots report `w = 0`.
     Missing/invalid `w` → keep last known (default 0). No gameplay meaning — display only.

2. **Locomotion animation (kill the skating)**
   - Pure helper `pickLocomotion(localVx, localVz, speedXZ, shooting)` →
     `{ clip, timeScale }`, unit-tested:
     - Rotate world velocity by `-yaw` to get character-local velocity.
     - `speedXZ < 0.5` → `Idle_Gun` (or `Idle_Gun_Shoot` while shooting).
     - Else dominant axis picks `Run` / `Run_Back` / `Run_Left` / `Run_Right`
       (`Run_Shoot` replaces forward `Run` while shooting).
     - `timeScale = clamp(speedXZ / RUN_REFERENCE_SPEED, 0.6, 1.6)` so stride cadence
       matches actual ground speed (no foot-slide).
   - Crossfade 150 ms between clips. Existing crouch squash and parachute stay.

3. **Death animation** — on kill, play `Death` once (~1 s), hide nameplate/health bar
   immediately, remove the body when the clip ends or the player respawns. Gibbed (blast)
   deaths keep the instant gib — no change.

4. **Interpolation smoothing (kill the stutter)**
   - Replace the linear position lerp in `src/interp.ts` with velocity-aware cubic
     (Hermite) sampling — `PlayerSnap` already carries `v`, no protocol change.
   - Bounded extrapolation (≤ 100 ms) using last velocity when the buffer runs dry.
   - Shortest-arc yaw interpolation (no 359°→1° spin).
   - All pure; existing `interp.test.ts` extended.

### PR-2 — First-person viewmodel + movement feel

5. **Realistic FPS arms (Approach B addition)**
   - Source a rigged FPS-arms GLB, license CC0 or CC-BY (user approved CC-BY), from
     Poly Pizza / OpenGameArt / Sketchfab-CC downloads; convert FBX→GLB via `fbx2gltf`
     if needed. Record license + attribution in `public/models/CREDITS.md` (and README
     attribution section if CC-BY).
   - If the rig ships idle/fire/reload clips, drive them from the weapon controller;
     otherwise pose statically and rely on procedural motion (item 7).
   - **Fallback (explicit):** if no sourceable asset passes the quality bar, keep
     improved stylized arms gripping the real gun meshes. Screenshots either way.

6. **Real guns in the viewmodel** — replace the procedural/boxy held guns with the
   soldier-armory meshes (AK = Rifle, Sniper = Sniper, RocketLauncher = Rocket), scaled
   and gripped per weapon. The sniper scope overlay and muzzle anchor (#67 tracers) carry
   over; muzzle offsets re-tuned per model.

7. **Viewmodel motion (procedural, no per-frame allocation)**
   - Look-lag sway: viewmodel lags look rotation by a few degrees, spring-damped.
   - Stride bob: synced to the existing footstep stride callback.
   - Reload dip/tilt animated over the weapon's real `reloadMs`.
   - Weapon-raise animation on switch. Recoil kick stays.

8. **Local movement feel (cosmetic only)**
   - Head bob synced to strides, amplitude scaled by speed; **Settings toggle**
     ("Head bob", default on, persisted with existing settings).
   - Sprint FOV kick (~+6°). FOV writes centralize in one per-frame compose:
     `fov = baseFov × zoomMultiplier × sprintFactor` — refactors the current
     `applyZoom()` direct write so zoom (#28) and the kick can't fight.
   - Landing dip: camera dips ~6 cm over ~150 ms (ease-out) after hard landings,
     reusing the existing fall-detection path.
   - **No changes to movement physics, speeds, or server validation** — anti-cheat
     envelope untouched.

## Testing

- Pure units (vitest): locomotion picker, Hermite sampler + yaw arc, sway/bob/dip math,
  FOV compose, armory weapon-id mapping, `InMsg.w` clamp.
- `room.test.ts`: `w` stored + echoed in snapshots; invalid `w` rejected/clamped.
- Visual: run the Node build locally, join with bots, screenshot third-person and
  first-person results (as done for the CSP fix).

## Risks

| Risk | Mitigation |
|---|---|
| FPS-arms asset sourcing fails (login walls, FBX-only, low quality) | Explicit fallback to stylized arms + real guns (item 5) |
| Wrist-socket alignment looks wrong | Single tuning constant per weapon; iterate with screenshots |
| Interp changes regress remote rendering | Pure functions behind tests; old lerp kept as reference in tests |
| FOV compose conflicts with zoom/ADS | Centralized per-frame compose is the refactor that prevents this |

## Out of scope

- New movement mechanics (slide, lean, vaulting), stamina.
- Per-limb hit reactions, ragdolls.
- First-person leg/body awareness.
- Any server-side movement/validation change.
