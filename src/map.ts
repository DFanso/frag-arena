// src/map.ts — arena split into an invisible COLLISION group (Octree source, unchanged)
// and a VISUAL group (rendered: ground/walls + CC0 crate/barrel props with box fallbacks).
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const ARENA = 60;
const HALF = ARENA / 2;
const WALL_H = 6;
const WALL_T = 1;

function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

const COVER: Array<[number, number, number]> = [
  [-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10],
];

export function buildArena(reg: { crate: GLTF | null; barrel: GLTF | null } = { crate: null, barrel: null }): {
  collision: THREE.Group; visual: THREE.Group;
} {
  const collision = new THREE.Group();
  const visual = new THREE.Group();

  // --- COLLISION (identical to v1; NOT rendered) ---
  const groundT = 1;
  collision.add(box(ARENA, groundT, ARENA, 0x000000, 0, -groundT / 2, 0));
  const wy = WALL_H / 2;
  collision.add(box(ARENA, WALL_H, WALL_T, 0x000000, 0, wy, -HALF));
  collision.add(box(ARENA, WALL_H, WALL_T, 0x000000, 0, wy, HALF));
  collision.add(box(WALL_T, WALL_H, ARENA, 0x000000, -HALF, wy, 0));
  collision.add(box(WALL_T, WALL_H, ARENA, 0x000000, HALF, wy, 0));
  for (const [x, , z] of COVER) collision.add(box(4, 3, 4, 0x000000, x, 1.5, z));
  const platH = 2, platD = 8;
  collision.add(box(8, platH, platD, 0x000000, 0, platH / 2, 0));
  const rampAngle = (20 * Math.PI) / 180, rampLen = 10;
  const r1 = box(4, 0.4, rampLen, 0x000000, 0, platH / 2 - 0.2, platD / 2 + 4); r1.rotation.x = rampAngle; collision.add(r1);
  const r2 = box(4, 0.4, rampLen, 0x000000, 0, platH / 2 - 0.2, -(platD / 2 + 4)); r2.rotation.x = -rampAngle; collision.add(r2);

  // --- VISUAL (rendered) ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA, ARENA),
    new THREE.MeshStandardMaterial({ color: 0x3a5f3a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  visual.add(ground);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x70808f, roughness: 0.9 });
  for (const m of [
    new THREE.Mesh(new THREE.BoxGeometry(ARENA, WALL_H, WALL_T), wallMat),
    new THREE.Mesh(new THREE.BoxGeometry(ARENA, WALL_H, WALL_T), wallMat),
    new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, ARENA), wallMat),
    new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, ARENA), wallMat),
  ]) { m.castShadow = true; m.receiveShadow = true; visual.add(m); }
  (visual.children[1] as THREE.Mesh).position.set(0, wy, -HALF);
  (visual.children[2] as THREE.Mesh).position.set(0, wy, HALF);
  (visual.children[3] as THREE.Mesh).position.set(-HALF, wy, 0);
  (visual.children[4] as THREE.Mesh).position.set(HALF, wy, 0);

  // platform (visual)
  const plat = box(8, platH, platD, 0x586a8c, 0, platH / 2, 0); visual.add(plat);
  const v1 = box(4, 0.4, rampLen, 0xaaaaaa, 0, platH / 2 - 0.2, platD / 2 + 4); v1.rotation.x = rampAngle; visual.add(v1);
  const v2 = box(4, 0.4, rampLen, 0xaaaaaa, 0, platH / 2 - 0.2, -(platD / 2 + 4)); v2.rotation.x = -rampAngle; visual.add(v2);

  // crate props at the 4 cover spots (fallback to a wood box if no model)
  for (const [x, , z] of COVER) {
    if (reg.crate) {
      const c = cloneSkeleton(reg.crate.scene);
      fitProp(c, 4); // scale so it roughly fills the 4-wide cover footprint
      c.position.set(x, 0, z);
      c.traverse((o) => { o.userData.noHit = true; if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      visual.add(c);
    } else {
      visual.add(box(4, 3, 4, 0xb5651d, x, 1.5, z));
    }
  }

  // a couple of barrels for flavour (visual only; no collision)
  if (reg.barrel) {
    for (const [bx, bz] of [[-6, 0], [6, 0]] as Array<[number, number]>) {
      const b = cloneSkeleton(reg.barrel.scene);
      fitProp(b, 1.2);
      b.position.set(bx, 0, bz);
      b.traverse((o) => { o.userData.noHit = true; if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      visual.add(b);
    }
  }

  return { collision, visual };
}

// Uniformly scale an object so its largest XZ footprint ≈ targetWidth.
function fitProp(obj: THREE.Object3D, targetWidth: number): void {
  const bb = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); bb.getSize(size);
  const maxXZ = Math.max(size.x, size.z) || 1;
  obj.scale.setScalar(targetWidth / maxXZ);
}
