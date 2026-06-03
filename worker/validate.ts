// worker/validate.ts — pure combat + movement validation. No runtime deps.
import {
  AIM_CONE_DOT,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  ST_ALIVE,
  type Vec3,
  type Weapon,
} from "./protocol";

export type ShootReject =
  | "dead"
  | "firerate"
  | "notarget"
  | "target"
  | "range"
  | "aim";

export interface ShooterView {
  p: Vec3;
  st: number;
  lastShotAt: number;
}
export interface TargetView {
  p: Vec3;
  st: number;
}

// ---- vector helpers ----
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function len(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function norm(a: Vec3): Vec3 {
  const l = len(a);
  if (l === 0) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Returns null if the shot is valid (caller applies damage), else a reject reason.
export function validateShoot(
  shooter: ShooterView,
  target: TargetView | null,
  dir: Vec3,
  weapon: Weapon,
  now: number,
): ShootReject | null {
  if (shooter.st !== ST_ALIVE) return "dead";
  if (now - shooter.lastShotAt < weapon.cooldownMs - 25) return "firerate";
  if (target === null) return "notarget";
  if (target.st !== ST_ALIVE) return "target";

  const toTarget = sub(target.p, shooter.p);
  const dist = len(toTarget);
  if (dist > weapon.maxRange) return "range";

  if (dot(norm(dir), norm(toTarget)) < AIM_CONE_DOT) return "aim";

  return null;
}

// Clamp a claimed new position to a plausible distance from the last known one.
// Returns the accepted position (snapped toward `prev` if the move was implausible).
// dtMs is the SERVER wall-clock delta between accepted inputs (see ingestInput / D7);
// a non-positive dt falls back to one server tick (50ms) so we never divide by zero.
export function clampMove(prev: Vec3, next: Vec3, dtMs: number): Vec3 {
  const dt = (dtMs > 0 ? dtMs : 50) / 1000; // seconds
  const maxDist = MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE * dt;
  const delta = sub(next, prev);
  const dist = len(delta);
  if (dist <= maxDist || dist === 0) return [next[0], next[1], next[2]];
  const scale = maxDist / dist;
  return [
    prev[0] + delta[0] * scale,
    prev[1] + delta[1] * scale,
    prev[2] + delta[2] * scale,
  ];
}

// Pick the spawn point that maximizes distance to the NEAREST living enemy.
// No enemies -> a rand()-chosen point. Ties -> rand() among the maxima.
export function chooseSpawn(spawnPoints: Vec3[], enemies: Vec3[], rand: () => number): Vec3 {
  if (spawnPoints.length === 0) return [0, 0, 0];
  if (enemies.length === 0) {
    return spawnPoints[Math.floor(rand() * spawnPoints.length)] ?? spawnPoints[0]!;
  }
  let best: Vec3[] = [];
  let bestScore = -Infinity;
  for (const sp of spawnPoints) {
    let nearest = Infinity;
    for (const e of enemies) {
      const d = len(sub(sp, e));
      if (d < nearest) nearest = d;
    }
    if (nearest > bestScore + 1e-9) {
      bestScore = nearest;
      best = [sp];
    } else if (Math.abs(nearest - bestScore) <= 1e-9) {
      best.push(sp);
    }
  }
  return best[Math.floor(rand() * best.length)] ?? best[0]!;
}
