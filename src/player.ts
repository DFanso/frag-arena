// src/player.ts
// LocalPlayer: client prediction + reconciliation (seq counter, InMsg builder).
// RemotePlayer: GLTF animated character + invisible hit-proxy + nameplate sprite.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { INTERP_DELAY_MS, EYE_HEIGHT, CROUCH_EYE_HEIGHT, MAX_HP, type Vec3, type Rot, type InMsg } from "../worker/protocol";
import { sampleBuffer, type Snapshot } from "./interp";
import { pickAnim } from "./anim";
import { healthFraction, healthColor } from "./health-ui";

// Snap the local player to the server position only when divergence exceeds this (world units).
// Movement is client-authoritative (model A): the client predicts locally and the server just
// echoes its (anti-cheat-clamped) position, so during normal play the snapshot trails the
// client by ~speed*latency. This threshold must absorb that or the player rubber-bands while
// moving; it exists only to correct gross desync, not to fight latency.
export const RECONCILE_DIST = 8.0;

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
  buildInput(p: Vec3, r: Rot, v: Vec3, tsMs: number, crouch = false): InMsg {
    return {
      t: "in",
      seq: this.nextSeq(),
      ts: tsMs,
      p: [p[0], p[1], p[2]],
      r: [r[0], r[1]],
      v: [v[0], v[1], v[2]],
      c: crouch,
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
  private crouching = false;

  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current: THREE.AnimationAction | null = null;

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
      // The Quaternius soldier bundles a full weapon set as separate meshes — drop them so
      // the remote player is a clean helmeted soldier (also keeps the bounding box correct).
      const weaponRe = /^(revolver|sniper|pistol|smg|grenadelauncher|shortcannon|shotgun|rocketlauncher|ak|shovel|knife)/i;
      const drop: THREE.Object3D[] = [];
      model.traverse((o) => { if ((o as THREE.Mesh).isMesh && weaponRe.test(o.name)) drop.push(o); });
      for (const o of drop) o.removeFromParent();
      // Scale to a consistent player height regardless of the model's native units,
      // then anchor its feet at the group origin (y=0).
      model.updateMatrixWorld(true);
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(model).getSize(size);
      model.scale.setScalar(PLAYER_HEIGHT / (size.y || 1));
      model.updateMatrixWorld(true);
      const fitted = new THREE.Box3().setFromObject(model);
      model.position.y = -fitted.min.y; // lift so the lowest point (feet) sits at y=0
      // Keep the model's natural materials (no per-player tint) — just enable shadows.
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      this.group.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      const clips = character.animations;
      for (const clip of clips) this.actions[clip.name] = this.mixer.clipAction(clip);
      // Canonical aliases (Idle / Running / Punch) resolved by fuzzy clip-name match, so
      // any rigged humanoid works regardless of its clip naming (e.g. "CharacterArmature|Run").
      const find = (...subs: string[]): THREE.AnimationClip | undefined =>
        clips.find((c) => subs.some((s) => c.name.toLowerCase().includes(s)));
      const alias = (key: string, clip: THREE.AnimationClip | undefined): void => {
        if (clip && !this.actions[key]) this.actions[key] = this.mixer!.clipAction(clip);
      };
      alias("Idle", find("idle") ?? clips[0]);
      alias("Running", find("run", "sprint") ?? find("walk") ?? find("idle") ?? clips[0]);
      alias("Punch", find("punch", "attack", "shoot", "fire", "kick", "wave"));
      this.current = this.actions["Idle"] ?? null;
      this.current?.play();
    } else {
      // Fallback (model failed to load): a neutral soldier-olive box.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, PLAYER_HEIGHT, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x5b6b3a }),
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
      // depthTest:true so the bar is hidden when the enemy is behind cover.
      new THREE.SpriteMaterial({ map: this.healthTex, depthTest: true }),
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

  // Crouch: squash the body vertically (feet stay grounded) so remotes look crouched.
  setCrouch(crouch: boolean): void {
    if (this.crouching === crouch) return;
    this.crouching = crouch;
    this.group.scale.y = crouch ? CROUCH_EYE_HEIGHT / EYE_HEIGHT : 1;
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
      // Server p is the eye position; subtract the (crouch-aware) eye height so the group
      // origin (the character's feet) stays on the ground.
      const eye = this.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
      this.group.position.set(sample.p[0], sample.p[1] - eye, sample.p[2]);
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
    // depthTest:true so the nameplate is occluded when the enemy is behind cover.
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.375, 1);
    return sprite;
  }
}
