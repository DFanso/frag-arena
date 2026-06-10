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
  v?: Vec3; // world-units/sec; enables cubic sampling + extrapolation when present
}

export const EXTRAPOLATE_MAX_MS = 100; // never project a remote further than this past its last snap

// Cubic Hermite on one axis: positions p0/p1, tangents m0/m1 scaled to the segment duration.
function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0
       + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

// Pick interpolated {p,r} for renderTime from a time-sorted (ascending t) buffer.
// With per-snapshot velocities this is cubic Hermite (smooth through direction changes,
// spec 2026-06-10) plus bounded dead-reckoning past the newest snapshot; without them it
// falls back to the original linear behavior. Returns null only when the buffer is empty.
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
    // Buffer ran dry: project along the last known velocity, hard-capped so a dropped
    // stream parks the player nearby instead of sending them through a wall.
    if (!last.v) return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
    const dt = Math.min(renderTime - last.t, EXTRAPOLATE_MAX_MS) / 1000;
    return {
      p: [last.p[0] + last.v[0] * dt, last.p[1] + last.v[1] * dt, last.p[2] + last.v[2] * dt],
      r: [...last.r] as Rot,
    };
  }

  // Find the adjacent pair (lo, hi) such that lo.t <= renderTime < hi.t.
  for (let i = 1; i < buf.length; i++) {
    const hi = buf[i]!;
    if (renderTime < hi.t) {
      const lo = buf[i - 1]!;
      const span = hi.t - lo.t;
      const t = span > 0 ? (renderTime - lo.t) / span : 0;
      const r: Rot = [lerpAngle(lo.r[0], hi.r[0], t), lerpAngle(lo.r[1], hi.r[1], t)];
      if (lo.v && hi.v && span > 0) {
        const s = span / 1000; // tangents are u/s; scale into the segment's parameter space
        return {
          p: [
            hermite(lo.p[0], lo.v[0] * s, hi.p[0], hi.v[0] * s, t),
            hermite(lo.p[1], lo.v[1] * s, hi.p[1], hi.v[1] * s, t),
            hermite(lo.p[2], lo.v[2] * s, hi.p[2], hi.v[2] * s, t),
          ],
          r,
        };
      }
      return { p: lerpVec3(lo.p, hi.p, t), r };
    }
  }

  // Unreachable (renderTime < last.t guaranteed above), but keep TS happy.
  return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
}
