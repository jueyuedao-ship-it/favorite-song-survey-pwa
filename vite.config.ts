import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: process.env.VITE_BASE_PATH || "./",
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8791", changeOrigin: false },
    },
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
});
