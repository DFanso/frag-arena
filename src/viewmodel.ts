// src/viewmodel.ts — first-person viewmodel: the currently-held weapon + two gloved hands
// gripping it, attached to the camera, with recoil + muzzle flash. The held weapon swaps with
// the player's selection (rifle / sniper / rocket launcher). The hands are low-poly meshes
// placed directly on the weapon (no external rig to misalign) so they read as gripping it.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { ROCKET_ID } from "../worker/protocol";
import { buildRocketLauncher } from "./models";

const REST = new THREE.Vector3(0.24, -0.22, -0.55); // bottom-right of view
const RECOIL_BACK = 0.06;
const GUN_TARGET_LEN = 0.5; // largest gun dimension in view-space units (model-unit agnostic)

// Hand placement (view-space, relative to the weapon centered at the root origin). Each weapon
// has its own grip/support offsets so the hands wrap the actual model rather than floating.
const ARM_LEN = 0.34;
type ArmSpec = { hand: THREE.Vector3; pitch: number; yaw: number };
const RIFLE_RIGHT: ArmSpec = { hand: new THREE.Vector3(0.02, -0.02, 0.13), pitch: -1.2, yaw: 0.22 };  // trigger grip
const RIFLE_LEFT: ArmSpec = { hand: new THREE.Vector3(-0.04, -0.03, -0.06), pitch: -1.1, yaw: -0.3 }; // foregrip
const ROCKET_RIGHT: ArmSpec = { hand: new THREE.Vector3(0.0, -0.085, 0.02), pitch: -1.1, yaw: 0.2 };  // launcher grip (lower)
const ROCKET_LEFT: ArmSpec = { hand: new THREE.Vector3(-0.03, -0.02, 0.2), pitch: -1.0, yaw: -0.3 };  // support on the tube

// Muzzle anchor z (view-space, from the weapon root) per weapon id — where tracers spawn (#67).
// The guns are centered on the root and ~GUN_TARGET_LEN long; the sniper's barrel reaches -0.575.
const MUZZLE_Z: readonly number[] = [-0.28, -0.58, -0.45];

export class Viewmodel {
  private root: THREE.Group;
  private flashLight: THREE.PointLight;
  private flashUntil = 0;
  private recoilZ = 0;
  private held: (THREE.Object3D | null)[] = []; // index by weapon id (0 rifle, 1 sniper, 2 rocket)
  private curId = 0;
  private rightArm: THREE.Group;
  private leftArm: THREE.Group;
  private muzzle: THREE.Object3D; // tracer spawn anchor at the held weapon's barrel tip (#67)

  constructor(camera: THREE.PerspectiveCamera, gun: GLTF | null) {
    this.root = new THREE.Group();
    this.root.position.copy(REST);

    // One held mesh per weapon id; only the current one is visible.
    this.held[0] = this.buildGun(gun, false); // rifle
    this.held[1] = this.buildGun(gun, true);  // sniper (gun + scope + long barrel)
    this.held[ROCKET_ID] = this.buildRocket();
    for (const h of this.held) if (h) { h.visible = false; this.root.add(h); }
    if (this.held[0]) this.held[0]!.visible = true;

    // Two gloved hands gripping the weapon; re-placed per weapon in setWeapon().
    this.rightArm = this.makeArm();
    this.leftArm = this.makeArm();
    this.applyArmSpec(this.rightArm, RIFLE_RIGHT);
    this.applyArmSpec(this.leftArm, RIFLE_LEFT);
    this.root.add(this.rightArm);
    this.root.add(this.leftArm);

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, MUZZLE_Z[0]!);
    this.root.add(this.muzzle);

    this.flashLight = new THREE.PointLight(0xffd9a0, 0, 6);
    this.flashLight.position.set(0, 0.02, -0.4);
    this.root.add(this.flashLight);

    const fill = new THREE.PointLight(0xffffff, 2.2);
    fill.decay = 0;
    fill.position.set(0.15, 0.25, 0.4);
    this.root.add(fill);

    camera.add(this.root); // viewmodel follows the camera
  }

  // Show the held mesh for weapon `id` and move the hands onto that weapon's grips.
  setWeapon(id: number): void {
    if (id < 0 || id >= this.held.length) return;
    const prev = this.held[this.curId];
    if (prev) prev.visible = false;
    this.curId = id;
    const next = this.held[id];
    if (next) next.visible = true;
    if (id === ROCKET_ID) {
      this.applyArmSpec(this.rightArm, ROCKET_RIGHT);
      this.applyArmSpec(this.leftArm, ROCKET_LEFT);
    } else {
      this.applyArmSpec(this.rightArm, RIFLE_RIGHT);
      this.applyArmSpec(this.leftArm, RIFLE_LEFT);
    }
    this.muzzle.position.z = MUZZLE_Z[id] ?? MUZZLE_Z[0]!;
  }

  // World position of the held weapon's barrel tip — tracers start here, not at the camera (#67).
  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  recoil(scale = 1): void { this.recoilZ = RECOIL_BACK * scale; }
  flash(): void { this.flashUntil = performance.now() + 60; }

  update(dtMs: number): void {
    this.recoilZ *= Math.max(0, 1 - dtMs / 90);
    this.root.position.z = REST.z + this.recoilZ;
    this.flashLight.intensity = performance.now() < this.flashUntil ? 8 : 0;
  }

  // Build the held rifle/sniper from the gun GLB (falls back to a simple box). The sniper
  // variant gets a small scope so the two read differently in first person.
  private buildGun(gun: GLTF | null, sniper: boolean): THREE.Object3D {
    let gunObj: THREE.Object3D;
    if (gun) {
      const model = cloneSkeleton(gun.scene);
      const bb = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      bb.getSize(size);
      bb.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const s = GUN_TARGET_LEN / maxDim;
      model.scale.setScalar(s);
      model.position.set(-center.x * s, -center.y * s, -center.z * s);
      const holder = new THREE.Group();
      holder.add(model);
      if (sniper) {
        const dark = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.5 });
        // Scope on top.
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 12), dark);
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.075, -0.02);
        holder.add(scope);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0x2a4a6a, emissive: 0x10243a }));
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 0.075, 0.08);
        holder.add(lens);
        // Long sniper barrel protruding from the muzzle (-Z forward).
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.42, 10), dark);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.0, -0.34);
        holder.add(barrel);
        const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 10), dark);
        muzzle.rotation.x = Math.PI / 2;
        muzzle.position.set(0, 0.0, -0.55);
        holder.add(muzzle);
      }
      gunObj = holder;
    } else {
      gunObj = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.06, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x222228 }),
      );
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.25),
        new THREE.MeshStandardMaterial({ color: 0x111114 }),
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.01, -0.22);
      gunObj.add(body, barrel);
    }
    gunObj.traverse((o) => { o.userData.noHit = true; });
    return gunObj;
  }

  // Build the held rocket launcher (procedural; muzzle rotated to face view-forward, -Z).
  private buildRocket(): THREE.Object3D {
    const launcher = buildRocketLauncher();
    launcher.rotation.y = Math.PI; // local +Z (muzzle) -> view-forward (-Z)
    launcher.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(launcher).getSize(size);
    const s = (GUN_TARGET_LEN * 1.6) / (Math.max(size.x, size.y, size.z) || 1);
    launcher.scale.setScalar(s);
    launcher.updateMatrixWorld(true);
    const center = new THREE.Vector3();
    new THREE.Box3().setFromObject(launcher).getCenter(center);
    launcher.position.sub(center); // center on the root origin like the guns
    const holder = new THREE.Group();
    holder.add(launcher);
    holder.traverse((o) => { o.userData.noHit = true; });
    return holder;
  }

  // A gloved hand on a forearm (positioned later via applyArmSpec).
  private makeArm(): THREE.Group {
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3c4a30, roughness: 0.9 }); // olive sleeve
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x24222a, roughness: 0.9 });  // dark glove
    const arm = new THREE.Group();

    // Forearm: tapered cylinder running from the wrist (origin) down to the elbow.
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.062, ARM_LEN, 12), sleeveMat);
    forearm.position.set(0, -ARM_LEN / 2, 0);
    arm.add(forearm);

    // Gloved hand: palm + four curled fingers + a thumb, wrapping the grip.
    const hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.05, 0.1), gloveMat);
    hand.add(palm);
    for (let i = 0; i < 4; i++) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.05, 0.05), gloveMat);
      finger.position.set(-0.03 + i * 0.02, -0.012, 0.065);
      finger.rotation.x = 0.7; // curl over the grip
      hand.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.052, 0.04), gloveMat);
    thumb.position.set(0.05, 0.002, 0.02);
    thumb.rotation.z = -0.6;
    hand.add(thumb);
    arm.add(hand);

    arm.traverse((o) => { o.userData.noHit = true; (o as THREE.Mesh).castShadow = false; });
    return arm;
  }

  // Position an arm at a weapon-specific grip offset.
  private applyArmSpec(arm: THREE.Group, spec: ArmSpec): void {
    arm.position.copy(spec.hand);
    arm.rotation.set(spec.pitch, spec.yaw, 0);
  }
}
