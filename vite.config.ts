import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";
import { pwaBuildPlugin } from "./web/pwa-plugin.ts";
import { apiDevProxy } from "./web/dev-proxy.ts";

export default defineConfig(({ mode }) => {
  const webEnv = loadEnv(mode, resolve(process.cwd(), "web"), "");
  const apiBase = process.env.VITE_API_BASE_URL || webEnv.VITE_API_BASE_URL || (mode === "development" ? "/api/v1" : "");
  return {
    root: "web",
    base: process.env.VITE_BASE_PATH || webEnv.VITE_BASE_PATH || "./",
    plugins: [pwaBuildPlugin(process.cwd(), apiBase)],
    build: { outDir: "../dist/web", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: apiDevProxy(),
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem,key,p12,pfx,cer,der}",
          ".npmrc",
          ".yarnrc.yml",
          "**/.git/**",
          "**/.local/**",
          "**/.superpowers/**",
          "**/data/**",
          "**/.dev.vars*",
        ],
      },
    },
  };
});
