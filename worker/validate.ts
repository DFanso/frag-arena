// worker/validate.ts — pure combat + movement validation. No runtime deps.
import {
  HIT_RADIUS,
  HEAD_THRESHOLD,
  CHEST_MIN_HEIGHT,
  STOMACH_MIN_HEIGHT,
  EYE_HEIGHT,
  CROUCH_EYE_HEIGHT,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  ST_ALIVE,
  ZONE_LEGS,
  ZONE_STOMACH,
  ZONE_CHEST,
  ZONE_HEAD,
  ZONE_MULT,
  type Vec3,
  type Weapon,
  type HitZone,
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

  // Range-independent aim check: does the shooter's aim ray pass within HIT_RADIUS of
  // the target's body? This is far more forgiving (and correct) than a fixed angle cone
  // for body-sized targets at close range, where a head/feet shot is many degrees off the
  // eye->eye vector yet visually a clean hit. Replaces the old AIM_CONE_DOT test.
  const dn = norm(dir);
  const proj = dot(toTarget, dn); // distance to the closest point along the ray
  if (proj <= 0) return "aim"; // target is behind the shooter
  const perpSq = dot(toTarget, toTarget) - proj * proj;
  const perp = Math.sqrt(Math.max(0, perpSq));
  if (perp > HIT_RADIUS) return "aim";

  return null;
}

// Server-authoritative per-limb hit zone (issue #29). Finds where the aim ray crosses the
// target's vertical column (its XZ position) and classifies the impact height above the target's
// feet into head / chest / stomach / legs. `target` is the EYE position, so feet = eye.y -
// eyeHeight (eyeHeight depends on the target's crouch state). The client's `head` claim is NOT
// consulted — the zone (and thus damage) is derived purely from geometry. A near-vertical aim
// (no meaningful column crossing) or a target behind the shooter falls back to the chest zone,
// since validateShoot has already confirmed the shot is otherwise a valid body hit.
export function hitZone(shooter: Vec3, target: Vec3, dir: Vec3, crouched: boolean): HitZone {
  const dn = norm(dir);
  const denomXZ = dn[0] * dn[0] + dn[2] * dn[2];
  if (denomXZ < 1e-9) return ZONE_CHEST;
  const t = ((target[0] - shooter[0]) * dn[0] + (target[2] - shooter[2]) * dn[2]) / denomXZ;
  if (t <= 0) return ZONE_CHEST;
  const hitY = shooter[1] + dn[1] * t;
  const feetY = target[1] - (crouched ? CROUCH_EYE_HEIGHT : EYE_HEIGHT);
  const h = hitY - feetY; // impact height above the feet
  if (h > HEAD_THRESHOLD) return ZONE_HEAD;
  if (h >= CHEST_MIN_HEIGHT) return ZONE_CHEST;
  if (h >= STOMACH_MIN_HEIGHT) return ZONE_STOMACH;
  return ZONE_LEGS;
}

// Back-compat helper (issue #17): a shot is a headshot iff its server-computed zone is the head.
// Kept so callers/tests that only care about "head or not" stay simple.
export function isHeadshot(shooter: Vec3, target: Vec3, dir: Vec3, crouched: boolean): boolean {
  return hitZone(shooter, target, dir, crouched) === ZONE_HEAD;
}

// Damage multiplier for a zone: the head uses the weapon's own headMult (preserving per-weapon
// head scaling); the other zones use the shared CS-style ZONE_MULT table.
export function zoneDamageMultiplier(zone: HitZone, weapon: Weapon): number {
  return zone === ZONE_HEAD ? weapon.headMult : ZONE_MULT[zone];
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
