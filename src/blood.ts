// src/blood.ts — blood spray particles on hits + gib pieces on explosion kills (cosmetic).
import * as THREE from "three";
import type { Vec3 } from "../worker/protocol";

interface Burst { pts: THREE.Points; geom: THREE.BufferGeometry; mat: THREE.PointsMaterial; pos: Float32Array; vel: Float32Array; n: number; age: number; life: number; }
interface Gib { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; age: number; life: number; }

const GIB_MAT = new THREE.MeshStandardMaterial({ color: 0x8a1a1a, roughness: 0.85 }); // shared flesh

export class Blood {
  private bursts: Burst[] = [];
  private gibs: Gib[] = [];

  constructor(private scene: THREE.Scene) {}

  // A burst of blood droplets at p (scale ~ hit strength).
  spray(p: Vec3, scale = 1): void {
    const n = Math.max(6, Math.round(14 * scale));
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      const sp = (2 + Math.random() * 4) * scale;
      const ang = Math.random() * Math.PI * 2;
      vel[i * 3] = Math.cos(ang) * sp;
      vel[i * 3 + 1] = Math.random() * 3 * scale;
      vel[i * 3 + 2] = Math.sin(ang) * sp;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xaa0a0a, size: 0.18, transparent: true, opacity: 0.95, depthWrite: false });
    const pts = new THREE.Points(geom, mat);
    pts.userData.noHit = true;
    this.scene.add(pts);
    this.bursts.push({ pts, geom, mat, pos, vel, n, age: 0, life: 0.6 });
  }

  // A bloody dismemberment: a big spray + a dozen tumbling gib pieces.
  gib(p: Vec3): void {
    this.spray(p, 2.4);
    for (let i = 0; i < 12; i++) {
      const s = 0.12 + Math.random() * 0.2;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), GIB_MAT);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.castShadow = true;
      mesh.userData.noHit = true;
      const ang = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 6;
      const vel = new THREE.Vector3(Math.cos(ang) * sp, 3 + Math.random() * 5, Math.sin(ang) * sp);
      const spin = new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
      this.scene.add(mesh);
      this.gibs.push({ mesh, vel, spin, age: 0, life: 1.5 });
    }
  }

  update(dt: number): void {
    for (const b of this.bursts) {
      b.age += dt;
      for (let i = 0; i < b.n; i++) {
        b.vel[i * 3 + 1]! -= 14 * dt; // gravity
        b.pos[i * 3]! += b.vel[i * 3]! * dt;
        b.pos[i * 3 + 1]! += b.vel[i * 3 + 1]! * dt;
        b.pos[i * 3 + 2]! += b.vel[i * 3 + 2]! * dt;
        if (b.pos[i * 3 + 1]! < 0.02) b.pos[i * 3 + 1] = 0.02;
      }
      (b.geom.attributes["position"] as THREE.BufferAttribute).needsUpdate = true;
      b.mat.opacity = Math.max(0, 0.95 * (1 - b.age / b.life));
    }
    this.bursts = this.bursts.filter((b) => {
      if (b.age >= b.life) { this.scene.remove(b.pts); b.geom.dispose(); b.mat.dispose(); return false; }
      return true;
    });

    for (const g of this.gibs) {
      g.age += dt;
      g.vel.y -= 16 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      if (g.mesh.position.y < 0.1) { g.mesh.position.y = 0.1; g.vel.set(g.vel.x * 0.3, Math.abs(g.vel.y) * 0.2, g.vel.z * 0.3); }
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;
    }
    this.gibs = this.gibs.filter((g) => {
      if (g.age >= g.life) { this.scene.remove(g.mesh); g.mesh.geometry.dispose(); return false; }
      return true;
    });
  }

  dispose(): void {
    for (const b of this.bursts) { this.scene.remove(b.pts); b.geom.dispose(); b.mat.dispose(); }
    for (const g of this.gibs) { this.scene.remove(g.mesh); g.mesh.geometry.dispose(); }
    this.bursts = [];
    this.gibs = [];
  }
}
