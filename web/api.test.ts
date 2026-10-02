import { describe, expect, it, vi } from "vitest";
import { createApi, publicCacheName } from "./api";

class MemoryCache {
  entries = new Map<string, Response>();
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = String(request);
    return this.entries.get(key)?.clone();
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(String(request), response.clone());
  }
}

class MemoryCaches {
  cache = new MemoryCache();
  names: string[] = [];
  async open(name: string): Promise<MemoryCache> {
    this.names.push(name);
    return this.cache;
  }
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("APIと公開スナップショット", () => {
  it("公開統計だけをAPI起点別Cache APIへ保存し、通信断では最後の値を返す", async () => {
    const caches = new MemoryCaches();
    const network = vi.fn().mockResolvedValueOnce(ok({ total_records: 4 })).mockRejectedValueOnce(new TypeError("offline"));
    const api = createApi("https://survey.example/api/v1", { fetch: network as typeof fetch, caches: caches as unknown as CacheStorage });

    expect(await api.get("/statistics?participant_id=p1")).toEqual({ total_records: 4 });
    expect(await api.get("/statistics?participant_id=p1")).toEqual({ total_records: 4 });
    expect(caches.names[0]).toBe(publicCacheName("https://survey.example/api/v1"));
    expect(caches.cache.entries.size).toBe(1);
  });

  it("管理者応答とAuthorization付き応答は公開キャッシュへ入れない", async () => {
    const caches = new MemoryCaches();
    const network = vi.fn().mockResolvedValue(ok({ items: [] }));
    const api = createApi("https://survey.example/api/v1", { fetch: network as typeof fetch, caches: caches as unknown as CacheStorage });

    await api.get("/admin/audit", { token: "memory-only-admin" });
    await api.get("/records?participant_id=p1", { token: "guest-capability" });
    await api.get("/guest/me", { token: "guest-capability" });
    expect(caches.cache.entries.size).toBe(0);
    expect(caches.names).toEqual([]);
  });

  it("管理者トークンを含む成功・失敗内容を永続キャッシュに保存しない", async () => {
    const caches = new MemoryCaches();
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "再ログインしてください" } }), { status: 401 }));
    const api = createApi("https://survey.example/api/v1", { fetch: network as typeof fetch, caches: caches as unknown as CacheStorage });
    await expect(api.get("/admin/jobs", { token: "private-token" })).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(caches.cache.entries.size).toBe(0);
  });

  it("UI unit test mode rejects an uninjected fetch in Japanese instead of reaching a live listener", async () => {
    const liveNetwork = vi.fn().mockResolvedValue(ok({ configured: true }));
    vi.stubGlobal("fetch", liveNetwork);
    try {
      const api = createApi("http://127.0.0.1:8791/api/v1");
      await expect(api.get("/health")).rejects.toThrow("サーバーに接続できませんでした。接続を確認して、もう一度お試しください。");
      expect(liveNetwork).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("public requests still work when browser snapshot storage is unavailable", async () => {
    const cacheStorage = { open: vi.fn().mockRejectedValue(new Error("storage disabled")) } as unknown as CacheStorage;
    const api = createApi("https://survey.example/api/v1", { fetch: vi.fn().mockResolvedValue(ok({ total_records: 3 })) as typeof fetch, caches: cacheStorage });
    await expect(api.get("/statistics")).resolves.toEqual({ total_records: 3 });
  });
});
