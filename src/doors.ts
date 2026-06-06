// src/doors.ts — interactive building doors. Each door is a hinged leaf that swings open/closed
// on a press of E. Closed doors contribute a collision box to a small "door octree" that the
// player capsule is resolved against (separate from the static arena octree, so it can change
// at runtime without rebuilding the whole world).
import * as THREE from "three";
import { Octree } from "three/addons/math/Octree.js";
import type { Vec3 } from "../worker/protocol";

// A door sitting in a wall: hinge base position, leaf size, the wall axis it fills, and which
// way along that axis the leaf extends from the hinge (+1/-1).
export interface DoorSpec {
  hinge: Vec3;       // hinge base (x, 0, z)
  width: number;
  height: number;
  axis: "x" | "z";
  swing: number;     // +1 / -1
}

const T = 0.22;          // door leaf thickness
const REACH = 3.2;       // press-E reach to a door (XZ)
const OPEN_ANGLE = Math.PI / 2;
const SWING_SPEED = 6;   // rad/sec swing animation

export class Doors {
  private specs: DoorSpec[];
  private hinges: THREE.Group[] = [];
  private open: boolean[] = [];
  private angle: number[] = [];          // current animated hinge angle
  private center: Array<[number, number]> = []; // door center XZ (for nearest())
  private collBoxes: THREE.Mesh[] = [];  // closed-position collision proxies (octree source)
  private collGroup = new THREE.Group();
  private octree = new Octree();

  constructor(scene: THREE.Scene, specs: DoorSpec[]) {
    this.specs = specs;
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.85, metalness: 0.1 });
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.7, roughness: 0.4 });
    for (const s of specs) {
      const dimW = s.axis === "x" ? s.width : T;
      const dimD = s.axis === "x" ? T : s.width;
      const offX = s.axis === "x" ? (s.swing * s.width) / 2 : 0;
      const offZ = s.axis === "x" ? 0 : (s.swing * s.width) / 2;

      const hinge = new THREE.Group();
      hinge.position.set(s.hinge[0], s.hinge[1], s.hinge[2]);
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(dimW, s.height, dimD), mat);
      leaf.position.set(offX, s.height / 2, offZ);
      leaf.castShadow = true;
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), handleMat);
      handle.position.set(s.axis === "x" ? s.swing * s.width * 0.85 : 0.18, s.height / 2, s.axis === "x" ? 0.18 : s.swing * s.width * 0.85);
      hinge.add(leaf, handle);
      hinge.traverse((o) => { o.userData.noHit = true; });
      scene.add(hinge);
      this.hinges.push(hinge);
      this.open.push(false);
      this.angle.push(0);

      const cx = s.hinge[0] + offX;
      const cz = s.hinge[2] + offZ;
      this.center.push([cx, cz]);
      const cbox = new THREE.Mesh(new THREE.BoxGeometry(dimW, s.height, dimD));
      cbox.position.set(cx, s.height / 2, cz);
      this.collBoxes.push(cbox);
    }
    this.rebuildOctree();
  }

  private rebuildOctree(): void {
    this.collGroup.clear();
    for (let i = 0; i < this.specs.length; i++) {
      if (!this.open[i]) this.collGroup.add(this.collBoxes[i]!);
    }
    this.collGroup.updateMatrixWorld(true);
    this.octree = new Octree().fromGraphNode(this.collGroup);
  }

  getOctree(): Octree { return this.octree; }

  // Index of the nearest door within press-E reach of `pos`, else -1.
  nearest(pos: Vec3): number {
    let best = -1, bestD = REACH;
    for (let i = 0; i < this.center.length; i++) {
      const c = this.center[i]!;
      const d = Math.hypot(pos[0] - c[0], pos[2] - c[1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Toggle a door (rebuilds the collision octree); returns the new octree to hand to controls.
  toggle(i: number): Octree {
    if (i >= 0 && i < this.specs.length) {
      this.open[i] = !this.open[i];
      this.rebuildOctree();
    }
    return this.octree;
  }

  update(dt: number): void {
    for (let i = 0; i < this.specs.length; i++) {
      const target = this.open[i] ? OPEN_ANGLE * this.specs[i]!.swing : 0;
      const a = this.angle[i]!;
      if (a === target) continue;
      const step = SWING_SPEED * dt;
      this.angle[i] = Math.abs(target - a) <= step ? target : a + Math.sign(target - a) * step;
      this.hinges[i]!.rotation.y = this.angle[i]!;
    }
  }
}
