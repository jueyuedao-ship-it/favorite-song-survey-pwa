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
  /** Worker-derived relation to the selected recording; never copied from provider JSON. */
  recording_associations?: (
    | {
        provenance: "worker_verified_release_v1";
        reference_url: string;
        basis: "official_release";
        artist: string;
        title_quote: string;
        release_url: string;
      }
    | {
        provenance: "worker_verified_song_v1";
        reference_url: string;
        basis: "exact_song_recording";
        artist: string;
        song_title: string;
        identity_quote: string;
        description_quote: string;
      }
  )[];
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
    evidence_type?: "direct" | "semantic_inference";
  }[];
}
export interface Analysis {
  recordings: Recording[];
  raw_model?: string;
  review_warnings?: string[];
  tag_decisions?: {
    tag_id: string;
    source_id: string;
    status: "accepted" | "rejected";
    evidence_type?: "direct" | "semantic_inference";
    reason_code: string;
  }[];
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
const creditGroups: { role: CreditRole; pattern: string }[] = [
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

const withoutHandles = (value: string) =>
  value.replace(/(?:\s+@[a-z0-9_][a-z0-9_.-]*)+\s*$/i, "").trim();
const descriptorWords =
  /\b(?:pop|rock|dance|jazz|folk|ballad|electronic|hip.hop|metal|bright|dark|warm|gentle|calm|upbeat|melancholic|refreshing|energetic|soft|powerful|clear|transparent|tempo|chorus|instrumental|synth|classical|fast|slow|hope|husky|whisper)\b|ジャンル|曲調|ポップ|ロック|ダンス|切な|爽やか|穏やか|透明感|ハスキー|疾走感|バラード|アップテンポ|電子音|シンセ|希望|歌詞|歌声|ジャズ|クラシック/i;
/** Share field boundaries and complete values between credit and tag provenance. */
function creditClauses(quote: string) {
  // Preserve case: a multiword whitespace-only name needs proper-name tokens.
  // Explicit fields/by/featured clauses also permit lowercase multiword names.
  const input = quote.normalize("NFKC");
  const markers = [
    ...input.matchAll(
      new RegExp(
        "(?<![\\p{L}\\p{N}_])(" +
          creditGroups.map((g) => g.pattern).join("|") +
          ")(?:\\s*([:.\\-–—])\\s*|\\s+)",
        "giu",
      ),
    ),
  ];
  return markers.flatMap((m, i) => {
    const value = input
      .slice(m.index! + m[0].length, markers[i + 1]?.index ?? input.length)
      .split(/[;；\n。]/)[0]
      .trim();
    // A following known role bounds a sentence separator; interior punctuation
    // remains part of the complete name (Mrs. GREEN APPLE, AC/DC, fun.).
    const bounded = markers[i + 1] ? value.replace(/\.\s*$/, "").trim() : value;
    if (!value) return [];
    const explicit = !!m[2] || /\bby$|^feat(?:uring)?$/i.test(m[1]);
    let named = true;
    if (!explicit) {
      const leading = input.slice(0, m.index);
      if (!/(?:^|[;；\n。.])\s*$/.test(leading)) return [];
      const name = withoutHandles(bounded);
      named =
        name.length <= 100 &&
        name
          .split(/\s+/)
          .every(
            (token, _, words) =>
              words.length === 1 ||
              /^[\p{Lu}\p{Lt}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
                token,
              ),
          );
      // Lowercase predicate prose must actually describe sound. An ambiguous
      // bare role/value stays non-descriptive, without crediting a guessed name.
      if (!named && /^\p{Ll}/u.test(name) && descriptorWords.test(name))
        return [];
    }
    const role = creditGroups.find((g) =>
      new RegExp("^(?:" + g.pattern + ")$", "iu").test(m[1]),
    )!.role;
    return [{ role, value, bounded, named }];
  });
}
function hasCreditAttribution(value: string) {
  return creditClauses(value).length > 0;
}
/** Only a complete name directly attributed by the matching role clause is accepted. */
export function explicitCredit(
  quote: string,
  name: string,
  role: CreditRole,
  aliases: { name: string; quote: string }[] = [],
) {
  if (!norm(name)) return false;
  const complete = (value: string, named: boolean) => {
    const attributed = norm(value);
    const credited = norm(name);
    if (attributed === credited) return named;
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
  return creditClauses(quote).some(
    ({ role: attributedRole, value, bounded, named }) => {
      if (attributedRole !== role) return false;
      // Structural alias tokens may fail the plain-name gate. Only the exact
      // whole-value alias proof below can establish those whitespace fields.
      return (
        complete(value, named) ||
        complete(bounded, named) ||
        complete(withoutHandles(value), named) ||
        complete(withoutHandles(bounded), named)
      );
    },
  );
}
export const recordingTitleMatches = (actual: string, requested: string) =>
  norm(actual).includes(norm(requested));
function officialReleaseUrl(value: string, artist: string): string | null {
  try {
    const canonical = catalogUrl(value);
    if (!canonical) return null;
    const parsed = new URL(canonical);
    const host = parsed.hostname.toLowerCase();
    const aliasHost = host.endsWith(".lnk.to")
      ? host.slice(0, -".lnk.to".length)
      : "";
    if (aliasHost && norm(aliasHost) === norm(artist)) return canonical;
    if (host === "open.spotify.com" && /\/track\//.test(parsed.pathname))
      return canonical;
    if (host === "music.apple.com" && /\/song\//.test(parsed.pathname))
      return canonical;
    if (host === "ototoy.jp" && /\/_\/default\/p\/\d+/.test(parsed.pathname))
      return canonical;
    return null;
  } catch {
    return null;
  }
}
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
/** Release-page context can support descriptions without becoming credit evidence. */
export function linkedDescriptionRecording(source: Evidence, recording: string) {
  if (linkedRecording(source, recording)) return true;
  if (
    source.recording_associations?.some((association) => {
      try {
        if (association.provenance === "worker_verified_song_v1")
          return exactSongAssociationMatchesSource(source, association, recording);
        return (
          association.provenance === "worker_verified_release_v1" &&
          association.basis === "official_release" &&
          catalogUrl(association.reference_url) === recording &&
          association.artist.trim().length >= 2 &&
          association.title_quote.trim().length >= 3 &&
          officialReleaseUrl(association.release_url, association.artist) ===
            association.release_url
        );
      } catch {
        return false;
      }
    })
  )
    return true;
  return false;
}

const cleanRecordingText = (raw: string) => {
  const clean = raw
    .slice(0, 48000)
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    .replace(/\[\s*\]\(https?:\/\/[^)\s]+\)/g, " ")
    .replace(/<(https:\/\/[^<>\s]+)>/gi, "$1")
    .replace(/data:image\/[\w.+-]+;[^\s)]*/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/[ \t]+/g, " ");
  const paragraphs: string[] = [];
  let bodyLines: string[] = [];
  const flush = () => {
    const body = bodyLines.join(" ").trim();
    if (body) paragraphs.push(body);
    bodyLines = [];
  };
  const relatedHeading =
    /^\s{0,3}#{0,6}\s*(?:関連記事|関連する(?:記事|作品|楽曲)|おすすめ記事|こちらもおすすめ|他の作品|他の楽曲|別の曲|別の楽曲|other (?:songs|tracks|articles)|another song|other song|other track|related (?:songs|tracks|articles)|you may also like|digital catalog(?:ue)?|デジタルカタログ)/i;
  const transcriptHeading =
    /^\s{0,3}#{0,6}\s*(?:transcript|lyrics transcript|文字起こし|lyrics|歌詞)\s*[:：]?\s*$/i;
  const trackSidebar =
    /^\s{0,3}#{0,6}\s*(?:他の曲|別の曲|別の楽曲|other (?:songs|tracks)|another song)/i;
  for (const sourceLine of clean.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (
      relatedHeading.test(line) ||
      trackSidebar.test(line) ||
      transcriptHeading.test(line)
    ) {
      flush();
      break;
    }
    const languageNavigation =
      line.length > 80 &&
      (line.match(/English|日本語|한국어|Français|Español|Deutsch|Italiano/gi)
        ?.length ?? 0) >= 3;
    if (
      languageNavigation ||
      /^\s*(?:home|back to top|ログイン|新規登録|メニュー|menu|search)\s*$/i.test(
        line,
      )
    ) {
      flush();
      continue;
    }
    const sectionHeading = /^\s*#{1,6}\s+/.test(line);
    const fieldBoundary = fieldHeader.test(line) || descriptionHeader.test(line);
    const creditBoundary = creditClauses(line).length > 0;
    if (sectionHeading || fieldBoundary || creditBoundary) {
      flush();
      paragraphs.push(line);
    } else bodyLines.push(line);
  }
  flush();
  return paragraphs;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactSongTitleIsSubject(text: string, title: string) {
  const normalized = text.normalize("NFKC");
  const escapedTitle = escapeRegExp(title.normalize("NFKC").trim());
  if (!escapedTitle) return false;
  // The title must be named as a song, single, track, or recording in the
  // prose. This prevents a short title such as "Scatman" from matching only
  // the artist name "Scatman John" or an unrelated title like "Scatman's World".
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])["'“‘]?${escapedTitle}["'”’]?\\s+(?:is|was|became|becomes|remains|served\\s+as)\\s+(?:(?:a|an|the|his|her|their)\\s+)?(?:(?:[\\p{L}\\p{N}]+(?:[-’'][\\p{L}\\p{N}]+)?\\s+){0,6})(?:song|single|track|recording)\\b`,
    "iu",
  ).test(normalized);
}

function exactArtistMention(text: string, artist: string) {
  const escapedArtist = escapeRegExp(artist.normalize("NFKC").trim());
  if (!escapedArtist) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapedArtist}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text.normalize("NFKC"));
}

function foreignNamedSongTitle(
  sentence: string,
  title: string,
  artist: string,
) {
  const isForeignTitle = (candidate: string) => {
    const normalized = norm(candidate);
    return Boolean(
      normalized &&
        !/^(?:it|this|that|these|those|the|a|an|as|where|which|who)$/i.test(
          normalized,
        ) &&
        !norm(title).includes(normalized) &&
        normalized !== norm(artist),
    );
  };
  const titleCasePhrase =
    /^[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*(?:\s+[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*){0,4}$/u;
  for (const [, quote] of sentence.matchAll(/["“‘]([^"“”‘’]{2,160})["”’]/gu)) {
    if (titleCasePhrase.test(quote.trim()) && isForeignTitle(quote)) return true;
  }
  for (const match of sentence.matchAll(
    /\b([\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*[’']s\s+[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*(?:\s+[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*){0,3})\b/gu,
  )) {
    if (isForeignTitle(match[1])) return true;
  }
  const relative = sentence.match(
    /((?:[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*\s+){1,4}[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*)\s*,\s*(?:which|who|that)\b/u,
  );
  return Boolean(relative && isForeignTitle(relative[1]));
}

function hasOtherNamedSongSubject(
  sentence: string,
  title: string,
  artist: string,
) {
  if (foreignNamedSongTitle(sentence, title, artist)) return true;
  if (exactSongTitleIsSubject(sentence, title)) return false;
  const quoted =
    /["“‘][^"“”‘’]{2,160}["”’]\s+(?:is|was|became|becomes|remains)\s+(?:(?:a|an|the|his|her|their)\s+)?(?:(?:[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)?\s+){0,6})(?:song|single|track|recording)\b/iu.test(
      sentence,
    );
  const unquoted =
    /^(?!(?:it|this|that|these|those|the|a|an|as|where|which)\b)(?:[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*)(?:\s+[\p{Lu}\p{Lt}][\p{L}\p{N}'’:&.-]*){0,5}\s+(?:is|was|became|becomes|remains)\s+(?:(?:a|an|the|his|her|their)\s+)?(?:(?:[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)?\s+){0,6})(?:song|single|track|recording)\b/iu.test(
      sentence.trim(),
    );
  return quoted || unquoted;
}

function isSongScopedContinuation(sentence: string) {
  const text = sentence.trim();
  return (
    /^(?:It|This|That|These|Those|Its|Their|The\s+(?:lyrics|song|track|recording|music|sound|groove|beat|rhythm|instrumentation|arrangement|chorus|verse|vocals?|voice|singing|tempo|bpm|mood|energy|genre|production|drum\s+machine))\b/i.test(
      text,
    ) ||
    /^As\s+[^.!?]{1,100},\s+(?:the\s+(?:lyrics|song|track|recording|music|sound)|its|their)\b/i.test(
      text,
    )
  );
}

function exactSongScopes(
  text: string,
  title: string,
  artist: string,
): { identity_quote: string; description_quote: string }[] {
  if (alternateRecordingEdition.test(text)) return [];
  const result: { identity_quote: string; description_quote: string }[] = [];
  for (const paragraph of cleanRecordingText(text)) {
    const sentences = paragraph
      .split(/(?<=[.!?。！？])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const subject = sentences.findIndex((sentence) =>
      exactSongTitleIsSubject(sentence, title),
    );
    if (subject < 0) continue;
    if (hasOtherNamedSongSubject(sentences[subject], title, artist)) continue;
    const scope = [sentences[subject]];
    let artistBound = exactArtistMention(sentences[subject], artist);
    let identityEnd = artistBound ? 0 : -1;
    for (let index = subject + 1; index < sentences.length; index++) {
      const sentence = sentences[index];
      if (
        hasOtherNamedSongSubject(sentence, title, artist) ||
        !isSongScopedContinuation(sentence)
      )
        break;
      scope.push(sentence);
      if (!artistBound && exactArtistMention(sentence, artist)) {
        artistBound = true;
        identityEnd = scope.length - 1;
      }
    }
    if (!artistBound) continue;
    result.push({
      identity_quote: scope.slice(0, identityEnd + 1).join(" "),
      description_quote: scope.join(" "),
    });
  }
  return result;
}

function exactSongIdentityQuote(text: string, title: string, artist: string) {
  return exactSongScopes(text, title, artist).length > 0;
}

function exactSongDescriptionQuote(text: string, title: string, artist: string) {
  return exactSongScopes(text, title, artist).some((scope) =>
    descriptorSearchGroups.some((group) =>
      group.cues.test(scope.description_quote),
    ),
  );
}

function rescopeExactSongAssociation(
  association: Extract<
    NonNullable<Evidence["recording_associations"]>[number],
    { provenance: "worker_verified_song_v1" }
  >,
) {
  const identity = exactSongScopes(
    association.identity_quote,
    association.song_title,
    association.artist,
  )[0]?.identity_quote;
  const descriptions = exactSongScopes(
    association.description_quote,
    association.song_title,
    association.artist,
  )
    .filter((scope) =>
      descriptorSearchGroups.some((group) =>
        group.cues.test(scope.description_quote),
      ),
    )
    .map((scope) => scope.description_quote);
  const selected: string[] = [];
  for (const quote of descriptions) {
    if (selected.some((old) => norm(old) === norm(quote))) continue;
    if (`${selected.join("\n\n")}${selected.length ? "\n\n" : ""}${quote}`.length > 1200)
      break;
    selected.push(quote);
  }
  if (!identity || !selected.length) return null;
  return {
    identity_quote: identity,
    description_quote: selected.join("\n\n"),
  };
}

function validExactSongAssociation(
  association: NonNullable<Evidence["recording_associations"]>[number],
  recording: string,
) {
  if (association.provenance !== "worker_verified_song_v1") return false;
  let reference: string | null;
  try {
    reference = catalogUrl(association.reference_url);
  } catch {
    return false;
  }
  return (
    association.basis === "exact_song_recording" &&
    reference === recording &&
    association.artist.trim().length >= 2 &&
    association.song_title.trim().length >= 2 &&
    association.identity_quote.trim().length >= 3 &&
    association.identity_quote.length <= 1200 &&
    association.description_quote.trim().length >= 3 &&
    association.description_quote.length <= 1200 &&
    exactSongIdentityQuote(
      association.identity_quote,
      association.song_title,
      association.artist,
    ) &&
    Boolean(rescopeExactSongAssociation(association))
  );
}

function exactSongAssociationMatchesSource(
  source: Evidence,
  association: NonNullable<Evidence["recording_associations"]>[number],
  recording: string,
) {
  if (
    association.provenance !== "worker_verified_song_v1" ||
    !validExactSongAssociation(association, recording)
  )
    return false;
  const scoped = rescopeExactSongAssociation(association);
  if (
    !scoped ||
    norm(association.identity_quote) !== norm(scoped.identity_quote) ||
    norm(association.description_quote) !== norm(scoped.description_quote)
  )
    return false;
  const content = norm(contentWithoutMetadata(source));
  return (
    content.includes(norm(scoped.identity_quote)) &&
    content.includes(norm(scoped.description_quote))
  );
}

const releaseTerms =
  /single|new song|release(?:d)?|distribution|available|track|配信|リリース|発売|新曲|シングル|楽曲紹介|作品紹介/i;
const editionConflict =
  /\bcover(?:ed)?\b|\bremix(?:ed)?\b|\boff[- ]?vocal\b|\blive(?: version| recording)?\b|\bacoustic(?: version)?\b|カバー|リミックス|オフボーカル|ライブ|アコースティック/i;
const alternateRecordingEdition =
  /\bcover(?:ed)?\b|\bremix(?:ed)?\b|\boff[- ]?vocal\b|\blive(?:\s+(?:version|recording|performance))?\b|\bacoustic\s+version\b|\b(?:extended|radio|club|album)\s+(?:radio\s+)?(?:version|edit|mix|cut)\b|カバー|リミックス|オフボーカル|ライブ(?:\s*(?:版|バージョン|録音))?|アコースティック(?:\s*(?:版|バージョン))?/i;
const editionKind = (text: string) => {
  if (/\bcover(?:ed)?\b|カバー/i.test(text)) return "cover";
  if (/\bremix(?:ed)?\b|リミックス/i.test(text)) return "remix";
  if (/\blive(?: version| recording)?\b|ライブ/i.test(text)) return "live";
  if (/\bacoustic(?: version)?\b|アコースティック/i.test(text)) return "acoustic";
  if (/\b(?:extended|radio|club|album)\s+(?:radio\s+)?(?:version|edit|mix|cut)\b/i.test(text)) return "alternate";
  if (/\boff[- ]?vocal\b|オフボーカル/i.test(text)) return "instrumental";
  return "original";
};
const observedUrls = (text: string) =>
  [...text.matchAll(/https:\/\/[^\s<>"\]\)]+/g)]
    .map(([url]) => url.replace(/&amp;/g, "&").replace(/[.,;。）」』]+$/, ""))
    .filter((url, i, all) => all.indexOf(url) === i);

function primaryArtistAnchor(
  evidence: Evidence[],
  query: { title: string; reference_url: string | null; artist_hint?: string | null },
) {
  let recordingUrl: string | null;
  try {
    recordingUrl = catalogUrl(query.reference_url);
  } catch {
    return null;
  }
  if (!recordingUrl) return null;
  const primary = evidence.find((source) => source.url === recordingUrl);
  const metadata = primary?.metadata;
  if (
    !primary ||
    metadata?.provider !== "youtube_oembed" ||
    metadata.endpoint !== youtubeMetadataEndpoint(recordingUrl) ||
    !recordingTitleMatches(metadata.title, query.title) ||
    metadata.author_name.trim().length < 2
  )
    return null;
  const nativeText = norm(`${metadata.title} ${metadata.author_name}`);
  if (
    query.artist_hint &&
    norm(query.artist_hint).length >= 2 &&
    nativeText.includes(norm(query.artist_hint)) &&
    norm(metadata.title).includes(norm(query.artist_hint)) &&
    norm(metadata.author_name).includes(norm(query.artist_hint))
  )
    return query.artist_hint.trim();
  const titlePrefix = metadata.title.match(/^(.+?)\s+[-–—]\s+(.+?)(?:\s*\(|$)/)?.[1]?.trim();
  if (
    titlePrefix &&
    titlePrefix.length >= 2 &&
    recordingTitleMatches(metadata.title, query.title) &&
    norm(metadata.author_name).includes(norm(titlePrefix))
  )
    return titlePrefix;
  return null;
}

function selectedNativeSongTitle(
  nativeTitle: string | undefined,
  requestedTitle: string,
  artist: string,
) {
  if (!nativeTitle?.trim() || !requestedTitle.trim()) return null;
  let title = nativeTitle.normalize("NFKC").trim();
  title = title
    .replace(
      /\s*\((?:official(?:\s+(?:music\s+)?video)?|music\s+video|audio|visualizer|lyrics?(?:\s+video)?|hd|4k|remastered(?:\s+version)?)[^)]*\)\s*$/i,
      "",
    )
    .replace(
      /\s+(?:official(?:\s+(?:music\s+)?video)?|music\s+video|audio|visualizer|lyrics?(?:\s+video)?|hd|4k|remastered(?:\s+version)?)\b.*$/i,
      "",
    )
    .trim();
  const escapedArtist = escapeRegExp(artist.normalize("NFKC").trim());
  if (escapedArtist) {
    title = title
      .replace(new RegExp(`\\s+[-–—:]\\s+${escapedArtist}$`, "iu"), "")
      .replace(new RegExp(`^${escapedArtist}\\s+[-–—:]\\s+`, "iu"), "")
      .trim();
  }
  const escapedRequested = escapeRegExp(requestedTitle.normalize("NFKC").trim());
  if (
    !new RegExp(`^${escapedRequested}(?:\\s*\\([^()]{2,160}\\))?$`, "iu").test(
      title,
    )
  )
    return null;
  return title;
}

/**
 * Adds a non-model-authored article-to-recording relation only when verified
 * primary metadata independently anchors the artist and an extracted single
 * release context contains both artist and title plus observed distribution.
 */
export function associateOfficialReleaseEvidence(
  evidence: Evidence[],
  query: { title: string; reference_url: string | null; artist_hint?: string | null },
  rawTextByUrl: Record<string, string> = {},
  trustedPersistedSourceIds: string[] = [],
) {
  let recordingUrl: string | null;
  try {
    recordingUrl = catalogUrl(query.reference_url);
  } catch {
    recordingUrl = null;
  }
  const artist = primaryArtistAnchor(evidence, query);
  const primary = evidence.find((source) => source.url === recordingUrl);
  const nativeSongTitle = selectedNativeSongTitle(
    primary?.metadata?.title,
    query.title,
    artist ?? "",
  );
  const nativeEdition = editionKind(
    `${primary?.metadata?.title ?? ""} ${query.title}`,
  );
  const associated = evidence.map((source) => {
    const { recording_associations: previousAssociations = [], ...clean } = source;
    const previous = previousAssociations.filter((association) => {
      try {
        if (association.provenance === "worker_verified_song_v1")
          return (
            trustedPersistedSourceIds.includes(source.id) &&
            Boolean(recordingUrl) &&
            Boolean(artist) &&
            Boolean(nativeSongTitle) &&
            !alternateRecordingEdition.test(
              `${primary?.metadata?.title ?? ""} ${primary?.title ?? ""}`,
            ) &&
            norm(association.artist) === norm(artist!) &&
            norm(association.song_title) === norm(nativeSongTitle!) &&
            validExactSongAssociation(association, recordingUrl!)
          );
        return (
          trustedPersistedSourceIds.includes(source.id) &&
          association.provenance === "worker_verified_release_v1" &&
          association.basis === "official_release" &&
          catalogUrl(association.reference_url) === recordingUrl &&
          Boolean(artist) &&
          norm(association.artist) === norm(artist!) &&
          norm(association.title_quote).includes(norm(query.title)) &&
          norm(association.title_quote).includes(norm(artist!)) &&
          /single|release|distribution|track|配信|リリース|発売|新曲|シングル/i.test(
            association.title_quote,
          ) &&
          Boolean(officialReleaseUrl(association.release_url, artist!))
        );
      } catch {
        return false;
      }
    });
    const keepPrevious = () =>
      previous.length ? { ...clean, recording_associations: previous } : clean;
    if (source.url === recordingUrl) return clean;
    if (!recordingUrl || !artist) return keepPrevious();
    const associationText = rawTextByUrl[source.url] ?? source.content;
    const paragraphs = cleanRecordingText(associationText);
    const contextIndex = paragraphs.findIndex((paragraph) => {
      const text = norm(paragraph);
      const edition = editionKind(paragraph);
      return (
        text.includes(norm(query.title)) &&
        text.includes(norm(artist)) &&
        releaseTerms.test(paragraph) &&
        ((!editionConflict.test(paragraph) && nativeEdition === "original") ||
          (editionConflict.test(paragraph) && edition === nativeEdition))
      );
    });
    if (contextIndex < 0) return keepPrevious();
    const articleContext = paragraphs[contextIndex];
    const releaseStart = paragraphs.findIndex((paragraph) =>
      /^\s*(?:#{1,6}\s*)?(?:リリース情報|配信情報|作品情報|音源情報|release information|release info|track information|digital single|digital release|album info)(?:\b|$)/i.test(
        paragraph,
      ),
    );
    let releaseSection: string[] = [];
    if (releaseStart >= 0) {
      let releaseEnd = releaseStart + 1;
      while (
        releaseEnd < paragraphs.length &&
        !/^\s*#{1,6}\s+/.test(paragraphs[releaseEnd])
      )
        releaseEnd++;
      releaseSection = paragraphs.slice(releaseStart, releaseEnd);
    }
    const releaseQuote = releaseSection.find((paragraph) => {
      const text = norm(paragraph);
      const edition = editionKind(paragraph);
      return (
        text.includes(norm(query.title)) &&
        releaseTerms.test(paragraph) &&
        ((!editionConflict.test(paragraph) && nativeEdition === "original") ||
          (editionConflict.test(paragraph) && edition === nativeEdition))
      );
    });
    if (releaseSection.length && !releaseQuote) return keepPrevious();
    const neighbors = paragraphs.slice(
      Math.max(0, contextIndex - 1),
      Math.min(paragraphs.length, contextIndex + 4),
    );
    const targetContext = (releaseSection.length ? releaseSection : neighbors).join("\n");
    const context = releaseQuote ?? articleContext;
    const urls = observedUrls(targetContext);
    const distribution = urls.find((url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const linkParagraph = (releaseSection.length ? releaseSection : neighbors)
          .find((paragraph) => paragraph.includes(url)) ?? "";
        const conflictingQuotedTitle = [...linkParagraph.matchAll(/[「『"]([^」』"]+)[」』"]/g)]
          .some(([, title]) => norm(title) !== norm(query.title));
        if (conflictingQuotedTitle) return false;
        const route = host.endsWith(".lnk.to")
          ? host.slice(0, -".lnk.to".length)
          : "";
        if (
          route.length > 1 && norm(route) === norm(artist)
        ) {
          return (
            !conflictingQuotedTitle &&
            releaseSection.length > 0 &&
            Boolean(releaseQuote) &&
            /official|distribution|listen|stream|配信|公式|音源|発売/i.test(
              linkParagraph,
            )
          );
        }
        const pageForTarget =
          norm(articleContext).includes(norm(query.title)) &&
          norm(articleContext).includes(norm(artist)) &&
          Boolean(releaseQuote) &&
          norm(linkParagraph).includes(norm(query.title));
        return (
          pageForTarget &&
          ((host === "open.spotify.com" && /\/track\//.test(parsed.pathname)) ||
            (host === "music.apple.com" && /\/song\//.test(parsed.pathname)) ||
            (host === "ototoy.jp" && /\/_\/default\/p\/\d+/.test(parsed.pathname)))
        );
      } catch {
        return false;
      }
    });
    const sourceHost = (() => {
      try {
        return new URL(clean.url).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const officialPage =
      sourceHost === "ototoy.jp" &&
      /\/_\/default\/p\/\d+/.test(new URL(clean.url).pathname) &&
      norm(articleContext).includes(norm(query.title)) &&
      norm(articleContext).includes(norm(artist));
    if (!distribution && !officialPage) {
      return keepPrevious();
    }
    const titleQuote = [articleContext, ...(releaseQuote ? [releaseQuote] : [])]
      .filter((quote, index, all) => all.indexOf(quote) === index)
      .join("\n")
      .slice(0, 400);
    return {
      ...clean,
      recording_associations: [
        {
          provenance: "worker_verified_release_v1" as const,
          reference_url: recordingUrl,
          basis: "official_release" as const,
          artist,
          title_quote: titleQuote,
          release_url: distribution ?? clean.url,
        },
      ],
    };
  });
  return associateExactSongRecordingEvidence(
    associated,
    query,
    rawTextByUrl,
    trustedPersistedSourceIds,
  );
}

/** Links only song-scoped description paragraphs to the native selected recording. */
export function associateExactSongRecordingEvidence(
  evidence: Evidence[],
  query: { title: string; reference_url: string | null; artist_hint?: string | null },
  rawTextByUrl: Record<string, string> = {},
  trustedPersistedSourceIds: string[] = [],
) {
  let recordingUrl: string | null;
  try {
    recordingUrl = catalogUrl(query.reference_url);
  } catch {
    recordingUrl = null;
  }
  const artist = primaryArtistAnchor(evidence, query);
  const primary = evidence.find((source) => source.url === recordingUrl);
  const nativeSongTitle = selectedNativeSongTitle(
    primary?.metadata?.title,
    query.title,
    artist ?? "",
  );
  const selectedTitle = `${primary?.metadata?.title ?? ""} ${primary?.title ?? ""} ${query.title}`;
  const selectedEditionIsAmbiguous = alternateRecordingEdition.test(selectedTitle);

  return evidence.map((source) => {
    const previous = source.recording_associations?.flatMap((association) => {
      try {
        const trusted =
          association.provenance === "worker_verified_song_v1" &&
          trustedPersistedSourceIds.includes(source.id) &&
          Boolean(recordingUrl) &&
          Boolean(artist) &&
          Boolean(nativeSongTitle) &&
          !selectedEditionIsAmbiguous &&
          norm(association.artist) === norm(artist!) &&
          norm(association.song_title) === norm(nativeSongTitle!) &&
          validExactSongAssociation(association, recordingUrl!);
        if (!trusted || association.provenance !== "worker_verified_song_v1")
          return [];
        const scoped = rescopeExactSongAssociation(association);
        return scoped ? [{ ...association, ...scoped }] : [];
      } catch {
        return [];
      }
    }) ?? [];
    const official = source.recording_associations?.filter(
      (association) => association.provenance === "worker_verified_release_v1",
    ) ?? [];
    const clean: Evidence = {
      ...source,
      ...(official.length || previous.length
        ? { recording_associations: [...official, ...previous] }
        : { recording_associations: undefined }),
    };
    if (
      source.url === recordingUrl ||
      !recordingUrl ||
      !artist ||
      !nativeSongTitle
    )
      return clean;
    if (
      selectedEditionIsAmbiguous ||
      alternateRecordingEdition.test(source.title) ||
      editionKind(source.title) !== "original"
    )
      return clean;

    const text = rawTextByUrl[source.url] ?? source.content;
    const paragraphs = cleanRecordingText(text);
    const scopes = paragraphs.flatMap((paragraph) =>
      exactSongScopes(paragraph, nativeSongTitle, artist!).filter(
        (scope) =>
          scope.description_quote.length <= 1200 &&
          descriptorSearchGroups.some((group) =>
            group.cues.test(scope.description_quote),
          ),
      ),
    );
    const descriptions = scopes.map((scope) => scope.description_quote);
    if (previous.length) {
      const prior = previous.find(
        (association) => association.provenance === "worker_verified_song_v1",
      )!;
      const combinedQuotes = [prior.description_quote, ...descriptions].filter(
        (quote, index, all) =>
          quote.trim() &&
          all.findIndex((candidate) => norm(candidate) === norm(quote)) === index,
      );
      const combinedDescription = combinedQuotes.join("\n\n");
      if (combinedDescription.length > 1200) return clean;
      const association = {
        ...prior,
        description_quote: combinedDescription,
      };
      return {
        ...clean,
        recording_associations: [...official, association],
      };
    }
    if (linkedDescriptionRecording(clean, recordingUrl)) return clean;
    const scope = scopes[0];
    if (!scope || scope.identity_quote.length > 1200) return clean;
    const association = {
      provenance: "worker_verified_song_v1" as const,
      reference_url: recordingUrl,
      basis: "exact_song_recording" as const,
      artist,
      song_title: nativeSongTitle,
      identity_quote: scope.identity_quote,
      description_quote: scope.description_quote,
    };
    return {
      ...clean,
      recording_associations: [...official, association],
    };
  });
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
  if (known) {
    Object.assign((schema.properties as any).recordings, {
      minItems: 1,
      maxItems: 1,
    });
    const identity = (schema.properties as any).recordings.items.properties;
    identity.reference_url = {
      ...identity.reference_url,
      type: "string",
      enum: [canonical],
    };
    identity.source_id = {
      ...identity.source_id,
      type: "string",
      enum: [known.id],
    };
    identity.quote = {
      ...identity.quote,
      type: "string",
      enum: [known.metadata!.title],
    };
  }
  return schema;
}
export const fieldHeader =
  /^\s*(?:#{1,6}\s*)?(?:channel|uploader|uploaded by|title|song title|チャンネル|投稿者|タイトル|曲名)(?:\s*[:：]|\s*$)/i;
export const descriptionHeader =
  /^\s*(?:#{1,6}\s*)?(?:description|song credits|credits|説明|概要|楽曲クレジット|クレジット)(?:\s*[:：]|\s*$)/i;
/** The metadata JSON prefix is a distinct field origin, never recording-credit prose. */
export function contentWithoutMetadata(source: Evidence) {
  if (!source.metadata) return source.content;
  const serialized = JSON.stringify(source.metadata);
  if (source.content === serialized) return "";
  if (source.content.startsWith(serialized))
    return source.content.slice(serialized.length).replace(/^\r?\n/, "");
  return source.content;
}
function independentText(source: Evidence, role?: CreditRole) {
  const text = contentWithoutMetadata(source);
  let field: "channel" | "title" | null = null;
  let pendingValue = false;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const headerLine = line.replace(/^\s*#{1,6}\s*/, "");
      // The first nonempty value of a multiline field stays in that field,
      // even when the value itself looks like a role or section label.
      if (pendingValue) {
        if (line.trim()) pendingValue = false;
        return field === "channel" && role === "uploader";
      }
      if (descriptionHeader.test(headerLine)) field = null;
      else if (fieldHeader.test(headerLine)) {
        field = /^\s*(?:title|song title|タイトル|曲名)(?:\s*[:：]|\s*$)/i.test(
          headerLine,
        )
          ? "title"
          : "channel";
        pendingValue = /[:：]\s*$/.test(headerLine) || !/[:：]/.test(headerLine);
      }
      if (field && !(field === "channel" && role === "uploader")) return false;
      if (norm(headerLine) === norm(source.metadata?.title ?? source.title))
        return false;
      return true;
    })
    .join("\n");
}
const syntheticVoiceTypeSource =
  "(?:合成(?:音声|歌声|ボーカル|歌唱)|ボーカロイド|ボカロ|\\bVOCALOID\\b|\\bSynthesizer\\s*V\\b|\\bCeVIO\\b|\\bUTAU\\b|\\bsynthetic\\s+(?:voice|vocal|singer)\\b|\\bsynthesi[sz]ed\\s+(?:voice|vocal|singer)\\b|\\bvirtual\\s+(?:voice|singer)\\b|\\bAI[- ]generated\\s+(?:voice|vocal|singer)\\b)";
const syntheticVoiceTypeSignal = new RegExp(syntheticVoiceTypeSource, "i");
const negatedSyntheticVoiceType =
  /\b(?:not|never|no|without|isn't|aren't|wasn't|weren't)\b[^.!?。！？]{0,24}$/i;
function completeNameMention(text: string, name: string) {
  const normalizedName = norm(name);
  if (!normalizedName) return null;
  const escaped = normalizedName
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const particles = "はがのとやもをにへで";
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-]|[${particles}])${escaped}(?=$|[^\\p{L}\\p{N}_-]|[${particles}])`,
    "u",
  );
}
function exactNativeFeaturedVirtualSinger(claim: Claim, source: Evidence) {
  // Crypton's product pages identify 初音ミク as virtual singer software and a voice library:
  // https://ec.crypton.co.jp/pages/prod/virtualsinger/mikuv3
  // https://ec.crypton.co.jp/pages/prod/virtualsinger
  const knownNames = new Set([norm("初音ミク"), norm("Hatsune Miku")]);
  const metadata = source.metadata;
  if (
    claim.role !== "vocalist" ||
    claim.kind !== "synthetic_voice" ||
    !knownNames.has(norm(claim.name)) ||
    metadata?.provider !== "youtube_oembed" ||
    metadata.endpoint !== youtubeMetadataEndpoint(source.url)
  )
    return false;
  const featured = claim.quote.match(
    /(?:^|\s)(?:feat(?:uring)?\.?)\s+(.+)$/i,
  );
  if (
    !featured ||
    !completeNameMention(featured[1].trim(), claim.name)?.test(
      norm(featured[1].trim()),
    )
  )
    return false;
  const particles = "はがのとやもをにへで";
  const escapedName = norm(claim.name)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const exactFeature = new RegExp(
    `(?:^|\\s)feat(?:uring)?\\.?\\s+${escapedName}(?=$|[^\\p{L}\\p{N}_-]|[${particles}])`,
    "u",
  );
  const nativeCaption = norm(metadata.title);
  return (
    nativeCaption.includes(norm(claim.quote)) &&
    exactFeature.test(nativeCaption)
  );
}
function explicitSyntheticVoiceAttribution(claim: Claim, source: Evidence) {
  const text = `${claim.quote}\n${independentText(source, claim.role)}`;
  return text.split(/[.!?。！？\n]+/u).some((sentence) => {
    const clauses = sentence.split(/\bbut\b|\bhowever\b|しかし|ただし|だが|一方で/i);
    return clauses.some((clause) => {
      const nameMention = completeNameMention(clause, claim.name);
      if (!nameMention?.test(norm(clause))) return false;
      const match = syntheticVoiceTypeSignal.exec(clause);
      if (!match) return false;
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + match[0].length);
      const positivePatterns = [
        new RegExp(
          `${nameMention.source}\\s*(?:is|are|was|were|uses?|has|have|performs? with|sings? with)\\s+(?:an?\\s+|the\\s+)?${syntheticVoiceTypeSource}`,
          "iu",
        ),
        new RegExp(
          `${nameMention.source}['’]s\\s+(?:voice|vocal|vocals|singing voice)\\s+(?:(?:is|are|was|were)\\s+)?(?:synthetic|synthesi[sz]ed|AI[- ]generated)`,
          "iu",
        ),
        new RegExp(
          `${nameMention.source}['’]s\\s+(?:synthetic|synthesi[sz]ed|AI[- ]generated)\\s+(?:voice|vocal|vocals|singer)`,
          "iu",
        ),
        new RegExp(
          `${nameMention.source}(?:は|が|の(?:声|歌声|ボーカル|歌唱)?)(?:は|が)?[^。！？]{0,12}${syntheticVoiceTypeSource}`,
          "iu",
        ),
        new RegExp(
          `${syntheticVoiceTypeSource}[^。！？]{0,16}(?:の|by|from)\\s*${nameMention.source}`,
          "iu",
        ),
      ];
      const negated =
        negatedSyntheticVoiceType.test(before) ||
        /^[^.!?。！？]{0,24}\b(?:not|never|no|without|isn't|aren't|wasn't|weren't)\b/i.test(
          after,
        ) ||
        /合成(?:音声|歌声|ボーカル|歌唱)[^。！？]{0,16}(?:ではない|ではなく|じゃない|ではありません|ではありませんでした)/i.test(
          clause,
        );
      return !negated && positivePatterns.some((pattern) => pattern.test(clause));
    });
  });
}
export const descriptorSearchGroups = [
  {
    id: "genre_sound",
    label: "ジャンルと音作り",
    search: "ジャンル 音楽性 サウンド 音色 楽器 composition genre sound instrumentation",
    cues:
      /j[- ]?pop|k[- ]?pop|日本語ポップ|韓国ポップ|邦楽ポップ|ロック|rock|r&b|リズム[＆&]ブルース|ヒップホップ|hip.?hop|ラップ|エレクトロ|electronic|電子音|シンセ|synth|ダンスポップ|dance.?pop|\bpop.{0,16}dance.{0,16}(?:tune|track|song)\b|ジャズ|jazz|スウィング|即興|フォーク|folk|クラシック|classical|メタル|metal|オーケストラ|\borchestral\b|\borchestra\b|acoustic|アコースティック/i,
  },
  {
    id: "mood_energy_tempo",
    label: "雰囲気・勢い・テンポ",
    search: "曲調 雰囲気 明るい 切ない 爽やか 勢い テンポ BPM mood energy tempo",
    cues:
      /明る|前向き|切な|胸が締め|悲し|穏やか|安ら|暗い|陰鬱|幻想|夢のよう|懐か|レトロ|コミカル|ユーモア|爽やか|清涼|温か|ぬくもり|緊張感|緊迫|しっとり|軽快|弾む|力強|激し|荒々し|疾走感|駆け抜け|ダンサブル|踊れる|重厚|ゆったり|スローテンポ|ミドルテンポ|アップテンポ|テンポ|\bbpm\b|\bbright\b|\bupbeat\b|\bmelanchol|\bsad\b|\bcalm\b|\bpeaceful\b|\bdark\b|\bdreamy\b|\bnostalgic\b|\brefreshing\b|\bwarm\b|\btense\b|\bgentle\b|\benergetic\b|\bfast tempo\b|\bslow tempo\b|\bmid[- ]tempo\b/i,
  },
  {
    id: "voice",
    label: "歌声の構成と印象",
    search: "歌声 歌唱 ボーカル 透明感 ハスキー whisper vocal timbre",
    cues:
      /(歌声|歌唱|ボーカル|歌手|vocal|voice|singing).{0,50}(透明感|澄ん|透き通|柔らか|優し|力強|ささや|ハスキー|かすれ|human|synth|合成|コーラス|合唱|複数|clear|soft|powerful|whisper|husky|chorus|choir|synthetic)|(?:透明感|澄ん|透き通|柔らか|優し|力強|ささや|ハスキー|かすれ|clear|soft|powerful|whisper|husky).{0,50}(歌声|歌唱|ボーカル|歌手|vocal|voice|singing)/i,
  },
  {
    id: "lyric_theme",
    label: "歌詞テーマ",
    search: "歌詞 内容 テーマ 恋愛 別れ 孤独 希望 lyrics theme meaning",
    cues:
      /(歌詞|lyrics?).{0,240}(恋愛|愛|別れ|失恋|孤独|ひとり|応援|励ま|希望|日常|毎日|自己探求|自分探し|社会|世界|love|relationship|farewell|loneliness|hope|everyday|self[- ]?discovery|society|world)|(恋愛|別れ|失恋|孤独|希望|日常|自己探求|自分探し|社会|世界|love|relationship|farewell|loneliness|hope|everyday|self[- ]?discovery|society|world).{0,240}(歌詞|lyrics?)/i,
  },
] as const;
export type DescriptorSearchGroup = (typeof descriptorSearchGroups)[number]["id"];
export const tagCategoryGuidance: Record<string, string> = {
  ジャンル:
    "実際のジャンル名、またはジャンルと具体的な音楽的特徴を確認する。キャッチーなメロディだけではJ-POPにしない。ピアノやサックスなど楽器名だけではジャズやクラシックにしない。",
  雰囲気:
    "明るさ、切なさ、穏やかさ、暗さ、幻想性、懐かしさ、コミカルさ、爽やかさ、温かさ、緊張感を曲調について述べた文章で確認する。歌詞の単語だけから曲調を推測しない。",
  勢い:
    "演奏やビートの具体的な説明を確認する。軽快、力強い、激しい、疾走感、ダンサブル、重厚などを曲名や一般的な感想だけから決めない。",
  テンポ感:
    "遅い・中程度・速いテンポ、BPM、または明確に相当する説明を確認する。雰囲気だけからテンポを推測しない。",
  歌声の構成:
    "人声・合成音声は明示された歌唱者種別で判断する。複数ボーカル、コーラス中心、インストは明示された記述を確認する。",
  歌声の印象:
    "歌声そのものの透明感、柔らかさ、力強さ、ささやき、ハスキーさを述べた記述を確認する。担当者名だけから印象を推測しない。",
  歌詞テーマ:
    "歌詞の内容を説明する文章で主題を確認する。歌詞の転載や単語の出現だけではテーマとみなさない。",
};
function descriptiveLines(source: Evidence) {
  const exactAssociation = source.recording_associations?.find(
    (association) => association.provenance === "worker_verified_song_v1",
  );
  const descriptionSource = exactAssociation
    ? { ...source, content: exactAssociation.description_quote, metadata: undefined }
    : source;
  return independentText(descriptionSource)
    .split(/\r?\n/)
    .filter(
      (line) =>
        !hasCreditAttribution(line) &&
        !/\[\d{1,2}:\d{2}\]|\btranscript\b|文字起こし|^\s*(?:lyrics?|歌詞)\s*[:：]?\s*$/i.test(
          line,
        ) &&
        !/^\s*(?:instrumental|inst\.?|オフボーカル|カラオケ)\s*(?:[(:：]|downloads?|https?:|音源)/i.test(
          line,
        ),
    );
}
function hasDescriptorEvidence(
  evidence: Evidence[],
  recording: string | null | undefined,
  group: DescriptorSearchGroup,
) {
  const definition = descriptorSearchGroups.find((candidate) => candidate.id === group)!;
  return evidence.some(
    (source) =>
      (!recording || linkedDescriptionRecording(source, recording)) &&
      definition.cues.test(descriptiveLines(source).join("\n")),
  );
}
export function missingDescriptorCategories(
  evidence: Evidence[],
  recording?: string | null,
  completed: string[] = [],
): DescriptorSearchGroup[] {
  return descriptorSearchGroups
    .map((group) => group.id)
    .filter(
      (group) =>
        !completed.includes(group) &&
        !hasDescriptorEvidence(evidence, recording, group),
    );
}
export function hasDescriptors(
  evidence: Evidence[],
  recording?: string | null,
) {
  return descriptorSearchGroups.some((group) =>
    hasDescriptorEvidence(evidence, recording, group.id),
  );
}

/** Alias claims are independent of whether their role quote needs an alias. */
function validateAliasEvidence(
  c: Claim,
  a: Claim["aliases"][number],
  recording: string,
  evidence: Evidence[],
) {
  const source = evidence.find((s) => s.id === c.source_id);
  if (
    !a ||
    typeof a.name !== "string" ||
    a.name.length > 100 ||
    typeof a.quote !== "string" ||
    a.quote.length < 3 ||
    a.quote.length > 400 ||
    !source ||
    !linkedRecording(source, recording) ||
    !norm(source.content).includes(norm(a.quote)) ||
    !norm(a.quote).includes(norm(c.name)) ||
    !norm(a.quote).includes(norm(a.name))
  )
    throw new ResearchError("UNSUPPORTED_EVIDENCE");
}
export function requestTokenEstimate(body: unknown) {
  let estimate = 256;
  for (const ch of JSON.stringify(body))
    estimate += ch.charCodeAt(0) > 127 ? 2 : 1 / 3;
  return estimate + Number((body as any).max_completion_tokens ?? 0);
}
function associatedDescriptionWindow(source: Evidence, maxLength: number) {
  const exactAssociation = source.recording_associations?.find(
    (candidate) => candidate.provenance === "worker_verified_song_v1",
  );
  if (exactAssociation) {
    const proof = [exactAssociation.identity_quote, exactAssociation.description_quote]
      .filter((quote, index, all) => all.indexOf(quote) === index)
      .join("\n\n");
    const limit = Math.min(1000, Math.max(128, Math.trunc(maxLength)));
    return proof.length <= limit ? proof : exactAssociation.description_quote.slice(0, limit);
  }
  const association = source.recording_associations?.find(
    (candidate) =>
      candidate.provenance === "worker_verified_release_v1" &&
      candidate.basis === "official_release" &&
      catalogUrl(candidate.reference_url) !== null &&
      Boolean(candidate.title_quote.trim()) &&
      Boolean(candidate.release_url.trim()),
  );
  if (!association) return recordingWindows(source.content, maxLength);
  const limit = Math.min(1000, Math.max(128, Math.trunc(maxLength)));
  const sentences = cleanRecordingText(source.content)
    .flatMap((paragraph) =>
      paragraph.split(/(?<=[。！？.!?])\s+/).map((sentence) => sentence.trim()),
    )
    .filter(
      (sentence) =>
        sentence.length >= 3 &&
        !/^\s*#{1,6}\s/.test(sentence) &&
        !hasCreditAttribution(sentence) &&
        !/data:image\/|^https?:\/\//i.test(sentence),
    );
  const matches = descriptorSearchGroups.map((group) =>
    sentences.filter((sentence) => group.cues.test(sentence)),
  );
  const representatives: string[] = [];
  for (const group of matches) {
    const sentence = group.find((candidate) => !representatives.includes(candidate));
    if (sentence) representatives.push(sentence);
  }
  const remainder = matches.flatMap((group) =>
    group.filter((sentence) => !representatives.includes(sentence)),
  );
  const selected: string[] = [];
  let length = 0;
  for (const sentence of [...representatives, ...remainder]) {
    if (selected.includes(sentence)) continue;
    const nextLength = length + sentence.length + (selected.length ? 2 : 0);
    if (nextLength > limit) continue;
    selected.push(sentence);
    length = nextLength;
  }
  return selected.length
    ? selected.join("\n\n")
    : recordingWindows(source.content, maxLength);
}
/** Fit the serialized request while retaining complete evidence sentences and derived provenance. */
export function fitInferenceRequest(body: any, evidence: Evidence[]) {
  const input = JSON.parse(body.messages[1].content);
  const tagDefinitions = Array.isArray(input.tags) ? input.tags : [];
  const recording = input.query?.reference_url
    ? catalogUrl(input.query.reference_url)
    : null;
  const sources = evidence
    .filter((source) => !recording || linkedDescriptionRecording(source, recording))
    .map((source) => {
    const prefix = source.metadata ? `${JSON.stringify(source.metadata)}\n` : "";
    const text = contentWithoutMetadata(source);
    const limit = Math.max(128, 1000 - prefix.length);
    const content = source.recording_associations?.length
      ? associatedDescriptionWindow(source, limit)
      : balancedEvidenceWindow(
          { ...source, content: text },
          {
            title: input.query?.title ?? "",
            artist_hint: input.query?.artist_hint,
          },
          limit,
        );
    return {
      ...source,
      content: `${prefix}${content}`,
    };
  });
  const hasPrimary = Boolean(
    recording && sources.some((source) => source.url === recording),
  );
  const lowValueIndex = () =>
    hasPrimary
      ? sources.findIndex(
          (source) =>
            source.url !== recording &&
            !source.recording_associations?.length &&
            !descriptorSearchGroups.some((group) =>
              group.cues.test(descriptiveLines(source).join("\n")),
            ) &&
            !/(?:^|\n)\s*(?:vocals?|singer|music|lyrics|composer|arrangement|artist|channel|歌唱|歌手|ボーカル|作詞|作曲|編曲|演奏)\s*[:：]/im.test(
              source.content,
            ),
        )
      : -1;
  while (sources.length > 1 && lowValueIndex() >= 0)
    sources.splice(lowValueIndex(), 1);
  const compactCriterion = (tag: (typeof tagDefinitions)[number]) => {
    const generic = `Webの説明・公式情報で「${tag.name}」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。`;
    return tag.criterion === generic
      ? {
          ...tag,
          criterion: `${tag.name}についてWebで具体的な根拠を確認。曲名や作者名から推測しない。`,
        }
      : tag;
  };
  const compactGuidance: Record<string, string> = {
    ジャンル:
      "明示ジャンルか具体的な音楽特徴。旋律だけでJ-POP、楽器名だけでジャズ/クラシックとしない。",
    雰囲気: "曲調の説明で判断。歌詞だけで推測しない。",
    勢い: "演奏やビートの具体描写で判断。",
    テンポ感: "速度やBPMの明示で判断。",
    歌声の構成: "声種・人数・コーラス・インストの明示を確認。",
    歌声の印象: "透明感等は歌声自体の記述で確認。",
    歌詞テーマ: "歌詞内容の説明で判断。単語だけで推測しない。",
  };
  const update = () => {
    const candidates = inferenceTagCandidates(
      tagDefinitions,
      sources,
      input.query?.reference_url,
    );
    input.tags = candidates.map(compactCriterion);
    const seenBodies = new Set<string>();
    input.sources = sources.map((source) => {
      const sourceView = {
        ...source,
        title: source.title.slice(0, 80),
        ...(source.recording_associations?.length
          ? {
      recording_associations: source.recording_associations.map(
              (association) =>
                association.provenance === "worker_verified_song_v1"
                  ? {
                      provenance: association.provenance,
                      reference_url: association.reference_url,
                      basis: association.basis,
                      artist: association.artist,
                      song_title: association.song_title,
                    }
                  : {
                      ...association,
                      title_quote: association.title_quote.slice(0, 96),
                    },
            ),
          }
          : {}),
      };
      if (source.recording_associations?.length) return sourceView;
      const body = contentWithoutMetadata(source);
      const key = norm(`${source.title}\n${body}`);
      if (key && seenBodies.has(key))
        return {
          ...sourceView,
          content: identityCreditWindow(source, {
            title: input.query?.title ?? "",
            artist_hint: input.query?.artist_hint,
          }),
        };
      if (key) seenBodies.add(key);
      return sourceView;
    });
    if (input.tag_category_guidance && typeof input.tag_category_guidance === "object") {
      const categories = new Set(candidates.map((tag: any) => tag.category));
      input.tag_category_guidance = Object.fromEntries(
        Object.entries(input.tag_category_guidance)
          .filter(([category]) => categories.has(category))
          .map(([category, guidance]) => [
            category,
            compactGuidance[category] ?? guidance,
          ]),
      );
    }
    const tagArraySchema =
      body.response_format?.json_schema?.schema?.properties?.recordings?.items
        ?.properties?.tags;
    if (tagArraySchema?.items?.properties?.tag_id) {
      const candidateIds = [
        ...new Set(
          input.tags
            .map((tag: any) => tag?.id)
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      const tagIdSchema = tagArraySchema.items.properties.tag_id;
      if (candidateIds.length) {
        tagArraySchema.items.properties.tag_id = {
          ...tagIdSchema,
          type: "string",
          enum: candidateIds,
        };
        tagArraySchema.maxItems = Math.min(tagArraySchema.maxItems ?? 12, 12);
      } else {
        const { enum: _enum, ...freeTagIdSchema } = tagIdSchema;
        tagArraySchema.items.properties.tag_id = {
          ...freeTagIdSchema,
          type: "string",
        };
        tagArraySchema.maxItems = 0;
      }
    }
    body.messages[1].content = JSON.stringify(input);
  };
  update();
  while (requestTokenEstimate(body) > 7600) {
    const removable = lowValueIndex();
    if (removable >= 0 && sources.length > 1) {
      sources.splice(removable, 1);
      update();
      continue;
    }
    const longest = sources.reduce((a, b) =>
      a.content.length >= b.content.length ? a : b,
    );
    if (longest.content.length > 128) {
      const prefix = longest.metadata
        ? `${JSON.stringify(longest.metadata)}\n`
        : "";
      const oldText = longest.content.startsWith(prefix)
        ? longest.content.slice(prefix.length)
        : longest.content;
      const targetLength = Math.max(128 - prefix.length, oldText.length - 64);
      const nextText = longest.recording_associations?.length
        ? associatedDescriptionWindow(longest, targetLength)
        : balancedEvidenceWindow(
            { ...longest, content: oldText },
            {
              title: input.query?.title ?? "",
              artist_hint: input.query?.artist_hint,
            },
            targetLength,
          );
      if (nextText.length >= oldText.length) {
        const title = sources.find((source) => source.title.length > 80);
        if (title) title.title = title.title.slice(0, 80);
        else if (sources.length > 1) sources.pop();
        else throw new ResearchError("GROQ_REQUEST_TOO_LARGE");
      } else longest.content = `${prefix}${nextText}`;
    }
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
const boundedString = (maxLength: number) => ({ type: "string", maxLength });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const arr = (items: unknown, maxItems?: number) => ({
  type: "array",
  items,
  ...(maxItems ? { maxItems } : {}),
});
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
        obj({
          tag_id: str,
          source_id: str,
          quote: boundedString(240),
          reasoning: boundedString(220),
        }),
        12,
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
  tags: { id: string; name: string; category?: string; criterion?: string }[],
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
  const quote = (
    id: any,
    q: any,
    recording: string,
    descriptionOnly = false,
  ) => {
    const s = evidence.find((x) => x.id === id);
    if (
      !s ||
      typeof q !== "string" ||
      q.length < 3 ||
      q.length > 400 ||
      !norm(s.content).includes(norm(q)) ||
      !(descriptionOnly
        ? linkedDescriptionRecording(s, recording)
        : linkedRecording(s, recording))
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
      r.tags.length > 12
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
        validateAliasEvidence(c, a, url!, evidence);
      }
    }
    for (const t of r.tags) {
      const tag = tags.find((x) => x.id === t.tag_id);
      if (!tag) fail();
      const tagSource = quote(t.source_id, t.quote, url!, true);
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
        (hasCreditAttribution(t.quote) || /\[\d+:\d+\]/.test(t.quote))
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
        t.reasoning.length > 220 ||
        t.quote.length > 240 ||
        !/[\p{L}]/u.test(t.reasoning)
      )
        fail();
    }
  }
  return value;
}

const seedTagCategories = (tagId: string) => {
  const number = Number(tagId.match(/^tag-(\d+)$/)?.[1]);
  if (number >= 1 && number <= 12) return "ジャンル";
  if (number >= 13 && number <= 22) return "雰囲気";
  if (number >= 23 && number <= 29) return "勢い";
  if (number >= 30 && number <= 32) return "テンポ感";
  if (number >= 33 && number <= 37) return "歌声の構成";
  if (number >= 38 && number <= 42) return "歌声の印象";
  if (number >= 43 && number <= 50) return "歌詞テーマ";
  return undefined;
};
const seedTagNames = [
  "",
  "J-POP",
  "K-POP",
  "ロック",
  "ポップロック",
  "R&B",
  "ヒップホップ",
  "エレクトロ",
  "ダンスポップ",
  "ジャズ",
  "フォーク",
  "クラシック",
  "メタル",
  "明るい",
  "切ない",
  "穏やか",
  "暗い",
  "幻想的",
  "懐かしい",
  "コミカル",
  "爽やか",
  "温かい",
  "緊張感",
  "しっとり",
  "軽快",
  "力強い",
  "激しい",
  "疾走感",
  "ダンサブル",
  "重厚",
  "ゆったり",
  "中程度",
  "速い",
  "人の歌声",
  "合成歌声",
  "複数ボーカル",
  "コーラス中心",
  "インスト",
  "透明感",
  "柔らかい",
  "力強い歌声",
  "ささやくような",
  "ハスキー",
  "恋愛",
  "別れ",
  "孤独",
  "応援",
  "希望",
  "日常",
  "自己探求",
  "社会・世界",
];
const seedTagSignals: Record<string, RegExp> = {
  "tag-01": /\bj\s*[-–]?\s*pop\b|日本(?:語)?ポップ(?:音楽|ス)?|邦楽ポップ/i,
  "tag-02": /\bk\s*[-–]?\s*pop\b|韓国ポップ(?:音楽|ス)?/i,
  "tag-03": /ロック|\brock\b/i,
  "tag-04": /ポップロック|\bpop\s*[-–]?\s*rock\b|ポップ.{0,16}ロック/i,
  "tag-05": /\br\s*&\s*b\b|リズム[＆&]ブルース|rhythm and blues/i,
  "tag-06": /ヒップホップ|\bhip[ -]?hop\b|ラップ.{0,24}(?:ビート|中心)|rap.{0,24}beat/i,
  "tag-07": /エレクトロ|電子音|\belectronic(?: music)?\b|\bsynthpop\b|シンセ.{0,20}(?:主体|中心|サウンド)|synth(?:sizer)?[- ](?:based|pop|driven)/i,
  "tag-08": /ダンスポップ|\bdance[ -]?pop\b|\bsynthpop\s+dance\s+(?:song|track|tune)\b|\bpop.{0,16}dance.{0,16}(?:tune|track|song)\b|ポップなダンスチューン|ポップ.{0,16}ダンス.{0,16}(?:ビート|チューン)|踊れるビート.{0,24}ポップ/i,
  "tag-09": /ジャズ|\bjazz\b|スウィング|\bswing\b|即興演奏|\bimprovisation\b/i,
  "tag-10": /フォーク|\bfolk(?: music)?\b/i,
  "tag-11": /クラシック|\bclassical(?: music)?\b|西洋芸術音楽/i,
  "tag-12": /メタル|\bmetal\b/i,
  "tag-13": /明る|前向き|\bbright\b|\bcheerful\b|\bpositive mood\b/i,
  "tag-14": /切な|胸.{0,8}締め|悲し|\bbittersweet\b|\bsad\b|\bmelanchol/i,
  "tag-15": /穏やか|安ら|落ち着|\bcalm\b|\bpeaceful\b|\bserene\b/i,
  "tag-16": /暗い|陰鬱|\bdark\b|\bgloomy\b/i,
  "tag-17": /幻想|夢のよう|非現実的|\bdreamy\b|\bfantastical\b|\bethereal\b/i,
  "tag-18": /懐か|レトロ|\bnostalgic\b|\bretro\b/i,
  "tag-19": /コミカル|滑稽|ユーモア|\bcomical\b|\bhumorous\b/i,
  "tag-20": /爽やか|清涼|すっきり|\brefreshing\b|\bcrisp\b/i,
  "tag-21": /温か|ぬくもり|親しみ|\bwarm(?:th)?\b|\bwelcoming\b/i,
  "tag-22": /緊張感|緊迫感|張りつめ|不安.{0,12}(?:曲調|雰囲気)|\btense\b|\bsuspenseful\b/i,
  "tag-23": /しっとり|静かで落ち着|情緒的な演奏|\bsoftly paced\b|\bsubdued performance\b/i,
  "tag-24": /軽快|軽やか|弾むリズム|\blively rhythm\b|\bbouncy rhythm\b|\blight and bouncy\b/i,
  "tag-25": /力強|強いエネルギー|\bpowerful performance\b|\bstrong energy\b/i,
  "tag-26": /激し|荒々し|\bintense\b|\bfierce\b|\brough sound\b/i,
  "tag-27": /疾走感|駆け抜け|\brapid and driving\b|\bdriving performance\b/i,
  "tag-28": /ダンサブル|踊りやすい|反復ビート|\bdanceable\b|\brepetitive beat\b|\bgroove/i,
  "tag-29": /重厚|厚く重い|\bmassive sound\b|\bheavy arrangement\b/i,
  "tag-30": /ゆったり|ゆっくりしたテンポ|\bslow tempo\b|\bleisurely tempo\b/i,
  "tag-31": /中程度.{0,8}テンポ|ミドルテンポ|\bmid(?:dle)?[- ]tempo\b|\bmoderate tempo\b/i,
  "tag-32": /速いテンポ|アップテンポ|\bfast tempo\b|\bup[- ]tempo\b|\bhigh[- ]tempo\b/i,
  "tag-33": /人の歌声|人間(?:の)?歌唱|human vocals?/i,
  "tag-34": /合成音声.{0,16}歌唱|合成歌声|ボーカロイド|vocaloid|synthetic vocals?/i,
  "tag-35": /複数(?:人|名)?(?:の)?ボーカル|複数(?:人|名)?(?:が)?歌唱|デュエット|duet|multiple vocals?/i,
  "tag-36": /コーラス.{0,12}(?:中心|主役)|合唱.{0,12}(?:中心|主役)|choir.{0,12}(?:center|focus)|chorus.{0,12}(?:center|focus)/i,
  "tag-37": /インスト(?:ゥルメンタル)?|instrumental(?: track| song)?|器楽曲/i,
  "tag-38": /透明感|澄んだ|透き通|\bclear and transparent\b|\btransparent vocals?\b/i,
  "tag-39": /柔らか|優しい歌声|\bsoft vocals?\b|\bgentle vocals?\b|\btender voice\b/i,
  "tag-40": /力強い歌声|力のある歌声|\bpowerful vocals?\b|\bstrong singing voice\b/i,
  "tag-41": /ささや(?:く|き)|\bwhisper(?:ing)? vocals?\b|\bwhispery voice\b/i,
  "tag-42": /ハスキー|かすれた歌声|\bhusky vocals?\b|\braspy voice\b/i,
  "tag-43": /歌詞.{0,240}(?:恋愛|愛情|恋心)|(?:恋愛|愛情|恋心).{0,240}歌詞|\blyrics?.{0,240}(?:love|romance|relationship)/i,
  "tag-44": /歌詞.{0,240}(?:別れ|失恋)|(?:別れ|失恋).{0,240}歌詞|\blyrics?.{0,240}(?:farewell|breakup|parting)/i,
  "tag-45": /歌詞.{0,240}(?:孤独|ひとり)|(?:孤独|ひとり).{0,240}歌詞|\blyrics?.{0,240}(?:loneliness|alone)/i,
  "tag-46": /歌詞.{0,240}(?:応援|励ま|背中を押)|(?:応援|励ま).{0,240}歌詞|\blyrics?.{0,240}(?:encourag|support|cheer)/i,
  "tag-47": /歌詞.{0,240}(?:希望|光を見つけ|未来を信じ)|(?:希望|光を見つけ|未来を信じ).{0,240}歌詞|\blyrics?.{0,240}(?:hope|look toward a better future|new possibilities)|(?:hope|a better future|new possibilities).{0,240}\blyrics?/i,
  "tag-48": /歌詞.{0,240}(?:日常|毎日)|(?:日常|毎日).{0,240}歌詞|\blyrics?.{0,240}everyday life/i,
  "tag-49": /歌詞.{0,240}(?:自己探求|自分探し)|(?:自己探求|自分探し).{0,240}歌詞|\blyrics?.{0,240}self[- ]?discovery/i,
  "tag-50": /歌詞.{0,240}(?:社会|世界(?!観))|(?:社会|世界(?!観)).{0,240}歌詞|\blyrics?.{0,240}(?:society|the world)\b/i,
};
function trustedSeedProfile(tag: {
  id: string;
  name: string;
  category?: string;
  criterion?: string;
}) {
  const number = Number(tag.id.match(/^tag-(\d+)$/)?.[1]);
  const criterion = tag.criterion ?? "";
  const profile = seedTagSignals[tag.id];
  const generic =
    criterion ===
    `Webの説明・公式情報で「${tag.name}」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。`;
  const peopleSinging =
    tag.id === "tag-33" &&
    /人(?:の|または)|人間|human|people/i.test(criterion) &&
    /歌唱|歌声|ボーカル|vocal|voice/i.test(criterion) &&
    !/合成|synthetic|vocaloid/i.test(criterion);
  const dancePop =
    tag.id === "tag-08" &&
    /ポップ|pop/i.test(criterion) &&
    /ダンス|踊れる|dance/i.test(criterion);
  const denied =
    /ではなく|ではない|とは言えない|使わない|含まない|該当しない|\bnot\b|\bwithout\b|\brather than\b|\binstead of\b/i.test(
      criterion,
    );
  return seedTagCategories(tag.id) === tag.category &&
    seedTagNames[number] === tag.name &&
    !denied &&
    (profile?.test(criterion) || generic || peopleSinging || dancePop)
    ? profile
    : undefined;
}
const stopCriterionTerms = new Set(
  "音楽 楽曲 曲 曲調 演奏 説明 記述 明示 特徴 具体 説明される 基準 公式 Web の と が を に は する 主体 中心 特徴 人 または による という 的な 歌声 歌唱 音 説明を 音楽的 音楽性 使う 場合".split(
    /\s+/,
  ),
);
function criterionTerms(criterion: string | undefined) {
  const terms =
    (criterion ?? "").match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}|[A-Za-z][A-Za-z&'-]{2,}/gu,
    ) ?? [];
  return terms
    .flatMap((term) => [
      term,
      ...term.split(/(?:や|と|を|に|が|は|の|で|も|へ|から|する|される|という|または|および)/),
    ])
    .filter(
      (term, index, all) =>
        term.length > 1 &&
        !stopCriterionTerms.has(term) &&
        all.indexOf(term) === index,
    );
}
function tagEvidenceNegated(text: string, signal: RegExp) {
  const match = signal.exec(text);
  if (!match) return false;
  const before = text.slice(Math.max(0, match.index - 32), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 48);
  const context = `${before} ${after}`.replace(/\bnot only\b/gi, "");
  return /ではなく|ではない|とは言えない|(?:を|とは)描かず|描かない|表現していない|取り上げない|使わない|含まない|該当しない|\bnot\b|\bno\b|\bwithout\b|\brather than\b|\binstead of\b/i.test(
    context,
  );
}
function hasSongPropertyContext(text: string, signal: RegExp) {
  const matches = new RegExp(signal.source, `${signal.flags.replace(/[gy]/g, "")}g`);
  const scenery =
    /会場|ライブ|舞台|照明|ライティング|ライト|天気|天候|春風|風|気温|気候|景色|観客|客席|フェス|\bvenue\b|\bstage\b|\blighting\b|\blights\b|\bweather\b|\bcrowd\b|\baudience\b|\bfestival\b|\boutside\b|\bbreeze\b/i;
  const musicObject =
    /曲調|サウンド|音楽|メロディ|楽曲|音色|響き|トラック|歌声|\bsong\b|\bmusic\b|\bmelody\b|\bsound\b|\barrangement\b|\btrack\b|\btone\b|\bgroove\b|\bdrum machine\b|\bdrums?\b|\bpercussion\b/i;
  const broadMusicObject =
    /演奏|パフォーマンス|リズム|ビート|テンポ|\bperformance\b|\brhythm\b|\bbeat\b|\btempo\b/i;
  for (const match of text.matchAll(matches)) {
    const start = Math.max(0, match.index! - 28);
    const end = Math.min(text.length, match.index! + match[0].length + 40);
    const nearby = text.slice(start, end);
    if (scenery.test(nearby)) {
      if (musicObject.test(nearby)) return true;
      continue;
    }
    if (musicObject.test(nearby) || broadMusicObject.test(nearby)) return true;
  }
  return false;
}
function quoteParagraphContext(content: string, quote: string) {
  const paragraph = content
    .split(/\r?\n\s*\r?\n/)
    .find((candidate) => norm(candidate).includes(norm(quote)));
  return paragraph ?? quote;
}

function balancedEvidenceWindow(
  source: Evidence,
  query: { title: string; artist_hint?: string | null },
  maxLength: number,
) {
  const limit = Math.min(1000, Math.max(128, Math.trunc(maxLength)));
  const paragraphs = cleanRecordingText(source.content);
  const identity = paragraphs.find((paragraph) =>
    norm(paragraph).includes(norm(query.title)),
  );
  const boundaries = paragraphs.flatMap((paragraph, index) => {
    if (!fieldHeader.test(paragraph) && !descriptionHeader.test(paragraph))
      return [];
    return [paragraph, ...(paragraphs[index + 1] ? [paragraphs[index + 1]] : [])];
  });
  const boundaryIndexes = new Set<number>();
  paragraphs.forEach((paragraph, index) => {
    if (!fieldHeader.test(paragraph) && !descriptionHeader.test(paragraph))
      return;
    boundaryIndexes.add(index);
    if (paragraphs[index + 1]) boundaryIndexes.add(index + 1);
  });
  const credits = paragraphs.filter(
    (paragraph, index) =>
      hasCreditAttribution(paragraph) && !boundaryIndexes.has(index),
  );
  const sentences = paragraphs.flatMap((paragraph) =>
    paragraph.split(/(?<=[。！？.!?])\s+/).map((sentence) => sentence.trim()),
  );
  const matches = descriptorSearchGroups.map((group) =>
    sentences.filter((sentence) => group.cues.test(sentence)),
  );
  const representatives: string[] = [];
  for (const group of matches) {
    const sentence = group.find((candidate) => !representatives.includes(candidate));
    if (sentence) representatives.push(sentence);
  }
  const remainder = matches.flatMap((group) =>
    group.filter((sentence) => !representatives.includes(sentence)),
  );
  const unrepresentedDescriptors = [...representatives, ...remainder].filter(
    (line, index, all) =>
      !boundaries.includes(line) &&
      !credits.includes(line) &&
      all.indexOf(line) === index,
  );
  const candidates = [
    ...(identity && !boundaries.includes(identity) ? [identity] : []),
    ...boundaries,
    ...credits.filter((line, index, all) => all.indexOf(line) === index),
    ...unrepresentedDescriptors,
  ];
  const selected: string[] = [];
  let size = 0;
  for (const line of candidates) {
    const next = size + line.length + (selected.length ? 2 : 0);
    if (next > limit) continue;
    selected.push(line);
    size = next;
  }
  return selected.length ? selected.join("\n\n") : recordingWindows(source.content, limit);
}

function identityCreditWindow(
  source: Evidence,
  query: { title: string; artist_hint?: string | null },
) {
  const paragraphs = cleanRecordingText(contentWithoutMetadata(source));
  const identity = paragraphs.find((paragraph) =>
    norm(paragraph).includes(norm(query.title)),
  );
  const fields = paragraphs.flatMap((paragraph, index) =>
    fieldHeader.test(paragraph) || descriptionHeader.test(paragraph)
      ? [paragraph, ...(paragraphs[index + 1] ? [paragraphs[index + 1]] : [])]
      : [],
  );
  const fieldIndexes = new Set<number>();
  paragraphs.forEach((paragraph, index) => {
    if (!fieldHeader.test(paragraph) && !descriptionHeader.test(paragraph))
      return;
    fieldIndexes.add(index);
    if (paragraphs[index + 1]) fieldIndexes.add(index + 1);
  });
  const credits = paragraphs.filter(
    (paragraph, index) =>
      hasCreditAttribution(paragraph) && !fieldIndexes.has(index),
  );
  const selected = [
    ...(identity && !fields.includes(identity) ? [identity] : []),
    ...fields,
    ...credits.filter((paragraph, index, all) => all.indexOf(paragraph) === index),
  ];
  return selected.length
    ? selected.join("\n\n")
    : recordingWindows(contentWithoutMetadata(source));
}

function tagSemanticDecision(
  tag: { id: string; name: string; category?: string; criterion?: string },
  quoteText: string,
  reasoning: string,
  factualVoice: boolean,
  contextText = quoteText,
) {
  const profile = trustedSeedProfile(tag);
  const quote = norm(quoteText);
  const nameMatch = norm(tag.name).length > 1 && quote.includes(norm(tag.name));
  const criterionMatch = criterionTerms(tag.criterion).some((term) =>
    quote.includes(norm(term)),
  );
  const categoryCue =
    tag.category === "ジャンル"
      ? descriptorSearchGroups[0].cues.test(contextText)
      : tag.category === "雰囲気" ||
          tag.category === "勢い" ||
          tag.category === "テンポ感"
        ? descriptorSearchGroups[1].cues.test(contextText)
        : tag.category === "歌声の構成" || tag.category === "歌声の印象"
          ? descriptorSearchGroups[2].cues.test(contextText)
        : tag.category === "歌詞テーマ"
            ? descriptorSearchGroups[3].cues.test(contextText)
            : /音作り|音色|音響|楽器|編曲|プロダクション|production|instrumentation/i.test(
                  `${tag.category ?? ""} ${tag.criterion ?? ""}`,
              ) &&
              /sound|music|instrument|electronic|acoustic|synth|音楽|サウンド|音色|音響|楽器|編曲|電子音|シンセ/i.test(
                contextText,
              );
  const needsVoiceNoun = tag.category === "歌声の印象";
  const voiceNoun =
    /歌声|歌唱|ボーカル|歌手|\bvocal(?:s)?\b|\bvoice\b|\bsinging\b/i.test(
      contextText,
    );
  const customSignal = new RegExp(
    [tag.name, ...criterionTerms(tag.criterion)]
      .filter(Boolean)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "i",
  );
  const moodOrEnergyContext =
    tag.category !== "雰囲気" && tag.category !== "勢い"
      ? true
      : hasSongPropertyContext(contextText, profile ?? customSignal);
  const matches = factualVoice
    ? true
    : profile
      ? profile.test(contextText) &&
        !tagEvidenceNegated(contextText, profile) &&
        (!needsVoiceNoun || voiceNoun) &&
        moodOrEnergyContext
      : (nameMatch || criterionMatch) &&
        categoryCue &&
        moodOrEnergyContext &&
        !tagEvidenceNegated(contextText, customSignal);
  const hedged =
    /\b(?:maybe|possibly|perhaps|might|could be|seems?)\b|かもしれ|可能性が|らしい|っぽい|推測/i.test(
      reasoning,
    );
  const explanationCue =
    tag.category === "ジャンル"
      ? /genre|style|music|sound|instrument|\bdance[ -]?pop\b|\bpop dance\b|音楽|ジャンル|サウンド|音色|演奏|ロック|ポップ|ジャズ|クラシック|フォーク|メタル/i
      : tag.category === "雰囲気"
        ? /mood|feeling|atmosphere|曲調|雰囲気|印象|感情/i
        : tag.category === "勢い"
          ? /energy|rhythm|beat|performance|演奏|勢い|リズム|ビート/i
          : tag.category === "テンポ感"
            ? /tempo|bpm|pace|テンポ|速度/i
            : tag.category === "歌声の構成" || tag.category === "歌声の印象"
              ? /voice|vocal|singing|tone|歌声|歌唱|ボーカル|声質/i
              : tag.category === "歌詞テーマ"
                ? /lyrics?|lyrical|theme|subject|narrative|words|歌詞|主題|内容|物語/i
                : /description|evidence|meaning|description|説明|根拠|特徴|内容/i;
  const meaningfulReason =
    reasoning.trim().length >= 24 &&
    /[\p{L}]/u.test(reasoning) &&
    explanationCue.test(reasoning);
  if (!matches || hedged || !meaningfulReason) return null;
  return {
    evidence_type: nameMatch ? ("direct" as const) : ("semantic_inference" as const),
  };
}

export function inferenceTagCandidates(
  tags: { id: string; name: string; category?: string; criterion?: string }[],
  evidence: Evidence[],
  recording?: string | null,
) {
  const usable = evidence.filter(
    (source) => !recording || linkedDescriptionRecording(source, recording),
  );
  const prose = usable.map((source) => independentText(source)).join("\n");
  const descriptive = usable.map(descriptiveLines).join("\n");
  const vocals = usable.some((source) =>
    independentText(source).split(/\r?\n/).some((line) =>
      creditClauses(line).some((claim) => claim.role === "vocalist"),
    ),
  );
  return tags.filter((tag) => {
    const profile = trustedSeedProfile(tag);
    const isUnchangedSeed = Boolean(profile);
    if (isUnchangedSeed && profile) {
      if (tag.id === "tag-33" && vocals) return true;
      return profile.test(descriptive) && !tagEvidenceNegated(descriptive, profile);
    }
    const normalizedText = norm(descriptive);
    return [tag.name, ...criterionTerms(tag.criterion)].some(
      (term) => norm(term).length > 1 && normalizedText.includes(norm(term)),
    );
  });
}

/** Identity is atomic; enrichment claims are individually reviewed and filtered. */
export function supportedAnalysis(
  raw: string,
  evidence: Evidence[],
  query: Parameters<typeof validateAnalysis>[2],
  tags: Parameters<typeof validateAnalysis>[3],
  allowSelectedNativeFallback = false,
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
        r.tags.length > 12,
    )
  )
    throw new ResearchError("UNSUPPORTED_EVIDENCE");
  // A model's empty answer must not hide recordings independently identified by
  // native metadata. Without a selected URL, require the artist hint in native
  // title/author fields; description mentions alone cannot establish identity.
  // Keep these as unclassified candidates: native metadata never proves roles,
  // original/cover relationships or sound tags (except the exact uploader).
  let selectedRecordingUrl: string | null = null;
  try {
    selectedRecordingUrl = query.reference_url
      ? catalogUrl(query.reference_url)
      : null;
  } catch {
    selectedRecordingUrl = null;
  }
  const nativeFallback =
    !parsed.recordings.length &&
    Boolean(
      query.artist_hint?.trim() ||
        (allowSelectedNativeFallback && selectedRecordingUrl),
    );
  if (nativeFallback) {
    const recovered: Recording[] = [];
    for (const s of evidence) {
      const m = s.metadata;
      if (
        !m ||
        m.provider !== "youtube_oembed" ||
        m.endpoint !== youtubeMetadataEndpoint(s.url) ||
        (allowSelectedNativeFallback &&
          selectedRecordingUrl &&
          s.url !== selectedRecordingUrl) ||
        !recordingTitleMatches(m.title, query.title) ||
        (query.artist_hint &&
          !norm(`${m.title} ${m.author_name}`).includes(norm(query.artist_hint)))
      )
        continue;
      const r: Recording = {
        title: m.title,
        reference_url: s.url,
        kind: "other",
        original: null,
        source_id: s.id,
        quote: m.title,
        credits:
          m.author_name.length >= 3
            ? [
                {
                  name: m.author_name,
                  kind: "channel",
                  role: "uploader",
                  source_id: s.id,
                  quote: m.author_name,
                  aliases: [],
                },
              ]
            : [],
        tags: [],
      };
      try {
        validateAnalysis(
          JSON.stringify({ recordings: [r] }),
          evidence,
          query,
          tags,
        );
        if (!recovered.some((x) => x.reference_url === r.reference_url))
          recovered.push(r);
      } catch {
        /* Retain only identities passing the ordinary evidence checks. */
      }
    }
    if (recovered.length > 0 && recovered.length <= 2)
      parsed.recordings = recovered;
  }
  const identity = validateAnalysis(
    JSON.stringify({
      recordings: parsed.recordings.map((r: any) => ({
        ...r,
        original: null,
        credits: [],
        tags: [],
      })),
    }),
    evidence,
    query,
    tags,
  );
  const warnings: string[] = nativeFallback
    ? ["NATIVE_IDENTITY_WITHOUT_AI_METADATA"]
    : [];
  const tagDecisions: NonNullable<Analysis["tag_decisions"]> = [];
  const test = (r: Recording) => {
    for (const claim of r.credits) {
      if (claim.role !== "vocalist" || claim.kind !== "synthetic_voice")
        continue;
      const source = evidence.find((item) => item.id === claim.source_id);
      if (
        !source ||
        (!explicitSyntheticVoiceAttribution(claim, source) &&
          !exactNativeFeaturedVirtualSinger(claim, source))
      )
        throw new ResearchError("UNSUPPORTED_EVIDENCE");
    }
    return validateAnalysis(
      JSON.stringify({ recordings: [r] }),
      evidence,
      query,
      tags,
    );
  };
  identity.recordings.forEach((r, index) => {
    const original = parsed.recordings[index];
    if (original.original) {
      try {
        const candidate = {
          ...r,
          original: structuredClone(original.original),
          credits: [],
          tags: [],
        };
        test(candidate);
        r.original = candidate.original;
      } catch {
        warnings.push(`recording:${index}:original:UNSUPPORTED_EVIDENCE`);
        if (r.kind !== "other") r.kind = "other";
      }
    }
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
        if (!Array.isArray(c.aliases) || c.aliases.length > 2)
          throw new ResearchError("UNSUPPORTED_EVIDENCE");
        for (const a of c.aliases) {
          try {
            validateAliasEvidence(c, a, r.reference_url, evidence);
            acceptedAliases.push(a);
          } catch {
            warnings.push(
              `recording:${index}:credit:${n}:alias:UNSUPPORTED_EVIDENCE`,
            );
          }
        }
        c.aliases = acceptedAliases;
        // Validate the complete role only after retaining independently supported
        // aliases, including the subset needed by an explicit bilingual caption.
        test({ ...r, credits: [c], tags: [] });
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
      } catch {
        warnings.push(`recording:${index}:tag:${n}:UNSUPPORTED_EVIDENCE`);
        tagDecisions.push({
          tag_id: String(t?.tag_id ?? ""),
          source_id: String(t?.source_id ?? ""),
          status: "rejected",
          reason_code: "UNSUPPORTED_EVIDENCE",
        });
        return;
      }
      const tag = tags.find((candidate) => candidate.id === t.tag_id)!;
      const tagSource = evidence.find((source) => source.id === t.source_id);
      const contextText = tagSource
        ? quoteParagraphContext(tagSource.content, t.quote)
        : t.quote;
      const voiceCredit = r.credits.find(
        (credit) =>
          norm(credit.quote) === norm(t.quote) &&
          credit.role === "vocalist" &&
          ((tag.name === "人の歌声" && ["person", "group"].includes(credit.kind)) ||
            (tag.name === "合成歌声" && credit.kind === "synthetic_voice")),
      );
      const semantic = tagSemanticDecision(
        tag,
        t.quote,
        t.reasoning ?? "",
        Boolean(voiceCredit),
        contextText,
      );
      if (!semantic) {
        warnings.push(`recording:${index}:tag:${n}:TAG_SEMANTIC_MISMATCH`);
        tagDecisions.push({
          tag_id: t.tag_id,
          source_id: t.source_id,
          status: "rejected",
          reason_code: "TAG_SEMANTIC_MISMATCH",
        });
        return;
      }
      r.tags.push({ ...t, evidence_type: semantic.evidence_type });
      tagDecisions.push({
        tag_id: t.tag_id,
        source_id: t.source_id,
        status: "accepted",
        evidence_type: semantic.evidence_type,
        reason_code: semantic.evidence_type.toUpperCase(),
      });
    });
  });
  return {
    ...identity,
    raw_model: raw,
    review_warnings: warnings.slice(0, 24),
    tag_decisions: tagDecisions.slice(0, 48),
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
      redirect: "manual",
    });
  } catch {
    throw new ResearchError("PROVIDER_UNAVAILABLE", true);
  }
  // Workers supports manual/follow only. Reject every redirect here so provider
  // credentials never reach a Location target and redirect bodies cannot be evidence.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ResearchError(`PROVIDER_HTTP_${response.status}`);
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
export function recordingWindows(raw: string, maxLength = 1000) {
  return buildRecordingWindows(raw, maxLength);
}

function buildRecordingWindows(raw: string, maxLength: number) {
  const limit = Math.min(1000, Math.max(128, Math.trunc(maxLength)));
  const paragraphs = cleanRecordingText(raw);
  const footer = paragraphs.findIndex((paragraph) =>
    /^\s*(?:transcript|文字起こし|lyrics transcript|members?\s*[:：]?|メンバー\s*[:：]?)\s*$/i.test(
      paragraph,
    ),
  );
  const usable = footer < 0 ? paragraphs : paragraphs.slice(0, footer);
  const descriptor =
    /vocal|song|music|genre|mood|tempo|synth|strings|guitar|drum|piano|jazz|rock|pop|electronic|hip.?hop|metal|folk|classical|ballad|dance|bright|dark|warm|gentle|calm|upbeat|melancholic|refreshing|energetic|soft|powerful|clear|transparent|whisper|husky|hope|theme|instrumental|lyrics?|bpm|acoustic|orchestral|j[- ]?pop|k[- ]?pop|作詞|作曲|歌唱|ボーカル|歌声|歌手|ジャンル|曲調|ポップ|ロック|ジャズ|クラシック|メタル|フォーク|エレクトロ|電子音|シンセ|ギター|ドラム|ピアノ|明る|切な|悲し|穏やか|安らぎ|暗い|幻想|懐かし|レトロ|コミカル|爽やか|清涼|温か|ぬくもり|緊張|しっとり|軽快|力強|激し|疾走|ダンサブル|重厚|ゆったり|テンポ|アップテンポ|ミドルテンポ|スローテンポ|透明感|澄ん|透き通|柔らか|ささや|ハスキー|かすれ|合成音声|コーラス|合唱|インスト|歌詞|恋愛|別れ|孤独|応援|希望|日常|自己探求|社会|世界|配信|リリース|発売|新曲|シングル|https:\/\//i;
  const candidate = (paragraph: string) =>
    !/\[\d{1,2}:\d{2}\]|文字起こし|lyrics transcript/i.test(paragraph) &&
    !/^\s*(?:instrumental|inst\.?|off vocal|オフボーカル|カラオケ)\s*(?:download|https?:|音源)/i.test(
      paragraph,
    ) &&
    (descriptor.test(paragraph) ||
      fieldHeader.test(paragraph) ||
      descriptionHeader.test(paragraph) ||
      creditGroups.some((group) => new RegExp(group.pattern, "i").test(paragraph)));
  const selected: string[] = [];
  for (let i = 0; i < usable.length; i++) {
    const fieldValue =
      i > 0 &&
      (fieldHeader.test(usable[i - 1]) || descriptionHeader.test(usable[i - 1]));
    if (!candidate(usable[i]) && !fieldValue) continue;
    if (i > 0 && (fieldHeader.test(usable[i - 1]) || descriptionHeader.test(usable[i - 1])))
      selected.push(usable[i - 1]);
    selected.push(usable[i]);
  }
  if (usable[0]?.length <= 240 && !selected.includes(usable[0]))
    selected.unshift(usable[0]);

  const textLimit = Math.max(64, limit - 150);
  const blocks = selected.flatMap((paragraph) => {
    if (paragraph.length <= textLimit) return [paragraph];
    return paragraph
      .split(/(?<=[。！？])\s*|(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length <= textLimit);
  });
  let result = "";
  // Remove adjacent repeats only. Identical lines separated by a field header
  // can have different roles, such as a channel value and a Description credit.
  for (const block of blocks.filter(
    (item, index, all) => index === 0 || all[index - 1] !== item,
  )) {
    const next = result ? `${result}\n\n${block}` : block;
    if (next.length <= textLimit) result = next;
  }
  if (!result) result = blocks.find((block) => block.length <= textLimit) ?? "";

  for (const link of observedUrls(usable.join("\n")).slice(0, 4)) {
    let relevant = false;
    try {
      const parsed = new URL(link);
      relevant =
        Boolean(youtubeMetadataEndpoint(catalogUrl(link) ?? "")) ||
        parsed.hostname.toLowerCase().endsWith(".lnk.to") ||
        (parsed.hostname === "open.spotify.com" && /\/track\//.test(parsed.pathname)) ||
        (parsed.hostname === "music.apple.com" && /\/song\//.test(parsed.pathname)) ||
        (parsed.hostname === "ototoy.jp" && /\/_\/default\/p\/\d+/.test(parsed.pathname));
    } catch {
      relevant = false;
    }
    if (!relevant || result.includes(link)) continue;
    const next = result ? `${result}\n${link}` : link;
    if (next.length <= limit) result = next;
  }
  return result;
}
