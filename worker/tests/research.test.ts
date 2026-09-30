import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import {
  runResearchQueue as run,
  reserveCredits as reserve,
} from "../src/research/runner";
import { newRow, allRows } from "../src/store";
import { researchJob, safeUrl, candidates } from "../src/catalog";
import type { WorkerEnv, ResearchJob } from "../../shared/contracts";
let mf: Miniflare, db: D1Database;
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
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
});
beforeEach(async () => {
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
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
  expect(await allRows(db, "credits")).toHaveLength(0);
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
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
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
  expect((await allRows(db, "responses"))[0].version_id).toBeNull();
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
import { validateAnalysis } from "../src/research/providers";
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
