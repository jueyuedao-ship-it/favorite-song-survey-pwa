from __future__ import annotations

import os
from pathlib import Path

PHASE = "green-task1"
TEST_COMMAND = "npx vitest run worker/tests/research-tagging.test.ts"
COMMIT_MESSAGE = "refactor: split descriptor research categories"


def write_env(name: str, value: str) -> None:
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f"expected one replacement target, found {text.count(old)}")
    return text.replace(old, new, 1)


providers_path = Path("worker/src/research/providers.ts")
text = providers_path.read_text(encoding="utf-8")
start_marker = "export const descriptorSearchGroups = ["
end_marker = "] as const;"
start = text.index(start_marker)
end = text.index(end_marker, start) + len(end_marker)
replacement = r'''export const descriptorSearchGroups = [
  {
    id: "genre_sound",
    category: "ジャンル",
    label: "ジャンルと音作り",
    search: "ジャンル 音楽性 サウンド 音色 楽器 composition genre sound instrumentation",
    cues:
      /j[- ]?pop|k[- ]?pop|日本語ポップ|韓国ポップ|邦楽ポップ|ロック|rock|r&b|リズム[＆&]ブルース|ヒップホップ|hip.?hop|ラップ|エレクトロ|electronic|電子音|シンセ|synth|ダンスポップ|dance.?pop|\bpop.{0,16}dance.{0,16}(?:tune|track|song)\b|ジャズ|jazz|スウィング|即興|フォーク|folk|クラシック|classical|メタル|metal|オーケストラ|\borchestral\b|\borchestra\b|acoustic|アコースティック/i,
  },
  {
    id: "mood",
    category: "雰囲気",
    label: "雰囲気",
    search: "曲調 雰囲気 明るい 切ない 爽やか mood tone atmosphere",
    cues:
      /曲調|雰囲気|明る|前向き|切な|胸が締め|悲し|穏やか|安ら|暗い|陰鬱|幻想|夢のよう|懐か|レトロ|コミカル|ユーモア|爽やか|清涼|温か|ぬくもり|緊張感|緊迫|\bmood\b|\btone\b|\batmosphere\b|\bbright\b|\bcheerful\b|\bquirky\b|\bcomical\b|\bhumorous\b|\bmelanchol|\bsad\b|\bcalm\b|\bpeaceful\b|\bdark\b|\bdreamy\b|\bnostalgic\b|\brefreshing\b|\bwarm\b|\btense\b/i,
  },
  {
    id: "energy",
    category: "勢い",
    label: "勢い",
    search: "勢い 演奏 リズム ビート グルーヴ energy rhythm beat groove",
    cues:
      /勢い|演奏|リズム|ビート|グルー[ヴブ]|しっとり|軽快|軽やか|弾む|力強|激し|荒々し|疾走感|駆け抜け|ダンサブル|踊れる|重厚|\benergy\b|\benergetic\b|\brhythm\b|\bbeat\b|\bgroove\b|\bdriving\b|\bjaunty\b|\brapid\b|\blively\b|\bbouncy\b|\bdanceable\b|\bintense\b|\bfierce\b|\bheavy\b/i,
  },
  {
    id: "tempo",
    category: "テンポ感",
    label: "テンポ",
    search: "テンポ BPM 速度 速い 遅い tempo BPM pace speed",
    cues:
      /テンポ|速度|速い|遅い|ゆったり|スローテンポ|ミドルテンポ|アップテンポ|\bbpm\b|\btempo\b|\bpace\b|\bspeed\b|\bfast\b|\bslow\b|\bquick\b|\brapid\b|\bup[- ]tempo\b|\bmid[- ]tempo\b/i,
  },
  {
    id: "voice_structure",
    category: "歌声の構成",
    label: "歌声の構成",
    search: "歌唱者 声種 複数ボーカル コーラス 合唱 インスト duet chorus choir vocal structure",
    cues:
      /人の歌声|人間(?:の)?歌唱|合成(?:音声|歌声|ボーカル|歌唱)|ボーカロイド|\bVOCALOID\b|\bSynthesizer\s*V\b|複数(?:人|名)?(?:の)?ボーカル|複数(?:人|名)?(?:が)?歌唱|デュエット|コーラス|合唱|インスト(?:ゥルメンタル)?|器楽曲|\bhuman vocals?\b|\bsynthetic vocals?\b|\bmultiple vocals?\b|\b(?:two|dual)\s+(?:vocalists?|singers?|voices?)\b|\bduet\b|\bchorus\b|\bchoir\b|\binstrumental(?: track| song)?\b/i,
  },
  {
    id: "voice_impression",
    category: "歌声の印象",
    label: "歌声の印象",
    search: "歌声 声質 透明感 ハスキー whisper vocal timbre voice quality",
    cues:
      /(歌声|歌唱|ボーカル|歌手|vocal(?:s)?|voice|singing).{0,60}(透明感|澄ん|透き通|柔らか|優し|力強|ささや|ハスキー|かすれ|声質|clear|transparent|soft|gentle|powerful|whisper|husky|raspy|timbre|tone quality)|(?:透明感|澄ん|透き通|柔らか|優し|力強|ささや|ハスキー|かすれ|声質|clear|transparent|soft|gentle|powerful|whisper|husky|raspy|timbre|tone quality).{0,60}(歌声|歌唱|ボーカル|歌手|vocal(?:s)?|voice|singing)/i,
  },
  {
    id: "lyric_theme",
    category: "歌詞テーマ",
    label: "歌詞テーマ",
    search: "歌詞 内容 テーマ 恋愛 別れ 孤独 希望 lyrics theme meaning",
    cues:
      /(歌詞|lyrics?).{0,240}(恋愛|愛|別れ|失恋|孤独|ひとり|応援|励ま|希望|日常|毎日|自己探求|自分探し|社会|世界|love|relationship|farewell|loneliness|hope|everyday|self[- ]?discovery|society|world)|(恋愛|別れ|失恋|孤独|希望|日常|自己探求|自分探し|社会|世界|love|relationship|farewell|loneliness|hope|everyday|self[- ]?discovery|society|world).{0,240}(歌詞|lyrics?)/i,
  },
] as const;'''
providers_path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")

test_path = Path("worker/tests/research-tagging.test.ts")
tests = test_path.read_text(encoding="utf-8")
tests = replace_once(
    tests,
    '''  expect(missingDescriptorCategories(sparse, recordingUrl)).toEqual([\n    "genre_sound",\n    "mood_energy_tempo",\n    "voice",\n    "lyric_theme",\n  ]);\n  expect(missingDescriptorCategories(partial, recordingUrl)).toEqual([\n    "mood_energy_tempo",\n    "voice",\n    "lyric_theme",\n  ]);\n  expect(missingDescriptorCategories(complete, recordingUrl)).toEqual([]);\n  expect(\n    missingDescriptorCategories(partial, recordingUrl, ["voice"]),\n  ).toEqual(["mood_energy_tempo", "lyric_theme"]);''',
    '''  expect(missingDescriptorCategories(sparse, recordingUrl)).toEqual([\n    "genre_sound",\n    "mood",\n    "energy",\n    "tempo",\n    "voice_structure",\n    "voice_impression",\n    "lyric_theme",\n  ]);\n  expect(missingDescriptorCategories(partial, recordingUrl)).toEqual([\n    "mood",\n    "energy",\n    "tempo",\n    "voice_structure",\n    "voice_impression",\n    "lyric_theme",\n  ]);\n  expect(missingDescriptorCategories(complete, recordingUrl)).toEqual([\n    "energy",\n    "voice_structure",\n  ]);\n  expect(\n    missingDescriptorCategories(partial, recordingUrl, ["voice_structure"]),\n  ).toEqual(["mood", "energy", "tempo", "voice_impression", "lyric_theme"]);''',
)
tests = replace_once(
    tests,
    ''').toContain("mood_energy_tempo");''',
    ''').toContain("mood");''',
)
test_path.write_text(tests, encoding="utf-8")

write_env("SEMANTIC_PHASE", PHASE)
write_env("SEMANTIC_TEST_COMMAND", TEST_COMMAND)
write_env("SEMANTIC_COMMIT_MESSAGE", COMMIT_MESSAGE)
print(f"semantic-tag TDD phase: {PHASE}")
