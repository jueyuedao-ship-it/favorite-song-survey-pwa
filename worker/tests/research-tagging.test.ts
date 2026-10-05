import { it, expect } from "vitest";
import { inferenceSystemPrompt } from "../src/research/runner";

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
    '{"provider":"youtube_oembed","endpoint":"https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaLpQ5RX0quU&format=json","title":"tayori - 蜃気楼 (Official Video)","author_name":"tayori wmj"}\n# tayori - Mirage (Official Video)\n### Description\nVocal: isui',
  metadata: {
    provider: "youtube_oembed" as const,
    endpoint:
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaLpQ5RX0quU&format=json",
    title: "tayori - 蜃気楼 (Official Video)",
    author_name: "tayori wmj",
  },
};

it("associates an independently retrieved single-release article with the selected recording without inventing an MV link", async () => {
  const {
    associateOfficialReleaseEvidence,
    linkedDescriptionRecording,
    linkedRecording,
    recordingWindows,
  } = await import("../src/research/providers");
  const rawArticle = [
    "# tayori、約7ヶ月ぶりの新曲「蜃気楼」をリリース！春の余韻と夏の気配が交差する最新曲",
    "透明感に満ちたボーカル・isuiの歌声が楽曲全体をしなやかに牽引し、キャッチーでありながら情緒的なメロディは一度聴けば耳に残る。",
    "エレクトロニックなサウンドにアップテンポなビートを重ね、春の余韻と夏の気配を開放感とともに描く。",
    "歌詞では、思い描いていた未来とは異なる現実を受け入れながらも、それでも前へ進もうとする意志を描写。儚さと希望が同居する世界観がリスナーそれぞれの記憶や感情を静かに呼び起こす。",
    "さらに新曲は4月29日にリリースされ、春から夏へ向かう季節の変化を表現している。",
    "## リリース情報",
    "Digital Single「蜃気楼」",
    "リリース日：2026年4月29日",
    "公式配信: https://tayori.lnk.to/Mirage",
    "## Digital Catalog",
    "別アーティストの作品「夜明け」はジャズピアノが主役。",
  ].join("\n\n");
  const article = {
    id: "s1",
    url: "https://note.com/eveningmusic/n/nbb07092492c4",
    title:
      "tayori、約7ヶ月ぶりの新曲「蜃気楼」をリリース！｜EVENING",
    content: recordingWindows(rawArticle),
  };

  const associated = associateOfficialReleaseEvidence(
    [primarySource, article],
    query,
    { [article.url]: rawArticle },
  );
  const result = associated.find((source) => source.id === "s1")!;

  expect(result.url).toBe(article.url);
  expect(result.content).not.toContain(recordingUrl);
  expect(result.content).toContain("透明感に満ちたボーカル・isuiの歌声");
  expect(result.content).toContain("エレクトロニックなサウンドにアップテンポなビート");
  expect(result.content).not.toContain("Digital Catalog");
  expect(result.content).not.toContain("別アーティスト");
  expect((result as any).recording_associations).toEqual([
    expect.objectContaining({
      reference_url: recordingUrl,
      basis: "official_release",
      release_url: "https://tayori.lnk.to/Mirage",
    }),
  ]);
  expect(linkedRecording(result, recordingUrl)).toBe(false);
  expect(linkedDescriptionRecording(result, recordingUrl)).toBe(true);
  const refreshed = associateOfficialReleaseEvidence(
    [primarySource, { ...result, content: "A newer category-focused excerpt." }],
    query,
    { [article.url]: "A newer category-focused excerpt without release details." },
    [article.id],
  );
  expect((refreshed[1] as any).recording_associations).toEqual(
    (result as any).recording_associations,
  );
});

it("keeps Tavily Markdown autolinks as observed release URLs for article association", async () => {
  const { associateOfficialReleaseEvidence, recordingWindows } = await import(
    "../src/research/providers"
  );
  const articleUrl = "https://note.com/eveningmusic/n/nbb07092492c4";
  const rawArticle = [
    "# tayori、約7ヶ月ぶりの新曲「蜃気楼」をリリース！春の余韻と夏の気配が交差する最新曲",
    "3人組ユニットtayoriが、2026年4月29日(水)にデジタルシングル「蜃気楼」をリリースした。",
    "エレクトロニックなサウンドに、ストリングスやホーンといったアコースティックな要素を織り交ぜた、開放感あふれるアップテンポナンバー。",
    "### リリース情報",
    "2026年4月29日(水) Release",
    "Digital Single「蜃気楼」",
    "配信URL：<https://tayori.lnk.to/Mirage>",
  ].join("\n\n");
  const article = {
    id: "s1",
    url: articleUrl,
    title: "tayori、新曲「蜃気楼」をリリース",
    content: recordingWindows(rawArticle),
  };

  const [_, associated] = associateOfficialReleaseEvidence(
    [primarySource, article],
    query,
    { [articleUrl]: rawArticle },
  );

  expect(associated.content).toContain("https://tayori.lnk.to/Mirage");
  expect((associated as any).recording_associations).toEqual([
    expect.objectContaining({
      reference_url: recordingUrl,
      release_url: "https://tayori.lnk.to/Mirage",
      basis: "official_release",
    }),
  ]);
});

it("uses an OTOTOY release page's target Album Info section and stops before Digital Catalog", async () => {
  const { associateOfficialReleaseEvidence, linkedDescriptionRecording, recordingWindows } =
    await import("../src/research/providers");
  const url = "https://ototoy.jp/_/default/p/3662895";
  const raw = [
    "# 蜃気楼 - song and lyrics by tayori",
    "Artist: tayori",
    "## Album Info",
    "Digital Single「蜃気楼」 by tayori",
    "Label: WM Japan. Released on April 29, 2026.",
    "## Digital Catalog",
    "Recommended: another artist's jazz piano album.",
  ].join("\n\n");
  const result = associateOfficialReleaseEvidence(
    [
      primarySource,
      {
        id: "s1",
        url,
        title: "蜃気楼 - song and lyrics by tayori",
        content: recordingWindows(raw),
      },
    ],
    query,
    { [url]: raw },
  )[1];

  expect(result.content).not.toContain("Digital Catalog");
  expect(result.content).not.toContain("another artist");
  expect((result as any).recording_associations).toEqual([
    expect.objectContaining({
      reference_url: recordingUrl,
      basis: "official_release",
      release_url: url,
    }),
  ]);
  expect(linkedDescriptionRecording(result, recordingUrl)).toBe(true);
  expect(result.url).not.toBe(recordingUrl);
});

it("does not carry an article association through a conflicting native remix caption or forged metadata endpoint", async () => {
  const { associateOfficialReleaseEvidence } = await import(
    "../src/research/providers"
  );
  const article = {
    id: "s1",
    url: "https://note.com/eveningmusic/n/nbb07092492c4",
    title: "tayori、新曲「蜃気楼」をリリース",
    content:
      "tayori、新曲「蜃気楼」をリリース。\n\nOfficial distribution: https://tayori.lnk.to/Mirage",
  };
  const remixPrimary = {
    ...primarySource,
    metadata: {
      ...primarySource.metadata,
      title: "tayori - 蜃気楼 Remix (Official Video)",
    },
  };
  const forgedPrimary = {
    ...primarySource,
    metadata: {
      ...primarySource.metadata,
      endpoint: "https://www.youtube.com/oembed?url=unrelated&format=json",
    },
  };

  expect(
    (associateOfficialReleaseEvidence([remixPrimary, article], query)[1] as any)
      .recording_associations,
  ).toBeUndefined();
  expect(
    (associateOfficialReleaseEvidence([forgedPrimary, article], query)[1] as any)
      .recording_associations,
  ).toBeUndefined();
});

it("does not let an associated release article prove recording credits", async () => {
  const {
    associateOfficialReleaseEvidence,
    supportedAnalysis,
  } = await import("../src/research/providers");
  const article = {
    id: "s1",
    url: "https://note.com/eveningmusic/n/nbb07092492c4",
    title: "tayori、新曲「蜃気楼」をリリース",
    content:
      "tayori、新曲「蜃気楼」をリリース。\n\n## リリース情報\nDigital Single「蜃気楼」\nVocal: unrelated profile name\n公式配信: https://tayori.lnk.to/Mirage",
  };
  const evidence = associateOfficialReleaseEvidence(
    [primarySource, article],
    query,
  );
  const raw = {
    recordings: [
      {
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [
          {
            name: "unrelated profile name",
            kind: "person",
            role: "vocalist",
            source_id: "s1",
            quote: "Vocal: unrelated profile name",
            aliases: [],
          },
        ],
        tags: [],
      },
    ],
  };
  const analysis = supportedAnalysis(
    JSON.stringify(raw),
    evidence,
    query,
    [],
  );

  expect(analysis.recordings[0].credits).toEqual([]);
  expect(analysis.review_warnings).toContain(
    "recording:0:credit:0:UNSUPPORTED_EVIDENCE",
  );
});

it("keeps supported identity and descriptor tags when optional original and synthetic claims fail", async () => {
  const {
    associateOfficialReleaseEvidence,
    recordingWindows,
    supportedAnalysis,
  } = await import("../src/research/providers");
  const singer = "Mira";
  const primary = {
    ...primarySource,
    content: primarySource.content
      .replace("Vocal: isui", `Vocal: ${singer}`)
      .concat("\nProduced by tayori"),
  };
  const articleUrl = "https://note.com/eveningmusic/n/nbb07092492c4";
  const rawArticle = [
    "# tayori、新曲「蜃気楼」をリリース！春の余韻と夏の気配が交差する最新曲",
    "軽やかで明るいサウンドをベースにしながらも、どこか儚くエモーショナルな余韻を残す作品。",
    "エレクトロニックなサウンドに、ストリングスやホーンを織り交ぜた、開放感あふれるアップテンポナンバー。",
    `透明感に満ちたボーカル・${singer}の歌声が楽曲全体をしなやかに牽引する。`,
    "歌詞では、思い描いていた未来とは異なる現実を受け入れ、それでも前へ進む意志を描く。儚さと希望が同居する世界観を表現する。",
    "## リリース情報",
    "Digital Single「蜃気楼」",
    "公式配信: https://tayori.lnk.to/Mirage",
  ].join("\n\n");
  const article = {
    id: "s2",
    url: articleUrl,
    title: "tayori、新曲「蜃気楼」をリリース｜EVENING",
    content: recordingWindows(rawArticle),
  };
  const evidence = associateOfficialReleaseEvidence(
    [primary, article],
    query,
    { [articleUrl]: rawArticle },
  );
  const tags = [
    { id: "tag-07", name: "エレクトロ", category: "ジャンル", criterion: "電子音やシンセ主体のサウンド。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
    { id: "tag-24", name: "軽快", category: "勢い", criterion: "軽やかで弾むリズム。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-33", name: "人の歌声", category: "歌声の構成", criterion: "人または人のグループによる歌唱の明示。" },
    { id: "tag-38", name: "透明感", category: "歌声の印象", criterion: "澄んだ透明な歌声の具体的な説明。" },
    { id: "tag-47", name: "希望", category: "歌詞テーマ", criterion: "歌詞が希望を主題とするという解説。" },
  ];
  const raw = {
    recordings: [
      {
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        original: {
          title: "蜃気楼",
          reference_url: recordingUrl,
          source_id: "s2",
          quote: "tayori、新曲「蜃気楼」をリリース",
        },
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [
          {
            name: singer,
            kind: "synthetic_voice",
            role: "vocalist",
            source_id: "s0",
            quote: `Vocal: ${singer}`,
            aliases: [],
          },
        ],
        tags: [
          {
            tag_id: "tag-07",
            source_id: "s2",
            quote: "エレクトロニックなサウンド",
            reasoning: "The description explicitly identifies electronic sound in the recording.",
          },
          {
            tag_id: "tag-13",
            source_id: "s2",
            quote: "軽やかで明るいサウンド",
            reasoning: "The source describes a light and bright mood, directly supporting the bright atmosphere tag.",
          },
          {
            tag_id: "tag-24",
            source_id: "s2",
            quote: "軽やかで明るいサウンド",
            reasoning: "The description of the sound as light directly supports the light energy tag.",
          },
          {
            tag_id: "tag-32",
            source_id: "s2",
            quote: "開放感あふれるアップテンポナンバー",
            reasoning: "The description explicitly calls the number up-tempo.",
          },
          {
            tag_id: "tag-33",
            source_id: "s0",
            quote: `Vocal: ${singer}`,
            reasoning: "The listed vocalist is a human singer and supports the human-vocal tag.",
          },
          {
            tag_id: "tag-38",
            source_id: "s2",
            quote: `透明感に満ちたボーカル・${singer}の歌声`,
            reasoning: "The description explicitly says this vocalist's voice has transparency.",
          },
          {
            tag_id: "tag-47",
            source_id: "s2",
            quote: "希望が同居する世界観",
            reasoning: "The lyric description identifies hope as a theme of the song.",
          },
        ],
      },
    ],
  };

  const analysis = supportedAnalysis(JSON.stringify(raw), evidence, query, tags);

  expect(analysis.recordings).toHaveLength(1);
  expect(analysis.recordings[0]).toMatchObject({
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "other",
    original: null,
    credits: [],
  });
  expect(analysis.recordings[0].tags.map((tag) => tag.tag_id)).toEqual([
    "tag-07",
    "tag-13",
    "tag-24",
    "tag-32",
    "tag-38",
    "tag-47",
  ]);
  expect(analysis.review_warnings).toContain(
    "recording:0:original:UNSUPPORTED_EVIDENCE",
  );
  expect(analysis.review_warnings).toContain(
    "recording:0:credit:0:UNSUPPORTED_EVIDENCE",
  );
  expect(analysis.tag_decisions).toContainEqual(
    expect.objectContaining({ tag_id: "tag-33", status: "rejected" }),
  );
});

it("accepts a synthetic vocalist kind only when the source explicitly identifies it", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const singer = "Mira Kai";
  const source = {
    ...primarySource,
    content: `${primarySource.content.replace("Vocal: isui", `Vocal: ${singer}`)}\n${singer}の歌声は合成音声による。`,
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "other",
          source_id: "s0",
          quote: "tayori - 蜃気楼 (Official Video)",
          credits: [
            {
              name: singer,
              kind: "synthetic_voice",
              role: "vocalist",
              source_id: "s0",
              quote: `Vocal: ${singer}`,
              aliases: [],
            },
          ],
          tags: [],
        },
      ],
    }),
    [source],
    query,
    [],
  );

  expect(analysis.recordings[0].credits).toMatchObject([
    { name: singer, kind: "synthetic_voice", role: "vocalist" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("does not treat a name prefix in a fake native feature caption as a synthetic system credit", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const caption = "tayori - 蜃気楼 feat. 初音ミク風";
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint:
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaLpQ5RX0quU&format=json",
    title: caption,
    author_name: "tayori",
  };
  const source = {
    id: "s0",
    url: recordingUrl,
    title: caption,
    content: `${JSON.stringify(metadata)}\n${caption}`,
    metadata,
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "other",
          source_id: "s0",
          quote: caption,
          credits: [
            {
              name: "初音ミク",
              kind: "synthetic_voice",
              role: "vocalist",
              source_id: "s0",
              quote: "feat. 初音ミク",
              aliases: [],
            },
          ],
          tags: [],
        },
      ],
    }),
    [source],
    query,
    [],
  );

  expect(analysis.recordings[0].credits).toEqual([]);
  expect(analysis.review_warnings).toContain(
    "recording:0:credit:0:UNSUPPORTED_EVIDENCE",
  );
});

it.each([
  { singer: "Mira", statement: "Mira is not a synthetic voice.", caseName: "English negation" },
  { singer: "Mira", statement: "Miraは合成音声ではない。", caseName: "Japanese negation" },
  { singer: "Mira", statement: "Another performer uses a synthetic voice.", caseName: "different performer" },
  { singer: "Mira", statement: "Mira's song uses synthetic production.", caseName: "synthetic production" },
  { singer: "Ann", statement: "Annabelle uses a synthetic voice.", caseName: "short name inside another word" },
])(
  "does not confirm a synthetic vocalist without positive same-performer evidence: $caseName",
  async ({ singer, statement }) => {
    const { supportedAnalysis } = await import("../src/research/providers");
    const source = {
      ...primarySource,
      content: `${primarySource.content.replace("Vocal: isui", `Vocal: ${singer}`)}\n${statement}`,
    };
    const analysis = supportedAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "蜃気楼",
            reference_url: recordingUrl,
            kind: "other",
            source_id: "s0",
            quote: "tayori - 蜃気楼 (Official Video)",
            credits: [
              {
                name: singer,
                kind: "synthetic_voice",
                role: "vocalist",
                source_id: "s0",
                quote: `Vocal: ${singer}`,
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      }),
      [source],
      query,
      [],
    );

    expect(analysis.recordings[0].credits).toEqual([]);
    expect(analysis.review_warnings).toContain(
      "recording:0:credit:0:UNSUPPORTED_EVIDENCE",
    );
  },
);

it("does not apply a music mood tag to a venue or weather sentence on an associated release page", async () => {
  const { associateOfficialReleaseEvidence, supportedAnalysis } = await import(
    "../src/research/providers"
  );
  const article = {
    id: "s1",
    url: "https://note.com/eveningmusic/n/nbb07092492c4",
    title: "tayori、新曲「蜃気楼」をリリース",
    content:
      "tayori、新曲「蜃気楼」をリリース。\n\n暗い会場で暖かい春風を感じながらライブを楽しめる。\n\n## リリース情報\nDigital Single「蜃気楼」\n公式配信: https://tayori.lnk.to/Mirage",
  };
  const evidence = associateOfficialReleaseEvidence(
    [primarySource, article],
    query,
  );
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "tayori - 蜃気楼 (Official Video)",
          credits: [],
          tags: [
            {
              tag_id: "tag-16",
              source_id: "s1",
              quote: "暗い会場で暖かい春風を感じながらライブを楽しめる。",
              reasoning:
                "The release article describes a dark mood, which is enough to classify the song's emotional tone.",
            },
            {
              tag_id: "tag-21",
              source_id: "s1",
              quote: "暖かい春風",
              reasoning:
                "The release article describes warmth, which supports a warm musical atmosphere.",
            },
          ],
        },
      ],
    }),
    evidence,
    query,
    [
      { id: "tag-16", name: "暗い", category: "雰囲気", criterion: "陰鬱で暗い曲調。" },
      { id: "tag-21", name: "温かい", category: "雰囲気", criterion: "ぬくもりや親しみを感じる曲調。" },
    ],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
  expect(analysis.review_warnings).toEqual([
    "recording:0:tag:0:TAG_SEMANTIC_MISMATCH",
    "recording:0:tag:1:TAG_SEMANTIC_MISMATCH",
  ]);
});

it.each([
  {
    title: "別の新曲「蜃気楼」をリリース",
    content: "別の新曲「蜃気楼」をリリース。https://tayori.lnk.to/Mirage",
  },
  {
    title: "tayori、新曲「別の曲」をリリース",
    content: "tayori、新曲「別の曲」をリリース。https://tayori.lnk.to/Mirage",
  },
  {
    title: "tayori、新曲「蜃気楼」のカバーを公開",
    content:
      "tayori、新曲「蜃気楼」のカバーを公開。https://tayori.lnk.to/Mirage",
  },
  {
    title: "tayori、新曲「蜃気楼」のライブ版を公開",
    content:
      "tayori、新曲「蜃気楼」のライブ版を公開。https://tayori.lnk.to/Mirage",
  },
  {
    title: "tayori、新曲「蜃気楼」をリリース",
    content:
      "tayori、新曲「蜃気楼」をリリース。https://unrelated.example/release",
  },
])(
  "does not associate a release page with the recording when title, artist, edition, or distribution proof differs",
  async ({ title, content }) => {
    const {
      associateOfficialReleaseEvidence,
      linkedDescriptionRecording,
      linkedRecording,
    } = await import("../src/research/providers");
    const associated = associateOfficialReleaseEvidence(
      [
        primarySource,
        {
          id: "s1",
          url: "https://note.com/eveningmusic/n/nbb07092492c4",
          title,
          content,
        },
      ],
      query,
    );

    expect((associated[1] as any).recording_associations).toBeUndefined();
    expect(linkedRecording(associated[1], recordingUrl)).toBe(false);
    expect(linkedDescriptionRecording(associated[1], recordingUrl)).toBe(false);
  },
);

it.each(["Live", "Acoustic"])(
  "does not associate a standard release article with the selected %s recording",
  async (edition) => {
    const { associateOfficialReleaseEvidence } = await import(
      "../src/research/providers"
    );
    const selected = {
      ...primarySource,
      metadata: {
        ...primarySource.metadata,
        title: `tayori - 蜃気楼 (${edition})`,
      },
    };
    const article = {
      id: "s1",
      url: "https://note.com/eveningmusic/n/nbb07092492c4",
      title: "tayori、新曲「蜃気楼」をリリース",
      content:
        "tayori、新曲「蜃気楼」をリリース。\n\n## リリース情報\nDigital Single「蜃気楼」\n公式配信: https://tayori.lnk.to/Mirage",
    };

    expect(
      (associateOfficialReleaseEvidence([selected, article], query)[1] as any)
        .recording_associations,
    ).toBeUndefined();
  },
);

it("keeps complete Japanese music-description sentences after removing image and navigation payloads", async () => {
  const { recordingWindows } = await import("../src/research/providers");
  const raw = [
    '![見出し画像](https://assets.example/image.jpeg)',
    '[![EVENING](data:image/svg+xml;charset=utf8,%3Csvg%20viewBox%3D%220%200%22%3E)](https://note.com/)',
    "English 日本語 한국어 Français",
    "tayori、約7ヶ月ぶりの新曲「蜃気楼」をリリース。",
    "エレクトロニックなサウンドとアップテンポなビートが、春の余韻と夏の気配を描く。",
    "透明感に満ちたボーカル・isuiの歌声が楽曲全体をしなやかに牽引する。",
    "歌詞には迷いの先にも希望を見つける思いが描かれている。",
    "関連記事：別アーティストの曲「夜明け」はジャズピアノが主役。",
  ].join("\n\n");

  const excerpt = recordingWindows(raw);

  expect(excerpt).toContain(
    "エレクトロニックなサウンドとアップテンポなビートが、春の余韻と夏の気配を描く。",
  );
  expect(excerpt).toContain(
    "透明感に満ちたボーカル・isuiの歌声が楽曲全体をしなやかに牽引する。",
  );
  expect(excerpt).toContain("歌詞には迷いの先にも希望を見つける思いが描かれている。");
  expect(excerpt).not.toContain("data:image");
  expect(excerpt).not.toContain("assets.example");
  expect(excerpt).not.toContain("別アーティスト");
});

it("preserves single-newline channel, vocalist, and description boundaries", async () => {
  const { recordingWindows } = await import("../src/research/providers");
  const excerpt = recordingWindows(
    "Blue Song\n## Channel:\nVocal: Alice\nDescription\nbright refreshing sound",
  );

  expect(excerpt).toMatch(
    /Channel:\s*\n+\s*Vocal: Alice\s*\n+\s*Description\s*\n+\s*bright refreshing sound/,
  );
});

it("does not turn a single-newline Channel field into a recording vocalist credit", async () => {
  const { recordingWindows, supportedAnalysis } = await import(
    "../src/research/providers"
  );
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "Blue Song Official Video",
    content: recordingWindows(
      "Blue Song\n## Channel:\nVocal: Alice\nDescription\nbright refreshing sound",
    ),
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "Blue Song",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "Blue Song",
          credits: [
            {
              name: "Alice",
              kind: "person",
              role: "vocalist",
              source_id: "s0",
              quote: "Vocal: Alice",
              aliases: [],
            },
          ],
          tags: [],
        },
      ],
    }),
    [source],
    { title: "Blue Song", reference_url: recordingUrl },
    [],
  );

  expect(analysis.recordings[0].credits).toEqual([]);
  expect(analysis.review_warnings).toContain(
    "recording:0:credit:0:UNSUPPORTED_EVIDENCE",
  );
});

it("stops excerpts at a single-newline transcript or another song heading", async () => {
  const { recordingWindows } = await import("../src/research/providers");
  const excerpt = recordingWindows(
    "# tayori、新曲「蜃気楼」をリリース\nDescription\n電子音を交えた軽やかで明るいサウンド。\nTranscript\n暗い街で眠れないという歌詞本文。\n## 別の曲「夜明け」\n重厚で激しいロックサウンド。",
  );

  expect(excerpt).toContain("電子音を交えた軽やかで明るいサウンド。");
  expect(excerpt).not.toContain("Transcript");
  expect(excerpt).not.toContain("眠れないという歌詞本文");
  expect(excerpt).not.toContain("別の曲");
  expect(excerpt).not.toContain("重厚で激しい");
});

it("does not preserve a fabricated old association without a current verified primary anchor", async () => {
  const { associateOfficialReleaseEvidence, linkedDescriptionRecording } = await import(
    "../src/research/providers"
  );
  const forged = {
    id: "s9",
    url: "https://unrelated.example/profile",
    title: "Artist profile",
    content: "No release or track details.",
    recording_associations: [
      {
        provenance: "worker_verified_release_v1" as const,
        reference_url: recordingUrl,
        basis: "official_release" as const,
        artist: "tayori",
        title_quote: "tayori、新曲「蜃気楼」をリリース。",
        release_url: "https://tayori.lnk.to/Mirage",
      },
    ],
  };
  const result = associateOfficialReleaseEvidence([forged], query)[0];

  expect((result as any).recording_associations).toBeUndefined();
  expect(linkedDescriptionRecording(result, recordingUrl)).toBe(false);
});

it("does not accept a same-artist distribution link outside a target release information section", async () => {
  const { associateOfficialReleaseEvidence, linkedDescriptionRecording } = await import(
    "../src/research/providers"
  );
  const article = {
    id: "s1",
    url: "https://note.com/eveningmusic/n/unrelated-route",
    title: "tayori、新曲「蜃気楼」をリリース",
    content:
      "tayori、新曲「蜃気楼」をリリース。\n\n公式配信 https://tayori.lnk.to/UnrelatedSong",
  };
  const result = associateOfficialReleaseEvidence(
    [primarySource, article],
    query,
  )[1];

  expect((result as any).recording_associations).toBeUndefined();
  expect(linkedDescriptionRecording(result, recordingUrl)).toBe(false);
});

it("rejects a same-artist link when its dedicated release section names another title", async () => {
  const { associateOfficialReleaseEvidence, linkedDescriptionRecording } = await import(
    "../src/research/providers"
  );
  const article = {
    id: "s1",
    url: "https://note.com/eveningmusic/n/unrelated-release",
    title: "tayori、新曲「蜃気楼」をリリース",
    content:
      "tayori、新曲「蜃気楼」をリリース。\n\n## リリース情報\nDigital Single「別の曲」\n公式配信: https://tayori.lnk.to/UnrelatedSong",
  };
  const result = associateOfficialReleaseEvidence(
    [primarySource, article],
    query,
  )[1];

  expect((result as any).recording_associations).toBeUndefined();
  expect(linkedDescriptionRecording(result, recordingUrl)).toBe(false);
});

it("requires mood and energy descriptions to describe a song property, not its venue", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content:
      "tayori - 蜃気楼\n\n暗い会場で暖かい春風の中、新曲を演奏した。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "蜃気楼",
          credits: [],
          tags: [
            {
              tag_id: "tag-16",
              source_id: "s0",
              quote: "暗い会場で暖かい春風の中、新曲を演奏した。",
              reasoning:
                "This describes a dark mood and therefore establishes the song's emotional atmosphere.",
            },
          ],
        },
      ],
    }),
    [source],
    query,
    [{ id: "tag-16", name: "暗い", category: "雰囲気", criterion: "陰鬱で暗い曲調。" }],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});

it("tracks missing descriptive search groups independently instead of treating one hit as full coverage", async () => {
  const { missingDescriptorCategories } = await import(
    "../src/research/providers"
  );
  const sparse = [
    {
      ...primarySource,
      content: `${primarySource.content}\n\nVocal: isui`,
    },
  ];
  const partial = [
    ...sparse,
    {
      id: "s1",
      url: "https://note.com/eveningmusic/n/example",
      title: "tayori、新曲「蜃気楼」をリリース",
      content:
        "tayori、新曲「蜃気楼」をリリース。\n\n電子音とシンセを中心とするサウンド。",
      recording_associations: [
        {
          provenance: "worker_verified_release_v1" as const,
          reference_url: recordingUrl,
          basis: "official_release" as const,
          artist: "tayori",
          title_quote: "tayori、新曲「蜃気楼」をリリース。",
          release_url: "https://tayori.lnk.to/Mirage",
        },
      ],
    },
  ];
  const complete = [
    ...partial,
    {
      id: "s2",
      url: "https://music.example/track/mirage",
      title: "蜃気楼の楽曲解説",
      content:
        "春の余韻と夏の気配が交差する明るくアップテンポな曲調。\n\n透明感のあるボーカルの歌声。\n\n歌詞には迷いの先にも希望を見つける思いが描かれている。",
      recording_associations: [
        {
          provenance: "worker_verified_release_v1" as const,
          reference_url: recordingUrl,
          basis: "official_release" as const,
          artist: "tayori",
          title_quote: "tayori、新曲「蜃気楼」をリリース。",
          release_url: "https://tayori.lnk.to/Mirage",
        },
      ],
    },
  ];

  expect(missingDescriptorCategories(sparse, recordingUrl)).toEqual([
    "genre_sound",
    "mood",
    "energy",
    "tempo",
    "voice_structure",
    "voice_impression",
    "lyric_theme",
  ]);
  expect(missingDescriptorCategories(partial, recordingUrl)).toEqual([
    "mood",
    "energy",
    "tempo",
    "voice_structure",
    "voice_impression",
    "lyric_theme",
  ]);
  expect(missingDescriptorCategories(complete, recordingUrl)).toEqual([
    "energy",
    "voice_structure",
  ]);
  expect(
    missingDescriptorCategories(partial, recordingUrl, ["voice_structure"]),
  ).toEqual(["mood", "energy", "tempo", "voice_impression", "lyric_theme"]);
});

it("packs only tag definitions with matching evidence while retaining custom definitions", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "tayori - 蜃気楼",
    content:
      "tayori - 蜃気楼\n\nAn electronic, synth-driven sound rides an up-tempo beat.",
  };
  const tags = [
    {
      id: "tag-01",
      name: "J-POP",
      category: "ジャンル",
      criterion: "日本語ポップ音楽と明示された楽曲。",
    },
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion: "電子音やシンセ主体のサウンド。",
    },
    {
      id: "tag-32",
      name: "速い",
      category: "テンポ感",
      criterion: "速いテンポと説明される。",
    },
    {
      id: "tag-51",
      name: "シンセ主導",
      category: "ジャンル",
      criterion: "A synthesizer-led sound with electronic textures.",
    },
  ];

  expect(inferenceTagCandidates(tags, [source], recordingUrl).map((tag) => tag.id)).toEqual([
    "tag-01",
    "tag-07",
    "tag-32",
    "tag-51",
  ]);
});

it("offers the human-vocal seed when current criterion wording means people singing", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const source = {
    ...primarySource,
    content: `${primarySource.content}\n\nVocal: isui`,
  };
  const candidates = inferenceTagCandidates(
    [
      {
        id: "tag-33",
        name: "人の歌声",
        category: "歌声の構成",
        criterion: "人または人のグループによる歌唱の明示。",
      },
      {
        id: "tag-34",
        name: "合成歌声",
        category: "歌声の構成",
        criterion: "合成音声による歌唱の明示。",
      },
    ],
    [source],
    recordingUrl,
  );

  expect(candidates.map((tag) => tag.id)).toContain("tag-33");
  expect(candidates.map((tag) => tag.id)).not.toContain("tag-34");
});

it("recognizes a source's pop dance tune phrasing for the current dance-pop criterion", async () => {
  const { inferenceTagCandidates, supportedAnalysis } = await import(
    "../src/research/providers"
  );
  const quote = "bright and refreshing pop dance tune";
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "Blue Song",
    content: `Blue Song official\n\n${quote}`,
  };
  const tag = {
    id: "tag-08",
    name: "ダンスポップ",
    category: "ジャンル",
    criterion: "踊れるビートとポップなメロディの融合。",
  };
  expect(inferenceTagCandidates([tag], [source], recordingUrl).map((x) => x.id)).toEqual([
    "tag-08",
  ]);

  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "Blue Song",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "Blue Song official",
          credits: [],
          tags: [
            {
              tag_id: "tag-08",
              source_id: "s0",
              quote,
              reasoning:
                "The description identifies the genre as a pop dance tune, combining a pop melody with a dance-oriented rhythm.",
            },
          ],
        },
      ],
    }),
    [source],
    { title: "Blue Song", reference_url: null },
    [tag],
  );
  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-08", evidence_type: "semantic_inference" },
  ]);
});

it("accepts the current human-vocal criterion when the source explicitly says 人の歌声", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const source = {
    ...primarySource,
    content: `${primarySource.content}\n\n人の歌声。`,
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "tayori - 蜃気楼 (Official Video)",
          credits: [
            {
              name: "isui",
              kind: "person",
              role: "vocalist",
              source_id: "s0",
              quote: "Vocal: isui",
              aliases: [],
            },
          ],
          tags: [
            {
              tag_id: "tag-33",
              source_id: "s0",
              quote: "人の歌声",
              reasoning:
                "この明示された人の歌声という説明が、人の歌声の基準に直接合致する。",
            },
          ],
        },
      ],
    }),
    [source],
    query,
    [
      {
        id: "tag-33",
        name: "人の歌声",
        category: "歌声の構成",
        criterion: "人または人のグループによる歌唱の明示。",
      },
    ],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-33", evidence_type: "direct" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("rejects generic catchy melody as J-POP and instrument-only jazz or classical labels", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content:
      "tayori - 蜃気楼\n\nキャッチーでありながら情緒的なメロディが耳に残る。\n\nピアノとサックスを用いた演奏。",
  };
  const recording = (tag_id: string, quote: string) => ({
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "original",
    source_id: "s0",
    quote: "蜃気楼",
    credits: [],
    tags: [
      {
        tag_id,
        source_id: "s0",
        quote,
        reasoning:
          "この引用は曲の内容を説明しており、選択したタグの意味に合う音楽上の特徴を示している。",
      },
    ],
  });
  const definitions = [
    { id: "tag-01", name: "J-POP", category: "ジャンル" },
    { id: "tag-09", name: "ジャズ", category: "ジャンル" },
    { id: "tag-11", name: "クラシック", category: "ジャンル" },
  ];
  const results = [
    supportedAnalysis(
      JSON.stringify({ recordings: [recording("tag-01", "キャッチーでありながら情緒的なメロディが耳に残る。")] }),
      [source],
      query,
      definitions,
    ),
    supportedAnalysis(
      JSON.stringify({ recordings: [recording("tag-09", "ピアノとサックスを用いた演奏。")] }),
      [source],
      query,
      definitions,
    ),
    supportedAnalysis(
      JSON.stringify({ recordings: [recording("tag-11", "ピアノとサックスを用いた演奏。")] }),
      [source],
      query,
      definitions,
    ),
  ];

  expect(results.map((analysis) => analysis.recordings[0].tags)).toEqual([
    [],
    [],
    [],
  ]);
  expect(results.every((analysis) => analysis.review_warnings?.length)).toBe(
    true,
  );
});

it("rejects negated seed evidence while honoring an administrator's changed criterion", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content:
      "tayori - 蜃気楼\n\nElectronic synthesis is not used in this arrangement.\n\nAn orchestral string arrangement shapes the song's musical style.",
  };
  const recording = (quote: string, reasoning: string) => ({
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "original",
    source_id: "s0",
    quote: "蜃気楼",
    credits: [],
    tags: [
      {
        tag_id: "tag-07",
        source_id: "s0",
        quote,
        reasoning,
      },
    ],
  });
  const originalDefinition = [
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion: "電子音やシンセ主体のサウンド。",
    },
  ];
  const changedDefinition = [
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion: "Orchestral strings, not electronic synthesis, shape the arrangement.",
    },
  ];
  const negated = supportedAnalysis(
    JSON.stringify({
      recordings: [
        recording(
          "Electronic synthesis is not used in this arrangement.",
          "The sound description supports the electronic genre because it mentions electronic synthesis.",
        ),
      ],
    }),
    [source],
    query,
    originalDefinition,
  );
  const redefined = supportedAnalysis(
    JSON.stringify({
      recordings: [
        recording(
          "An orchestral string arrangement shapes the song's musical style.",
          "The orchestral timbre and string arrangement establish the intended musical style.",
        ),
      ],
    }),
    [source],
    query,
    changedDefinition,
  );

  expect(negated.recordings[0].tags).toEqual([]);
  expect(redefined.recordings[0].tags).toHaveLength(1);
  expect(redefined.recordings[0].tags[0].evidence_type).toBe("semantic_inference");
});

it("supports a custom 音作り category through its current criterion and rejects its negation", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content:
      "tayori - 蜃気楼\n\n電子音とシンセを中心にしたサウンド。\n\n電子音を使わないアコースティック編曲。",
  };
  const tag = {
    id: "tag-51",
    name: "シンセ主導",
    category: "音作り",
    criterion: "電子音やシンセ主体のサウンドを使う。",
  };
  const recording = (quote: string) => ({
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "original",
    source_id: "s0",
    quote: "蜃気楼",
    credits: [],
    tags: [
      {
        tag_id: tag.id,
        source_id: "s0",
        quote,
        reasoning:
          "The production description identifies how electronic textures shape the track's arrangement.",
      },
    ],
  });
  const positive = supportedAnalysis(
    JSON.stringify({ recordings: [recording("電子音とシンセを中心にしたサウンド。")] }),
    [source],
    query,
    [tag],
  );
  const negative = supportedAnalysis(
    JSON.stringify({ recordings: [recording("電子音を使わないアコースティック編曲。")] }),
    [source],
    query,
    [tag],
  );
  expect(positive.recordings[0].tags).toHaveLength(1);
  expect(negative.recordings[0].tags).toEqual([]);
});

it("accepts twelve independently supported category decisions and rejects a thirteenth", async () => {
  const { analysisSchema, supportedAnalysis } = await import(
    "../src/research/providers"
  );
  const definitions = [
    ["tag-07", "エレクトロ", "ジャンル", "電子音とシンセを中心にしたサウンド。"],
    ["tag-03", "ロック", "ジャンル", "ギターとドラム主体のロック演奏。"],
    ["tag-13", "明るい", "雰囲気", "明るく前向きな曲調。"],
    ["tag-14", "切ない", "雰囲気", "悲しさが胸に迫る切ない曲調。"],
    ["tag-15", "穏やか", "雰囲気", "穏やかで安らぎを感じる曲調。"],
    ["tag-20", "爽やか", "雰囲気", "爽やかで清涼感のある曲調。"],
    ["tag-21", "温かい", "雰囲気", "温かさと親しみを感じる曲調。"],
    ["tag-22", "緊張感", "雰囲気", "張りつめた緊張感のある曲調。"],
    ["tag-24", "軽快", "勢い", "軽快で弾むリズム。"],
    ["tag-25", "力強い", "勢い", "力強いエネルギーを感じる演奏。"],
    ["tag-27", "疾走感", "勢い", "疾走感のある演奏。"],
    ["tag-32", "速い", "テンポ感", "アップテンポな速いテンポ。"],
  ] as const;
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: `tayori - 蜃気楼\n\n${definitions.map(([, , , quote]) => quote).join("\n\n")}`,
  };
  const rawRecording = {
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "original",
    source_id: "s0",
    quote: "蜃気楼",
    credits: [],
    tags: definitions.map(([tag_id, , , quote]) => ({
      tag_id,
      source_id: "s0",
      quote,
      reasoning: `${quote}が説明されており、このタグの基準に直接合致する。`,
    })),
  };
  const tags = definitions.map(([id, name, category, criterion]) => ({
    id,
    name,
    category,
    criterion,
  }));
  const analysis = supportedAnalysis(
    JSON.stringify({ recordings: [rawRecording] }),
    [source],
    query,
    tags,
  );
  const tooMany: any = structuredClone(rawRecording);
  tooMany.tags.push({
    tag_id: "tag-01",
    source_id: "s0",
    quote: "蜃気楼",
    reasoning: "追加のタグ候補を確認するための検証用文です。",
  });

  expect((analysisSchema.properties as any).recordings.items.properties.tags.maxItems).toBe(12);
  expect(analysis.recordings[0].tags).toHaveLength(12);
  expect(analysis.recordings[0].tags[0].evidence_type).toBe("semantic_inference");
  expect(analysis.tag_decisions?.filter((decision) => decision.status === "accepted")).toHaveLength(12);
  expect(() =>
    supportedAnalysis(
      JSON.stringify({ recordings: [tooMany] }),
      [source],
      query,
      tags,
    ),
  ).toThrow();
});

it("fits source evidence from cleaned sentences while retaining observed release provenance and twelve-tag capacity", async () => {
  const { fitInferenceRequest, requestTokenEstimate } = await import(
    "../src/research/providers"
  );
  const quote =
    "エレクトロニックなサウンドにアップテンポなビートを重ね、春の余韻と夏の気配を開放感とともに描く。";
  const association = {
    provenance: "worker_verified_release_v1" as const,
    reference_url: recordingUrl,
    basis: "official_release" as const,
    artist: "tayori",
    title_quote: "tayori、新曲「蜃気楼」をリリース。\nDigital Single「蜃気楼」",
    release_url: "https://tayori.lnk.to/Mirage",
  };
  const sources = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    url: i === 0 ? "https://note.com/eveningmusic/n/mirage" : `https://music.example/song/${i}`,
    title: "蜃気楼 - tayori",
    content: [
      `![logo](https://assets.example/${i}.svg)`,
      "cookie settings login menu related articles sign in " .repeat(60),
      `tayori - 蜃気楼 source ${i}`,
      quote,
      `Selected recording: ${recordingUrl}`,
      "Official distribution: https://tayori.lnk.to/Mirage",
    ].join("\n\n"),
    ...(i === 0 ? { recording_associations: [association] } : {}),
  }));
  const definitions = Array.from({ length: 50 }, (_, i) => ({
    id: `tag-${String(i + 1).padStart(2, "0")}`,
    name: `reviewed tag ${i + 1}`,
    category: ["ジャンル", "雰囲気", "勢い", "テンポ感", "歌声の構成", "歌声の印象", "歌詞テーマ"][i % 7],
    criterion: "Webの独立した説明で対象の音楽特徴が述べられている場合にだけ使う。",
  }));
  const body: any = {
    model: "fixture-model",
    max_completion_tokens: 3200,
    response_format: { type: "json_schema", json_schema: { schema: {} } },
    messages: [
      { role: "system", content: "タグは最大12件。根拠のない推測をしない。" },
      {
        role: "user",
        content: JSON.stringify({ query, sources, tags: definitions }),
      },
    ],
  };

  const fitted = fitInferenceRequest(body, sources);
  const first = fitted.evidence[0];

  expect(requestTokenEstimate(fitted.body)).toBeLessThanOrEqual(7600);
  expect(first.content).toContain(quote);
  expect(first.recording_associations).toEqual([association]);
  expect(fitted.evidence.map((source) => source.id)).toEqual(
    sources.map((source) => source.id),
  );
  expect(first.content).not.toContain("assets.example");
});

it("fits a real-shaped 50-tag request without losing the associated article or its supported tag candidates", async () => {
  const {
    associateOfficialReleaseEvidence,
    fitInferenceRequest,
    knownIdentitySchema,
    recordingWindows,
    requestTokenEstimate,
    tagCategoryGuidance,
  } = await import("../src/research/providers");
  const articleUrl = "https://note.com/eveningmusic/n/nbb07092492c4";
  const rawArticle = [
    "# tayori、約7ヶ月ぶりの新曲「蜃気楼」をリリース！春の余韻と夏の気配が交差する最新曲",
    "3人組ユニットtayoriが、2026年4月29日(水)にデジタルシングル「蜃気楼」をリリースした。",
    "2025年9月にリリースした2ndアルバム「magic」以来、約7ヶ月ぶりの新曲となる本作は、春の余韻と夏の気配が交差する楽曲。軽やかで明るいサウンドをベースにしながらも、どこか儚くエモーショナルな余韻を残す点が印象的な作品に仕上がっている。",
    "エレクトロニックなサウンドに、ストリングスやホーンといったアコースティックな要素を織り交ぜた、開放感あふれるアップテンポナンバー。",
    "透明感に満ちたボーカル・isuiの歌声が楽曲全体をしなやかに牽引し、キャッチーでありながら情緒的なメロディは、一度聴けば耳に残る中毒性を持つ。",
    "歌詞では、“思い描いていた未来とは異なる現実”を受け入れながらも、それでも前へ進もうとする意志を描写。儚さと希望が同居する世界観がリスナーそれぞれの記憶や感情を静かに呼び起こす。",
    "### リリース情報",
    "2026年4月29日(水) Release",
    "Digital Single「蜃気楼」",
    "配信URL：<https://tayori.lnk.to/Mirage>",
    "### 公演概要",
    "tayori 3rd Anniversary Live “Asterism”",
  ].join("\n\n");
  const threads = {
    id: "s1",
    url: "https://www.threads.com/@warnermusic_jp/post/DZB-4SoDgx0/tayori",
    title: "#tayori 最新曲「蜃気楼」Music Video Out",
    content:
      "[Home](/)\n[warnermusic_jp](/@warnermusic_jp)\n#tayori 最新曲「蜃気楼」\nMusic Video Out\nMVはこちら https://youtu.be/aLpQ5RX0quU\ntayori - 新情報解禁 https://youtu.be/FqTcz_cYJNI",
  };
  const article = {
    id: "s2",
    url: articleUrl,
    title: "tayori、約7ヶ月ぶりの新曲「蜃気楼」をリリース！",
    content: `${recordingWindows(rawArticle)}\n\n${recordingWindows(rawArticle).slice(0, 300)}`,
  };
  const irrelevant = {
    id: "s3",
    url: "https://music.apple.com/us/artist/tayori/1698282899?l=ru",
    title: "tayori - Apple Music",
    content: "Artist page for tayori. A Little Bird Told Me. Artist biography and catalog.",
  };
  const evidence = associateOfficialReleaseEvidence(
    [primarySource, threads, article, irrelevant],
    query,
    { [articleUrl]: rawArticle },
  );
  expect(evidence.find((source) => source.id === "s2")?.content).toContain(
    "エレクトロニックなサウンドに",
  );
  expect(evidence.find((source) => source.id === "s2")?.content).toContain(
    "透明感に満ちたボーカル・isuiの歌声",
  );
  expect(evidence.find((source) => source.id === "s2")?.content).toContain(
    "歌詞では、“思い描いていた未来とは異なる現実”を受け入れながらも",
  );
  expect(evidence.find((source) => source.id === "s2")?.content).toContain(
    "軽やかで明るいサウンド",
  );
  const names = [
    "J-POP", "K-POP", "ロック", "ポップロック", "R&B", "ヒップホップ", "エレクトロ", "ダンスポップ", "ジャズ", "フォーク", "クラシック", "メタル",
    "明るい", "切ない", "穏やか", "暗い", "幻想的", "懐かしい", "コミカル", "爽やか", "温かい", "緊張感",
    "しっとり", "軽快", "力強い", "激しい", "疾走感", "ダンサブル", "重厚", "ゆったり", "中程度", "速い",
    "人の歌声", "合成歌声", "複数ボーカル", "コーラス中心", "インスト", "透明感", "柔らかい", "力強い歌声", "ささやくような", "ハスキー",
    "恋愛", "別れ", "孤独", "応援", "希望", "日常", "自己探求", "社会・世界",
  ];
  const categoryFor = (index: number) =>
    index < 12
      ? "ジャンル"
      : index < 22
        ? "雰囲気"
        : index < 29
          ? "勢い"
          : index < 32
            ? "テンポ感"
            : index < 37
              ? "歌声の構成"
              : index < 42
                ? "歌声の印象"
                : "歌詞テーマ";
  const tags = names.map((name, index) => ({
    id: `tag-${String(index + 1).padStart(2, "0")}`,
    name,
    category: categoryFor(index),
    criterion: `Webの説明・公式情報で「${name}」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。`,
  }));
  const body: any = {
    model: "qwen/qwen3.8-27b",
    temperature: 0,
    max_completion_tokens: 3200,
    response_format: {
      type: "json_schema",
      json_schema: { name: "song_evidence", strict: true, schema: knownIdentitySchema(evidence, query) },
    },
    messages: [
      {
        role: "system",
        content: inferenceSystemPrompt,
      },
      {
        role: "user",
        content: JSON.stringify({
          query,
          sources: evidence,
          tag_category_guidance: tagCategoryGuidance,
          tags,
        }),
      },
    ],
  };

  const fitted = fitInferenceRequest(body, evidence);
  const input = JSON.parse(fitted.body.messages[1].content);
  const fittedArticle = fitted.evidence.find((source) => source.id === "s2");

  expect(requestTokenEstimate(fitted.body)).toBeLessThanOrEqual(7600);
  expect(fitted.evidence.map((source) => source.id)).toEqual(["s0", "s2"]);
  const releaseAssociation = fittedArticle?.recording_associations?.find(
    (association) => association.provenance === "worker_verified_release_v1",
  );
  expect(releaseAssociation?.release_url).toBe("https://tayori.lnk.to/Mirage");
  expect(releaseAssociation?.title_quote).toContain("Digital Single「蜃気楼」");
  expect(fittedArticle?.content).toContain("エレクトロニックなサウンドに");
  expect(fittedArticle?.content).toContain("軽やかで明るいサウンド");
  expect(fittedArticle?.content).toContain("透明感に満ちたボーカル・isuiの歌声");
  expect(fittedArticle?.content).toContain("歌詞では、“思い描いていた未来とは異なる現実”を受け入れながらも");
  expect(input.tags.map((tag: any) => tag.id)).toEqual(
    expect.arrayContaining([
      "tag-07",
      "tag-13",
      "tag-24",
      "tag-32",
      "tag-38",
      "tag-47",
    ]),
  );
  expect(input.tags.map((tag: any) => tag.id)).toContain("tag-50");
  expect(input.tags.map((tag: any) => tag.id)).not.toContain("tag-34");
});

it("accepts a specific English rationale for Japanese lyric-theme evidence without requiring literal tag repetition", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content:
      "tayori - 蜃気楼\n\n歌詞では迷いの先にも光を見つける物語を描く。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "蜃気楼",
          credits: [],
          tags: [
            {
              tag_id: "tag-47",
              source_id: "s0",
              quote: "歌詞では迷いの先にも光を見つける物語を描く。",
              reasoning:
                "The narrative describes lyrics that look toward a better future, so the song's subject is optimistic.",
            },
          ],
        },
      ],
    }),
    [source],
    query,
    [
      {
        id: "tag-47",
        name: "希望",
        category: "歌詞テーマ",
        criterion: "歌詞が希望を主題とするという解説。",
      },
    ],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-47", evidence_type: "semantic_inference" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("keeps a long Japanese lyric synopsis within the lyric-theme category without treating it as mood evidence", async () => {
  const { missingDescriptorCategories, supportedAnalysis } = await import(
    "../src/research/providers"
  );
  const quote =
    "歌詞では、“思い描いていた未来とは異なる現実”を受け入れながらも、それでも前へ進もうとする意志を描写。儚さと希望が同居する世界観がリスナーそれぞれの記憶や感情を静かに呼び起こす。";
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: `tayori - 蜃気楼\n\n${quote}`,
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "蜃気楼",
          credits: [],
          tags: [
            {
              tag_id: "tag-47",
              source_id: "s0",
              quote,
              reasoning:
                "The lyrics describe accepting disappointment while continuing forward, which establishes hope as a central theme.",
            },
          ],
        },
      ],
    }),
    [source],
    query,
    [
      {
        id: "tag-47",
        name: "希望",
        category: "歌詞テーマ",
        criterion: "歌詞が希望を主題とするという解説。",
      },
    ],
  );

  expect(
    missingDescriptorCategories([source], recordingUrl),
  ).not.toContain("lyric_theme");
  expect(
    missingDescriptorCategories([source], recordingUrl),
  ).toContain("mood");
  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-47", evidence_type: "direct" },
  ]);
});

it("uses only the cited lyric paragraph to recover a clipped lyric-theme label", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const paragraph =
    "歌詞では思い描いていた未来とは異なる現実を受け入れながらも、それでも前へ進もうとする意志を描写。儚さと希望が同居する世界観がリスナーそれぞれの記憶や感情を静かに呼び起こす。";
  const quote =
    "それでも前へ進もうとする意志を描写。儚さと希望が同居する世界観";
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼",
    content: `tayori - 蜃気楼\n\n${paragraph}`,
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "蜃気楼",
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: "蜃気楼",
          credits: [],
          tags: [
            {
              tag_id: "tag-47",
              source_id: "s0",
              quote,
              reasoning:
                "The lyrics describe continuing forward through a changed future, so hope is a supported theme.",
            },
          ],
        },
      ],
    }),
    [source],
    query,
    [
      {
        id: "tag-47",
        name: "希望",
        category: "歌詞テーマ",
        criterion: "歌詞が希望を主題とするという解説。",
      },
    ],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-47", evidence_type: "direct" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("retains complete identity and credit lines before long Japanese unspaced sentences", async () => {
  const { recordingWindows } = await import("../src/research/providers");
  const raw =
    "Blue Song official. Vocal: Alice. " +
    "これは公式の曲紹介です。".repeat(80);
  const excerpt = recordingWindows(raw);

  expect(excerpt).toContain("Blue Song official.");
  expect(excerpt).toContain("Vocal: Alice.");
});

it("keeps a singleton native metadata object out of ordinary credit prose after fitting", async () => {
  const { fitInferenceRequest, supportedAnalysis } = await import(
    "../src/research/providers"
  );
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: primarySource.metadata.endpoint,
    title: "Blue Song",
    author_name: "Vocal: Alice",
  };
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "Blue Song",
    content: JSON.stringify(metadata),
    metadata,
  };
  const body: any = {
    max_completion_tokens: 100,
    messages: [
      { role: "system", content: "Extract evidenced claims only." },
      {
        role: "user",
        content: JSON.stringify({
          query: { ...query, title: "Blue Song", artist_hint: null },
          sources: [source],
          tags: [],
        }),
      },
    ],
  };
  const fitted = fitInferenceRequest(body, [source]);
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "Blue Song",
          reference_url: recordingUrl,
          kind: "other",
          source_id: "s0",
          quote: "Blue Song",
          credits: [
            {
              name: "Alice",
              kind: "person",
              role: "vocalist",
              source_id: "s0",
              quote: "Vocal: Alice",
              aliases: [],
            },
          ],
          tags: [],
        },
      ],
    }),
    fitted.evidence,
    { ...query, title: "Blue Song", artist_hint: null },
    [],
  );

  expect(analysis.recordings[0].credits).toEqual([]);
  expect(analysis.review_warnings).toContain(
    "recording:0:credit:0:UNSUPPORTED_EVIDENCE",
  );
});

it("associates only exact song-scoped recording prose without trusting page titles or related tracks", async () => {
  const {
    associateOfficialReleaseEvidence,
    fitInferenceRequest,
    linkedDescriptionRecording,
    linkedRecording,
  } = await import("../src/research/providers");
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const articleUrl = "https://en.wikipedia.org/wiki/Scatman_(Ski-Ba-Bop-Ba-Dop-Bop)";
  const query = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const primary = {
    id: "s0",
    url: scatmanUrl,
    title: metadata.title,
    metadata,
    content: JSON.stringify(metadata),
  };
  const composition =
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a novelty synthpop dance song with a quirky Euro-NRG tone. As critics summarized, the lyrics contain portions of spoken word, rapping, and a "jaunty ragga" style of scatting, where Scatman John "bends his tongue to rapid, ear-popping effect". This is driven by the "hellacious" techno groove of its extremely-fast, pitter-pattering chintzy drum machine.';
  const rawArticle = [
    "## Composition",
    composition,
    "## Artist biography",
    "Scatman John released many songs and his artist bio describes an upbeat career.",
    "## Related tracks",
    '"Scatman\'s World" is a slow acoustic ballad unrelated to this recording.',
  ].join("\n\n");
  const japaneseArticle = {
    id: "s1",
    url: "https://ja.wikipedia.org/wiki/%E3%82%B9%E3%82%AD%E3%83%A3%E3%83%83%E3%83%88%E3%83%9E%E3%83%B3_(%E6%9B%B2)",
    title: "スキャットマン (曲) - Wikipedia",
    content:
      "「スキャットマン」（英語: Scatman (Ski-Ba-Bop-Ba-Dop-Bop)）は、スキャットマン・ジョンの楽曲である。ジョンのデビュー・シングルである。",
  };
  const alternate = {
    id: "s2",
    url: "https://example.com/scatman-extended-radio",
    title: "Scatman (Extended Radio Version)",
    content:
      '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop) Extended Radio Version" is a dance song by Scatman John.',
  };
  const article = {
    id: "s3",
    url: articleUrl,
    title: "Scatman (Ski-Ba-Bop-Ba-Dop-Bop) - Wikipedia",
    content: rawArticle,
  };
  const artistPage = {
    id: "s4",
    url: "https://example.com/artist/scatman-john",
    title: "Scatman John — artist profile",
    content: "Scatman John is an artist. Scatman's World is a dance song.",
  };
  const commentary = {
    id: "s5",
    url: "https://example.com/video-commentary/scatman",
    title: 'ONE HIT WONDERLAND: "Scatman" by Scatman John',
    content:
      "The host discusses Scatman John and the story behind his lyrics in this retrospective video.",
  };
  const spotify = {
    id: "s6",
    url: "https://open.spotify.com/track/1234567890123456789012",
    title: "Scatman (ski-ba-bop-ba-dop-bop) - song and lyrics by Scatman John",
    content: "United States. Crazy (feat. Scatman John).",
  };
  const misleadingSubtitle = {
    id: "s7",
    url: "https://example.com/scatman-different-song",
    title: "Scatman (Another Song)",
    content:
      '"Scatman (Another Song)" is a synthpop dance song by Scatman John.',
  };
  const associated = associateOfficialReleaseEvidence(
    [primary, japaneseArticle, alternate, article, artistPage, commentary, spotify, misleadingSubtitle],
    query,
    { [articleUrl]: rawArticle },
  );
  const bound = associated.find((source) => source.id === "s3")!;
  const fitted = fitInferenceRequest(
    {
      max_completion_tokens: 3200,
      messages: [
        { role: "system", content: "Use cited evidence only." },
        {
          role: "user",
          content: JSON.stringify({ query, sources: associated, tags: [] }),
        },
      ],
    },
    associated,
  );
  const fittedArticle = fitted.evidence.find((source) => source.id === "s3")!;

  expect(bound.recording_associations?.[0]).toMatchObject({
    provenance: "worker_verified_song_v1",
    basis: "exact_song_recording",
    reference_url: scatmanUrl,
    artist: "Scatman John",
    song_title: "Scatman (ski-ba-bop-ba-dop-bop)",
  });
  expect(linkedRecording(bound, scatmanUrl)).toBe(false);
  expect(linkedDescriptionRecording(bound, scatmanUrl)).toBe(true);
  expect(fitted.evidence.map((source) => source.id)).toEqual(["s0", "s3"]);
  expect(
    associated
      .slice(1)
      .filter((source) => source.id !== "s3")
      .filter((source) => source.recording_associations?.length)
      .map((source) => source.id),
  ).toEqual([]);
  expect(fittedArticle.content).toContain("novelty synthpop dance song");
  expect(fittedArticle.content).not.toContain("artist bio");
  expect(fittedArticle.content).not.toContain("Scatman's World");
});

it("exposes every supplied genre tag when genre evidence is supported", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const definitions = [
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion:
        "Webの説明・公式情報で「エレクトロ」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。",
    },
    {
      id: "tag-08",
      name: "ダンスポップ",
      category: "ジャンル",
      criterion:
        "Webの説明・公式情報で「ダンスポップ」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。",
    },
    {
      id: "tag-03",
      name: "ロック",
      category: "ジャンル",
      criterion: "ギターやドラム主体のロック演奏。",
    },
  ];
  const explicitDance = {
    id: "s1",
    url: "https://example.com/scatman",
    title: "Scatman composition",
    content:
      '\"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)\" is a novelty synthpop dance song driven by a techno groove.',
  };
  const eurodanceOnly = {
    ...explicitDance,
    content: '\"Scatman\" is an Eurodance song.',
  };

  expect(
    inferenceTagCandidates(definitions, [explicitDance], "https://example.com/scatman").map((tag) => tag.id),
  ).toEqual(["tag-07", "tag-08", "tag-03"]);
  expect(
    inferenceTagCandidates(definitions, [eurodanceOnly], "https://example.com/scatman").map((tag) => tag.id),
  ).toEqual([]);
});

it("rejects an exact-song association marker that was not derived from retained source text", async () => {
  const { associateOfficialReleaseEvidence, linkedDescriptionRecording } =
    await import("../src/research/providers");
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const query = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const primary = {
    id: "s0",
    url: scatmanUrl,
    title: metadata.title,
    metadata,
    content: JSON.stringify(metadata),
  };
  const source = {
    id: "s8",
    url: "https://example.com/scatman-profile",
    title: "Scatman (Ski-Ba-Bop-Ba-Dop-Bop) — artist profile",
    content: "Scatman John is an artist with an international discography.",
    recording_associations: [
      {
        provenance: "worker_verified_song_v1" as const,
        reference_url: scatmanUrl,
        basis: "exact_song_recording" as const,
        artist: "Scatman John",
        song_title: "Scatman (ski-ba-bop-ba-dop-bop)",
        identity_quote:
          '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a novelty synthpop dance song by Scatman John.',
        description_quote:
          '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a novelty synthpop dance song by Scatman John.',
      },
    ],
  };
  const checked = associateOfficialReleaseEvidence([primary, source], query)[1];

  expect(checked.recording_associations).toBeUndefined();
  expect(linkedDescriptionRecording(checked, scatmanUrl)).toBe(false);
});

it("does not import genre evidence from another named song later in the same paragraph", async () => {
  const {
    associateOfficialReleaseEvidence,
    inferenceTagCandidates,
    linkedDescriptionRecording,
  } =
    await import("../src/research/providers");
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const query = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const primary = {
    id: "s0",
    url: scatmanUrl,
    title: metadata.title,
    metadata,
    content: JSON.stringify(metadata),
  };
  const otherSongParagraphs = [
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a song by Scatman John. "Scatman\'s World" is a synthpop dance song.',
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a jazz song by Another Artist. "Scatman\'s World" is a synthpop dance song by Scatman John.',
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a song by Scatman John. Scatman’s World, which is a synthpop dance tune, was another hit.',
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a song by Scatman John, while "Scatman’s World" is a synthpop dance song.',
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a song by Scatman John. "World" is a synthpop dance track.',
  ];
  const tags = [
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion: "電子音やシンセ主体のサウンド。",
    },
    {
      id: "tag-08",
      name: "ダンスポップ",
      category: "ジャンル",
      criterion: "踊れるビートとポップなメロディの融合。",
    },
    {
      id: "tag-03",
      name: "ロック",
      category: "ジャンル",
      criterion: "ギターやドラム主体のロック演奏。",
    },
  ];

  for (const [index, content] of otherSongParagraphs.entries()) {
    const article = {
      id: `s${index + 1}`,
      url: `https://en.wikipedia.org/wiki/Scatman_fixture_${index + 1}`,
      title: "Scatman song description",
      content,
    };
    const checked = associateOfficialReleaseEvidence(
      [primary, article],
      query,
      { [article.url]: content },
    );

    expect(checked[1].recording_associations).toBeUndefined();
    expect(inferenceTagCandidates(tags, checked, scatmanUrl)).toEqual([]);
  }

  const mixedParagraph =
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a synthpop dance song by Scatman John. Scatman’s World, which is a heavy metal rock tune, was another hit.';
  const articleUrl = "https://en.wikipedia.org/wiki/Scatman_mixed_description";
  const article = {
    id: "s7",
    url: articleUrl,
    title: "Scatman song description",
    content: mixedParagraph,
  };
  const priorAssociation = {
    provenance: "worker_verified_song_v1" as const,
    reference_url: scatmanUrl,
    basis: "exact_song_recording" as const,
    artist: "Scatman John",
    song_title: "Scatman (ski-ba-bop-ba-dop-bop)",
    identity_quote: mixedParagraph,
    description_quote: mixedParagraph,
  };
  const revalidated = associateOfficialReleaseEvidence(
    [primary, { ...article, recording_associations: [priorAssociation] }],
    query,
    {},
    [article.id],
  );
  const scoped = revalidated[1].recording_associations?.find(
    (association) => association.provenance === "worker_verified_song_v1",
  );

  expect(scoped?.identity_quote).not.toContain("Scatman’s World");
  expect(scoped?.description_quote).not.toContain("Scatman’s World");
  expect(linkedDescriptionRecording(revalidated[1], scatmanUrl)).toBe(true);
  expect(inferenceTagCandidates(tags, revalidated, scatmanUrl).map((tag) => tag.id)).toEqual([
    "tag-07",
    "tag-08",
    "tag-03",
  ]);
});

it("keeps explicit tempo and vocal properties in selected-song continuations", async () => {
  const { associateOfficialReleaseEvidence, inferenceTagCandidates } =
    await import("../src/research/providers");
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const query = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const primary = {
    id: "s0",
    url: scatmanUrl,
    title: metadata.title,
    metadata,
    content: JSON.stringify(metadata),
  };
  const article = {
    id: "s1",
    url: "https://example.com/scatman-vocals-and-tempo",
    title: "Scatman description",
    content: [
      '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a song by Scatman John.',
      "The tempo is up-tempo.",
      "The vocals are clear and transparent.",
    ].join(" "),
  };
  const tags = [
    {
      id: "tag-32",
      name: "速い",
      category: "テンポ感",
      criterion: "速いテンポと説明される。",
    },
    {
      id: "tag-38",
      name: "透明感",
      category: "歌声の印象",
      criterion: "澄んだ透明な歌声の具体的な説明。",
    },
  ];
  const associated = associateOfficialReleaseEvidence(
    [primary, article],
    query,
    { [article.url]: article.content },
  );

  expect(inferenceTagCandidates(tags, associated, scatmanUrl).map((tag) => tag.id)).toEqual([
    "tag-32",
    "tag-38",
  ]);
});

it("accepts danceability from a song-specific techno groove and drum-machine description", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const query = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const quote =
    'This is driven by the "hellacious" techno groove of its extremely-fast, pitter-pattering chintzy drum machine.';
  const source = {
    id: "s0",
    url: scatmanUrl,
    title: "Scatman (Ski-Ba-Bop-Ba-Dop-Bop) Official Video HD - Scatman John",
    content: [
      '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a novelty synthpop dance song with a quirky Euro-NRG tone by Scatman John.',
      quote,
    ].join("\n\n"),
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: "Scatman",
          reference_url: scatmanUrl,
          kind: "other",
          source_id: "s0",
          quote: "Scatman (Ski-Ba-Bop-Ba-Dop-Bop)",
          credits: [],
          tags: [
            {
              tag_id: "tag-28",
              source_id: "s0",
              quote,
              reasoning:
                "The techno groove and pitter-pattering drum machine provide an energetic dance rhythm for the song.",
            },
          ],
        },
      ],
    }),
    [source],
    query,
    [
      {
        id: "tag-28",
        name: "ダンサブル",
        category: "勢い",
        criterion: "ダンサブルなビートやグルーヴを感じる演奏。",
      },
    ],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-28", source_id: "s0", evidence_type: "semantic_inference" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("restricts the response tag ID enum to candidates that survive evidence fitting", async () => {
  const { fitInferenceRequest, knownIdentitySchema } = await import(
    "../src/research/providers"
  );
  const source = {
    ...primarySource,
    content:
      `${primarySource.content}\n\nAn electronic synthpop dance song with an up-tempo beat.`,
  };
  const descriptionSource = {
    id: "s3",
    url: "https://example.com/mirage-description",
    title: "蜃気楼 genre description",
    content: `Selected recording: ${recordingUrl}\n\nAn electronic synthpop dance song with an up-tempo beat.`,
  };
  const definitions = [
    {
      id: "tag-07",
      name: "エレクトロ",
      category: "ジャンル",
      criterion: "電子音やシンセ主体のサウンド。",
    },
    {
      id: "tag-08",
      name: "ダンスポップ",
      category: "ジャンル",
      criterion: "踊れるビートとポップなメロディの融合。",
    },
    {
      id: "tag-14",
      name: "切ない",
      category: "雰囲気",
      criterion: "悲しさや胸が締めつけられる曲調。",
    },
  ];
  const body: any = {
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "song_evidence",
        strict: true,
        schema: knownIdentitySchema([source, descriptionSource], query),
      },
    },
    messages: [
      { role: "system", content: "Return only supplied tag IDs." },
      {
        role: "user",
        content: JSON.stringify({ query, sources: [source, descriptionSource], tags: definitions }),
      },
    ],
  };
  const fitted = fitInferenceRequest(body, [source, descriptionSource]);
  const input = JSON.parse(fitted.body.messages[1].content);
  const recordingSchema =
    fitted.body.response_format.json_schema.schema.properties.recordings.items
      .properties;
  const tagSchema = recordingSchema.tags;

  expect(input.tags.map((tag: any) => tag.id)).toEqual(["tag-07", "tag-08"]);
  expect(tagSchema.items.properties.tag_id.enum).toEqual(["tag-07", "tag-08"]);
  expect(recordingSchema.title.enum).toBeUndefined();
  expect(recordingSchema.reference_url.enum).toEqual([recordingUrl]);
  expect(recordingSchema.source_id.enum).toEqual(["s0"]);
  expect(recordingSchema.quote.enum).toEqual([source.metadata.title]);
  expect(recordingSchema.credits.items.properties.name.enum).toBeUndefined();
  expect(recordingSchema.credits.items.properties.quote.enum).toBeUndefined();
  expect(recordingSchema.credits.items.properties.source_id.enum).toBeUndefined();
  expect(recordingSchema.tags.items.properties.source_id.enum).toBeUndefined();
  expect(input.sources.map((item: any) => item.id)).toEqual(["s0", "s3"]);
  const { supportedAnalysis } = await import("../src/research/providers");
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [
        {
          title: query.title,
          reference_url: recordingUrl,
          kind: "original",
          source_id: "s0",
          quote: source.metadata.title,
          credits: [],
          tags: [],
        },
      ],
    }),
    [source, descriptionSource],
    query,
    definitions,
  );
  expect(analysis.recordings[0].reference_url).toBe(recordingUrl);
});

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

it("expands candidates to every active tag in an evidence-supported category", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const definitions = [
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
  ];
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼 tempo description",
    content: "The track is extremely-fast, with pitter-pattering drums.",
  };

  expect(
    inferenceTagCandidates(definitions, [source], recordingUrl).map((tag) => tag.id),
  ).toEqual(["tag-30", "tag-31", "tag-32"]);
});

it("does not include tags from categories without evidence", async () => {
  const { inferenceTagCandidates } = await import("../src/research/providers");
  const definitions = [
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
  ];
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼 tempo description",
    content: "The track is extremely-fast, with pitter-pattering drums.",
  };

  expect(
    inferenceTagCandidates(definitions, [source], recordingUrl).map((tag) => tag.id),
  ).not.toContain("tag-13");
});

it("keeps the response tag enum limited to evidence-supported categories", async () => {
  const { fitInferenceRequest, knownIdentitySchema } = await import(
    "../src/research/providers"
  );
  const definitions = [
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
    { id: "tag-13", name: "明るい", category: "雰囲気", criterion: "明るく前向きな曲調。" },
  ];
  const source = {
    id: "s0",
    url: recordingUrl,
    title: "蜃気楼 tempo description",
    content: "蜃気楼 is extremely-fast, with pitter-pattering drums.",
  };
  const body: any = {
    max_completion_tokens: 200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "song_evidence",
        strict: true,
        schema: knownIdentitySchema([source], query),
      },
    },
    messages: [
      { role: "system", content: "Use supplied evidence only." },
      {
        role: "user",
        content: JSON.stringify({ query, sources: [source], tags: definitions }),
      },
    ],
  };

  const fitted = fitInferenceRequest(body, [source]);
  const input = JSON.parse(fitted.body.messages[1].content);
  const tagSchema =
    fitted.body.response_format.json_schema.schema.properties.recordings.items
      .properties.tags;

  expect(input.tags.map((tag: any) => tag.id)).toEqual(["tag-30", "tag-31", "tag-32"]);
  expect(tagSchema.items.properties.tag_id.enum).toEqual(["tag-30", "tag-31", "tag-32"]);
  expect(tagSchema.maxItems).toBe(12);
  expect(fitted.evidence[0].content).toContain("extremely-fast");
});

it("fits expanded category candidates without dropping the supporting Scatman quote", async () => {
  const { fitInferenceRequest, knownIdentitySchema } = await import(
    "../src/research/providers"
  );
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const scatmanQuery = {
    title: "Scatman",
    artist_hint: "Scatman John",
    reference_url: scatmanUrl,
  };
  const quote =
    'This is driven by the "hellacious" techno groove of its extremely-fast, pitter-pattering chintzy drum machine.';
  const source = {
    id: "s0",
    url: scatmanUrl,
    title: "Scatman",
    content: `Scatman by Scatman John.\n\n${quote}`,
  };
  const definitions = [
    { id: "tag-24", name: "軽快", category: "勢い", criterion: "軽やかで弾むリズム。" },
    { id: "tag-28", name: "ダンサブル", category: "勢い", criterion: "ダンサブルなビートやグルーヴを感じる演奏。" },
    { id: "tag-30", name: "ゆったり", category: "テンポ感", criterion: "ゆっくりしたテンポ。" },
    { id: "tag-31", name: "中程度", category: "テンポ感", criterion: "中程度のテンポ。" },
    { id: "tag-32", name: "速い", category: "テンポ感", criterion: "速いテンポと説明される。" },
  ];
  const body: any = {
    max_completion_tokens: 200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "song_evidence",
        strict: true,
        schema: knownIdentitySchema([source], scatmanQuery),
      },
    },
    messages: [
      { role: "system", content: "Use supplied evidence only." },
      {
        role: "user",
        content: JSON.stringify({ query: scatmanQuery, sources: [source], tags: definitions }),
      },
    ],
  };

  const fitted = fitInferenceRequest(body, [source]);
  const input = JSON.parse(fitted.body.messages[1].content);
  expect(input.tags.map((tag: any) => tag.id)).toEqual([
    "tag-24",
    "tag-28",
    "tag-30",
    "tag-31",
    "tag-32",
  ]);
  expect(fitted.evidence[0].content).toContain(quote);
});

it("accepts extremely-fast as semantic evidence for 速い", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The track runs at an extremely-fast pace with pitter-pattering drums.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning:
            "The extremely-fast pace directly entails the selected 速い tempo criterion for this track.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-32", evidence_type: "semantic_inference" },
  ]);
  expect(analysis.review_warnings).toEqual([]);
});

it("accepts jaunty rhythmic evidence for 軽快 without a seed-regex match", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The song moves with a jaunty, springing rhythm throughout the performance.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-24",
    name: "軽快",
    category: "勢い",
    criterion: "軽やかで弾むリズム。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning:
            "The jaunty springing rhythm entails the 軽快 tag by describing a light, lively rhythmic performance.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-24", evidence_type: "semantic_inference" },
  ]);
});

it("marks explicit seed-profile wording as direct evidence", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The song has a fast tempo throughout the arrangement.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning: "The explicit fast tempo wording directly satisfies the selected 速い tempo criterion.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toMatchObject([
    { tag_id: "tag-32", evidence_type: "direct" },
  ]);
});

it("rejects hedged or unanchored semantic reasoning", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The track runs at an extremely-fast pace with pitter-pattering drums.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const recording = (reasoning: string) => ({
    title: "蜃気楼",
    reference_url: recordingUrl,
    kind: "original",
    source_id: "s0",
    quote: "tayori - 蜃気楼 (Official Video)",
    credits: [],
    tags: [{ tag_id: tag.id, source_id: "s0", quote, reasoning }],
  });
  const hedged = supportedAnalysis(
    JSON.stringify({
      recordings: [recording("The pace maybe indicates the selected 速い tempo tag, but the evidence is uncertain.")],
    }),
    [source],
    query,
    [tag],
  );
  const unanchored = supportedAnalysis(
    JSON.stringify({
      recordings: [recording("The exact quote gives a concrete tempo description for the recording and its performance.")],
    }),
    [source],
    query,
    [tag],
  );

  expect(hedged.recordings[0].tags).toEqual([]);
  expect(unanchored.recordings[0].tags).toEqual([]);
});

it("rejects negated speed evidence", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The track is not fast in pace despite the frantic visual editing.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-32",
    name: "速い",
    category: "テンポ感",
    criterion: "速いテンポと説明される。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning: "The sentence discusses speed, but its negated wording cannot establish the 速い tempo tag.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});

it("does not infer mood from lyric-theme evidence", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const quote = "The lyrics describe a bright future and cheerful hope after hardship.";
  const source = { ...primarySource, content: `${primarySource.content}\n\n${quote}` };
  const tag = {
    id: "tag-13",
    name: "明るい",
    category: "雰囲気",
    criterion: "明るく前向きな曲調。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote,
          reasoning: "The bright lyrical idea would otherwise appear related to the 明るい mood tag.",
        }],
      }],
    }),
    [source],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});

it("does not infer voice impression from a bare vocalist credit", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const tag = {
    id: "tag-38",
    name: "透明感",
    category: "歌声の印象",
    criterion: "澄んだ透明な歌声の具体的な記述。",
  };
  const analysis = supportedAnalysis(
    JSON.stringify({
      recordings: [{
        title: "蜃気楼",
        reference_url: recordingUrl,
        kind: "original",
        source_id: "s0",
        quote: "tayori - 蜃気楼 (Official Video)",
        credits: [{
          name: "isui",
          kind: "person",
          role: "vocalist",
          source_id: "s0",
          quote: "Vocal: isui",
          aliases: [],
        }],
        tags: [{
          tag_id: tag.id,
          source_id: "s0",
          quote: "Vocal: isui",
          reasoning: "The vocalist credit alone should not establish the 透明感 voice-impression tag.",
        }],
      }],
    }),
    [primarySource],
    query,
    [tag],
  );

  expect(analysis.recordings[0].tags).toEqual([]);
});
