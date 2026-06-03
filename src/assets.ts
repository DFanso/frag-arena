// src/assets.ts — preload CC0 GLBs from /models via GLTFLoader. Never rejects:
// a failed individual load resolves to null so callers can fall back.
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

export interface AssetRegistry {
  character: GLTF | null;
  gun: GLTF | null;
  crate: GLTF | null;
  barrel: GLTF | null;
}

const FILES: Record<keyof AssetRegistry, string> = {
  character: "/models/character.glb",
  gun: "/models/gun.glb",
  crate: "/models/crate.glb",
  barrel: "/models/barrel.glb",
};

function loadOne(loader: GLTFLoader, url: string): Promise<GLTF | null> {
  return loader.loadAsync(url).catch((err) => {
    console.warn(`[assets] failed to load ${url}:`, err);
    return null;
  });
}

export async function loadAssets(onProgress?: (label: string) => void): Promise<AssetRegistry> {
  const loader = new GLTFLoader();
  const keys = Object.keys(FILES) as (keyof AssetRegistry)[];
  const reg = { character: null, gun: null, crate: null, barrel: null } as AssetRegistry;
  for (const key of keys) {
    onProgress?.(`Loading ${key}…`);
    reg[key] = await loadOne(loader, FILES[key]);
  }
  onProgress?.("Ready");
  return reg;
}
