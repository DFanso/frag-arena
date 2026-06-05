// src/combat.ts
// Hitscan raycast from the crosshair (NDC center) + left-click shoot wiring.
import * as THREE from "three";
import { type Vec3 } from "../worker/protocol";

// Impact this far (or more) above the player's feet counts as a headshot.
export const HEAD_THRESHOLD = 0.8;

export interface FireResult {
  hit: number | null;    // claimed target player id
  barrel: number | null; // claimed explosive-barrel id (mutually exclusive with hit)
  head: boolean;         // headshot claim
  o: Vec3;               // ray origin (camera world position)
  d: Vec3;               // ray direction (camera forward, normalized)
}

// Minimal shape of what findPlayerId reads — lets it be unit-tested with mocks.
interface HasUserData { userData: Record<string, unknown>; parent: HasUserData | null; }

// Pure: climb parents until an ancestor carries a numeric userData.playerId.
export function findPlayerId(start: HasUserData | null): number | null {
  let node: HasUserData | null = start;
  while (node) {
    const id = node.userData["playerId"];
    if (typeof id === "number") return id;
    node = node.parent;
  }
  return null;
}

// Pure: climb parents until an ancestor carries a numeric userData.barrelId.
export function findBarrelId(start: HasUserData | null): number | null {
  let node: HasUserData | null = start;
  while (node) {
    const id = node.userData["barrelId"];
    if (typeof id === "number") return id;
    node = node.parent;
  }
  return null;
}

// Pure: is the impact y far enough above the player's base y to be a headshot?
export function isHead(impactY: number, playerBaseY: number): boolean {
  return impactY - playerBaseY > HEAD_THRESHOLD;
}

const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Cast from the crosshair (screen center) against the given meshes; return the claim.
export function fireRay(camera: THREE.Camera, targets: THREE.Object3D[]): FireResult {
  _raycaster.setFromCamera(_center, camera);

  camera.getWorldPosition(_origin);
  camera.getWorldDirection(_dir);
  const o: Vec3 = [_origin.x, _origin.y, _origin.z];
  const d: Vec3 = [_dir.x, _dir.y, _dir.z];

  const intersects = _raycaster.intersectObjects(targets, true);
  for (const it of intersects) {
    if (it.object.userData["noHit"]) continue; // skip nameplates etc.
    const barrel = findBarrelId(it.object as unknown as HasUserData);
    if (barrel !== null) return { hit: null, barrel, head: false, o, d };
    const id = findPlayerId(it.object as unknown as HasUserData);
    if (id === null) continue;
    // The target group origin is at the player's feet (base y).
    const playerBaseY = findGroupBaseY(it.object) ?? it.point.y;
    return { hit: id, barrel: null, head: isHead(it.point.y, playerBaseY), o, d };
  }
  return { hit: null, barrel: null, head: false, o, d };
}

// Walk up to the topmost ancestor (the RemotePlayer group) to read its world feet y.
function findGroupBaseY(obj: THREE.Object3D): number | null {
  let node: THREE.Object3D | null = obj;
  let top: THREE.Object3D | null = null;
  while (node) {
    if (typeof node.userData["playerId"] === "number") top = node.parent ?? node;
    node = node.parent;
  }
  if (!top) return null;
  const pos = top.getWorldPosition(new THREE.Vector3());
  return pos.y;
}

