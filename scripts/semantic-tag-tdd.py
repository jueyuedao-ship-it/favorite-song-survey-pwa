from __future__ import annotations

import os
from pathlib import Path

PHASE = "red-task4"
TEST_COMMAND = (
    'npx vitest run worker/tests/research-tagging.test.ts '
    '-t "locks Scatman semantic recall across candidate fitting and validation|Scatman|scatman|danceability|extremely-fast"'
)


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def append_once(path: Path, marker: str, addition: str) -> None:
    text = path.read_text(encoding="utf-8")
    if marker not in text:
        path.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n", encoding="utf-8")


test_path = Path("worker/tests/research-tagging.test.ts")
append_once(
    test_path,
    'it("locks Scatman semantic recall across candidate fitting and validation"',
    r'''
it("locks Scatman semantic recall across candidate fitting and validation", async () => {
  const {
    associateOfficialReleaseEvidence,
    fitInferenceRequest,
    inferenceTagCandidates,
    knownIdentitySchema,
    linkedDescriptionRecording,
    supportedAnalysis,
  } = await import("../src/research/providers");
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const scatmanQuery = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const primary = {
    id: "s0",
    url: scatmanUrl,
    title: metadata.title,
    metadata,
    content: JSON.stringify(metadata),
  };
  const genreMoodQuote =
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a novelty synthpop dance song with a quirky Euro-NRG tone.';
  const voiceLyricsQuote =
    'As critics summarized, the lyrics contain portions of spoken word, rapping, and a "jaunty ragga" style of scatting, where Scatman John "bends his tongue to rapid, ear-popping effect".';
  const tempoQuote =
    'This is driven by the "hellacious" techno groove of its extremely-fast, pitter-pattering chintzy drum machine.';
  const composition = `${genreMoodQuote} ${voiceLyricsQuote} ${tempoQuote}`;
  const articleUrl =
    "https://en.wikipedia.org/wiki/Scatman_(Ski-Ba-Bop-Ba-Dop-Bop)";
  const rawArticle = [
    "## Composition",
    composition,
    "## Artist biography",
    "Scatman John released many songs and his artist bio describes an upbeat career.",
    "## Related tracks",
    '"Scatman\'s World" is a slow acoustic ballad unrelated to this recording.',
  ].join("\n\n");
  const article = {
    id: "s3",
    url: articleUrl,
    title: "Scatman (Ski-Ba-Bop-Ba-Dop-Bop) - Wikipedia",
    content: rawArticle,
  };
  const associated = associateOfficialReleaseEvidence(
    [primary, article],
    scatmanQuery,
    { [articleUrl]: rawArticle },
  );
  const bound = associated[1];
  expect(linkedDescriptionRecording(bound, scatmanUrl)).toBe(true);
  expect(bound.recording_associations?.[0]).toMatchObject({
    provenance: "worker_verified_song_v1",
    reference_url: scatmanUrl,
  });
  expect(bound.recording_associations?.[0].description_quote).not.toContain(
    "Scatman's World",
  );

  const definitions = [
    { id: "tag-07", name: "エレクトロ", category: "ジャンル", criterion: "電子音やシンセ主体のサウンド。" },
    { id: "tag-08", name: "ダンスポップ", category: "ジャンル", criterion: "踊れるビートとポップなメロディの融合。" },
    { id: "tag-03", name: "ロック", category: "ジャンル", criterion: "ギターやドラム主体のロック演奏。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
    { id: "tag-19", name: "コミカル", category: "雰囲気", criterion: "コミカルでユーモアのある曲調。" },
    { id: "tag-24", name: "軽快", category: "勢い", criterion: "軽やかで弾むリズム。" },
    { id: "tag-27", name: "疾走感", category: "勢い", criterion: "疾走感のある演奏。" },
    { id: "tag-28", name: "ダンサブル", category: "勢い", criterion: "ダンサブルなビートやグルーヴを感じる演奏。" },
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-40", name: "力強い歌声", category: "歌声の印象", criterion: "力強さのある歌声。" },
    { id: "tag-47", name: "希望", category: "歌詞テーマ", criterion: "歌詞が希望を主題とするという解説。" },
  ];
  const candidateIds = inferenceTagCandidates(
    definitions,
    associated,
    scatmanUrl,
  ).map((tag) => tag.id);
  expect(candidateIds).toEqual([
    "tag-07",
    "tag-08",
    "tag-03",
    "tag-13",
    "tag-19",
    "tag-24",
    "tag-27",
    "tag-28",
    "tag-30",
    "tag-31",
    "tag-32",
  ]);
  expect(candidateIds).not.toContain("tag-40");
  expect(candidateIds).not.toContain("tag-47");

  const body: any = {
    max_completion_tokens: 800,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "scatman_semantic_regression",
        strict: true,
        schema: knownIdentitySchema(associated, scatmanQuery),
      },
    },
    messages: [
      { role: "system", content: "Use supplied evidence only." },
      {
        role: "user",
        content: JSON.stringify({
          query: scatmanQuery,
          sources: associated,
          tags: definitions,
        }),
      },
    ],
  };
  const fitted = fitInferenceRequest(body, associated);
  const input = JSON.parse(fitted.body.messages[1].content);
  const tagSchema =
    fitted.body.response_format.json_schema.schema.properties.recordings.items
      .properties.tags;
  expect(input.tags.map((tag: any) => tag.id)).toEqual(candidateIds);
  expect(tagSchema.items.properties.tag_id.enum).toEqual(candidateIds);
  expect(tagSchema.maxItems).toBe(12);
  const fittedArticle = fitted.evidence.find((source) => source.id === "s3")!;
  expect(fittedArticle.content).toContain("novelty synthpop dance song");
  expect(fittedArticle.content).toContain("techno groove");
  expect(fittedArticle.content).toContain("extremely-fast");
  expect(fittedArticle.content).not.toContain("Scatman's World");

  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "Scatman",
        reference_url: scatmanUrl,
        kind: "other",
        source_id: "s0",
        quote: metadata.title,
        credits: [],
        tags: [
          {
            tag_id: "tag-32",
            source_id: "s3",
            quote: tempoQuote,
            reasoning:
              "The extremely-fast pace explicitly entails the selected 速い tempo criterion for this track.",
          },
          {
            tag_id: "tag-28",
            source_id: "s3",
            quote: tempoQuote,
            reasoning:
              "The techno groove is direct dance-rhythm evidence for the ダンサブル energy tag.",
          },
          {
            tag_id: "tag-40",
            source_id: "s3",
            quote: voiceLyricsQuote,
            reasoning:
              "The rapid scatting does not itself establish the 力強い歌声 voice-quality criterion.",
          },
          {
            tag_id: "tag-47",
            source_id: "s3",
            quote: voiceLyricsQuote,
            reasoning:
              "The passage mentions lyrics but gives no evidence that 希望 is their theme.",
          },
        ],
      }],
    }),
    fitted.evidence,
    scatmanQuery,
    definitions,
  );
  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-32", evidence_type: "semantic_inference" },
    { tag_id: "tag-28", evidence_type: "direct" },
  ]);
  expect(analysis.recordings[0].tags.map((tag) => tag.tag_id)).not.toContain(
    "tag-40",
  );
  expect(analysis.recordings[0].tags.map((tag) => tag.tag_id)).not.toContain(
    "tag-47",
  );
});
''',
)

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
print(f"semantic-tag TDD phase: {PHASE}")
