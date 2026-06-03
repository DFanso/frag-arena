// src/anim.ts — pure animation-state selection (no three.js / DOM).
export type BaseClip = "Idle" | "Running";
export const RUN_SPEED_THRESHOLD = 0.5; // world units/sec on the XZ plane

export interface AnimState {
  base: BaseClip;
  shoot: boolean;
}

// speedXZ: horizontal speed magnitude. shootingUntilMs: epoch ms the shoot cue ends.
export function pickAnim(speedXZ: number, shootingUntilMs: number, nowMs: number): AnimState {
  return {
    base: speedXZ > RUN_SPEED_THRESHOLD ? "Running" : "Idle",
    shoot: nowMs < shootingUntilMs,
  };
}
