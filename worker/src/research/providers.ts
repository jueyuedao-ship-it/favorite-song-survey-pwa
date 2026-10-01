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
/** Only a complete name directly attributed by the matching role clause is accepted. */
export function explicitCredit(
  quote: string,
  name: string,
  role: CreditRole,
  aliases: { name: string; quote: string }[] = [],
) {
  if (!norm(name)) return false;
  const groups: { role: CreditRole; pattern: string }[] = [
    {
      role: "composer",
      pattern:
        "lyrics\\s*(?:&|and)\\s*music|music\\s*(?:&|and)\\s*lyrics|composed\\s+by|composer|composition|music|作詞[&/・と]作曲|作曲(?:者)?",
    },
    {
      role: "vocalist",
      pattern: "featuring|feat|vocalist|vocals?|歌唱|ボーカル|歌手|歌声|歌",
    },
    {
      role: "release_name",
      pattern:
        "produced\\s+by|release\\s+artist|artist|発表名義|名義|アーティスト",
    },
    {
      role: "uploader",
      pattern: "uploaded\\s+by|uploader|channel|投稿(?:者)?|チャンネル",
    },
  ];
  const input = quote.normalize("NFKC").toLocaleLowerCase("ja");
  const markers = [
    ...input.matchAll(
      new RegExp(
        "(?<![\\p{L}\\p{N}_])(" +
          groups.map((g) => g.pattern).join("|") +
          ")(?:\\s*[:.\\-–—]\\s*|\\s+)",
        "gu",
      ),
    ),
  ];
  const complete = (value: string) => {
    const attributed = norm(value);
    const credited = norm(name);
    if (attributed === credited) return true;
    // A punctuation-bearing credited name is one complete value. Slash/comma/&
    // never establish separate people. Explicit whole-value alias forms may match.
    return aliases.some((a) => {
      if (typeof a.name !== "string" || typeof a.quote !== "string")
        return false;
      const alternate = norm(a.name),
        proof = norm(a.quote);
      const pair = (v: string) => v.replace(/\s*\/\s*/g, "/");
      const bilingual =
        (/[a-z]/i.test(credited) &&
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
            alternate,
          )) ||
        (/[a-z]/i.test(alternate) &&
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
            credited,
          ));
      if (bilingual) {
        const forms = [credited + "/" + alternate, alternate + "/" + credited];
        if (
          forms.includes(pair(attributed)) &&
          pair(proof) === pair(attributed)
        )
          return true;
      }
      const forms = [
        `${credited} (aka ${alternate})`,
        `${credited} (also known as ${alternate})`,
      ];
      return forms.includes(attributed) && proof === attributed;
    });
  };
  return markers.some((m, i) => {
    const matched = groups.find((g) =>
      new RegExp("^(?:" + g.pattern + ")$", "u").test(m[1]),
    );
    if (matched?.role !== role) return false;
    const value = input
      .slice(m.index! + m[0].length, markers[i + 1]?.index ?? input.length)
      .split(/[;；\n。]/)[0]
      .trim();
    // Only a known following role marker permits a terminal sentence separator.
    // Interior punctuation and spaces remain part of the complete credited value.
    const bounded = markers[i + 1] ? value.replace(/\.\s*$/, "").trim() : value;
    return complete(bounded);
  });
}
export function requestTokenEstimate(body: unknown) {
  let estimate = 256;
  for (const ch of JSON.stringify(body))
    estimate += ch.charCodeAt(0) > 127 ? 2 : 1 / 3;
  return estimate + Number((body as any).max_completion_tokens ?? 0);
}
/** Fit the complete schema/dictionary/output budget, preserving exact content prefixes. */
export function fitInferenceRequest(body: any, evidence: Evidence[]) {
  const sources = evidence.map((e) => ({ ...e }));
  const input = JSON.parse(body.messages[1].content);
  const update = () => {
    input.sources = sources;
    body.messages[1].content = JSON.stringify(input);
  };
  update();
  while (requestTokenEstimate(body) > 7600) {
    const longest = sources.reduce((a, b) =>
      a.content.length >= b.content.length ? a : b,
    );
    if (longest.content.length > 128)
      longest.content = longest.content.slice(
        0,
        Math.max(128, longest.content.length - 64),
      );
    else {
      const title = sources.find((e) => e.title.length > 80);
      if (title) title.title = title.title.slice(0, 80);
      else if (sources.length > 1) sources.pop();
      else throw new ResearchError("GROQ_REQUEST_TOO_LARGE");
    }
    update();
  }
  return { body, evidence: sources };
}
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
      if (!explicitCredit(c.quote, c.name, c.role, c.aliases)) fail();
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
    // Include the schema, dictionary and output allowance in the same transport guard.
    if (requestTokenEstimate(body) > 7600)
      throw new ResearchError("GROQ_REQUEST_TOO_LARGE");
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
