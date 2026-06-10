// src/combat.ts
// Hitscan raycast from the crosshair (NDC center) + left-click shoot wiring.
import * as THREE from "three";
import { ROCKET_MAX_RANGE, HEAD_THRESHOLD, type Vec3 } from "../worker/protocol";

// Impact this far (or more) above the player's feet counts as a headshot. Sourced from protocol
// so the client and the server's authoritative check (worker/validate isHeadshot) stay in sync.
export { HEAD_THRESHOLD };

// ---- Aim spread / bloom (#20) — COSMETIC ONLY: drives the crosshair widen (Hud.setCrosshairSpread)
// as recoil feedback. It no longer deviates the shot — bullets are pinpoint to the crosshair (fireRay).
export const SPREAD_BLOOM_MAX = 0.05;     // max NDC bloom the crosshair can accumulate above base
export const SPREAD_DECAY_PER_SEC = 0.12; // NDC of crosshair bloom recovered per second toward base

/** Pure: grow the spread by one shot's worth, clamped to base + SPREAD_BLOOM_MAX. */
export function bumpSpread(cur: number, base: number, growth: number): number {
  return Math.min(cur + growth, base + SPREAD_BLOOM_MAX);
}

/** Pure: decay the spread toward `base` over `dtMs`, never below base. */
export function decaySpread(cur: number, base: number, dtMs: number): number {
  if (cur <= base) return base;
  return Math.max(base, cur - SPREAD_DECAY_PER_SEC * (dtMs / 1000));
}

export interface FireResult {
  hit: number | null;    // claimed target player id
  barrel: number | null; // claimed explosive-barrel id (mutually exclusive with hit)
  head: boolean;         // headshot claim
  o: Vec3;               // ray origin (camera world position)
  d: Vec3;               // ray direction (camera forward, normalized)
  point: Vec3 | null;    // impact point when something was struck (tracer endpoint, #67)
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
const _center = new THREE.Vector2(0, 0); // the crosshair = screen centre (NDC 0,0); never mutated
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Cast from the crosshair (screen centre, NDC 0,0) against the given meshes and return the claim.
// Bullets are pinpoint-accurate to the crosshair: the cast ray, the reported direction `d`, and the
// tracer endpoint (`point`) are ALL the same centre ray, so whatever sits under the crosshair is
// exactly what gets hit. Aim-spread/bloom (#20) is cosmetic (crosshair widen) and never offsets it.
export function fireRay(camera: THREE.Camera, targets: THREE.Object3D[]): FireResult {
  _raycaster.setFromCamera(_center, camera);

  camera.getWorldPosition(_origin);
  camera.getWorldDirection(_dir);
  const o: Vec3 = [_origin.x, _origin.y, _origin.z];
  const d: Vec3 = [_dir.x, _dir.y, _dir.z];

  const intersects = _raycaster.intersectObjects(targets, true);
  for (const it of intersects) {
    if (it.object.userData["noHit"]) continue; // skip nameplates etc.
    const point: Vec3 = [it.point.x, it.point.y, it.point.z];
    const barrel = findBarrelId(it.object as unknown as HasUserData);
    if (barrel !== null) return { hit: null, barrel, head: false, o, d, point };
    const id = findPlayerId(it.object as unknown as HasUserData);
    if (id === null) continue;
    // The target group origin is at the player's feet (base y).
    const playerBaseY = findGroupBaseY(it.object) ?? it.point.y;
    return { hit: id, barrel: null, head: isHead(it.point.y, playerBaseY), o, d, point };
  }
  return { hit: null, barrel: null, head: false, o, d, point: null };
}

// What a fired rocket struck: the impact point in world space plus whether it was a player /
// barrel (so the client can show feedback). The server re-derives the blast from o + d + point.
export interface RocketResult {
  o: Vec3;               // ray origin (camera world position)
  d: Vec3;               // ray direction (camera forward, normalized)
  point: Vec3;           // first impact point against players / barrels / world geometry
  hit: number | null;    // player id struck directly (else null)
  barrel: number | null; // explosive-barrel id struck directly (else null)
}

// Cast the rocket from the crosshair against entities (player proxies + barrels) AND world
// geometry (the arena collision group), and return the nearest impact point. Unlike the
// hitscan path this reports WHERE the ray stops on a wall/floor too, so the rocket explodes
// on cover instead of flying through it. Detonation + damage stay server-authoritative.
export function fireRocket(
  camera: THREE.Camera,
  entityTargets: THREE.Object3D[],
  worldTargets: THREE.Object3D[],
): RocketResult {
  _raycaster.setFromCamera(_center, camera); // screen centre — rockets also fire dead-on the crosshair
  const prevFar = _raycaster.far;
  _raycaster.far = ROCKET_MAX_RANGE;

  camera.getWorldPosition(_origin);
  camera.getWorldDirection(_dir);
  const o: Vec3 = [_origin.x, _origin.y, _origin.z];
  const d: Vec3 = [_dir.x, _dir.y, _dir.z];

  try {
    const intersects = _raycaster.intersectObjects([...entityTargets, ...worldTargets], true);
    for (const it of intersects) {
      if (it.object.userData["noHit"]) continue; // skip nameplates / health bars
      const point: Vec3 = [it.point.x, it.point.y, it.point.z];
      const barrel = findBarrelId(it.object as unknown as HasUserData);
      if (barrel !== null) return { o, d, point, hit: null, barrel };
      const id = findPlayerId(it.object as unknown as HasUserData);
      if (id !== null) return { o, d, point, hit: id, barrel: null };
      return { o, d, point, hit: null, barrel: null }; // world geometry impact
    }
    // Nothing within range: detonate at max range straight ahead.
    const point: Vec3 = [
      o[0] + d[0] * ROCKET_MAX_RANGE,
      o[1] + d[1] * ROCKET_MAX_RANGE,
      o[2] + d[2] * ROCKET_MAX_RANGE,
    ];
    return { o, d, point, hit: null, barrel: null };
  } finally {
    _raycaster.far = prevFar; // don't leak the shorter range into the hitscan path
  }
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

