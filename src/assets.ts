// src/assets.ts — preload CC0 GLBs + textures. Never rejects: a failed individual
// load resolves to null so callers can fall back.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

type GltfKey =
  | "character" | "gun" | "crate" | "barrel" | "container" | "rock" | "tree"
  | "grass" | "bush" | "fern" | "fence" | "log";

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
  textures: { grass: THREE.Texture | null; stone: THREE.Texture | null };
}

const FILES: Record<GltfKey, string> = {
  character: "/models/character.glb",
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

export async function loadAssets(onProgress?: (label: string) => void): Promise<AssetRegistry> {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const reg: AssetRegistry = {
    character: null, gun: null, crate: null, barrel: null, container: null, rock: null, tree: null,
    grass: null, bush: null, fern: null, fence: null, log: null,
    textures: { grass: null, stone: null },
  };

  for (const key of Object.keys(FILES) as GltfKey[]) {
    onProgress?.(`Loading ${key}…`);
    reg[key] = await loadGltf(loader, FILES[key]);
  }
  for (const key of Object.keys(TEXTURES) as Array<"grass" | "stone">) {
    onProgress?.(`Loading ${key} texture…`);
    reg.textures[key] = await loadTexture(texLoader, TEXTURES[key]);
  }

  onProgress?.("Ready");
  return reg;
}
