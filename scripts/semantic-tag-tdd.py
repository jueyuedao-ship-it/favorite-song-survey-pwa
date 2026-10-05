from __future__ import annotations

import os

PHASE = "final-verify"
TEST_COMMAND = "npx vitest run worker/tests/research-tagging.test.ts"


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
print(f"semantic-tag TDD phase: {PHASE}")
