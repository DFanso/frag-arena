// test/player.test.ts
import { describe, it, expect } from "vitest";
import { LocalPlayer, RECONCILE_DIST } from "../src/player";
import type { InMsg } from "../worker/protocol";

describe("LocalPlayer.nextSeq", () => {
  it("returns 1 first, then increments monotonically", () => {
    const lp = new LocalPlayer(3);
    expect(lp.nextSeq()).toBe(1);
    expect(lp.nextSeq()).toBe(2);
    expect(lp.nextSeq()).toBe(3);
  });

  it("stores the id passed to the constructor", () => {
    expect(new LocalPlayer(7).id).toBe(7);
  });
});

describe("LocalPlayer.buildInput", () => {
  it("builds an InMsg with an incrementing seq from nextSeq", () => {
    const lp = new LocalPlayer(1);
    const m1: InMsg = lp.buildInput([1, 2, 3], [0.5, -0.2], [0, 0, 1], 1000);
    expect(m1).toEqual({ t: "in", seq: 1, ts: 1000, p: [1, 2, 3], r: [0.5, -0.2], v: [0, 0, 1] });

    const m2: InMsg = lp.buildInput([4, 5, 6], [0, 0], [0, 0, 0], 1066);
    expect(m2.seq).toBe(2);
    expect(m2.ts).toBe(1066);
    expect(m2.t).toBe("in");
  });

  it("copies the position/rotation/velocity arrays (no shared reference)", () => {
    const lp = new LocalPlayer(1);
    const p: [number, number, number] = [1, 2, 3];
    const r: [number, number] = [0, 0];
    const v: [number, number, number] = [0, 0, 0];
    const m = lp.buildInput(p, r, v, 0);
    expect(m.p).not.toBe(p);
    expect(m.r).not.toBe(r);
    expect(m.v).not.toBe(v);
    expect(m.p).toEqual([1, 2, 3]);
  });
});

describe("LocalPlayer.reconcile", () => {
  it("returns null when predicted and server positions are within RECONCILE_DIST", () => {
    const lp = new LocalPlayer(1);
    expect(lp.reconcile([0, 1, 0], [0.1, 1, 0.1])).toBeNull();
  });

  it("returns the server position when divergence exceeds RECONCILE_DIST", () => {
    const lp = new LocalPlayer(1);
    const server: [number, number, number] = [0, 1, RECONCILE_DIST + 1];
    expect(lp.reconcile([0, 1, 0], server)).toEqual(server);
  });

  it("uses 3D distance (diagonal) for the decision", () => {
    const lp = new LocalPlayer(1);
    const d = RECONCILE_DIST; // sqrt(3*d^2) = d*sqrt(3) > RECONCILE_DIST
    const server: [number, number, number] = [d, d, d];
    expect(lp.reconcile([0, 0, 0], server)).toEqual(server);
  });

  it("returns null for identical positions", () => {
    const lp = new LocalPlayer(1);
    expect(lp.reconcile([5, 5, 5], [5, 5, 5])).toBeNull();
  });

  it("returns a copy of the server position, not the passed reference", () => {
    const lp = new LocalPlayer(1);
    const server: [number, number, number] = [0, 0, RECONCILE_DIST + 5];
    const snapped = lp.reconcile([0, 0, 0], server);
    expect(snapped).not.toBe(server);
    expect(snapped).toEqual(server);
  });
});
