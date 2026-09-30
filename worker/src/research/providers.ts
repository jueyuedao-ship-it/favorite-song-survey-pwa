import type { CreditRole, VersionKind } from "../../../shared/contracts";
import { catalogUrl } from "../catalog";
export interface Evidence {
  id: string;
  url: string;
  title: string;
  content: string;
}
export interface Claim {
  name: string;
  kind: "person" | "group" | "synthetic_voice" | "channel";
  role: CreditRole;
  source_id: string;
  quote: string;
  aliases: { name: string; quote: string }[];
}
export interface Recording {
  original?: {
    title: string;
    reference_url: string;
    source_id: string;
    quote: string;
  } | null;
  title: string;
  reference_url: string;
  kind: VersionKind;
  source_id: string;
  quote: string;
  credits: Claim[];
  tags: {
    tag_id: string;
    source_id: string;
    quote: string;
    reasoning?: string;
  }[];
}
export interface Analysis {
  recordings: Recording[];
}
export class ResearchError extends Error {
  constructor(
    public code: string,
    public retry = false,
    public delay = 60000,
  ) {
    super(code);
  }
}
export const norm = (s: string) =>
  s.normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, " ").trim();
const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const arr = (items: unknown) => ({ type: "array", items });
export const analysisSchema = obj({
  recordings: arr(
    obj({
      title: str,
      reference_url: str,
      original: {
        anyOf: [
          obj({ title: str, reference_url: str, source_id: str, quote: str }),
          { type: "null" },
        ],
      },
      kind: { enum: ["original", "cover", "remix", "other"], type: "string" },
      source_id: str,
      quote: str,
      credits: arr(
        obj({
          name: str,
          kind: {
            type: "string",
            enum: ["person", "group", "synthetic_voice", "channel"],
          },
          role: {
            type: "string",
            enum: ["vocalist", "composer", "release_name", "uploader"],
          },
          source_id: str,
          quote: str,
          aliases: arr(obj({ name: str, quote: str })),
        }),
      ),
      tags: arr(
        obj({ tag_id: str, source_id: str, quote: str, reasoning: str }),
      ),
    }),
  ),
});
export function validateAnalysis(
  raw: string,
  evidence: Evidence[],
  query: {
    title: string;
    reference_url: string | null;
    artist_hint?: string | null;
  },
  tags: { id: string; name: string; category?: string }[],
): Analysis {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResearchError("INVALID_MODEL_JSON");
  }
  const fail = () => {
    throw new ResearchError("UNSUPPORTED_EVIDENCE");
  };
  const quote = (id: any, q: any, recording: string) => {
    const s = evidence.find((x) => x.id === id);
    if (
      !s ||
      typeof q !== "string" ||
      q.length < 3 ||
      q.length > 400 ||
      !norm(s.content).includes(norm(q)) ||
      (s.url !== recording && !s.content.includes(recording))
    )
      fail();
    return s!;
  };
  if (
    !value ||
    !Array.isArray(value.recordings) ||
    value.recordings.length < 1 ||
    value.recordings.length > 2
  )
    fail();
  const seen = new Set<string>();
  for (const r of value.recordings) {
    if (
      typeof r.title !== "string" ||
      r.title.length > 256 ||
      !["original", "cover", "remix", "other"].includes(r.kind) ||
      !Array.isArray(r.credits) ||
      r.credits.length > 4 ||
      !Array.isArray(r.tags) ||
      r.tags.length > 5
    )
      fail();
    let url: string | null = null;
    try {
      url = catalogUrl(r.reference_url);
    } catch {
      fail();
    }
    if (!url! || seen.has(url!)) fail();
    seen.add(url!);
    r.reference_url = url!;
    const s = quote(r.source_id, r.quote, url!);
    if (query.artist_hint && !norm(s.content).includes(norm(query.artist_hint)))
      fail();
    if (
      !norm(s.content).includes(norm(r.title)) ||
      !norm(s.content).includes(norm(query.title)) ||
      !norm(r.title).includes(norm(query.title)) ||
      (query.reference_url && catalogUrl(query.reference_url) !== url!)
    )
      fail();
    if (r.original) {
      const o = r.original;
      if (typeof o.title !== "string" || o.title.length > 256) fail();
      try {
        o.reference_url = catalogUrl(o.reference_url);
      } catch {
        fail();
      }
      if (!o.reference_url || o.reference_url === url) fail();
      const relationship = quote(o.source_id, o.quote, url!);
      if (
        !relationship.content.includes(o.reference_url) ||
        !norm(o.quote).includes(norm(o.title)) ||
        !/cover|remix|original|カバー|原曲|リミックス/i.test(o.quote)
      )
        fail();
    }
    for (const c of r.credits) {
      if (
        typeof c.name !== "string" ||
        c.name.length > 100 ||
        !["person", "group", "synthetic_voice", "channel"].includes(c.kind) ||
        !Array.isArray(c.aliases) ||
        c.aliases.length > 2
      )
        fail();
      quote(c.source_id, c.quote, url!);
      const roles: Record<string, RegExp> = {
        vocalist: /vocal|feat[.．]?|featuring|歌唱|歌声|歌手|歌:/i,
        composer: /music|compos|作曲/i,
        release_name: /produced by|名義|artist|アーティスト/i,
        uploader: /upload|channel|投稿|チャンネル/i,
      };
      if (
        !roles[c.role]?.test(c.quote) ||
        !norm(c.quote).includes(norm(c.name))
      )
        fail();
      for (const a of c.aliases) {
        if (
          typeof a.name !== "string" ||
          a.name.length > 100 ||
          typeof a.quote !== "string"
        )
          fail();
        quote(c.source_id, a.quote, url!);
        if (
          !norm(a.quote).includes(norm(c.name)) ||
          !norm(a.quote).includes(norm(a.name))
        )
          fail();
      }
    }
    for (const t of r.tags) {
      const tag = tags.find((x) => x.id === t.tag_id);
      if (!tag) fail();
      quote(t.source_id, t.quote, url!);
      if (
        !tag!.category?.startsWith("歌声") &&
        r.credits.some((c: Claim) => norm(c.quote) === norm(t.quote))
      )
        fail();
      if (
        norm(t.quote) === norm(r.quote) ||
        norm(t.quote) === norm(r.title) ||
        norm(t.quote) === norm(s.title)
      )
        fail();
      if (
        typeof t.reasoning !== "string" ||
        t.reasoning.length < 15 ||
        t.reasoning.length > 500 ||
        !norm(t.reasoning).includes(norm(t.quote)) ||
        !norm(t.reasoning).includes(norm(tag!.name))
      )
        fail();
    }
  }
  return value;
}
export async function providerJson(
  fetcher: typeof fetch,
  url: string,
  key: string,
  body?: unknown,
): Promise<any> {
  const serialized = body ? JSON.stringify(body) : undefined;
  if (url.startsWith("https://api.groq.com/") && serialized) {
    // Conservative character estimate plus reserved output; the cron spacing is 5 minutes.
    let estimate = 256;
    for (const ch of serialized) estimate += ch.charCodeAt(0) > 127 ? 2 : 1 / 3;
    estimate += Number((body as any).max_completion_tokens ?? 0);
    if (estimate > 7600) throw new ResearchError("GROQ_REQUEST_TOO_LARGE");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "FavoriteSongSurvey/1.0",
      },
      ...(body ? { body: serialized } : {}),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
  } catch {
    throw new ResearchError("PROVIDER_UNAVAILABLE", true);
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after") ?? "60";
    const parsed = /^\d+(?:\.\d+)?$/.test(retry)
      ? Number(retry) * 1000
      : Date.parse(retry) - Date.now();
    const delay = Math.min(
      3600000,
      Math.max(60000, Number.isFinite(parsed) ? parsed : 60000),
    );
    response.body?.cancel();
    throw new ResearchError(
      `PROVIDER_HTTP_${response.status}`,
      [429, 500, 502, 503, 504].includes(response.status),
      delay,
    );
  }
  // Bound bytes before JSON parsing, including chunked responses.
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 48000) {
      await reader.cancel();
      throw new ResearchError("PROVIDER_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    bytes.set(c, pos);
    pos += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ResearchError("INVALID_PROVIDER_JSON");
  }
}
