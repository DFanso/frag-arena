// worker/bot-ai.ts — pure AI helpers for server-driven bots (issue #31). No runtime deps; the
// game loop (game-core.ts) owns the BotState and calls these each tick to move + fire bots. Single
// "medium" difficulty: hunt the nearest living enemy, hold a preferred range, fire on a hit roll.
import {
  ST_ALIVE,
  EYE_HEIGHT,
  BOT_REACTION_MS,
  BOT_FIRE_RANGE,
  BOT_AIM_DOT,
  BOT_MOVE_SPEED,
  BOT_PREFERRED_RANGE,
  BOT_WANDER_INTERVAL_MS,
  BOT_BOUND,
  BOT_RADIUS,
  BOT_VISION_RANGE,
  BOT_FOV_DOT,
  type Vec3,
  type Weapon,
  type Rect,
} from "./protocol";

// Per-bot scratchpad held on the PlayerRec (game-core mutates it across ticks).
export interface BotState {
  targetId: number | null;
  wanderYaw: number;      // heading used when there is no target
  nextDecisionAt: number; // epoch ms to re-pick the wander heading
  engagedAt: number;      // epoch ms the current target was acquired (reaction-delay anchor)
  lastShotAt: number;     // epoch ms of the bot's last shot (fire-rate gate)
}

export function newBotState(): BotState {
  return { targetId: null, wanderYaw: 0, nextDecisionAt: 0, engagedAt: 0, lastShotAt: 0 };
}

// Minimal view of a player the AI reasons about.
export interface Combatant {
  id: number;
  p: Vec3;
  st: number;
  inMatch: boolean;
}

/** Nearest living, in-match enemy id (excludes self, dead, protected, and lobby players); null if none. */
export function nearestEnemy(selfId: number, selfPos: Vec3, others: Combatant[]): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const o of others) {
    if (o.id === selfId || !o.inMatch || o.st !== ST_ALIVE) continue;
    const dx = o.p[0] - selfPos[0];
    const dy = o.p[1] - selfPos[1];
    const dz = o.p[2] - selfPos[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = o.id; }
  }
  return best;
}

/** Yaw (radians) whose camera-forward (-sinθ, -cosθ) points from `from` toward `to` in XZ. */
function yawToward(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  return Math.atan2(-dx, -dz); // inverts forward = (-sinθ, -cosθ)
}

/**
 * Should the bot fire this tick? Requires: past the reaction delay, off the weapon cooldown, the
 * target within fire range, and the bot facing within BOT_AIM_DOT of the target. Hit/miss is a
 * separate roll (botHits) so the server stays authoritative over damage.
 */
export function botShouldFire(
  selfPos: Vec3,
  selfYaw: number,
  targetPos: Vec3,
  now: number,
  weapon: Weapon,
  state: BotState,
): boolean {
  if (now - state.engagedAt < BOT_REACTION_MS) return false;
  if (now - state.lastShotAt < weapon.cooldownMs) return false;
  const dx = targetPos[0] - selfPos[0];
  const dy = targetPos[1] - selfPos[1];
  const dz = targetPos[2] - selfPos[2];
  const range = Math.min(weapon.maxRange, BOT_FIRE_RANGE);
  if (dx * dx + dy * dy + dz * dz > range * range) return false;
  const horiz = Math.hypot(dx, dz) || 1;
  const dot = -Math.sin(selfYaw) * (dx / horiz) + -Math.cos(selfYaw) * (dz / horiz);
  return dot > BOT_AIM_DOT;
}

/** Per-shot hit roll: true when rand() falls under the configured accuracy. */
export function botHits(rand: () => number, accuracy: number): boolean {
  return rand() < accuracy;
}

// 2-D (XZ) segment-vs-rectangle test via Liang–Barsky. Returns true if the segment a→b touches
// the axis-aligned rect (endpoints inside count). Used for line-of-sight occlusion.
export function segmentIntersectsRect(ax: number, az: number, bx: number, bz: number, r: Rect): boolean {
  const minX = r.x - r.w / 2, maxX = r.x + r.w / 2;
  const minZ = r.z - r.d / 2, maxZ = r.z + r.d / 2;
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, ax - minX], [dx, maxX - ax],
    [-dz, az - minZ], [dz, maxZ - az],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false; // parallel and outside this slab
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t0 <= t1;
}

/** True if no occluder blocks the XZ sightline from `from` to `to`. */
export function hasLineOfSight(from: Vec3, to: Vec3, occluders: readonly Rect[]): boolean {
  for (const r of occluders) {
    if (segmentIntersectsRect(from[0], from[2], to[0], to[2], r)) return false;
  }
  return true;
}

/**
 * Can the bot see `targetPos`? Requires: within BOT_VISION_RANGE, inside the view cone (BOT_FOV_DOT
 * of the bot's facing), and an unobstructed line of sight past the occluders. This is what gates a
 * bot's awareness — a target it can't see is ignored entirely (no shooting through walls).
 */
export function canSee(selfPos: Vec3, selfYaw: number, targetPos: Vec3, occluders: readonly Rect[]): boolean {
  const dx = targetPos[0] - selfPos[0];
  const dz = targetPos[2] - selfPos[2];
  const horiz = Math.hypot(dx, dz);
  if (horiz > BOT_VISION_RANGE) return false;
  if (horiz > 1e-6) {
    const dot = -Math.sin(selfYaw) * (dx / horiz) + -Math.cos(selfYaw) * (dz / horiz);
    if (dot < BOT_FOV_DOT) return false; // outside the view cone
  }
  return hasLineOfSight(selfPos, targetPos, occluders);
}

/** Nearest living, in-match enemy the bot can actually see (range + view cone + line of sight); null if none. */
export function visibleEnemy(
  selfId: number,
  selfPos: Vec3,
  selfYaw: number,
  others: Combatant[],
  occluders: readonly Rect[],
): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const o of others) {
    if (o.id === selfId || !o.inMatch || o.st !== ST_ALIVE) continue;
    if (!canSee(selfPos, selfYaw, o.p, occluders)) continue;
    const dx = o.p[0] - selfPos[0];
    const dz = o.p[2] - selfPos[2];
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = o.id; }
  }
  return best;
}

export interface BotMove { p: Vec3; yaw: number; v: Vec3; }

function clampBound(n: number): number {
  return Math.max(-BOT_BOUND, Math.min(BOT_BOUND, n));
}

// Is (x,z) inside any occluder rect, expanded by the bot's body radius `margin`?
function pointBlocked(x: number, z: number, occluders: readonly Rect[], margin: number): boolean {
  for (const r of occluders) {
    if (
      x > r.x - r.w / 2 - margin && x < r.x + r.w / 2 + margin &&
      z > r.z - r.d / 2 - margin && z < r.z + r.d / 2 + margin
    ) return true;
  }
  return false;
}

/**
 * Resolve a desired XZ move against the occluders so bots can't walk through structures. Tries the
 * full move, then each axis alone (wall-sliding), then gives up and stays put. The structures are
 * far taller than the bot, so this 2-D test matches gameplay. Pure.
 */
export function resolveMove(
  fromX: number, fromZ: number, toX: number, toZ: number,
  occluders: readonly Rect[], margin: number,
): [number, number] {
  if (!pointBlocked(toX, toZ, occluders, margin)) return [toX, toZ];
  if (!pointBlocked(toX, fromZ, occluders, margin)) return [toX, fromZ]; // slide along X
  if (!pointBlocked(fromX, toZ, occluders, margin)) return [fromX, toZ]; // slide along Z
  return [fromX, fromZ]; // fully blocked — hold position
}

/**
 * Advance the bot one tick. With a target: face it and close to (or hold) BOT_PREFERRED_RANGE.
 * Without one: wander along a heading refreshed every BOT_WANDER_INTERVAL_MS. The result is clamped
 * to the soft arena bound and kept grounded at EYE_HEIGHT. Mutates `state.wanderYaw/nextDecisionAt`.
 */
export function botMove(
  state: BotState,
  selfPos: Vec3,
  targetPos: Vec3 | null,
  now: number,
  dtSec: number,
  rand: () => number,
  occluders: readonly Rect[] = [],
): BotMove {
  let moveYaw: number;  // direction of travel
  let faceYaw: number;  // direction the bot looks (faces the target while strafing/backing off)

  if (targetPos) {
    faceYaw = yawToward(selfPos, targetPos);
    const dist = Math.hypot(targetPos[0] - selfPos[0], targetPos[2] - selfPos[2]);
    if (dist > BOT_PREFERRED_RANGE + 2) {
      moveYaw = faceYaw;            // close the gap
    } else if (dist < BOT_PREFERRED_RANGE - 2) {
      moveYaw = faceYaw + Math.PI;  // back off
    } else {
      moveYaw = faceYaw + Math.PI / 2; // hold range — strafe sideways
    }
  } else {
    if (now >= state.nextDecisionAt) {
      state.wanderYaw = rand() * Math.PI * 2;
      state.nextDecisionAt = now + BOT_WANDER_INTERVAL_MS;
    }
    moveYaw = state.wanderYaw;
    faceYaw = state.wanderYaw;
  }

  // Camera-forward convention: forward = (-sin yaw, -cos yaw).
  const step = BOT_MOVE_SPEED * Math.max(0, dtSec);
  const vx = -Math.sin(moveYaw) * BOT_MOVE_SPEED;
  const vz = -Math.cos(moveYaw) * BOT_MOVE_SPEED;
  const candX = clampBound(selfPos[0] - Math.sin(moveYaw) * step);
  const candZ = clampBound(selfPos[2] - Math.cos(moveYaw) * step);
  // Don't walk through buildings: resolve the candidate against the occluders (wall-slide / stop).
  const [rx, rz] = resolveMove(selfPos[0], selfPos[2], candX, candZ, occluders, BOT_RADIUS);
  return { p: [rx, EYE_HEIGHT, rz], yaw: faceYaw, v: [vx, 0, vz] };
}
