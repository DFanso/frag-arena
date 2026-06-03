import { describe, it, expect } from "vitest";
import { chooseSpawn } from "../worker/validate";
import type { Vec3 } from "../worker/protocol";

const PTS: Vec3[] = [[-10, 1, 0], [0, 1, 0], [10, 1, 0]];

describe("chooseSpawn", () => {
  it("with no enemies, returns a point chosen by rand", () => {
    const got = chooseSpawn(PTS, [], () => 0); // index 0
    expect(got).toEqual([-10, 1, 0]);
    const got2 = chooseSpawn(PTS, [], () => 0.99); // last index
    expect(got2).toEqual([10, 1, 0]);
  });
  it("picks the point farthest from the nearest enemy", () => {
    // enemy hugging the left spawn -> the right spawn is farthest
    const got = chooseSpawn(PTS, [[-10, 1, 0]], () => 0);
    expect(got).toEqual([10, 1, 0]);
  });
  it("breaks ties using rand", () => {
    // enemy in the middle: left and right are equidistant (tie) -> rand selects
    const got = chooseSpawn(PTS, [[0, 1, 0]], () => 0);   // first of the tied set
    expect(got).toEqual([-10, 1, 0]);
    const got2 = chooseSpawn(PTS, [[0, 1, 0]], () => 0.99); // last of the tied set
    expect(got2).toEqual([10, 1, 0]);
  });
});
