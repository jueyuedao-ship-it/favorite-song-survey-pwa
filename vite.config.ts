import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  base: process.env.VITE_BASE_PATH || "./",
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
});
