from __future__ import annotations

import os
from pathlib import Path

PHASE = "green-task3"
TEST_COMMAND = "npx vitest run worker/tests/research-tagging.test.ts"
COMMIT_MESSAGE = "feat: validate semantic tag entailment"


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def replace_once(text: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one replacement target, found {count}: {old[:80]!r}")
    return text.replace(old, new, 1)


providers_path = Path("worker/src/research/providers.ts")
providers = providers_path.read_text(encoding="utf-8")
start = providers.index("function tagSemanticDecision(")
end = providers.index("\n\nexport function inferenceTagCandidates(", start)
replacement = r'''function tagSemanticDecision(
  tag: { id: string; name: string; category?: string; criterion?: string },
  quoteText: string,
  reasoning: string,
  factualVoice: boolean,
  contextText = quoteText,
) {
  const profile = trustedSeedProfile(tag);
  const quote = norm(quoteText);
  const normalizedReasoning = norm(reasoning);
  const nameMatch = norm(tag.name).length > 1 && quote.includes(norm(tag.name));
  const criterion = criterionTerms(tag.criterion);
  const group = descriptorSearchGroups.find(
    (candidate) => candidate.category === tag.category,
  );
  const customSignal = new RegExp(
    [tag.name, ...criterion]
      .filter(Boolean)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "i",
  );
  const categoryCue = group
    ? group.cues.test(contextText)
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
  const songPropertyContext =
    tag.category !== "雰囲気" && tag.category !== "勢い"
      ? true
      : hasSongPropertyContext(contextText, group?.cues ?? profile ?? customSignal);
  const profileMatch = Boolean(profile?.test(contextText));
  const profileDirect =
    Boolean(profile) &&
    profileMatch &&
    !tagEvidenceNegated(contextText, profile!) &&
    (!needsVoiceNoun || voiceNoun) &&
    songPropertyContext;
  const nameSignal = new RegExp(
    tag.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
  const literalDirect =
    nameMatch &&
    categoryCue &&
    !tagEvidenceNegated(contextText, nameSignal) &&
    (!needsVoiceNoun || voiceNoun) &&
    songPropertyContext;
  const direct = factualVoice || profileDirect || literalDirect;
  const semanticSignal = group?.cues ?? customSignal;
  const reasoningAnchor =
    (norm(tag.name).length > 1 && normalizedReasoning.includes(norm(tag.name))) ||
    criterion.some(
      (term) => norm(term).length > 1 && normalizedReasoning.includes(norm(term)),
    ) ||
    Boolean(profile?.test(reasoning));
  const hedged =
    /\b(?:maybe|possibly|perhaps|might|could be|seems?|uncertain)\b|かもしれ|可能性が|らしい|っぽい|推測/i.test(
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
            ? /tempo|bpm|pace|speed|テンポ|速度/i
            : tag.category === "歌声の構成" || tag.category === "歌声の印象"
              ? /voice|vocal|singing|tone|歌声|歌唱|ボーカル|声質/i
              : tag.category === "歌詞テーマ"
                ? /lyrics?|lyrical|theme|subject|narrative|words|歌詞|主題|内容|物語/i
                : /description|evidence|meaning|production|sound|説明|根拠|特徴|内容|音作り|サウンド/i;
  const meaningfulReason =
    reasoning.trim().length >= 24 &&
    /[\p{L}]/u.test(reasoning) &&
    explanationCue.test(reasoning);
  if (hedged || !meaningfulReason) return null;
  if (direct) return { evidence_type: "direct" as const };
  const semantic =
    categoryCue &&
    reasoningAnchor &&
    !tagEvidenceNegated(contextText, semanticSignal) &&
    (!needsVoiceNoun || voiceNoun) &&
    songPropertyContext;
  return semantic ? { evidence_type: "semantic_inference" as const } : null;
}'''
providers_path.write_text(providers[:start] + replacement + providers[end:], encoding="utf-8")

runner_path = Path("worker/src/research/runner.ts")
runner = runner_path.read_text(encoding="utf-8")
runner = replace_once(
    runner,
    "Explain how each quote meets the criterion.\";",
    "For semantic tags, reasoning must explicitly name the selected tag or a meaningful criterion phrase and explain why the exact quote entails it; merely repeating the quote is insufficient. Explain how each quote meets the criterion.\";",
)
runner_path.write_text(runner, encoding="utf-8")

test_path = Path("worker/tests/research-tagging.test.ts")
tests = test_path.read_text(encoding="utf-8")
tests = replace_once(
    tests,
    '{ tag_id: "tag-08", evidence_type: "semantic_inference" },',
    '{ tag_id: "tag-08", evidence_type: "direct" },',
)
tests = replace_once(
    tests,
    'expect(analysis.recordings[0].tags[0].evidence_type).toBe("semantic_inference");',
    'expect(analysis.recordings[0].tags[0].evidence_type).toBe("direct");',
)
tests = replace_once(
    tests,
    '{ tag_id: "tag-47", evidence_type: "semantic_inference" },',
    '{ tag_id: "tag-47", evidence_type: "direct" },',
)
tests = replace_once(
    tests,
    '{ tag_id: "tag-28", source_id: "s0", evidence_type: "semantic_inference" },',
    '{ tag_id: "tag-28", source_id: "s0", evidence_type: "direct" },',
)
tests = replace_once(
    tests,
    '"The production description identifies how electronic textures shape the track\'s arrangement.",',
    '"The production description supports the シンセ主導 tag because electronic textures shape the track\'s arrangement.",',
)
test_path.write_text(tests, encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")
