// test/controls.test.ts
import { describe, it, expect } from "vitest";
import {
  clampDelta,
  axisFromKeys,
  moveAccel,
  MAX_DELTA,
  MOVE_SPEED,
  SPRINT_MULT,
  DAMPING_GROUND,
} from "../src/controls";
import { MAX_MOVE_SPEED, MOVE_SPEED_TOLERANCE } from "../worker/protocol";

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
