// src/viewmodel.ts — first-person viewmodel: gun + two procedural arms gripping it, attached
// to the camera, with recoil + muzzle flash. The arms are simple low-poly meshes placed
// directly on the gun (no external rig to misalign), so they hold the weapon in first person.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const REST = new THREE.Vector3(0.24, -0.22, -0.55); // bottom-right of view
const RECOIL_BACK = 0.06;
const GUN_TARGET_LEN = 0.5; // largest gun dimension in view-space units (model-unit agnostic)

// Arm placement (view-space, relative to the gun which is centered at the root origin).
// hand = position of the wrist on the gun; pitch/yaw aim the forearm down toward the body.
const ARM_LEN = 0.34;
const RIGHT_ARM = { hand: new THREE.Vector3(0.02, -0.02, 0.13), pitch: -1.2, yaw: 0.22 };   // trigger hand (grip)
const LEFT_ARM = { hand: new THREE.Vector3(-0.04, -0.03, -0.06), pitch: -1.1, yaw: -0.3 };  // support hand (foregrip)

export class Viewmodel {
  private root: THREE.Group;
  private flashLight: THREE.PointLight;
  private flashUntil = 0;
  private recoilZ = 0;

  constructor(camera: THREE.PerspectiveCamera, gun: GLTF | null) {
    this.root = new THREE.Group();
    this.root.position.copy(REST);

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
    this.root.add(gunObj);

    // Procedural arms gripping the gun (sleeve forearm + gloved hand).
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3c4a30, roughness: 0.9 }); // olive sleeve
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x24222a, roughness: 0.9 });  // dark glove
    const makeArm = (spec: { hand: THREE.Vector3; pitch: number; yaw: number }): THREE.Group => {
      const arm = new THREE.Group();
      // forearm: a tapered cylinder running in local -Y from the wrist (origin) to the elbow.
      const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.062, ARM_LEN, 10), sleeveMat);
      forearm.position.set(0, -ARM_LEN / 2, 0);
      arm.add(forearm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.07, 0.12), gloveMat);
      arm.add(hand); // at the wrist (group origin)
      arm.position.copy(spec.hand);
      arm.rotation.set(spec.pitch, spec.yaw, 0);
      arm.traverse((o) => { o.userData.noHit = true; (o as THREE.Mesh).castShadow = false; });
      return arm;
    };
    this.root.add(makeArm(RIGHT_ARM));
    this.root.add(makeArm(LEFT_ARM));

    this.flashLight = new THREE.PointLight(0xffd9a0, 0, 6);
    this.flashLight.position.set(0, 0.02, -0.4);
    this.root.add(this.flashLight);

    const fill = new THREE.PointLight(0xffffff, 2.2);
    fill.decay = 0;
    fill.position.set(0.15, 0.25, 0.4);
    this.root.add(fill);

    camera.add(this.root); // viewmodel follows the camera
  }

  recoil(): void { this.recoilZ = RECOIL_BACK; }
  flash(): void { this.flashUntil = performance.now() + 60; }

  update(dtMs: number): void {
    this.recoilZ *= Math.max(0, 1 - dtMs / 90);
    this.root.position.z = REST.z + this.recoilZ;
    this.flashLight.intensity = performance.now() < this.flashUntil ? 8 : 0;
  }
}
