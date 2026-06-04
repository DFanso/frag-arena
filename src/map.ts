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
    collidable: boolean, fallback: { w: number; h: number; d: number }, fallbackColor: number,
  ): void => {
    if (model) {
      const o = cloneSkeleton(model.scene);
      fitProp(o, targetW);
      o.position.set(x, 0, z);
      o.updateMatrixWorld(true);
      o.traverse((m) => {
        m.userData.noHit = true;
        if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
      visual.add(o);
      if (collidable) {
        // Collision box = the model's ACTUAL fitted bounds, so the solid volume matches
        // exactly what you see — no walking or landing "inside" the prop.
        const bb = new THREE.Box3().setFromObject(o);
        const s = new THREE.Vector3(); bb.getSize(s);
        const c = new THREE.Vector3(); bb.getCenter(c);
        collision.add(box(s.x, s.y, s.z, 0x000000, c.x, c.y, c.z));
      }
    } else {
      visual.add(box(fallback.w, fallback.h, fallback.d, fallbackColor, x, fallback.h / 2, z));
      if (collidable) collision.add(box(fallback.w, fallback.h, fallback.d, 0x000000, x, fallback.h / 2, z));
    }
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
    prop(reg.crate, 4, bx, bz, true, { w: 4, h: 3, d: 4 }, 0xb5651d);
    prop(reg.crate, 3, bx + 5, bz + 1, true, { w: 3, h: 2.5, d: 3 }, 0xb5651d);
    solid(8, 2.5, 1, 0x6e6256, bx - 2, 1.25, bz - 4);  // L-wall segment A
    solid(1, 2.5, 8, 0x6e6256, bx - 6, 1.25, bz);      // L-wall segment B
  }

  // --- Containers: large collidable cover near the side walls ---
  prop(reg.container, 9, 38, 0, true, { w: 9, h: 5, d: 4 }, 0x995533);
  prop(reg.container, 9, -38, 0, true, { w: 9, h: 5, d: 4 }, 0x995533);

  // --- Broken houses: enterable wall-shells (doorway gap + a collapsed wall to peek
  //     over + a partial roof fragment + rubble inside). Strong hiding/peeking spots. ---
  const house = (cx: number, cz: number, door: "n" | "s" | "e" | "w"): void => {
    const W = 10, D = 10, H = 4, T = 0.6, GAP = 3;
    const wc = 0x8a7a66, roofc = 0x6b5d4a, rubblec = 0x70655a;
    const hx = W / 2, hz = D / 2, seg = (W - GAP) / 2, low = 1.8;
    const wallX = (z: number, gap: boolean, h: number): void => {
      if (gap) {
        solid(seg, h, T, wc, cx - (GAP / 2 + seg / 2), h / 2, z);
        solid(seg, h, T, wc, cx + (GAP / 2 + seg / 2), h / 2, z);
      } else {
        solid(W, h, T, wc, cx, h / 2, z);
      }
    };
    const wallZ = (x: number, gap: boolean, h: number): void => {
      if (gap) {
        solid(T, h, seg, wc, x, h / 2, cz - (GAP / 2 + seg / 2));
        solid(T, h, seg, wc, x, h / 2, cz + (GAP / 2 + seg / 2));
      } else {
        solid(T, h, D, wc, x, h / 2, cz);
      }
    };
    // doorway on `door` side; the opposite wall is collapsed (low) to peek/vault over.
    wallX(cz - hz, door === "n", door === "s" ? low : H);
    wallX(cz + hz, door === "s", door === "n" ? low : H);
    wallZ(cx - hx, door === "w", door === "e" ? low : H);
    wallZ(cx + hx, door === "e", door === "w" ? low : H);
    solid(W / 2, T, D / 2, roofc, cx - W / 4, H + T / 2, cz - D / 4); // partial broken roof
    solid(2.2, 1.2, 2.2, rubblec, cx + hx - 2, 0.6, cz + hz - 2);     // rubble inside
  };
  house(-32, 14, "e");
  house(32, -14, "w");
  house(16, 32, "s");

  // --- Standalone ruined wall fragments (low L-shaped cover) ---
  const ruin = (cx: number, cz: number): void => {
    solid(7, 2.2, 0.8, 0x7d7065, cx, 1.1, cz);
    solid(0.8, 2.2, 5, 0x7d7065, cx - 3, 1.1, cz + 2.5);
  };
  ruin(-14, 30);
  ruin(34, 8);
  ruin(-36, -14);

  // --- Barrels + rocks: small SOLID cover (collision matches the model bounds) ---
  for (const [x, z] of [[10, 8], [-10, 8], [8, -10], [-8, -10], [12, 12], [-12, -12]] as Array<[number, number]>) {
    prop(reg.barrel, 1.2, x, z, true, { w: 1.2, h: 1.6, d: 1.2 }, 0xcc5533);
  }
  for (const [x, z] of [[40, 22], [-40, -22], [22, 40], [-22, -40], [42, -8]] as Array<[number, number]>) {
    prop(reg.rock, 4, x, z, true, { w: 4, h: 2.5, d: 4 }, 0x777777);
  }
  // --- Trees: decorative only (canopy bounds would over-block; walk-through) ---
  for (const [x, z] of [[45, 45], [-45, 45], [45, -45], [-45, -45]] as Array<[number, number]>) {
    prop(reg.tree, 6, x, z, false, { w: 1, h: 6, d: 1 }, 0x2f6f3f);
  }

  return { collision, visual };
}
