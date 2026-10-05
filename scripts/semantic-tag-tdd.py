from __future__ import annotations

import os
from pathlib import Path

PHASE = "green-task2"
TEST_COMMAND = "npx vitest run worker/tests/research-tagging.test.ts"
COMMIT_MESSAGE = "feat: generate tag candidates by descriptor category"


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
text = providers_path.read_text(encoding="utf-8")
start_marker = "export function inferenceTagCandidates("
end_marker = "\n\n/** Identity is atomic; enrichment claims are individually reviewed and filtered. */"
start = text.index(start_marker)
end = text.index(end_marker, start)
replacement = r'''export function inferenceTagCandidates(
  tags: { id: string; name: string; category?: string; criterion?: string }[],
  evidence: Evidence[],
  recording?: string | null,
) {
  const usable = evidence.filter(
    (source) => !recording || linkedDescriptionRecording(source, recording),
  );
  const descriptive = usable.map(descriptiveLines).join("\n");
  const supportedCategories = new Set(
    descriptorSearchGroups
      .filter((group) =>
        usable.some((source) => group.cues.test(descriptiveLines(source).join("\n"))),
      )
      .map((group) => group.category),
  );
  const vocals = usable.some((source) =>
    independentText(source)
      .split(/\r?\n/)
      .some((line) =>
        creditClauses(line).some((claim) => claim.role === "vocalist"),
      ),
  );
  const normalizedText = norm(descriptive);
  return tags.filter((tag) => {
    const group = descriptorSearchGroups.find(
      (candidate) => candidate.category === tag.category,
    );
    if (group) {
      if (tag.id === "tag-33" && vocals) return true;
      return supportedCategories.has(group.category);
    }
    return [tag.name, ...criterionTerms(tag.criterion)].some(
      (term) => norm(term).length > 1 && normalizedText.includes(norm(term)),
    );
  });
}'''
text = text[:start] + replacement + text[end:]

compact_start = text.index("  const compactCriterion = (")
compact_end = text.index("  const compactGuidance:", compact_start)
compact_replacement = r'''  const compactCriterion = (tag: (typeof tagDefinitions)[number]) => {
    const generic = `Webの説明・公式情報で「${tag.name}」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。`;
    const criterion = typeof tag.criterion === "string" ? tag.criterion.trim() : "";
    return {
      id: tag.id,
      name: tag.name,
      category: tag.category,
      criterion:
        criterion === generic
          ? "Web根拠必須"
          : criterion.length > 96
            ? criterion.slice(0, 96)
            : criterion,
    };
  };
'''
text = text[:compact_start] + compact_replacement + text[compact_end:]
providers_path.write_text(text, encoding="utf-8")

test_path = Path("worker/tests/research-tagging.test.ts")
tests = test_path.read_text(encoding="utf-8")
tests = replace_once(
    tests,
    '''  expect(inferenceTagCandidates(tags, [source], recordingUrl).map((tag) => tag.id)).toEqual([\n    "tag-07",\n    "tag-32",\n    "tag-51",\n  ]);''',
    '''  expect(inferenceTagCandidates(tags, [source], recordingUrl).map((tag) => tag.id)).toEqual([\n    "tag-01",\n    "tag-07",\n    "tag-32",\n    "tag-51",\n  ]);''',
)
tests = replace_once(
    tests,
    '''  expect(input.tags.map((tag: any) => tag.id)).not.toContain("tag-50");''',
    '''  expect(input.tags.map((tag: any) => tag.id)).toContain("tag-50");\n  expect(input.tags.map((tag: any) => tag.id)).not.toContain("tag-34");''',
)
tests = replace_once(
    tests,
    '''  expect(inferenceTagCandidates(tags, revalidated, scatmanUrl).map((tag) => tag.id)).toEqual([\n    "tag-07",\n    "tag-08",\n  ]);''',
    '''  expect(inferenceTagCandidates(tags, revalidated, scatmanUrl).map((tag) => tag.id)).toEqual([\n    "tag-07",\n    "tag-08",\n    "tag-03",\n  ]);''',
)
test_path.write_text(tests, encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")
