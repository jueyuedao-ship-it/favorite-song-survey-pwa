import type { Tag } from "../../shared/contracts";
import { allRows } from "./store";

export async function activeTags(db: D1Database): Promise<Tag[]> {
  return (await allRows(db, "tags")).filter((t) => t.active);
}

function canonicalTag(tag: Tag) {
  return {
    id: tag.id,
    revision: tag.revision,
    name: tag.name,
    category: tag.category,
    criterion: tag.criterion,
    evidence_policy: tag.evidence_policy ?? null,
  };
}

/** Stable non-cryptographic fingerprint used only to invalidate stale research. */
export function tagDictionaryFingerprint(tags: Tag[]): string {
  const input = JSON.stringify(
    tags
      .filter((tag) => tag.active)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(canonicalTag),
  );
  const bytes = new TextEncoder().encode(input);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `tagdict-v2-${hash.toString(16).padStart(16, "0")}`;
}
