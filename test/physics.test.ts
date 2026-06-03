import { describe, it, expect } from "vitest";
import { makePlayerCollider } from "../src/physics";
import { EYE_HEIGHT } from "../worker/protocol";

describe("makePlayerCollider", () => {
  it("builds a Capsule with the contract-fixed start, end and radius", () => {
    const c = makePlayerCollider();
    expect(c.start.x).toBeCloseTo(0, 6);
    expect(c.start.y).toBeCloseTo(0.35, 6);
    expect(c.start.z).toBeCloseTo(0, 6);
    expect(c.end.x).toBeCloseTo(0, 6);
    expect(c.end.y).toBeCloseTo(EYE_HEIGHT, 6);
    expect(c.end.z).toBeCloseTo(0, 6);
    expect(c.radius).toBeCloseTo(0.35, 6);
  });

  it("returns a fresh, independent collider each call", () => {
    const a = makePlayerCollider();
    const b = makePlayerCollider();
    expect(a).not.toBe(b);
    a.start.x = 999;
    expect(b.start.x).toBeCloseTo(0, 6);
  });
});
