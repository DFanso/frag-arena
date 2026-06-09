import { defineConfig } from "vite";

// Client-only build for the self-hosted (Dokploy / Node) target. Deliberately omits the
// `@cloudflare/vite-plugin` used by vite.config.ts — this builds ONLY the Three.js SPA, which
// the Node server (server/index.ts) serves as static assets. The Cloudflare build is unchanged.
//
// Vite auto-detects the root `index.html` (→ /src/main.ts) as the entry and copies `public/`
// (models + textures) into the out dir. The client imports only `../worker/protocol` (plain TS)
// and `three`, so no Workers runtime is involved.
export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
