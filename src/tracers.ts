// src/tracers.ts — pooled bullet tracers (issue #67): a short bright streak races from the
// muzzle to the impact point so hitscan fire is visible, locally and for remote shooters.
// Purely cosmetic — hit detection stays server-authoritative. A fixed-size pool of meshes is
// recycled (oldest-first when full) so sustained auto-fire allocates nothing per shot.
import * as THREE from "three";
import type { Vec3 } from "../worker/protocol";

// Hard cap on simultaneously-live tracers. 16 players × ~8 rifle rounds/sec × ~0.25s life is
// well under this; beyond the cap the oldest streak is recycled early (visually harmless).
export const TRACER_POOL_SIZE = 64;

// Per-weapon styling: the rifle is a subtle thin streak, the sniper a brighter/thicker beam.
export interface TracerStyle { color: number; thickness: number; length: number; speed: number; opacity: number; }
export const TRACER_STYLES: readonly TracerStyle[] = [
  { color: 0xffd9a0, thickness: 0.03, length: 7,  speed: 450, opacity: 0.85 }, // 0 Rifle
  { color: 0xfff3cf, thickness: 0.06, length: 16, speed: 700, opacity: 1.0 },  // 1 Sniper
];
export function tracerStyle(weaponId: number): TracerStyle {
  return TRACER_STYLES[weaponId] ?? TRACER_STYLES[0]!;
}

// Pure: the visible [a, b] span (distances from the start) of a streak of length `len` whose
// head has travelled `head` units along a ray of total length `dist`. Null once fully past the
// end. The head clamps at the impact while the tail catches up, so the streak "absorbs" into
// the surface instead of vanishing or overshooting.
export function streakSpan(head: number, len: number, dist: number): { a: number; b: number } | null {
  const a = head - len;
  if (a >= dist) return null;
  return { a: Math.max(0, a), b: Math.min(dist, head) };
}

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  active: boolean;
  start: THREE.Vector3;
  dir: THREE.Vector3; // unit
  dist: number;       // total ray length
  head: number;       // distance the streak head has travelled
  speed: number;
  len: number;
  thickness: number;
}

export class Tracers {
  private slots: Slot[] = [];
  private next = 0; // ring index for recycling when every slot is live
  // Unit box stretched per-frame into the streak segment (shared across all slots).
  private geo = new THREE.BoxGeometry(1, 1, 1);
  private static UP_Z = new THREE.Vector3(0, 0, 1);

  constructor(private scene: THREE.Scene) {}

  /** Live streak count (for tests / debugging). */
  activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  // Launch a streak from `from` toward `to`, styled per weapon. Reuses an idle pool slot,
  // grows the pool up to TRACER_POOL_SIZE, then recycles the oldest live streak.
  spawn(from: Vec3, to: Vec3, weaponId: number): void {
    const style = tracerStyle(weaponId);
    const slot = this.acquire();
    slot.start.set(from[0], from[1], from[2]);
    slot.dir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    slot.dist = slot.dir.length();
    if (slot.dist < 0.001) { slot.active = false; slot.mesh.visible = false; return; }
    slot.dir.multiplyScalar(1 / slot.dist);
    slot.head = 0;
    slot.speed = style.speed;
    slot.len = style.length;
    slot.thickness = style.thickness;
    slot.mat.color.setHex(style.color);
    slot.mat.opacity = style.opacity;
    slot.active = true;
    slot.mesh.visible = false; // positioned on the next update tick
    slot.mesh.quaternion.setFromUnitVectors(Tracers.UP_Z, slot.dir);
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.head += s.speed * dt;
      const span = streakSpan(s.head, s.len, s.dist);
      if (span === null) { s.active = false; s.mesh.visible = false; continue; }
      const segLen = Math.max(0.01, span.b - span.a);
      const mid = (span.a + span.b) / 2;
      s.mesh.position.set(
        s.start.x + s.dir.x * mid,
        s.start.y + s.dir.y * mid,
        s.start.z + s.dir.z * mid,
      );
      s.mesh.scale.set(s.thickness, s.thickness, segLen);
      s.mesh.visible = true;
    }
  }

  // Find an idle slot, or create one (≤ pool cap), or recycle round-robin.
  private acquire(): Slot {
    for (const s of this.slots) if (!s.active) return s;
    if (this.slots.length < TRACER_POOL_SIZE) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false, // glow shouldn't punch holes in later transparents
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.userData["noHit"] = true; // never a raycast target
      this.scene.add(mesh);
      const slot: Slot = {
        mesh, mat, active: false,
        start: new THREE.Vector3(), dir: new THREE.Vector3(),
        dist: 0, head: 0, speed: 0, len: 0, thickness: 0,
      };
      this.slots.push(slot);
      return slot;
    }
    const slot = this.slots[this.next]!;
    this.next = (this.next + 1) % this.slots.length;
    return slot;
  }

  dispose(): void {
    for (const s of this.slots) { this.scene.remove(s.mesh); s.mat.dispose(); }
    this.slots = [];
    this.geo.dispose();
  }
}
