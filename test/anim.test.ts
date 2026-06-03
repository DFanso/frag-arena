import { describe, it, expect } from "vitest";
import { pickAnim, RUN_SPEED_THRESHOLD } from "../src/anim";

describe("pickAnim", () => {
  it("Idle below the run threshold", () => {
    expect(pickAnim(0, 0, 1000).base).toBe("Idle");
    expect(pickAnim(RUN_SPEED_THRESHOLD, 0, 1000).base).toBe("Idle"); // not strictly greater
  });
  it("Running above the run threshold", () => {
    expect(pickAnim(RUN_SPEED_THRESHOLD + 0.01, 0, 1000).base).toBe("Running");
    expect(pickAnim(8, 0, 1000).base).toBe("Running");
  });
  it("shoot flag is true only while now < shootingUntil", () => {
    expect(pickAnim(0, 2000, 1500).shoot).toBe(true);
    expect(pickAnim(0, 2000, 2000).shoot).toBe(false);
    expect(pickAnim(0, 0, 1).shoot).toBe(false);
  });
});
