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

// --- Third-person locomotion (spec 2026-06-10): pick a SWAT clip from character-local velocity.
export const RUN_REFERENCE_SPEED = 6; // world u/s at which Run plays at timeScale 1
export type LocomotionClip =
  | "Idle_Gun" | "Idle_Gun_Shoot" | "Run" | "Run_Back" | "Run_Left" | "Run_Right" | "Run_Shoot";
export interface Locomotion { clip: LocomotionClip; timeScale: number; }

// vx/vz: world-space horizontal velocity. yaw: facing (snapshot r[0]; yaw=0 faces -Z).
// Rotates the velocity into the character frame, picks the dominant direction, and scales the
// clip speed to the actual ground speed so the feet match the floor (no skating).
export function pickLocomotion(vx: number, vz: number, yaw: number, shooting: boolean): Locomotion {
  const speed = Math.hypot(vx, vz);
  if (speed <= RUN_SPEED_THRESHOLD) {
    return { clip: shooting ? "Idle_Gun_Shoot" : "Idle_Gun", timeScale: 1 };
  }
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const fwd = -vz * cos - vx * sin;  // + = moving the way the character faces
  const right = vx * cos - vz * sin; // + = moving toward the character's right
  let clip: LocomotionClip;
  if (Math.abs(fwd) >= Math.abs(right)) clip = fwd > 0 ? (shooting ? "Run_Shoot" : "Run") : "Run_Back";
  else clip = right > 0 ? "Run_Right" : "Run_Left";
  const timeScale = Math.min(1.6, Math.max(0.6, speed / RUN_REFERENCE_SPEED));
  return { clip, timeScale };
}
