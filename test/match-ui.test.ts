import { describe, it, expect } from "vitest";
import { formatClock } from "../src/match-ui";

describe("formatClock", () => {
  it("formats minutes:seconds", () => {
    expect(formatClock(300000)).toBe("5:00");
    expect(formatClock(65000)).toBe("1:05");
    expect(formatClock(9000)).toBe("0:09");
  });
  it("ceils partial seconds so it reads 0:01 until truly zero", () => {
    expect(formatClock(999)).toBe("0:01");
    expect(formatClock(1)).toBe("0:01");
  });
  it("clamps to 0:00 at or below zero", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-500)).toBe("0:00");
  });
});
