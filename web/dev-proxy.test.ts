import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import { apiDevProxy } from "./dev-proxy";

describe("Vite development API proxy", () => {
  it("serves /api.ts as a module and proxies only /api/v1 routes", async () => {
    const apiServer = createHttpServer((request, response) => {
      if (request.url === "/api/v1/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { schema_version: 1 } }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
    });
    apiServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListen) => apiServer.once("listening", resolveListen));
    const apiAddress = apiServer.address() as AddressInfo;
    let vite: Awaited<ReturnType<typeof createServer>> | undefined;

    try {
      vite = await createServer({
        configFile: false,
        root: resolve(process.cwd(), "web"),
        server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: apiDevProxy(`http://127.0.0.1:${apiAddress.port}`) },
      });
      await vite.listen();
      const address = vite.httpServer?.address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}`;
      const moduleResponse = await fetch(`${base}/api.ts`);
      expect(moduleResponse.status).toBe(200);
      expect(moduleResponse.headers.get("content-type")).toMatch(/javascript/u);
      expect(await moduleResponse.text()).toContain("createApi");

      const apiResponse = await fetch(`${base}/api/v1/health`);
      expect(apiResponse.status).toBe(200);
      expect(apiResponse.headers.get("content-type")).toMatch(/application\/json/u);
      expect(await apiResponse.json()).toEqual({ data: { schema_version: 1 } });
    } finally {
      if (vite) await vite.close();
      await new Promise<void>((resolveClose, reject) => apiServer.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
