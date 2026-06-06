// src/pickups.ts — pickup visuals (server-authoritative; this only shows/hides + animates).
// Each field self-manages its respawn (re-shows once nowMs passes the recorded availableAt),
// so there are no uncancellable setTimeouts that could re-show a pickup in a later match.
//   AmmoPickups / GrenadePickups / HealthPickups / ArmorPickups / SpringPickups — fields.
//   RocketPickup — the single rocket launcher on its tower.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { AMMO_PICKUPS, GRENADE_PICKUPS, HEALTH_PICKUPS, ARMOR_PICKUPS, SPRING_PICKUPS, ROCKET_TOWERS } from "../worker/protocol";
import { buildRocketLauncher } from "./models";

// Base for a field of identical floating pickups at fixed positions.
class PickupField {
  protected items: THREE.Group[] = [];
  private availableAt: number[] = [];
  protected spin = 1.3;
  protected bob = 0.13;
  protected baseY = 0.15;

  protected register(scene: THREE.Scene, g: THREE.Group, x: number, z: number): void {
    g.position.set(x, 0, z);
    g.traverse((o) => { o.userData.noHit = true; });
    scene.add(g);
    this.items.push(g);
    this.availableAt.push(0);
  }
  // Mark a pickup taken until `availableAtMs`; it hides now and re-shows itself in update().
  setTaken(id: number, availableAtMs: number): void {
    const c = this.items[id];
    if (!c) return;
    c.visible = false;
    this.availableAt[id] = availableAtMs;
  }
  showAll(): void {
    for (let i = 0; i < this.items.length; i++) { this.items[i]!.visible = true; this.availableAt[i] = 0; }
  }
  update(dt: number, nowMs: number): void {
    for (let i = 0; i < this.items.length; i++) {
      const c = this.items[i]!;
      if (!c.visible && nowMs >= this.availableAt[i]!) c.visible = true;
      if (!c.visible) continue;
      c.rotation.y += dt * this.spin;
      c.position.y = this.baseY + Math.sin(nowMs / 400 + c.position.x) * this.bob;
    }
  }
}

export class AmmoPickups extends PickupField {
  constructor(scene: THREE.Scene) {
    super();
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xffcc22, emissive: 0x6a5300, roughness: 0.5 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x33280c, roughness: 0.8 });
    for (const p of AMMO_PICKUPS) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), boxMat); box.position.y = 0.55; box.castShadow = true;
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.2, 0.86), bandMat); band.position.y = 0.55;
      g.add(box, band);
      this.register(scene, g, p[0], p[2]);
    }
  }
}

export class GrenadePickups extends PickupField {
  constructor(scene: THREE.Scene, model: GLTF | null | undefined) {
    super();
    for (const p of GRENADE_PICKUPS) {
      const g = new THREE.Group();
      let vis: THREE.Object3D;
      if (model) {
        vis = cloneSkeleton(model.scene);
        const s = new THREE.Vector3();
        new THREE.Box3().setFromObject(vis).getSize(s);
        vis.scale.setScalar(0.9 / (Math.max(s.x, s.y, s.z) || 1));
        vis.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
      } else {
        vis = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), new THREE.MeshStandardMaterial({ color: 0x2f3a22, roughness: 0.7 }));
      }
      vis.position.y = 0.7;
      g.add(vis);
      this.register(scene, g, p[0], p[2]);
    }
  }
}

// Health syringe / medkit — a white box with a red cross.
export class HealthPickups extends PickupField {
  constructor(scene: THREE.Scene) {
    super();
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 });
    const red = new THREE.MeshStandardMaterial({ color: 0xdd2222, emissive: 0x440505, roughness: 0.5 });
    for (const p of HEALTH_PICKUPS) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), white); box.position.y = 0.6; box.castShadow = true;
      const barV = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.16), red); barV.position.y = 0.86;
      const barH = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.16), red); barH.position.y = 0.86;
      g.add(box, barV, barH);
      this.register(scene, g, p[0], p[2]);
    }
  }
}

// Armor — a blue shield.
export class ArmorPickups extends PickupField {
  constructor(scene: THREE.Scene) {
    super();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2e72d2, emissive: 0x0a1f44, metalness: 0.5, roughness: 0.4 });
    for (const p of ARMOR_PICKUPS) {
      const g = new THREE.Group();
      const shield = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.18), mat); shield.position.y = 0.75; shield.castShadow = true;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.42, 4), mat); tip.position.y = 0.25; tip.rotation.y = Math.PI / 4;
      g.add(shield, tip);
      this.register(scene, g, p[0], p[2]);
    }
  }
}

// Spring boots pad — a green pad with a metal coil.
export class SpringPickups extends PickupField {
  constructor(scene: THREE.Scene) {
    super();
    const pad = new THREE.MeshStandardMaterial({ color: 0x22cc66, emissive: 0x0a3318, roughness: 0.5 });
    const coil = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.7, roughness: 0.3 });
    for (const p of SPRING_PICKUPS) {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.18, 16), pad); base.position.y = 0.1; base.castShadow = true;
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 8, 16), coil);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.32 + i * 0.18;
        g.add(ring);
      }
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 16), pad); top.position.y = 0.92;
      g.add(base, top);
      this.register(scene, g, p[0], p[2]);
    }
    this.baseY = 0.05;
    this.bob = 0.08;
  }
}

// Rocket launchers on the (non-center) towers — one per ROCKET_TOWERS entry, self-managing.
export class RocketPickups {
  private items: THREE.Group[] = [];
  private baseY: number[] = [];
  private availableAt: number[] = [];

  constructor(scene: THREE.Scene) {
    for (const t of ROCKET_TOWERS) {
      const g = buildRocketLauncher();
      g.scale.setScalar(1.2);
      const by = t[1] + 0.6; // hover just above the tower's top surface
      g.position.set(t[0], by, t[2]);
      g.traverse((o) => { o.userData.noHit = true; });
      scene.add(g);
      this.items.push(g);
      this.baseY.push(by);
      this.availableAt.push(0);
    }
  }
  setTaken(id: number, availableAtMs: number): void {
    const g = this.items[id];
    if (g) g.visible = false;
    this.availableAt[id] = availableAtMs;
  }
  showAll(): void {
    for (let i = 0; i < this.items.length; i++) { this.items[i]!.visible = true; this.availableAt[i] = 0; }
  }
  update(dt: number, nowMs: number): void {
    for (let i = 0; i < this.items.length; i++) {
      const g = this.items[i]!;
      if (!g.visible && nowMs >= this.availableAt[i]!) g.visible = true;
      if (!g.visible) continue;
      g.rotation.y += dt * 1.0;
      g.position.y = this.baseY[i]! + Math.sin(nowMs / 500) * 0.14;
    }
  }
}
