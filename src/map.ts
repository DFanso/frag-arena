// src/map.ts — 240x240 Cold-War arena. COLLISION group = invisible solid boxes + enterable
// building walls (Octree source + rocket impact raycast). VISUAL group = ground, 3 climbable
// towers (center tallest), CLOSED enterable concrete homes (some two-story) with E-doors +
// windows + roofs, ziplines, cover, trees, foliage, and dim interior lights. Doors are returned
// as specs and handled at runtime by src/doors.ts.
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import {
  CENTER_TOWER, ROCKET_TOWER, WATCH_TOWER, ZIPLINES, SPAWN_POINTS,
  AMMO_PICKUPS, GRENADE_PICKUPS, HEALTH_PICKUPS, ARMOR_PICKUPS, SPRING_PICKUPS, EXPLOSIVE_BARRELS,
  type Vec3,
} from "../worker/protocol";
import type { DoorSpec } from "./doors";

const ARENA = 240;
const HALF = ARENA / 2;  // 120
const WALL_H = 8;
const WALL_T = 1;
const CONCRETE = 0x6e6e6a; // Soviet concrete gray

// Exported for the minimap (src/hud.ts): arena scale + the major structures to draw as
// footprints. Kept in sync by hand with the `home(...)` and `ladderTower(...)` placements
// below — homes are 2*halfW squares at ±62; the three towers are 5×5 (W=5 in ladderTower).
export const ARENA_SIZE = ARENA;
export const ARENA_HALF = HALF;
export interface MinimapRect { x: number; z: number; w: number; d: number; }
export const MINIMAP_BUILDINGS: readonly MinimapRect[] = [
  // Enterable homes — home(cx, cz, halfW, stories): footprint = 2*halfW square.
  { x: 62, z: 0, w: 18, d: 18 }, { x: -62, z: 0, w: 16, d: 16 },
  { x: 0, z: 62, w: 18, d: 18 }, { x: 0, z: -62, w: 16, d: 16 },
  { x: 62, z: 62, w: 16, d: 16 }, { x: -62, z: -62, w: 18, d: 18 },
  // Climbable towers (5×5 concrete columns).
  { x: CENTER_TOWER[0], z: CENTER_TOWER[2], w: 5, d: 5 },
  { x: ROCKET_TOWER[0], z: ROCKET_TOWER[2], w: 5, d: 5 },
  { x: WATCH_TOWER[0], z: WATCH_TOWER[2], w: 5, d: 5 },
];

export interface MapProps {
  crate?: GLTF | null; barrel?: GLTF | null; container?: GLTF | null; rock?: GLTF | null; tree?: GLTF | null;
  grass?: GLTF | null; bush?: GLTF | null; fern?: GLTF | null; fence?: GLTF | null; log?: GLTF | null;
  bTower?: GLTF | null; bHouse1?: GLTF | null; bHouse2?: GLTF | null; bShed?: GLTF | null; bShed2?: GLTF | null;
  textures?: { grass: THREE.Texture | null; stone: THREE.Texture | null };
}

export interface Ladder { minX: number; maxX: number; minZ: number; maxZ: number; baseY: number; topY: number; }

function fitWidth(obj: THREE.Object3D, targetW: number): void {
  obj.updateMatrixWorld(true);
  const s = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(s);
  obj.scale.setScalar(targetW / (Math.max(s.x, s.z) || 1));
}

export function buildArena(reg: MapProps = {}): { collision: THREE.Group; visual: THREE.Group; ladders: Ladder[]; doors: DoorSpec[] } {
  const collision = new THREE.Group();
  const visual = new THREE.Group();
  const ladders: Ladder[] = [];
  const doors: DoorSpec[] = [];

  const grassTex = reg.textures?.grass ?? null;
  const stoneTex = reg.textures?.stone ?? null;
  if (grassTex) grassTex.repeat.set(60, 60);
  if (stoneTex) stoneTex.repeat.set(2, 2);
  const structMat = stoneTex ? new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 1 }) : null;

  const cbox = (w: number, h: number, d: number, x: number, y: number, z: number, rotX = 0, rotZ = 0): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
    m.position.set(x, y, z);
    if (rotX) m.rotation.x = rotX;
    if (rotZ) m.rotation.z = rotZ;
    collision.add(m);
  };
  const vstruct = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rotX = 0, rotZ = 0, textured = true): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), textured && structMat ? structMat : new THREE.MeshStandardMaterial({ color, roughness: 1 }));
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
  // Concrete structural box (visual uses a flat concrete color, NOT the stone texture).
  const conc = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    vstruct(w, h, d, CONCRETE, x, y, z, 0, 0, false);
    cbox(w, h, d, x, y, z);
  };
  const collOnly = (w: number, h: number, d: number, x: number, y: number, z: number): void => { cbox(w, h, d, x, y, z); };

  const shade = (o: THREE.Object3D): void => {
    o.traverse((m) => { m.userData.noHit = true; if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  };
  const deco = (model: GLTF | null | undefined, footprintW: number, x: number, z: number, rotY = 0): THREE.Object3D | null => {
    if (!model) return null;
    const o = cloneSkeleton(model.scene);
    fitWidth(o, footprintW);
    o.position.set(x, 0, z);
    if (rotY) o.rotation.y = rotY;
    o.updateMatrixWorld(true);
    o.position.y -= new THREE.Box3().setFromObject(o).min.y;
    o.updateMatrixWorld(true);
    shade(o);
    visual.add(o);
    return o;
  };
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

  // --- Ground ---
  const groundMat = grassTex
    ? new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 })
    : new THREE.MeshStandardMaterial({ color: 0x3a5f3a, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  visual.add(ground);
  cbox(ARENA, 1, ARENA, 0, -0.5, 0);

  // --- Perimeter ---
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
    vstruct(ARENA, WALL_H, WALL_T, 0x4a525a, 0, wy, -HALF, 0, 0, false);
    vstruct(ARENA, WALL_H, WALL_T, 0x4a525a, 0, wy, HALF, 0, 0, false);
    vstruct(WALL_T, WALL_H, ARENA, 0x4a525a, -HALF, wy, 0, 0, 0, false);
    vstruct(WALL_T, WALL_H, ARENA, 0x4a525a, HALF, wy, 0, 0, 0, false);
  }

  const occ: Array<{ x: number; z: number; r: number }> = [];
  const note = (x: number, z: number, r: number): void => { occ.push({ x, z, r }); };
  const clearSpot = (x: number, z: number, pad: number): boolean =>
    Math.hypot(x, z) > 16 && Math.hypot(x, z) < 104 && occ.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + pad);

  // --- Climbable towers (center tallest) ---
  const ladderTower = (t: Vec3, top = 0x5a5d62): void => {
    const [x, H, z] = t;
    const W = 5;
    conc(W, H, W, x, H / 2, z);
    void top;
    const lz = z + W / 2 + 0.07;
    vstruct(0.14, H, 0.14, 0x3a2a16, x - 0.55, H / 2, lz, 0, 0, false);
    vstruct(0.14, H, 0.14, 0x3a2a16, x + 0.55, H / 2, lz, 0, 0, false);
    for (let ry = 0.6; ry < H; ry += 0.7) vstruct(1.25, 0.1, 0.1, 0x4b3a1e, x, ry, lz, 0, 0, false);
    ladders.push({ minX: x - 1.3, maxX: x + 1.3, minZ: z + W / 2, maxZ: z + W / 2 + 1.4, baseY: 0, topY: H });
    note(x, z, 5);
  };
  ladderTower(CENTER_TOWER);
  ladderTower(ROCKET_TOWER);
  ladderTower(WATCH_TOWER);

  // --- Enterable concrete homes (closed: walls + roof + windows + an E-door). `stories` 1 or 2. ---
  const T = 0.7, doorW = 3.2, doorH = 3, winW = 2.6;
  // A wall with a centered window gap, along X (z fixed) or Z (x fixed), from baseY up by h.
  const winWallX = (cx: number, zc: number, halfLen: number, baseY: number, h: number): void => {
    const sillOff = 1.0, headOff = h - 0.8, side = 2 * halfLen;
    conc(side, sillOff, T, cx, baseY + sillOff / 2, zc);
    conc(side, h - headOff, T, cx, baseY + (headOff + h) / 2, zc);
    const post = halfLen - winW / 2;
    conc(post, headOff - sillOff, T, cx - (winW / 2 + post / 2), baseY + (sillOff + headOff) / 2, zc);
    conc(post, headOff - sillOff, T, cx + (winW / 2 + post / 2), baseY + (sillOff + headOff) / 2, zc);
  };
  const winWallZ = (xc: number, cz: number, halfLen: number, baseY: number, h: number): void => {
    const sillOff = 1.0, headOff = h - 0.8, side = 2 * halfLen;
    conc(T, sillOff, side, xc, baseY + sillOff / 2, cz);
    conc(T, h - headOff, side, xc, baseY + (headOff + h) / 2, cz);
    const post = halfLen - winW / 2;
    conc(T, headOff - sillOff, post, xc, baseY + (sillOff + headOff) / 2, cz - (winW / 2 + post / 2));
    conc(T, headOff - sillOff, post, xc, baseY + (sillOff + headOff) / 2, cz + (winW / 2 + post / 2));
  };
  // Front wall (-Z) with a doorway: two side segments + a lintel above the door; pushes a DoorSpec.
  const doorWallX = (cx: number, zc: number, halfLen: number, h: number): void => {
    const seg = halfLen - doorW / 2;
    conc(seg, h, T, cx - (doorW / 2 + seg / 2), h / 2, zc);
    conc(seg, h, T, cx + (doorW / 2 + seg / 2), h / 2, zc);
    conc(doorW, h - doorH, T, cx, (doorH + h) / 2, zc); // lintel
    doors.push({ hinge: [cx - doorW / 2, 0, zc], width: doorW, height: doorH, axis: "x", swing: 1 });
  };

  const home = (cx: number, cz: number, halfW: number, stories: number): void => {
    const H1 = 4, H2 = 3.6;
    // Ground floor: door on the front (-Z), windows on the other three sides.
    doorWallX(cx, cz - halfW, halfW, H1);
    winWallX(cx, cz + halfW, halfW, 0, H1);
    winWallZ(cx - halfW, cz, halfW, 0, H1);
    winWallZ(cx + halfW, cz, halfW, 0, H1);
    if (stories >= 2) {
      // Mezzanine floor over the left ~55% (the right side is open, double-height), reached by a ramp.
      const mezzRight = cx + halfW * 0.1;
      const mezzW = mezzRight - (cx - halfW);
      conc(mezzW, 0.4, 2 * halfW, (cx - halfW) + mezzW / 2, H1 - 0.2, cz);
      // Ramp up to the mezzanine edge (interior, right side).
      const run = halfW - 1.5, rise = H1;
      const ang = Math.atan2(rise, run);
      solid(Math.hypot(run, rise), 0.4, 3.2, 0x55554f, cx + halfW * 0.1 + run / 2, H1 / 2, cz, 0, ang);
      // Upper floor: windows all around.
      winWallX(cx, cz - halfW, halfW, H1, H2);
      winWallX(cx, cz + halfW, halfW, H1, H2);
      winWallZ(cx - halfW, cz, halfW, H1, H2);
      winWallZ(cx + halfW, cz, halfW, H1, H2);
      conc(2 * halfW + T, 0.4, 2 * halfW + T, cx, H1 + H2 + 0.2, cz); // roof
    } else {
      conc(2 * halfW + T, 0.4, 2 * halfW + T, cx, H1 + 0.2, cz); // roof
    }
    // Dim interior light so the closed home isn't pitch-black under the overcast sky.
    const light = new THREE.PointLight(0x9fb4cc, 14, 22, 1.6);
    light.position.set(cx, stories >= 2 ? H1 + 1 : H1 * 0.6, cz);
    visual.add(light);
    note(cx, cz, halfW + 2);
  };
  home(62, 0, 9, 2);
  home(-62, 0, 8, 1);
  home(0, 62, 9, 2);
  home(0, -62, 8, 1);
  home(62, 62, 8, 1);
  home(-62, -62, 9, 2);

  // --- Ziplines ---
  for (const z of ZIPLINES) {
    const a = new THREE.Vector3(z.a[0], z.a[1], z.a[2]);
    const b = new THREE.Vector3(z.b[0], z.b[1], z.b[2]);
    const cable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, a.distanceTo(b), 6),
      new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.6, metalness: 0.4 }),
    );
    cable.position.copy(a.clone().add(b).multiplyScalar(0.5));
    cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    cable.userData.noHit = true;
    visual.add(cable);
  }

  // Exclude every pickup + barrel + spawn spot from scattered-cover placement.
  for (const arr of [AMMO_PICKUPS, GRENADE_PICKUPS, HEALTH_PICKUPS, ARMOR_PICKUPS, SPRING_PICKUPS, EXPLOSIVE_BARRELS, SPAWN_POINTS]) {
    for (const p of arr) note(p[0], p[2], 4);
  }

  // --- Chunky cover: containers + logs ---
  for (const [x, z, rot] of [[30, -70, 0], [-30, 70, 0], [70, 30, Math.PI / 2], [-70, -30, Math.PI / 2]] as Array<[number, number, number]>) {
    if (clearSpot(x, z, 3)) { solidProp(reg.container, 10, x, z, rot, { w: 10, h: 5, d: 4 }, 0x6a6a60); note(x, z, 6); }
  }
  for (const [x, z, rot] of [[-70, 30, 0], [70, -30, 0]] as Array<[number, number, number]>) {
    if (clearSpot(x, z, 3)) { solidProp(reg.log, 6, x, z, rot, { w: 6, h: 1.4, d: 1.6 }, 0x4f3d24); note(x, z, 4); }
  }

  // --- Scattered low cover: crates + rocks ONLY (no inert barrels — all barrels are explosive) ---
  const coverDefs = [
    { m: reg.crate, w: 4, fb: { w: 4, h: 3, d: 4 }, c: 0x8a6a3a },
    { m: reg.rock, w: 4.5, fb: { w: 4.5, h: 2.5, d: 4.5 }, c: 0x5a5a5a },
  ];
  let ci = 0;
  for (let gx = -96; gx <= 96; gx += 14) {
    for (let gz = -96; gz <= 96; gz += 14) {
      const x = gx + (Math.abs(gx * 7 + gz * 13) % 7) - 3;
      const z = gz + (Math.abs(gx * 5 + gz * 11) % 7) - 3;
      if (!clearSpot(x, z, 4)) continue;
      const d = coverDefs[ci % coverDefs.length]!;
      ci++;
      solidProp(d.m, d.w, x, z, ((ci * 53) % 360) * (Math.PI / 180), d.fb, d.c);
      note(x, z, 3);
    }
  }

  // --- Trees + foliage (decorative) ---
  for (const [x, z] of [[110, 110], [-110, 110], [110, -110], [-110, -110], [110, 0], [-110, 0], [0, 110], [0, -110]] as Array<[number, number]>) {
    deco(reg.tree, 8, x, z);
  }
  const foliage = [reg.grass, reg.bush, reg.fern];
  const sizes = [1.7, 2.8, 2.3];
  let fi = 0;
  for (let gx = -104; gx <= 104; gx += 13) {
    for (let gz = -104; gz <= 104; gz += 13) {
      const x = gx + (Math.abs(gx * 7 + gz * 13) % 6) - 3;
      const z = gz + (Math.abs(gx * 11 + gz * 5) % 6) - 3;
      if (Math.hypot(x, z) < 12) continue;
      if (!occ.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + 1)) continue;
      const idx = fi % 3;
      deco(foliage[idx], sizes[idx]!, x, z, ((fi * 47) % 360) * (Math.PI / 180));
      fi++;
    }
  }

  return { collision, visual, ladders, doors };
}
