import { describe, it, expect } from "vitest";
import { sortScoreboard, pruneKillFeed, KILL_FEED_TTL_MS, type KillFeedEntry } from "../src/hud";
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
