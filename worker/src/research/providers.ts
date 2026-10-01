import type {
  CreditRole,
  VersionKind,
  RecordingMetadata,
} from "../../../shared/contracts";
import { catalogUrl } from "../catalog";
export interface Evidence {
  id: string;
  url: string;
  title: string;
  content: string;
  metadata?: RecordingMetadata;
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
  raw_model?: string;
  review_warnings?: string[];
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
        "(?:(?:words|lyrics?)\\s*(?:,|&|and)\\s*)?music(?:\\s*(?:&|and)\\s*(?:lyrics?|arrangement))?|composed\\s+by|composer|composition|作詞[&/・と]作曲(?:[&/・と]編曲)?|作曲(?:[&/・と]編曲)?(?:者)?",
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
    const withoutHandles = (v: string) =>
      v.replace(/(?:\s+@[a-z0-9_][a-z0-9_.-]*)+\s*$/i, "").trim();
    return (
      complete(value) ||
      complete(bounded) ||
      complete(withoutHandles(value)) ||
      complete(withoutHandles(bounded))
    );
  });
}
export const recordingTitleMatches = (actual: string, requested: string) =>
  norm(actual).includes(norm(requested));
/** Links must be observed in the retrieved document, never supplied by the query. */
export function linkedRecording(source: Evidence, recording: string) {
  if (source.url === recording) return true;
  return [...source.content.matchAll(/https:\/\/[^\s<>"\]\)]+/g)].some(
    ([link]) => {
      try {
        return catalogUrl(link.replace(/&amp;/g, "&")) === recording;
      } catch {
        return false;
      }
    },
  );
}

export function knownIdentitySchema(
  evidence: Evidence[],
  query: {
    title: string;
    reference_url: string | null;
    artist_hint?: string | null;
  },
) {
  const schema = structuredClone(analysisSchema);
  let canonical: string | null;
  try {
    canonical = catalogUrl(query.reference_url);
  } catch {
    return schema;
  }
  if (!canonical) return schema;
  const known = evidence.find(
    (s) =>
      s.url === canonical &&
      s.metadata?.provider === "youtube_oembed" &&
      s.metadata.endpoint === youtubeMetadataEndpoint(canonical) &&
      recordingTitleMatches(s.metadata.title, query.title) &&
      (!query.artist_hint || norm(s.content).includes(norm(query.artist_hint))),
  );
  if (known)
    Object.assign((schema.properties as any).recordings, {
      minItems: 1,
      maxItems: 1,
    });
  return schema;
}
const fieldHeader =
  /^\s*(?:channel|uploader|uploaded by|title|song title|チャンネル|投稿者|タイトル|曲名)(?:\s*[:：]|\s*$)/i;
const descriptionHeader =
  /^\s*(?:description|song credits|credits|説明|概要|楽曲クレジット|クレジット)(?:\s*[:：]|\s*$)/i;
/** The metadata JSON prefix is a distinct field origin, never recording-credit prose. */
function independentText(source: Evidence, role?: CreditRole) {
  const fields = source.metadata ? JSON.stringify(source.metadata) + "\n" : "";
  const text = source.content.startsWith(fields)
    ? source.content.slice(fields.length)
    : "";
  let field: "channel" | "title" | null = null;
  let pendingValue = false;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      // The first nonempty value of a multiline field stays in that field,
      // even when the value itself looks like a role or section label.
      if (pendingValue) {
        if (line.trim()) pendingValue = false;
        return field === "channel" && role === "uploader";
      }
      if (descriptionHeader.test(line)) field = null;
      else if (fieldHeader.test(line)) {
        field = /^\s*(?:title|song title|タイトル|曲名)(?:\s*[:：]|\s*$)/i.test(
          line,
        )
          ? "title"
          : "channel";
        pendingValue = /[:：]\s*$/.test(line) || !/[:：]/.test(line);
      }
      if (field && !(field === "channel" && role === "uploader")) return false;
      if (norm(line) === norm(source.metadata?.title ?? source.title))
        return false;
      return true;
    })
    .join("\n");
}
export function hasDescriptors(
  evidence: Evidence[],
  recording?: string | null,
) {
  return evidence.some(
    (s) =>
      (!recording || linkedRecording(s, recording)) &&
      /\b(?:pop|rock|dance|jazz|folk|ballad|electronic|hip.hop|metal|bright|dark|warm|gentle|calm|upbeat|melancholic|refreshing|energetic|soft|powerful|tempo|chorus|instrumental)\b|ジャンル|曲調|ポップ|ロック|ダンス|切な|爽やか|穏やか|透明感|ハスキー|疾走感|バラード/i.test(
        independentText(s)
          .split(/\r?\n/)
          .filter(
            (line) =>
              !/^\s*(?:vocal|music|artist|composer|歌唱|作曲)\s*[:：]/i.test(
                line,
              ),
          )
          .join("\n"),
      ),
  );
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
      !linkedRecording(s, recording)
    )
      fail();
    return s!;
  };
  if (!value || !Array.isArray(value.recordings) || value.recordings.length > 2)
    fail();
  if (!value.recordings.length)
    throw new ResearchError("NO_SUPPORTED_RECORDINGS");
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
      !recordingTitleMatches(r.title, query.title) ||
      (s.metadata && !recordingTitleMatches(s.metadata.title, query.title)) ||
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
        !linkedRecording(relationship, o.reference_url) ||
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
      const creditedSource = quote(c.source_id, c.quote, url!);
      const m = creditedSource.metadata;
      const structuredUploader =
        m?.provider === "youtube_oembed" &&
        m.endpoint === youtubeMetadataEndpoint(url!) &&
        c.role === "uploader" &&
        c.kind === "channel" &&
        c.name === m.author_name &&
        c.quote === m.author_name &&
        c.aliases.length === 0;
      const feature = c.quote.match(/(?:^|\s)(?:feat(?:uring)?\.?)\s+/i);
      const caption = m?.title ?? creditedSource.title;
      const titleVocalist =
        c.role === "vocalist" &&
        feature &&
        norm(caption).includes(norm(c.quote)) &&
        explicitCredit(
          c.quote.slice(feature.index!),
          c.name,
          c.role,
          c.aliases,
        );
      // Trusted native author fields settle header attribution. Role-looking
      // substrings of those channel headers cannot establish another uploader.
      const prose = independentText(
        creditedSource,
        m && c.role === "uploader" ? undefined : c.role,
      );
      const ordinaryCredit =
        norm(prose).includes(norm(c.quote)) &&
        explicitCredit(c.quote, c.name, c.role, c.aliases);
      if (!structuredUploader && !titleVocalist && !ordinaryCredit) fail();
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
      const tagSource = quote(t.source_id, t.quote, url!);
      if (!norm(independentText(tagSource)).includes(norm(t.quote))) fail();
      const creditQuote = r.credits.find(
        (c: Claim) => norm(c.quote) === norm(t.quote),
      );
      const factualVoice =
        creditQuote?.role === "vocalist" &&
        ((tag!.name === "人の歌声" &&
          ["person", "group"].includes(creditQuote.kind)) ||
          (tag!.name === "合成歌声" && creditQuote.kind === "synthetic_voice"));
      if (creditQuote && !factualVoice) fail();
      // Names/role lines and lyrics do not describe the sound or mood. Only the
      // established factual voice type may be supported by a bare vocal credit.
      if (
        !factualVoice &&
        /(?:\b(?:vocal|music|artist|composer|lyrics?)\s*[:：]|歌唱\s*[:：]|\[\d+:\d+\])/i.test(
          t.quote,
        )
      )
        fail();
      if (
        tag!.category !== "歌詞テーマ" &&
        /\blyrics?\b|歌詞|\b(?:i|you|me|we)\b.*\b(?:dance|sleep|love|forget)\b/i.test(
          `${t.reasoning} ${t.quote}`,
        )
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
        !/[\p{L}]/u.test(t.reasoning)
      )
        fail();
    }
  }
  return value;
}

/** Identity is atomic; enrichment claims are individually reviewed and filtered. */
export function supportedAnalysis(
  raw: string,
  evidence: Evidence[],
  query: Parameters<typeof validateAnalysis>[2],
  tags: Parameters<typeof validateAnalysis>[3],
): Analysis {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ResearchError("INVALID_MODEL_JSON");
  }
  if (
    !parsed ||
    !Array.isArray(parsed.recordings) ||
    parsed.recordings.some(
      (r: any) =>
        !r ||
        !Array.isArray(r.credits) ||
        r.credits.length > 4 ||
        !Array.isArray(r.tags) ||
        r.tags.length > 5,
    )
  )
    throw new ResearchError("UNSUPPORTED_EVIDENCE");
  const identity = validateAnalysis(
    JSON.stringify({
      recordings: parsed.recordings.map((r: any) => ({
        ...r,
        credits: [],
        tags: [],
      })),
    }),
    evidence,
    query,
    tags,
  );
  const warnings: string[] = [];
  const test = (r: Recording) =>
    validateAnalysis(
      JSON.stringify({ recordings: [r] }),
      evidence,
      query,
      tags,
    );
  identity.recordings.forEach((r, index) => {
    const original = parsed.recordings[index];
    original.credits.forEach((claim: Claim, n: number) => {
      try {
        let c = structuredClone(claim);
        const s = evidence.find((s) => s.id === c.source_id),
          m = s?.metadata;
        if (
          m?.provider === "youtube_oembed" &&
          m.endpoint === youtubeMetadataEndpoint(r.reference_url) &&
          s &&
          linkedRecording(s, r.reference_url) &&
          c.role === "uploader" &&
          c.kind === "channel" &&
          c.name === m.author_name &&
          Array.isArray(c.aliases) &&
          c.aliases.length === 0 &&
          typeof c.quote === "string" &&
          norm(s.content).includes(norm(c.quote))
        )
          c.quote = m.author_name;
        const acceptedAliases: Claim["aliases"] = [];
        // First validate role attribution with all aliases (some complete bilingual
        // credit forms need their explicit alias proof), then check aliases singly.
        test({ ...r, credits: [c], tags: [] });
        for (const a of c.aliases) {
          try {
            test({ ...r, credits: [{ ...c, aliases: [a] }], tags: [] });
            acceptedAliases.push(a);
          } catch {
            warnings.push(
              `recording:${index}:credit:${n}:alias:UNSUPPORTED_EVIDENCE`,
            );
          }
        }
        c.aliases = acceptedAliases;
        r.credits.push(c);
      } catch {
        // A bad alias must not discard an otherwise ordinary explicit attribution.
        try {
          const c = { ...claim, aliases: [] };
          test({ ...r, credits: [c], tags: [] });
          r.credits.push(c);
          warnings.push(
            `recording:${index}:credit:${n}:aliases:UNSUPPORTED_EVIDENCE`,
          );
        } catch {
          warnings.push(`recording:${index}:credit:${n}:UNSUPPORTED_EVIDENCE`);
        }
      }
    });
    original.tags.forEach((t: Recording["tags"][number], n: number) => {
      try {
        test({ ...r, tags: [t] });
        r.tags.push(t);
      } catch {
        warnings.push(`recording:${index}:tag:${n}:UNSUPPORTED_EVIDENCE`);
      }
    });
  });
  return {
    ...identity,
    raw_model: raw,
    review_warnings: warnings.slice(0, 24),
  };
}
export async function providerJson(
  fetcher: typeof fetch,
  url: string,
  key: string,
  body?: unknown,
  timeoutMs = 20000,
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
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
        "User-Agent": "FavoriteSongSurvey/1.0",
      },
      ...(body ? { body: serialized } : {}),
      signal: AbortSignal.timeout(timeoutMs),
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

/** This is the only direct recording fetch: fixed HTTPS host, validated video ID. */
export function youtubeMetadataEndpoint(url: string) {
  if (!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url))
    return null;
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
}
export async function recordingMetadata(
  fetcher: typeof fetch,
  url: string,
): Promise<RecordingMetadata | undefined> {
  const endpoint = youtubeMetadataEndpoint(url);
  if (!endpoint) return;
  try {
    const m = await providerJson(fetcher, endpoint, "", undefined, 5000);
    if (
      typeof m.title !== "string" ||
      !m.title.trim() ||
      m.title.length > 256 ||
      typeof m.author_name !== "string" ||
      !m.author_name.trim() ||
      m.author_name.length > 100
    )
      return;
    return {
      provider: "youtube_oembed",
      endpoint,
      title: m.title,
      author_name: m.author_name,
    };
  } catch {
    /* Missing metadata is recoverable; extracted evidence still applies. */
  }
}
/** Retain verbatim useful windows, never requested names or invented credit labels. */
export function recordingWindows(raw: string) {
  const lines = raw.slice(0, 48000).split(/\r?\n/);
  const footer = lines.findIndex((line) =>
    /^\s*(?:Transcript|文字起こし|Members?\s*[:：]?|メンバー\s*[:：]?)\s*$/i.test(
      line,
    ),
  );
  const usable = footer < 0 ? lines : lines.slice(0, footer);
  const useful =
    /vocal|feat\.?|composer|composed|music|lyrics\s*[&/]|artist|upload|channel|released|official|genre|mood|description|\b(?:pop|rock|dance|jazz|folk|ballad|electronic|hip.hop|metal|bright|dark|warm|gentle|calm|upbeat|melancholic|refreshing|energetic|soft|powerful|tempo|chorus|instrumental)\b|作曲|歌唱|ボーカル|名義|投稿|配信|ジャンル|ポップ|ロック|ダンス|切な|爽やか|穏やか|透明感|https:\/\//i;
  const selected = new Set<number>();
  // Small context windows preserve a credit whose value is on the following line.
  for (let i = 0; i < usable.length; i++)
    if (
      useful.test(usable[i]) ||
      fieldHeader.test(usable[i]) ||
      descriptionHeader.test(usable[i])
    ) {
      selected.add(i);
      if (
        /[:：]\s*$/.test(usable[i]) ||
        (fieldHeader.test(usable[i]) && !/[:：]/.test(usable[i]))
      ) {
        let value = i + 1;
        while (value < usable.length && !usable[value].trim()) value++;
        if (value < usable.length) selected.add(value);
      }
    }
  const windows = [...selected].map((i) => usable[i]).join("\n");
  const content = windows || usable.slice(0, 6).join("\n");
  // The bounded excerpt must retain real recording links even when a long
  // descriptive paragraph pushes them past its first 1000 characters.
  const links = [...content.matchAll(/https:\/\/[^\s<>"\]\)]+/g)]
    .map(([link]) => link)
    .filter((link) => {
      try {
        return Boolean(youtubeMetadataEndpoint(catalogUrl(link)!));
      } catch {
        return false;
      }
    })
    .filter((link, i, all) => all.indexOf(link) === i)
    .slice(0, 4);
  const suffix = links
    .filter((link) => !content.slice(0, 1000).includes(link))
    .join("\n");
  return suffix
    ? `${content.slice(0, 999 - suffix.length)}\n${suffix}`
    : content.slice(0, 1000);
}
