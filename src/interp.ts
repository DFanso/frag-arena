// src/interp.ts — pure interpolation + vector math helpers (no DOM / no THREE).
import type { Vec3, Rot } from "../worker/protocol";

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// Shortest-path angular interpolation (radians). Wraps across +/-PI correctly.
export function lerpAngle(a: number, b: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  // Smallest signed delta in (-PI, PI].
  let diff = (b - a) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  else if (diff < -Math.PI) diff += TWO_PI;
  return a + diff * t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface Snapshot {
  t: number;
  p: Vec3;
  r: Rot;
}

// Pick interpolated {p,r} for renderTime from a time-sorted (ascending t) buffer.
// Returns null if the buffer is empty. Clamps to the ends when renderTime is
// outside the buffered window. Stale samples (older than the straddling pair) are
// simply never selected because we scan to the latest pair bracketing renderTime.
export function sampleBuffer(
  buf: Snapshot[],
  renderTime: number,
): { p: Vec3; r: Rot } | null {
  if (buf.length === 0) return null;

  const first = buf[0]!;
  const last = buf[buf.length - 1]!;

  if (buf.length === 1 || renderTime <= first.t) {
    return { p: [...first.p] as Vec3, r: [...first.r] as Rot };
  }
  if (renderTime >= last.t) {
    return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
  }

  // Find the adjacent pair (lo, hi) such that lo.t <= renderTime < hi.t.
  for (let i = 1; i < buf.length; i++) {
    const hi = buf[i]!;
    if (renderTime < hi.t) {
      const lo = buf[i - 1]!;
      const span = hi.t - lo.t;
      const t = span > 0 ? (renderTime - lo.t) / span : 0;
      return {
        p: lerpVec3(lo.p, hi.p, t),
        r: [lerpAngle(lo.r[0], hi.r[0], t), lerpAngle(lo.r[1], hi.r[1], t)],
      };
    }
  }

  // Unreachable (renderTime < last.t guaranteed above), but keep TS happy.
  return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
}
