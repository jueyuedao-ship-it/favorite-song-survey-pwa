const SHELL_PREFIX = "favorite-song-survey-shell-";
const SHELL_CACHE = `${SHELL_PREFIX}v1`;
const STATIC_EXTENSIONS = /\.(?:js|css|svg|webmanifest|png|ico|woff2?)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll([self.registration.scope, new URL("index.html", self.registration.scope).href, new URL("manifest.webmanifest", self.registration.scope).href, new URL("icons/icon.svg", self.registration.scope).href]);
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
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const relativePath = url.pathname.slice(scope.pathname.length);
  if (relativePath === "api" || relativePath.startsWith("api/") || relativePath.includes("/api/")) return;
  const navigation = request.mode === "navigate";
  if (!navigation && !STATIC_EXTENSIONS.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    if (navigation) {
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(new URL("index.html", self.registration.scope).href, response.clone());
        return response;
      } catch {
        return (await cache.match(new URL("index.html", self.registration.scope).href)) ?? Response.error();
      }
    }
    const cached = await cache.match(request);
    const update = fetch(request).then((response) => {
      if (response.ok && new URL(request.url).origin === scope.origin) void cache.put(request, response.clone());
      return response;
    }).catch(() => cached);
    return cached ?? await update ?? Response.error();
  })());
});
