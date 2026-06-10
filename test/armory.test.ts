// test/armory.test.ts — held-weapon template extraction (spec 2026-06-10).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { extractWeaponTemplates, WEAPON_MESH_NAMES, HELD_WEAPON_LEN } from "../src/armory";

// Synthetic stand-in for the soldier GLTF scene: named meshes like the real GLB.
function fakeSoldier(): { scene: THREE.Group } {
  const scene = new THREE.Group();
  for (const name of ["AK", "Sniper", "RocketLauncher", "Pistol", "Body"]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 0.4, 0.4), new THREE.MeshStandardMaterial());
    m.name = name;
    scene.add(m);
  }
  return { scene };
}

describe("extractWeaponTemplates", () => {
  it("maps weapon ids to the right soldier meshes", () => {
    expect(WEAPON_MESH_NAMES).toEqual({ 0: "AK", 1: "Sniper", 2: "RocketLauncher" });
  });

  it("extracts a normalized, no-hit template per weapon id", () => {
    const t = extractWeaponTemplates(fakeSoldier() as never);
    for (const id of [0, 1, 2]) {
      const obj = t[id]!;
      expect(obj).toBeTruthy();
      let noHit = true;
      obj.traverse((o) => { if (!o.userData["noHit"]) noHit = false; });
      expect(noHit).toBe(true);
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(obj).getSize(size);
      expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(HELD_WEAPON_LEN[id]!, 3);
    }
  });

  it("returns nulls when the soldier model is missing", () => {
    expect(extractWeaponTemplates(null)).toEqual([null, null, null]);
  });
});
