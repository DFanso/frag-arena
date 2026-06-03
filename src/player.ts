// src/player.ts
// LocalPlayer: client prediction + reconciliation (seq counter, InMsg builder).
// RemotePlayer: snapshot interpolation (blocky body + nameplate sprite).
import * as THREE from "three";
import { INTERP_DELAY_MS, type Vec3, type Rot, type InMsg } from "../worker/protocol";
import { sampleBuffer, type Snapshot } from "./interp";

// Snap the local player to the server position only when divergence exceeds this (world units).
export const RECONCILE_DIST = 2.0;

// Owns the input seq counter and the reconciliation decision for the net layer.
export class LocalPlayer {
  id: number;
  private seq = 0;

  constructor(id: number) {
    this.id = id;
  }

  // Return the current seq, THEN increment (first call returns 1).
  nextSeq(): number {
    return ++this.seq;
  }

  // Build the next InMsg from explicit p/r/v + timestamp, bumping the seq counter.
  buildInput(p: Vec3, r: Rot, v: Vec3, tsMs: number): InMsg {
    return {
      t: "in",
      seq: this.nextSeq(),
      ts: tsMs,
      p: [p[0], p[1], p[2]],
      r: [r[0], r[1]],
      v: [v[0], v[1], v[2]],
    };
  }

  // Returns the server position to snap to (3D distance beyond RECONCILE_DIST), else null.
  reconcile(predicted: Vec3, server: Vec3): Vec3 | null {
    const dx = predicted[0] - server[0];
    const dy = predicted[1] - server[1];
    const dz = predicted[2] - server[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return dist > RECONCILE_DIST ? [server[0], server[1], server[2]] : null;
  }
}

// A remote player: blocky body (raycast target) + nameplate sprite (excluded from raycast).
export class RemotePlayer {
  readonly id: number;
  readonly group: THREE.Group;
  readonly body: THREE.Mesh;
  private nameplate: THREE.Sprite;
  private buffer: Snapshot[] = [];

  constructor(id: number, name: string) {
    this.id = id;
    this.group = new THREE.Group();

    // Blocky body, roughly capsule-sized so visuals match the server collider.
    const geo = new THREE.BoxGeometry(0.7, 1.0, 0.7);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff5544 });
    this.body = new THREE.Mesh(geo, mat);
    this.body.position.y = 0.5; // box center at half-height above feet
    this.body.userData.playerId = id; // tag for raycasting (climb parents to find this)
    this.group.add(this.body);

    this.nameplate = RemotePlayer.makeNameplate(name);
    this.nameplate.position.y = 1.6;
    this.nameplate.userData.noHit = true; // excluded from raycast targets
    this.group.add(this.nameplate);
  }

  // Push a timestamped snapshot into the interpolation buffer (kept time-sorted).
  addSnapshot(s: Snapshot): void {
    this.buffer.push(s);
    // Drop anything older than ~1s behind the newest sample.
    const newest = s.t;
    while (this.buffer.length > 2 && this.buffer[0]!.t < newest - 1000) {
      this.buffer.shift();
    }
  }

  // Render this remote player INTERP_DELAY_MS in the past.
  update(nowMs: number): void {
    const sample = sampleBuffer(this.buffer, nowMs - INTERP_DELAY_MS);
    if (!sample) return;
    this.group.position.set(sample.p[0], sample.p[1], sample.p[2]);
    this.group.rotation.y = sample.r[0]; // yaw only for the body
  }

  dispose(): void {
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    const tex = (this.nameplate.material as THREE.SpriteMaterial).map;
    if (tex) tex.dispose();
    this.nameplate.material.dispose();
  }

  private static makeNameplate(name: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 32px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.375, 1);
    return sprite;
  }
}
