// test/audio.test.ts — pure distance-attenuation maths for positional gunfire (#21).
// (The live audio path delegates this to a PannerNode; pannerGain mirrors it for unit testing.)
import { describe, it, expect } from "vitest";
import {
  pannerGain,
  PANNER_REF_DISTANCE,
  PANNER_MAX_DISTANCE,
} from "../src/audio";

describe("pannerGain (inverse-distance attenuation)", () => {
  it("is full volume within the reference distance", () => {
    expect(pannerGain(0)).toBe(1);
    expect(pannerGain(PANNER_REF_DISTANCE - 1)).toBe(1);
    expect(pannerGain(PANNER_REF_DISTANCE)).toBe(1);
  });

  it("decreases monotonically as the source gets farther away", () => {
    const near = pannerGain(PANNER_REF_DISTANCE + 5);
    const mid = pannerGain(PANNER_REF_DISTANCE + 30);
    const far = pannerGain(PANNER_MAX_DISTANCE);
    expect(near).toBeLessThan(1);
    expect(mid).toBeLessThan(near);
    expect(far).toBeLessThan(mid);
  });

  it("clamps beyond the max distance to the max-distance gain (no negative/zero blow-up)", () => {
    const atMax = pannerGain(PANNER_MAX_DISTANCE);
    expect(pannerGain(PANNER_MAX_DISTANCE + 1000)).toBeCloseTo(atMax, 12);
    expect(atMax).toBeGreaterThan(0);
  });

  it("treats negative distances as their magnitude", () => {
    expect(pannerGain(-50)).toBeCloseTo(pannerGain(50), 12);
  });

  it("matches the inverse model exactly at a known distance", () => {
    // inverse model: ref / (ref + rolloff*(d-ref)); at d = 2*ref, rolloff 1 → ref/(2*ref) = 0.5
    expect(pannerGain(2 * PANNER_REF_DISTANCE)).toBeCloseTo(0.5, 12);
  });

  it("never exceeds 1 nor drops to zero across the whole range", () => {
    for (let d = 0; d <= PANNER_MAX_DISTANCE; d += 7) {
      const g = pannerGain(d);
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});
