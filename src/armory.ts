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
// SkinnedMeshes are rebuilt as plain Meshes (geometry stays in bind pose — fine for a held prop).
export function extractWeaponTemplates(soldier: GLTF | null): (THREE.Object3D | null)[] {
  const out: (THREE.Object3D | null)[] = [null, null, null];
  if (!soldier) return out;
  for (const idStr of Object.keys(WEAPON_MESH_NAMES)) {
    const id = Number(idStr);
    const want = WEAPON_MESH_NAMES[id]!.toLowerCase();
    let found: THREE.Mesh | null = null;
    soldier.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!found && mesh.isMesh && mesh.name.toLowerCase() === want) found = mesh;
    });
    if (!found) continue;
    const src = found as THREE.Mesh;
    const mesh = new THREE.Mesh(src.geometry, src.material); // un-skinned copy, bind pose
    const holder = new THREE.Group();
    holder.add(mesh);
    // Center on the origin and normalize the largest dimension to the per-weapon length.
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const s = HELD_WEAPON_LEN[id]! / (Math.max(size.x, size.y, size.z) || 1);
    mesh.scale.setScalar(s);
    mesh.position.set(-center.x * s, -center.y * s, -center.z * s);
    holder.traverse((o) => { o.userData["noHit"] = true; (o as THREE.Mesh).castShadow = true; });
    out[id] = holder;
  }
  return out;
}
