import { describe, it, expect } from "vitest";
import { countdownText, deathMessage } from "../src/death-ui";

describe("countdownText", () => {
  it("shows 'Respawning…' at or below zero", () => {
    expect(countdownText(0)).toBe("Respawning…");
    expect(countdownText(-50)).toBe("Respawning…");
  });
  it("ceils remaining seconds", () => {
    expect(countdownText(2500)).toBe("Respawning in 3");
    expect(countdownText(1000)).toBe("Respawning in 1");
    expect(countdownText(1)).toBe("Respawning in 1");
  });
});

describe("deathMessage", () => {
  it("names the killer", () => {
    expect(deathMessage("Bob")).toBe("Fragged by Bob");
  });
  it("falls back to 'the void' when empty", () => {
    expect(deathMessage("")).toBe("Fragged by the void");
    expect(deathMessage("   ")).toBe("Fragged by the void");
  });
});
