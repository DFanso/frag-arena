// test/combat.test.ts
import { describe, it, expect } from "vitest";
import { findPlayerId, isHead, HEAD_THRESHOLD } from "../src/combat";

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
