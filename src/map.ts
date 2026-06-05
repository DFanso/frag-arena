// src/map.ts — 100x100 arena. COLLISION group = invisible solid boxes (Octree source).
// VISUAL group = grass-textured ground + complete CC0 building models (tower/houses/sheds)
// placed as SOLID props (collision = model bounds, so you can't clip inside), 2 climbable
// stone platforms for verticality, low cover props, trees, and foliage. Collision is
// decoupled from visuals; every model falls back to a box if it fails to load.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const ARENA = 180;       // much-bigger arena (was 100) — issues #3 / #4
const HALF = ARENA / 2;  // 90
const WALL_H = 8;
const WALL_T = 1;

export interface MapProps {
  crate?: GLTF | null; barrel?: GLTF | null; container?: GLTF | null; rock?: GLTF | null; tree?: GLTF | null;
  grass?: GLTF | null; bush?: GLTF | null; fern?: GLTF | null; fence?: GLTF | null; log?: GLTF | null;
  bTower?: GLTF | null; bHouse1?: GLTF | null; bHouse2?: GLTF | null; bShed?: GLTF | null; bShed2?: GLTF | null;
  textures?: { grass: THREE.Texture | null; stone: THREE.Texture | null };
}

// A climbable ladder volume (axis-aligned XZ footprint in front of a wall, from baseY to topY).
export interface Ladder { minX: number; maxX: number; minZ: number; maxZ: number; baseY: number; topY: number; }

function fitWidth(obj: THREE.Object3D, targetW: number): void {
  obj.updateMatrixWorld(true);
  const s = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(s);
  obj.scale.setScalar(targetW / (Math.max(s.x, s.z) || 1));
}

export function buildArena(reg: MapProps = {}): { collision: THREE.Group; visual: THREE.Group; ladders: Ladder[] } {
  const collision = new THREE.Group();
  const visual = new THREE.Group();
  const ladders: Ladder[] = [];

  const grassTex = reg.textures?.grass ?? null;
  const stoneTex = reg.textures?.stone ?? null;
  if (grassTex) grassTex.repeat.set(45, 45);
  if (stoneTex) stoneTex.repeat.set(2, 2);
  const structMat = stoneTex ? new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1 }) : null;

  const cbox = (w: number, h: number, d: number, x: number, y: number, z: number, rotX = 0, rotZ = 0): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    if (rotZ) m.rotation.z = rotZ;
    collision.add(m);
  };
  const vstruct = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotX = 0, rotZ = 0): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), structMat ?? new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    if (rotZ) m.rotation.z = rotZ;
    m.castShadow = true;
    m.receiveShadow = true;
    visual.add(m);
  };
  const solid = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotX = 0, rotZ = 0): void => {
    vstruct(w, h, d, color, x, y, z, rotX, rotZ);
    cbox(w, h, d, x, y, z, rotX, rotZ);
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

  // Occupancy tracker so scattered cover/foliage avoids buildings + platforms.
  const occ: Array<{ x: number; z: number; r: number }> = [];
  const note = (x: number, z: number, r: number): void => { occ.push({ x, z, r }); };
  const clearSpot = (x: number, z: number, pad: number): boolean =>
    Math.hypot(x, z) > 14 && Math.hypot(x, z) < 78 && occ.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + pad);

  // --- Buildings: complete models, ENTERABLE (collision = real geometry via the Octree).
  //     Tower at center, an inner diagonal ring, and an outer cardinal ring. ---
  const place = (m: GLTF | null | undefined, w: number, x: number, z: number, rot: number, fb: { w: number; h: number; d: number }, color: number): void => {
    building(m, w, x, z, rot, fb, color);
    note(x, z, w * 0.75);
  };
  place(reg.bTower, 11, 0, 0, 0, { w: 9, h: 12, d: 9 }, 0x8a8a8a);            // central landmark
  place(reg.bHouse1, 13, -40, -40, 0, { w: 10, h: 5, d: 10 }, 0x9a8a72);     // inner diagonal ring
  place(reg.bHouse2, 13, 40, 40, Math.PI, { w: 10, h: 5, d: 10 }, 0x9a8a72);
  place(reg.bShed, 9, 40, -40, Math.PI / 2, { w: 7, h: 4, d: 7 }, 0x8a7a5a);
  place(reg.bShed2, 9, -40, 40, -Math.PI / 2, { w: 7, h: 4, d: 7 }, 0x8a7a5a);
  place(reg.bHouse2, 13, 0, -66, 0, { w: 10, h: 5, d: 10 }, 0x9a8a72);       // outer cardinal ring
  place(reg.bHouse1, 13, 0, 66, Math.PI, { w: 10, h: 5, d: 10 }, 0x9a8a72);
  place(reg.bShed, 9, -66, 0, Math.PI / 2, { w: 7, h: 4, d: 7 }, 0x8a7a5a);
  place(reg.bShed2, 9, 66, 0, -Math.PI / 2, { w: 7, h: 4, d: 7 }, 0x8a7a5a);

  // --- 4 climbable stone platforms (verticality) around the tower + axis-aware ramps ---
  const midH = 2.5;
  const rampColor = 0xaaaaaa;
  const rampAngle = Math.atan2(2.5, 10);
  const rampLen = Math.hypot(10, 2.5);
  for (const [mx, mz] of [[28, 0], [-28, 0], [0, 28], [0, -28]] as Array<[number, number]>) {
    collOnly(10, midH, 10, mx, midH / 2, mz);
    vstruct(10, midH, 10, 0x6b6f62, mx, midH / 2, mz);
    if (mz !== 0) {
      // platform on the Z axis → ramp runs along Z (tilt about X)
      solid(5, 0.5, rampLen, rampColor, mx, midH / 2, mz + (mz > 0 ? -8 : 8), mz > 0 ? rampAngle : -rampAngle, 0);
    } else {
      // platform on the X axis → ramp runs along X (tilt about Z)
      solid(rampLen, 0.5, 5, rampColor, mx + (mx > 0 ? -8 : 8), midH / 2, mz, 0, mx > 0 ? -rampAngle : rampAngle);
    }
    note(mx, mz, 9);
  }

  // --- Ladder towers: a solid tower you climb (ladder on the +Z face) to a high perch ---
  const ladderTower = (x: number, z: number): void => {
    const W = 5, H = 11;
    solid(W, H, W, 0x77787c, x, H / 2, z); // solid tower; the top (y=H) is the perch
    const lz = z + W / 2 + 0.07;           // ladder visual just in front of the +Z face
    vstruct(0.14, H, 0.14, 0x5a3a1a, x - 0.55, H / 2, lz);
    vstruct(0.14, H, 0.14, 0x5a3a1a, x + 0.55, H / 2, lz);
    for (let ry = 0.6; ry < H; ry += 0.7) vstruct(1.25, 0.1, 0.1, 0x6b4a26, x, ry, lz);
    ladders.push({ minX: x - 1.3, maxX: x + 1.3, minZ: z + W / 2, maxZ: z + W / 2 + 1.4, baseY: 0, topY: H });
    note(x, z, 5);
  };
  ladderTower(16, -16);
  ladderTower(-16, 16);

  // --- Big containers as chunky cover at clear mid-ring spots ---
  for (const [x, z, rot] of [[24, -52, 0], [-24, 52, 0], [52, 24, Math.PI / 2], [-52, -24, Math.PI / 2]] as Array<[number, number, number]>) {
    if (clearSpot(x, z, 3)) { solidProp(reg.container, 10, x, z, rot, { w: 10, h: 5, d: 4 }, 0x995533); note(x, z, 6); }
  }
  // --- Fallen logs (low cover) ---
  for (const [x, z, rot] of [[-52, 24, 0], [52, -24, 0]] as Array<[number, number, number]>) {
    if (clearSpot(x, z, 3)) { solidProp(reg.log, 6, x, z, rot, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f); note(x, z, 4); }
  }

  // --- Scattered low cover (crates / rocks / barrels), avoiding structures + spawn ring ---
  const coverDefs = [
    { m: reg.crate, w: 4, fb: { w: 4, h: 3, d: 4 }, c: 0xb5651d },
    { m: reg.rock, w: 4.5, fb: { w: 4.5, h: 2.5, d: 4.5 }, c: 0x777777 },
    { m: reg.barrel, w: 1.3, fb: { w: 1.3, h: 1.6, d: 1.3 }, c: 0xcc5533 },
  ];
  let ci = 0;
  for (let gx = -72; gx <= 72; gx += 13) {
    for (let gz = -72; gz <= 72; gz += 13) {
      const x = gx + (Math.abs(gx * 7 + gz * 13) % 7) - 3;
      const z = gz + (Math.abs(gx * 5 + gz * 11) % 7) - 3;
      if (!clearSpot(x, z, 4)) continue;
      const d = coverDefs[ci % coverDefs.length]!;
      ci++;
      solidProp(d.m, d.w, x, z, ((ci * 53) % 360) * (Math.PI / 180), d.fb, d.c);
      note(x, z, 3);
    }
  }

  // --- Trees (decorative, corners + edge midpoints) ---
  for (const [x, z] of [[82, 82], [-82, 82], [82, -82], [-82, -82], [82, 0], [-82, 0], [0, 82], [0, -82]] as Array<[number, number]>) {
    deco(reg.tree, 7, x, z);
  }

  // --- Scattered foliage (deco only; off building/platform footprints) ---
  const foliage = [reg.grass, reg.bush, reg.fern];
  const sizes = [1.7, 2.8, 2.3];
  let fi = 0;
  for (let gx = -80; gx <= 80; gx += 12) {
    for (let gz = -80; gz <= 80; gz += 12) {
      const x = gx + (Math.abs(gx * 7 + gz * 13) % 6) - 3;
      const z = gz + (Math.abs(gx * 11 + gz * 5) % 6) - 3;
      if (Math.hypot(x, z) < 10) continue;
      if (!occ.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + 1)) continue;
      const idx = fi % 3;
      deco(foliage[idx], sizes[idx]!, x, z, ((fi * 47) % 360) * (Math.PI / 180));
      fi++;
    }
  }

  return { collision, visual, ladders };
}
