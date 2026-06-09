import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  ACTIONS,
  clampSettings,
  parseSettings,
  rebind,
  type Settings,
} from "../src/settings";

describe("clampSettings", () => {
  it("returns the defaults for empty input", () => {
    expect(clampSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps sensitivity to [0.1, 5]", () => {
    expect(clampSettings({ sensitivity: 0 }).sensitivity).toBe(0.1);
    expect(clampSettings({ sensitivity: 999 }).sensitivity).toBe(5);
    expect(clampSettings({ sensitivity: 2.5 }).sensitivity).toBe(2.5);
  });

  it("clamps fov to [60, 120]", () => {
    expect(clampSettings({ fov: 40 }).fov).toBe(60);
    expect(clampSettings({ fov: 200 }).fov).toBe(120);
    expect(clampSettings({ fov: 90 }).fov).toBe(90);
  });

  it("clamps masterVolume to [0, 1]", () => {
    expect(clampSettings({ masterVolume: -1 }).masterVolume).toBe(0);
    expect(clampSettings({ masterVolume: 5 }).masterVolume).toBe(1);
    expect(clampSettings({ masterVolume: 0.3 }).masterVolume).toBe(0.3);
  });

  it("falls back to the default when a number field is not a finite number", () => {
    expect(clampSettings({ sensitivity: "fast" as unknown as number }).sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
    expect(clampSettings({ fov: NaN }).fov).toBe(DEFAULT_SETTINGS.fov);
  });

  it("fills missing keymap actions from the defaults", () => {
    const out = clampSettings({ keymap: { forward: "ArrowUp" } as Settings["keymap"] });
    expect(out.keymap.forward).toBe("ArrowUp");
    for (const a of ACTIONS) expect(typeof out.keymap[a]).toBe("string");
    expect(out.keymap.back).toBe(DEFAULT_SETTINGS.keymap.back);
  });

  it("ignores unknown keymap actions and non-string codes", () => {
    const out = clampSettings({
      keymap: { forward: 123 as unknown as string, bogus: "KeyZ" } as unknown as Settings["keymap"],
    });
    expect(out.keymap.forward).toBe(DEFAULT_SETTINGS.keymap.forward); // non-string ignored
    expect((out.keymap as Record<string, string>).bogus).toBeUndefined();
  });

  it("does not mutate the defaults", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    clampSettings({ sensitivity: 3, keymap: { forward: "KeyZ" } as Settings["keymap"] });
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});

describe("parseSettings", () => {
  it("returns the defaults for null", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for invalid JSON", () => {
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for a non-object payload", () => {
    expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps a valid partial payload", () => {
    const out = parseSettings(JSON.stringify({ sensitivity: 99, fov: 100 }));
    expect(out.sensitivity).toBe(5);
    expect(out.fov).toBe(100);
    expect(out.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
  });
});

describe("rebind", () => {
  it("binds an action to a free code", () => {
    const r = rebind(DEFAULT_SETTINGS.keymap, "forward", "ArrowUp");
    expect(r.ok).toBe(true);
    expect(r.keymap?.forward).toBe("ArrowUp");
  });

  it("is a no-op success when rebinding an action to its own current code", () => {
    const r = rebind(DEFAULT_SETTINGS.keymap, "forward", "KeyW");
    expect(r.ok).toBe(true);
    expect(r.keymap?.forward).toBe("KeyW");
    expect(r.conflict).toBeUndefined();
  });

  it("rejects a code already owned by a different action", () => {
    const r = rebind(DEFAULT_SETTINGS.keymap, "forward", "KeyS"); // KeyS = back
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe("back");
    expect(r.keymap).toBeUndefined();
  });

  it("does not mutate the input keymap", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS.keymap);
    rebind(DEFAULT_SETTINGS.keymap, "forward", "ArrowUp");
    expect(JSON.stringify(DEFAULT_SETTINGS.keymap)).toBe(before);
  });
});
