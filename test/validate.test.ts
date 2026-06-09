import { describe, it, expect } from "vitest";
import {
  sub,
  dot,
  len,
  norm,
  validateShoot,
  clampMove,
  isHeadshot,
  hitZone,
  zoneDamageMultiplier,
  type ShooterView,
  type TargetView,
} from "../worker/validate";
import {
  WEAPONS,
  HIT_RADIUS,
  HEAD_THRESHOLD,
  EYE_HEIGHT,
  ZONE_HEAD,
  ZONE_CHEST,
  ZONE_STOMACH,
  ZONE_LEGS,
  ST_ALIVE,
  ST_DEAD,
  ST_PROTECTED,
  type Vec3,
  type Weapon,
} from "../worker/protocol";

const RIFLE: Weapon = WEAPONS[0]!;

describe("vector helpers", () => {
  it("sub subtracts component-wise", () => {
    expect(sub([3, 5, 9], [1, 2, 3])).toEqual([2, 3, 6]);
  });

  it("dot computes the dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(1 * 4 + 2 * 5 + 3 * 6);
  });

  it("len computes the Euclidean length", () => {
    expect(len([3, 4, 0])).toBe(5);
    expect(len([0, 0, 0])).toBe(0);
  });

  it("norm returns a unit vector preserving direction", () => {
    const n = norm([0, 0, 5]);
    expect(n[0]).toBeCloseTo(0, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(1, 6);
    expect(len(n)).toBeCloseTo(1, 6);
  });

  it("norm of a zero vector returns a zero vector (no NaN)", () => {
    expect(norm([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("validateShoot", () => {
  const aliveShooter = (over: Partial<ShooterView> = {}): ShooterView => ({
    p: [0, 1, 0],
    st: ST_ALIVE,
    lastShotAt: 0,
    ...over,
  });
  const aliveTarget = (over: Partial<TargetView> = {}): TargetView => ({
    p: [0, 1, 10],
    st: ST_ALIVE,
    ...over,
  });
  // direction straight down +z toward the target at [0,1,10]
  const dirToTarget: Vec3 = [0, 0, 1];
  const NOW = 1_000_000;

  it("returns null for a clean valid shot", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBeNull();
  });

  it("rejects 'dead' when the shooter is dead", () => {
    expect(
      validateShoot(aliveShooter({ st: ST_DEAD, lastShotAt: NOW - 1000 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBe("dead");
  });

  it("rejects 'dead' when the shooter is still spawn-protected (st !== ST_ALIVE)", () => {
    // validateShoot only treats ST_ALIVE as able-to-fire; protection is dropped by
    // handleShoot BEFORE validation in real flow, so a raw protected shooter rejects.
    expect(
      validateShoot(aliveShooter({ st: ST_PROTECTED, lastShotAt: NOW - 1000 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBe("dead");
  });

  it("rejects 'firerate' when now - lastShotAt < cooldownMs - 25", () => {
    // cooldownMs = 120, threshold = 95ms. 50ms elapsed => reject.
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 50 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBe("firerate");
  });

  it("allows a shot exactly at the cooldown grace boundary", () => {
    // 95ms elapsed == cooldownMs - 25; NOT less-than, so allowed.
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 95 }), aliveTarget(), dirToTarget, RIFLE, NOW),
    ).toBeNull();
  });

  it("rejects 'notarget' when target is null", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), null, dirToTarget, RIFLE, NOW),
    ).toBe("notarget");
  });

  it("rejects 'target' when the target is dead", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget({ st: ST_DEAD }), dirToTarget, RIFLE, NOW),
    ).toBe("target");
  });

  it("rejects 'target' when the target is spawn-protected", () => {
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget({ st: ST_PROTECTED }), dirToTarget, RIFLE, NOW),
    ).toBe("target");
  });

  it("rejects 'range' when distance exceeds the weapon max range", () => {
    expect(
      validateShoot(
        aliveShooter({ lastShotAt: NOW - 1000 }),
        aliveTarget({ p: [0, 1, RIFLE.maxRange + 5] }),
        dirToTarget,
        RIFLE,
        NOW,
      ),
    ).toBe("range");
  });

  it("rejects 'aim' when firing perpendicular to the target (ray never approaches it)", () => {
    // target at +z but the player claims to fire along +x => ray goes nowhere near it
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget(), [1, 0, 0], RIFLE, NOW),
    ).toBe("aim");
  });

  it("rejects 'aim' when the target is behind the shooter", () => {
    // target at +z, but firing along -z => projection onto the ray is negative
    expect(
      validateShoot(aliveShooter({ lastShotAt: NOW - 1000 }), aliveTarget(), [0, 0, -1], RIFLE, NOW),
    ).toBe("aim");
  });

  it("accepts a CLOSE-RANGE shot aimed at the target's head (ray within HIT_RADIUS)", () => {
    // Regression for "direct hits miss": shooter at [0,1,0], target eye at [0,1,3].
    // Aiming up at the head is ~18 degrees off the eye->eye vector (old 4-degree cone
    // would WRONGLY reject), but the ray passes ~0.95u from the target centre < HIT_RADIUS.
    const shooter = aliveShooter({ lastShotAt: NOW - 1000 });
    const target = aliveTarget({ p: [0, 1, 3] });
    const aimAtHead: Vec3 = [0, 1, 3]; // from [0,1,0] toward [0,2,3]
    expect(validateShoot(shooter, target, aimAtHead, RIFLE, NOW)).toBeNull();
  });

  it("rejects 'aim' when the ray passes farther than HIT_RADIUS from the target", () => {
    // shooter [0,1,0], target [0,1,3]; aim steeply upward so the ray clears the body
    const shooter = aliveShooter({ lastShotAt: NOW - 1000 });
    const target = aliveTarget({ p: [0, 1, 3] });
    const aimHigh: Vec3 = [0, 4, 3]; // perpendicular distance ~2.4u > HIT_RADIUS (1.2)
    expect(validateShoot(shooter, target, aimHigh, RIFLE, NOW)).toBe("aim");
    expect(HIT_RADIUS).toBeLessThan(2.4); // guard: the test's margin assumes this
  });
});

describe("clampMove", () => {
  it("accepts a plausible move within speed budget", () => {
    // MAX_MOVE_SPEED 12, tolerance 1.6 => ~19.2 u/s. Over 100ms => ~1.92 u allowed.
    const next: Vec3 = [1, 1, 0];
    expect(clampMove([0, 1, 0], next, 100)).toEqual(next);
  });

  it("snaps an implausible teleport back toward the previous position", () => {
    // 1000 units in 100ms is way over budget -> result must be closer than the claim
    const prev: Vec3 = [0, 1, 0];
    const next: Vec3 = [1000, 1, 0];
    const out = clampMove(prev, next, 100);
    expect(out).not.toEqual(next);
    expect(len(sub(out, prev))).toBeLessThan(len(sub(next, prev)));
  });

  it("treats a non-positive dtMs as a one-tick (50ms) budget (no divide-by-zero)", () => {
    const prev: Vec3 = [0, 1, 0];
    const next: Vec3 = [1000, 1, 0];
    const out = clampMove(prev, next, 0);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(out).not.toEqual(next);
  });
});

describe("isHeadshot (server-authoritative head verification, issue #17)", () => {
  // Standing target: eye at y=1 (EYE_HEIGHT), feet at y=0. Shooter eye at y=1.
  const shooter: Vec3 = [0, EYE_HEIGHT, 0];
  const target: Vec3 = [0, EYE_HEIGHT, 10];

  it("a level eye-to-eye shot is a headshot (impact ~EYE_HEIGHT above feet > threshold)", () => {
    // hitY = 1 at the target column, feet = 0, 1 - 0 = 1 > 0.8.
    expect(isHeadshot(shooter, target, [0, 0, 1], false)).toBe(true);
  });

  it("a downward body/leg shot is NOT a headshot", () => {
    // Aiming down so the ray crosses the target column near the feet.
    expect(isHeadshot(shooter, target, [0, -0.1, 1], false)).toBe(false);
  });

  it("an upward shot over the head is below threshold only if it crosses low — high crossing is head", () => {
    // Steep up: at the target's column the ray is well above the feet -> head.
    expect(isHeadshot(shooter, target, [0, 0.3, 1], false)).toBe(true);
  });

  it("returns false when the target column is behind the shooter", () => {
    expect(isHeadshot(shooter, target, [0, 0, -1], false)).toBe(false);
  });

  it("returns false for a near-vertical aim (no meaningful column crossing)", () => {
    expect(isHeadshot(shooter, target, [0, 1, 0], false)).toBe(false);
  });

  it("uses the crouch eye height for the feet baseline", () => {
    // Crouched target (eye at y=1 still, but feet = 1 - CROUCH_EYE_HEIGHT(0.6) = 0.4). A level
    // shot at y=1 is 0.6 above feet < 0.8 -> NOT a head, where a standing target would be.
    expect(isHeadshot(shooter, target, [0, 0, 1], true)).toBe(false);
    expect(isHeadshot(shooter, target, [0, 0, 1], false)).toBe(true);
  });

  it("HEAD_THRESHOLD is shared with the client", () => {
    expect(HEAD_THRESHOLD).toBe(0.8);
  });
});

describe("hitZone (server-computed per-limb damage zone, issue #29)", () => {
  // Standing target: eye at y=1 (EYE_HEIGHT), feet at y=0. Shooter eye at y=1, target 10u ahead.
  // A small downward slope dy/dz ≈ (h-1)/10 lands the ray at height h on the target's column.
  const shooter: Vec3 = [0, EYE_HEIGHT, 0];
  const target: Vec3 = [0, EYE_HEIGHT, 10];

  it("classifies a level eye-to-eye shot as a head zone", () => {
    expect(hitZone(shooter, target, [0, 0, 1], false)).toBe(ZONE_HEAD); // impact ~1.0 above feet
  });

  it("classifies an upper-body shot as the chest zone", () => {
    expect(hitZone(shooter, target, [0, -0.03, 1], false)).toBe(ZONE_CHEST); // impact ~0.70
  });

  it("classifies a mid-body shot as the stomach zone", () => {
    expect(hitZone(shooter, target, [0, -0.05, 1], false)).toBe(ZONE_STOMACH); // impact ~0.50
  });

  it("classifies a low shot as the legs zone", () => {
    expect(hitZone(shooter, target, [0, -0.08, 1], false)).toBe(ZONE_LEGS); // impact ~0.20
  });

  it("agrees with isHeadshot for the head zone (no client trust)", () => {
    const headDir: Vec3 = [0, 0, 1];
    expect(hitZone(shooter, target, headDir, false) === ZONE_HEAD).toBe(
      isHeadshot(shooter, target, headDir, false),
    );
    const legDir: Vec3 = [0, -0.08, 1];
    expect(hitZone(shooter, target, legDir, false) === ZONE_HEAD).toBe(
      isHeadshot(shooter, target, legDir, false),
    );
  });

  it("uses the crouch eye height (a level shot on a crouched target is not a head)", () => {
    // feet = 1 - 0.6 = 0.4; level impact at 1.0 is 0.6 above feet < 0.8 -> not head.
    expect(hitZone(shooter, target, [0, 0, 1], true)).not.toBe(ZONE_HEAD);
  });
});

describe("zoneDamageMultiplier (CS-style per-zone scaling, issue #29)", () => {
  const rifle = WEAPONS[0]!;

  it("uses the weapon's headMult for the head zone", () => {
    expect(zoneDamageMultiplier(ZONE_HEAD, rifle)).toBe(rifle.headMult);
  });

  it("scales chest 1x, stomach 1.25x, legs 0.75x", () => {
    expect(zoneDamageMultiplier(ZONE_CHEST, rifle)).toBe(1);
    expect(zoneDamageMultiplier(ZONE_STOMACH, rifle)).toBe(1.25);
    expect(zoneDamageMultiplier(ZONE_LEGS, rifle)).toBe(0.75);
  });

  it("orders damage head > stomach > chest > legs for a fixed base", () => {
    const d = (z: 0 | 1 | 2 | 3) => rifle.damage * zoneDamageMultiplier(z, rifle);
    expect(d(ZONE_HEAD)).toBeGreaterThan(d(ZONE_STOMACH));
    expect(d(ZONE_STOMACH)).toBeGreaterThan(d(ZONE_CHEST));
    expect(d(ZONE_CHEST)).toBeGreaterThan(d(ZONE_LEGS));
  });
});
