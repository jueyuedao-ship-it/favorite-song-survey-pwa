import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const APP_BASE = "/favorite-song-survey-pwa/";
const API_BASE = "https://api.example.test/api/v1";
const OUTPUT = resolve(process.cwd(), "dist/pwa-build-regression");

type AppIcon = { src: string; sizes: string; type: string; purpose?: string };

describe("production PWA build at a GitHub Pages project path", () => {
  it("keeps manifest/icons stable and installs a scope/API-isolated cache of emitted app assets", async () => {
    const previousApi = process.env.VITE_API_BASE_URL;
    process.env.VITE_API_BASE_URL = API_BASE;
    try {
      await build({
        configFile: resolve(process.cwd(), "vite.config.ts"),
        base: APP_BASE,
        build: { outDir: OUTPUT, emptyOutDir: true },
      });
    } finally {
      if (previousApi === undefined) delete process.env.VITE_API_BASE_URL;
      else process.env.VITE_API_BASE_URL = previousApi;
    }

    const site = "https://survey.example.test";
    const pageUrl = new URL(APP_BASE, site);
    const indexHtml = readFileSync(join(OUTPUT, "index.html"), "utf8");
    const manifestHref = /<link[^>]+rel="manifest"[^>]+href="([^"]+)"/iu.exec(indexHtml)?.[1];
    expect(manifestHref).toBeDefined();
    const manifestUrl = new URL(manifestHref!, pageUrl);
    expect(manifestUrl.pathname).toBe(`${APP_BASE}manifest.webmanifest`);
    expect(existsSync(join(OUTPUT, "manifest.webmanifest"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(OUTPUT, "manifest.webmanifest"), "utf8")) as { id: string; start_url: string; scope: string; icons: AppIcon[] };
    expect(new URL(manifest.id, manifestUrl).pathname).toBe(APP_BASE);
    expect(new URL(manifest.start_url, manifestUrl).pathname).toBe(APP_BASE);
    expect(new URL(manifest.scope, manifestUrl).pathname).toBe(APP_BASE);
    for (const [file, dimension] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
      const path = join(OUTPUT, "icons", file);
      expect(existsSync(path), path).toBe(true);
      const png = readFileSync(path);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(Buffer.from(png).readUInt32BE(16)).toBe(dimension);
      expect(Buffer.from(png).readUInt32BE(20)).toBe(dimension);
    }
    const iconPaths = manifest.icons.map((icon) => new URL(icon.src, manifestUrl).pathname);
    expect(iconPaths).toContain(`${APP_BASE}icons/icon-192.png`);
    expect(iconPaths).toContain(`${APP_BASE}icons/icon-512.png`);
    for (const icon of manifest.icons) expect(icon.type).toBe("image/png");

    const workerPath = join(OUTPUT, "sw.js");
    expect(existsSync(workerPath)).toBe(true);
    const workerSource = readFileSync(workerPath, "utf8");
    expect(workerSource).toContain("favorite-song-survey-shell-");
    expect(workerSource).toMatch(/BUILD_FINGERPRINT\s*=\s*"[a-f0-9]{16}"/u);

    const events = new Map<string, (event: { waitUntil(promise: Promise<unknown>): void }) => void>();
    let installedUrls: string[] = [];
    let openedCacheName = "";
    let installPromise: Promise<unknown> | undefined;
    const fakeSelf = {
      registration: { scope: pageUrl.href },
      clients: { claim: async () => undefined },
      addEventListener: (type: string, handler: (event: { waitUntil(promise: Promise<unknown>): void }) => void) => events.set(type, handler),
    };
    const fakeCaches = { open: async (name: string) => { openedCacheName = name; return { addAll: async (urls: string[]) => { installedUrls = urls; } }; } };
    runInNewContext(workerSource, { self: fakeSelf, caches: fakeCaches, URL, encodeURIComponent, Promise });
    events.get("install")?.({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise;
    expect(openedCacheName).toContain(encodeURIComponent(`${site}${APP_BASE}|${API_BASE}`));
    expect(openedCacheName.endsWith((/BUILD_FINGERPRINT\s*=\s*"([a-f0-9]{16})"/u.exec(workerSource)?.[1] ?? ""))).toBe(true);
    const installedPaths = installedUrls.map((url) => new URL(url).pathname);
    expect(installedPaths.some((path) => path.startsWith(`${APP_BASE}assets/`))).toBe(true);
    const appAssets = installedPaths.filter((path) => /\.(?:js|css)$/u.test(path));
    expect(appAssets.some((path) => /\.js$/u.test(path))).toBe(true);
    expect(appAssets.some((path) => /\.css$/u.test(path))).toBe(true);
    for (const path of appAssets) expect(workerSource).toContain(`"${path.slice(APP_BASE.length)}"`);
    for (const url of installedUrls) {
      const path = new URL(url).pathname;
      expect(path.startsWith(APP_BASE)).toBe(true);
      const relative = path === APP_BASE ? "index.html" : path.slice(APP_BASE.length);
      const localPath = resolve(OUTPUT, ...relative.split("/"));
      expect(localPath.startsWith(`${OUTPUT}${sep}`) || localPath === OUTPUT).toBe(true);
      expect(existsSync(localPath), relative).toBe(true);
    }
    expect(installedUrls.some((url) => new URL(url).pathname.includes("/api/"))).toBe(false);
    let apiWasIntercepted = false;
    const fetchHandler = events.get("fetch") as unknown as (event: { request: { method: string; mode: string; url: string }; respondWith: () => void }) => void;
    fetchHandler({
      request: { method: "GET", mode: "cors", url: `${API_BASE}/health` },
      respondWith: () => { apiWasIntercepted = true; },
    });
    expect(apiWasIntercepted).toBe(false);
  });
});
