import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import {
  runResearchQueue as run,
  reserveCredits as reserve,
} from "../src/research/runner";
import { newRow, allRows } from "../src/store";
import { researchJob, safeUrl, candidates, songDetail } from "../src/catalog";
import { queueTagResearch } from "../src/record-research";
import type {
  WorkerEnv,
  ResearchJob,
  CreditRole,
  Version,
} from "../../shared/contracts";
import { registerRuntimeTransport } from "./miniflare-transport";
let mf: Miniflare, db: D1Database;
let closeTransport: () => Promise<void>;
let calls: string[];
let model: any;
const url = "https://www.youtube.com/watch?v=abcdefghijk";
const evidence =
  "Blue Song official. Vocal: Alice / アリス. Music: Bob. 人の歌声。";
const env = () =>
  ({
    DB: db,
    GROQ_API_KEY: "fixture-groq",
    TAVILY_API_KEY: "fixture-tavily",
  }) as WorkerEnv;
const json = (v: unknown, status = 200) => Response.json(v, { status });
let groqStatus = 200;
const provider = (async (input: any, init: any) => {
  const target = String(input);
  calls.push(target);
  expect(new Headers(init.headers).get("User-Agent")).toBeTruthy();
  if (target.endsWith("/usage"))
    return json({
      account: {
        current_plan: "Researcher",
        plan_usage: 0,
        plan_limit: 1000,
        paygo_usage: 0,
      },
      key: { usage: 0, limit: 1000 },
    });
  if (target.endsWith("/search")) {
    const b = JSON.parse(init.body);
    expect(b.search_depth).toBe("basic");
    expect(b.auto_parameters).toBe(false);
    return json({
      results: [{ url, title: "Blue Song official", content: evidence }],
    });
  }
  if (target.endsWith("/extract"))
    return json({ results: [{ url, raw_content: evidence }] });
  return groqStatus === 200
    ? json({
        choices: [
          {
            message: {
              content:
                typeof model === "string" ? model : JSON.stringify(model),
            },
          },
        ],
      })
    : json({ error: "fixture" }, groqStatus);
}) as typeof fetch;
async function insert(table: string, row: any) {
  await db
    .prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`)
    .bind(row.id, JSON.stringify(row))
    .run();
  return row;
}
async function answer(
  title = "Blue Song",
  reference_url: string | null = null,
) {
  const p = await insert("participants", newRow({ name: crypto.randomUUID() }));
  const r = await insert(
    "responses",
    newRow({
      participant_id: p.id,
      version_id: null,
      unresolved_title: title,
      reference_url,
      artist_hint: null,
      record_date: "2026-09-30",
    }),
  );
  await insert("research_jobs", researchJob(null, r));
  return r;
}
async function drain(n = 25) {
  for (let i = 0; i < n; i++) await run(env(), undefined, provider);
}
async function wake() {
  for (const j of await allRows(db, "research_jobs"))
    await db
      .prepare("UPDATE research_jobs SET data=? WHERE id=?")
      .bind(
        JSON.stringify({
          ...j,
          next_attempt_at: "2000-01-01T00:00:00Z",
          lease_until: null,
        }),
        j.id,
      )
      .run();
}
async function createRuntime() {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
    }),
  );
  closeTransport = await registerRuntimeTransport(mf);
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
}
beforeAll(createRuntime);
let fixtureRuns = 0;
beforeEach(async () => {
  // Periodic real runtime disposal also releases the bounded fixture pool.
  if (++fixtureRuns % 20 === 0) {
    await mf.dispose();
    await closeTransport();
    await createRuntime();
  }
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .all<{ name: string }>();
  for (const t of tables.results)
    await db.exec(`DROP TABLE IF EXISTS ${t.name}`);
  for (const f of (await readdir("worker/schema"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile(`worker/schema/${f}`, "utf8"))
        .replace(/--[^\n]*\n/g, "")
        .split("\n")
        .filter((l) => l.trim())
        .join("\n"),
    );
  calls = [];
  groqStatus = 200;
  model = {
    recordings: [
      {
        title: "Blue Song",
        reference_url: url,
        kind: "original",
        source_id: "s0",
        quote: "Blue Song official",
        credits: [
          {
            name: "Alice",
            kind: "person",
            role: "vocalist",
            source_id: "s0",
            quote: "Vocal: Alice",
            aliases: [{ name: "アリス", quote: "Alice / アリス" }],
          },
        ],
        tags: [
          {
            tag_id: "tag-33",
            source_id: "s0",
            quote: "人の歌声",
            reasoning:
              "人の歌声という公式記述が、人の歌声という歌声構成タグを直接裏付けている。",
          },
        ],
      },
    ],
  };
});
afterAll(async () => {
  await mf.dispose();
  await closeTransport();
});
it("retains native Mirage candidates when real title-plus-artist inference repeatedly returns empty", async () => {
  const fixture = JSON.parse(
    await readFile("worker/tests/research-mirage-fixture.json", "utf8"),
  );
  const r = await answer(fixture.query.title);
  const originalJob = (await allRows(db, "research_jobs"))[0];
  await db
    .prepare("UPDATE responses SET data=? WHERE id=?")
    .bind(JSON.stringify({ ...r, artist_hint: "tayori" }), r.id)
    .run();
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...originalJob,
        stage: "infer",
        query: fixture.query,
        evidence: fixture.evidence,
      }),
      originalJob.id,
    )
    .run();
  const f = (async () =>
    json({
      choices: [{ message: { content: fixture.raw_model } }],
    })) as typeof fetch;
  await measuredLiveDrain(f);
  const job = (await allRows(db, "research_jobs")).find(
    (j) => j.response_id === r.id,
  )!;
  expect(job.stage).toBe("done");
  expect(job.status).toBe("needs_review");
  expect(job.candidates).toHaveLength(1);
  expect(job.candidates[0]).toMatchObject({
    reference_url: "https://www.youtube.com/watch?v=aLpQ5RX0quU",
    kind: "other",
  });
  expect(job.candidates[0].title).toContain("蜃気楼");
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
  expect(await allRows(db, "credits")).toMatchObject([
    { role: "uploader", confirmed: true },
  ]);
  expect((await allRows(db, "entities"))[0].name).toBe("tayori wmj");
  expect((await allRows(db, "research_results"))[0].raw_model).toBe(
    fixture.raw_model,
  );
});

it.each([
  "no-artist",
  "wrong-artist",
  "wrong-native-title",
  "wrong-endpoint",
  "missing-metadata",
  "wrong-url",
])(
  "does not recover empty inference from untrusted or unmatched native identity: %s",
  async (mode) => {
    const { supportedAnalysis } = await import("../src/research/providers");
    const fixture = JSON.parse(
      await readFile("worker/tests/research-mirage-fixture.json", "utf8"),
    );
    if (mode === "no-artist") fixture.query.artist_hint = null;
    if (mode === "wrong-artist")
      fixture.query.artist_hint = "unrelated performer";
    if (mode === "wrong-native-title")
      fixture.evidence[0].metadata.title = "tayori - Another Song";
    if (mode === "wrong-endpoint")
      fixture.evidence[0].metadata.endpoint = "https://example.com/oembed";
    if (mode === "missing-metadata") delete fixture.evidence[0].metadata;
    if (mode === "wrong-url")
      fixture.query.reference_url =
        "https://www.youtube.com/watch?v=abcdefghijk";
    expect(() =>
      supportedAnalysis(fixture.raw_model, fixture.evidence, fixture.query, []),
    ).toThrow("NO_SUPPORTED_RECORDINGS");
  },
);

it("keeps multiple matching native versions separate for owner selection after empty inference", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const fixture = JSON.parse(
    await readFile("worker/tests/research-mirage-fixture.json", "utf8"),
  );
  const source = structuredClone(fixture.evidence[0]);
  source.id = "second";
  source.url = "https://www.youtube.com/watch?v=abcdefghijk";
  source.metadata.endpoint =
    "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&format=json";
  source.metadata.title = "tayori - 蜃気楼 (Live)";
  source.content = JSON.stringify(source.metadata);
  const analysis = supportedAnalysis(
    fixture.raw_model,
    [fixture.evidence[0], source],
    fixture.query,
    [],
  );
  expect(analysis.recordings.map((r) => r.reference_url)).toEqual([
    "https://www.youtube.com/watch?v=aLpQ5RX0quU",
    "https://www.youtube.com/watch?v=abcdefghijk",
  ]);
  expect(
    analysis.recordings.every((r) => r.kind === "other" && !r.original),
  ).toBe(true);
});

it("resolves unknown title with recording-specific sources, credits, aliases and feed", async () => {
  const r = await answer();
  await drain();
  const saved = (await allRows(db, "responses")).find((x) => x.id === r.id)!;
  expect(saved.version_id).toBeTruthy();
  expect((await allRows(db, "credits"))[0]).toMatchObject({
    confirmed: true,
    role: "vocalist",
  });
  expect((await allRows(db, "aliases"))[0].name).toBe("アリス");
  const c = (await allRows(db, "credits"))[0];
  expect(
    (await allRows(db, "sources")).find((s) => s.id === c.source_id)
      ?.version_id,
  ).toBe(saved.version_id);
  expect(
    (
      await db
        .prepare(
          "SELECT table_name FROM changes WHERE table_name IN ('aliases','credits','research_results')",
        )
        .all()
    ).results.length,
  ).toBeGreaterThanOrEqual(3);
});
it("manual candidate lookup publishes choices without replacing an already saved recording", async () => {
  const r = await answer();
  await drain();
  const saved = (await allRows(db, "responses"))[0];
  const old = (await allRows(db, "research_jobs")).find(
    (j) => j.response_id === r.id,
  )!;
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...researchJob(null, saved),
        id: old.id,
        revision: old.revision,
        purpose: "candidate_lookup",
        response_revision: saved.revision,
        query: { title: "Blue Song", artist_hint: null, reference_url: null },
      }),
      old.id,
    )
    .run();
  await drain();
  const lookup = (await allRows(db, "research_jobs")).find(
    (j) => j.response_id === r.id,
  )!;
  expect(lookup.stage).toBe("done");
  expect(lookup.candidates).toHaveLength(1);
  expect((await allRows(db, "responses"))[0]).toEqual(saved);
});
it("candidate publication preserves a pending independent tag job", async () => {
  const { publishCatalog } = await import("../src/research/publish");
  const r = await answer();
  await drain();
  const saved = (await allRows(db, "responses"))[0];
  const versionJob = (await allRows(db, "research_jobs")).find(
    (j) => j.version_id === saved.version_id,
  )!;
  const pending = {
    ...versionJob,
    status: "queued" as const,
    purpose: "tag_enrichment" as const,
    stage: "search" as const,
  };
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(JSON.stringify(pending), pending.id)
    .run();
  const lookup = (await allRows(db, "research_jobs")).find(
    (j) => j.response_id === r.id,
  )!;
  const restarted = {
    ...lookup,
    stage: "catalog" as const,
    purpose: "candidate_lookup" as const,
    catalog_cursor: 0,
    candidates: [],
  };
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(JSON.stringify(restarted), lookup.id)
    .run();
  await publishCatalog(env(), restarted, model);
  expect(
    (await allRows(db, "research_jobs")).find((j) => j.id === pending.id),
  ).toEqual(pending);
});

it("restarts a failed shared version job with the current analysis version and no stale descriptor state", async () => {
  const { publishCatalog } = await import("../src/research/publish");
  const work = await insert(
    "works",
    newRow({ title: "Blue Song", manual_lock: false }),
  );
  const version = await insert(
    "versions",
    newRow({
      work_id: work.id,
      title: "Blue Song",
      kind: "original",
      reference_url: url,
      uploader_entity_id: null,
      research_status: "needs_review",
      manual_lock: false,
    }),
  );
  const failed = {
    ...researchJob(version),
    version_id: version.id,
    status: "needs_review" as const,
    stage: "done" as const,
    analysis_version: "1",
    dictionary_version: "old-dictionary",
    descriptive_category: "voice",
    descriptive_status: "unavailable" as const,
    descriptive_source_ids: ["s1"],
    descriptive_coverage: { genre_sound: "complete" as const, voice: "unavailable" as const },
  };
  await insert("research_jobs", failed);
  const evidence = [{ id: "s0", url, title: "Blue Song", content: "Blue Song" }];
  const lookup = {
    ...researchJob(null),
    stage: "catalog" as const,
    purpose: "candidate_lookup" as const,
    analysis_version: "2",
    dictionary_version: "current-dictionary",
    evidence,
  };
  await insert("research_jobs", lookup);
  const analysis = {
    recordings: [
      {
        title: "Blue Song",
        reference_url: url,
        kind: "original" as const,
        source_id: "s0",
        quote: "Blue Song",
        credits: [],
        tags: [],
      },
    ],
    raw_model: "{}",
    review_warnings: [],
  };

  await publishCatalog(env(), lookup, analysis);

  const restarted = (await allRows(db, "research_jobs")).find(
    (job) => job.id === failed.id,
  )!;
  expect(restarted).toMatchObject({
    status: "queued",
    stage: "metadata",
    analysis_version: "2",
    dictionary_version: "current-dictionary",
  });
  expect(restarted.descriptive_status).toBeUndefined();
  expect(restarted.descriptive_category).toBeUndefined();
  expect(restarted.descriptive_source_ids).toBeUndefined();
  expect(restarted.descriptive_coverage).toBeUndefined();
});

it("tag enrichment preserves the chosen recording identity and reports unsupported tags", async () => {
  const r = await answer();
  await drain();
  const v = (await allRows(db, "versions"))[0];
  const old = (await allRows(db, "research_jobs")).find(
    (j) => j.version_id === v.id,
  )!;
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...old,
        purpose: "tag_enrichment",
        query: { title: "Blue Song", artist_hint: null, reference_url: url },
        stage: "infer",
        status: "queued",
        candidates: [],
        catalog_cursor: 0,
        metadata_cursor: 0,
      }),
      old.id,
    )
    .run();
  model.recordings[0].title = "Blue Song official";
  model.recordings[0].tags = [];
  await drain();
  expect((await allRows(db, "versions"))[0].title).toBe("Blue Song");
  const job = (await allRows(db, "research_jobs")).find(
    (j) => j.id === old.id,
  )!;
  expect(job.status).toBe("needs_review");
  expect(job.analysis?.review_warnings).toContain(
    "NO_SUPPORTED_TAG_DESCRIPTIONS",
  );
});
it.each([
  "not json",
  "unlisted tag",
  "unsupported credit",
  "unsupported source",
  "mismatch",
])("keeps unsupported %s pending without claims", async (mode) => {
  await answer();
  if (mode === "not json") model = "bogus";
  if (mode === "unlisted tag") model.recordings[0].tags[0].tag_id = "invented";
  if (mode === "unsupported credit")
    model.recordings[0].credits[0].quote = "Vocal: Fake";
  if (mode === "unsupported source") model.recordings[0].source_id = "s99";
  if (mode === "mismatch") model.recordings[0].title = "Different song";
  await drain();
  expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
  if (["unlisted tag", "unsupported credit"].includes(mode))
    expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  else expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  expect(await allRows(db, "credits")).toHaveLength(
    mode === "unlisted tag" ? 1 : 0,
  );
});
it("publishes multiple candidates without merging titles", async () => {
  await answer();
  model.recordings.push({
    ...model.recordings[0],
    reference_url: "https://www.youtube.com/watch?v=zyxwvutsrqp",
  }); // second identity needs matching evidence
  model.recordings[1].source_id = "s1";
  model.recordings[1].credits = [];
  model.recordings[1].tags = [];
  const multi = (async (i: any, b: any) =>
    String(i).endsWith("/search")
      ? json({
          results: [
            { url, title: "Blue Song", content: evidence },
            {
              url: "https://www.youtube.com/watch?v=zyxwvutsrqp",
              title: "Blue Song",
              content: evidence,
            },
          ],
        })
      : String(i).endsWith("/extract")
        ? json({
            results: [
              { url, raw_content: evidence },
              {
                url: "https://www.youtube.com/watch?v=zyxwvutsrqp",
                raw_content: evidence,
              },
            ],
          })
        : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, multi);
  const j = (await allRows(db, "research_jobs")).find((j) => j.response_id)!;
  expect(j.status).toBe("needs_review");
  expect(j.candidates).toHaveLength(2);
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
});
it("429 resumes inference from durable evidence without repeating search", async () => {
  await answer();
  groqStatus = 429;
  await drain();
  expect((await allRows(db, "research_jobs"))[0].last_error).toMatch(/429/);
  const search = calls.filter((x) => x.endsWith("/search")).length;
  groqStatus = 200;
  await wake();
  await drain();
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  expect(calls.filter((x) => x.endsWith("/search"))).toHaveLength(search);
});
it("reserves the 800 cap atomically in real D1", async () => {
  await insert(
    "usage",
    newRow({
      month: "2026-10",
      tavily_credits: 799,
      tavily_credit_cap: 800,
      groq_requests: 0,
      last_error: null,
    }),
  );
  const results = await Promise.allSettled([
    reserve(env(), 1, 1000),
    reserve(env(), 1, 1000),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(800);
});
it("does not spend beyond actual provider remaining quota", async () => {
  expect(
    await Promise.allSettled([reserve(env(), 1, 0)]).then((x) => x[0].status),
  ).toBe("rejected");
  expect(await allRows(db, "usage")).toHaveLength(0);
});
it("concurrent leases execute one search", async () => {
  await answer();
  await Promise.all([
    run(env(), undefined, provider),
    run(env(), undefined, provider),
  ]);
  expect(calls.filter((x) => x.endsWith("/search")).length).toBeLessThanOrEqual(
    1,
  );
  await drain();
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
});
it("reuses canonical recording cache across new answers and preserves admin locks", async () => {
  const r = await answer();
  await drain();
  const v = (await allRows(db, "versions"))[0];
  expect(v).toBeTruthy();
  if (!v) return;
  await db
    .prepare("UPDATE versions SET data=? WHERE id=?")
    .bind(
      JSON.stringify({ ...v, title: "Admin title", manual_lock: true }),
      v.id,
    )
    .run();
  await answer("Blue Song", "https://youtu.be/abcdefghijk?t=15");
  const count = calls.length;
  await drain();
  expect(
    (await allRows(db, "responses")).every((x) => x.version_id === v.id),
  ).toBe(true);
  expect(calls).toHaveLength(count);
  expect((await allRows(db, "versions"))[0].title).toBe("Admin title");
});
it("rejects trailing-dot local hosts and normalizes URL catalog lookup", async () => {
  expect(() => safeUrl("https://localhost./x")).toThrow();
  const w = await insert(
    "works",
    newRow({ title: "Blue", manual_lock: false }),
  );
  await insert(
    "versions",
    newRow({
      work_id: w.id,
      title: "Blue",
      kind: "original",
      manual_lock: false,
      reference_url: url,
      uploader_entity_id: null,
      research_status: "complete",
    }),
  );
  expect(
    await candidates(db, "https://youtu.be/abcdefghijk?t=30"),
  ).toHaveLength(1);
});
it("validates artist hints before auto resolution", async () => {
  await answer("Blue Song");
  const r = (await allRows(db, "responses"))[0];
  await db
    .prepare(
      "UPDATE responses SET data=json_set(data,'$.artist_hint','Another artist') WHERE id=?",
    )
    .bind(r.id)
    .run();
  const j = (await allRows(db, "research_jobs"))[0];
  await db
    .prepare(
      "UPDATE research_jobs SET data=json_set(data,'$.query.artist_hint','Another artist') WHERE id=?",
    )
    .bind(j.id)
    .run();
  await drain();
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
});
it("reuses canonical search matches for repeated title-only answers", async () => {
  await answer();
  await drain();
  const searches = calls.filter((x) => x.endsWith("/search")).length;
  const groq = calls.filter((x) => x.endsWith("/completions")).length;
  await answer();
  await drain();
  expect(calls.filter((x) => x.endsWith("/search"))).toHaveLength(searches + 1);
  expect(calls.filter((x) => x.endsWith("/completions"))).toHaveLength(groq);
  expect((await allRows(db, "responses")).map((x) => x.version_id)).toEqual([
    (await allRows(db, "versions"))[0].id,
    (await allRows(db, "versions"))[0].id,
  ]);
});
it("keeps missing-configuration jobs pending without provider calls", async () => {
  await answer();
  await run({ DB: db }, undefined, provider);
  expect(calls).toHaveLength(0);
  expect((await allRows(db, "research_jobs"))[0].status).toBe("queued");
});
it("fails model downtime safely without losing answer or repeating searches", async () => {
  await answer();
  groqStatus = 503;
  await drain();
  expect((await allRows(db, "research_jobs"))[0]).toMatchObject({
    stage: "infer",
    status: "queued",
    last_error: "PROVIDER_HTTP_503",
  });
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  groqStatus = 200;
  await wake();
  await drain();
  expect(calls.filter((x) => x.endsWith("/search"))).toHaveLength(1);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
});
it("accepts nonliteral source-grounded dance and tempo tags with AI rationale", async () => {
  await answer();
  model.recordings[0].tags = [
    {
      tag_id: "tag-08",
      source_id: "s0",
      quote: "ポップなダンスチューン",
      reasoning:
        "ポップなダンスチューンという説明はポップとダンスを融合した特徴を述べており、ダンスポップの基準を満たす。",
    },
    {
      tag_id: "tag-32",
      source_id: "s0",
      quote: "アップテンポ",
      reasoning:
        "アップテンポという公式説明はテンポが高いことを示すため、速いというテンポ感の判定基準を満たす。",
    },
  ];
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/extract")
      ? json({
          results: [
            {
              url,
              raw_content: evidence + " ポップなダンスチューン。アップテンポ。",
            },
          ],
        })
      : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  expect(
    (await allRows(db, "tag_assignments")).map((x) => x.tag_id).sort(),
  ).toEqual(["tag-08", "tag-32"]);
  expect((await allRows(db, "tag_assignments"))[0].evidence).toContain(
    "AI判定",
  );
});
it("rejects title-only irrelevant tag evidence", async () => {
  await answer();
  model.recordings[0].tags = [
    {
      tag_id: "tag-08",
      source_id: "s0",
      quote: "Blue Song official",
      reasoning:
        "Blue Song officialだからダンスポップというタグに分類する。曲名からダンスが想像できるため。",
    },
  ];
  await drain();
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
});
it("links a cover to an explicitly evidenced original recording", async () => {
  const w = await insert(
    "works",
    newRow({ title: "Original song", manual_lock: false }),
  );
  const original = await insert(
    "versions",
    newRow({
      work_id: w.id,
      title: "Original song",
      kind: "original",
      manual_lock: false,
      reference_url: "https://www.youtube.com/watch?v=zyxwvutsrqp",
      uploader_entity_id: null,
      research_status: "complete",
    }),
  );
  await answer();
  const rel =
    "Cover of Original song https://www.youtube.com/watch?v=zyxwvutsrqp";
  model.recordings[0].kind = "cover";
  model.recordings[0].original = {
    title: "Original song",
    reference_url: original.reference_url,
    source_id: "s0",
    quote: rel,
  };
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/extract")
      ? json({ results: [{ url, raw_content: evidence + " " + rel }] })
      : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  const v = (await allRows(db, "versions")).find(
    (x) => x.reference_url === url,
  )!;
  expect(v.work_id).toBe(w.id);
  expect((await allRows(db, "responses"))[0].version_id).toBe(v.id);
});
it("preserves manually locked credits and tags during research replay", async () => {
  await answer();
  await drain();
  const v = (await allRows(db, "versions"))[0];
  const credit = (await allRows(db, "credits"))[0],
    tag = (await allRows(db, "tag_assignments"))[0];
  const lockedCredit = { ...credit, manual_lock: true, confirmed: false };
  const lockedTag = {
    ...tag,
    manual_lock: true,
    confirmed: false,
    evidence: "Admin rationale",
  };
  await db
    .prepare("UPDATE credits SET data=? WHERE id=?")
    .bind(JSON.stringify(lockedCredit), credit.id)
    .run();
  await db
    .prepare("UPDATE tag_assignments SET data=? WHERE id=?")
    .bind(JSON.stringify(lockedTag), tag.id)
    .run();
  const j = (await allRows(db, "research_jobs")).find(
    (j) => j.version_id === v.id,
  )!;
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...j,
        catalog_cursor: 0,
        response_id: null,
        version_id: v.id,
        stage: "infer",
        status: "queued",
        candidates: [],
        next_attempt_at: "2000-01-01T00:00:00Z",
      }),
      j.id,
    )
    .run();
  await drain();
  expect((await allRows(db, "credits"))[0]).toEqual(lockedCredit);
  expect((await allRows(db, "tag_assignments"))[0]).toEqual(lockedTag);
});
it("cached recording URL never silently overrides a contradictory title", async () => {
  await answer();
  await drain();
  const second = await answer("Different title", url);
  await drain();
  expect(
    (await allRows(db, "responses")).find((x) => x.id === second.id)
      ?.version_id,
  ).toBeNull();
});
it("bounds every invocation to D1 free query limits using real D1 transport", async () => {
  await answer();
  let max = 0;
  for (let i = 0; i < 25; i++) {
    let count = 0;
    const measured = new Proxy(db, {
      get(t, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = t.prepare(sql);
            function wrap(s: D1PreparedStatement): D1PreparedStatement {
              return new Proxy(s, {
                get(t, k) {
                  if (k === "bind")
                    return (...args: unknown[]) => wrap(t.bind(...args));
                  const fn = Reflect.get(t, k);
                  if (["first", "all", "run", "raw"].includes(String(k)))
                    return (...args: unknown[]) => {
                      count++;
                      return fn.apply(t, args);
                    };
                  return typeof fn === "function" ? fn.bind(t) : fn;
                },
              });
            }
            return wrap(statement);
          };
        if (key === "batch")
          return (s: D1PreparedStatement[]) => {
            count += s.length;
            return t.batch(s);
          };
        const v = Reflect.get(t, key);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await run({ ...env(), DB: measured }, undefined, provider);
    max = Math.max(max, count);
    expect(count).toBeLessThanOrEqual(50);
  }
  expect(max).toBeGreaterThan(10);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
});
it("publishes linked evidence in resumable batches below the D1 per-invocation limit", async () => {
  const work = await insert(
    "works",
    newRow({ title: "Blue Song", manual_lock: false }),
  );
  const version = await insert(
    "versions",
    newRow({
      work_id: work.id,
      title: "Blue Song",
      kind: "original",
      reference_url: url,
      uploader_entity_id: null,
      research_status: "running",
      manual_lock: false,
    }),
  );
  const linkedEvidence = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    url: index === 0 ? url : `https://example.com/song/${index}`,
    title: `Blue Song source ${index}`,
    content: `Blue Song official description ${index}. ${index ? url : ""}`,
  }));
  const selected = {
    ...researchJob(version),
    version_id: version.id,
    stage: "metadata" as const,
    analysis: {
      recordings: [
        {
          title: "Blue Song",
          reference_url: url,
          kind: "original" as const,
          source_id: "s0",
          quote: "Blue Song",
          credits: [],
          tags: [],
        },
      ],
      raw_model: "{}",
      review_warnings: [],
    },
    evidence: linkedEvidence,
    candidates: [{ ...version, work_title: version.title, credits: [] }],
    metadata_cursor: 0,
    metadata_source_cursor: 0,
  };
  await insert("research_jobs", selected);

  const countInvocation = async () => {
    let count = 0;
    const measured = new Proxy(db, {
      get(t, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = t.prepare(sql);
            function wrap(s: D1PreparedStatement): D1PreparedStatement {
              return new Proxy(s, {
                get(t, k) {
                  if (k === "bind")
                    return (...args: unknown[]) => wrap(t.bind(...args));
                  const fn = Reflect.get(t, k);
                  if (["first", "all", "run", "raw"].includes(String(k)))
                    return (...args: unknown[]) => {
                      count++;
                      return fn.apply(t, args);
                    };
                  return typeof fn === "function" ? fn.bind(t) : fn;
                },
              });
            }
            return wrap(statement);
          };
        if (key === "batch")
          return (statements: D1PreparedStatement[]) => {
            count += statements.length;
            return t.batch(statements);
          };
        const value = Reflect.get(t, key);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    await run({ ...env(), DB: measured }, undefined, provider);
    expect(count).toBeLessThanOrEqual(50);
    return count;
  };

  expect(await countInvocation()).toBeGreaterThan(0);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job.metadata_cursor).toBe(0);
  expect(job.metadata_source_cursor).toBe(4);
  expect(await allRows(db, "sources")).toHaveLength(4);

  await wake();
  expect(await countInvocation()).toBeGreaterThan(0);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.metadata_cursor).toBe(1);
  expect(job.metadata_source_cursor).toBe(0);
  expect(await allRows(db, "sources")).toHaveLength(8);
});
it("publishes the safe provider failure in administrator usage status", async () => {
  await answer();
  groqStatus = 503;
  await drain();
  expect((await allRows(db, "usage"))[0].last_error).toBe("PROVIDER_HTTP_503");
});
it("recovers expired leases with bounded crash attempts", async () => {
  await answer();
  const j = (await allRows(db, "research_jobs"))[0];
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...j,
        status: "running",
        attempts: 3,
        lease_until: "2000-01-01T00:00:00Z",
      }),
      j.id,
    )
    .run();
  await run(env(), undefined, provider);
  expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
  expect(calls).toHaveLength(0);
});
import { providerJson, ResearchError } from "../src/research/providers";
it("rejects provider payloads larger than the bounded response budget", async () => {
  await expect(
    providerJson(
      (async () => new Response("x".repeat(48001))) as typeof fetch,
      "https://api.tavily.com/search",
      "fixture",
      {},
    ),
  ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
});
it("bounds Groq requests below free TPM before transport", async () => {
  let sent = 0;
  await expect(
    providerJson(
      (async () => {
        sent++;
        return Response.json({});
      }) as typeof fetch,
      "https://api.groq.com/openai/v1/chat/completions",
      "fixture",
      {
        messages: [{ content: "大".repeat(8000) }],
        max_completion_tokens: 1600,
      },
    ),
  ).rejects.toMatchObject({ code: "GROQ_REQUEST_TOO_LARGE" });
  expect(sent).toBe(0);
});
it("supports HTTP-date Retry-After without producing invalid durable timestamps", async () => {
  try {
    await providerJson(
      (async () =>
        new Response("", {
          status: 429,
          headers: {
            "Retry-After": new Date(Date.now() + 120000).toUTCString(),
          },
        })) as typeof fetch,
      "https://api.groq.com/openai/v1/chat/completions",
      "fixture",
      {},
    );
    throw new Error("expected 429");
  } catch (e) {
    expect(e).toBeInstanceOf(ResearchError);
    expect(Number.isFinite((e as ResearchError).delay)).toBe(true);
    expect((e as ResearchError).delay).toBeGreaterThanOrEqual(60000);
  }
});
it("rejects an unrelated performer attribution as genre evidence", async () => {
  await answer();
  model.recordings[0].tags = [
    {
      tag_id: "tag-08",
      source_id: "s0",
      quote: "Vocal: Alice",
      reasoning:
        "Vocal: Aliceという歌唱者情報があるからダンスポップである。歌手名から踊れる曲だと想像してこの基準を満たす。",
    },
  ];
  await drain();
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
});
it("fills canonical recording and uploader metadata on an unlocked known version", async () => {
  const w = await insert(
    "works",
    newRow({ title: "Blue Song", manual_lock: false }),
  );
  const v = await insert(
    "versions",
    newRow({
      work_id: w.id,
      title: "Blue Song",
      kind: "other",
      manual_lock: false,
      reference_url: null,
      uploader_entity_id: null,
      research_status: "queued",
    }),
  );
  await insert("research_jobs", researchJob(v));
  model.recordings[0].credits = [
    {
      name: "Alice",
      kind: "channel",
      role: "uploader",
      source_id: "s0",
      quote: "Channel: Alice",
      aliases: [],
    },
  ];
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/extract")
      ? json({ results: [{ url, raw_content: evidence + " Channel: Alice" }] })
      : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  const saved = (await allRows(db, "versions"))[0];
  expect(saved.reference_url).toBe(url);
  expect(saved.kind).toBe("original");
  expect(saved.uploader_entity_id).toBe((await allRows(db, "entities"))[0].id);
});
it("retains a shared version job when the unresolved response is removed mid-research", async () => {
  const r = await answer();
  for (let i = 0; i < 4; i++) await run(env(), undefined, provider);
  const v = (await allRows(db, "versions"))[0];
  expect(v).toBeTruthy();
  const jobs = await allRows(db, "research_jobs");
  expect(
    jobs.some((j) => j.version_id === v.id && j.response_id === null),
  ).toBe(true);
  await db
    .prepare(
      "UPDATE responses SET data=json_set(data,'$.deleted_at',?) WHERE id=?",
    )
    .bind(new Date().toISOString(), r.id)
    .run();
  await db
    .prepare(
      "UPDATE research_jobs SET data=json_set(data,'$.deleted_at',?) WHERE json_extract(data,'$.response_id')=?",
    )
    .bind(new Date().toISOString(), r.id)
    .run();
  await drain();
  expect((await allRows(db, "versions"))[0].research_status).toBe("complete");
  expect(
    (await allRows(db, "research_jobs")).find((j) => j.version_id === v.id)
      ?.status,
  ).toBe("complete");
});
it("accepts the real free account when per-key limit is null", async () => {
  await answer();
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/usage")
      ? json({
          account: {
            current_plan: "Researcher",
            plan_usage: 0,
            plan_limit: 1000,
            paygo_usage: 0,
          },
          key: { usage: 0, limit: null },
        })
      : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
});
it("keeps refreshed claims tied to the actual stored evidence snapshot", async () => {
  await answer();
  await drain();
  const v = (await allRows(db, "versions"))[0];
  const j = (await allRows(db, "research_jobs")).find(
    (j) => j.version_id === v.id,
  )!;
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...j,
        status: "queued",
        stage: "extract",
        catalog_cursor: 0,
        candidates: [],
        metadata_cursor: 0,
        next_attempt_at: "2000-01-01T00:00:00Z",
      }),
      j.id,
    )
    .run();
  model.recordings[0].tags = [
    {
      tag_id: "tag-08",
      source_id: "s0",
      quote: "ポップなダンスチューン",
      reasoning:
        "ポップなダンスチューンという公式説明はポップとダンスを融合する特徴を示しており、ダンスポップの定義を満たす。",
    },
  ];
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/extract")
      ? json({
          results: [{ url, raw_content: evidence + " ポップなダンスチューン" }],
        })
      : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  const tag = (await allRows(db, "tag_assignments")).find(
    (t) => t.tag_id === "tag-08",
  )!;
  expect(tag).toBeTruthy();
  expect(
    (await allRows(db, "sources")).find((s) => s.id === tag.source_id)?.excerpt,
  ).toContain("ポップなダンスチューン");
});
import { save } from "../src/research/state";
it("atomically rejects a credit whose source belongs to another recording", async () => {
  await answer();
  await drain();
  const v = (await allRows(db, "versions"))[0],
    j = (await allRows(db, "research_jobs")).find(
      (j) => j.version_id === v.id,
    )!,
    entity = (await allRows(db, "entities"))[0];
  const w = await insert(
    "works",
    newRow({ title: "Other recording", manual_lock: false }),
  );
  const other = await insert(
    "versions",
    newRow({
      ...v,
      id: undefined,
      work_id: w.id,
      reference_url: "https://www.youtube.com/watch?v=zyxwvutsrqp",
    }),
  );
  const source = await insert(
    "sources",
    newRow({
      version_id: other.id,
      url: other.reference_url,
      title: "Other",
      excerpt: "Other Music:Alice",
      checked_at: new Date().toISOString(),
      origin: "research",
    }),
  );
  const c = newRow({
    version_id: v.id,
    entity_id: entity.id,
    role: "composer",
    source_id: source.id,
    confirmed: true,
    manual_lock: false,
  });
  await expect(
    save(env(), j, {}, [{ table: "credits", before: null, after: c }]),
  ).rejects.toMatchObject({ status: 409 });
  expect((await allRows(db, "credits")).some((x) => x.id === c.id)).toBe(false);
});
import { validateAnalysis, explicitCredit } from "../src/research/providers";
it("recognizes explicit featured vocalist attribution in official recording titles", () => {
  expect(() =>
    validateAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "Blue Song",
            reference_url: url,
            kind: "original",
            source_id: "s0",
            quote: "Blue Song official",
            credits: [
              {
                name: "Alice",
                kind: "person",
                role: "vocalist",
                source_id: "s0",
                quote: "feat. Alice",
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      }),
      [
        {
          id: "s0",
          url,
          title: "Blue Song",
          content: "Blue Song official feat. Alice",
        },
      ],
      { title: "Blue Song", reference_url: null },
      [],
    ),
  ).not.toThrow();
});
it.each([
  { role: "composer", name: "Alice", quote: "Vocal: Alice. Music: Bob" },
  { role: "vocalist", name: "Alice", quote: "Vocal: Malice" },
])(
  "rejects role/name cross-clause or substring attribution $quote",
  async (c) => {
    await answer();
    model.recordings[0].credits = [
      { ...c, kind: "person", source_id: "s0", aliases: [] },
    ];
    model.recordings[0].tags = [];
    const f = (async (i: any, b: any) =>
      String(i).endsWith("/extract")
        ? json({
            results: [{ url, raw_content: "Blue Song official. " + c.quote }],
          })
        : provider(i, b)) as typeof fetch;
    for (let i = 0; i < 25; i++) await run(env(), undefined, f);
    expect(await allRows(db, "credits")).toHaveLength(0);
    expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  },
);
it.each([
  { role: "composer", name: "Bob", quote: "Vocal: Alice. Music: Bob" },
  { role: "composer", name: "DECO*27", quote: "Lyrics & Music: DECO*27" },
  { role: "vocalist", name: "初音ミク", quote: "歌唱：初音ミク" },
  { role: "vocalist", name: "Alice", quote: "Blue Song feat. Alice" },
  { role: "vocalist", name: "Alice", quote: "featuring Alice" },
])("preserves explicit supported multilingual attribution $quote", (c) => {
  expect(() =>
    validateAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "Blue Song",
            reference_url: url,
            kind: "original",
            source_id: "s0",
            quote: "Blue Song official",
            credits: [{ ...c, kind: "person", source_id: "s0", aliases: [] }],
            tags: [],
          },
        ],
      }),
      [
        {
          id: "s0",
          url,
          title: "Blue Song",
          content: "Blue Song official. " + c.quote,
        },
      ],
      { title: "Blue Song", reference_url: null },
      [],
    ),
  ).not.toThrow();
});
it("fits three Japanese sources and sends only evidence-backed candidates from the fifty-tag dictionary", async () => {
  await answer();
  const vurls = [
    url,
    "https://www.youtube.com/watch?v=zyxwvutsrqp",
    "https://www.youtube.com/watch?v=123456789ab",
  ];
  const contents = vurls.map(() =>
    [
      "Blue Song official",
      "Vocal: Alice",
      "Genre: electronic dance-pop with synth-led production.",
      "A bright and bouncy rhythm moves at a fast tempo.",
      "The clear and transparent vocals carry a warm tone.",
      "The lyrics describe love and hope for tomorrow.",
      "これは公式の曲紹介です。".repeat(15),
    ].join("\n\n"),
  );
  const { recordingWindows } = await import("../src/research/providers");
  expect(recordingWindows(contents[0])).toContain("electronic dance-pop");
  expect(recordingWindows(contents[0])).toContain("bright and bouncy rhythm");
  model.recordings[0].credits = [
    {
      name: "Alice",
      kind: "person",
      role: "vocalist",
      source_id: "s0",
      quote: "Vocal: Alice",
      aliases: [],
    },
  ];
  model.recordings[0].tags = [];
  let sent = 0;
  let observedInput: any;
  let observedEstimate = 0;
  const f = (async (i: any, b: any) => {
    if (String(i).endsWith("/search"))
      return json({
        results: vurls.map((u, k) => ({
          url: u,
          title: "日本語".repeat(80),
          content: contents[k],
        })),
      });
    if (String(i).endsWith("/extract"))
      return json({
        results: vurls.map((u, k) => ({ url: u, raw_content: contents[k] })),
      });
    if (String(i).endsWith("/completions")) {
      sent++;
      const request = JSON.parse(b.body);
      observedInput = JSON.parse(request.messages[1].content);
      observedEstimate =
        256 +
        Array.from(b.body as string).reduce(
          (n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1 / 3),
          0,
        ) +
        request.max_completion_tokens;
    }
    return provider(i, b);
  }) as typeof fetch;
  await drain(0);
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  expect(sent).toBe(1);
  expect(await allRows(db, "tags")).toHaveLength(50);
  expect(observedInput.tags.map((tag: any) => tag.id)).toEqual(
    expect.arrayContaining([
      "tag-07",
      "tag-13",
      "tag-24",
      "tag-32",
      "tag-33",
      "tag-38",
      "tag-47",
    ]),
  );
  expect(observedInput.tags.length).toBeLessThan(50);
  expect(observedEstimate).toBeLessThanOrEqual(7600);
  const fullEvidence = observedInput.sources.find((source: any) => source.id === "s0");
  expect(fullEvidence.content).toContain("Genre: electronic dance-pop");
  expect(fullEvidence.content).toContain("A bright and bouncy rhythm");
  expect(fullEvidence.content).toContain("clear and transparent vocals");
  expect(fullEvidence.content).toContain("lyrics describe love and hope");
  for (const source of observedInput.sources)
    expect(source.content).toContain("Vocal: Alice");
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  const snapshots = await allRows(db, "sources");
  expect(snapshots[0].excerpt).toContain("Vocal: Alice");
});
it.each([
  { name: "", quote: "Vocal: " },
  { name: "Alice", quote: "Vocal: Alice.com" },
])("rejects incomplete credited identity $quote", (c) => {
  expect(() =>
    validateAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "Blue Song",
            reference_url: url,
            kind: "original",
            source_id: "s0",
            quote: "Blue Song official",
            credits: [
              {
                ...c,
                role: "vocalist",
                kind: "person",
                source_id: "s0",
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      }),
      [
        {
          id: "s0",
          url,
          title: "Blue Song",
          content: "Blue Song official. " + c.quote,
        },
      ],
      { title: "Blue Song", reference_url: null },
      [],
    ),
  ).toThrow();
});
it.each([
  { name: "AC", role: "vocalist", quote: "Vocal: AC/DC" },
  { name: "DC", role: "vocalist", quote: "Vocal: AC/DC" },
  { name: "Mrs", role: "release_name", quote: "Artist: Mrs. GREEN APPLE" },
])("rejects clipped punctuation artist $name from $quote", async (c) => {
  await answer();
  model.recordings[0].credits = [
    { ...c, kind: "group", source_id: "s0", aliases: [] },
  ];
  model.recordings[0].tags = [];
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/extract")
      ? json({
          results: [{ url, raw_content: "Blue Song official. " + c.quote }],
        })
      : provider(i, b)) as typeof fetch;
  for (let i = 0; i < 25; i++) await run(env(), undefined, f);
  expect(await allRows(db, "credits")).toHaveLength(0);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
});
it.each([
  { name: "AC/DC", role: "vocalist", quote: "Vocal: AC/DC" },
  {
    name: "Mrs. GREEN APPLE",
    role: "release_name",
    quote: "Artist: Mrs. GREEN APPLE",
  },
])("preserves complete punctuation artist $name", (c) => {
  expect(() =>
    validateAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "Blue Song",
            reference_url: url,
            kind: "original",
            source_id: "s0",
            quote: "Blue Song official",
            credits: [{ ...c, kind: "group", source_id: "s0", aliases: [] }],
            tags: [],
          },
        ],
      }),
      [
        {
          id: "s0",
          url,
          title: "Blue Song",
          content: "Blue Song official. " + c.quote,
        },
      ],
      { title: "Blue Song", reference_url: null },
      [],
    ),
  ).not.toThrow();
});
it.each([
  { name: "AC", alternate: "DC", quote: "Vocal: AC/DC" },
  { name: "Alice", alternate: "Bob", quote: "Vocal: Alice / Bob" },
])(
  "keeps ambiguous same-script separator identities unconfirmed $quote",
  (c) => {
    expect(() =>
      validateAnalysis(
        JSON.stringify({
          recordings: [
            {
              title: "Blue Song",
              reference_url: url,
              kind: "original",
              source_id: "s0",
              quote: "Blue Song official",
              credits: [
                {
                  name: c.name,
                  role: "vocalist",
                  kind: "group",
                  source_id: "s0",
                  quote: c.quote,
                  aliases: [{ name: c.alternate, quote: c.quote.slice(7) }],
                },
              ],
              tags: [],
            },
          ],
        }),
        [
          {
            id: "s0",
            url,
            title: "Blue Song",
            content: "Blue Song official. " + c.quote,
          },
        ],
        { title: "Blue Song", reference_url: null },
        [],
      ),
    ).toThrow();
  },
);
it("preserves explicitly stated same-script alias evidence", () => {
  const quote = "Vocal: Alice (also known as Ally)";
  expect(() =>
    validateAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "Blue Song",
            reference_url: url,
            kind: "original",
            source_id: "s0",
            quote: "Blue Song official",
            credits: [
              {
                name: "Alice",
                role: "vocalist",
                kind: "person",
                source_id: "s0",
                quote,
                aliases: [
                  { name: "Ally", quote: "Alice (also known as Ally)" },
                ],
              },
            ],
            tags: [],
          },
        ],
      }),
      [
        {
          id: "s0",
          url,
          title: "Blue Song",
          content: "Blue Song official. " + quote,
        },
      ],
      { title: "Blue Song", reference_url: null },
      [],
    ),
  ).not.toThrow();
});

// External transport alone is faked; all leases, audited writes and stages use D1.
const liveSongs = [
  {
    title: "スピカ",
    id: "Ol1o3dgPIbI",
    native: "ロクデナシ「スピカ」/ Rokudenashi - Spica【Official Music Video】",
    author: "ロクデナシ",
  },
  {
    title: "Overdose",
    id: "H08YWE4CIFQ",
    native: "なとり - Overdose",
    author: "なとり / natori",
  },
  {
    title: "風のたより",
    id: "sWff60PZytQ",
    native: "tayori - 風のたより (Official Video)",
    author: "tayori",
  },
  {
    title: "テレパシ",
    id: "c56TpxfO9q0",
    native: "DECO*27 - テレパシ feat. 初音ミク",
    author: "DECO*27",
  },
];
function liveFixture(
  song: (typeof liveSongs)[number],
  options: {
    search?: any[];
    raw?: string;
    metadataStatus?: number;
    analysis?: any;
  } = {},
) {
  const canonical = `https://www.youtube.com/watch?v=${song.id}`;
  return (async (i: any, init: any) => {
    const target = String(i);
    if (target.startsWith("https://www.youtube.com/oembed?")) {
      expect(new URL(target).searchParams.get("url")).toBe(canonical);
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      expect(init.redirect).toBe("manual");
      return json(
        {
          title: song.native,
          author_name: song.author,
          author_url: "https://www.youtube.com/@fixture",
          type: "video",
          version: "1.0",
          provider_name: "YouTube",
          provider_url: "https://www.youtube.com/",
          html: "<iframe></iframe>",
          width: 200,
          height: 113,
          thumbnail_url: "https://i.ytimg.com/vi/fixture/hqdefault.jpg",
          thumbnail_width: 480,
          thumbnail_height: 360,
        },
        options.metadataStatus ?? 200,
      );
    }
    if (target.endsWith("/search"))
      return json({
        results: options.search ?? [
          {
            url,
            title: song.title,
            content: `${song.title} unrelated recording`,
          },
        ],
      });
    if (target.endsWith("/extract")) {
      const b = JSON.parse(init.body);
      return json({
        results: b.urls.map((u: string) => ({
          url: u,
          raw_content:
            u === canonical
              ? (options.raw ?? "Transcript\n[0:01] music\nlyrics only")
              : `${song.title} unrelated recording`,
        })),
      });
    }
    if (target.includes("api.groq.com"))
      return json({
        choices: [
          {
            message: {
              content: JSON.stringify(
                options.analysis ?? {
                  recordings: [
                    {
                      title: song.native,
                      reference_url: canonical,
                      kind: "original",
                      source_id: "s0",
                      quote: song.title,
                      credits: [
                        {
                          name: song.author,
                          kind: "channel",
                          role: "uploader",
                          source_id: "s0",
                          quote: song.author,
                          aliases: [],
                        },
                      ],
                      tags: [],
                    },
                  ],
                },
              ),
            },
          },
        ],
      });
    return provider(i, init);
  }) as typeof fetch;
}
async function measuredLiveDrain(f: typeof fetch, n = 25) {
  for (let i = 0; i < n; i++) {
    let queries = 0;
    const measured = new Proxy(db, {
      get(t, key) {
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(s, {
                get(t, k) {
                  if (k === "bind")
                    return (...v: unknown[]) => wrap(t.bind(...v));
                  const fn = Reflect.get(t, k);
                  if (["first", "all", "run", "raw"].includes(String(k)))
                    return (...v: unknown[]) => {
                      queries++;
                      return fn.apply(t, v);
                    };
                  return typeof fn === "function" ? fn.bind(t) : fn;
                },
              });
            return wrap(t.prepare(sql));
          };
        if (key === "batch")
          return (s: D1PreparedStatement[]) => {
            queries += s.length;
            return t.batch(s);
          };
        const value = Reflect.get(t, key);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    await run({ ...env(), DB: measured }, undefined, f);
    expect(queries).toBeLessThanOrEqual(50);
  }
}
it.each(liveSongs)(
  "investigates supplied $title despite unrelated/localized ranking and stores exact metadata uploader",
  async (song) => {
    const canonical = `https://www.youtube.com/watch?v=${song.id}`;
    const r = await answer(song.title, canonical);
    const f = liveFixture(song, {
      search: [
        {
          url,
          title: song.title === "スピカ" ? "Rokudenashi - Spica" : song.title,
          content: "unrelated version",
        },
      ],
    });
    await measuredLiveDrain(f);
    const saved = (await allRows(db, "responses")).find((x) => x.id === r.id)!;
    expect(saved.version_id).toBeTruthy();
    const versions = await allRows(db, "versions");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      reference_url: canonical,
      title: song.native,
    });
    const credits = await allRows(db, "credits");
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ role: "uploader", confirmed: true });
    expect((await allRows(db, "entities"))[0]).toMatchObject({
      name: song.author,
      kind: "channel",
    });
    const source = (await allRows(db, "sources")).find(
      (s) => s.id === credits[0].source_id,
    )!;
    expect(source).toMatchObject({
      url: canonical,
      version_id: saved.version_id,
    });
    expect(source.excerpt).toContain(song.native);
    expect(source.excerpt).toContain(song.author);
    expect(source.metadata).toMatchObject({
      provider: "youtube_oembed",
      title: song.native,
      author_name: song.author,
    });
    expect(source.metadata?.endpoint).toBe(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
    );
  },
);
it("preserves late song-credit windows and exact retrieved header when lyrics dominate extraction", async () => {
  const song = liveSongs[2],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  const raw = `Description\n${"歌詞の行です\n".repeat(180)}Vocal: isui\nMusic: raku\nbright and refreshing pop dance tune\nTranscript\n[0:01] ${"music ".repeat(100)}`;
  const { recordingWindows } = await import("../src/research/providers");
  const initialWindow = recordingWindows(raw);
  expect(initialWindow).toContain("Vocal: isui");
  expect(initialWindow).toContain("bright and refreshing pop dance tune");
  const f = liveFixture(song, {
    raw,
    analysis: {
      recordings: [
        {
          title: song.native,
          reference_url: canonical,
          kind: "original",
          source_id: "s0",
          quote: song.title,
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
              tag_id: "tag-08",
              source_id: "s0",
              quote: "bright and refreshing pop dance tune",
              reasoning:
                "bright and refreshing pop dance tuneという説明はダンスポップのポップとダンスを融合する特徴を明示している。",
            },
          ],
        },
      ],
    },
  });
  await measuredLiveDrain(f);
  expect((await allRows(db, "credits"))[0]?.role).toBe("vocalist");
  const tag = (await allRows(db, "tag_assignments"))[0];
  expect(tag?.confirmed).toBe(true);
  const source = (await allRows(db, "sources")).find(
    (s) => s.id === tag.source_id,
  )!;
  expect(source.excerpt).toContain("Vocal: isui");
  expect(source.excerpt).toContain(song.native);
  expect(source.excerpt).not.toContain("[0:01]");
});
it("retains actual search title on extract fallback without public metadata", async () => {
  const song = liveSongs[1],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  const f = liveFixture(song, {
    metadataStatus: 503,
    search: [{ url: canonical, title: song.native, content: "Vocal: Alice" }],
    raw: "Vocal: Alice",
    analysis: {
      recordings: [
        {
          title: song.native,
          reference_url: canonical,
          kind: "original",
          source_id: "s0",
          quote: "Overdose",
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
    },
  });
  await measuredLiveDrain(f);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  expect((await allRows(db, "sources"))[0].excerpt).toContain(song.native);
});
it("rejects supplied wrong recording title instead of attaching a ranked alternative", async () => {
  const song = liveSongs[2],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer("テレパシ", canonical);
  await measuredLiveDrain(liveFixture(song));
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  expect(await allRows(db, "versions")).toHaveLength(0);
  expect((await allRows(db, "research_jobs"))[0]).toMatchObject({
    status: "needs_review",
    last_error: "RECORDING_TITLE_CONFLICT",
  });
  expect(
    (await allRows(db, "research_jobs"))[0].evidence?.[0].metadata?.title,
  ).toBe(song.native);
});
it.each(["vocalist", "composer", "release_name"])(
  "never promotes structured channel authors into %s",
  async (role) => {
    const song = liveSongs[3],
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        analysis: {
          recordings: [
            {
              title: song.native,
              reference_url: canonical,
              kind: "original",
              source_id: "s0",
              quote: song.title,
              credits: [
                {
                  name: song.author,
                  kind: "person",
                  role,
                  source_id: "s0",
                  quote: song.author,
                  aliases: [],
                },
              ],
              tags: [],
            },
          ],
        },
      }),
    );
    expect(await allRows(db, "credits")).toHaveLength(0);
    expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
  },
);
it.each([false, true])(
  "publishes terminal metadata review status while respecting manual lock=%s",
  async (manual_lock) => {
    const song = liveSongs[0],
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    const w = await insert(
      "works",
      newRow({ title: song.title, manual_lock: false }),
    );
    const v = await insert(
      "versions",
      newRow({
        work_id: w.id,
        title: song.title,
        reference_url: canonical,
        kind: "original",
        uploader_entity_id: null,
        research_status: "queued",
        manual_lock,
      }),
    );
    await insert("research_jobs", researchJob(v));
    await measuredLiveDrain(
      liveFixture(song, { analysis: { recordings: [] } }),
    );
    expect((await allRows(db, "research_jobs"))[0]).toMatchObject({
      status: "needs_review",
      last_error: "NO_SUPPORTED_RECORDINGS",
    });
    expect((await allRows(db, "versions"))[0].research_status).toBe(
      manual_lock ? "queued" : "needs_review",
    );
    expect(await allRows(db, "credits")).toHaveLength(0);
  },
);
it("preserves terminal-dot artist names before another role marker", () => {
  expect(explicitCredit("Vocal: fun. Music: Bob", "fun.", "vocalist")).toBe(
    true,
  );
  expect(explicitCredit("Vocal: fun. Music: Bob", "fun", "vocalist")).toBe(
    true,
  );
});
it("does not treat group-member footer credits as recording credits", async () => {
  const song = liveSongs[2],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: "Lyrics\n歌詞の末尾\nMember\nVocal: isui\nMusic: raku\nTranscript\n[0:01] music",
      analysis: {
        recordings: [
          {
            title: song.native,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
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
            tags: [],
          },
        ],
      },
    }),
  );
  expect(await allRows(db, "credits")).toHaveLength(0);
  expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
});
it("does not treat structured author fields as semantic genre evidence", async () => {
  const song = liveSongs[0],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      analysis: {
        recordings: [
          {
            title: song.native,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
            credits: [],
            tags: [
              {
                tag_id: "tag-08",
                source_id: "s0",
                quote: song.author,
                reasoning:
                  "ロクデナシという投稿者の名前は、ダンスポップの特徴と一致するためこのジャンルに分類する。",
              },
            ],
          },
        ],
      },
    }),
  );
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
  expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
});
it("resolves ordinary title-only Japanese input through native metadata on a localized YouTube search result", async () => {
  const song = liveSongs[0],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title);
  await measuredLiveDrain(
    liveFixture(song, {
      search: [
        {
          url: canonical,
          title: "Rokudenashi - Spica (Official Music Video)",
          content: "Official music video by Rokudenashi",
        },
      ],
    }),
  );
  const saved = (await allRows(db, "responses"))[0];
  expect(saved.version_id).toBeTruthy();
  expect((await allRows(db, "versions"))[0]).toMatchObject({
    title: song.native,
    reference_url: canonical,
  });
  expect((await allRows(db, "sources"))[0].metadata?.author_name).toBe(
    song.author,
  );
});
it("keeps only matching native title from capped multilingual candidates", async () => {
  const song = liveSongs[0],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  const wrong = "https://www.youtube.com/watch?v=zyxwvutsrqp";
  const ignored = "https://www.youtube.com/watch?v=123456789ab";
  await answer(song.title);
  const fallback = liveFixture(song, {
    search: [
      { url: wrong, title: "Foreign song", content: "Official recording" },
      { url: canonical, title: "Spica", content: "Official recording" },
      { url: ignored, title: "Third song", content: "Official recording" },
      {
        url: "https://www.youtube.com/watch?v=abcdefghijk",
        title: "Fourth song",
        content: "Official recording",
      },
    ],
    analysis: {
      recordings: [
        {
          title: song.native,
          reference_url: canonical,
          kind: "original",
          source_id: "s1",
          quote: song.title,
          credits: [
            {
              name: song.author,
              kind: "channel",
              role: "uploader",
              source_id: "s1",
              quote: song.author,
              aliases: [],
            },
          ],
          tags: [],
        },
      ],
    },
  });
  const f = (async (i: any, b: any) => {
    if (String(i).startsWith("https://www.youtube.com/oembed?")) {
      const u = new URL(String(i)).searchParams.get("url");
      if (u === wrong || u === ignored)
        return json({
          title: "unrelated song",
          author_name: "unrelated channel",
        });
    }
    return fallback(i, b);
  }) as typeof fetch;
  await measuredLiveDrain(f);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  expect((await allRows(db, "versions")).map((v) => v.reference_url)).toEqual([
    canonical,
  ]);
  expect((await allRows(db, "sources")).map((s) => s.url)).toEqual([canonical]);
});
it.each([
  { author: "Vocal: Alice", name: "Alice", role: "vocalist" },
  { author: "Music: Bob", name: "Bob", role: "composer" },
  { author: "Artist: Band", name: "Band", role: "release_name" },
  { author: "Channel: Other", name: "Other", role: "uploader" },
])(
  "rejects role-shaped structured author $author as ordinary attribution",
  async (c) => {
    const song = { ...liveSongs[0], author: c.author },
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        analysis: {
          recordings: [
            {
              title: song.native,
              reference_url: canonical,
              kind: "original",
              source_id: "s0",
              quote: song.title,
              credits: [
                {
                  name: c.name,
                  kind: "person",
                  role: c.role,
                  source_id: "s0",
                  quote: c.author,
                  aliases: [],
                },
              ],
              tags: [],
            },
          ],
        },
      }),
    );
    expect(await allRows(db, "credits")).toHaveLength(0);
    expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
    expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
  },
);
it("preserves independently retrieved recording attribution even when author field has the same text", async () => {
  const song = { ...liveSongs[0], author: "Vocal: Alice" },
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: "Vocal: Alice",
      analysis: {
        recordings: [
          {
            title: song.native,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
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
      },
    }),
  );
  expect((await allRows(db, "credits"))[0]).toMatchObject({
    role: "vocalist",
    confirmed: true,
  });
});
it("cache native recording title overrides unrelated title mentions in its description", async () => {
  const song = liveSongs[2],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  const first = await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: "Description: Related song テレパシ. bright refreshing pop",
    }),
  );
  const original = (await allRows(db, "versions"))[0];
  expect(original.research_status).toBe("complete");
  const second = await answer("テレパシ", canonical);
  await measuredLiveDrain(liveFixture(song));
  const answers = await allRows(db, "responses");
  expect(answers.find((r) => r.id === first.id)?.version_id).toBe(original.id);
  expect(answers.find((r) => r.id === second.id)?.version_id).toBeNull();
  const reviewed = (await allRows(db, "research_jobs")).find(
    (j) => j.response_id === second.id,
  )!;
  expect(reviewed).toMatchObject({
    status: "needs_review",
    last_error: "RECORDING_TITLE_CONFLICT",
  });
  expect((await allRows(db, "versions"))[0].research_status).toBe("complete");
});
it("cache never treats a description-only title mention as identity without native metadata", async () => {
  await answer();
  const f = (async (i: any, b: any) =>
    String(i).endsWith("/extract")
      ? json({
          results: [
            {
              url,
              raw_content:
                evidence + " Description: Other title is a different song",
            },
          ],
        })
      : provider(i, b)) as typeof fetch;
  await measuredLiveDrain(f);
  const second = await answer("Other title", url);
  await measuredLiveDrain(f);
  expect(
    (await allRows(db, "responses")).find((r) => r.id === second.id)
      ?.version_id,
  ).toBeNull();
});
it("accepts exact public Spica live credits with handles and compound composer roles", async () => {
  const fixture = JSON.parse(
    await readFile("worker/tests/research-live-spica-fixture.json", "utf8"),
  );
  expect(() =>
    validateAnalysis(
      JSON.stringify(fixture.analysis),
      fixture.sources,
      fixture.query,
      fixture.tags,
    ),
  ).not.toThrow();
  await answer(fixture.query.title, fixture.query.reference_url);
  const j = (await allRows(db, "research_jobs"))[0];
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({ ...j, stage: "infer", evidence: fixture.sources }),
      j.id,
    )
    .run();
  const f = (async (i: any, b: any) =>
    String(i).includes("api.groq.com")
      ? json({
          choices: [{ message: { content: JSON.stringify(fixture.analysis) } }],
        })
      : provider(i, b)) as typeof fetch;
  await measuredLiveDrain(f);
  const credits = await allRows(db, "credits"),
    entities = await allRows(db, "entities");
  expect(
    credits.map((c) => ({
      role: c.role,
      name: entities.find((e) => e.id === c.entity_id)!.name,
    })),
  ).toEqual(
    expect.arrayContaining([
      { role: "vocalist", name: "Ninjin" },
      { role: "composer", name: "Nayutan Seijin" },
      { role: "uploader", name: "ロクデナシ" },
    ]),
  );
  expect((await allRows(db, "tag_assignments"))[0]).toMatchObject({
    tag_id: "tag-33",
    confirmed: true,
  });
});
it.each([
  "Music & Arrangement: Nayutan Seijin @officialnayutalien1318",
  "Words, Music & Arrangement: Nayutan Seijin @officialnayutalien1318",
  "作詞・作曲・編曲: Nayutan Seijin @officialnayutalien1318",
  "Music & lyric：Nayutan Seijin @officialnayutalien1318",
])("accepts complete compound composer attribution %s", (quote) => {
  expect(explicitCredit(quote, "Nayutan Seijin", "composer")).toBe(true);
  expect(explicitCredit(quote, "Nayutan", "composer")).toBe(false);
});
it.each([
  "Vocal: Ninjin Junior @ninzin_official",
  "Vocal: Ninjin / Another @ninzin_official",
  "Vocal: Ninjin & Another @ninzin_official",
  "Vocal: Ninjin, Another @ninzin_official",
])("never clips a complete credited name at social handle/list %s", (quote) => {
  expect(explicitCredit(quote, "Ninjin", "vocalist")).toBe(false);
});
it.each([
  { author: "Music: Bob", name: "Bob", role: "composer" },
  { author: "Vocal: Alice", name: "Alice", role: "vocalist" },
])("rejects nested $role text inside a retrieved channel header", async (c) => {
  const song = { ...liveSongs[0], author: c.author },
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: `Channel: ${c.author} (verified)\nDescription`,
      analysis: {
        recordings: [
          {
            title: song.native,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
            credits: [
              {
                name: c.name,
                kind: "person",
                role: c.role,
                source_id: "s0",
                quote: c.author,
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      },
    }),
  );
  expect(await allRows(db, "credits")).toHaveLength(0);
  expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
});
it("keeps partial recording facts with empty tags and unknown kind while preserving the raw caption", async () => {
  const song = liveSongs[2],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: "Vocal: isui\nMusic: tazuneru",
      analysis: {
        recordings: [
          {
            title: song.title,
            reference_url: canonical,
            kind: "other",
            original: null,
            source_id: "s0",
            quote: song.title,
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
            tags: [],
          },
        ],
      },
    }),
  );
  const version = (await allRows(db, "versions"))[0];
  expect(version).toMatchObject({
    title: song.title,
    kind: "other",
    research_status: "needs_review",
    reference_url: canonical,
  });
  expect((await allRows(db, "credits")).map((c) => c.role)).toEqual([
    "vocalist",
  ]);
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
  expect((await allRows(db, "sources"))[0].metadata?.title).toBe(song.native);
});
it("keeps explicit featured-title vocalist evidence without promoting arbitrary title role labels", async () => {
  const song = liveSongs[3],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      analysis: {
        recordings: [
          {
            title: song.title,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
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
      },
    }),
  );
  expect((await allRows(db, "credits"))[0]).toMatchObject({
    role: "vocalist",
    confirmed: true,
  });
  const misleading = { ...liveSongs[0], native: "スピカ / Music: Bob" },
    other = `https://www.youtube.com/watch?v=${misleading.id}`;
  const second = await answer(misleading.title, other);
  await measuredLiveDrain(
    liveFixture(misleading, {
      raw: misleading.native,
      analysis: {
        recordings: [
          {
            title: misleading.title,
            reference_url: other,
            kind: "original",
            source_id: "s0",
            quote: misleading.title,
            credits: [
              {
                name: "Bob",
                kind: "person",
                role: "composer",
                source_id: "s0",
                quote: "Music: Bob",
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      },
    }),
  );
  expect(
    (await allRows(db, "responses")).find((r) => r.id === second.id)
      ?.version_id,
  ).toBeTruthy();
  expect(
    (await allRows(db, "credits")).some((c) => c.role === "composer"),
  ).toBe(false);
});
const multilineAuthors = [
  { author: "Music: Bob", name: "Bob", role: "composer" },
  { author: "Vocal: Alice", name: "Alice", role: "vocalist" },
];
it.each(multilineAuthors)(
  "rejects $role-looking values of multiline channel headers",
  async (c) => {
    const song = { ...liveSongs[0], author: c.author },
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        raw: `Blue Song\nChannel:\n${c.author}\nDescription`,
        analysis: {
          recordings: [
            {
              title: song.native,
              reference_url: canonical,
              kind: "original",
              source_id: "s0",
              quote: song.title,
              credits: [
                {
                  name: c.name,
                  kind: "person",
                  role: c.role,
                  source_id: "s0",
                  quote: c.author,
                  aliases: [],
                },
              ],
              tags: [],
            },
          ],
        },
      }),
    );
    expect(await allRows(db, "credits")).toHaveLength(0);
    expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
    expect((await allRows(db, "research_jobs"))[0].status).toBe("needs_review");
  },
);
it.each(multilineAuthors)(
  "accepts $role credit truly in Description after multiline channel header",
  async (c) => {
    const song = { ...liveSongs[0], author: c.author },
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        raw: `Channel:\n${c.author}\nDescription\n${c.author}`,
        analysis: {
          recordings: [
            {
              title: song.native,
              reference_url: canonical,
              kind: "original",
              source_id: "s0",
              quote: song.title,
              credits: [
                {
                  name: c.name,
                  kind: "person",
                  role: c.role,
                  source_id: "s0",
                  quote: c.author,
                  aliases: [],
                },
              ],
              tags: [],
            },
          ],
        },
      }),
    );
    expect((await allRows(db, "credits"))[0]).toMatchObject({
      role: c.role,
      confirmed: true,
    });
    expect((await allRows(db, "entities"))[0].name).toBe(c.name);
  },
);
it.each(multilineAuthors)(
  "keeps the whole actual channel $author as uploader only",
  async (c) => {
    const song = { ...liveSongs[0], author: c.author },
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        raw: `Channel:\n${c.author}\nDescription`,
        analysis: {
          recordings: [
            {
              title: song.native,
              reference_url: canonical,
              kind: "original",
              source_id: "s0",
              quote: song.title,
              credits: [
                {
                  name: c.author,
                  kind: "channel",
                  role: "uploader",
                  source_id: "s0",
                  quote: c.author,
                  aliases: [],
                },
              ],
              tags: [],
            },
          ],
        },
      }),
    );
    const credits = await allRows(db, "credits");
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ role: "uploader", confirmed: true });
    expect((await allRows(db, "entities"))[0]).toMatchObject({
      name: c.author,
      kind: "channel",
    });
  },
);
it("does not derive voice tags from a multiline channel value", async () => {
  const song = { ...liveSongs[0], author: "Vocal: Alice" },
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: "Channel:\nVocal: Alice\nDescription",
      analysis: {
        recordings: [
          {
            title: song.native,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
            credits: [],
            tags: [
              {
                tag_id: "tag-33",
                source_id: "s0",
                quote: "Vocal: Alice",
                reasoning:
                  "Vocal: Aliceという歌唱者を記した引用から、人の歌声の基準を満たすと判断した。",
              },
            ],
          },
        ],
      },
    }),
  );
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
});
it("preserves Japanese header/value context through extraction windows", async () => {
  const song = { ...liveSongs[0], author: "Music: Bob" },
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: "チャンネル:\nMusic: Bob\n概要",
      analysis: {
        recordings: [
          {
            title: song.native,
            reference_url: canonical,
            kind: "original",
            source_id: "s0",
            quote: song.title,
            credits: [
              {
                name: "Bob",
                kind: "person",
                role: "composer",
                source_id: "s0",
                quote: "Music: Bob",
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      },
    }),
  );
  expect(await allRows(db, "credits")).toHaveLength(0);
});
it.each([
  { header: "Channel", section: "Description", gap: "" },
  { header: "チャンネル", section: "概要", gap: "" },
  { header: "Channel", section: "Description", gap: "\n" },
  { header: "チャンネル:", section: "概要", gap: "\n" },
])(
  "preserves first nonempty $header value before genuine description credit (gap=$gap)",
  async (c) => {
    const song = { ...liveSongs[0], author: "Bob" },
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        raw: `${c.header}\n${c.gap}Bob\n${c.section}\nMusic: Carol`,
        analysis: {
          recordings: [
            {
              title: song.native,
              reference_url: canonical,
              kind: "original",
              source_id: "s0",
              quote: song.title,
              credits: [
                {
                  name: "Carol",
                  kind: "person",
                  role: "composer",
                  source_id: "s0",
                  quote: "Music: Carol",
                  aliases: [],
                },
              ],
              tags: [],
            },
          ],
        },
      }),
    );
    const credit = (await allRows(db, "credits"))[0];
    expect(credit).toMatchObject({ role: "composer", confirmed: true });
    expect((await allRows(db, "entities"))[0].name).toBe("Carol");
    const source = (await allRows(db, "sources")).find(
      (s) => s.id === credit.source_id,
    )!;
    expect(source.excerpt.replace(/\s+/g, " ")).toContain(
      `${c.header} Bob ${c.section} Music: Carol`.replace(/\s+/g, " "),
    );
  },
);

it.each([0, 1, 2, 3, 4])(
  "retains independently supported actual model claims and privileged rejected raw fixture %s",
  async (index) => {
    const fixtures = JSON.parse(
      await readFile(
        "worker/tests/research-actual-model-fixtures.json",
        "utf8",
      ),
    );
    const fixture = fixtures[index];
    await answer(fixture.query.title, fixture.query.reference_url);
    const j = (await allRows(db, "research_jobs"))[0];
    await db
      .prepare("UPDATE research_jobs SET data=? WHERE id=?")
      .bind(
        JSON.stringify({ ...j, stage: "infer", evidence: fixture.sources }),
        j.id,
      )
      .run();
    const f = (async (i: any, init: any) =>
      String(i).includes("api.groq.com")
        ? json({ choices: [{ message: { content: fixture.raw } }] })
        : provider(i, init)) as typeof fetch;
    await measuredLiveDrain(f, 38);
    const credits = await allRows(db, "credits");
    expect(credits.map((c) => c.role)).toEqual(
      expect.arrayContaining(["uploader", "composer"]),
    );
    if (fixture.query.title !== "Overdose")
      expect(credits.some((c) => c.role === "vocalist")).toBe(true);
    else expect(credits.some((c) => c.role === "vocalist")).toBe(false);
    expect(
      (await allRows(db, "tag_assignments")).some((t) => t.tag_id === "tag-01"),
    ).toBe(false);
    if (index === 4)
      expect(
        (await allRows(db, "tag_assignments")).some(
          (t) => t.tag_id === "tag-33",
        ),
      ).toBe(true);
    const result = (await allRows(db, "research_results"))[0];
    expect(result.raw_model).toBe(fixture.raw);
    expect((await allRows(db, "responses"))[0].version_id).toBe(
      result.version_id,
    );
    const detail = await songDetail(db, result.version_id);
    expect(JSON.stringify(detail)).not.toContain("raw_model");
    if (index === 4) {
      expect(result.review_warnings?.length ?? 0).toBeGreaterThan(0);
      expect(detail.version.research_status).toBe("needs_review");
      expect(JSON.stringify(detail.tags)).not.toContain("J-POP");
    }
  },
);

it("constrains only trusted known supplied identity while credits/tags remain optional", async () => {
  const song = liveSongs[2];
  const canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  let capturedSchema: any;
  const fixture = liveFixture(song);
  const f = (async (i: any, init: any) => {
    if (String(i).includes("api.groq.com")) {
      capturedSchema = JSON.parse(init.body).response_format.json_schema.schema;
    }
    return fixture(i, init);
  }) as typeof fetch;
  await measuredLiveDrain(f, 38);
  expect(capturedSchema?.properties.recordings.minItems).toBe(1);
  expect(capturedSchema.properties.recordings.maxItems).toBe(1);
  expect(
    capturedSchema.properties.recordings.items.properties.credits.minItems ?? 0,
  ).toBe(0);
  expect(
    capturedSchema.properties.recordings.items.properties.tags.minItems ?? 0,
  ).toBe(0);
});

it.each(["title-only", "missing-metadata", "conflicting-hint"])(
  "does not force %s identity",
  async (mode) => {
    const song = liveSongs[2],
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    await answer(song.title, mode === "title-only" ? null : canonical);
    if (mode === "conflicting-hint") {
      const r = (await allRows(db, "responses"))[0],
        j = (await allRows(db, "research_jobs"))[0];
      await db
        .prepare("UPDATE responses SET data=? WHERE id=?")
        .bind(JSON.stringify({ ...r, artist_hint: "not the artist" }), r.id)
        .run();
      await db
        .prepare("UPDATE research_jobs SET data=? WHERE id=?")
        .bind(
          JSON.stringify({
            ...j,
            query: { ...j.query, artist_hint: "not the artist" },
          }),
          j.id,
        )
        .run();
    }
    const fixture = liveFixture(song, {
      metadataStatus: mode === "missing-metadata" ? 503 : 200,
    });
    let capturedSchema: any;
    const f = (async (i: any, init: any) => {
      if (String(i).includes("api.groq.com")) {
        capturedSchema = JSON.parse(init.body).response_format.json_schema
          .schema;
        return json({
          choices: [{ message: { content: '{"recordings":[]}' } }],
        });
      }
      return fixture(i, init);
    }) as typeof fetch;
    await measuredLiveDrain(f, 38);
    expect(capturedSchema).toBeTruthy();
    expect(capturedSchema.properties.recordings.minItems ?? 0).toBe(0);
    expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  },
);

it("keeps canonical corrected entity and locked role during case/alias replay", async () => {
  const r = await answer();
  await drain();
  const person = (await allRows(db, "entities"))[0],
    credit = (await allRows(db, "credits"))[0];
  await db
    .prepare("UPDATE entities SET data=? WHERE id=?")
    .bind(
      JSON.stringify({ ...person, name: "Corrected Alice", manual_lock: true }),
      person.id,
    )
    .run();
  await db
    .prepare("UPDATE credits SET data=? WHERE id=?")
    .bind(JSON.stringify({ ...credit, manual_lock: true }), credit.id)
    .run();
  await insert("aliases", newRow({ entity_id: person.id, name: "ＡＬＩＣＥ" }));
  const targetVersion = (await allRows(db, "responses"))[0].version_id;
  const j = (await allRows(db, "research_jobs")).find(
    (j) => j.version_id === targetVersion,
  )!;
  // Use a version job because the resolved answer is intentionally stale.
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...j,
        status: "queued",
        response_id: null,
        version_id: (await allRows(db, "responses"))[0].version_id,
        query: null,
        stage: "infer",
        next_attempt_at: new Date().toISOString(),
        metadata_cursor: 0,
        catalog_cursor: 0,
        candidates: [],
      }),
      j.id,
    )
    .run();
  await measuredLiveDrain(provider);
  expect(await allRows(db, "entities")).toHaveLength(1);
  expect((await allRows(db, "credits"))[0]).toMatchObject({
    entity_id: person.id,
    manual_lock: true,
  });
});

it("rejects voice quality inferred only from a vocalist credit but retains factual vocals", async () => {
  await answer();
  model.recordings[0].tags = [
    {
      tag_id: "tag-38",
      source_id: "s0",
      quote: "Vocal: Alice",
      reasoning: "Vocal: Alice means the voice has 透明感 and an airy quality.",
    },
  ];
  await measuredLiveDrain(provider);
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
  expect(await allRows(db, "credits")).toHaveLength(1);
});

it("reuses an evidenced alias after canonical person correction without locking the credit edge", async () => {
  await answer();
  await drain();
  const person = (await allRows(db, "entities"))[0];
  await db
    .prepare("UPDATE entities SET data=? WHERE id=?")
    .bind(
      JSON.stringify({ ...person, name: "Corrected Alice", manual_lock: true }),
      person.id,
    )
    .run();
  await insert("aliases", newRow({ entity_id: person.id, name: "ＡＬＩＣＥ" }));
  const targetVersion = (await allRows(db, "versions"))[0].id;
  const old = (await allRows(db, "research_jobs")).find(
    (j) => j.version_id === targetVersion,
  )!;
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...old,
        status: "queued",
        response_id: null,
        version_id: (await allRows(db, "versions"))[0].id,
        query: null,
        stage: "infer",
        next_attempt_at: new Date().toISOString(),
        metadata_cursor: 0,
        catalog_cursor: 0,
        candidates: [],
      }),
      old.id,
    )
    .run();
  await measuredLiveDrain(provider);
  expect(await allRows(db, "entities")).toHaveLength(1);
  expect((await allRows(db, "credits"))[0].entity_id).toBe(person.id);
  expect((await allRows(db, "entities"))[0]).toMatchObject({
    name: "Corrected Alice",
    manual_lock: true,
  });
});

it("investigates missing descriptors with a bounded Japanese metadata query and preserves retrieved markdown recording links", async () => {
  const song = liveSongs[2],
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  const fixture = liveFixture(song, {
    raw: `${song.native}\nDescription\nVocal: isui\nMusic: tazuneru`,
  });
  const descriptive = "https://tayori.example/song/wind";
  const raw = `${song.title} は爽やかなダンスポップ、fast tempo の楽曲。 [Official Video](https://youtu.be/${song.id})`;
  const lookupBodies: any[] = [];
  let searches = 0;
  const f = (async (i: any, init: any) => {
    const target = String(i);
    if (target.endsWith("/search")) {
      const body = JSON.parse(init.body);
      lookupBodies.push(body);
      searches++;
      if (searches === 2)
        return json({
          results: [{ url: descriptive, title: song.title, content: raw }],
        });
    }
    if (
      target.endsWith("/extract") &&
      JSON.parse(init.body).urls.includes(descriptive)
    ) {
      expect(JSON.parse(init.body).format).toBe("markdown");
      return json({ results: [{ url: descriptive, raw_content: raw }] });
    }
    if (target.includes("api.groq.com")) {
      const input = JSON.parse(JSON.parse(init.body).messages[1].content);
      const source = input.sources.find((s: any) => s.url === descriptive);
      return json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                recordings: [
                  {
                    title: song.title,
                    reference_url: canonical,
                    kind: "original",
                    original: null,
                    source_id: "s0",
                    quote: song.title,
                    credits: [],
                    tags: source
                      ? [
                          {
                            tag_id: "tag-08",
                            source_id: source.id,
                            quote: "爽やかなダンスポップ",
                            reasoning:
                              "The description explicitly characterizes this recording as a dance pop track.",
                          },
                        ]
                      : [],
                  },
                ],
              }),
            },
          },
        ],
      });
    }
    return fixture(i, init);
  }) as typeof fetch;
  await measuredLiveDrain(f, 38);
  expect(searches).toBe(4);
  expect(lookupBodies[1].query).toContain(song.author);
  expect(lookupBodies[1].query).not.toContain("youtube.com");
  expect(lookupBodies[1].query.length).toBeLessThanOrEqual(399);
  expect((await allRows(db, "tag_assignments"))[0]?.tag_id).toBe("tag-08");
  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(8);
});

it.each(["quota", "provider"])(
  "retains recording facts and answer when descriptive lookup %s fails",
  async (mode) => {
    const song = liveSongs[2],
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    const r = await answer(song.title, canonical);
    const fixture = liveFixture(song);
    let searches = 0,
      quotas = 0;
    const f = (async (i: any, init: any) => {
      if (String(i).endsWith("/usage") && ++quotas === 3 && mode === "quota")
        return json({
          account: {
            current_plan: "Researcher",
            plan_usage: 1000,
            plan_limit: 1000,
            paygo_usage: 0,
          },
          key: { usage: 1000, limit: 1000 },
        });
      if (
        String(i).endsWith("/search") &&
        ++searches === 2 &&
        mode === "provider"
      )
        return json({}, 503);
      return fixture(i, init);
    }) as typeof fetch;
    await measuredLiveDrain(f, 38);
    if (mode === "provider") {
      const retrying = (await allRows(db, "research_jobs"))[0];
      expect(retrying).toMatchObject({
        stage: "describe_search",
        status: "queued",
        last_error: "PROVIDER_HTTP_503",
      });
      expect(Date.parse(retrying.next_attempt_at)).toBeGreaterThan(Date.now());
      await wake();
      await measuredLiveDrain(f, 38);
    }
    expect(
      (await allRows(db, "responses")).find((x) => x.id === r.id)?.version_id,
    ).toBeTruthy();
    expect(
      (await allRows(db, "credits")).some((c) => c.role === "uploader"),
    ).toBe(true);
    const warnings = (await allRows(db, "research_results"))[0].review_warnings;
    if (mode === "quota")
      expect(warnings).toContain("DESCRIPTIVE_LOOKUP_UNAVAILABLE");
    else expect(warnings).not.toContain("DESCRIPTIVE_LOOKUP_UNAVAILABLE");
  },
);

it.each(["embed", "shorts", "watch"])(
  "keeps actual retrieved %s links past descriptor truncation without injecting query identity",
  async (path) => {
    const { recordingWindows, linkedRecording } =
      await import("../src/research/providers");
    const actual =
      path === "watch" ? url : `https://www.youtube.com/${path}/abcdefghijk`;
    const raw =
      "Description: bright refreshing pop\n" +
      "Official music release details\n".repeat(60) +
      `[Official recording](${actual})`;
    const content = recordingWindows(raw);
    expect(content).toContain(actual);
    expect(content.length).toBeLessThanOrEqual(1000);
    expect(
      linkedRecording(
        {
          id: "s1",
          url: "https://label.example/release",
          title: "Blue Song",
          content,
        },
        url,
      ),
    ).toBe(true);
    expect(
      linkedRecording(
        {
          id: "s1",
          url: "https://label.example/release",
          title: "Blue Song",
          content: recordingWindows("Blue Song Official pop release"),
        },
        url,
      ),
    ).toBe(false);
  },
);

it("does not infer genre or mood from standalone lyric text", async () => {
  const raw =
    "Blue Song official\nDescription\nThat’s why I dance, sleep, and forget everything";
  await answer();
  model.recordings[0].tags = [
    {
      tag_id: "tag-28",
      source_id: "s0",
      quote: "That’s why I dance, sleep, and forget everything",
      reasoning:
        "The lyrics mention dancing and therefore this has a danceable rhythm.",
    },
  ];
  const f = (async (i: any, init: any) =>
    String(i).endsWith("/extract")
      ? json({ results: [{ url, raw_content: raw + "\nVocal: Alice" }] })
      : provider(i, init)) as typeof fetch;
  await measuredLiveDrain(f);
  expect(await allRows(db, "tag_assignments")).toHaveLength(0);
  expect(await allRows(db, "credits")).toHaveLength(1);
});

it("retains malformed model response only in privileged job review", async () => {
  await answer();
  model = "malformed fixture";
  await drain();
  const job = (await allRows(db, "research_jobs"))[0];
  expect(job.status).toBe("needs_review");
  expect(job.raw_model).toBe("malformed fixture");
  expect(await allRows(db, "versions")).toHaveLength(0);
});

it("keeps admin-edited criteria while upgrading untouched generic initial definitions", async () => {
  const tags = await allRows(db, "tags"),
    legacy = tags.find((t) => t.id === "tag-08")!,
    edited = tags.find((t) => t.id === "tag-38")!;
  const old = `Webの説明・公式情報で「${legacy.name}」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。`;
  await db
    .prepare("UPDATE tags SET data=? WHERE id=?")
    .bind(JSON.stringify({ ...legacy, criterion: old }), legacy.id)
    .run();
  await db
    .prepare("UPDATE tags SET data=? WHERE id=?")
    .bind(
      JSON.stringify({
        ...edited,
        criterion: "管理者専用の特別な基準",
        revision: 2,
      }),
      edited.id,
    )
    .run();
  const migrations = (await readdir("worker/schema"))
    .filter((f) => f > "0003_research.sql" && f.endsWith(".sql"))
    .sort();
  for (const f of migrations)
    await db.exec(
      (await readFile(`worker/schema/${f}`, "utf8"))
        .replace(/--[^\n]*\n/g, "")
        .split("\n")
        .filter((l) => l.trim())
        .join("\n"),
    );
  const saved = await allRows(db, "tags");
  expect(saved.find((t) => t.id === "tag-08")?.criterion).toContain("ビート");
  expect(saved.find((t) => t.id === "tag-38")?.criterion).toBe(
    "管理者専用の特別な基準",
  );
  expect(saved).toHaveLength(50);
});

it("never treats a role-shaped channel header substring as a different uploader", async () => {
  const song = { ...liveSongs[2], author: "Channel: Other" },
    canonical = `https://www.youtube.com/watch?v=${song.id}`;
  await answer(song.title, canonical);
  await measuredLiveDrain(
    liveFixture(song, {
      raw: `Channel: ${song.author} (verified)\nDescription`,
      analysis: {
        recordings: [
          {
            title: song.title,
            reference_url: canonical,
            kind: "original",
            original: null,
            source_id: "s0",
            quote: song.title,
            credits: [
              {
                name: "Other",
                kind: "channel",
                role: "uploader",
                source_id: "s0",
                quote: "Channel: Other",
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      },
    }),
    38,
  );
  expect(await allRows(db, "credits")).toHaveLength(0);
});

it.each([
  "作曲：Alice",
  "Words, Music & Arrangement: Bob",
  "作詞・作曲・編曲: Bob",
  "The music was composed by Alice.",
  "Vocal. Alice",
  "Vocal Alice",
  "Music Nayutan Seijin",
  "Vocal alice smith",
])(
  "never derives voice quality from optional-array-independent bare credit %s",
  async (creditQuote) => {
    const { supportedAnalysis } = await import("../src/research/providers");
    const source = {
      id: "s0",
      url,
      title: "Blue Song",
      content: `Blue Song official\nDescription\n${creditQuote}`,
    };
    const r = {
      ...model.recordings[0],
      credits: [],
      tags: [
        {
          tag_id: "tag-38",
          source_id: "s0",
          quote: creditQuote,
          reasoning:
            "This credited creator establishes a transparent vocal quality for the recording.",
        },
      ],
    };
    const a = supportedAnalysis(
      JSON.stringify({ recordings: [r] }),
      [source],
      { title: "Blue Song", reference_url: url },
      [{ id: "tag-38", name: "透明感", category: "歌声の印象" }],
    );
    expect(a.recordings[0].tags).toHaveLength(0);
    expect(a.review_warnings).toHaveLength(1);
  },
);

it("retains an independently supported alias beside an unsupported sibling alias", async () => {
  const { supportedAnalysis } = await import("../src/research/providers");
  const r = structuredClone(model.recordings[0]);
  r.tags = [];
  r.credits[0].aliases.push({
    name: "Invented Alice",
    quote: "Alice aka Invented Alice",
  });
  const a = supportedAnalysis(
    JSON.stringify({ recordings: [r] }),
    [{ id: "s0", url, title: "Blue Song", content: evidence }],
    { title: "Blue Song", reference_url: url },
    [],
  );
  expect(a.recordings[0].credits[0].aliases).toEqual([
    { name: "アリス", quote: "Alice / アリス" },
  ]);
  expect(a.review_warnings).toHaveLength(1);
});

it.each([0, 1])(
  "investigates descriptors missing from captured native metadata/lyrics/resource source %s",
  async (index) => {
    const fixtures = JSON.parse(
      await readFile(
        "worker/tests/research-actual-model-fixtures.json",
        "utf8",
      ),
    );
    const fixture = fixtures[index];
    const { hasDescriptors } = await import("../src/research/providers");
    expect(hasDescriptors(fixture.sources, fixture.query.reference_url)).toBe(
      false,
    );
    await answer(fixture.query.title, fixture.query.reference_url);
    const job = (await allRows(db, "research_jobs"))[0];
    await db
      .prepare("UPDATE research_jobs SET data=? WHERE id=?")
      .bind(
        JSON.stringify({ ...job, stage: "infer", evidence: fixture.sources }),
        job.id,
      )
      .run();
    const searchQueries: string[] = [];
    const f = (async (i: any, init: any) => {
      if (String(i).endsWith("/search")) {
        searchQueries.push(JSON.parse(init.body).query);
        return json({ results: [] });
      }
      if (String(i).includes("api.groq.com"))
        return json({ choices: [{ message: { content: fixture.raw } }] });
      return provider(i, init);
    }) as typeof fetch;
    await measuredLiveDrain(f, 38);
    expect(searchQueries).toHaveLength(4);
    expect(searchQueries.some((query) => query.includes("ジャンル 音楽性"))).toBe(
      true,
    );
    expect(searchQueries.some((query) => query.includes("曲調 雰囲気"))).toBe(
      true,
    );
    expect(searchQueries.some((query) => query.includes("歌声 歌唱"))).toBe(
      true,
    );
    expect(searchQueries.some((query) => query.includes("歌詞 内容"))).toBe(
      true,
    );
    expect(
      (await allRows(db, "research_results"))[0].review_warnings,
    ).not.toContain("NO_SUPPORTED_TAG_DESCRIPTIONS");
    expect((await allRows(db, "responses"))[0].version_id).toBeTruthy();
  },
);

it.each([
  "That’s why I dance, sleep, and forget everything",
  "Instrumental (Piapro): https://piapro.example/download",
])("does not treat %s as a recording description", async (text) => {
  const { hasDescriptors } = await import("../src/research/providers");
  expect(
    hasDescriptors(
      [
        {
          id: "s0",
          url,
          title: "Blue Song",
          content: `Blue Song\nDescription\n${text}`,
        },
      ],
      url,
    ),
  ).toBe(false);
});

it("aligns fresh and migrated classical tag definition while preserving its ID/name", async () => {
  let classical = (await allRows(db, "tags")).find((t) => t.id === "tag-11")!;
  expect(classical.name).toBe("クラシック");
  expect(classical.criterion).not.toContain("バラード");
  expect(classical.criterion).toContain("クラシック");
  const old = `Webの説明・公式情報で「${classical.name}」を裏付ける具体的な根拠がある場合のみ付与。曲名や作者名から推測しない。`;
  await db
    .prepare("UPDATE tags SET data=? WHERE id=?")
    .bind(JSON.stringify({ ...classical, criterion: old }), classical.id)
    .run();
  await db.exec(
    (await readFile("worker/schema/0004_tag_criteria.sql", "utf8"))
      .replace(/--[^\n]*\n/g, "")
      .split("\n")
      .filter((l) => l.trim())
      .join("\n"),
  );
  const migrated = (await allRows(db, "tags")).find((t) => t.id === "tag-11")!;
  expect(migrated.criterion).toBe(classical.criterion);
});

it.each([
  { quote: "The music is bright refreshing dance pop.", tag: "tag-08" },
  { quote: "The vocals are clear and transparent.", tag: "tag-38" },
  { quote: "Vocals deliver a clear and transparent tone.", tag: "tag-38" },
  { quote: "Vocals deliver a clear and transparent tone", tag: "tag-38" },
])(
  "retains ordinary music/vocals descriptive prose $quote as evidence and confirmed tags",
  async (example) => {
    const { hasDescriptors } = await import("../src/research/providers");
    const song = liveSongs[2],
      canonical = `https://www.youtube.com/watch?v=${song.id}`;
    expect(
      hasDescriptors(
        [
          {
            id: "s0",
            url: canonical,
            title: song.native,
            content: `${song.native}\nDescription\n${example.quote}`,
          },
        ],
        canonical,
      ),
    ).toBe(true);
    await answer(song.title, canonical);
    await measuredLiveDrain(
      liveFixture(song, {
        raw: `${song.native}\nDescription\n${example.quote}`,
        analysis: {
          recordings: [
            {
              title: song.title,
              reference_url: canonical,
              kind: "original",
              original: null,
              source_id: "s0",
              quote: song.title,
              credits: [],
              tags: [
                {
                  tag_id: example.tag,
                  source_id: "s0",
                  quote: example.quote,
                  reasoning:
                    "The description establishes the musical sound or vocal quality of this recording.",
                },
              ],
            },
          ],
        },
      }),
      38,
    );
    expect((await allRows(db, "tag_assignments"))[0]).toMatchObject({
      tag_id: example.tag,
      confirmed: true,
    });
    expect((await allRows(db, "research_results"))[0].review_warnings).toEqual(
      [],
    );
  },
);

it.each([":", ".", "-", "–", "—", " "])(
  "preserves complete named vocalist fields with shared separator %s",
  (separator) => {
    const quote = `Vocal${separator} Alice`;
    expect(explicitCredit(quote, "Alice", "vocalist")).toBe(true);
    expect(explicitCredit(quote, "Ali", "vocalist")).toBe(false);
  },
);

it("never promotes a descriptive predicate to a named vocalist", () => {
  expect(
    explicitCredit(
      "Vocals deliver a clear and transparent tone.",
      "deliver a clear and transparent tone.",
      "vocalist",
    ),
  ).toBe(false);
});

it.each([
  {
    quote: "Vocal Alice / アリス",
    alternate: "アリス",
    proof: "Alice / アリス",
  },
  {
    quote: "Vocal: Alice / アリス",
    alternate: "アリス",
    proof: "Alice / アリス",
  },
  {
    quote: "Vocal Alice (aka Alice Smith)",
    alternate: "Alice Smith",
    proof: "Alice (aka Alice Smith)",
  },
  {
    quote: "Vocal: Alice (aka Alice Smith)",
    alternate: "Alice Smith",
    proof: "Alice (aka Alice Smith)",
  },
])("preserves evidenced whole-value alias credit $quote", (c) => {
  expect(
    explicitCredit(c.quote, "Alice", "vocalist", [
      { name: c.alternate, quote: c.proof },
    ]),
  ).toBe(true);
  expect(explicitCredit(c.quote, "Alice", "vocalist")).toBe(false);
  expect(
    explicitCredit(c.quote, "Alice", "vocalist", [
      { name: c.alternate, quote: "unrelated alias evidence" },
    ]),
  ).toBe(false);
  expect(
    explicitCredit(c.quote, "Ali", "vocalist", [
      { name: c.alternate, quote: c.proof },
    ]),
  ).toBe(false);
});

it.each([
  { role: "composer", name: "tazuneru", quote: "Music tazuneru" },
  { role: "vocalist", name: "AC/DC", quote: "Vocal AC/DC" },
  { role: "vocalist", name: "fun.", quote: "Vocal fun." },
  {
    role: "release_name",
    name: "Mrs. GREEN APPLE",
    quote: "Artist Mrs. GREEN APPLE",
  },
  {
    role: "composer",
    name: "Nayutan Seijin",
    quote: "Music Nayutan Seijin @officialnayutalien1318",
  },
  { role: "vocalist", name: "alice smith", quote: "Vocal: alice smith" },
])("preserves shared complete named credit value $quote", (c) => {
  expect(explicitCredit(c.quote, c.name, c.role as CreditRole)).toBe(true);
});

it("re-extracts a duplicate source for its selected descriptor category and retains its identity", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const selected = {
    ...researchJob(version),
    version_id: version.id,
    purpose: "tag_enrichment" as const,
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "describe_search" as const,
    descriptive_category: "mood_energy_tempo",
    descriptive_coverage: { genre_sound: "complete" as const },
    evidence: [
      {
        id: "s0",
        url,
        title: "Blue Song official",
        content: [
          "Blue Song official.",
          "Vocal: Alice",
          "Blue Song is performed by a human vocalist.",
          ...Array.from(
            { length: 18 },
            (_, index) =>
              `The music has a bright, steady arrangement in section ${index}.`,
          ),
        ].join("\n\n"),
        metadata: {
          provider: "youtube_oembed" as const,
          endpoint:
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&format=json",
          title: "Blue Song",
          author_name: "Singer",
        },
      },
    ],
    status: "queued" as const,
  };
  await insert("research_jobs", selected);

  const searchQueries: string[] = [];
  const extractedUrls: string[][] = [];
  let metadataLookups = 0;
  const f = (async (input: any, init: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/search")) {
      const body = JSON.parse(init.body);
      searchQueries.push(body.query);
      return json({
        results: [
          {
            url,
            title: "Blue Song single notes",
            content: "Blue Song is bright, steady, and danceable at 120 BPM.",
            recording_associations: [
              {
                provenance: "worker_verified_release_v1",
                reference_url: url,
                basis: "official_release",
                artist: "Singer",
                title_quote: "Blue Song is an official single release.",
                release_url: "https://singer.lnk.to/Blue-Song",
              },
            ],
          },
        ],
      });
    }
    if (target.endsWith("/extract")) {
      const body = JSON.parse(init.body);
      extractedUrls.push(body.urls);
      return json({
        results: [
          {
            url,
            raw_content:
              "Blue Song single notes. The music is bright, steady, and danceable at 120 BPM.",
          },
        ],
      });
    }
    if (target.includes("youtube.com/oembed")) {
      metadataLookups++;
      return json({ title: "Blue Song", author_name: "Singer" });
    }
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("describe_extract");
  expect(job.descriptive_category).toBe("mood_energy_tempo");
  expect(job.descriptive_source_ids).toEqual(["s0"]);
  expect(job.evidence?.map((source) => source.id)).toEqual(["s0"]);
  expect(job.evidence?.[0].recording_associations).toBeUndefined();
  expect(job.evidence?.[0].title).toBe("Blue Song official");
  expect(job.evidence?.[0].metadata?.title).toBe("Blue Song");
  expect(job.evidence?.[0].content).toContain(
    "Blue Song is performed by a human vocalist.",
  );
  expect(job.evidence?.[0].content).toContain(
    "Blue Song is bright, steady, and danceable at 120 BPM.",
  );
  expect(searchQueries[0]).toContain("曲調");

  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(extractedUrls).toEqual([[url]]);
  expect(job.evidence?.[0].id).toBe("s0");
  expect(job.evidence?.[0].content).toContain(
    "The music is bright, steady, and danceable at 120 BPM.",
  );
  expect(job.evidence?.[0].content).toContain(
    "Blue Song is performed by a human vocalist.",
  );
  expect(job.evidence?.[0].title).toBe("Blue Song official");
  expect(job.evidence?.[0].metadata?.title).toBe("Blue Song");
  expect(job.descriptive_coverage).toMatchObject({
    genre_sound: "complete",
    mood_energy_tempo: "complete",
  });
  expect(metadataLookups).toBe(0);
  expect((await allRows(db, "usage"))[0].tavily_credits).toBe(2);
});

it.each([
  { name: "Alice", role: "vocalist", quote: "Vocal: Alice" },
  { name: "Bob", role: "composer", quote: "Music: Bob" },
])(
  "keeps a fresh Description $role when its quote matches an old Channel value",
  async (credit) => {
    const work = newRow({ title: "Blue Song", manual_lock: false });
    const version: Version = newRow({
      work_id: work.id,
      title: "Blue Song",
      kind: "original",
      reference_url: url,
      uploader_entity_id: null,
      research_status: "queued",
      manual_lock: false,
    });
    await insert("works", work);
    await insert("versions", version);
    const selected = {
      ...researchJob(version),
      version_id: version.id,
      purpose: "tag_enrichment" as const,
      query: { title: "Blue Song", artist_hint: null, reference_url: url },
      stage: "describe_extract" as const,
      descriptive_category: "genre_sound" as const,
      descriptive_source_ids: ["s0"],
      evidence: [
        {
          id: "s0",
          url,
          title: "Blue Song official",
          content: `Blue Song official.\n\nChannel:\n\n${credit.quote}`,
          metadata: {
            provider: "youtube_oembed" as const,
            endpoint:
              "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&format=json",
            title: "Blue Song",
            author_name: credit.quote,
          },
        },
      ],
      status: "queued" as const,
    };
    await insert("research_jobs", selected);
    const fetcher = (async (input: any) => {
      const target = String(input);
      if (target.endsWith("/usage"))
        return json({
          account: {
            current_plan: "Researcher",
            plan_usage: 0,
            plan_limit: 1000,
            paygo_usage: 0,
          },
          key: { usage: 0, limit: 1000 },
        });
      if (target.endsWith("/extract"))
        return json({
          results: [{ url, raw_content: `Description\n${credit.quote}` }],
        });
      return json({});
    }) as typeof fetch;

    await run(env(), undefined, fetcher);
    const job = (await allRows(db, "research_jobs"))[0];
    const mergedSource = job.evidence![0];
    const { contentWithoutMetadata, supportedAnalysis } = await import(
      "../src/research/providers"
    );
    const body = contentWithoutMetadata(mergedSource);
    expect(body.match(new RegExp(credit.quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2);
    expect(body).toMatch(/Channel\s*:\s*Vocal: Alice|Channel\s*:\s*Music: Bob/);
    expect(body).toMatch(/Description\s+Vocal: Alice|Description\s+Music: Bob/);
    const analysis = supportedAnalysis(
      JSON.stringify({
        recordings: [
          {
            title: "Blue Song",
            reference_url: url,
            kind: "original",
            source_id: "s0",
            quote: "Blue Song official",
            credits: [
              {
                name: credit.name,
                kind: "person",
                role: credit.role,
                source_id: "s0",
                quote: credit.quote,
                aliases: [],
              },
            ],
            tags: [],
          },
        ],
      }),
      job.evidence!,
      { title: "Blue Song", artist_hint: null, reference_url: url },
      [],
    );
    expect(analysis.recordings[0].credits[0]).toMatchObject({
      name: credit.name,
      role: credit.role,
    });
  },
);

it("marks an empty group once and searches the next missing category independently", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "infer" as const,
    descriptive_coverage: { genre_sound: "complete" as const },
    evidence: [
      {
        id: "s0",
        url,
        title: "Blue Song lyrics",
        content: "The lyrics describe lost love and hope.",
      },
    ],
  };
  await insert("research_jobs", selected);
  const queries: string[] = [];
  const f = (async (input: any, init: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/search")) {
      queries.push(JSON.parse(init.body).query);
      return json({ results: [] });
    }
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("describe_search");
  expect(job.descriptive_category).toBe("mood_energy_tempo");

  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("infer");
  expect(job.descriptive_coverage).toMatchObject({
    genre_sound: "complete",
    mood_energy_tempo: "complete",
  });

  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("describe_search");
  expect(job.descriptive_category).toBe("voice");
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("BPM");
});

it("retries a 429 in the same descriptor group before marking it complete", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "describe_search" as const,
    descriptive_category: "mood_energy_tempo",
    descriptive_coverage: { genre_sound: "complete" as const },
    evidence: [{ id: "s0", url, title: "Blue Song", content: "Blue Song." }],
  };
  await insert("research_jobs", selected);
  const searchQueries: string[] = [];
  let searchCount = 0;
  const f = (async (input: any, init: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/search")) {
      searchQueries.push(JSON.parse(init.body).query);
      if (++searchCount === 1) return json({ error: "cool down" }, 429);
      return json({ results: [] });
    }
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job).toMatchObject({
    status: "queued",
    stage: "describe_search",
    descriptive_category: "mood_energy_tempo",
    attempts: 1,
  });
  expect(job.descriptive_coverage).toEqual({ genre_sound: "complete" });

  await wake();
  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("infer");
  expect(job.descriptive_coverage).toEqual({
    genre_sound: "complete",
    mood_energy_tempo: "complete",
  });
  expect(searchQueries).toHaveLength(2);
  expect(searchQueries[1]).toBe(searchQueries[0]);
});

it("keeps the global 429 retry window after a descriptor group becomes unavailable", async () => {
  const work = await insert(
    "works",
    newRow({ title: "Blue Song", manual_lock: false }),
  );
  const version = await insert(
    "versions",
    newRow({
      work_id: work.id,
      title: "Blue Song",
      kind: "original",
      reference_url: url,
      uploader_entity_id: null,
      research_status: "queued",
      manual_lock: false,
    }),
  );
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "describe_search" as const,
    descriptive_category: "mood_energy_tempo",
    descriptive_coverage: { genre_sound: "complete" as const },
    attempts: 3,
    next_attempt_at: "2000-01-01T00:00:00Z",
    evidence: [{ id: "s0", url, title: "Blue Song", content: "Blue Song." }],
  };
  await insert("research_jobs", selected);
  let searches = 0;
  const f = (async (input: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/search")) {
      searches++;
      return new Response(JSON.stringify({ error: "cool down" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "120" },
      });
    }
    return json({});
  }) as typeof fetch;

  const attemptedAt = Date.now();
  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job).toMatchObject({
    stage: "infer",
    descriptive_status: "unavailable",
    descriptive_coverage: {
      genre_sound: "complete",
      mood_energy_tempo: "unavailable",
    },
    last_error: "PROVIDER_HTTP_429",
  });
  expect(Date.parse(job.next_attempt_at) - attemptedAt).toBeGreaterThan(900_000);
  expect(searches).toBe(1);

  await wake();
  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("describe_search");
  expect(job.descriptive_category).toBe("voice");
  expect(searches).toBe(1);
});

it("marks a terminal descriptor failure unavailable and continues with another group", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "describe_search" as const,
    descriptive_category: "mood_energy_tempo",
    descriptive_coverage: { genre_sound: "complete" as const },
    evidence: [{ id: "s0", url, title: "Blue Song", content: "Blue Song." }],
  };
  await insert("research_jobs", selected);
  const f = (async (input: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/search"))
      return json({ error: "invalid search" }, 401);
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("infer");
  expect(job.descriptive_coverage).toMatchObject({
    genre_sound: "complete",
    mood_energy_tempo: "unavailable",
  });

  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("describe_search");
  expect(job.descriptive_category).toBe("voice");
});

it("fits all active tag definitions while retaining evidence for more than five researched tags", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original" as const,
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued" as const,
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const content = [
    "Blue Song",
    "The genre combines electronic dance-pop with synth-led production.",
    "The dreamy and bright mood of the song moves with a light, bouncy rhythm at a fast tempo.",
    "The clear and transparent vocals carry a warm tone.",
    "The lyrics describe love and hope for tomorrow.",
  ].join("\n\n");
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    analysis_version: "2",
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "infer" as const,
    descriptive_coverage: {
      genre_sound: "complete" as const,
      mood_energy_tempo: "complete" as const,
      voice: "complete" as const,
      lyric_theme: "complete" as const,
    },
    evidence: [
      {
        id: "s0",
        url,
        title: "Blue Song",
        content,
        metadata: {
          provider: "youtube_oembed" as const,
          endpoint:
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&format=json",
          title: "Blue Song",
          author_name: "Singer",
        },
      },
    ],
  };
  await insert("research_jobs", selected);

  const proposedTags = [
    {
      tag_id: "tag-07",
      source_id: "s0",
      quote: "The genre combines electronic dance-pop with synth-led production.",
      reasoning:
        "The genre description identifies electronic production and dance-pop as the song's musical style.",
    },
    {
      tag_id: "tag-08",
      source_id: "s0",
      quote: "The genre combines electronic dance-pop with synth-led production.",
      reasoning:
        "The genre description explicitly names dance-pop as the combined musical style.",
    },
    {
      tag_id: "tag-13",
      source_id: "s0",
      quote: "The dreamy and bright mood of the song",
      reasoning:
        "The mood description directly characterizes the song as bright.",
    },
    {
      tag_id: "tag-17",
      source_id: "s0",
      quote: "The dreamy and bright mood of the song",
      reasoning:
        "The mood description directly characterizes the song as dreamy.",
    },
    {
      tag_id: "tag-24",
      source_id: "s0",
      quote: "a light, bouncy rhythm",
      reasoning:
        "The rhythm is explicitly described as light and bouncy, supporting the song's energetic performance.",
    },
    {
      tag_id: "tag-32",
      source_id: "s0",
      quote: "a fast tempo",
      reasoning:
        "The description directly states the song's fast tempo.",
    },
    {
      tag_id: "tag-38",
      source_id: "s0",
      quote: "The clear and transparent vocals",
      reasoning:
        "The voice description directly identifies a clear and transparent vocal tone.",
    },
    {
      tag_id: "tag-43",
      source_id: "s0",
      quote: "The lyrics describe love",
      reasoning:
        "The lyrics description identifies love as one of the song's themes.",
    },
    {
      tag_id: "tag-47",
      source_id: "s0",
      quote: "hope for tomorrow",
      reasoning:
        "The lyrics description identifies hope as one of the song's themes.",
    },
  ];
  const analysis = {
    recordings: [
      {
        title: "Blue Song",
        reference_url: url,
        kind: "original",
        source_id: "s0",
        quote: "Blue Song",
        credits: [],
        tags: proposedTags,
      },
    ],
  };
  let sent: any;
  const f = (async (input: any, init: any) => {
    if (String(input).includes("api.groq.com")) {
      sent = JSON.parse(init.body);
      return json({
        choices: [{ message: { content: JSON.stringify(analysis) } }],
      });
    }
    return json({});
  }) as typeof fetch;

  await measuredLiveDrain(f, 1);
  const job = (await allRows(db, "research_jobs"))[0];
  const { requestTokenEstimate } = await import("../src/research/providers");
  expect(requestTokenEstimate(sent)).toBeLessThanOrEqual(7600);
  const userInput = JSON.parse(sent.messages[1].content);
  expect(userInput.tags.length).toBeLessThan(50);
  expect(userInput.sources).toEqual(job.evidence);
  expect(userInput.sources[0].content).toContain(
    "The genre combines electronic dance-pop with synth-led production.",
  );
  expect(job.analysis?.recordings[0].tags.length).toBeGreaterThan(5);
});

it("publishes a release-article tag through worker association without accepting its credit", async () => {
  const articleUrl = "https://note.com/eveningmusic/n/single-release";
  const releaseUrl = "https://tayori.lnk.to/Mirage";
  const work = newRow({ title: "蜃気楼", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "蜃気楼",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const excluded = newRow({
    version_id: version.id,
    tag_id: "tag-32",
    evidence: "Owner excluded this tag",
    source_id: null,
    origin: "participant",
    confirmed: false,
    manual_lock: true,
  });
  await insert("tag_assignments", excluded);
  const nativeTitle = "tayori - 蜃気楼";
  const metadataEndpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    analysis_version: "2",
    query: { title: "蜃気楼", artist_hint: null, reference_url: url },
    stage: "describe_extract" as const,
    descriptive_category: "genre_sound",
    descriptive_source_ids: ["s1"],
    descriptive_coverage: {
      genre_sound: "complete" as const,
      mood_energy_tempo: "complete" as const,
      voice: "complete" as const,
      lyric_theme: "complete" as const,
    },
    evidence: [
      {
        id: "s0",
        url,
        title: nativeTitle,
        content: nativeTitle,
        metadata: {
          provider: "youtube_oembed" as const,
          endpoint: metadataEndpoint,
          title: nativeTitle,
          author_name: "tayori",
        },
      },
      {
        id: "s1",
        url: articleUrl,
        title: "tayori、新曲「蜃気楼」をリリース",
        content: "tayori、新曲「蜃気楼」をリリース。",
      },
    ],
  };
  await insert("research_jobs", selected);
  const articleRaw = [
    "## リリース情報",
    "tayori、新曲「蜃気楼」をリリース。",
    `配信はこちら: ${releaseUrl}`,
    "## 楽曲紹介",
    "電子音を中心とするサウンドとアップテンポなビート。",
    "Music: Alice",
  ].join("\n");
  const analysis = {
    recordings: [
      {
        title: "蜃気楼",
        reference_url: url,
        kind: "original",
        source_id: "s0",
        quote: "蜃気楼",
        credits: [
          {
            name: "Alice",
            kind: "person",
            role: "composer",
            source_id: "s1",
            quote: "Music: Alice",
            aliases: [],
          },
        ],
        tags: [
          {
            tag_id: "tag-07",
            source_id: "s1",
            quote: "電子音を中心とするサウンド",
            reasoning:
              "ジャンル説明で電子音を中心とするサウンドが明示され、電子音楽の特徴を直接裏付ける。",
          },
          {
            tag_id: "tag-32",
            source_id: "s1",
            quote: "アップテンポなビート",
            reasoning:
              "テンポの説明でアップテンポと明示され、速いテンポの基準に合致する。",
          },
        ],
      },
    ],
  };
  const f = (async (input: any, init: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/extract")) {
      expect(JSON.parse(init.body).urls).toEqual([articleUrl]);
      return json({ results: [{ url: articleUrl, raw_content: articleRaw }] });
    }
    if (target.includes("api.groq.com"))
      return json({
        choices: [{ message: { content: JSON.stringify(analysis) } }],
      });
    return json({});
  }) as typeof fetch;

  await measuredLiveDrain(f, 1);
  let job = (await allRows(db, "research_jobs"))[0];
  const article = job.evidence?.find((source) => source.id === "s1")!;
  const { linkedDescriptionRecording, linkedRecording } = await import(
    "../src/research/providers"
  );
  expect(linkedRecording(article, url)).toBe(false);
  expect(linkedDescriptionRecording(article, url)).toBe(true);
  expect(article.recording_associations?.[0]).toMatchObject({
    reference_url: url,
    basis: "official_release",
    artist: "tayori",
    release_url: releaseUrl,
  });

  await measuredLiveDrain(f, 2);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("metadata");
  expect(job.analysis?.recordings[0].tags.map((tag) => tag.tag_id)).toEqual([
    "tag-07",
    "tag-32",
  ]);
  expect(job.analysis?.recordings[0].credits).toEqual([]);
  await measuredLiveDrain(f, 5);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("done");
  const assignments = await allRows(db, "tag_assignments");
  expect(assignments.find((tag) => tag.id !== excluded.id)).toMatchObject({
    tag_id: "tag-07",
    confirmed: true,
    source_id: expect.any(String),
  });
  expect(assignments.find((tag) => tag.id === excluded.id)).toEqual(excluded);
  const tagSource = (await allRows(db, "sources")).find(
    (source) => source.id === assignments.find((tag) => tag.id !== excluded.id)?.source_id,
  );
  expect(tagSource?.url).toBe(articleUrl);
  expect(await allRows(db, "credits")).toHaveLength(0);
});

it("marks a legacy inference job with the current analysis version and skips an empty tag request", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    analysis_version: "1",
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "infer" as const,
    descriptive_coverage: {
      genre_sound: "complete" as const,
      mood_energy_tempo: "complete" as const,
      voice: "complete" as const,
      lyric_theme: "complete" as const,
    },
    evidence: [
      {
        id: "s0",
        url,
        title: "Blue Song",
        content: "Blue Song",
        metadata: {
          provider: "youtube_oembed" as const,
          endpoint:
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&format=json",
          title: "Blue Song",
          author_name: "Singer",
        },
      },
    ],
  };
  await insert("research_jobs", selected);
  let groqCalls = 0;
  const f = (async (input: any) => {
    if (String(input).includes("api.groq.com")) {
      groqCalls++;
      return json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                recordings: [
                  {
                    title: "Blue Song",
                    reference_url: url,
                    kind: "original",
                    source_id: "s0",
                    quote: "Blue Song",
                    credits: [],
                    tags: [],
                  },
                ],
              }),
            },
          },
        ],
      });
    }
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("infer");
  expect(job.analysis_version).toBe("2");
  expect(groqCalls).toBe(0);

  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("catalog");
  expect(job.analysis_version).toBe("2");
  expect(groqCalls).toBe(0);
  expect(job.analysis?.recordings[0]).toMatchObject({
    reference_url: url,
    kind: "other",
    credits: [{ role: "uploader", name: "Singer" }],
    tags: [],
  });
  expect(job.analysis?.review_warnings).toContain("NO_SUPPORTED_TAG_DESCRIPTIONS");
});

it("keeps a selected native recording as an uploader candidate when no tag definitions fit", async () => {
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const work = newRow({ title: "Scatman", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Scatman",
    kind: "original",
    reference_url: scatmanUrl,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    analysis_version: "2",
    query: {
      title: "Scatman",
      artist_hint: null,
      reference_url: scatmanUrl,
    },
    stage: "infer" as const,
    descriptive_coverage: {
      genre_sound: "complete" as const,
      mood_energy_tempo: "complete" as const,
      voice: "complete" as const,
      lyric_theme: "complete" as const,
    },
    evidence: [
      {
        id: "s0",
        url: scatmanUrl,
        title: metadata.title,
        metadata,
        content: JSON.stringify(metadata),
      },
    ],
  };
  await insert("research_jobs", selected);
  const usage = await insert(
    "usage",
    newRow({
      month: "2026-10",
      tavily_credits: 0,
      tavily_credit_cap: 800,
      groq_requests: 0,
      last_error: null,
    }),
  );
  let groqCalls = 0;
  const f = (async (input: any) => {
    if (String(input).includes("api.groq.com")) {
      groqCalls++;
      return json({
        choices: [{ message: { content: JSON.stringify({ recordings: [] }) } }],
      });
    }
    return json({});
  }) as typeof fetch;

  for (let i = 0; i < 12; i++) await run(env(), undefined, f);

  const job = (await allRows(db, "research_jobs")).find(
    (candidate) => candidate.id === selected.id,
  )!;
  expect(groqCalls).toBe(0);
  expect(job.stage).toBe("done");
  expect(job.status).toBe("needs_review");
  expect(job.analysis?.recordings).toHaveLength(1);
  expect(job.analysis?.recordings[0]).toMatchObject({
    reference_url: scatmanUrl,
    kind: "other",
    credits: [
      {
        role: "uploader",
        name: "Scatman John Official YouTube Channel",
      },
    ],
    tags: [],
  });
  expect(job.analysis?.review_warnings).toContain("NO_SUPPORTED_TAG_DESCRIPTIONS");
  expect((await allRows(db, "usage")).find((row) => row.id === usage.id)?.groq_requests).toBe(0);
});

it("preserves verified song-scoped evidence while another source is category-extracted", async () => {
  const { associateOfficialReleaseEvidence, linkedDescriptionRecording } =
    await import("../src/research/providers");
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
  const firstDescription =
    '"Scatman (Ski-Ba-Bop-Ba-Dop-Bop)" is a novelty synthpop dance song with a quirky Euro-NRG tone.';
  const artistContinuation =
    "As critics summarized, the lyrics contain spoken word and scatting, where Scatman John bends his tongue to rapid effect.";
  const secondDescription =
    'This is driven by a rapid techno groove and pitter-pattering drum machine.';
  const rawArticle = `## Composition\n\n${firstDescription} ${artistContinuation} ${secondDescription}`;
  const article = {
    id: "s4",
    url: articleUrl,
    title: "Scatman (Ski-Ba-Bop-Ba-Dop-Bop) - Wikipedia",
    content: rawArticle,
  };
  const associatedArticle = associateOfficialReleaseEvidence(
    [primary, article],
    query,
    { [articleUrl]: rawArticle },
  )[1];
  const songAssociation = associatedArticle.recording_associations?.find(
    (association) => association.provenance === "worker_verified_song_v1",
  );
  expect(songAssociation).toBeDefined();
  const partialArticle = {
    ...associatedArticle,
    content: songAssociation!.identity_quote,
  };
  const work = newRow({ title: "Scatman", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Scatman",
    kind: "original",
    reference_url: scatmanUrl,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const target = {
    id: "s1",
    url: "https://example.com/scatman-voice",
    title: "Scatman voice description",
    content: "A song description.",
  };
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    analysis_version: "2",
    query,
    stage: "describe_extract" as const,
    descriptive_category: "voice",
    descriptive_source_ids: [target.id],
    evidence: [primary, target, partialArticle],
  };
  await insert("research_jobs", selected);
  const f = (async (input: any) => {
    const targetUrl = String(input);
    if (targetUrl.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (targetUrl.endsWith("/extract"))
      return json({
        results: [{ url: target.url, raw_content: "A bright human vocal performance." }],
      });
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);

  const saved = (await allRows(db, "research_jobs")).find(
    (candidate) => candidate.id === selected.id,
  )!;
  const retainedArticle = saved.evidence?.find((source) => source.id === "s4")!;
  expect(saved.stage).toBe("infer");
  expect(retainedArticle.recording_associations?.[0]?.provenance).toBe(
    "worker_verified_song_v1",
  );
  expect(retainedArticle.content).toContain(secondDescription);
  expect(linkedDescriptionRecording(retainedArticle, scatmanUrl)).toBe(true);
});

it("still runs candidate lookup inference when no tag definitions fit", async () => {
  const r = await answer("Scatman");
  const currentJob = (await allRows(db, "research_jobs"))[0];
  const scatmanUrl = "https://www.youtube.com/watch?v=Hy8kmNEo1i8";
  const metadata = {
    provider: "youtube_oembed" as const,
    endpoint: `https://www.youtube.com/oembed?url=${encodeURIComponent(scatmanUrl)}&format=json`,
    title: "Scatman (ski-ba-bop-ba-dop-bop) Official Video HD - Scatman John",
    author_name: "Scatman John Official YouTube Channel",
  };
  const selected = {
    ...currentJob,
    purpose: "candidate_lookup" as const,
    response_revision: r.revision,
    analysis_version: "2",
    query: {
      title: "Scatman",
      artist_hint: "Scatman John",
      reference_url: scatmanUrl,
    },
    stage: "infer" as const,
    status: "queued" as const,
    next_attempt_at: "2000-01-01T00:00:00Z",
    lease_until: null,
    descriptive_coverage: {
      genre_sound: "complete" as const,
      mood_energy_tempo: "complete" as const,
      voice: "complete" as const,
      lyric_theme: "complete" as const,
    },
    evidence: [
      {
        id: "s0",
        url: scatmanUrl,
        title: metadata.title,
        metadata,
        content: JSON.stringify(metadata),
      },
    ],
  };
  await db
    .prepare("UPDATE research_jobs SET data=? WHERE id=?")
    .bind(JSON.stringify(selected), selected.id)
    .run();
  let groqCalls = 0;
  const f = (async (input: any) => {
    if (String(input).includes("api.groq.com")) {
      groqCalls++;
      return json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                recordings: [
                  {
                    title: metadata.title,
                    reference_url: scatmanUrl,
                    kind: "other",
                    source_id: "s0",
                    quote: metadata.title,
                    credits: [],
                    tags: [],
                  },
                ],
              }),
            },
          },
        ],
      });
    }
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);

  const job = (await allRows(db, "research_jobs")).find(
    (candidate) => candidate.id === r.id || candidate.id === selected.id,
  )!;
  expect(job.stage).toBe("catalog");
  expect(groqCalls).toBe(1);
  expect(job.analysis?.recordings[0].reference_url).toBe(scatmanUrl);
});

it("moves a legacy generic descriptor extraction into the independent group cycle", async () => {
  const work = newRow({ title: "Blue Song", manual_lock: false });
  const version: Version = newRow({
    work_id: work.id,
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "queued",
    manual_lock: false,
  });
  await insert("works", work);
  await insert("versions", version);
  const selected = {
    ...researchJob(version),
    purpose: "tag_enrichment" as const,
    query: { title: "Blue Song", artist_hint: null, reference_url: url },
    stage: "describe_extract" as const,
    descriptive_status: "complete" as const,
    descriptive_source_ids: ["s1"],
    evidence: [
      {
        id: "s0",
        url,
        title: "Blue Song",
        content: "Blue Song",
        metadata: {
          provider: "youtube_oembed" as const,
          endpoint:
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&format=json",
          title: "Blue Song",
          author_name: "Singer",
        },
      },
      {
        id: "s1",
        url: "https://example.com/blue-song",
        title: "Blue Song description",
        content: "Blue Song older generic description result.",
      },
    ],
  };
  await insert("research_jobs", selected);
  let searches = 0;
  let extracts = 0;
  const f = (async (input: any, init: any) => {
    const target = String(input);
    if (target.endsWith("/usage"))
      return json({
        account: {
          current_plan: "Researcher",
          plan_usage: 0,
          plan_limit: 1000,
          paygo_usage: 0,
        },
        key: { usage: 0, limit: 1000 },
      });
    if (target.endsWith("/extract")) {
      extracts++;
      expect(JSON.parse(init.body).urls).toEqual([
        "https://example.com/blue-song",
      ]);
      return json({
        results: [
          {
            url: "https://example.com/blue-song",
            raw_content: "Blue Song older generic description result.",
          },
        ],
      });
    }
    if (target.endsWith("/search")) {
      searches++;
      return json({ results: [] });
    }
    return json({});
  }) as typeof fetch;

  await run(env(), undefined, f);
  let job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("infer");
  expect(job.descriptive_status).toBe("complete");
  expect(job.descriptive_coverage).toBeUndefined();
  expect(extracts).toBe(1);

  await run(env(), undefined, f);
  job = (await allRows(db, "research_jobs"))[0];
  expect(job.stage).toBe("describe_search");
  expect(job.descriptive_category).toBe("genre_sound");
  expect(searches).toBe(0);
});

it.each([
  { label: "old completed job", analysis_version: "1", status: "complete", automatic: true, queued: true },
  { label: "current completed job", analysis_version: "2", status: "complete", automatic: true, queued: false },
  { label: "active current job", analysis_version: "2", status: "queued", automatic: true, queued: false },
  { label: "manual refresh", analysis_version: "2", status: "complete", automatic: false, queued: true },
])("$label tag research queueing follows the analysis version", async (scenario) => {
  const version: Version = newRow({
    work_id: "work-1",
    title: "Blue Song",
    kind: "original",
    reference_url: url,
    uploader_entity_id: null,
    research_status: "complete",
    manual_lock: true,
  });
  const old = {
    ...researchJob(version),
    stage: "done" as const,
    purpose: "tag_enrichment" as const,
    analysis_version: scenario.analysis_version,
    status: scenario.status as ResearchJob["status"],
    descriptive_status: "complete" as const,
    descriptive_source_ids: ["s1"],
    descriptive_category: "lyric_theme",
    descriptive_coverage: { lyric_theme: "complete" as const },
  };
  await insert("research_jobs", old);
  const changes: any[] = [];

  await queueTagResearch(env(), version, changes, scenario.automatic);

  const queued = changes.find((change) => change.table === "research_jobs")?.after;
  expect(Boolean(queued)).toBe(scenario.queued);
  if (scenario.queued) {
    expect(queued).toMatchObject({
      status: "queued",
      stage: "search",
      purpose: "tag_enrichment",
      analysis_version: "2",
    });
    expect(queued.descriptive_status).toBeUndefined();
    expect(queued.descriptive_source_ids).toBeUndefined();
    expect(queued.descriptive_category).toBeUndefined();
    expect(queued.descriptive_coverage).toBeUndefined();
  }
});
