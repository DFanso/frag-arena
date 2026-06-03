// src/viewmodel.ts — first-person gun attached to the camera, with recoil + muzzle flash.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const REST = new THREE.Vector3(0.18, -0.18, -0.45); // bottom-right of view
const RECOIL_BACK = 0.06;

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
      gunObj = cloneSkeleton(gun.scene);
      gunObj.scale.setScalar(0.25);
      gunObj.rotation.y = Math.PI; // face forward (-z)
    } else {
      // primitive fallback gun
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

    this.flashLight = new THREE.PointLight(0xffd9a0, 0, 6);
    this.flashLight.position.set(0, 0.02, -0.4);
    this.root.add(this.flashLight);

    camera.add(this.root); // viewmodel follows the camera
  }

  recoil(): void { this.recoilZ = RECOIL_BACK; }
  flash(): void { this.flashUntil = performance.now() + 60; }

  update(dtMs: number): void {
    // ease recoil back to 0
    this.recoilZ *= Math.max(0, 1 - dtMs / 90);
    this.root.position.z = REST.z + this.recoilZ;
    this.flashLight.intensity = performance.now() < this.flashUntil ? 8 : 0;
  }
}
