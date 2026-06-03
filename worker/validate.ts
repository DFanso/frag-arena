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
