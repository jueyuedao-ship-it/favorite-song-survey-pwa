import type { Tag } from "../../shared/contracts";
import { allRows } from "./store";
export async function activeTags(db: D1Database): Promise<Tag[]> {
  return (await allRows(db, "tags")).filter((t) => t.active);
}
