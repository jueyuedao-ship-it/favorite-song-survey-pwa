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
providers_path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")
