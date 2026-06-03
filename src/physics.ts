// src/physics.ts — Octree/Capsule collision vs the arena (games_fps pattern).
import * as THREE from "three";
import { Octree } from "three/addons/math/Octree.js";
import { Capsule } from "three/addons/math/Capsule.js";
import { EYE_HEIGHT } from "../worker/protocol";

// Build the collision Octree from the merged arena group.
export function buildOctree(group: THREE.Object3D): Octree {
  return new Octree().fromGraphNode(group);
}

// Player collider: capsule from feet to eye height (contract-fixed).
export function makePlayerCollider(): Capsule {
  return new Capsule(
    new THREE.Vector3(0, 0.35, 0),
    new THREE.Vector3(0, EYE_HEIGHT, 0),
    0.35,
  );
}

// Resolve the collider against the world Octree, adjusting `velocity` along the
// contact normal and pushing the collider out of penetration. `velocity` is
// REQUIRED. Returns whether the player is standing on a (sufficiently
// upward-facing) floor.
export function resolveCollision(
  collider: Capsule,
  octree: Octree,
  velocity: THREE.Vector3,
): boolean {
  const result = octree.capsuleIntersect(collider);
  let onFloor = false;

  if (result) {
    // A near-upward normal means we can stand on the surface.
    onFloor = result.normal.y > 0;

    if (!onFloor) {
      // Cancel the inbound velocity component along the wall normal (slide).
      velocity.addScaledVector(result.normal, -result.normal.dot(velocity));
    }

    // Push the capsule out of the geometry by the penetration depth.
    if (result.depth >= 1e-10) {
      collider.translate(result.normal.clone().multiplyScalar(result.depth));
    }
  }

  return onFloor;
}
