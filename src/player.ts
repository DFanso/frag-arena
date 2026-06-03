// src/player.ts
// LocalPlayer: client prediction + reconciliation (seq counter, InMsg builder).
// RemotePlayer: GLTF animated character + invisible hit-proxy + nameplate sprite.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { INTERP_DELAY_MS, type Vec3, type Rot, type InMsg } from "../worker/protocol";
import { sampleBuffer, type Snapshot } from "./interp";
import { pickAnim } from "./anim";

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

const SHOOT_CUE_MS = 350;

export class RemotePlayer {
  readonly id: number;
  readonly group: THREE.Group;
  readonly body: THREE.Mesh; // invisible raycast proxy (userData.playerId)
  private nameplate: THREE.Sprite;
  private buffer: Snapshot[] = [];
  private speedXZ = 0;
  private shootingUntil = 0;

  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current: THREE.AnimationAction | null = null;

  constructor(id: number, name: string, character: GLTF | null) {
    this.id = id;
    this.group = new THREE.Group();

    // Invisible-but-raycastable proxy (raycaster skips visible:false, so use opacity 0).
    const proxyMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
    });
    this.body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.7), proxyMat);
    this.body.position.y = 0.5;
    this.body.userData.playerId = id;
    this.group.add(this.body);

    if (character) {
      const model = cloneSkeleton(character.scene);
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      // RobotExpressive is ~ unit-tall already; scale/anchor so feet sit at y=0.
      model.position.y = 0;
      this.group.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of character.animations) {
        this.actions[clip.name] = this.mixer.clipAction(clip);
      }
      this.current = this.actions["Idle"] ?? null;
      this.current?.play();
    } else {
      // Fallback: the v1 colored box.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 1.0, 0.7),
        new THREE.MeshStandardMaterial({ color: 0xff5544 }),
      );
      box.position.y = 0.5;
      box.castShadow = true;
      this.group.add(box);
    }

    this.nameplate = RemotePlayer.makeNameplate(name);
    this.nameplate.position.y = 2.2;
    this.nameplate.userData.noHit = true;
    this.group.add(this.nameplate);
  }

  addSnapshot(s: Snapshot): void {
    this.buffer.push(s);
    const newest = s.t;
    while (this.buffer.length > 2 && this.buffer[0]!.t < newest - 1000) this.buffer.shift();
  }

  setVelocity(v: Vec3): void {
    this.speedXZ = Math.hypot(v[0], v[2]);
  }

  playShoot(): void {
    this.shootingUntil = performance.now() + SHOOT_CUE_MS;
    const punch = this.actions["Punch"] ?? this.actions["Wave"];
    if (punch) {
      punch.reset();
      punch.setLoop(THREE.LoopOnce, 1);
      punch.clampWhenFinished = true;
      punch.play();
    }
  }

  update(nowMs: number, dtMs: number): void {
    const sample = sampleBuffer(this.buffer, nowMs - INTERP_DELAY_MS);
    if (sample) {
      this.group.position.set(sample.p[0], sample.p[1] - 0.5, sample.p[2]); // feet at ground
      this.group.rotation.y = sample.r[0];
    }
    if (this.mixer) {
      const want = pickAnim(this.speedXZ, this.shootingUntil, nowMs).base;
      const next = this.actions[want];
      if (next && next !== this.current) {
        next.reset().play();
        if (this.current) this.current.crossFadeTo(next, 0.2, false);
        this.current = next;
      }
      this.mixer.update(dtMs / 1000);
    }
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    const tex = (this.nameplate.material as THREE.SpriteMaterial).map;
    if (tex) tex.dispose();
    this.nameplate.material.dispose();
    (this.body.material as THREE.Material).dispose();
    this.body.geometry.dispose();
  }

  private static makeNameplate(name: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 32px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.375, 1);
    return sprite;
  }
}
