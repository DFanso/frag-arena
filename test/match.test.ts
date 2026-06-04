import { describe, it, expect } from "vitest";
import { matchOutcome, rankPlayers } from "../worker/match";
import type { Standing } from "../worker/protocol";

describe("matchOutcome", () => {
  it("is false while time remains and no one hit the frag limit", () => {
    expect(matchOutcome(1000, 5000, 10, 25)).toBe(false);
  });
  it("is true when the timer has expired", () => {
    expect(matchOutcome(5000, 5000, 0, 25)).toBe(true);
    expect(matchOutcome(6000, 5000, 0, 25)).toBe(true);
  });
  it("is true when a player reached the frag limit", () => {
    expect(matchOutcome(1000, 5000, 25, 25)).toBe(true);
    expect(matchOutcome(1000, 5000, 30, 25)).toBe(true);
  });
});

describe("rankPlayers", () => {
  const mk = (id: number, frags: number, deaths: number): Standing => ({ id, name: "p" + id, frags, deaths });

  it("sorts by frags desc, then deaths asc, then id asc", () => {
    const input = [mk(1, 3, 5), mk(2, 7, 2), mk(3, 7, 1), mk(4, 7, 1)];
    const ranked = rankPlayers(input);
    expect(ranked.map((p) => p.id)).toEqual([3, 4, 2, 1]); // 7/1(id3), 7/1(id4), 7/2(id2), 3/5(id1)
  });

  it("does not mutate the input array", () => {
    const input = [mk(1, 1, 0), mk(2, 9, 0)];
    const copy = [...input];
    rankPlayers(input);
    expect(input).toEqual(copy);
  });
});
