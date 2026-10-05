from __future__ import annotations

import os
from pathlib import Path

PHASE = "red-task2"
TEST_COMMAND = (
    'npx vitest run worker/tests/research-tagging.test.ts '
    '-t "evidence-supported category|categories without evidence|response tag enum|expanded category candidates|supplied genre tag"'
)


def append_once(path: Path, marker: str, addition: str) -> None:
    text = path.read_text(encoding="utf-8")
    if marker not in text:
        path.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n", encoding="utf-8")


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


test_path = Path("worker/tests/research-tagging.test.ts")
tests = test_path.read_text(encoding="utf-8")
start_marker = 'it("finds only explicit synthpop and synthpop dance song tags in genre evidence"'
end_marker = '\n\nit("rejects an exact-song association marker that was not derived from retained source text"'
if start_marker in tests:
    start = tests.index(start_marker)
    end = tests.index(end_marker, start)
    replacement = r'''it("exposes every supplied genre tag when genre evidence is supported", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const definitions = [
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion:
        "Webの説明・公式情報で「エレクトロ」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。",
    },
    {
      id: "tag-08",
      name: "ダンスポップ",
      category: "ジャンル",
      criterion:
        "Webの説明・公式情報で「ダンスポップ」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。",
    },
    {
      id: "tag-03",
      name: "ロック",
      category: "ジャンル",
      criterion: "ギターやドラム主体のロック演奏。",
    },
  ];
  const explicitDance = {
    id: "s1",
    url: "https://example.com/scatman",
    title: "Scatman composition",
    content:
      '\"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)\" is a novelty synthpop dance song driven by a techno groove.',
  };
  const eurodanceOnly = {
    ...explicitDance,
    content: '\"Scatman\" is an Eurodance song.',
  };

  expect(
    inferenceTagCandidates(definitions, [explicitDance], "https://example.com/scatman").map((tag) => tag.id),
  ).toEqual(["tag-07", "tag-08", "tag-03"]);
  expect(
    inferenceTagCandidates(definitions, [eurodanceOnly], "https://example.com/scatman").map((tag) => tag.id),
  ).toEqual([]);
});'''
    tests = tests[:start] + replacement + tests[end:]
    test_path.write_text(tests, encoding="utf-8")

append_once(
    test_path,
    'it("expands candidates to every active tag in an evidence-supported category"',
    r'''
it("expands candidates to every active tag in an evidence-supported category", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const definitions = [
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
  ];
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼 tempo description",
    content: "The track is extremely-fast, with pitter-pattering drums.",
  };

  expect(
    inferenceTagCandidates(definitions, [source], recordingUrl).map((tag) => tag.id),
  ).toEqual(["tag-30", "tag-31", "tag-32"]);
});

it("does not include tags from categories without evidence", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const definitions = [
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
  ];
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼 tempo description",
    content: "The track is extremely-fast, with pitter-pattering drums.",
  };

  expect(
    inferenceTagCandidates(definitions, [source], recordingUrl).map((tag) => tag.id),
  ).not.toContain("tag-13");
});

it("keeps the response tag enum limited to evidence-supported categories", async () => {
  const { fitInferenceRequest, knownIdentitySchema } = await import(
    "../src/research/providers"
  );
  const definitions = [
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
  ];
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼 tempo description",
    content: "蜃気楼 is extremely-fast, with pitter-pattering drums.",
  };
  const body: any = {
    max_completion_tokens: 200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "song_evidence",
        strict: true,
        schema: knownIdentitySchema([source], query),
      },
    },
    messages: [
      { role: "system", content: "Use supplied evidence only." },
      {
        role: "user",
        content: JSON.stringify({ query, sources: [source], tags: definitions }),
      },
    ],
  };

  const fitted = fitInferenceRequest(body, [source]);
  const input = JSON.parse(fitted.body.messages[1].content);
  const tagSchema =
    fitted.body.response_format.json_schema.schema.properties.recordings.items
      .properties.tags;

  expect(input.tags.map((tag: any) => tag.id)).toEqual(["tag-30", "tag-31", "tag-32"]);
  expect(tagSchema.items.properties.tag_id.enum).toEqual(["tag-30", "tag-31", "tag-32"]);
  expect(tagSchema.maxItems).toBe(12);
  expect(fitted.evidence[0].content).toContain("extremely-fast");
});

it("fits expanded category candidates without dropping the supporting Scatman quote", async () => {
  const { fitInferenceRequest, knownIdentitySchema } = await import(
    "../src/research/providers"
  );
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const scatmanQuery = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const quote =
    'This is driven by the "hellacious" techno groove of its extremely-fast, pitter-pattering chintzy drum machine.';
  const source = {
    id: "s0",
    url: scatmanUrl,
    title: "Scatman",
    content: `Scatman by Scatman John.\n\n${quote}`,
  };
  const definitions = [
    { id: "tag-24", name: "軽快", category: "勢い", criterion: "軽やかで弾むリズム。" },
    { id: "tag-28", name: "ダンサブル", category: "勢い", criterion: "ダンサブルなビートやグルーヴを感じる演奏。" },
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
  ];
  const body: any = {
    max_completion_tokens: 200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "song_evidence",
        strict: true,
        schema: knownIdentitySchema([source], scatmanQuery),
      },
    },
    messages: [
      { role: "system", content: "Use supplied evidence only." },
      {
        role: "user",
        content: JSON.stringify({ query: scatmanQuery, sources: [source], tags: definitions }),
      },
    ],
  };

  const fitted = fitInferenceRequest(body, [source]);
  const input = JSON.parse(fitted.body.messages[1].content);
  expect(input.tags.map((tag: any) => tag.id)).toEqual([
    "tag-24",
    "tag-28",
    "tag-30",
    "tag-31",
    "tag-32",
  ]);
  expect(fitted.evidence[0].content).toContain(quote);
});
''',
)

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
print(f"semantic-tag TDD phase: {PHASE}")
