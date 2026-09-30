import type { ApiResult } from "../shared/contracts";

export const PUBLIC_CACHE_PREFIX = "favorite-song-survey:public:v1:";

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiOptions = {
  fetch?: typeof fetch;
  caches?: CacheStorage;
};

type RuntimeEnv = { MODE?: string };

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
};

function cacheablePath(path: string, method: string, hasToken: boolean): boolean {
  if (method !== "GET" || hasToken) return false;
  const pathOnly = path.split("?", 1)[0] ?? "";
  return pathOnly === "/participants"
    || pathOnly === "/catalog/search"
    || pathOnly.startsWith("/catalog/versions/")
    || pathOnly === "/records"
    || pathOnly === "/tags"
    || pathOnly === "/statistics";
}

export function publicCacheName(apiBase: string): string {
  const url = new URL(apiBase, globalThis.location?.href ?? "https://localhost/");
  return `${PUBLIC_CACHE_PREFIX}${encodeURIComponent(`${url.origin}${url.pathname}`)}`;
}

export function createApi(apiBase: string, options: ApiOptions = {}) {
  const base = apiBase.replace(/\/$/u, "");
  const unitTestMode = (import.meta as ImportMeta & { env?: RuntimeEnv }).env?.MODE === "test";
  const fetcher = options.fetch ?? (unitTestMode
    ? (async () => { throw new Error("UI unit tests must inject fetch"); }) as typeof fetch
    : globalThis.fetch.bind(globalThis));
  const cacheStorage = options.caches ?? globalThis.caches;

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    if (!base) throw new ApiError("API接続先が設定されていません。", "NOT_CONFIGURED", 503);
    const method = requestOptions.method ?? "GET";
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers({ accept: "application/json" });
    if (requestOptions.body !== undefined) headers.set("content-type", "application/json");
    if (requestOptions.token) headers.set("authorization", `Bearer ${requestOptions.token}`);
    const canCache = cacheablePath(path, method, Boolean(requestOptions.token)) && Boolean(cacheStorage);
    let cache: Cache | undefined;
    if (canCache && cacheStorage) {
      try { cache = await cacheStorage.open(publicCacheName(apiBase)); }
      catch { cache = undefined; }
    }

    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        signal: requestOptions.signal,
      });
    } catch (error) {
      if (cache) {
        const cached = await cache.match(url);
        if (cached) response = cached;
        else throw error;
      } else {
        throw error;
      }
    }

    let payload: ApiResult<T>;
    try {
      payload = await response.clone().json() as ApiResult<T>;
    } catch {
      throw new ApiError("サーバー応答を読み取れませんでした。", "INVALID_RESPONSE", response.status);
    }
    if (!response.ok || !("data" in payload)) {
      if ("error" in payload) throw new ApiError(payload.error.message, payload.error.code, response.status);
      throw new ApiError("サーバー応答を確認できませんでした。", "INVALID_RESPONSE", response.status);
    }
    if (cache && response.status >= 200 && response.status < 300) {
      try { await cache.put(url, response.clone()); }
      catch { /* Cache storage is an offline enhancement, not an API prerequisite. */ }
    }
    return payload.data;
  }

  return {
    request,
    get<T>(path: string, requestOptions: Omit<RequestOptions, "method" | "body"> = {}) {
      return request<T>(path, requestOptions);
    },
    post<T>(path: string, body: unknown, token?: string) {
      return request<T>(path, { method: "POST", body, token });
    },
    patch<T>(path: string, body: unknown, token?: string) {
      return request<T>(path, { method: "PATCH", body, token });
    },
    delete<T>(path: string, body: unknown, token?: string) {
      return request<T>(path, { method: "DELETE", body, token });
    },
  };
}
