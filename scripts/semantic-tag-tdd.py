from __future__ import annotations

import os
from pathlib import Path

PHASE = "red-task1"
TEST_COMMAND = (
    'npx vitest run worker/tests/research-tagging.test.ts '
    '-t "descriptor coverage independently|unrelated recording evidence"'
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
append_once(
    test_path,
    'it("tracks mood energy and tempo descriptor coverage independently"',
    r'''
it("tracks mood energy and tempo descriptor coverage independently", async () => {
  const { descriptorSearchGroups, missingDescriptorCategories } = await import(
    "../src/research/providers"
  );
  const groupIds = descriptorSearchGroups.map((group) => group.id);
  expect(groupIds).toEqual(
    expect.arrayContaining(["mood", "energy", "tempo"]),
  );

  const moodSource = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: "The song has a cheerful mood.",
  };
  const energySource = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: "The performance has a driving groove.",
  };
  const tempoSource = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: "The track is 172 BPM.",
  };

  const moodMissing = missingDescriptorCategories([moodSource], recordingUrl);
  expect(moodMissing).not.toContain("mood");
  expect(moodMissing).toContain("energy");
  expect(moodMissing).toContain("tempo");

  const energyMissing = missingDescriptorCategories([energySource], recordingUrl);
  expect(energyMissing).toContain("mood");
  expect(energyMissing).not.toContain("energy");
  expect(energyMissing).toContain("tempo");

  const tempoMissing = missingDescriptorCategories([tempoSource], recordingUrl);
  expect(tempoMissing).toContain("mood");
  expect(tempoMissing).toContain("energy");
  expect(tempoMissing).not.toContain("tempo");
});

it("tracks voice structure and voice impression independently", async () => {
  const { descriptorSearchGroups, missingDescriptorCategories } = await import(
    "../src/research/providers"
  );
  const groupIds = descriptorSearchGroups.map((group) => group.id);
  expect(groupIds).toEqual(
    expect.arrayContaining(["voice_structure", "voice_impression"]),
  );

  const structureSource = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: "The song is a duet with two vocalists.",
  };
  const impressionSource = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: "The vocals have a husky timbre.",
  };

  const structureMissing = missingDescriptorCategories(
    [structureSource],
    recordingUrl,
  );
  expect(structureMissing).not.toContain("voice_structure");
  expect(structureMissing).toContain("voice_impression");

  const impressionMissing = missingDescriptorCategories(
    [impressionSource],
    recordingUrl,
  );
  expect(impressionMissing).toContain("voice_structure");
  expect(impressionMissing).not.toContain("voice_impression");
});

it("does not open descriptor categories from unrelated recording evidence", async () => {
  const { descriptorSearchGroups, missingDescriptorCategories } = await import(
    "../src/research/providers"
  );
  const source = {
    id: "s9",
    url: "https://example.com/unrelated-recording",
    title: "Other song",
    content:
      "The other song is cheerful, has a driving groove, runs at 172 BPM, and features husky vocals.",
  };

  expect(missingDescriptorCategories([source], recordingUrl)).toEqual(
    descriptorSearchGroups.map((group) => group.id),
  );
});
''',
)

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
print(f"semantic-tag TDD phase: {PHASE}")
