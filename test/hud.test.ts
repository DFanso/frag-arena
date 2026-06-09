import { describe, it, expect } from "vitest";
import { sortScoreboard, pruneKillFeed, damageDirectionAngle, minimapPoint, pingColor, pushPingSample, averagePing, crosshairGapPx, PING_SAMPLES, KILL_FEED_TTL_MS, type KillFeedEntry, type MinimapView } from "../src/hud";
import type { PlayerSnap } from "../worker/protocol";

function snap(id: number, name: string, frags: number, deaths: number): PlayerSnap {
  return { id, name, p: [0, 0, 0], r: [0, 0], v: [0, 0, 0], hp: 100, st: 1, frags, deaths };
}

describe("sortScoreboard", () => {
  it("returns empty array for empty input", () => {
    expect(sortScoreboard([])).toEqual([]);
  });

  it("sorts by frags descending", () => {
    const out = sortScoreboard([snap(1, "a", 1, 0), snap(2, "b", 5, 0), snap(3, "c", 3, 0)]);
    expect(out.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it("breaks ties by fewer deaths first", () => {
    const out = sortScoreboard([snap(1, "a", 5, 9), snap(2, "b", 5, 2), snap(3, "c", 5, 4)]);
    expect(out.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it("breaks remaining ties by lower id (stable, deterministic)", () => {
    const out = sortScoreboard([snap(7, "a", 2, 2), snap(3, "b", 2, 2), snap(5, "c", 2, 2)]);
    expect(out.map((p) => p.id)).toEqual([3, 5, 7]);
  });

  it("does not mutate the input array", () => {
    const input = [snap(1, "a", 1, 0), snap(2, "b", 5, 0)];
    const copy = input.slice();
    sortScoreboard(input);
    expect(input).toEqual(copy);
  });
});

describe("damageDirectionAngle", () => {
  // yaw=0 → camera looks down -Z (three.js default). Screen-relative bearing,
  // clockwise-positive: 0=ahead (top), +90=right, ±180=behind (bottom), -90=left.
  const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

  it("returns 0 when the attacker is straight ahead", () => {
    // looking -Z, attacker at -Z
    close(damageDirectionAngle([0, 0, 0], [0, 0, -10], 0), 0);
  });

  it("returns 180 when the attacker is directly behind", () => {
    close(Math.abs(damageDirectionAngle([0, 0, 0], [0, 0, 10], 0)), 180);
  });

  it("returns +90 when the attacker is to the right", () => {
    // screen-right of a -Z-facing camera is +X
    close(damageDirectionAngle([0, 0, 0], [10, 0, 0], 0), 90);
  });

  it("returns -90 when the attacker is to the left", () => {
    close(damageDirectionAngle([0, 0, 0], [-10, 0, 0], 0), -90);
  });

  it("ignores the vertical (y) component", () => {
    close(damageDirectionAngle([0, 0, 0], [0, 50, -10], 0), 0);
  });

  it("accounts for camera yaw (rotated to face -X)", () => {
    // yaw=π/2 turns the camera to look down -X; an attacker at -X is now straight ahead
    close(damageDirectionAngle([0, 0, 0], [-10, 0, 0], Math.PI / 2), 0);
  });

  it("is relative to the player position, not the world origin", () => {
    close(damageDirectionAngle([5, 0, 5], [5, 0, -5], 0), 0); // attacker due -Z of the player
  });
});

describe("minimapPoint", () => {
  // 160px canvas, arena half = 120 → scale = (160/2)/120. Center = (80,80). +x right, +y down.
  const north = (over: Partial<MinimapView> = {}): MinimapView =>
    ({ mode: "north", self: [0, 0, 0], yaw: 0, half: 120, size: 160, ...over });
  const rotate = (over: Partial<MinimapView> = {}): MinimapView =>
    ({ mode: "rotate", self: [0, 0, 0], yaw: 0, half: 120, size: 160, ...over });
  const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

  it("north: arena center maps to canvas center, not clamped", () => {
    const p = minimapPoint(0, 0, north());
    near(p.x, 80); near(p.y, 80); expect(p.clamped).toBe(false);
  });

  it("north: +z (south) maps downward, +x maps right", () => {
    const s = minimapPoint(60, 0, north()); near(s.x, 120); near(s.y, 80);
    const d = minimapPoint(0, 60, north()); near(d.x, 80); near(d.y, 120);
  });

  it("north: ignores self position and yaw (map is fixed)", () => {
    const p = minimapPoint(60, 0, north({ self: [40, 0, -40], yaw: 1.2 }));
    near(p.x, 120); near(p.y, 80);
  });

  it("north: a point outside the arena clamps to the circular edge", () => {
    const p = minimapPoint(1000, 0, north());
    expect(p.clamped).toBe(true);
    near(Math.hypot(p.x - 80, p.y - 80), 80); // on the edge circle (radius = size/2)
    near(p.x, 160); near(p.y, 80);
  });

  it("rotate: a point straight ahead maps to up (above center)", () => {
    const p = minimapPoint(0, -60, rotate()); // yaw=0 faces -Z, so -Z is ahead
    near(p.x, 80); near(p.y, 40);
  });

  it("rotate: a point to the right maps to the right", () => {
    const p = minimapPoint(60, 0, rotate());
    near(p.x, 120); near(p.y, 80);
  });

  it("rotate: is relative to the player position", () => {
    const p = minimapPoint(30, -30, rotate({ self: [30, 0, 30] })); // 60u ahead of the player
    near(p.x, 80); near(p.y, 40);
  });

  it("rotate: accounts for yaw (turned to face -X)", () => {
    const p = minimapPoint(-60, 0, rotate({ yaw: Math.PI / 2 })); // -X is now ahead
    near(p.x, 80); near(p.y, 40);
  });
});

describe("pruneKillFeed", () => {
  const e = (at: number, text: string): KillFeedEntry => ({ at, text });

  it("exposes a 5000ms TTL", () => {
    expect(KILL_FEED_TTL_MS).toBe(5000);
  });

  it("keeps entries younger than the TTL", () => {
    const now = 10_000;
    const out = pruneKillFeed([e(9000, "fresh")], now);
    expect(out).toEqual([e(9000, "fresh")]);
  });

  it("drops entries at or past the TTL", () => {
    const now = 10_000;
    const out = pruneKillFeed([e(5000, "old"), e(4999, "older"), e(6000, "keep")], now);
    expect(out.map((x) => x.text)).toEqual(["keep"]);
  });

  it("returns empty when all entries expired", () => {
    expect(pruneKillFeed([e(0, "x"), e(100, "y")], 10_000)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [e(9000, "a"), e(1000, "b")];
    const copy = input.slice();
    pruneKillFeed(input, 10_000);
    expect(input).toEqual(copy);
  });
});

describe("pingColor (ping latency thresholds, issue #18)", () => {
  it("green at or below 80ms", () => {
    expect(pingColor(0)).toBe("#3c9");
    expect(pingColor(80)).toBe("#3c9");
  });
  it("yellow above 80ms up to 150ms", () => {
    expect(pingColor(81)).toBe("#fc6");
    expect(pingColor(150)).toBe("#fc6");
  });
  it("red beyond 150ms", () => {
    expect(pingColor(151)).toBe("#e44");
    expect(pingColor(999)).toBe("#e44");
  });
});

describe("ping rolling buffer (issue #18)", () => {
  it("pushPingSample keeps the last PING_SAMPLES entries", () => {
    let buf: number[] = [];
    for (let i = 1; i <= PING_SAMPLES + 5; i++) buf = pushPingSample(buf, i);
    expect(buf.length).toBe(PING_SAMPLES);
    expect(buf[buf.length - 1]).toBe(PING_SAMPLES + 5); // newest retained
    expect(buf[0]).toBe(6); // oldest 5 dropped (1..5)
  });
  it("pushPingSample does not mutate the input array", () => {
    const buf = [1, 2, 3];
    const out = pushPingSample(buf, 4);
    expect(buf).toEqual([1, 2, 3]);
    expect(out).toEqual([1, 2, 3, 4]);
  });
  it("averagePing returns 0 for an empty buffer", () => {
    expect(averagePing([])).toBe(0);
  });
  it("averagePing rounds the mean", () => {
    expect(averagePing([10, 20, 30])).toBe(20);
    expect(averagePing([10, 11])).toBe(11); // 10.5 -> 11
  });
});

describe("crosshairGapPx (aim-spread crosshair, issue #20)", () => {
  it("returns the base gap at zero spread", () => {
    expect(crosshairGapPx(0)).toBe(3);
  });
  it("widens monotonically with spread", () => {
    expect(crosshairGapPx(0.02)).toBeGreaterThan(crosshairGapPx(0.006));
    expect(crosshairGapPx(0.05)).toBeGreaterThan(crosshairGapPx(0.02));
  });
  it("clamps negative spread to the base gap", () => {
    expect(crosshairGapPx(-1)).toBe(3);
  });
});
