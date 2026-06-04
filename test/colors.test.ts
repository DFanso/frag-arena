import { describe, it, expect } from "vitest";
import { playerColor } from "../src/colors";

describe("playerColor", () => {
  it("is deterministic for the same id", () => {
    expect(playerColor(7)).toBe(playerColor(7));
  });

  it("gives different colors to consecutive ids", () => {
    expect(playerColor(1)).not.toBe(playerColor(2));
    expect(playerColor(2)).not.toBe(playerColor(3));
  });

  it("returns a valid 24-bit RGB integer", () => {
    for (const id of [0, 1, 5, 10, 42, 100]) {
      const c = playerColor(id);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffffff);
    }
  });
});
