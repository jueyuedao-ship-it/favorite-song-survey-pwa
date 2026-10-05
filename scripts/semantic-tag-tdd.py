from __future__ import annotations

import os
from pathlib import Path

PHASE = "green-typecheck"
TEST_COMMAND = "npm run typecheck"
COMMIT_MESSAGE = "test: narrow exact-song association in Scatman regression"


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


path = Path("worker/tests/research-tagging.test.ts")
text = path.read_text(encoding="utf-8")
old = '''  expect(bound.recording_associations?.[0]).toMatchObject({\n    provenance: "worker_verified_song_v1",\n    reference_url: scatmanUrl,\n  });\n  expect(bound.recording_associations?.[0].description_quote).not.toContain(\n    "Scatman's World",\n  );'''
new = '''  const songAssociation = bound.recording_associations?.find(\n    (association) => association.provenance === "worker_verified_song_v1",\n  );\n  expect(songAssociation).toMatchObject({\n    provenance: "worker_verified_song_v1",\n    reference_url: scatmanUrl,\n  });\n  expect(songAssociation?.description_quote).not.toContain(\n    "Scatman's World",\n  );'''
if text.count(old) != 1:
    raise RuntimeError(f"expected one Scatman association assertion, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")