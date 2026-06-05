// src/assets.ts — preload CC0 GLBs + textures. Never rejects: a failed individual
// load resolves to null so callers can fall back.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

type GltfKey =
  | "character" | "gun" | "crate" | "barrel" | "container" | "rock" | "tree"
  | "grass" | "bush" | "fern" | "fence" | "log"
  | "kitWall" | "kitDoor" | "kitFloor" | "kitStairs" | "kitColumn" | "kitBroken"
  | "bTower" | "bHouse1" | "bHouse2" | "bShed" | "bShed2"
  | "grenade";

export interface AssetRegistry {
  character: GLTF | null;
  gun: GLTF | null;
  crate: GLTF | null;
  barrel: GLTF | null;
  container: GLTF | null;
  rock: GLTF | null;
  tree: GLTF | null;
  grass: GLTF | null;  // grass tuft model
  bush: GLTF | null;
  fern: GLTF | null;
  fence: GLTF | null;  // modular wall/fence segment
  log: GLTF | null;    // standing log (pillar)
  // Stone/castle modular kit pieces (Kenney Castle Kit, CC0).
  kitWall: GLTF | null;
  kitDoor: GLTF | null;
  kitFloor: GLTF | null;
  kitStairs: GLTF | null;
  kitColumn: GLTF | null;
  kitBroken: GLTF | null;
  // Complete CC0 building models (solid hide-behind cover).
  bTower: GLTF | null;
  bHouse1: GLTF | null;
  bHouse2: GLTF | null;
  bShed: GLTF | null;
  bShed2: GLTF | null;
  grenade: GLTF | null;
  textures: { grass: THREE.Texture | null; stone: THREE.Texture | null };
}

const FILES: Record<GltfKey, string> = {
  character: "/models/character_soldier.glb",
  gun: "/models/gun.glb",
  crate: "/models/crate.glb",
  barrel: "/models/barrel.glb",
  container: "/models/container.glb",
  rock: "/models/rock.glb",
  tree: "/models/tree.glb",
  grass: "/models/grass.glb",
  bush: "/models/bush.glb",
  fern: "/models/fern.glb",
  fence: "/models/fence.glb",
  log: "/models/log.glb",
  kitWall: "/models/kit_wall.glb",
  kitDoor: "/models/kit_door.glb",
  kitFloor: "/models/kit_floor.glb",
  kitStairs: "/models/kit_stairs.glb",
  kitColumn: "/models/kit_column.glb",
  kitBroken: "/models/kit_broken.glb",
  bTower: "/models/building_tower.glb",
  bHouse1: "/models/building_house1.glb",
  bHouse2: "/models/building_house2.glb",
  bShed: "/models/building_shed.glb",
  bShed2: "/models/building_shed2.glb",
  grenade: "/models/grenade.glb",
};

const TEXTURES: Record<"grass" | "stone", string> = {
  grass: "/textures/grass.jpg",
  stone: "/textures/stone.jpg",
};

function loadGltf(loader: GLTFLoader, url: string): Promise<GLTF | null> {
  return loader.loadAsync(url).catch((err) => {
    console.warn(`[assets] failed to load ${url}:`, err);
    return null;
  });
}

function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture | null> {
  return loader.loadAsync(url).then(
    (tex) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    },
    (err) => {
      console.warn(`[assets] failed to load ${url}:`, err);
      return null;
    },
  );
}

export async function loadAssets(onProgress?: (loaded: number, total: number, label: string) => void): Promise<AssetRegistry> {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const reg: AssetRegistry = {
    character: null, gun: null, crate: null, barrel: null, container: null, rock: null, tree: null,
    grass: null, bush: null, fern: null, fence: null, log: null,
    kitWall: null, kitDoor: null, kitFloor: null, kitStairs: null, kitColumn: null, kitBroken: null,
    bTower: null, bHouse1: null, bHouse2: null, bShed: null, bShed2: null, grenade: null,
    textures: { grass: null, stone: null },
  };

  const gltfKeys = Object.keys(FILES) as GltfKey[];
  const texKeys = Object.keys(TEXTURES) as Array<"grass" | "stone">;
  const total = gltfKeys.length + texKeys.length;
  let loaded = 0;

  for (const key of gltfKeys) {
    onProgress?.(loaded, total, key);
    reg[key] = await loadGltf(loader, FILES[key]);
    loaded += 1;
  }
  for (const key of texKeys) {
    onProgress?.(loaded, total, `${key} texture`);
    reg.textures[key] = await loadTexture(texLoader, TEXTURES[key]);
    loaded += 1;
  }

  onProgress?.(total, total, "Ready");
  return reg;
}
