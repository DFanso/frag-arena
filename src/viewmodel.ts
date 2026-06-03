// src/viewmodel.ts — first-person gun attached to the camera, with recoil + muzzle flash.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const REST = new THREE.Vector3(0.24, -0.22, -0.55); // bottom-right of view
const RECOIL_BACK = 0.06;
const GUN_TARGET_LEN = 0.5; // largest gun dimension in view-space units (model-unit agnostic)

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
      // Fit to a small held size regardless of the source model's native units,
      // and recenter so its bounding-box centre sits at the holder origin.
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
      holder.rotation.y = Math.PI; // face forward (-z); tuned visually
      gunObj = holder;
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

    // Steady camera-side fill so the viewmodel reads clearly instead of as a dark
    // silhouette (decay 0 = flat, distance-independent fill on the gun only).
    const fill = new THREE.PointLight(0xffffff, 2.2);
    fill.decay = 0;
    fill.position.set(0.15, 0.25, 0.4); // between gun and camera, slightly above
    this.root.add(fill);

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
