import { useEffect } from "react";

/** One request at a time, only while visible/online after the initial cache read.
 * The signal also guards state commits when an injected transport ignores abort.
 */
export function useVisibleRefresh(refresh: (signal: AbortSignal) => Promise<void>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let running = false;
    let lastStart = -Infinity;
    async function run(initial = false) {
      if (controller.signal.aborted || running) return;
      if (!initial && (document.visibilityState !== "visible" || !navigator.onLine || Date.now() - lastStart < 1000)) return;
      running = true;
      lastStart = Date.now();
      try { await refresh(controller.signal); }
      finally { running = false; }
    }
    const trigger = () => { void run(); };
    void run(true);
    const interval = window.setInterval(trigger, 60000);
    window.addEventListener("focus", trigger);
    window.addEventListener("online", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", trigger);
      window.removeEventListener("online", trigger);
      document.removeEventListener("visibilitychange", trigger);
    };
  }, [refresh, enabled]);
}
