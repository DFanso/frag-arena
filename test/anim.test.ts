import { describe, it, expect } from "vitest";
import { pickAnim, pickLocomotion, RUN_SPEED_THRESHOLD, RUN_REFERENCE_SPEED } from "../src/anim";

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

describe("pickLocomotion (third-person overhaul, spec 2026-06-10)", () => {
  // yaw=0 faces -Z (three.js camera convention; snapshot r[0] is the camera yaw).
  it("idles (gun pose) when slow", () => {
    expect(pickLocomotion(0, 0, 0, false).clip).toBe("Idle_Gun");
    expect(pickLocomotion(0.2, 0, 0, false).clip).toBe("Idle_Gun");
  });
  it("idle + shooting uses the gun-shoot idle", () => {
    expect(pickLocomotion(0, 0, 0, true).clip).toBe("Idle_Gun_Shoot");
  });
  it("forward run at yaw=0 is -Z", () => {
    expect(pickLocomotion(0, -5, 0, false).clip).toBe("Run");
  });
  it("forward + shooting runs-and-guns", () => {
    expect(pickLocomotion(0, -5, 0, true).clip).toBe("Run_Shoot");
  });
  it("backpedal at yaw=0 is +Z", () => {
    expect(pickLocomotion(0, 5, 0, false).clip).toBe("Run_Back");
  });
  it("strafe right at yaw=0 is +X", () => {
    expect(pickLocomotion(5, 0, 0, false).clip).toBe("Run_Right");
  });
  it("strafe left at yaw=0 is -X", () => {
    expect(pickLocomotion(-5, 0, 0, false).clip).toBe("Run_Left");
  });
  it("the frame rotates with the player: facing -X (yaw=+90°), moving -Z is a right strafe", () => {
    expect(pickLocomotion(0, -5, Math.PI / 2, false).clip).toBe("Run_Right");
  });
  it("timeScale tracks speed and clamps", () => {
    expect(pickLocomotion(0, -RUN_REFERENCE_SPEED, 0, false).timeScale).toBeCloseTo(1, 5);
    expect(pickLocomotion(0, -100, 0, false).timeScale).toBe(1.6);
    expect(pickLocomotion(0, -0.6, 0, false).timeScale).toBe(0.6);
    expect(pickLocomotion(0, 0, 0, false).timeScale).toBe(1); // idle always 1
  });
});
