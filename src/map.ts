// src/map.ts — 100x100 arena. COLLISION group = invisible solid boxes (Octree source,
// unchanged). VISUAL group = real CC0 assets: grass-textured ground, modular fence walls,
// log pillars, stone-textured structures, crate/container/rock cover, and scattered foliage.
// Collision is decoupled from visuals so the look can change without touching gameplay.
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
  grass?: GLTF | null;
  bush?: GLTF | null;
  fern?: GLTF | null;
  fence?: GLTF | null;
  log?: GLTF | null;
  textures?: { grass: THREE.Texture | null; stone: THREE.Texture | null };
}

function fitProp(obj: THREE.Object3D, targetWidth: number): void {
  obj.updateMatrixWorld(true);
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(size);
  obj.scale.setScalar(targetWidth / (Math.max(size.x, size.z) || 1));
}

function fitPropHeight(obj: THREE.Object3D, targetH: number): void {
  obj.updateMatrixWorld(true);
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(size);
  obj.scale.setScalar(targetH / (size.y || 1));
}

export function buildArena(reg: MapProps = {}): { collision: THREE.Group; visual: THREE.Group } {
  const collision = new THREE.Group();
  const visual = new THREE.Group();

  const grassTex = reg.textures?.grass ?? null;
  const stoneTex = reg.textures?.stone ?? null;
  if (grassTex) grassTex.repeat.set(25, 25);
  if (stoneTex) stoneTex.repeat.set(2, 2);
  const structMat = stoneTex ? new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1 }) : null;

  const cbox = (w: number, h: number, d: number, x: number, y: number, z: number, rotX = 0): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    collision.add(m);
  };
  const vstruct = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotX = 0): void => {
    const mat = structMat ?? new THREE.MeshStandardMaterial({ color, roughness: 1 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    m.castShadow = true;
    m.receiveShadow = true;
    visual.add(m);
  };
  // Solid structure: visual (stone-textured) + matching collision box.
  const solid = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotX = 0): void => {
    vstruct(w, h, d, color, x, y, z, rotX);
    cbox(w, h, d, x, y, z, rotX);
  };
  const collOnly = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    cbox(w, h, d, x, y, z);
  };

  // Place a model (clone + fit + position + rotate). Returns the object, or null if no model.
  const placeModel = (
    model: GLTF | null | undefined, target: number, x: number, z: number, rotY = 0, fitH = false,
  ): THREE.Object3D | null => {
    if (!model) return null;
    const o = cloneSkeleton(model.scene);
    if (fitH) fitPropHeight(o, target); else fitProp(o, target);
    o.position.set(x, 0, z);
    if (rotY) o.rotation.y = rotY;
    o.updateMatrixWorld(true);
    o.traverse((m) => {
      m.userData.noHit = true;
      if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    visual.add(o);
    return o;
  };
  // Solid cover prop: collision box = the model's ACTUAL fitted bounds (so you never land
  // "inside" it). Falls back to a colored box if the model is missing.
  const cover = (model: GLTF | null | undefined, targetW: number, x: number, z: number, fb: { w: number; h: number; d: number }, color: number): void => {
    const o = placeModel(model, targetW, x, z);
    if (o) {
      const bb = new THREE.Box3().setFromObject(o);
      const s = new THREE.Vector3(); bb.getSize(s);
      const c = new THREE.Vector3(); bb.getCenter(c);
      cbox(s.x, s.y, s.z, c.x, c.y, c.z);
    } else {
      vstruct(fb.w, fb.h, fb.d, color, x, fb.h / 2, z);
      cbox(fb.w, fb.h, fb.d, x, fb.h / 2, z);
    }
  };
  // Decorative model (visual only, never blocks movement).
  const deco = (model: GLTF | null | undefined, target: number, x: number, z: number, rotY = 0, fitH = false): void => {
    placeModel(model, target, x, z, rotY, fitH);
  };

  // --- Ground: grass-textured plane + a thin collision slab ---
  const groundMat = grassTex
    ? new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 })
    : new THREE.MeshStandardMaterial({ color: 0x3a5f3a, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  visual.add(ground);
  cbox(ARENA, 1, ARENA, 0, -0.5, 0);

  // --- Perimeter: tall invisible collision walls + tiled fence models (or stone boxes) ---
  const wy = WALL_H / 2;
  collOnly(ARENA, WALL_H, WALL_T, 0, wy, -HALF);
  collOnly(ARENA, WALL_H, WALL_T, 0, wy, HALF);
  collOnly(WALL_T, WALL_H, ARENA, -HALF, wy, 0);
  collOnly(WALL_T, WALL_H, ARENA, HALF, wy, 0);
  if (reg.fence) {
    const n = Math.round(ARENA / 5);
    const step = ARENA / n;
    for (let i = 0; i < n; i++) {
      const t = -HALF + step / 2 + i * step;
      deco(reg.fence, step, t, -HALF);
      deco(reg.fence, step, t, HALF);
      deco(reg.fence, step, -HALF, t, Math.PI / 2);
      deco(reg.fence, step, HALF, t, Math.PI / 2);
    }
  } else {
    vstruct(ARENA, WALL_H, WALL_T, 0x70808f, 0, wy, -HALF);
    vstruct(ARENA, WALL_H, WALL_T, 0x70808f, 0, wy, HALF);
    vstruct(WALL_T, WALL_H, ARENA, 0x70808f, -HALF, wy, 0);
    vstruct(WALL_T, WALL_H, ARENA, 0x70808f, HALF, wy, 0);
  }

  // --- Central tower (2 tiers) + N/S ramps ---
  const rampColor = 0xaaaaaa;
  solid(16, 2.5, 16, 0x586a8c, 0, 1.25, 0);
  solid(8, 2.5, 8, 0x6b7db0, 0, 3.75, 0);
  const rampAngle = Math.atan2(2.5, 10);
  const rampLen = Math.hypot(10, 2.5);
  solid(6, 0.5, rampLen, rampColor, 0, 1.25, 13, rampAngle);
  solid(6, 0.5, rampLen, rampColor, 0, 1.25, -13, -rampAngle);

  // --- 2 mid platforms + ramps ---
  const midH = 2.5;
  for (const [mx, mz] of [[26, -26], [-26, 26]] as Array<[number, number]>) {
    solid(10, midH, 10, 0x5a6a55, mx, midH / 2, mz);
    solid(5, 0.5, rampLen, rampColor, mx + (mx > 0 ? -1 : 1) * 8, midH / 2, mz);
  }

  // --- Pillars: invisible collision + a stone column (matches the collision box) ---
  for (const [px, pz] of [[15, 15], [-15, 15], [15, -15], [-15, -15], [0, 35], [0, -35]] as Array<[number, number]>) {
    collOnly(2, 6, 2, px, 3, pz);
    vstruct(2, 6, 2, 0x6b6f78, px, 3, pz);
  }

  // --- Lane walls ---
  solid(16, 3, 1, 0x788090, 22, 1.5, 0);
  solid(16, 3, 1, 0x788090, -22, 1.5, 0);

  // --- 4 quadrant cover-bases: crates + low L-walls ---
  for (const [bx, bz] of [[28, 28], [-28, 28], [28, -28], [-28, -28]] as Array<[number, number]>) {
    cover(reg.crate, 4, bx, bz, { w: 4, h: 3, d: 4 }, 0xb5651d);
    cover(reg.crate, 3, bx + 5, bz + 1, { w: 3, h: 2.5, d: 3 }, 0xb5651d);
    solid(8, 2.5, 1, 0x6e6256, bx - 2, 1.25, bz - 4);
    solid(1, 2.5, 8, 0x6e6256, bx - 6, 1.25, bz);
  }

  // --- Containers: large collidable cover ---
  cover(reg.container, 9, 38, 0, { w: 9, h: 5, d: 4 }, 0x995533);
  cover(reg.container, 9, -38, 0, { w: 9, h: 5, d: 4 }, 0x995533);

  // --- Broken houses (stone-textured shells, enterable + collapsed wall) ---
  const house = (cx: number, cz: number, door: "n" | "s" | "e" | "w"): void => {
    const W = 10, D = 10, H = 4, T = 0.6, GAP = 3, seg = (W - GAP) / 2, low = 1.8, hx = W / 2, hz = D / 2;
    const wallX = (z: number, gap: boolean, h: number): void => {
      if (gap) {
        solid(seg, h, T, 0x8a7a66, cx - (GAP / 2 + seg / 2), h / 2, z);
        solid(seg, h, T, 0x8a7a66, cx + (GAP / 2 + seg / 2), h / 2, z);
      } else solid(W, h, T, 0x8a7a66, cx, h / 2, z);
    };
    const wallZ = (x: number, gap: boolean, h: number): void => {
      if (gap) {
        solid(T, h, seg, 0x8a7a66, x, h / 2, cz - (GAP / 2 + seg / 2));
        solid(T, h, seg, 0x8a7a66, x, h / 2, cz + (GAP / 2 + seg / 2));
      } else solid(T, h, D, 0x8a7a66, x, h / 2, cz);
    };
    wallX(cz - hz, door === "n", door === "s" ? low : H);
    wallX(cz + hz, door === "s", door === "n" ? low : H);
    wallZ(cx - hx, door === "w", door === "e" ? low : H);
    wallZ(cx + hx, door === "e", door === "w" ? low : H);
    solid(W / 2, T, D / 2, 0x6b5d4a, cx - W / 4, H + T / 2, cz - D / 4);
    solid(2.2, 1.2, 2.2, 0x70655a, cx + hx - 2, 0.6, cz + hz - 2);
  };
  house(-32, 14, "e");
  house(32, -14, "w");
  house(16, 32, "s");

  // --- Ruined wall fragments ---
  const ruin = (cx: number, cz: number): void => {
    solid(7, 2.2, 0.8, 0x7d7065, cx, 1.1, cz);
    solid(0.8, 2.2, 5, 0x7d7065, cx - 3, 1.1, cz + 2.5);
  };
  ruin(-14, 30);
  ruin(34, 8);
  ruin(-36, -14);

  // --- Barrels + rocks: small SOLID cover (collision = model bounds) ---
  for (const [x, z] of [[10, 8], [-10, 8], [8, -10], [-8, -10], [12, 12], [-12, -12]] as Array<[number, number]>) {
    cover(reg.barrel, 1.2, x, z, { w: 1.2, h: 1.6, d: 1.2 }, 0xcc5533);
  }
  for (const [x, z] of [[40, 22], [-40, -22], [22, 40], [-22, -40], [42, -8]] as Array<[number, number]>) {
    cover(reg.rock, 4, x, z, { w: 4, h: 2.5, d: 4 }, 0x777777);
  }

  // --- Fallen logs as low natural cover (the log model lies flat by default) ---
  cover(reg.log, 6, 6, 40, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f);
  cover(reg.log, 6, -6, -40, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f);

  // --- Trees (decorative, corners) ---
  for (const [x, z] of [[45, 45], [-45, 45], [45, -45], [-45, -45]] as Array<[number, number]>) {
    deco(reg.tree, 6, x, z);
  }

  // --- Scattered foliage (grass tufts / bushes / ferns) for a lush field. Deco only. ---
  const foliage = [reg.grass, reg.bush, reg.fern];
  const sizes = [1.6, 2.6, 2.2];
  let fi = 0;
  for (let gx = -42; gx <= 42; gx += 11) {
    for (let gz = -42; gz <= 42; gz += 11) {
      const x = gx + ((Math.abs(gx * 7 + gz * 13)) % 5) - 2;
      const z = gz + ((Math.abs(gx * 11 + gz * 5)) % 5) - 2;
      if (Math.hypot(x, z) < 12) continue; // keep the central tower clear
      const idx = fi % 3;
      deco(foliage[idx], sizes[idx]!, x, z, ((fi * 47) % 360) * (Math.PI / 180));
      fi++;
    }
  }

  return { collision, visual };
}
