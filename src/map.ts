// src/map.ts — 100x100 arena. COLLISION group = invisible solid boxes (Octree source).
// VISUAL group = grass-textured ground + complete CC0 building models (tower/houses/sheds)
// placed as SOLID props (collision = model bounds, so you can't clip inside), 2 climbable
// stone platforms for verticality, low cover props, trees, and foliage. Collision is
// decoupled from visuals; every model falls back to a box if it fails to load.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const ARENA = 100;
const HALF = ARENA / 2; // 50
const WALL_H = 8;
const WALL_T = 1;

export interface MapProps {
  crate?: GLTF | null; barrel?: GLTF | null; container?: GLTF | null; rock?: GLTF | null; tree?: GLTF | null;
  grass?: GLTF | null; bush?: GLTF | null; fern?: GLTF | null; fence?: GLTF | null; log?: GLTF | null;
  bTower?: GLTF | null; bHouse1?: GLTF | null; bHouse2?: GLTF | null; bShed?: GLTF | null; bShed2?: GLTF | null;
  textures?: { grass: THREE.Texture | null; stone: THREE.Texture | null };
}

function fitWidth(obj: THREE.Object3D, targetW: number): void {
  obj.updateMatrixWorld(true);
  const s = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(s);
  obj.scale.setScalar(targetW / (Math.max(s.x, s.z) || 1));
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
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), structMat ?? new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    m.castShadow = true;
    m.receiveShadow = true;
    visual.add(m);
  };
  const solid = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotX = 0): void => {
    vstruct(w, h, d, color, x, y, z, rotX);
    cbox(w, h, d, x, y, z, rotX);
  };
  const collOnly = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    cbox(w, h, d, x, y, z);
  };

  const shade = (o: THREE.Object3D): void => {
    o.traverse((m) => { m.userData.noHit = true; if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  };

  // Decorative model (visual only): clone, fit to footprint width, base-anchor on the ground.
  const deco = (model: GLTF | null | undefined, footprintW: number, x: number, z: number, rotY = 0): THREE.Object3D | null => {
    if (!model) return null;
    const o = cloneSkeleton(model.scene);
    fitWidth(o, footprintW);
    o.position.set(x, 0, z);
    if (rotY) o.rotation.y = rotY;
    o.updateMatrixWorld(true);
    o.position.y -= new THREE.Box3().setFromObject(o).min.y; // sit on the ground
    o.updateMatrixWorld(true);
    shade(o);
    visual.add(o);
    return o;
  };

  // Small solid prop: place the model, then collide its full bounds (a box). Good for
  // compact convex props (crates/rocks/barrels/containers/logs). Falls back to a colored box.
  const solidProp = (model: GLTF | null | undefined, footprintW: number, x: number, z: number, rotY: number, fb: { w: number; h: number; d: number }, color: number): void => {
    const o = deco(model, footprintW, x, z, rotY);
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

  // Building: collision uses the model's ACTUAL geometry (a clone fed into the Octree), so the
  // capsule hits real walls and you can walk in through real doorways — no oversized box, no
  // getting stuck, enterable. Falls back to a solid box if the model is missing.
  const building = (model: GLTF | null | undefined, footprintW: number, x: number, z: number, rotY: number, fb: { w: number; h: number; d: number }, color: number): void => {
    const o = deco(model, footprintW, x, z, rotY);
    if (o) {
      const c = o.clone(true);          // shares geometry buffers; copies the baked transform
      c.updateMatrixWorld(true);
      collision.add(c);                  // Octree triangulates this → accurate, enterable collision
    } else {
      vstruct(fb.w, fb.h, fb.d, color, x, fb.h / 2, z);
      cbox(fb.w, fb.h, fb.d, x, fb.h / 2, z);
    }
  };

  // --- Ground ---
  const groundMat = grassTex
    ? new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 })
    : new THREE.MeshStandardMaterial({ color: 0x3a5f3a, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  visual.add(ground);
  cbox(ARENA, 1, ARENA, 0, -0.5, 0);

  // --- Perimeter: invisible collision walls + tiled fence models ---
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

  // --- Buildings: complete models, ENTERABLE (collision = real geometry via the Octree) ---
  building(reg.bTower, 9, 0, 0, 0, { w: 8, h: 12, d: 8 }, 0x8a8a8a);        // central landmark
  building(reg.bHouse1, 11, -22, -22, 0, { w: 9, h: 5, d: 9 }, 0x9a8a72);
  building(reg.bHouse2, 11, 22, 22, Math.PI, { w: 9, h: 5, d: 9 }, 0x9a8a72);
  building(reg.bShed, 7, 22, -22, Math.PI / 2, { w: 6, h: 3.5, d: 6 }, 0x8a7a5a);
  building(reg.bShed2, 7, -22, 22, -Math.PI / 2, { w: 6, h: 3.5, d: 6 }, 0x8a7a5a);

  // --- 2 climbable stone platforms (verticality) + ramps ---
  const midH = 2.5;
  const rampColor = 0xaaaaaa;
  const rampAngle = Math.atan2(2.5, 10);
  const rampLen = Math.hypot(10, 2.5);
  for (const [mx, mz] of [[0, 26], [0, -26]] as Array<[number, number]>) {
    collOnly(10, midH, 10, mx, midH / 2, mz);
    vstruct(10, midH, 10, 0x6b6f62, mx, midH / 2, mz);
    solid(5, 0.5, rampLen, rampColor, mx, midH / 2, mz + (mz > 0 ? -8 : 8), mz > 0 ? rampAngle : -rampAngle);
  }

  // --- Containers: mid cover ---
  solidProp(reg.container, 9, 14, 0, 0, { w: 9, h: 5, d: 4 }, 0x995533);
  solidProp(reg.container, 9, -14, 0, 0, { w: 9, h: 5, d: 4 }, 0x995533);

  // --- Crates: low cover ---
  for (const [x, z] of [[12, 12], [-12, -12], [12, -12], [-12, 12]] as Array<[number, number]>) {
    solidProp(reg.crate, 4, x, z, 0, { w: 4, h: 3, d: 4 }, 0xb5651d);
  }

  // --- Rocks + barrels + logs: scattered low cover ---
  for (const [x, z] of [[36, 18], [-36, -18], [18, 36], [-18, -36]] as Array<[number, number]>) {
    solidProp(reg.rock, 4, x, z, 0, { w: 4, h: 2.5, d: 4 }, 0x777777);
  }
  for (const [x, z] of [[6, 18], [-6, -18], [18, 6], [-18, -6]] as Array<[number, number]>) {
    solidProp(reg.barrel, 1.2, x, z, 0, { w: 1.2, h: 1.6, d: 1.2 }, 0xcc5533);
  }
  solidProp(reg.log, 6, 38, -14, 0, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f);
  solidProp(reg.log, 6, -38, 14, 0, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f);

  // --- Trees (decorative corners) ---
  for (const [x, z] of [[45, 45], [-45, 45], [45, -45], [-45, -45]] as Array<[number, number]>) {
    deco(reg.tree, 6, x, z);
  }

  // --- Scattered foliage (deco only) ---
  const foliage = [reg.grass, reg.bush, reg.fern];
  const sizes = [1.6, 2.6, 2.2];
  let fi = 0;
  for (let gx = -42; gx <= 42; gx += 11) {
    for (let gz = -42; gz <= 42; gz += 11) {
      const x = gx + (Math.abs(gx * 7 + gz * 13) % 5) - 2;
      const z = gz + (Math.abs(gx * 11 + gz * 5) % 5) - 2;
      if (Math.hypot(x, z) < 10) continue;
      const idx = fi % 3;
      deco(foliage[idx], sizes[idx]!, x, z, ((fi * 47) % 360) * (Math.PI / 180));
      fi++;
    }
  }

  return { collision, visual };
}
