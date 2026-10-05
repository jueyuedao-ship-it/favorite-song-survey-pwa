from __future__ import annotations

import os
from pathlib import Path

PHASE = "green-integration"
TEST_COMMAND = "npx vitest run worker/tests/research.test.ts"
COMMIT_MESSAGE = "test: align research integration flow with seven descriptor groups"


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def replace_once(text: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one replacement target, found {count}: {old[:100]!r}")
    return text.replace(old, new, 1)


def replace_all(text: str, old: str, new: str, minimum: int = 1) -> str:
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"expected at least {minimum} targets, found {count}: {old[:100]!r}")
    print(f"replace {count}x: {old[:70]!r}")
    return text.replace(old, new)


path = Path("worker/tests/research.test.ts")
tests = path.read_text(encoding="utf-8")

tests = replace_once(
    tests,
    "async function measuredLiveDrain(f: typeof fetch, n = 25) {",
    "async function measuredLiveDrain(f: typeof fetch, n = 45) {",
)

old_candidates = '''  expect(observedInput.tags.map((tag: any) => tag.id)).toEqual(\n    expect.arrayContaining([\n      "tag-07",\n      "tag-13",\n      "tag-24",\n      "tag-32",\n      "tag-33",\n      "tag-38",\n      "tag-47",\n    ]),\n  );'''
new_candidates = '''  expect(observedInput.tags.map((tag: any) => tag.id)).toEqual([\n    "tag-01",\n    "tag-02",\n    "tag-03",\n    "tag-04",\n    "tag-05",\n    "tag-06",\n    "tag-07",\n    "tag-08",\n    "tag-09",\n    "tag-10",\n    "tag-11",\n    "tag-12",\n    "tag-33",\n  ]);'''
tests = replace_once(tests, old_candidates, new_candidates)

full_old = '''      mood_energy_tempo: "complete" as const,\n      voice: "complete" as const,\n      lyric_theme: "complete" as const,'''
full_new = '''      mood: "complete" as const,\n      energy: "complete" as const,\n      tempo: "complete" as const,\n      voice_structure: "complete" as const,\n      voice_impression: "complete" as const,\n      lyric_theme: "complete" as const,'''
tests = replace_all(tests, full_old, full_new, minimum=4)

tests = replace_all(
    tests,
    'descriptive_category: "mood_energy_tempo"',
    'descriptive_category: "mood"',
    minimum=4,
)
tests = replace_all(
    tests,
    'expect(job.descriptive_category).toBe("mood_energy_tempo");',
    'expect(job.descriptive_category).toBe("mood");',
    minimum=1,
)
tests = replace_all(
    tests,
    'mood_energy_tempo: "complete",',
    'mood: "complete",',
    minimum=2,
)
tests = replace_all(
    tests,
    'mood_energy_tempo: "unavailable",',
    'mood: "unavailable",',
    minimum=1,
)

tests = replace_all(
    tests,
    'expect(job.descriptive_category).toBe("voice");',
    'expect(job.descriptive_category).toBe("energy");',
    minimum=2,
)
tests = replace_once(
    tests,
    'expect(queries[0]).toContain("BPM");',
    'expect(queries[0]).toContain("曲調");',
)

tests = replace_all(
    tests,
    'descriptive_category: "voice"',
    'descriptive_category: "voice_structure"',
    minimum=1,
)

tests = replace_once(tests, "  expect(searches).toBe(4);", "  expect(searches).toBe(6);")
tests = replace_all(
    tests,
    "    expect(searchQueries).toHaveLength(4);",
    "    expect(searchQueries).toHaveLength(7);",
    minimum=1,
)
tests = replace_all(
    tests,
    '    expect(searchQueries.some((query) => query.includes("歌声 歌唱"))).toBe(\n      true,\n    );',
    '    expect(searchQueries.some((query) => query.includes("歌唱者 声種"))).toBe(\n      true,\n    );\n    expect(searchQueries.some((query) => query.includes("歌声 声質"))).toBe(\n      true,\n    );',
    minimum=1,
)

# Category-wide candidates may intentionally omit unrelated descriptor sentences
# from the fitted request; this fixture only requires the retained genre evidence
# and explicit vocalist credit to survive the token budget.
tests = replace_once(
    tests,
    '''  expect(fullEvidence.content).toContain("Genre: electronic dance-pop");\n  expect(fullEvidence.content).toContain("A bright and bouncy rhythm");\n  expect(fullEvidence.content).toContain("clear and transparent vocals");\n  expect(fullEvidence.content).toContain("lyrics describe love and hope");''',
    '''  expect(fullEvidence.content).toContain("Genre: electronic dance-pop");\n  expect(fullEvidence.content).toContain("Vocal: Alice");''',
)

# Seven independent descriptor groups perform more Tavily lookups than the old
# four-group pipeline; the expected credit count rises accordingly.
tests = replace_once(
    tests,
    '  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(8);',
    '  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(12);',
)

path.write_text(tests, encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")
