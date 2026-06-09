// test/zoom.test.ts — pure per-weapon zoom math (issue #28).
import { describe, it, expect } from "vitest";
import { clampZoomLevel, zoomMultiplier, zoomSensitivityScale, isScopeActive } from "../src/zoom";
import { WEAPONS } from "../worker/protocol";

describe("clampZoomLevel", () => {
  it("pins a single-level weapon to hipfire (0)", () => {
    expect(clampZoomLevel(0, 1)).toBe(0);
    expect(clampZoomLevel(2, 1)).toBe(0);
    expect(clampZoomLevel(-1, 1)).toBe(0);
  });

  it("clamps into [0, levels-1]", () => {
    expect(clampZoomLevel(-3, 3)).toBe(0);
    expect(clampZoomLevel(1, 3)).toBe(1);
    expect(clampZoomLevel(2, 3)).toBe(2);
    expect(clampZoomLevel(9, 3)).toBe(2);
  });

  it("floors a fractional index", () => {
    expect(clampZoomLevel(1.9, 3)).toBe(1);
  });

  it("treats a zero/negative level count as hipfire", () => {
    expect(clampZoomLevel(5, 0)).toBe(0);
  });
});

describe("zoomMultiplier", () => {
  it("returns the multiplier at the given level", () => {
    expect(zoomMultiplier([1, 0.4, 0.2], 0)).toBe(1);
    expect(zoomMultiplier([1, 0.4, 0.2], 1)).toBe(0.4);
    expect(zoomMultiplier([1, 0.4, 0.2], 2)).toBe(0.2);
  });

  it("clamps an out-of-range index to the deepest level", () => {
    expect(zoomMultiplier([1, 0.4, 0.2], 99)).toBe(0.2);
    expect(zoomMultiplier([1, 0.4, 0.2], -5)).toBe(1);
  });

  it("treats an empty level list as hipfire (no zoom)", () => {
    expect(zoomMultiplier([], 0)).toBe(1);
    expect(zoomMultiplier([], 3)).toBe(1);
  });

  it("a single-level (no-op) weapon never zooms", () => {
    expect(zoomMultiplier([1], 0)).toBe(1);
    expect(zoomMultiplier([1], 1)).toBe(1); // clamps back to level 0
  });
});

describe("zoomSensitivityScale", () => {
  it("is 1 at hipfire (multiplier 1)", () => {
    expect(zoomSensitivityScale(1)).toBe(1);
  });

  it("scales down proportionally to the zoom (narrower FOV → slower look)", () => {
    expect(zoomSensitivityScale(0.4)).toBeCloseTo(0.4, 6);
    expect(zoomSensitivityScale(0.2)).toBeCloseTo(0.2, 6);
  });

  it("never amplifies above 1 even for a > 1 (zoom-out) multiplier", () => {
    expect(zoomSensitivityScale(1.5)).toBe(1);
  });

  it("guards against a non-positive multiplier", () => {
    expect(zoomSensitivityScale(0)).toBe(1);
    expect(zoomSensitivityScale(-1)).toBe(1);
  });
});

describe("isScopeActive", () => {
  it("shows the scope only for a scoped weapon that is actually zoomed in", () => {
    expect(isScopeActive(true, 1)).toBe(true);
    expect(isScopeActive(true, 2)).toBe(true);
  });

  it("never shows the scope at hipfire", () => {
    expect(isScopeActive(true, 0)).toBe(false);
  });

  it("never shows the scope for an un-scoped weapon (rifle ADS)", () => {
    expect(isScopeActive(false, 1)).toBe(false);
    expect(isScopeActive(false, 0)).toBe(false);
  });
});

describe("WEAPONS zoom config (issue #28)", () => {
  it("every weapon declares zoom levels starting at hipfire (1)", () => {
    for (const w of WEAPONS) {
      expect(w.zoomLevels.length).toBeGreaterThanOrEqual(1);
      expect(w.zoomLevels[0]).toBe(1); // index 0 is always hipfire
    }
  });

  it("every zoom level past hipfire narrows the FOV (multiplier < 1)", () => {
    for (const w of WEAPONS) {
      for (let i = 1; i < w.zoomLevels.length; i++) {
        expect(w.zoomLevels[i]).toBeLessThan(1);
        expect(w.zoomLevels[i]).toBeGreaterThan(0);
      }
    }
  });

  it("the level-1 zoom equals the legacy adsZoom so #22 ADS reuses #28", () => {
    for (const w of WEAPONS) {
      expect(w.zoomLevels[1]).toBe(w.adsZoom);
    }
  });

  it("only scoped weapons carry deeper-than-ADS levels", () => {
    for (const w of WEAPONS) {
      if (w.zoomLevels.length > 2) expect(w.scoped).toBe(true);
    }
  });
});
