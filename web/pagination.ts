import type { Page } from "../shared/contracts";

export async function loadAllPages<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    const next = result.next_cursor;
    if (!next || seen.has(next)) return items;
    seen.add(next);
    cursor = next;
  }
}
