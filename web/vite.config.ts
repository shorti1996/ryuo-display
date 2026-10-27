import { defineConfig } from "vite";

// The page builds into web/dist/, which ryuod serves. File names carry no content hash, so a
// rebuild of unchanged sources leaves dist/ byte-identical and `git diff` shows only real changes.
export default defineConfig({
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
    // ryuod answers only Host 127.0.0.1:8746 or localhost:8746 (ryuod.host_ok); changeOrigin
    // rewrites the Host header to the target's, so the dev server's port 5173 is not refused.
    proxy: { "/api": { target: "http://127.0.0.1:8746", changeOrigin: true } },
  },
});
