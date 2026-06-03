// src/controls.ts
// First-person controls: PointerLock mouse-look + WASD/jump/gravity with clamped delta.
// Movement tunables here are CLIENT-ONLY (not shared wire constants in worker/protocol.ts).
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { Octree } from "three/addons/math/Octree.js";
import { Capsule } from "three/addons/math/Capsule.js";
import { resolveCollision } from "./physics";
import { EYE_HEIGHT, type Vec3, type Rot } from "../worker/protocol";

// ---- Pure client-only movement tunables ----
export const GRAVITY = 30;          // units/sec^2 (downward)
export const JUMP_SPEED = 9;        // initial upward velocity on jump
export const MOVE_SPEED = 40;       // ground acceleration factor
export const DAMPING_GROUND = 8;    // velocity damping per second while grounded
export const DAMPING_AIR = 0.2;     // velocity damping per second while airborne
export const MAX_DELTA = 0.1;       // clamp render delta (seconds) after tab switches

export interface KeyState { w: boolean; a: boolean; s: boolean; d: boolean; }
export interface MoveAxis { fwd: number; right: number; }

// Pure: clamp a raw frame delta (seconds) into [0, MAX_DELTA].
export function clampDelta(rawSeconds: number): number {
  if (Number.isNaN(rawSeconds) || rawSeconds < 0) return 0;
  return Math.min(rawSeconds, MAX_DELTA);
}

// Pure: map held keys to a normalized movement intent (opposing keys cancel).
export function axisFromKeys(keys: KeyState): MoveAxis {
  const fwd = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const right = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  return { fwd, right };
}

export class FpsControls {
  readonly controls: PointerLockControls;
  readonly collider: Capsule;
  private octree: Octree;
  private camera: THREE.PerspectiveCamera;
  private velocity = new THREE.Vector3();
  private onFloor = false;
  private keys: KeyState = { w: false, a: false, s: false, d: false };
  private wantJump = false;
  private lockChangeCbs: ((locked: boolean) => void)[] = [];

  // scratch vectors (avoid per-frame allocation)
  private fwdDir = new THREE.Vector3();
  private rightDir = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, octree: Octree) {
    this.camera = camera;
    this.octree = octree;
    this.controls = new PointerLockControls(camera, dom);
    // getObject() was removed: PointerLockControls IS the camera-holder now.
    // Collider rides from feet to eye; camera sits on collider.end.
    this.collider = new Capsule(
      new THREE.Vector3(0, 0.35, 0),
      new THREE.Vector3(0, EYE_HEIGHT, 0),
      0.35,
    );
    this.syncCameraToCollider();

    this.controls.addEventListener("lock", this.onLock);
    this.controls.addEventListener("unlock", this.onUnlock);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
  }

  lock(): void { this.controls.lock(); }
  get isLocked(): boolean { return this.controls.isLocked; }

  // Subscribe to PointerLock lock/unlock transitions (true = locked).
  onLockChange(cb: (locked: boolean) => void): void {
    this.lockChangeCbs.push(cb);
  }

  // Teleport the player (used by reconciliation / spawn).
  setPosition(p: Vec3): void {
    const dy = this.collider.end.y - this.collider.start.y;
    this.collider.end.set(p[0], p[1], p[2]);
    this.collider.start.set(p[0], p[1] - dy, p[2]);
    this.velocity.set(0, 0, 0);
    this.syncCameraToCollider();
  }

  getPosition(): Vec3 {
    return [this.collider.end.x, this.collider.end.y, this.collider.end.z];
  }
  getRotation(): Rot {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    return [e.y, e.x];
  }
  getVelocity(): Vec3 {
    return [this.velocity.x, this.velocity.y, this.velocity.z];
  }

  // Advance one frame. `dtSec` is the raw render delta in SECONDS; it is clamped
  // internally (defensive) so a tab-switch spike cannot teleport the player.
  update(dtSec: number): void {
    const dt = clampDelta(dtSec);
    if (dt === 0) return;

    // Gravity + damping.
    if (!this.onFloor) {
      this.velocity.y -= GRAVITY * dt;
    }
    const damping = Math.exp(-(this.onFloor ? DAMPING_GROUND : DAMPING_AIR) * dt) - 1;
    this.velocity.addScaledVector(this.velocity, damping);

    // Horizontal movement intent relative to look direction.
    if (this.isLocked) {
      const axis = axisFromKeys(this.keys);
      this.getForwardVector(this.fwdDir);
      this.getRightVector(this.rightDir);
      const accel = MOVE_SPEED * (this.onFloor ? 1 : 0.3);
      this.velocity.addScaledVector(this.fwdDir, axis.fwd * accel * dt);
      this.velocity.addScaledVector(this.rightDir, axis.right * accel * dt);
      if (this.wantJump && this.onFloor) {
        this.velocity.y = JUMP_SPEED;
      }
    }
    this.wantJump = false;

    // Integrate then resolve against the world each frame (velocity REQUIRED).
    const step = this.velocity.clone().multiplyScalar(dt);
    this.collider.translate(step);
    this.onFloor = resolveCollision(this.collider, this.octree, this.velocity);

    // Fell out of the world: respawn at origin-ish.
    if (this.collider.end.y < -25) {
      this.setPosition([0, EYE_HEIGHT, 0]);
    }
    this.syncCameraToCollider();
  }

  dispose(): void {
    this.controls.removeEventListener("lock", this.onLock);
    this.controls.removeEventListener("unlock", this.onUnlock);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
  }

  private onLock = (): void => {
    for (const cb of this.lockChangeCbs) cb(true);
  };
  private onUnlock = (): void => {
    for (const cb of this.lockChangeCbs) cb(false);
  };

  private syncCameraToCollider(): void {
    this.camera.position.copy(this.collider.end);
  }

  private getForwardVector(out: THREE.Vector3): THREE.Vector3 {
    this.camera.getWorldDirection(out);
    out.y = 0;
    out.normalize();
    return out;
  }
  private getRightVector(out: THREE.Vector3): THREE.Vector3 {
    this.camera.getWorldDirection(out);
    out.y = 0;
    out.normalize();
    out.cross(this.camera.up);
    return out;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keys.w = true; break;
      case "KeyA": this.keys.a = true; break;
      case "KeyS": this.keys.s = true; break;
      case "KeyD": this.keys.d = true; break;
      case "Space": this.wantJump = true; break;
    }
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keys.w = false; break;
      case "KeyA": this.keys.a = false; break;
      case "KeyS": this.keys.s = false; break;
      case "KeyD": this.keys.d = false; break;
    }
  };
}
