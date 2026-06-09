// src/controls.ts
// First-person controls: PointerLock mouse-look + WASD/jump/gravity with clamped delta, plus
// crouch, ladders, fast sprint (unlimited), spring-boot super-jump, parachute glide, fall
// damage, ziplines, doors, and a screen-shake hook. Movement tunables here are CLIENT-ONLY.
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { Octree } from "three/addons/math/Octree.js";
import { Capsule } from "three/addons/math/Capsule.js";
import { resolveCollision } from "./physics";
import {
  EYE_HEIGHT, CROUCH_EYE_HEIGHT,
  PARACHUTE_FALL_SPEED, PARACHUTE_GLIDE_SPEED,
  FALL_SAFE_DIST, FALL_DMG_PER_UNIT, SPRING_JUMP_MULT, ZIPLINES, KZ_FLOOR,
  type Vec3, type Rot,
} from "../worker/protocol";
import type { Ladder } from "./map";

// ---- Pure client-only movement tunables ----
export const GRAVITY = 30;          // units/sec^2 (downward)
export const JUMP_SPEED = 9;        // initial upward velocity on jump
export const MOVE_SPEED = 40;       // ground acceleration factor
export const SPRINT_MULT = 2.1;     // accel multiplier while sprinting (Shift) — faster than before
export const DAMPING_GROUND = 8;    // velocity damping per second while grounded
export const DAMPING_AIR = 0.2;     // velocity damping per second while airborne
export const MAX_DELTA = 0.1;       // clamp render delta (seconds) after tab switches
export const CLIMB_SPEED = 5.5;     // vertical speed while on a ladder (within the server clamp)
export const CROUCH_SPEED_MULT = 0.55; // movement multiplier while crouched
// Hard cap on horizontal speed = the sprint steady-state (accel / ground damping). Airborne
// damping is tiny, so without this cap repeated jumps would let horizontal speed run away far
// above the ground speed (the "jumping makes you faster" bug). Stays well under the server
// anti-teleport clamp (MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE), so it never rubber-bands.
export const MAX_GROUND_SPEED = (MOVE_SPEED * SPRINT_MULT) / DAMPING_GROUND; // ~10.5 u/s
export const ZIP_SPEED = 24;        // ride speed along a zipline (units/sec)
const FEET_OFFSET = 0.35;           // capsule.start.y above the ground (feet)

// Pure: acceleration factor for this frame. Airborne control is reduced; Shift sprints.
export function moveAccel(onFloor: boolean, sprinting: boolean): number {
  return MOVE_SPEED * (onFloor ? 1 : 0.3) * (sprinting ? SPRINT_MULT : 1);
}

// Pure: scale a horizontal (x,z) velocity so its magnitude never exceeds `max`.
export function clampHorizontalSpeed(vx: number, vz: number, max: number = MAX_GROUND_SPEED): [number, number] {
  const sp = Math.hypot(vx, vz);
  if (sp <= max || sp === 0) return [vx, vz];
  const s = max / sp;
  return [vx * s, vz * s];
}

// Pure: fall damage for a drop of `fallDist` units (0 below the safe distance).
export function fallDamage(fallDist: number): number {
  return fallDist > FALL_SAFE_DIST ? (fallDist - FALL_SAFE_DIST) * FALL_DMG_PER_UNIT : 0;
}

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

// Pure: is the capsule (XZ at end.x/z, feet at feetY, head at endY) inside a ladder volume,
// and still below its top (so climbing is possible)?
export function ladderContains(l: Ladder, x: number, z: number, feetY: number, endY: number): boolean {
  return x >= l.minX && x <= l.maxX && z >= l.minZ && z <= l.maxZ && feetY < l.topY - 0.1 && endY > l.baseY;
}

interface ZipRide { from: Vec3; to: Vec3; t: number; len: number; }

export class FpsControls {
  readonly controls: PointerLockControls;
  readonly collider: Capsule;
  private octree: Octree;
  private ladders: Ladder[];
  private camera: THREE.PerspectiveCamera;
  private velocity = new THREE.Vector3();
  private onFloor = false;
  private keys: KeyState = { w: false, a: false, s: false, d: false };
  private wantJump = false;
  private sprinting = false;
  private wantCrouch = false;
  private curSeg = EYE_HEIGHT - FEET_OFFSET; // current capsule segment height (eye above feet)
  private lockChangeCbs: ((locked: boolean) => void)[] = [];

  // New mechanics state.
  private parachuteOpen = false;       // gliding under canopy
  private springUntil = 0;             // performance.now() ms the spring boots expire (0 = none)
  private zip: ZipRide | null = null;  // active zipline ride
  private peakY = EYE_HEIGHT;          // highest y reached since leaving the ground (fall tracking)
  private wasGrounded = true;          // grounded-or-laddered last frame
  private shakeAmt = 0;                // current screen-shake magnitude
  private onFallCb?: (dmg: number) => void;
  private doorOctree: Octree | null = null; // dynamic collision for closed doors
  private onUseCb?: (pos: Vec3) => void;     // E pressed on the ground (door / interact)

  // scratch vectors (avoid per-frame allocation)
  private fwdDir = new THREE.Vector3();
  private rightDir = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, octree: Octree, ladders: Ladder[] = []) {
    this.camera = camera;
    this.octree = octree;
    this.ladders = ladders;
    this.controls = new PointerLockControls(camera, dom);
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
  unlock(): void { this.controls.unlock(); }
  get isLocked(): boolean { return this.controls.isLocked; }
  get isCrouching(): boolean { return this.wantCrouch; }

  // ---- new-feature accessors (read by main.ts for the InMsg + HUD) ----
  isParachuting(): boolean { return this.parachuteOpen; }
  springRemainingMs(): number { return Math.max(0, this.springUntil - performance.now()); }
  // Offer the parachute only while falling (and not already gliding / on a zipline).
  canParachute(): boolean { return !this.onFloor && !this.parachuteOpen && !this.zip && this.velocity.y < -1; }
  isZipping(): boolean { return this.zip !== null; }
  get isGrounded(): boolean { return this.onFloor; }
  // Closed doors collide via a separate octree that can change at runtime.
  setDoorOctree(o: Octree | null): void { this.doorOctree = o; }
  // E-on-the-ground interaction (open/close a nearby door); parachute is handled separately.
  onUse(cb: (pos: Vec3) => void): void { this.onUseCb = cb; }
  nearZipline(): boolean {
    if (this.zip) return false;
    const e = this.collider.end;
    return ZIPLINES.some((z) => Math.hypot(e.x - z.a[0], e.y - z.a[1], e.z - z.a[2]) < 4.5);
  }

  // Grant a timed spring-boot super-jump (called when the pickup is taken).
  grantSpring(durationMs: number): void { this.springUntil = performance.now() + durationMs; }
  // Add a screen-shake impulse (explosions / hard landings).
  addShake(amount: number): void { this.shakeAmt = Math.min(0.7, this.shakeAmt + amount); }
  // Register the fall-damage callback (main sends a FallMsg).
  onFall(cb: (dmg: number) => void): void { this.onFallCb = cb; }

  onLockChange(cb: (locked: boolean) => void): void { this.lockChangeCbs.push(cb); }

  setPosition(p: Vec3): void {
    this.curSeg = EYE_HEIGHT - FEET_OFFSET; // stand up on (re)spawn
    this.placeCollider(p);
    this.velocity.set(0, 0, 0);
    this.parachuteOpen = false;
    this.zip = null;
    this.springUntil = 0; // drop spring boots on (re)spawn / match start
    this.peakY = p[1];
    this.wasGrounded = true;
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

  update(dtSec: number): void {
    const dt = clampDelta(dtSec);
    if (dt === 0) return;

    // Zipline ride overrides normal movement.
    if (this.zip) { this.updateZip(dt); this.applyShake(dt); return; }

    // Crouch: smoothly shrink the capsule (eye drops toward the feet).
    const targetSeg = (this.isLocked && this.wantCrouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT) - FEET_OFFSET;
    this.curSeg += (targetSeg - this.curSeg) * Math.min(1, dt * 12);
    this.collider.end.y = this.collider.start.y + this.curSeg;

    const onLadder = this.isLocked && this.onLadder();
    const grounded = this.onFloor || onLadder;
    if (grounded && this.parachuteOpen) this.parachuteOpen = false; // canopy collapses on landing

    const intent = axisFromKeys(this.keys);
    const canSprint = this.sprinting && !this.wantCrouch; // unlimited sprint (no stamina)

    // Gravity (suspended on a ladder) + damping.
    if (!grounded) this.velocity.y -= GRAVITY * dt;
    const damping = Math.exp(-(grounded ? DAMPING_GROUND : DAMPING_AIR) * dt) - 1;
    this.velocity.addScaledVector(this.velocity, damping);

    // Horizontal movement intent relative to look direction (+ ladder climb / jump).
    if (this.isLocked) {
      this.getForwardVector(this.fwdDir);
      this.getRightVector(this.rightDir);
      const accel = moveAccel(grounded, canSprint) * (this.wantCrouch ? CROUCH_SPEED_MULT : 1);
      this.velocity.addScaledVector(this.fwdDir, intent.fwd * accel * dt);
      this.velocity.addScaledVector(this.rightDir, intent.right * accel * dt);
      if (onLadder) {
        const climb = (this.keys.w || this.wantJump ? 1 : 0) - (this.keys.s ? 1 : 0);
        this.velocity.y = climb * CLIMB_SPEED;
      } else if (this.wantJump && this.onFloor) {
        this.velocity.y = JUMP_SPEED * (this.springRemainingMs() > 0 ? SPRING_JUMP_MULT : 1);
      }
    }
    this.wantJump = false;

    // Parachute: cap the descent speed so you float down (and let you glide a bit faster).
    if (this.parachuteOpen && !grounded && this.velocity.y < -PARACHUTE_FALL_SPEED) {
      this.velocity.y = -PARACHUTE_FALL_SPEED;
    }

    // Cap horizontal speed (jump fix); a wider cap applies while gliding under canopy.
    const hcap = this.parachuteOpen && !grounded ? PARACHUTE_GLIDE_SPEED : MAX_GROUND_SPEED;
    const [cvx, cvz] = clampHorizontalSpeed(this.velocity.x, this.velocity.z, hcap);
    this.velocity.x = cvx;
    this.velocity.z = cvz;

    // Integrate then resolve against the world (and any closed doors).
    const step = this.velocity.clone().multiplyScalar(dt);
    this.collider.translate(step);
    this.onFloor = resolveCollision(this.collider, this.octree, this.velocity);
    if (this.doorOctree && resolveCollision(this.collider, this.doorOctree, this.velocity)) this.onFloor = true;

    // Fall tracking (a ladder counts as grounded so climbing down isn't a "fall").
    const onLadderNow = this.isLocked && this.onLadder();
    const fallGrounded = this.onFloor || onLadderNow;
    const y = this.collider.end.y;
    if (fallGrounded) {
      if (!this.wasGrounded) {
        const fallDist = this.peakY - y;
        if (!this.parachuteOpen) {
          const dmg = fallDamage(fallDist);
          if (dmg > 0) { this.onFallCb?.(dmg); this.addShake(Math.min(0.4, dmg / 140)); }
        }
        this.parachuteOpen = false;
      }
      this.peakY = y;
    } else {
      this.peakY = Math.max(this.peakY, y);
    }
    this.wasGrounded = fallGrounded;

    // Fell below the world (issue #23): the SERVER applies an out-of-bounds suicide + respawn
    // (worker/game-core ingestInput checks KZ_FLOOR). Don't silently teleport to center — that
    // hid the fall from the server and let players escape fights. Just stop falling here; the
    // normal death/respawn flow repositions us (spawn -> controls.setPosition).
    if (this.collider.end.y < KZ_FLOOR) this.velocity.set(0, 0, 0);

    this.syncCameraToCollider();
    this.applyShake(dt);
  }

  dispose(): void {
    this.controls.removeEventListener("lock", this.onLock);
    this.controls.removeEventListener("unlock", this.onUnlock);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
  }

  private onLock = (): void => { for (const cb of this.lockChangeCbs) cb(true); };
  private onUnlock = (): void => { for (const cb of this.lockChangeCbs) cb(false); };

  private placeCollider(p: Vec3): void {
    this.collider.end.set(p[0], p[1], p[2]);
    this.collider.start.set(p[0], p[1] - this.curSeg, p[2]);
  }

  private syncCameraToCollider(): void {
    this.camera.position.copy(this.collider.end);
  }

  private applyShake(dt: number): void {
    if (this.shakeAmt <= 0.0001) return;
    const a = this.shakeAmt;
    this.camera.position.x += (Math.random() - 0.5) * a * 0.5;
    this.camera.position.y += (Math.random() - 0.5) * a * 0.5;
    this.camera.position.z += (Math.random() - 0.5) * a * 0.5;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.8);
  }

  // Attach to / detach from a zipline (F). Attach only when near a zipline's top start point.
  private toggleZip(): void {
    if (this.zip) {
      // Measure any subsequent fall from the detach point, NOT the frozen pre-ride tower peak.
      this.peakY = this.collider.end.y;
      this.wasGrounded = false;
      this.velocity.set(0, 0, 0);
      this.zip = null;
      return;
    }
    const e = this.collider.end;
    for (const z of ZIPLINES) {
      if (Math.hypot(e.x - z.a[0], e.y - z.a[1], e.z - z.a[2]) < 4.5) {
        this.zip = { from: [z.a[0], z.a[1], z.a[2]], to: [z.b[0], z.b[1], z.b[2]], t: 0, len: Math.hypot(z.b[0] - z.a[0], z.b[1] - z.a[1], z.b[2] - z.a[2]) || 1 };
        this.velocity.set(0, 0, 0);
        return;
      }
    }
  }

  private updateZip(dt: number): void {
    const z = this.zip!;
    z.t += (ZIP_SPEED * dt) / z.len;
    if (z.t >= 1 || !this.isLocked) {
      this.placeCollider(z.to);
      // small forward hop off the end so you don't drop straight down
      this.velocity.set(0, -1, 0);
      this.zip = null;
      this.onFloor = false;
      this.peakY = z.to[1];
      this.wasGrounded = false;
      this.syncCameraToCollider();
      return;
    }
    const x = z.from[0] + (z.to[0] - z.from[0]) * z.t;
    const y = z.from[1] + (z.to[1] - z.from[1]) * z.t;
    const zz = z.from[2] + (z.to[2] - z.from[2]) * z.t;
    this.placeCollider([x, y, zz]);
    this.syncCameraToCollider();
  }

  // True when the capsule is within a ladder volume (and not yet over its top).
  private onLadder(): boolean {
    const ex = this.collider.end.x, ez = this.collider.end.z, feet = this.collider.start.y, head = this.collider.end.y;
    for (const l of this.ladders) {
      if (ladderContains(l, ex, ez, feet, head)) return true;
    }
    return false;
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
    // Crouching with Ctrl held would otherwise let Ctrl+key browser shortcuts through; suppress
    // the page default for the Ctrl crouch keys (note: Ctrl+W tab-close can't be fully blocked).
    if (e.code === "ControlLeft" || e.code === "ControlRight") e.preventDefault();
    switch (e.code) {
      case "KeyW": this.keys.w = true; break;
      case "KeyA": this.keys.a = true; break;
      case "KeyS": this.keys.s = true; break;
      case "KeyD": this.keys.d = true; break;
      case "Space": this.wantJump = true; break;
      case "ShiftLeft": case "ShiftRight": this.sprinting = true; break;
      case "KeyC": case "ControlLeft": case "ControlRight": this.wantCrouch = true; break;
      // E is contextual: on the ground it interacts (open/close a door); airborne it parachutes.
      case "KeyE":
        if (!this.isLocked) break;
        if (this.onFloor) this.onUseCb?.(this.getPosition());
        else this.toggleParachute();
        break;
      case "KeyF": if (this.isLocked) this.toggleZip(); break;
    }
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case "KeyW": this.keys.w = false; break;
      case "KeyA": this.keys.a = false; break;
      case "KeyS": this.keys.s = false; break;
      case "KeyD": this.keys.d = false; break;
      case "ShiftLeft": case "ShiftRight": this.sprinting = false; break;
      case "KeyC": case "ControlLeft": case "ControlRight": this.wantCrouch = false; break;
    }
  };

  // Open the parachute only while airborne (it auto-closes on landing). Pressing E again cuts it.
  // Reset the fall baseline on both open and cut so any free-fall is charged from here, not the
  // pre-deploy apex (otherwise cutting the chute would apply the whole drop as fatal fall damage).
  private toggleParachute(): void {
    if (this.parachuteOpen) { this.parachuteOpen = false; this.peakY = this.collider.end.y; return; }
    if (!this.onFloor) { this.parachuteOpen = true; this.peakY = this.collider.end.y; }
  }
}
