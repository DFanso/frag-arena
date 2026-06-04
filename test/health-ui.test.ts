import { describe, it, expect } from "vitest";
import { healthFraction, healthColor } from "../src/health-ui";

describe("healthFraction", () => {
  it("computes the clamped fraction", () => {
    expect(healthFraction(100, 100)).toBe(1);
    expect(healthFraction(50, 100)).toBe(0.5);
    expect(healthFraction(0, 100)).toBe(0);
  });
  it("clamps out-of-range values", () => {
    expect(healthFraction(150, 100)).toBe(1);
    expect(healthFraction(-20, 100)).toBe(0);
  });
  it("returns 0 for a non-positive max", () => {
    expect(healthFraction(50, 0)).toBe(0);
  });
});

describe("healthColor", () => {
  it("is green at full, yellow at half, red at empty", () => {
    expect(healthColor(1)).toBe("rgb(0,255,0)");
    expect(healthColor(0.5)).toBe("rgb(255,255,0)");
    expect(healthColor(0)).toBe("rgb(255,0,0)");
  });
  it("clamps out-of-range fractions", () => {
    expect(healthColor(2)).toBe("rgb(0,255,0)");
    expect(healthColor(-1)).toBe("rgb(255,0,0)");
  });
});
