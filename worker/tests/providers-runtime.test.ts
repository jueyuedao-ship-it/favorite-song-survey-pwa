import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { providerJson } from "../src/research/providers";
import { registerRuntimeTransport } from "./miniflare-transport";

let runtime: Miniflare;
let closeTransport: () => Promise<void>;
let provider: Server;
let destination: Server;
let origin: string;
let providerRequests: { authorization?: string; method?: string }[];
let destinationAuthorizations: (string | undefined)[];

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeAll(async () => {
  destination = createServer((request, response) => {
    destinationAuthorizations.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"followed":true}');
  });
  const destinationOrigin = await listen(destination);
  provider = createServer((request, response) => {
    providerRequests.push({
      authorization: request.headers.authorization,
      method: request.method,
    });
    const path = new URL(request.url!, "http://fixture").pathname;
    if (path.startsWith("/redirect/")) {
      response.writeHead(Number(path.split("/").at(-1)), {
        Location: `${destinationOrigin}/must-not-receive-credentials`,
        "Content-Type": "application/json",
      });
      response.end('{"redirectBodyMustNotBeAccepted":true}');
    } else if (path === "/large") {
      // No Content-Length: exercise the byte guard on a real chunked body.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('"' + "x".repeat(48000) + '"');
    } else if (path === "/failure") {
      response.writeHead(503, { "Retry-After": "120" });
      response.end("unavailable");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"account":{"plan_usage":0},"key":{"usage":0}}');
    }
  });
  origin = await listen(provider);
  const bundled = await build({
    stdin: {
      contents: `import { providerJson } from "./worker/src/research/providers.ts";
        export default { async fetch(request) {
          let redirect;
          const nativeTransport = (url, init) => {
            redirect = init.redirect;
            return fetch(url, init);
          };
          try {
            const value = await providerJson(nativeTransport,
              ${JSON.stringify(origin)} + new URL(request.url).pathname,
              "fixture-authorization", request.method === "POST" ? {} : undefined);
            return Response.json({ value, redirect });
          } catch (error) {
            return Response.json({ code: error.code, retry: error.retry,
              delay: error.delay, redirect });
          }
        }};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    write: false,
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-30",
    }),
  );
  closeTransport = await registerRuntimeTransport(runtime);
});

beforeEach(() => {
  providerRequests = [];
  destinationAuthorizations = [];
});

afterAll(async () => {
  await runtime?.dispose();
  await closeTransport?.();
  await Promise.all([
    provider && close(provider),
    destination && close(destination),
  ]);
});

it.each(["GET", "POST"])(
  "accepts actual 200 JSON through Workers native fetch for %s",
  async (method) => {
    const response = await runtime.dispatchFetch("http://fixture/usage", {
      method,
    });
    expect(await response.json()).toEqual({
      value: { account: { plan_usage: 0 }, key: { usage: 0 } },
      redirect: "manual",
    });
    expect(providerRequests).toEqual([
      { method, authorization: "Bearer fixture-authorization" },
    ]);
  },
);

it.each([300, 301, 302, 303, 304, 305, 306, 307, 308, 399])(
  "rejects actual HTTP %i without calling its destination or forwarding Authorization",
  async (status) => {
    const response = await runtime.dispatchFetch(
      `http://fixture/redirect/${status}`,
      {
        method: "POST",
      },
    );
    expect(await response.json()).toEqual({
      code: `PROVIDER_HTTP_${status}`,
      retry: false,
      delay: 60000,
      redirect: "manual",
    });
    expect(providerRequests).toEqual([
      { method: "POST", authorization: "Bearer fixture-authorization" },
    ]);
    expect(destinationAuthorizations).toEqual([]);
  },
);

it("rejects every 3xx before JSON parsing, even with valid JSON and Retry-After", async () => {
  for (let status = 300; status < 400; status++) {
    await expect(
      providerJson(
        (async () =>
          new Response(status === 304 ? null : "{}", {
            status,
            headers: { "Retry-After": "3600" },
          })) as typeof fetch,
        "https://api.tavily.com/usage",
        "fixture",
      ),
    ).rejects.toMatchObject({
      code: `PROVIDER_HTTP_${status}`,
      retry: false,
      delay: 60000,
    });
  }
});

it("retains retry status and Retry-After for actual provider failure", async () => {
  const response = await runtime.dispatchFetch("http://fixture/failure");
  expect(await response.json()).toMatchObject({
    code: "PROVIDER_HTTP_503",
    retry: true,
    delay: 120000,
  });
});

it("retains the response byte cap for actual chunked JSON", async () => {
  const response = await runtime.dispatchFetch("http://fixture/large");
  expect(await response.json()).toMatchObject({
    code: "PROVIDER_RESPONSE_TOO_LARGE",
    retry: false,
  });
});
