import { describe, it, expect } from "vitest";
import {
  lerp,
  lerpVec3,
  lerpAngle,
  clamp,
  sampleBuffer,
  type Snapshot,
} from "../src/interp";

describe("lerp", () => {
  it("returns a at t=0 and b at t=1", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });
  it("returns the midpoint at t=0.5", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(-4, 4, 0.5)).toBe(0);
  });
});

describe("lerpVec3", () => {
  it("interpolates each component at the midpoint", () => {
    expect(lerpVec3([0, 0, 0], [2, 4, 6], 0.5)).toEqual([1, 2, 3]);
  });
  it("returns the endpoints at t=0 and t=1", () => {
    expect(lerpVec3([1, 2, 3], [9, 8, 7], 0)).toEqual([1, 2, 3]);
    expect(lerpVec3([1, 2, 3], [9, 8, 7], 1)).toEqual([9, 8, 7]);
  });
});

describe("lerpAngle (shortest-path yaw)", () => {
  it("interpolates linearly when no wrap is needed", () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 6);
  });
  it("wraps the short way across +/-PI instead of the long way", () => {
    // from 170deg (~2.967) to -170deg (~-2.967): shortest path crosses PI
    // (a 20deg gap), NOT the 340deg gap the other direction.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    // midpoint of the short arc sits at exactly 180deg == PI (or -PI).
    const dist = Math.abs(Math.atan2(Math.sin(mid - Math.PI), Math.cos(mid - Math.PI)));
    expect(dist).toBeCloseTo(0, 5);
  });
  it("is symmetric: wrapping the other direction also takes the short arc", () => {
    const a = (-170 * Math.PI) / 180;
    const b = (170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    const dist = Math.abs(Math.atan2(Math.sin(mid - Math.PI), Math.cos(mid - Math.PI)));
    expect(dist).toBeCloseTo(0, 5);
  });
});

describe("clamp", () => {
  it("passes through values within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps below lo and above hi", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("sampleBuffer", () => {
  it("returns null on an empty buffer", () => {
    expect(sampleBuffer([], 1000)).toBeNull();
  });

  it("returns the single sample when the buffer has length 1", () => {
    const buf: Snapshot[] = [{ t: 1000, p: [1, 2, 3], r: [0.5, -0.2] }];
    expect(sampleBuffer(buf, 5000)).toEqual({ p: [1, 2, 3], r: [0.5, -0.2] });
  });

  it("interpolates between two samples that straddle renderTime", () => {
    const buf: Snapshot[] = [
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 20, 30], r: [Math.PI / 2, 0] },
    ];
    const out = sampleBuffer(buf, 1500);
    expect(out).not.toBeNull();
    expect(out!.p[0]).toBeCloseTo(5, 6);
    expect(out!.p[1]).toBeCloseTo(10, 6);
    expect(out!.p[2]).toBeCloseTo(15, 6);
    expect(out!.r[0]).toBeCloseTo(Math.PI / 4, 6);
    expect(out!.r[1]).toBeCloseTo(0, 6);
  });

  it("clamps to the oldest sample when renderTime is before the buffer", () => {
    const buf: Snapshot[] = [
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 10, 10], r: [1, 1] },
    ];
    expect(sampleBuffer(buf, 500)).toEqual({ p: [0, 0, 0], r: [0, 0] });
  });

  it("clamps to the newest sample when renderTime is after the buffer", () => {
    const buf: Snapshot[] = [
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 10, 10], r: [1, 1] },
    ];
    expect(sampleBuffer(buf, 9999)).toEqual({ p: [10, 10, 10], r: [1, 1] });
  });

  it("drops stale samples and interpolates within the remaining window", () => {
    // older than the straddling pair must not be selected.
    const buf: Snapshot[] = [
      { t: 0, p: [-100, -100, -100], r: [3, 3] },
      { t: 1000, p: [0, 0, 0], r: [0, 0] },
      { t: 2000, p: [10, 10, 10], r: [0, 0] },
      { t: 3000, p: [20, 20, 20], r: [0, 0] },
    ];
    const out = sampleBuffer(buf, 2500);
    expect(out).not.toBeNull();
    expect(out!.p[0]).toBeCloseTo(15, 6);
    expect(out!.p[1]).toBeCloseTo(15, 6);
    expect(out!.p[2]).toBeCloseTo(15, 6);
  });
});

describe("velocity-aware sampling (spec 2026-06-10)", () => {
  const snap = (t: number, x: number, vx = 0): Snapshot =>
    ({ t, p: [x, 0, 0], r: [0, 0], v: [vx, 0, 0] });

  it("matches endpoints exactly", () => {
    const buf = [snap(0, 0, 10), snap(100, 1, 10)];
    expect(sampleBuffer(buf, 0)!.p[0]).toBeCloseTo(0, 6);
    expect(sampleBuffer(buf, 100)!.p[0]).toBeCloseTo(1, 6);
  });
  it("constant-velocity motion interpolates linearly (hermite degenerates to lerp)", () => {
    const buf = [snap(0, 0, 10), snap(100, 1, 10)];
    expect(sampleBuffer(buf, 50)!.p[0]).toBeCloseTo(0.5, 3);
  });
  it("eases direction reversals instead of kinking (cubic, not linear)", () => {
    const buf = [snap(0, 0, 10), snap(100, 0, -10)];
    expect(sampleBuffer(buf, 50)!.p[0]).toBeGreaterThan(0.05);
  });
  it("extrapolates past the newest snapshot using its velocity, capped at 100ms", () => {
    const buf = [snap(0, 0, 10), snap(100, 1, 10)];
    expect(sampleBuffer(buf, 150)!.p[0]).toBeCloseTo(1.5, 3);
    expect(sampleBuffer(buf, 900)!.p[0]).toBeCloseTo(2.0, 3);
  });
  it("falls back to lerp when snapshots carry no velocity", () => {
    const buf: Snapshot[] = [{ t: 0, p: [0, 0, 0], r: [0, 0] }, { t: 100, p: [1, 0, 0], r: [0, 0] }];
    expect(sampleBuffer(buf, 50)!.p[0]).toBeCloseTo(0.5, 6);
    expect(sampleBuffer(buf, 200)!.p[0]).toBeCloseTo(1, 6);
  });
});
