import { describe, expect, it, vi } from "vitest";
import type { Page } from "../shared/contracts";
import { loadAllPages } from "./pagination";

describe("admin reference pagination", () => {
  it("follows every API cursor instead of truncating names at the first page", async () => {
    const requests: (string | undefined)[] = [];
    const fetchPage = vi.fn(async (cursor?: string): Promise<Page<{ id: string; name: string }>> => {
      requests.push(cursor);
      return cursor
        ? { items: [{ id: "late", name: "後半の人物" }], next_cursor: null }
        : { items: [{ id: "early", name: "前半の人物" }], next_cursor: "early" };
    });
    await expect(loadAllPages(fetchPage)).resolves.toEqual([
      { id: "early", name: "前半の人物" },
      { id: "late", name: "後半の人物" },
    ]);
    expect(requests).toEqual([undefined, "early"]);
  });
});
