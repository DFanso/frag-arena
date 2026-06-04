// src/map.ts — 100x100 structured arena split into an invisible COLLISION group (Octree
// source) and a rendered VISUAL group. `solid()` adds a structure to BOTH (so visuals and
// collision never drift); `prop()` places a CC0 model (with a box fallback) and only adds a
// collision box when the prop is meant to be solid cover. Decorative props are visual-only.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const ARENA = 100;
const HALF = ARENA / 2; // 50
const WALL_H = 8;
const WALL_T = 1;

export interface MapProps {
  crate?: GLTF | null;
  barrel?: GLTF | null;
  container?: GLTF | null;
  rock?: GLTF | null;
  tree?: GLTF | null;
}

function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Uniformly scale an object so its largest XZ footprint ≈ targetWidth.
function fitProp(obj: THREE.Object3D, targetWidth: number): void {
  obj.updateMatrixWorld(true);
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(size);
  const maxXZ = Math.max(size.x, size.z) || 1;
  obj.scale.setScalar(targetWidth / maxXZ);
}

export function buildArena(reg: MapProps = {}): { collision: THREE.Group; visual: THREE.Group } {
  const collision = new THREE.Group();
  const visual = new THREE.Group();

  // Add a solid structure to BOTH groups (rendered + collidable).
  const solid = (
    w: number, h: number, d: number, color: number,
    x: number, y: number, z: number, rotX = 0,
  ): void => {
    const v = box(w, h, d, color, x, y, z);
    const c = box(w, h, d, 0x000000, x, y, z);
    if (rotX) { v.rotation.x = rotX; c.rotation.x = rotX; }
    visual.add(v);
    collision.add(c);
  };

  // Place a CC0 prop model (fallback to a box). If `collide` is given, also add a
  // collision box; otherwise it is decorative (visual-only, never blocks movement).
  const prop = (
    model: GLTF | null | undefined, targetW: number, x: number, z: number,
    collide: { w: number; h: number; d: number } | null, fallbackColor: number,
  ): void => {
    if (model) {
      const o = cloneSkeleton(model.scene);
      fitProp(o, targetW);
      o.position.set(x, 0, z);
      o.traverse((m) => {
        m.userData.noHit = true;
        if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
      visual.add(o);
    } else if (collide) {
      visual.add(box(collide.w, collide.h, collide.d, fallbackColor, x, collide.h / 2, z));
    } else {
      visual.add(box(targetW, targetW, targetW, fallbackColor, x, targetW / 2, z));
    }
    if (collide) collision.add(box(collide.w, collide.h, collide.d, 0x000000, x, collide.h / 2, z));
  };

  // --- Ground: visual plane + a thin collision slab (so the Octree has a floor) ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA, ARENA),
    new THREE.MeshStandardMaterial({ color: 0x3a5f3a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  visual.add(ground);
  collision.add(box(ARENA, 1, ARENA, 0x000000, 0, -0.5, 0));

  // --- Perimeter walls ---
  const wallColor = 0x70808f;
  const wy = WALL_H / 2;
  solid(ARENA, WALL_H, WALL_T, wallColor, 0, wy, -HALF);
  solid(ARENA, WALL_H, WALL_T, wallColor, 0, wy, HALF);
  solid(WALL_T, WALL_H, ARENA, wallColor, -HALF, wy, 0);
  solid(WALL_T, WALL_H, ARENA, wallColor, HALF, wy, 0);

  // --- Central tower (2 tiers) + N/S ramps up to the lower deck ---
  const towerA = 0x586a8c, towerB = 0x6b7db0, rampColor = 0xaaaaaa;
  solid(16, 2.5, 16, towerA, 0, 1.25, 0);   // lower deck, top y=2.5
  solid(8, 2.5, 8, towerB, 0, 3.75, 0);     // upper deck, top y=5
  const rampAngle = Math.atan2(2.5, 10);    // rise 2.5 over run ~10
  const rampLen = Math.hypot(10, 2.5);      // slope length
  solid(6, 0.5, rampLen, rampColor, 0, 1.25, 13, rampAngle);   // north ramp -> lower deck
  solid(6, 0.5, rampLen, rampColor, 0, 1.25, -13, -rampAngle); // south ramp -> lower deck

  // --- 2 mid platforms (raised, with a ramp each) ---
  const midH = 2.5;
  const midSpots: Array<[number, number]> = [[26, -26], [-26, 26]];
  for (const [mx, mz] of midSpots) {
    solid(10, midH, 10, 0x5a6a55, mx, midH / 2, mz);
    // a ramp on the inward (toward-center) side
    const dirX = mx > 0 ? -1 : 1;
    solid(5, 0.5, rampLen, rampColor, mx + dirX * 8, midH / 2, mz, 0);
  }

  // --- Pillars (sightline breaks / cover) ---
  for (const [px, pz] of [[15, 15], [-15, 15], [15, -15], [-15, -15], [0, 35], [0, -35]] as Array<[number, number]>) {
    solid(2, 6, 2, 0x6b6f78, px, 3, pz);
  }

  // --- Lane walls (low, break central sightlines) ---
  solid(16, 3, 1, 0x788090, 22, 1.5, 0);
  solid(16, 3, 1, 0x788090, -22, 1.5, 0);

  // --- 4 quadrant cover-bases: crates (collidable) + a low L-wall ---
  for (const [bx, bz] of [[28, 28], [-28, 28], [28, -28], [-28, -28]] as Array<[number, number]>) {
    prop(reg.crate, 4, bx, bz, { w: 4, h: 3, d: 4 }, 0xb5651d);
    prop(reg.crate, 3, bx + 5, bz + 1, { w: 3, h: 2.5, d: 3 }, 0xb5651d);
    solid(8, 2.5, 1, 0x6e6256, bx - 2, 1.25, bz - 4);  // L-wall segment A
    solid(1, 2.5, 8, 0x6e6256, bx - 6, 1.25, bz);      // L-wall segment B
  }

  // --- Containers: large collidable cover near the side walls ---
  prop(reg.container, 9, 38, 0, { w: 9, h: 5, d: 4 }, 0x995533);
  prop(reg.container, 9, -38, 0, { w: 9, h: 5, d: 4 }, 0x995533);

  // --- Decorative props (visual-only; never block movement) ---
  for (const [x, z] of [[8, 6], [-8, 6], [6, -8], [-6, -8], [20, 0], [-20, 0]] as Array<[number, number]>) {
    prop(reg.barrel, 1.2, x, z, null, 0xcc5533);
  }
  for (const [x, z] of [[34, 20], [-34, -20], [18, 34], [-18, -34], [40, -40]] as Array<[number, number]>) {
    prop(reg.rock, 4, x, z, null, 0x777777);
  }
  for (const [x, z] of [[44, 44], [-44, 44], [44, -44], [-44, -44]] as Array<[number, number]>) {
    prop(reg.tree, 6, x, z, null, 0x2f6f3f);
  }

  return { collision, visual };
}
