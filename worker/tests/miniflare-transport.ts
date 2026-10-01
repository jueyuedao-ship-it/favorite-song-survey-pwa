import { Pool, type Dispatcher } from "undici";
import type { Miniflare } from "miniflare";

const runtimes = new Set<string>();
const pools = new Map<string, Pool>();
const inheritedDispatch = Pool.prototype.dispatch;
const ownDispatch = Object.getOwnPropertyDescriptor(Pool.prototype, "dispatch");

/** Windows test-only workaround for Miniflare's unconditional options.reset=true.
 * Applies only to registered real runtime origins, retaining eight concurrent
 * connections and the actual workerd/D1 transport, headers, bodies and results.
 */
export async function registerRuntimeTransport(runtime: Miniflare) {
  if (process.platform !== "win32" || process.env.NODE_ENV !== "test")
    return async () => {};
  const url = await runtime.ready;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("D1 fixture must use a loopback runtime");
  const origin = url.origin;
  if (!runtimes.size) {
    Pool.prototype.dispatch = function (
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ) {
      const target = String(options.origin);
      if (!runtimes.has(target) || options.reset !== true)
        return inheritedDispatch.call(this, options, handler);
      let pool = pools.get(target);
      if (!pool) {
        pool = new Pool(target, {
          connections: 8,
          pipelining: 1,
          connect: { rejectUnauthorized: false },
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        pools.set(target, pool);
      }
      return inheritedDispatch.call(
        pool,
        { ...options, reset: false },
        handler,
      );
    };
  }
  runtimes.add(origin);
  return async () => {
    runtimes.delete(origin);
    const pool = pools.get(origin);
    pools.delete(origin);
    if (pool) await pool.close();
    if (!runtimes.size) {
      if (ownDispatch)
        Object.defineProperty(Pool.prototype, "dispatch", ownDispatch);
      else Reflect.deleteProperty(Pool.prototype, "dispatch");
    }
  };
}
