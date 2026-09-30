import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

type PwaBundleItem =
  | { type: "chunk"; fileName: string; code: string }
  | { type: "asset"; fileName: string; source: string | Uint8Array };
type PwaBundle = Record<string, PwaBundleItem>;

const PUBLIC_SHELL_FILES = [
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

function canonicalApiBase(apiBase: string): string {
  const sentinel = "https://same-origin-survey.invalid";
  const url = new URL(apiBase || "/api/v1", sentinel);
  const path = url.pathname.replace(/\/+$/u, "");
  return url.origin === sentinel ? path : `${url.origin}${path}`;
}

function fingerprint(bundle: PwaBundle, publicDir: string, base: string, apiBase: string): string {
  const hash = createHash("sha256");
  hash.update(base).update("\0").update(apiBase).update("\0");
  const emitted = Object.values(bundle)
    .filter((item) => item.type === "chunk" || (item.type === "asset" && (item.fileName === "index.html" || item.fileName.endsWith(".css"))))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  for (const item of emitted) {
    hash.update(item.fileName).update("\0");
    hash.update(item.type === "chunk" ? item.code : typeof item.source === "string" ? item.source : Buffer.from(item.source));
    hash.update("\0");
  }
  for (const fileName of PUBLIC_SHELL_FILES) {
    hash.update(fileName).update("\0").update(readFileSync(resolve(publicDir, fileName))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function serviceWorkerSource(base: string, apiBase: string, buildFingerprint: string, appFiles: string[]): string {
  const namespace = canonicalApiBase(apiBase);
  const precache = [...new Set(["index.html", ...PUBLIC_SHELL_FILES, ...appFiles])].sort();
  return `const BUILD_FINGERPRINT = ${JSON.stringify(buildFingerprint)};
const API_BASE = ${JSON.stringify(namespace)};
const PRECACHE_FILES = ${JSON.stringify(precache)};
const SHELL_PREFIX = (() => {
  const scope = new URL(self.registration.scope);
  const namespace = encodeURIComponent(scope.origin + scope.pathname + "|" + API_BASE);
  return "favorite-song-survey-shell-" + namespace + "-";
})();
const SHELL_CACHE = SHELL_PREFIX + BUILD_FINGERPRINT;
const STATIC_EXTENSIONS = /\\.(?:js|css|svg|png|ico|webmanifest|woff2?)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const scope = self.registration.scope;
    const urls = [scope, ...PRECACHE_FILES.map((file) => new URL(file, scope).href)];
    await cache.addAll(urls);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const scope = new URL(self.registration.scope);
  const url = new URL(request.url);
  const apiUrl = new URL(API_BASE, scope);
  const apiPath = apiUrl.pathname.replace(/\\/$/u, "");
  if (url.origin === apiUrl.origin && (url.pathname === apiPath || url.pathname.startsWith(apiPath + "/"))) return;
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const navigation = request.mode === "navigate";
  if (!navigation && !STATIC_EXTENSIONS.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    if (navigation) {
      const indexUrl = new URL("index.html", self.registration.scope).href;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(indexUrl, response.clone());
        return response;
      } catch {
        return (await cache.match(indexUrl)) ?? Response.error();
      }
    }
    const cached = await cache.match(request);
    const update = fetch(request).then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    }).catch(() => cached);
    return cached ?? await update ?? Response.error();
  })());
});
`;
}

export function pwaBuildPlugin(projectRoot: string, apiBase: string): Plugin {
  let base = "./";
  const normalizedApiBase = canonicalApiBase(apiBase);
  const publicDir = resolve(projectRoot, "web", "public");

  return {
    name: "favorite-song-survey-pwa",
    apply: "build",
    configResolved(config) { base = config.base; },
    generateBundle(_options, bundle) {
      const appFiles = Object.values(bundle)
        .filter((item) => item.type === "chunk" || (item.type === "asset" && item.fileName.endsWith(".css")))
        .map((item) => item.fileName)
        .sort();
      const buildFingerprint = fingerprint(bundle as PwaBundle, publicDir, base, normalizedApiBase);
      const source = serviceWorkerSource(base, normalizedApiBase, buildFingerprint, appFiles);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
