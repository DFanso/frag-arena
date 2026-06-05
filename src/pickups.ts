// src/pickups.ts — ammo crate pickups: render a spinning/bobbing crate at each fixed
// AMMO_PICKUPS position. Server is authoritative (it decides who refills + when a crate
// returns); this just shows/hides + animates the crates.
import * as THREE from "three";
import { AMMO_PICKUPS } from "../worker/protocol";

export class AmmoPickups {
  private crates: THREE.Group[] = [];

  constructor(scene: THREE.Scene) {
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xffcc22, emissive: 0x6a5300, roughness: 0.5 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x33280c, roughness: 0.8 });
    for (const p of AMMO_PICKUPS) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), boxMat);
      box.position.y = 0.6;
      box.castShadow = true;
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.2, 0.86), bandMat);
      band.position.y = 0.6;
      g.add(box, band);
      g.position.set(p[0], 0, p[2]);
      g.traverse((o) => { o.userData.noHit = true; });
      scene.add(g);
      this.crates.push(g);
    }
  }

  setAvailable(id: number, available: boolean): void {
    const c = this.crates[id];
    if (c) c.visible = available;
  }

  showAll(): void {
    for (const c of this.crates) c.visible = true;
  }

  update(dt: number, nowMs: number): void {
    for (const c of this.crates) {
      if (!c.visible) continue;
      c.rotation.y += dt * 1.2;
      c.position.y = 0.12 + Math.sin(nowMs / 400 + c.position.x) * 0.12; // gentle bob
    }
  }
}
