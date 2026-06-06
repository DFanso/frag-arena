// src/models.ts — procedural weapon meshes for items that have no CC0 GLB (the rocket
// launcher). Shared by the tower pickup (pickups.ts) and the first-person viewmodel so the
// dropped and held launcher look identical. Local +Z is the muzzle/forward direction.
import * as THREE from "three";

// Low-poly rocket launcher: a tube with a protruding warhead, rear flare, grip, and sight.
export function buildRocketLauncher(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x394150, roughness: 0.7, metalness: 0.2 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.8 });
  const warhead = new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff2a00, emissiveIntensity: 0.6, roughness: 0.5 });

  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 16), dark);
  tube.rotation.x = Math.PI / 2; // cylinder axis (Y) -> local +Z
  g.add(tube);

  const rear = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.25, 16), accent);
  rear.rotation.x = Math.PI / 2;
  rear.position.z = -0.8;
  g.add(rear);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 20), accent);
  ring.position.z = 0.35;
  g.add(ring);

  // Protruding warhead at the muzzle (the loaded rocket).
  const noseBody = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 14), warhead);
  noseBody.rotation.x = Math.PI / 2;
  noseBody.position.z = 0.62;
  g.add(noseBody);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 14), warhead);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.92;
  g.add(nose);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 0.18), accent);
  grip.position.set(0, -0.22, 0.05);
  g.add(grip);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.1), accent);
  sight.position.set(0, 0.21, 0.12);
  g.add(sight);

  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
  return g;
}
