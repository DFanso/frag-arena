// test/combat.test.ts
import { describe, it, expect } from "vitest";
import { findPlayerId, isHead, HEAD_THRESHOLD, bumpSpread, decaySpread, SPREAD_BLOOM_MAX, SPREAD_DECAY_PER_SEC } from "../src/combat";
import { WEAPONS } from "../worker/protocol";

// Minimal mock matching the bits of THREE.Object3D that findPlayerId reads.
interface MockObj {
  userData: Record<string, unknown>;
  parent: MockObj | null;
}
function obj(userData: Record<string, unknown>, parent: MockObj | null = null): MockObj {
  return { userData, parent };
}

describe("findPlayerId", () => {
  it("returns the playerId from the hit object itself", () => {
    expect(findPlayerId(obj({ playerId: 7 }))).toBe(7);
  });

  it("climbs parents until it finds a playerId", () => {
    const root = obj({ playerId: 9 });
    const mid = obj({}, root);
    const leaf = obj({}, mid);
    expect(findPlayerId(leaf)).toBe(9);
  });

  it("returns null when no ancestor carries a playerId", () => {
    const root = obj({});
    const leaf = obj({}, root);
    expect(findPlayerId(leaf)).toBeNull();
  });

  it("treats playerId 0 as a valid id (not falsy-skipped)", () => {
    expect(findPlayerId(obj({ playerId: 0 }))).toBe(0);
  });
});

describe("isHead", () => {
  it("is true when the impact point is above the head threshold over the player base", () => {
    // player base (feet) at y = 1, impact near the top of the body
    expect(isHead(1 + HEAD_THRESHOLD + 0.1, 1)).toBe(true);
  });

  it("is false when the impact point is a body shot below the head threshold", () => {
    expect(isHead(1 + HEAD_THRESHOLD - 0.1, 1)).toBe(false);
  });

  it("is false exactly at the threshold boundary", () => {
    expect(isHead(1 + HEAD_THRESHOLD, 1)).toBe(false);
  });
});

describe("aim spread / bloom (issue #20)", () => {
  it("bumpSpread grows the spread by the per-shot growth", () => {
    expect(bumpSpread(0.006, 0.006, 0.004)).toBeCloseTo(0.010, 6);
  });

  it("bumpSpread clamps at base + SPREAD_BLOOM_MAX", () => {
    const base = 0.006;
    expect(bumpSpread(base + SPREAD_BLOOM_MAX, base, 0.004)).toBe(base + SPREAD_BLOOM_MAX);
    // many shots saturate but never exceed the cap
    let s = base;
    for (let i = 0; i < 100; i++) s = bumpSpread(s, base, 0.004);
    expect(s).toBe(base + SPREAD_BLOOM_MAX);
  });

  it("decaySpread recovers toward base over time, never below base", () => {
    const base = 0.006;
    const bloomed = base + 0.04;
    const after = decaySpread(bloomed, base, 100); // 100ms of partial decay
    expect(after).toBeCloseTo(bloomed - SPREAD_DECAY_PER_SEC * 0.1, 6);
    expect(after).toBeGreaterThan(base);
    // a long dt overshoots and clamps to base (never below)
    expect(decaySpread(bloomed, base, 5000)).toBe(base);
  });

  it("decaySpread clamps to base and treats at-or-below-base as base", () => {
    const base = 0.006;
    expect(decaySpread(base, base, 1000)).toBe(base);
    expect(decaySpread(base + 0.001, base, 10_000)).toBe(base); // huge dt → snaps to base, not under
  });

  it("decaySpread with zero dt is a no-op above base", () => {
    const base = 0.006;
    expect(decaySpread(0.02, base, 0)).toBe(0.02);
  });
});

describe("rifle bloom accumulates under sustained auto fire (regression for #20)", () => {
  // Each fire cycle: the spread decays over the weapon cooldown (many frames, linear so equivalent
  // to one decay of cooldownMs) then a shot bumps it. With sprayGrowth tuned ABOVE the per-cooldown
  // decay, sustained fire must visibly bloom toward the cap (the original 0.004 growth was a no-op).
  it("rifle spread climbs well above base over a burst", () => {
    const rifle = WEAPONS[0]!;
    let s = rifle.baseSpread;
    for (let i = 0; i < 10; i++) {
      s = decaySpread(s, rifle.baseSpread, rifle.cooldownMs);
      s = bumpSpread(s, rifle.baseSpread, rifle.sprayGrowth);
    }
    expect(s).toBeGreaterThan(rifle.baseSpread + 0.02); // not pinned at base
    expect(s).toBeLessThanOrEqual(rifle.baseSpread + SPREAD_BLOOM_MAX);
  });

  it("per-shot growth exceeds the decay over one rifle cooldown (the bloom is real)", () => {
    const rifle = WEAPONS[0]!;
    const decayPerCycle = SPREAD_DECAY_PER_SEC * (rifle.cooldownMs / 1000);
    expect(rifle.sprayGrowth).toBeGreaterThan(decayPerCycle);
  });
});
