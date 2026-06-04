// src/map.ts — 100x100 arena. COLLISION group = invisible solid boxes (Octree source,
// unchanged). VISUAL group = grass-textured ground + modular CC0 stone/castle kit walls
// (battlemented) assembled along each structure's footprint, plus props/foliage. Collision
// is decoupled from visuals, so structures can be rebuilt from kit pieces without touching
// gameplay. Every kit piece falls back to a stone-textured box if its model is missing.
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
  kitWall?: GLTF | null; kitDoor?: GLTF | null; kitFloor?: GLTF | null;
  kitStairs?: GLTF | null; kitColumn?: GLTF | null; kitBroken?: GLTF | null;
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

  // A measured, placeable kit piece (fitted to a tile width). place() base-anchors the
  // model (bottom at baseY) and rotates about Y. `ok` is false if the model is missing.
  type Kit = { ok: boolean; w: number; h: number; minY: number; place: (x: number, baseY: number, z: number, rotY?: number) => void };
  const makeKit = (model: GLTF | null | undefined, tileW: number): Kit => {
    if (!model) return { ok: false, w: tileW, h: tileW, minY: 0, place: () => {} };
    const probe = cloneSkeleton(model.scene);
    fitWidth(probe, tileW);
    probe.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(probe);
    const s = new THREE.Vector3(); bb.getSize(s);
    const w = s.x, h = s.y, minY = bb.min.y;
    return {
      ok: true, w, h, minY,
      place: (x, baseY, z, rotY = 0) => {
        const o = cloneSkeleton(model.scene);
        fitWidth(o, tileW);
        o.position.set(x, baseY - minY, z);
        if (rotY) o.rotation.y = rotY;
        o.traverse((m) => {
          m.userData.noHit = true;
          if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        visual.add(o);
      },
    };
  };

  const WALL_TILE = 2.6; // fitted wall width; height ≈ 1.31 * tile ≈ 3.4
  const wallK = makeKit(reg.kitWall, WALL_TILE);
  const brokenK = makeKit(reg.kitBroken, WALL_TILE);
  const columnK = makeKit(reg.kitColumn, 2.4);

  // Tile a kit wall (or broken wall) along one axis-aligned edge. `skipMid` leaves the
  // center piece out to form a doorway gap. Falls back to a stone box if the kit is absent.
  const wallEdge = (k: Kit, x1: number, z1: number, x2: number, z2: number, baseY: number, skipMid = false): void => {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const alongX = Math.abs(dx) >= Math.abs(dz);
    if (!k.ok) {
      vstruct(alongX ? len : 0.6, 3.4, alongX ? 0.6 : len, 0x8a7a66, (x1 + x2) / 2, baseY + 1.7, (z1 + z2) / 2);
      return;
    }
    const n = Math.max(1, Math.round(len / k.w));
    const mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      if (skipMid && Math.abs(i - mid) < 0.5) continue; // leave a doorway gap
      const t = (i + 0.5) / n;
      k.place(x1 + dx * t, baseY, z1 + dz * t, alongX ? 0 : Math.PI / 2);
    }
  };

  // A walled rectangle (battlemented ring). `door` side gets a center gap.
  const ring = (k: Kit, cx: number, cz: number, w: number, d: number, baseY: number, door?: "n" | "s" | "e" | "w"): void => {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    wallEdge(k, x0, z0, x1, z0, baseY, door === "n");
    wallEdge(k, x0, z1, x1, z1, baseY, door === "s");
    wallEdge(k, x0, z0, x0, z1, baseY, door === "w");
    wallEdge(k, x1, z0, x1, z1, baseY, door === "e");
  };

  // Props / foliage (collision = model bounds for cover; deco = visual only). Unchanged.
  const placeModel = (model: GLTF | null | undefined, target: number, x: number, z: number, rotY = 0): THREE.Object3D | null => {
    if (!model) return null;
    const o = cloneSkeleton(model.scene);
    fitWidth(o, target);
    o.position.set(x, 0, z);
    if (rotY) o.rotation.y = rotY;
    o.updateMatrixWorld(true);
    o.traverse((m) => { m.userData.noHit = true; if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    visual.add(o);
    return o;
  };
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
  const deco = (model: GLTF | null | undefined, target: number, x: number, z: number, rotY = 0): void => {
    placeModel(model, target, x, z, rotY);
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

  // --- Central tower: solid collision blocks + kit-wall rings, stone decks, ramps, turrets ---
  collOnly(16, 2.5, 16, 0, 1.25, 0);
  collOnly(8, 2.5, 8, 0, 3.75, 0);
  ring(wallK, 0, 0, 16, 16, 0, "s");           // ground ring (gateway facing the south ramp)
  vstruct(16, 0.3, 16, 0x8a8a8a, 0, 2.5, 0);   // lower deck surface
  ring(wallK, 0, 0, 8, 8, 2.5);                // upper ring
  vstruct(8, 0.3, 8, 0x8a8a8a, 0, 5, 0);       // upper deck surface
  if (columnK.ok) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>) columnK.place(sx * 8, 0, sz * 8);
  const rampColor = 0xaaaaaa;
  const rampAngle = Math.atan2(2.5, 10);
  const rampLen = Math.hypot(10, 2.5);
  solid(6, 0.5, rampLen, rampColor, 0, 1.25, 13, rampAngle);
  solid(6, 0.5, rampLen, rampColor, 0, 1.25, -13, -rampAngle);

  // --- 2 mid platforms: solid block + stone deck + ramp ---
  const midH = 2.5;
  for (const [mx, mz] of [[26, -26], [-26, 26]] as Array<[number, number]>) {
    collOnly(10, midH, 10, mx, midH / 2, mz);
    vstruct(10, midH, 10, 0x5a6a55, mx, midH / 2, mz);
    solid(5, 0.5, rampLen, rampColor, mx + (mx > 0 ? -1 : 1) * 8, midH / 2, mz);
  }

  // --- Pillars: collision + stone column (matches collision height) ---
  for (const [px, pz] of [[15, 15], [-15, 15], [15, -15], [-15, -15], [0, 35], [0, -35]] as Array<[number, number]>) {
    collOnly(2, 6, 2, px, 3, pz);
    vstruct(2, 6, 2, 0x6b6f78, px, 3, pz);
  }

  // --- Lane walls: collision + kit-wall run ---
  collOnly(16, 3, 1, 22, 1.5, 0);
  collOnly(16, 3, 1, -22, 1.5, 0);
  wallEdge(wallK, 22 - 8, 0, 22 + 8, 0, 0);
  wallEdge(wallK, -22 - 8, 0, -22 + 8, 0, 0);

  // --- 4 quadrant cover-bases: crates + collision L-walls + kit-wall L ---
  for (const [bx, bz] of [[28, 28], [-28, 28], [28, -28], [-28, -28]] as Array<[number, number]>) {
    cover(reg.crate, 4, bx, bz, { w: 4, h: 3, d: 4 }, 0xb5651d);
    cover(reg.crate, 3, bx + 5, bz + 1, { w: 3, h: 2.5, d: 3 }, 0xb5651d);
    collOnly(8, 2.5, 1, bx - 2, 1.25, bz - 4);
    collOnly(1, 2.5, 8, bx - 6, 1.25, bz);
    wallEdge(wallK, bx - 6, bz - 4, bx + 2, bz - 4, 0);
    wallEdge(wallK, bx - 6, bz - 4, bx - 6, bz + 4, 0);
  }

  // --- Containers ---
  cover(reg.container, 9, 38, 0, { w: 9, h: 5, d: 4 }, 0x995533);
  cover(reg.container, 9, -38, 0, { w: 9, h: 5, d: 4 }, 0x995533);

  // --- Broken houses: collision wall boxes + kit-wall ring (door gap, broken back wall) ---
  const house = (cx: number, cz: number, door: "n" | "s" | "e" | "w"): void => {
    const W = 10, D = 10, H = 4, T = 0.6, hx = W / 2, hz = D / 2, low = 1.8;
    const opp = door === "n" ? "s" : door === "s" ? "n" : door === "e" ? "w" : "e";
    // Collision: doorway gap on `door` (walk-in), low collapsed wall on the opposite side.
    const cEdgeX = (z: number, gap: boolean, h: number): void => {
      if (gap) { const seg = (W - 3) / 2; collOnly(seg, h, T, cx - (1.5 + seg / 2), h / 2, z); collOnly(seg, h, T, cx + (1.5 + seg / 2), h / 2, z); }
      else collOnly(W, h, T, cx, h / 2, z);
    };
    const cEdgeZ = (x: number, gap: boolean, h: number): void => {
      if (gap) { const seg = (D - 3) / 2; collOnly(T, h, seg, x, h / 2, cz - (1.5 + seg / 2)); collOnly(T, h, seg, x, h / 2, cz + (1.5 + seg / 2)); }
      else collOnly(T, h, D, x, h / 2, cz);
    };
    cEdgeX(cz - hz, door === "n", door === "s" ? low : H);
    cEdgeX(cz + hz, door === "s", door === "n" ? low : H);
    cEdgeZ(cx - hx, door === "w", door === "e" ? low : H);
    cEdgeZ(cx + hx, door === "e", door === "w" ? low : H);
    // Kit visual: 3 walls + a gateway gap on `door`; the opposite side is a broken wall.
    const edges: Array<["n" | "s" | "e" | "w", number, number, number, number]> = [
      ["n", cx - hx, cz - hz, cx + hx, cz - hz],
      ["s", cx - hx, cz + hz, cx + hx, cz + hz],
      ["w", cx - hx, cz - hz, cx - hx, cz + hz],
      ["e", cx + hx, cz - hz, cx + hx, cz + hz],
    ];
    for (const [side, ax, az, bx, bz] of edges) {
      if (side === opp) wallEdge(brokenK.ok ? brokenK : wallK, ax, az, bx, bz, 0);
      else wallEdge(wallK, ax, az, bx, bz, 0, side === door);
    }
  };
  house(-32, 14, "e");
  house(32, -14, "w");
  house(16, 32, "s");

  // --- Ruined wall fragments: collision + broken-wall pieces ---
  const ruin = (cx: number, cz: number): void => {
    collOnly(7, 2.2, 0.8, cx, 1.1, cz);
    collOnly(0.8, 2.2, 5, cx - 3, 1.1, cz + 2.5);
    wallEdge(brokenK.ok ? brokenK : wallK, cx - 3.5, cz, cx + 3.5, cz, 0);
    wallEdge(brokenK.ok ? brokenK : wallK, cx - 3, cz, cx - 3, cz + 5, 0);
  };
  ruin(-14, 30);
  ruin(34, 8);
  ruin(-36, -14);

  // --- Barrels + rocks: small SOLID cover ---
  for (const [x, z] of [[10, 8], [-10, 8], [8, -10], [-8, -10], [12, 12], [-12, -12]] as Array<[number, number]>) {
    cover(reg.barrel, 1.2, x, z, { w: 1.2, h: 1.6, d: 1.2 }, 0xcc5533);
  }
  for (const [x, z] of [[40, 22], [-40, -22], [22, 40], [-22, -40], [42, -8]] as Array<[number, number]>) {
    cover(reg.rock, 4, x, z, { w: 4, h: 2.5, d: 4 }, 0x777777);
  }

  // --- Fallen logs (low cover) + trees (decorative corners) ---
  cover(reg.log, 6, 6, 40, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f);
  cover(reg.log, 6, -6, -40, { w: 6, h: 1.4, d: 1.6 }, 0x6b4f2f);
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
      if (Math.hypot(x, z) < 12) continue;
      const idx = fi % 3;
      deco(foliage[idx], sizes[idx]!, x, z, ((fi * 47) % 360) * (Math.PI / 180));
      fi++;
    }
  }

  return { collision, visual };
}
