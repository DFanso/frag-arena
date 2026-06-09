// src/zoom.ts — reusable per-weapon zoom math (issue #28). Pure + DOM-free so it can be unit
// tested and shared by the ADS path (#22) and the sniper scope (#2): a weapon declares its zoom
// levels in protocol.ts (`Weapon.zoomLevels`, FOV multipliers, index 0 = hipfire `1`), and these
// helpers turn a zoom-level index into the camera FOV and the look-sensitivity scale. Zoom is a
// purely client-side aiming aid — the server's HIT_RADIUS validation is unaffected.

/**
 * Pure: clamp a zoom-level index into [0, levels-1]. `levels` is the length of the weapon's
 * `zoomLevels` array (always >= 1; index 0 is hipfire). A weapon with one level (`[1]`) pins to 0.
 */
export function clampZoomLevel(idx: number, levels: number): number {
  if (levels <= 1) return 0;
  if (idx < 0) return 0;
  if (idx > levels - 1) return levels - 1;
  return Math.floor(idx);
}

/**
 * Pure: the FOV multiplier for a zoom-level index. Out-of-range indices clamp; an empty/levelless
 * list is treated as hipfire (`1`, no zoom). Multipliers < 1 narrow the FOV (zoom in).
 */
export function zoomMultiplier(zoomLevels: readonly number[], idx: number): number {
  if (zoomLevels.length === 0) return 1;
  const i = clampZoomLevel(idx, zoomLevels.length);
  return zoomLevels[i] ?? 1;
}

/**
 * Pure: scale look sensitivity to match the current zoom so the on-screen angular speed stays
 * roughly constant — at a zoom multiplier `m` (FOV shrinks by `m`) sensitivity is scaled by `m`
 * (e.g. 0.4x FOV → 0.4x sensitivity). Hipfire (`m = 1`) is unchanged. Guards against m <= 0.
 */
export function zoomSensitivityScale(multiplier: number): number {
  if (!(multiplier > 0)) return 1;
  return Math.min(1, multiplier);
}

/**
 * Pure: does this zoom level warrant the full-screen scope overlay? True only when the weapon is
 * `scoped` AND actually zoomed in (idx > 0) — hipfire never shows the scope. The sniper (#2)
 * supplies the deeper levels; an un-scoped weapon (rifle ADS, #22) never overlays a scope.
 */
export function isScopeActive(scoped: boolean, idx: number): boolean {
  return scoped && idx > 0;
}
