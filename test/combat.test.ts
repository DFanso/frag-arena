// test/combat.test.ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { fireRay, findPlayerId, isHead, HEAD_THRESHOLD, bumpSpread, decaySpread, SPREAD_BLOOM_MAX, SPREAD_DECAY_PER_SEC } from "../src/combat";
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

describe("fireRay — pinpoint to the crosshair (screen centre)", () => {
  // A perspective camera at eye height (0,1,0) aimed along `dir`. No renderer/WebGL needed —
  // setFromCamera + intersectObjects are pure math.
  function camLookingAlong(dir: THREE.Vector3): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 500);
    cam.position.set(0, 1, 0);
    cam.lookAt(cam.position.clone().add(dir));
    cam.updateMatrixWorld(true);
    return cam;
  }

  function playerBox(x: number, y: number, z: number, id: number, w = 0.8, h = 1.7): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.6));
    mesh.position.set(x, y, z);
    mesh.userData.playerId = id;
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  it("hits a centred target and reports the exact camera-forward direction", () => {
    const cam = camLookingAlong(new THREE.Vector3(0, 0, -1));
    const res = fireRay(cam, [playerBox(0, 1, -5, 3)]);
    expect(res.hit).toBe(3);
    // Direction = the crosshair (camera forward), normalized.
    expect(res.d[0]).toBeCloseTo(0, 6);
    expect(res.d[1]).toBeCloseTo(0, 6);
    expect(res.d[2]).toBeCloseTo(-1, 6);
    // Impact lands dead-centre on the near face of the target.
    expect(res.point).not.toBeNull();
    expect(res.point![0]).toBeCloseTo(0, 4);
    expect(res.point![1]).toBeCloseTo(1, 4);
  });

  it("reports the direction that was actually cast (matches camera world-direction) off-axis", () => {
    const cam = camLookingAlong(new THREE.Vector3(1, -0.3, -1));
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const res = fireRay(cam, []);
    expect(res.d[0]).toBeCloseTo(fwd.x, 6);
    expect(res.d[1]).toBeCloseTo(fwd.y, 6);
    expect(res.d[2]).toBeCloseTo(fwd.z, 6);
    expect(res.hit).toBeNull();
    expect(res.point).toBeNull();
  });

  it("has zero spread variance — a target off the crosshair line is always missed", () => {
    const cam = camLookingAlong(new THREE.Vector3(0, 0, -1));
    const off = playerBox(1.5, 1, -5, 9, 0.2, 0.2); // small box well off the centre axis
    // No randomness in the cast ray any more: the centre ray misses it every single time.
    for (let i = 0; i < 50; i++) expect(fireRay(cam, [off]).hit).toBeNull();
  });
});

describe("rifle bloom accumulates under sustained auto fire (review fix #20)", () => {
  it("per-shot growth exceeds the decay over one rifle cooldown (bloom is real, not a no-op)", () => {
    const rifle = WEAPONS[0]!;
    const decayPerCycle = SPREAD_DECAY_PER_SEC * (rifle.cooldownMs / 1000);
    expect(rifle.sprayGrowth).toBeGreaterThan(decayPerCycle);
  });
  it("rifle spread climbs well above base over a burst (decay then bump per cooldown)", () => {
    const rifle = WEAPONS[0]!;
    let s = rifle.baseSpread;
    for (let i = 0; i < 10; i++) {
      s = decaySpread(s, rifle.baseSpread, rifle.cooldownMs);
      s = bumpSpread(s, rifle.baseSpread, rifle.sprayGrowth);
    }
    expect(s).toBeGreaterThan(rifle.baseSpread + 0.02);
    expect(s).toBeLessThanOrEqual(rifle.baseSpread + SPREAD_BLOOM_MAX);
  });
});
