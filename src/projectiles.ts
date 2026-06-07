// src/projectiles.ts — client-side grenade visuals: render thrown grenades flying the
// server-sent ballistic arc, then a brief expanding-sphere explosion FX on the fuse.
// Damage is server-authoritative (arrives via HitMsg); this module is purely cosmetic.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { GRENADE_GRAVITY, GRENADE_RADIUS, ROCKET_RADIUS, type Vec3 } from "../worker/protocol";

interface Flying { mesh: THREE.Object3D; o: Vec3; v: Vec3; t: number; fuse: number; done: boolean; }
// A rocket flies in a straight line from o to its server-computed impact over `travel` seconds.
interface FlyingRocket { mesh: THREE.Object3D; o: Vec3; impact: Vec3; t: number; travel: number; done: boolean; }
interface Blast { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; radius: number; }

const BLAST_MS = 0.45;

export class Grenades {
  private flying: Flying[] = [];
  private rockets: FlyingRocket[] = [];
  private blasts: Blast[] = [];

  constructor(
    private scene: THREE.Scene,
    private model: GLTF | null | undefined,
    private onExplode?: (p: Vec3) => void,
  ) {}

  // Spawn a grenade flying the same ballistic arc the server used (o, v, fuse).
  spawn(o: Vec3, v: Vec3, fuseMs: number): void {
    let mesh: THREE.Object3D;
    if (this.model) {
      mesh = cloneSkeleton(this.model.scene);
      mesh.updateMatrixWorld(true);
      const s = new THREE.Vector3();
      new THREE.Box3().setFromObject(mesh).getSize(s);
      mesh.scale.setScalar(0.6 / (Math.max(s.x, s.y, s.z) || 1));
      mesh.traverse((m) => { m.userData["noHit"] = true; if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = true; });
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshStandardMaterial({ color: 0x2f3a22 }));
      mesh.userData["noHit"] = true;
    }
    mesh.position.set(o[0], o[1], o[2]);
    this.scene.add(mesh);
    this.flying.push({ mesh, o: [o[0], o[1], o[2]], v: [v[0], v[1], v[2]], t: 0, fuse: fuseMs / 1000, done: false });
  }

  // Spawn a rocket flying straight from o to its impact point over travelMs, then a blast.
  spawnRocket(o: Vec3, dir: Vec3, impact: Vec3, travelMs: number): void {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.55, 10),
      new THREE.MeshStandardMaterial({ color: 0x2f3036, roughness: 0.6 }),
    );
    body.rotation.x = Math.PI / 2; // cylinder axis (Y) -> local +Z (forward)
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.24, 10),
      new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff3300, emissiveIntensity: 1.2 }),
    );
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.38;
    group.add(body, tip);
    group.traverse((m) => { m.userData["noHit"] = true; });
    // Orient local +Z (nose) along the flight direction.
    const dn = new THREE.Vector3(dir[0], dir[1], dir[2]);
    if (dn.lengthSq() > 0) group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dn.normalize());
    group.position.set(o[0], o[1], o[2]);
    this.scene.add(group);
    this.rockets.push({ mesh: group, o: [o[0], o[1], o[2]], impact: [impact[0], impact[1], impact[2]], t: 0, travel: Math.max(0.001, travelMs / 1000), done: false });
  }

  update(dt: number): void {
    for (const g of this.flying) {
      g.t += dt;
      const t = g.t;
      g.mesh.position.set(
        g.o[0] + g.v[0] * t,
        Math.max(0.12, g.o[1] + g.v[1] * t - 0.5 * GRENADE_GRAVITY * t * t),
        g.o[2] + g.v[2] * t,
      );
      g.mesh.rotation.x += dt * 9;
      g.mesh.rotation.y += dt * 6;
      if (t >= g.fuse && !g.done) {
        g.done = true;
        this.boom([g.mesh.position.x, g.mesh.position.y, g.mesh.position.z]);
      }
    }
    this.flying = this.flying.filter((g) => {
      if (g.done) { this.scene.remove(g.mesh); return false; }
      return true;
    });

    // Advance rockets along their straight path; blast on arrival.
    for (const r of this.rockets) {
      r.t += dt;
      const k = Math.min(1, r.t / r.travel);
      r.mesh.position.set(
        r.o[0] + (r.impact[0] - r.o[0]) * k,
        r.o[1] + (r.impact[1] - r.o[1]) * k,
        r.o[2] + (r.impact[2] - r.o[2]) * k,
      );
      if (k >= 1 && !r.done) { r.done = true; this.boom([r.impact[0], r.impact[1], r.impact[2]], ROCKET_RADIUS); }
    }
    this.rockets = this.rockets.filter((r) => {
      if (r.done) { this.scene.remove(r.mesh); return false; }
      return true;
    });

    for (const b of this.blasts) {
      b.age += dt;
      const k = b.age / BLAST_MS;
      b.mesh.scale.setScalar(b.radius * Math.min(1, k * 1.15));
      b.mat.opacity = Math.max(0, 0.6 * (1 - k));
    }
    this.blasts = this.blasts.filter((b) => {
      if (b.age >= BLAST_MS) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mat.dispose(); return false; }
      return true;
    });
  }

  // Trigger an explosion FX at a position (used by exploding barrels).
  blast(p: Vec3, radius = GRENADE_RADIUS): void {
    this.boom(p, radius);
  }

  private boom(p: Vec3, radius = GRENADE_RADIUS): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa733, transparent: true, opacity: 0.6, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.scale.setScalar(0.2);
    mesh.userData["noHit"] = true;
    this.scene.add(mesh);
    this.blasts.push({ mesh, mat, age: 0, radius });
    this.onExplode?.(p);
  }

  dispose(): void {
    for (const g of this.flying) this.scene.remove(g.mesh);
    for (const r of this.rockets) this.scene.remove(r.mesh);
    for (const b of this.blasts) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mat.dispose(); }
    this.flying = [];
    this.rockets = [];
    this.blasts = [];
  }
}
