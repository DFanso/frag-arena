// src/player.ts
// LocalPlayer: client prediction + reconciliation (seq counter, InMsg builder).
// RemotePlayer: GLTF animated character + invisible hit-proxy + nameplate sprite.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { INTERP_DELAY_MS, EYE_HEIGHT, MAX_HP, type Vec3, type Rot, type InMsg } from "../worker/protocol";
import { sampleBuffer, type Snapshot } from "./interp";
import { pickAnim } from "./anim";
import { healthFraction, healthColor } from "./health-ui";
import { playerColor } from "./colors";

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
const PLAYER_HEIGHT = 1.7; // visible character + hit-proxy height (feet at y=0 .. head at 1.7)

export class RemotePlayer {
  readonly id: number;
  readonly group: THREE.Group;
  readonly body: THREE.Mesh; // invisible raycast proxy (userData.playerId)
  private nameplate: THREE.Sprite;
  private healthBar: THREE.Sprite;
  private healthCanvas: HTMLCanvasElement;
  private healthCtx: CanvasRenderingContext2D;
  private healthTex: THREE.CanvasTexture;
  private lastHp = MAX_HP;
  private buffer: Snapshot[] = [];
  private speedXZ = 0;
  private shootingUntil = 0;

  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current: THREE.AnimationAction | null = null;
  private modelMats: THREE.Material[] = []; // per-instance cloned materials (for disposal)

  constructor(id: number, name: string, character: GLTF | null) {
    this.id = id;
    this.group = new THREE.Group();

    // Invisible-but-raycastable proxy (raycaster skips visible:false, so use opacity 0).
    // Sized + positioned to match the visible character (feet at 0 .. head at PLAYER_HEIGHT)
    // so aiming at the on-screen player actually hits the raycast target.
    const proxyMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
    });
    this.body = new THREE.Mesh(new THREE.BoxGeometry(0.8, PLAYER_HEIGHT, 0.6), proxyMat);
    this.body.position.y = PLAYER_HEIGHT / 2;
    this.body.userData.playerId = id;
    this.group.add(this.body);

    if (character) {
      const model = cloneSkeleton(character.scene);
      // Scale to a consistent player height regardless of the model's native units,
      // then anchor its feet at the group origin (y=0).
      model.updateMatrixWorld(true);
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(model).getSize(size);
      model.scale.setScalar(PLAYER_HEIGHT / (size.y || 1));
      model.updateMatrixWorld(true);
      const fitted = new THREE.Box3().setFromObject(model);
      model.position.y = -fitted.min.y; // lift so the lowest point (feet) sits at y=0
      // Tint this player's body a deterministic per-id color. Materials are SHARED across
      // SkeletonUtils clones, so clone them per-instance before recoloring.
      const tint = playerColor(id);
      const applyTint = (m: THREE.Material): THREE.Material => {
        const cloned = m.clone();
        const sm = cloned as THREE.MeshStandardMaterial;
        if (sm.color) sm.color.setHex(tint);
        this.modelMats.push(cloned);
        return cloned;
      };
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(applyTint)
          : applyTint(mesh.material);
      });
      this.group.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of character.animations) {
        this.actions[clip.name] = this.mixer.clipAction(clip);
      }
      this.current = this.actions["Idle"] ?? null;
      this.current?.play();
    } else {
      // Fallback: a box tinted with this player's color.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, PLAYER_HEIGHT, 0.6),
        new THREE.MeshStandardMaterial({ color: playerColor(id) }),
      );
      box.position.y = PLAYER_HEIGHT / 2;
      box.castShadow = true;
      this.group.add(box);
    }

    this.nameplate = RemotePlayer.makeNameplate(name);
    this.nameplate.position.y = 2.25;
    this.nameplate.userData.noHit = true;
    this.group.add(this.nameplate);

    // Enemy health bar (billboard just below the nameplate, above the head).
    this.healthCanvas = document.createElement("canvas");
    this.healthCanvas.width = 128;
    this.healthCanvas.height = 16;
    this.healthCtx = this.healthCanvas.getContext("2d")!;
    this.healthTex = new THREE.CanvasTexture(this.healthCanvas);
    this.healthBar = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.healthTex, depthTest: false }),
    );
    this.healthBar.scale.set(1.0, 0.13, 1);
    this.healthBar.position.y = 1.98;
    this.healthBar.userData.noHit = true;
    this.group.add(this.healthBar);
    this.drawHealth(MAX_HP);
  }

  // Redraw the health bar canvas (dark track + colored fill proportional to hp).
  private drawHealth(hp: number): void {
    const frac = healthFraction(hp, MAX_HP);
    const c = this.healthCtx;
    const w = this.healthCanvas.width;
    const h = this.healthCanvas.height;
    const pad = 2;
    c.clearRect(0, 0, w, h);
    c.fillStyle = "rgba(0,0,0,0.6)";
    c.fillRect(0, 0, w, h);
    c.fillStyle = healthColor(frac);
    c.fillRect(pad, pad, (w - 2 * pad) * frac, h - 2 * pad);
    this.healthTex.needsUpdate = true;
  }

  // Update the enemy's health bar from the latest snapshot (no-op if unchanged).
  setHealth(hp: number): void {
    if (hp === this.lastHp) return;
    this.lastHp = hp;
    this.drawHealth(hp);
  }

  // Show/hide the whole player (dead players vanish instantly, reappear on respawn).
  setAlive(alive: boolean): void {
    this.group.visible = alive;
  }

  // Snap to a new position and drop buffered history (used on respawn so the player
  // appears at the spawn point instead of sliding across the map from the death spot).
  resetTo(p: Vec3): void {
    this.buffer.length = 0;
    this.group.position.set(p[0], p[1] - EYE_HEIGHT, p[2]);
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
      // Server p is the eye position (y = EYE_HEIGHT); subtract it so the group origin
      // (the character's feet + proxy base) sits on the ground.
      this.group.position.set(sample.p[0], sample.p[1] - EYE_HEIGHT, sample.p[2]);
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
    this.healthTex.dispose();
    this.healthBar.material.dispose();
    for (const m of this.modelMats) m.dispose(); // per-instance cloned tints
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
