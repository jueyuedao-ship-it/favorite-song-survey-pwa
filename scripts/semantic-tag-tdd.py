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

# End-to-end research now has three additional independently researched descriptor
# groups. Give terminal-flow helpers enough invocations to finish those groups.
tests = replace_once(
    tests,
    "async function measuredLiveDrain(f: typeof fetch, n = 25) {",
    "async function measuredLiveDrain(f: typeof fetch, n = 45) {",
)

# Candidate fitting is intentionally category-wide. This title-only fixture has
# reliable genre evidence plus an explicit human-vocal credit at fitting time.
old_candidates = '''  expect(observedInput.tags.map((tag: any) => tag.id)).toEqual(\n    expect.arrayContaining([\n      "tag-07",\n      "tag-13",\n      "tag-24",\n      "tag-32",\n      "tag-33",\n      "tag-38",\n      "tag-47",\n    ]),\n  );'''
new_candidates = '''  expect(observedInput.tags.map((tag: any) => tag.id)).toEqual([\n    "tag-01",\n    "tag-02",\n    "tag-03",\n    "tag-04",\n    "tag-05",\n    "tag-06",\n    "tag-07",\n    "tag-08",\n    "tag-09",\n    "tag-10",\n    "tag-11",\n    "tag-12",\n    "tag-33",\n  ]);'''
tests = replace_once(tests, old_candidates, new_candidates)

# Hand-built jobs that mean "all descriptor research is already complete" must
# express all seven new groups, otherwise the runner correctly starts more searches.
full_old = '''      mood_energy_tempo: "complete" as const,\n      voice: "complete" as const,\n      lyric_theme: "complete" as const,'''
full_new = '''      mood: "complete" as const,\n      energy: "complete" as const,\n      tempo: "complete" as const,\n      voice_structure: "complete" as const,\n      voice_impression: "complete" as const,\n      lyric_theme: "complete" as const,'''
tests = replace_all(tests, full_old, full_new, minimum=4)

# Tests that exercise one descriptor group at a time now use the first independent
# group (mood) rather than the removed combined mood/energy/tempo group.
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

# After mood is completed/unavailable, energy is now the next independent group.
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

# A legacy generic voice extraction maps to the first explicit voice group.
tests = replace_all(
    tests,
    'descriptive_category: "voice"',
    'descriptive_category: "voice_structure"',
    minimum=1,
)

# Search-count integration assertions reflect seven independently researched
# categories. The first fixture already has one category covered, hence six searches.
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

path.write_text(tests, encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")
