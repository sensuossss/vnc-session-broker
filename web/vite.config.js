import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7070",
    },
  },
  build: {
    outDir: "dist",
    // @novnc/novnc 1.7 ships top-level await; needs es2022+ to transpile.
    target: "es2022",
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
  },
});
