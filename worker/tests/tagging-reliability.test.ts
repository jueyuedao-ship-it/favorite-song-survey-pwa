import { expect, it } from "vitest";
import { tagDictionaryFingerprint } from "../src/tags";
import {
  associateExactSongRecordingEvidence,
  inferenceTagCandidates,
  researchSourceQuality,
} from "../src/research/providers";

const recordingUrl = "https://www.youtube.com/watch?v=aLpQ5RX0quU";
const query = {
  title: "蜃気楼",
  artist_hint: "tayori",
  reference_url: recordingUrl,
};
const primarySource = {
  id: "s0",
  url: recordingUrl,
  title: "tayori - 蜃気楼 (Official Video)",
  content:
    '{"provider":"youtube_oembed","endpoint":"https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaLpQ5RX0quU&format=json","title":"tayori - 蜃気楼 (Official Video)","author_name":"tayori wmj"}',
  metadata: {
    provider: "youtube_oembed" as const,
    endpoint:
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaLpQ5RX0quU&format=json",
    title: "tayori - 蜃気楼 (Official Video)",
    author_name: "tayori wmj",
  },
};

it("fingerprints active structured tag policy deterministically", () => {
  const base = {
    id: "tag-x",
    revision: 2,
    name: "透明",
    category: "音色",
    criterion: "透明な音",
    evidence_policy: {
      positive_patterns: ["crystalline"],
    },
    active: true,
  } as any;
  const fingerprint = tagDictionaryFingerprint([base]);
  expect(tagDictionaryFingerprint([{ ...base }])).toBe(fingerprint);
  expect(
    tagDictionaryFingerprint([
      { ...base, id: "tag-z", active: false },
      base,
    ]),
  ).toBe(fingerprint);
  expect(tagDictionaryFingerprint([{ ...base, revision: 3 }])).not.toBe(
    fingerprint,
  );
  expect(
    tagDictionaryFingerprint([
      {
        ...base,
        evidence_policy: { positive_patterns: ["glassy"] },
      },
    ]),
  ).not.toBe(fingerprint);
});

it("uses a structured evidence policy before criterion keyword fallback", () => {
  const source = {
    id: "s1",
    url: "https://example.com/song",
    title: "Song review",
    content: "The production has a crystalline shimmer throughout the song.",
  };
  const tags = [
    {
      id: "custom",
      name: "透明な質感",
      category: "音作り",
      criterion: "管理者が自由記述した基準",
      evidence_policy: {
        positive_patterns: ["crystalline\\s+shimmer"],
      },
    },
  ];
  expect(inferenceTagCandidates(tags, [source]).map((tag) => tag.id)).toEqual([
    "custom",
  ]);
  expect(
    inferenceTagCandidates(
      [
        {
          ...tags[0],
          evidence_policy: {
            positive_patterns: ["crystalline\\s+shimmer"],
            negative_patterns: ["throughout\\s+the\\s+song"],
          },
        },
      ],
      [source],
    ),
  ).toEqual([]);
});

it.each([
  "『蜃気楼』はtayoriの楽曲で、エレクトロニックなサウンドとアップテンポなビートが特徴です。",
  "tayoriの『蜃気楼』は新しい楽曲で、エレクトロニックなサウンドとアップテンポなビートが特徴です。",
])("associates Japanese exact-song prose: %s", (sentence) => {
  const article = {
    id: "s1",
    url: "https://example.com/tayori-mirage",
    title: "tayori「蜃気楼」楽曲解説",
    content: sentence,
  };
  const associated = associateExactSongRecordingEvidence(
    [primarySource, article],
    query,
    { [article.url]: sentence },
  );
  expect(associated[1].recording_associations).toEqual([
    expect.objectContaining({
      provenance: "worker_verified_song_v1",
      basis: "exact_song_recording",
      reference_url: recordingUrl,
      song_title: "蜃気楼",
      artist: "tayori",
    }),
  ]);
});

it("does not attach Japanese description for a different artist or alternate edition", () => {
  const wrongArtist = {
    id: "s1",
    url: "https://example.com/other-mirage",
    title: "別アーティスト「蜃気楼」解説",
    content:
      "『蜃気楼』は別アーティストの楽曲で、エレクトロニックなサウンドが特徴です。",
  };
  const cover = {
    id: "s2",
    url: "https://example.com/mirage-cover",
    title: "蜃気楼 cover review",
    content:
      "『蜃気楼』はtayoriの楽曲で、エレクトロニックなサウンドが特徴です。",
  };
  const associated = associateExactSongRecordingEvidence(
    [primarySource, wrongArtist, cover],
    query,
    {
      [wrongArtist.url]: wrongArtist.content,
      [cover.url]: cover.content,
    },
  );
  expect(associated[1].recording_associations).toBeUndefined();
  expect(associated[2].recording_associations).toBeUndefined();
});

it("classifies source quality for evidence display", () => {
  expect(researchSourceQuality(primarySource)).toMatchObject({
    tier: "platform",
  });
  expect(
    researchSourceQuality({
      id: "s1",
      url: "https://example.com/release",
      title: "release",
      content: "release",
      recording_associations: [
        {
          provenance: "worker_verified_release_v1",
          reference_url: recordingUrl,
          basis: "official_release",
          artist: "tayori",
          title_quote: "tayori 蜃気楼 single release",
          release_url: "https://tayori.lnk.to/Mirage",
        },
      ],
    }),
  ).toMatchObject({ tier: "editorial" });
  expect(
    researchSourceQuality({
      id: "s2",
      url: "https://tayori.lnk.to/Mirage",
      title: "Mirage official distribution",
      content: "Digital Single 蜃気楼",
      recording_associations: [
        {
          provenance: "worker_verified_release_v1",
          reference_url: recordingUrl,
          basis: "official_release",
          artist: "tayori",
          title_quote: "tayori 蜃気楼 single release",
          release_url: "https://tayori.lnk.to/Mirage",
        },
      ],
    }),
  ).toMatchObject({ tier: "official" });
});
