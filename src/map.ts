// src/map.ts — blocky arena geometry merged into a single THREE.Group.
// Ground 60x60, 4 perimeter walls (h6), 4 cover boxes, 2 ramps to a low platform.
import * as THREE from "three";

const ARENA = 60; // ground is 60 x 60, centered at origin
const HALF = ARENA / 2; // 30
const WALL_H = 6;
const WALL_T = 1; // wall thickness

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildArena(): THREE.Group {
  const group = new THREE.Group();

  // Ground: a 60x60 slab (thin box so the Octree has a solid floor volume).
  const groundT = 1;
  const ground = box(ARENA, groundT, ARENA, 0x556b2f, 0, -groundT / 2, 0);
  group.add(ground);

  // 4 perimeter walls (height 6) enclosing the 60x60 area.
  const wy = WALL_H / 2;
  group.add(box(ARENA, WALL_H, WALL_T, 0x8899aa, 0, wy, -HALF)); // north (-z)
  group.add(box(ARENA, WALL_H, WALL_T, 0x8899aa, 0, wy, HALF)); // south (+z)
  group.add(box(WALL_T, WALL_H, ARENA, 0x8899aa, -HALF, wy, 0)); // west (-x)
  group.add(box(WALL_T, WALL_H, ARENA, 0x8899aa, HALF, wy, 0)); // east (+x)

  // 4 cover boxes ~ [4,3,4] at (+-10, 1.5, +-10).
  const coverColor = 0xcc8844;
  group.add(box(4, 3, 4, coverColor, -10, 1.5, -10));
  group.add(box(4, 3, 4, coverColor, 10, 1.5, -10));
  group.add(box(4, 3, 4, coverColor, 10, 1.5, 10));
  group.add(box(4, 3, 4, coverColor, -10, 1.5, 10));

  // A low platform near the center to reach via ramps.
  const platW = 8;
  const platH = 2;
  const platD = 8;
  const platColor = 0x6677aa;
  group.add(box(platW, platH, platD, platColor, 0, platH / 2, 0));

  // 2 ramps: thin boxes rotated ~20 degrees giving access to the platform.
  const rampAngle = (20 * Math.PI) / 180;
  const rampLen = 10;
  const rampColor = 0xaaaaaa;

  const ramp1 = box(4, 0.4, rampLen, rampColor, 0, platH / 2 - 0.2, platD / 2 + 4);
  ramp1.rotation.x = rampAngle;
  group.add(ramp1);

  const ramp2 = box(4, 0.4, rampLen, rampColor, 0, platH / 2 - 0.2, -(platD / 2 + 4));
  ramp2.rotation.x = -rampAngle;
  group.add(ramp2);

  return group;
}
