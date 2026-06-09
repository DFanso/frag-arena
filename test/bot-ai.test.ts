import { describe, it, expect } from "vitest";
import {
  nearestEnemy,
  botShouldFire,
  botHits,
  botMove,
  newBotState,
  type Combatant,
  type BotState,
} from "../worker/bot-ai";
import {
  WEAPONS,
  ST_ALIVE,
  ST_DEAD,
  ST_PROTECTED,
  EYE_HEIGHT,
  BOT_ACCURACY,
  BOT_REACTION_MS,
  BOT_MOVE_SPEED,
  BOT_BOUND,
  type Vec3,
} from "../worker/protocol";

const rifle = WEAPONS[0]!;

// Deterministic LCG so rand-dependent behaviour is testable.
function lcg(seed: number): () => number {
  let s = seed % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function combatant(id: number, p: Vec3, st = ST_ALIVE, inMatch = true): Combatant {
  return { id, p, st, inMatch };
}

describe("nearestEnemy", () => {
  const self: Vec3 = [0, EYE_HEIGHT, 0];

  it("returns null when there are no other living in-match players", () => {
    expect(nearestEnemy(1, self, [combatant(1, self)])).toBeNull();
  });

  it("picks the closest living enemy", () => {
    const out = nearestEnemy(1, self, [
      combatant(1, self),
      combatant(2, [0, EYE_HEIGHT, 40]),
      combatant(3, [0, EYE_HEIGHT, 12]),
      combatant(4, [50, EYE_HEIGHT, 0]),
    ]);
    expect(out).toBe(3);
  });

  it("ignores dead, protected, lobby, and self", () => {
    const out = nearestEnemy(1, self, [
      combatant(1, [0, EYE_HEIGHT, 2]),                 // self — closest but skipped
      combatant(2, [0, EYE_HEIGHT, 5], ST_DEAD),        // dead
      combatant(3, [0, EYE_HEIGHT, 6], ST_PROTECTED),   // protected (can't be damaged)
      combatant(4, [0, EYE_HEIGHT, 7], ST_ALIVE, false), // in lobby
      combatant(5, [0, EYE_HEIGHT, 30]),                // the only valid target
    ]);
    expect(out).toBe(5);
  });
});

describe("botShouldFire", () => {
  const self: Vec3 = [0, EYE_HEIGHT, 0];
  const ahead: Vec3 = [0, EYE_HEIGHT, 20]; // 20u in front when yaw faces +z
  // Bot facing +z: forward (-sinθ,-cosθ) = (0,1) ⇒ cosθ=-1 ⇒ yaw = π.
  const yawFacingAhead = Math.PI;

  const ready = (over: Partial<BotState> = {}): BotState =>
    ({ ...newBotState(), engagedAt: 0, lastShotAt: 0, ...over });

  it("fires when in range, aimed, off cooldown, and past the reaction delay", () => {
    expect(botShouldFire(self, yawFacingAhead, ahead, 10_000, rifle, ready())).toBe(true);
  });

  it("holds fire during the reaction delay", () => {
    const now = 1000;
    const st = ready({ engagedAt: now - (BOT_REACTION_MS - 50) });
    expect(botShouldFire(self, yawFacingAhead, ahead, now, rifle, st)).toBe(false);
  });

  it("holds fire while on cooldown", () => {
    const now = 10_000;
    const st = ready({ lastShotAt: now - (rifle.cooldownMs - 10) });
    expect(botShouldFire(self, yawFacingAhead, ahead, now, rifle, st)).toBe(false);
  });

  it("holds fire when the target is out of range", () => {
    const far: Vec3 = [0, EYE_HEIGHT, 5000];
    expect(botShouldFire(self, yawFacingAhead, far, 10_000, rifle, ready())).toBe(false);
  });

  it("holds fire when not facing the target", () => {
    expect(botShouldFire(self, 0 /* faces -z */, ahead, 10_000, rifle, ready())).toBe(false);
  });
});

describe("botHits", () => {
  it("returns true when the roll is under the accuracy", () => {
    expect(botHits(() => 0.1, 0.5)).toBe(true);
    expect(botHits(() => 0.9, 0.5)).toBe(false);
  });

  it("hits roughly BOT_ACCURACY of the time over many rolls", () => {
    const rand = lcg(42);
    let hits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (botHits(rand, BOT_ACCURACY)) hits++;
    expect(Math.abs(hits / N - BOT_ACCURACY)).toBeLessThan(0.05);
  });
});

describe("botMove", () => {
  const rand = lcg(7);

  it("moves toward a distant target and faces it", () => {
    const self: Vec3 = [0, EYE_HEIGHT, 0];
    const target: Vec3 = [0, EYE_HEIGHT, 100];
    const st = newBotState();
    const { p, yaw, v } = botMove(st, self, target, 1000, 0.1, rand);
    expect(p[2]).toBeGreaterThan(self[2]); // advanced toward +z
    expect(p[1]).toBeCloseTo(EYE_HEIGHT, 5); // stays grounded
    // Faces the target: forward (-sinθ,-cosθ) should point ~+z.
    expect(-Math.cos(yaw)).toBeGreaterThan(0.9);
    expect(Math.hypot(v[0], v[2])).toBeGreaterThan(0); // has horizontal velocity
  });

  it("keeps the bot inside the arena bound", () => {
    const self: Vec3 = [BOT_BOUND - 0.5, EYE_HEIGHT, 0];
    const target: Vec3 = [10_000, EYE_HEIGHT, 0]; // way outside, pulls the bot outward
    const st = newBotState();
    const { p } = botMove(st, self, target, 1000, 1.0, rand);
    expect(Math.abs(p[0])).toBeLessThanOrEqual(BOT_BOUND + 1e-6);
    expect(Math.abs(p[2])).toBeLessThanOrEqual(BOT_BOUND + 1e-6);
  });

  it("wanders (moves) when there is no target", () => {
    const self: Vec3 = [0, EYE_HEIGHT, 0];
    const st = newBotState();
    const { p, v } = botMove(st, self, null, 1000, 0.2, rand);
    expect(p[0] !== self[0] || p[2] !== self[2]).toBe(true);
    expect(Math.hypot(v[0], v[2])).toBeGreaterThan(0);
  });

  it("does not exceed the bot move speed", () => {
    const self: Vec3 = [0, EYE_HEIGHT, 0];
    const target: Vec3 = [0, EYE_HEIGHT, 100];
    const st = newBotState();
    const dt = 0.5;
    const { p } = botMove(st, self, target, 1000, dt, rand);
    const moved = Math.hypot(p[0] - self[0], p[2] - self[2]);
    expect(moved).toBeLessThanOrEqual(BOT_MOVE_SPEED * dt + 1e-6);
  });
});
