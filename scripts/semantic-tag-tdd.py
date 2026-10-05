from __future__ import annotations

import os
from pathlib import Path

PHASE = "red-task3"
TEST_COMMAND = (
    'npx vitest run worker/tests/research-tagging.test.ts '
    '-t "extremely-fast as semantic|jaunty rhythmic|seed-profile wording|hedged or unanchored|negated speed|mood from lyric-theme|bare vocalist credit"'
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
    'it("accepts extremely-fast as semantic evidence for 速い"',
    r'''
it("accepts extremely-fast as semantic evidence for 速い", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The track runs at an extremely-fast pace with pitter-pattering drums.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning:
            "The extremely-fast pace directly entails the selected 速い tempo criterion for this track.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-32", evidence_type: "semantic_inference" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("accepts jaunty rhythmic evidence for 軽快 without a seed-regex match", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The song moves with a jaunty, springing rhythm throughout the performance.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-24",
    name: "軽快",
    category: "勢い",
    criterion: "軽やかで弾むリズム。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning:
            "The jaunty springing rhythm entails the 軽快 tag by describing a light, lively rhythmic performance.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-24", evidence_type: "semantic_inference" },
  ]);
});

it("marks explicit seed-profile wording as direct evidence", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The song has a fast tempo throughout the arrangement.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning: "The explicit fast tempo wording directly satisfies the selected 速い tempo criterion.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-32", evidence_type: "direct" },
  ]);
});

it("rejects hedged or unanchored semantic reasoning", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The track runs at an extremely-fast pace with pitter-pattering drums.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const recording = (reasoning: string) => ({
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "original",
    source_id: "s0",
    quote: "tayori - 蜃気楼 (Official Video)",
    credits: [],
    tags: [{ tag_id: tag.id, source_id: "s0", quote, reasoning }],
  });
  const hedged = supportedAnalysis(
    JSON.stringify({
      recordings: [recording("The pace maybe indicates the selected 速い tempo tag, but the evidence is uncertain.")],
    }),
    [source],
    query,
    [tag],
  );
  const unanchored = supportedAnalysis(
    JSON.stringify({
      recordings: [recording("The exact quote gives a concrete tempo description for the recording and its performance.")],
    }),
    [source],
    query,
    [tag],
  );

  expect(hedged.recordings[0].tags).toEqual([]);
  expect(unanchored.recordings[0].tags).toEqual([]);
});

it("rejects negated speed evidence", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The track is not fast in pace despite the frantic visual editing.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning: "The sentence discusses speed, but its negated wording cannot establish the 速い tempo tag.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});

it("does not infer mood from lyric-theme evidence", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The lyrics describe a bright future and cheerful hope after hardship.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-13",
    name: "明るい",
    category: "雰囲気",
    criterion: "明るく前向きな曲調。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning: "The bright lyrical idea would otherwise appear related to the 明るい mood tag.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});

it("does not infer voice impression from a bare vocalist credit", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const tag = {
    id: "tag-38",
    name: "透明感",
    category: "歌声の印象",
    criterion: "澄んだ透明な歌声の具体的な記述。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [{
          name: "isui",
          kind: "person",
          role: "vocalist",
          source_id: "s0",
          quote: "Vocal: isui",
          aliases: [],
        }],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote: "Vocal: isui",
          reasoning: "The vocalist credit alone should not establish the 透明感 voice-impression tag.",
        }],
      }],
    }),
    [primarySource],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});
''',
)

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
print(f"semantic-tag TDD phase: {PHASE}")
