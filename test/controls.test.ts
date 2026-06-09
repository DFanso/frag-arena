// test/controls.test.ts
import { describe, it, expect } from "vitest";
import {
  clampDelta,
  axisFromKeys,
  moveAccel,
  ladderContains,
  clampHorizontalSpeed,
  fallDamage,
  strideInterval,
  advanceStride,
  MAX_DELTA,
  MAX_GROUND_SPEED,
  MOVE_SPEED,
  SPRINT_MULT,
  DAMPING_GROUND,
  STRIDE_WALK,
  STRIDE_SPRINT,
  STRIDE_CROUCH,
  STEP_MIN_SPEED,
} from "../src/controls";
import { FALL_SAFE_DIST } from "../worker/protocol";
import { MAX_MOVE_SPEED, MOVE_SPEED_TOLERANCE } from "../worker/protocol";
import type { Ladder } from "../src/map";

describe("ladderContains", () => {
  const L: Ladder = { minX: -1, maxX: 1, minZ: 5, maxZ: 7, baseY: 0, topY: 11 };
  it("is true when inside the footprint and below the top", () => {
    expect(ladderContains(L, 0, 6, 3, 4)).toBe(true);
  });
  it("is false when outside the XZ footprint", () => {
    expect(ladderContains(L, 3, 6, 3, 4)).toBe(false);
    expect(ladderContains(L, 0, 9, 3, 4)).toBe(false);
  });
  it("is false once the feet reach the top (so you dismount)", () => {
    expect(ladderContains(L, 0, 6, 11, 12)).toBe(false);
  });
  it("is false below the base", () => {
    expect(ladderContains(L, 0, 6, -1, -0.2)).toBe(false);
  });
});

describe("clampDelta", () => {
  it("passes a normal frame delta through unchanged", () => {
    expect(clampDelta(0.016)).toBeCloseTo(0.016, 6);
  });

  it("clamps a huge delta (e.g. after a tab switch) to MAX_DELTA", () => {
    expect(clampDelta(5)).toBe(MAX_DELTA);
  });

  it("never returns a negative delta", () => {
    expect(clampDelta(-1)).toBe(0);
  });

  it("returns 0 for a non-finite delta", () => {
    expect(clampDelta(Number.NaN)).toBe(0);
    expect(clampDelta(Number.POSITIVE_INFINITY)).toBe(MAX_DELTA);
  });
});

describe("axisFromKeys", () => {
  it("returns zero intent when no keys are held", () => {
    expect(axisFromKeys({ w: false, a: false, s: false, d: false })).toEqual({ fwd: 0, right: 0 });
  });

  it("maps W to forward +1 and S to forward -1", () => {
    expect(axisFromKeys({ w: true, a: false, s: false, d: false })).toEqual({ fwd: 1, right: 0 });
    expect(axisFromKeys({ w: false, a: false, s: true, d: false })).toEqual({ fwd: -1, right: 0 });
  });

  it("maps D to right +1 and A to right -1", () => {
    expect(axisFromKeys({ w: false, a: false, s: false, d: true })).toEqual({ fwd: 0, right: 1 });
    expect(axisFromKeys({ w: false, a: true, s: false, d: false })).toEqual({ fwd: 0, right: -1 });
  });

  it("cancels opposing keys to zero", () => {
    expect(axisFromKeys({ w: true, a: true, s: true, d: true })).toEqual({ fwd: 0, right: 0 });
  });
});

describe("moveAccel (sprint)", () => {
  it("sprinting raises ground accel by SPRINT_MULT", () => {
    expect(moveAccel(true, false)).toBe(MOVE_SPEED);
    expect(moveAccel(true, true)).toBe(MOVE_SPEED * SPRINT_MULT);
  });

  it("airborne control is reduced (and still scales with sprint)", () => {
    expect(moveAccel(false, false)).toBeCloseTo(MOVE_SPEED * 0.3, 6);
    expect(moveAccel(false, true)).toBeCloseTo(MOVE_SPEED * 0.3 * SPRINT_MULT, 6);
  });

  it("steady-state sprint speed stays within the server movement clamp", () => {
    // equilibrium ground speed ~= accel / DAMPING_GROUND; must be <= server budget
    const sprintSpeed = moveAccel(true, true) / DAMPING_GROUND;
    expect(sprintSpeed).toBeLessThanOrEqual(MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE);
  });
});

describe("clampHorizontalSpeed (jump-speed fix)", () => {
  it("leaves a sub-cap velocity unchanged", () => {
    expect(clampHorizontalSpeed(2, 0)).toEqual([2, 0]);
    expect(clampHorizontalSpeed(0, 0)).toEqual([0, 0]);
  });

  it("scales an over-cap velocity down to MAX_GROUND_SPEED, preserving direction", () => {
    const [vx, vz] = clampHorizontalSpeed(100, 0);
    expect(vx).toBeCloseTo(MAX_GROUND_SPEED, 6);
    expect(vz).toBe(0);
    // a diagonal runaway is capped in magnitude but keeps its 45° heading
    const [dx, dz] = clampHorizontalSpeed(60, 60);
    expect(Math.hypot(dx, dz)).toBeCloseTo(MAX_GROUND_SPEED, 6);
    expect(dx).toBeCloseTo(dz, 6);
  });

  it("the cap stays within the server movement clamp", () => {
    expect(MAX_GROUND_SPEED).toBeLessThanOrEqual(MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE);
  });
});

describe("fallDamage", () => {
  it("is zero for a fall up to the safe distance", () => {
    expect(fallDamage(0)).toBe(0);
    expect(fallDamage(FALL_SAFE_DIST)).toBe(0);
  });
  it("scales with the distance fallen beyond the safe distance", () => {
    expect(fallDamage(FALL_SAFE_DIST + 1)).toBeGreaterThan(0);
    expect(fallDamage(FALL_SAFE_DIST + 10)).toBeGreaterThan(fallDamage(FALL_SAFE_DIST + 5));
  });
});

describe("strideInterval (#21 footstep cadence)", () => {
  it("returns the walk cadence by default", () => {
    expect(strideInterval(false, false)).toBe(STRIDE_WALK);
  });
  it("sprinting gives a faster (shorter) cadence than walking", () => {
    expect(strideInterval(true, false)).toBe(STRIDE_SPRINT);
    expect(STRIDE_SPRINT).toBeLessThan(STRIDE_WALK);
  });
  it("crouching gives a slower (longer) cadence and overrides sprint", () => {
    expect(strideInterval(false, true)).toBe(STRIDE_CROUCH);
    expect(strideInterval(true, true)).toBe(STRIDE_CROUCH); // can't sprint while crouched
    expect(STRIDE_CROUCH).toBeGreaterThan(STRIDE_WALK);
  });
});

describe("advanceStride (#21 footstep timer)", () => {
  const FAST = STEP_MIN_SPEED + 5; // comfortably above the standing-still threshold

  it("fires no step while airborne and holds the accumulator below the interval", () => {
    const r = advanceStride(0.39, 0.1, FAST, false, STRIDE_WALK);
    expect(r.steps).toBe(0);
    expect(r.acc).toBeLessThanOrEqual(STRIDE_WALK);
  });

  it("fires no step when standing still (below STEP_MIN_SPEED), even when grounded", () => {
    const r = advanceStride(0.2, 0.1, STEP_MIN_SPEED - 0.1, true, STRIDE_WALK);
    expect(r.steps).toBe(0);
  });

  it("accumulates without firing until the interval is reached", () => {
    const r = advanceStride(0, 0.2, FAST, true, STRIDE_WALK);
    expect(r.steps).toBe(0);
    expect(r.acc).toBeCloseTo(0.2, 6);
  });

  it("fires exactly one step when the interval is crossed and carries the remainder", () => {
    const r = advanceStride(0.35, 0.1, FAST, true, STRIDE_WALK); // 0.45 >= 0.40
    expect(r.steps).toBe(1);
    expect(r.acc).toBeCloseTo(0.05, 6);
  });

  it("fires multiple steps on a large (clamped) delta", () => {
    const r = advanceStride(0, 0.85, FAST, true, STRIDE_WALK); // 0.85 / 0.40 = 2 steps
    expect(r.steps).toBe(2);
    expect(r.acc).toBeCloseTo(0.05, 6);
  });

  it("clamps a stale accumulator down to the interval when not stepping", () => {
    // a long airborne stretch shouldn't bank up many instant steps on landing
    const r = advanceStride(99, 0.016, FAST, false, STRIDE_WALK);
    expect(r.acc).toBe(STRIDE_WALK);
    expect(r.steps).toBe(0);
  });
});
