from __future__ import annotations

import os
from pathlib import Path

PHASE = "green-integration"
TEST_COMMAND = "npx vitest run worker/tests/research.test.ts"
COMMIT_MESSAGE = "fix: preserve category evidence under semantic candidate budget"


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


# Stable seed tags do not need their repeated criterion prose in every model call.
# The server still validates against the full criterion; compacting the prompt keeps
# descriptor evidence from being sacrificed to the 7600-token transport budget.
provider_path = Path("worker/src/research/providers.ts")
providers = provider_path.read_text(encoding="utf-8")
providers = replace_once(
    providers,
    '''      ...(criterion && criterion !== generic\n        ? { criterion: criterion.length > 72 ? criterion.slice(0, 72) : criterion }\n        : {}),''',
    '''      ...(criterion && criterion !== generic && !trustedSeedProfile(tag)\n        ? { criterion: criterion.length > 72 ? criterion.slice(0, 72) : criterion }\n        : {}),''',
)
provider_path.write_text(providers, encoding="utf-8")

path = Path("worker/tests/research.test.ts")
tests = path.read_text(encoding="utf-8")

tests = replace_once(
    tests,
    "async function measuredLiveDrain(f: typeof fetch, n = 25) {",
    "async function measuredLiveDrain(f: typeof fetch, n = 45) {",
)

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
tests = replace_once(
    tests,
    '  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(8);',
    '  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(12);',
)
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