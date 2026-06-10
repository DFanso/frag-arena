// test/tracers.test.ts — bullet tracers (issue #67): pure streak math + pool cap/reuse.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Tracers, streakSpan, tracerStyle, TRACER_STYLES, TRACER_POOL_SIZE } from "../src/tracers";

describe("streakSpan", () => {
  it("clamps the tail at the muzzle while the streak is emerging", () => {
    expect(streakSpan(3, 7, 100)).toEqual({ a: 0, b: 3 });
  });

  it("is the full streak length mid-flight", () => {
    expect(streakSpan(50, 7, 100)).toEqual({ a: 43, b: 50 });
  });

  it("clamps the head at the impact while the tail catches up", () => {
    expect(streakSpan(103, 7, 100)).toEqual({ a: 96, b: 100 });
  });

  it("ends (null) once the tail reaches the impact", () => {
    expect(streakSpan(107, 7, 100)).toBeNull();
    expect(streakSpan(200, 7, 100)).toBeNull();
  });

  it("handles a ray shorter than the streak length", () => {
    expect(streakSpan(1, 7, 2)).toEqual({ a: 0, b: 1 });
    expect(streakSpan(9, 7, 2)).toBeNull();
  });
});

describe("tracerStyle", () => {
  it("gives the sniper a thicker, brighter, faster streak than the rifle", () => {
    const rifle = tracerStyle(0), sniper = tracerStyle(1);
    expect(sniper.thickness).toBeGreaterThan(rifle.thickness);
    expect(sniper.length).toBeGreaterThan(rifle.length);
    expect(sniper.speed).toBeGreaterThan(rifle.speed);
  });

  it("falls back to the rifle style for unknown weapon ids", () => {
    expect(tracerStyle(99)).toBe(TRACER_STYLES[0]);
    expect(tracerStyle(-1)).toBe(TRACER_STYLES[0]);
  });
});

describe("Tracers pool", () => {
  it("a spawned tracer becomes visible, travels, and expires (no leak)", () => {
    const scene = new THREE.Scene();
    const t = new Tracers(scene);
    t.spawn([0, 0, 0], [0, 0, 100], 0);
    expect(t.activeCount()).toBe(1);
    t.update(0.016); // streak emerges
    expect(scene.children[0]!.visible).toBe(true);
    t.update(10); // far past the full flight time
    expect(t.activeCount()).toBe(0);
    expect(scene.children[0]!.visible).toBe(false);
    t.dispose();
  });

  it("never grows past TRACER_POOL_SIZE meshes under sustained fire", () => {
    const scene = new THREE.Scene();
    const t = new Tracers(scene);
    for (let i = 0; i < TRACER_POOL_SIZE * 3; i++) t.spawn([0, 0, 0], [0, 0, 200], 0);
    expect(scene.children.length).toBe(TRACER_POOL_SIZE);
    expect(t.activeCount()).toBe(TRACER_POOL_SIZE);
    t.dispose();
  });

  it("reuses expired slots instead of allocating new meshes", () => {
    const scene = new THREE.Scene();
    const t = new Tracers(scene);
    t.spawn([0, 0, 0], [0, 0, 50], 0);
    t.update(10); // expire it
    t.spawn([0, 0, 0], [0, 0, 50], 1);
    expect(scene.children.length).toBe(1); // same mesh recycled
    expect(t.activeCount()).toBe(1);
    t.dispose();
  });

  it("ignores a degenerate zero-length shot", () => {
    const scene = new THREE.Scene();
    const t = new Tracers(scene);
    t.spawn([1, 1, 1], [1, 1, 1], 0);
    expect(t.activeCount()).toBe(0);
    t.dispose();
  });

  it("dispose removes every mesh from the scene", () => {
    const scene = new THREE.Scene();
    const t = new Tracers(scene);
    for (let i = 0; i < 5; i++) t.spawn([0, 0, 0], [0, 0, 10], 0);
    t.dispose();
    expect(scene.children.length).toBe(0);
  });
});
