// src/armory.ts — held-weapon templates for remote players (spec 2026-06-10).
// The Quaternius soldier GLB ships real modeled guns as separate meshes; extract one
// template per catalog weapon id, normalized to a hand-relative size, ready to clone
// into a character's Wrist.R socket. Purely visual: templates are noHit.
import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

export const WEAPON_MESH_NAMES: Record<number, string> = {
  0: "AK",             // Rifle
  1: "Sniper",         // Sniper
  2: "RocketLauncher", // Rocket
};

// Target size (largest dimension, in character-local units) per weapon id.
export const HELD_WEAPON_LEN: Record<number, number> = { 0: 0.9, 1: 1.15, 2: 1.1 };

// Extract one template Object3D per weapon id from the soldier GLTF (null per id on failure).
// Matches the NODE name (a multi-primitive GLTF mesh becomes a named Group with unnamed Mesh
// children, so matching only THREE.Mesh objects misses it), clones the whole subtree, strips
// the node transform, and recenters/normalizes so the template hangs cleanly off a hand bone.
export function extractWeaponTemplates(soldier: GLTF | null): (THREE.Object3D | null)[] {
  const out: (THREE.Object3D | null)[] = [null, null, null];
  if (!soldier) return out;
  for (const idStr of Object.keys(WEAPON_MESH_NAMES)) {
    const id = Number(idStr);
    const want = WEAPON_MESH_NAMES[id]!.toLowerCase();
    let found: THREE.Object3D | null = null;
    soldier.scene.traverse((o) => {
      if (!found && o.name.toLowerCase() === want) found = o;
    });
    if (!found) continue;
    const obj = (found as THREE.Object3D).clone(true);
    obj.position.set(0, 0, 0); // drop wherever the armory display parked it in model space
    obj.rotation.set(0, 0, 0);
    obj.scale.set(1, 1, 1);
    const holder = new THREE.Group();
    holder.add(obj);
    // Center on the origin and normalize the largest dimension to the per-weapon length.
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const s = HELD_WEAPON_LEN[id]! / (Math.max(size.x, size.y, size.z) || 1);
    obj.scale.setScalar(s);
    obj.position.set(-center.x * s, -center.y * s, -center.z * s);
    holder.traverse((o) => { o.userData["noHit"] = true; (o as THREE.Mesh).castShadow = true; });
    out[id] = holder;
  }
  return out;
}
