import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Supply a test-only assets directory so the pool worker validates correctly.
      // wrangler.jsonc intentionally omits assets.directory (the vite-plugin sets it
      // from the client build output at build/deploy time).
      miniflare: { assets: { directory: "./public" } },
    }),
  ],
});
