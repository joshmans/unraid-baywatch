import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Separate config, not a second rollupOptions.input on vite.config.ts -
// Rollup's iife/umd output formats only support a single entry point, and
// this stays iife (a plain <script src> tag, no type="module" anywhere) to
// match the existing BayWatch.page convention. emptyOutDir: false
// matters doubly here since this build always runs second (after
// vite.config.ts's own build) and must not delete the frontend.js it just
// produced.
export default defineConfig({
  plugins: [svelte({ preprocess: vitePreprocess() })],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/frontend/dashboard-main.ts",
      output: {
        entryFileNames: "dashboard.js",
        assetFileNames: "dashboard[extname]",
        format: "iife",
      },
    },
  },
});
