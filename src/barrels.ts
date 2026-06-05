// src/barrels.ts — explosive barrels: render a red barrel at each fixed EXPLOSIVE_BARRELS
// position, tagged with userData.barrelId so the hitscan ray can claim a barrel hit. The
// server validates the hit, tracks HP, and detonates (AoE); this shows/hides the barrels.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { EXPLOSIVE_BARRELS } from "../worker/protocol";

export class Barrels {
  private groups: THREE.Group[] = [];

  constructor(scene: THREE.Scene, model: GLTF | null | undefined) {
    // One shared red material — do NOT mutate the source model's material (the map reuses it).
    const redMat = new THREE.MeshStandardMaterial({ color: 0xcc3322, emissive: 0x350a06, roughness: 0.6 });
    for (let i = 0; i < EXPLOSIVE_BARRELS.length; i++) {
      const p = EXPLOSIVE_BARRELS[i]!;
      const root = new THREE.Group();
      let vis: THREE.Object3D;
      if (model) {
        vis = cloneSkeleton(model.scene);
        const bb = new THREE.Box3().setFromObject(vis);
        const sz = new THREE.Vector3();
        bb.getSize(sz);
        vis.scale.setScalar(1.6 / (sz.y || 1));
        const bb2 = new THREE.Box3().setFromObject(vis);
        vis.position.y = -bb2.min.y; // base on the ground
        vis.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = redMat; m.castShadow = true; } });
      } else {
        vis = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.5, 14), redMat);
        vis.position.y = 0.75;
      }
      root.add(vis);
      root.position.set(p[0], 0, p[2]);
      root.traverse((o) => { o.userData["barrelId"] = i; }); // raycast claim target
      scene.add(root);
      this.groups.push(root);
    }
  }

  // The barrel groups, for inclusion in the shoot raycast targets.
  getTargets(): THREE.Object3D[] {
    return this.groups;
  }

  setAvailable(id: number, available: boolean): void {
    const g = this.groups[id];
    if (g) g.visible = available;
  }

  showAll(): void {
    for (const g of this.groups) g.visible = true;
  }
}
