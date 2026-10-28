import { defineConfig } from "vite";
import { mockApi } from "./demo/mock-api.ts";

// The page builds into web/dist/, which ryuod serves. File names carry no content hash, so a
// rebuild of unchanged sources leaves dist/ byte-identical and `git diff` shows only real changes.
// `vite --mode demo` (npm run demo) answers /api/* from demo/mock-api.ts instead of ryuod.
export default defineConfig(({ mode }) => ({
  plugins: mode === "demo" ? [mockApi()] : [],
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "",
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  server: {
    // The README names http://127.0.0.1:5173/; Vite's default host is ::1, which that URL misses.
    host: "127.0.0.1",
    // ryuod answers only Host 127.0.0.1:8746 or localhost:8746 (ryuod.host_ok); changeOrigin
    // rewrites the Host header to the target's, so the dev server's port 5173 is not refused.
    // Anchored with a trailing slash: a bare "/api" prefix would also send the source module
    // /api.ts to ryuod and leave the page unstyled with no console error.
    proxy: mode === "demo" ? undefined : { "^/api/": { target: "http://127.0.0.1:8746", changeOrigin: true } },
  },
}));
