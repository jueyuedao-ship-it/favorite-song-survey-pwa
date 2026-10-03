import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { pbkdf2Sync, createHash } from "node:crypto";
import worker from "../src/index";
import type { WorkerEnv } from "../../shared/contracts";
import { registerRuntimeTransport } from "./miniflare-transport";
let closeTransport: () => Promise<void>;

let mf: Miniflare;
let db: D1Database;
let admin: string;
const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const INVITE = "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII";
const SYNC = "test-only-collector-secret";
let serial = 0;
function op() {
  return `test-operation-${++serial}`;
}
/** A scheduling gate over real D1 reads, never a fabricated database result. */
function pauseFirstReplayRead(real: D1Database) {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "first")
          return async (column?: string) => {
            const value =
              column === undefined
                ? await target.first()
                : await target.first(column);
            if (!paused) {
              paused = true;
              entered();
              await resume;
            }
            return value;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const gated = new Proxy(real, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          return !paused &&
            sql.startsWith("SELECT fingerprint,response,status FROM operations")
            ? wrap(statement)
            : statement;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: gated, reached, release };
}
/** Pause before the actual write transaction; every statement still runs in real D1. */
function pauseFirstBatch(real: D1Database) {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    resume = new Promise<void>((resolve) => {
      release = resolve;
    });
  let paused = false;
  const gated = new Proxy(real, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!paused) {
            paused = true;
            entered();
            await resume;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: gated, reached, release };
}
async function directRetry(
  path: string,
  method: string,
  body: unknown,
  token: string | undefined,
  gate: ReturnType<typeof pauseFirstReplayRead>,
) {
  const bindings = (await mf.getBindings()) as unknown as WorkerEnv;
  const result = await worker.fetch(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { ...bindings, DB: gate.db },
    {} as ExecutionContext,
  );
  return { status: result.status, ...((await result.json()) as any) };
}
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  const response = await mf.dispatchFetch(`http://localhost/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...((await response.json()) as any) };
}
async function register(name: string, secret: string) {
  const result = await api("/guest/create", "POST", {
    name,
    device_label: "test browser",
    device_secret: secret,
    operation_id: op(),
  });
  expect(result.status).toBe(201);
  return result.data.participant;
}
async function row(table: string, values: any) {
  const result = await api(
    `/admin/data/${table}`,
    "POST",
    { operation_id: op(), values },
    admin,
  );
  expect(result.status, JSON.stringify(result)).toBe(201);
  return result.data;
}
async function version(
  title = "Shared song",
  kind = "original",
  workId?: string,
) {
  const work = workId ? { id: workId } : await row("works", { title });
  return row("versions", {
    work_id: work.id,
    title,
    kind,
    reference_url: null,
    uploader_entity_id: null,
    research_status: "unconfirmed",
    manual_lock: false,
  });
}
async function record(
  token: string,
  versionId: string | null,
  date: string,
  operationId = op(),
  participantId?: string,
) {
  return api(
    "/records",
    "POST",
    {
      operation_id: operationId,
      version_id: versionId,
      record_date: date,
      ...(versionId ? {} : { unresolved_title: "Unconfirmed tune" }),
      ...(participantId ? { participant_id: participantId } : {}),
    },
    token,
  );
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["worker/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  const salt = "0123456789abcdef0123456789abcdef";
  const hash = Buffer.from(
    pbkdf2Sync(
      "integration-password",
      Buffer.from(salt, "hex"),
      100000,
      32,
      "sha256",
    ),
  ).toString("hex");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
      bindings: {
        ADMIN_PASSWORD_HASH: `pbkdf2$100000$${salt}$${hash}`,
        SYNC_TOKEN_HASH: createHash("sha256").update(SYNC).digest("hex"),
        ALLOWED_ORIGINS: "http://localhost:5173",
        GROQ_MODEL: "qwen/qwen3.8-27b",
      },
    }),
  );
  closeTransport = await registerRuntimeTransport(mf);
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
});
beforeEach(async () => {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .all<{ name: string }>();
  await db.exec("PRAGMA foreign_keys = OFF");
  for (const table of tables.results)
    await db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
  await db.exec("PRAGMA foreign_keys = ON");
  for (const file of (await readdir("worker/schema"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(`worker/schema/${file}`, "utf8");
    // exec uses lines, so each migration statement is flattened without comments.
    const statements = sql
      .replace(/--[^\n]*/g, "")
      .replace(/\r?\n/g, " ")
      .trim();
    if (statements) await db.exec(statements);
  }
  const login = await api("/admin/login", "POST", {
    password: "integration-password",
  });
  expect(login.status).toBe(200);
  admin = login.data.session_token;
});
afterAll(async () => {
  await mf?.dispose();
  await closeTransport();
});

describe("D1 HTTP capability and mutation integrity", () => {
  it("a new answer selecting a catalog candidate also queues incomplete tag research", async () => {
    await register("A",A);const song=await version();
    const job=(await api("/admin/jobs","GET",undefined,admin)).data.items.find((j:any)=>j.version_id===song.id);
    await db.prepare("UPDATE research_jobs SET data=json_set(data,'$.status','needs_review','$.stage','done') WHERE id=?").bind(job.id).run();
    expect((await record(A,song.id,"2026-09-30")).status).toBe(201);
    expect((await api("/admin/jobs","GET",undefined,admin)).data.items.find((j:any)=>j.id===job.id)).toMatchObject({status:"queued",purpose:"tag_enrichment",stage:"search"});
  });
  it("date-only editing preserves a manual lookup query different from the saved unresolved title", async () => {
    await register("A", A); const rec=await record(A,null,"2026-09-30");
    const initial=(await api("/admin/jobs","GET",undefined,admin)).data.items.find((j:any)=>j.response_id===rec.data.id);
    await db.prepare("UPDATE research_jobs SET data=json_set(data,'$.status','needs_review') WHERE id=?").bind(initial.id).run();
    expect((await api(`/records/${rec.data.id}/research`,"POST",{operation_id:op(),expected_revision:1,kind:"candidates",title:"Different search"},A)).status).toBe(200);
    expect((await api(`/records/${rec.data.id}`,"PATCH",{operation_id:op(),expected_revision:1,record_date:"2026-09-29"},A)).status).toBe(200);
    const job=(await api("/admin/jobs","GET",undefined,admin)).data.items.find((j:any)=>j.response_id===rec.data.id);
    expect(job).toMatchObject({purpose:"candidate_lookup",response_revision:2,query:{title:"Different search"}});
  });
  it("manual candidate lookup tracks changed unresolved queries and survives date-only edits", async () => {
    await register("A", A);
    const rec = await record(A, null, "2026-09-30");
    const original = (await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.response_id === rec.data.id);
    await db.prepare("UPDATE research_jobs SET data=json_set(data,'$.status','needs_review') WHERE id=?").bind(original.id).run();
    expect((await api(`/records/${rec.data.id}/research`, "POST", {operation_id:op(),expected_revision:1,kind:"candidates",title:"Unconfirmed tune"}, A)).status).toBe(200);
    const changed = await api(`/records/${rec.data.id}`, "PATCH", {operation_id:op(),expected_revision:1,unresolved_title:"New tune"}, A);
    expect(changed.status).toBe(200);
    let lookup = (await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === original.id);
    const { sourceQuery } = await import("../src/research/state");
    expect(await sourceQuery({ DB: db } as WorkerEnv, lookup)).toMatchObject({title:"New tune"});
    expect((await api(`/records/${rec.data.id}`, "PATCH", {operation_id:op(),expected_revision:2,record_date:"2026-09-29"}, A)).status).toBe(200);
    lookup = (await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === original.id);
    expect(await sourceQuery({ DB: db } as WorkerEnv, lookup)).toMatchObject({title:"New tune"});
    expect(lookup).toMatchObject({stage:"search",status:"queued"});
  });
  it("candidate re-search prefers an active lookup over a historical tombstone", async () => {
    await register("A", A); const song=await version(), rec=await record(A,null,"2026-09-30");
    const initial=(await api("/admin/jobs","GET",undefined,admin)).data.items.find((j:any)=>j.response_id===rec.data.id);
    await db.prepare("UPDATE research_jobs SET id='00000000-old',data=json_set(data,'$.id','00000000-old') WHERE id=?").bind(initial.id).run();
    expect((await api(`/records/${rec.data.id}`,"PATCH",{operation_id:op(),expected_revision:1,version_id:song.id},A)).status).toBe(200);
    expect((await api(`/records/${rec.data.id}`,"PATCH",{operation_id:op(),expected_revision:2,version_id:null,unresolved_title:"Other tune"},A)).status).toBe(200);
    expect((await api(`/records/${rec.data.id}/research`,"POST",{operation_id:op(),expected_revision:3,kind:"candidates",title:"Other tune"},A)).status).toBe(200);
    expect((await api("/admin/jobs","GET",undefined,admin)).data.items.filter((j:any)=>j.response_id===rec.data.id)).toHaveLength(1);
  });
  it("candidate confirmation atomically restarts incomplete shared tag research without date-edit duplicates", async () => {
    await register("A", A);
    const song = await version("Mirage"), unknown = await record(A, null, "2026-09-30");
    const job = (await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.version_id === song.id);
    await db.prepare("UPDATE research_jobs SET data=json_set(data,'$.status','needs_review','$.stage','done','$.descriptive_status','complete','$.raw_model','old','$.analysis',json('{}')) WHERE id=?").bind(job.id).run();
    const body = { operation_id: op(), expected_revision: 1, version_id: song.id };
    expect((await api(`/records/${unknown.data.id}`, "PATCH", body, A)).status).toBe(200);
    const after = (await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === job.id);
    expect(after).toMatchObject({ status: "queued", stage: "search", purpose: "tag_enrichment", candidates: [] });
    expect(after.analysis).toBeUndefined(); expect(after.descriptive_status).toBeUndefined();
    const replay = await api(`/records/${unknown.data.id}`, "PATCH", body, A);
    expect(replay.status).toBe(200);
    expect((await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === job.id).revision).toBe(after.revision);
    expect((await api(`/records/${unknown.data.id}`, "PATCH", { operation_id: op(), expected_revision: 2, record_date: "2026-09-29" }, A)).status).toBe(200);
    expect((await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === job.id).revision).toBe(after.revision);
  });

  it("manual research requests preserve resolved answers, reject other owners and coalesce active jobs", async () => {
    await register("A", A); await register("B", B);
    const song = await version("Mirage"), rec = await record(A, song.id, "2026-09-30");
    const path = `/records/${rec.data.id}/research`;
    expect((await api(path, "POST", { operation_id: op(), expected_revision: 1, kind: "candidates", title: "Mirage" }, B)).status).toBe(403);
    const body = { operation_id: op(), expected_revision: 1, kind: "candidates", title: "Mirage" };
    const started = await api(path, "POST", body, A);
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ lookup_status: "queued", candidates: [] });
    const jobs = (await api("/admin/jobs", "GET", undefined, admin)).data.items;
    const lookup = jobs.find((j: any) => j.response_id === rec.data.id);
    expect(lookup).toMatchObject({ purpose: "candidate_lookup", response_revision: 1, status: "queued" });
    expect((await api(path, "POST", { ...body, operation_id: op() }, A)).status).toBe(200);
    expect((await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === lookup.id).revision).toBe(lookup.revision);
    expect((await api("/records")).data.items.find((r: any) => r.id === rec.data.id)).toEqual(rec.data);
    expect((await api(path, "POST", { operation_id: op(), expected_revision: 1, kind: "tags" }, A)).status).toBe(200);
    expect((await api(path, "POST", { operation_id: op(), expected_revision: 99, kind: "tags" }, A)).status).toBe(409);
    expect((await api("/records")).data.items.find((r: any) => r.id === rec.data.id)).toEqual(rec.data);
  });

  it("unresolved answers cannot start tag research and confirmation retains completed shared research", async () => {
    await register("A", A);
    const song = await version(), rec = await record(A, null, "2026-09-30");
    expect((await api(`/records/${rec.data.id}/research`, "POST", { operation_id: op(), expected_revision: 1, kind: "tags" }, A)).status).toBe(400);
    const job = (await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.version_id === song.id);
    await db.prepare("UPDATE research_jobs SET data=json_set(data,'$.status','complete','$.stage','done') WHERE id=?").bind(job.id).run();
    expect((await api(`/records/${rec.data.id}`, "PATCH", { operation_id: op(), expected_revision: 1, version_id: song.id }, A)).status).toBe(200);
    expect((await api("/admin/jobs", "GET", undefined, admin)).data.items.find((j: any) => j.id === job.id).status).toBe("complete");
  });
  it.each(["PATCH", "DELETE"] as const)(
    "replays identical %s after its winner commits between initial replay read and guarded build",
    async (method) => {
      await register("A", A);
      const song = await version(),
        rec = await record(A, song.id, "2026-09-28");
      const path = `/records/${rec.data.id}`,
        body = {
          operation_id: op(),
          expected_revision: 1,
          ...(method === "PATCH" ? { record_date: "2026-09-29" } : {}),
        };
      const gate = pauseFirstReplayRead(db),
        retry = directRetry(path, method, body, A, gate);
      await gate.reached;
      const winner = await api(path, method, body, A);
      expect(winner.status).toBe(200);
      const afterWinner = (await api("/admin/export", "GET", undefined, admin))
        .data;
      gate.release();
      const replayed = await retry;
      expect(replayed.status).toBe(200);
      expect(replayed.data).toEqual(winner.data);
      const afterReplay = (await api("/admin/export", "GET", undefined, admin))
        .data;
      expect(afterReplay.high_watermark).toBe(afterWinner.high_watermark);
      expect(afterReplay.tables.responses).toEqual(
        afterWinner.tables.responses,
      );
      expect(afterReplay.tables.audit).toEqual(afterWinner.tables.audit);
      const differentOperation = await api(
        path,
        method,
        { ...body, operation_id: op() },
        A,
      );
      expect(differentOperation.status).toBe(method === "PATCH" ? 409 : 404);
    },
  );
  it("replays identical invite claim after its winner consumes the invite between replay read and build", async () => {
    const person = await row("participants", { name: "Invited replay" });
    expect(
      (
        await api(
          "/admin/invites",
          "POST",
          {
            operation_id: op(),
            participant_id: person.id,
            invite_secret: INVITE,
          },
          admin,
        )
      ).status,
    ).toBe(201);
    const body = {
        operation_id: op(),
        invite_secret: INVITE,
        device_secret: A,
        device_label: "Phone",
      },
      gate = pauseFirstReplayRead(db);
    const retry = directRetry("/guest/claim", "POST", body, undefined, gate);
    await gate.reached;
    const winner = await api("/guest/claim", "POST", body);
    expect(winner.status).toBe(201);
    const afterWinner = (await api("/admin/export", "GET", undefined, admin))
      .data;
    gate.release();
    const replayed = await retry;
    expect(replayed.status).toBe(201);
    expect(replayed.data).toEqual(winner.data);
    const afterReplay = (await api("/admin/export", "GET", undefined, admin))
      .data;
    expect(afterReplay.high_watermark).toBe(afterWinner.high_watermark);
    expect(afterReplay.tables.devices).toEqual(afterWinner.tables.devices);
    expect(afterReplay.tables.audit).toEqual(afterWinner.tables.audit);
    expect(
      (await api("/guest/claim", "POST", { ...body, operation_id: op() }))
        .status,
    ).toBe(409);
  });
  it.each(["credits", "tag_assignments"] as const)(
    "rejects moving a source already referenced by active %s while allowing same-version and unused edits",
    async (table) => {
      const first = await version("First"),
        second = await version("Second");
      const source = await row("sources", {
        version_id: first.id,
        url: "https://example.org/first",
        title: "First evidence",
        excerpt: "Explicit evidence",
        origin: "admin",
      });
      const values =
        table === "credits"
          ? {
              entity_id: (
                await row("entities", { name: "Singer", kind: "person" })
              ).id,
              role: "vocalist",
            }
          : {
              tag_id: "tag-01",
              evidence: "Explicit tag evidence",
              origin: "admin",
            };
      await row(table, {
        ...values,
        version_id: first.id,
        source_id: source.id,
        confirmed: true,
      });
      const before = (await api("/admin/export", "GET", undefined, admin)).data;
      const rejected = await api(
        `/admin/data/sources/${source.id}`,
        "PATCH",
        {
          operation_id: op(),
          expected_revision: 1,
          values: { version_id: second.id },
        },
        admin,
      );
      expect(rejected.status).toBe(409);
      const after = (await api("/admin/export", "GET", undefined, admin)).data;
      expect(after.high_watermark).toBe(before.high_watermark);
      expect(after.tables.sources).toEqual(before.tables.sources);
      expect(after.tables.audit).toEqual(before.tables.audit);
      const same = await api(
        `/admin/data/sources/${source.id}`,
        "PATCH",
        {
          operation_id: op(),
          expected_revision: 1,
          values: { version_id: first.id, excerpt: "Corrected evidence" },
        },
        admin,
      );
      expect(same.status).toBe(200);
      const unused = await row("sources", {
        version_id: first.id,
        url: "https://example.org/unused",
        title: "Unreferenced evidence",
        excerpt: "Evidence",
        origin: "admin",
      });
      expect(
        (
          await api(
            `/admin/data/sources/${unused.id}`,
            "PATCH",
            {
              operation_id: op(),
              expected_revision: 1,
              values: { version_id: second.id },
            },
            admin,
          )
        ).status,
      ).toBe(200);
    },
  );
  it.each(["credits", "tag_assignments"] as const)(
    "checks reverse %s references inside the source write transaction after a concurrent insertion",
    async (table) => {
      const first = await version("Concurrent first"),
        second = await version("Concurrent second");
      const source = await row("sources", {
        version_id: first.id,
        url: "https://example.org/concurrent",
        title: "Evidence",
        excerpt: "Explicit evidence",
        origin: "admin",
      });
      const values =
        table === "credits"
          ? {
              entity_id: (
                await row("entities", { name: "Singer", kind: "person" })
              ).id,
              role: "vocalist",
            }
          : {
              tag_id: "tag-01",
              evidence: "Explicit tag evidence",
              origin: "admin",
            };
      const gate = pauseFirstBatch(db),
        move = directRetry(
          `/admin/data/sources/${source.id}`,
          "PATCH",
          {
            operation_id: op(),
            expected_revision: 1,
            values: { version_id: second.id },
          },
          admin,
          gate,
        );
      await gate.reached;
      await row(table, {
        ...values,
        version_id: first.id,
        source_id: source.id,
        confirmed: true,
      });
      const afterInsert = (await api("/admin/export", "GET", undefined, admin))
        .data;
      gate.release();
      expect((await move).status).toBe(409);
      const afterMove = (await api("/admin/export", "GET", undefined, admin))
        .data;
      expect(afterMove.high_watermark).toBe(afterInsert.high_watermark);
      expect(afterMove.tables.sources).toEqual(afterInsert.tables.sources);
      expect(afterMove.tables[table]).toEqual(afterInsert.tables[table]);
      expect(afterMove.tables.audit).toEqual(afterInsert.tables.audit);
    },
  );
  it("queues unknown title-only responses durably and preserves them without a research runner", async () => {
    await register("A", A);
    const response = await record(A, null, "2026-09-30");
    expect(response.status).toBe(201);
    const jobs = (await api("/admin/jobs", "GET", undefined, admin)).data.items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      response_id: response.data.id,
      version_id: null,
      status: "queued",
      query: {
        title: "Unconfirmed tune",
        artist_hint: null,
        reference_url: null,
      },
      candidates: [],
    });
    expect(
      (
        await api(
          `/records/${response.data.id}/candidates`,
          "GET",
          undefined,
          A,
        )
      ).data,
    ).toMatchObject({ status: "queued", candidates: [] });
    expect((await api("/records")).data.items[0].version_id).toBeNull();
  });
  it("never includes capability hashes or raw registration secrets in business exports or feeds", async () => {
    await register("A", A);
    const exported = await api("/admin/export", "GET", undefined, admin);
    const feed = await api("/sync/feed", "GET", undefined, SYNC);
    const hash = createHash("sha256").update(A).digest("hex");
    expect(JSON.stringify(exported)).not.toContain(hash);
    expect(JSON.stringify(feed)).not.toContain(hash);
    expect(JSON.stringify(exported)).not.toContain(A);
  });
  it("rejects impossible dates, future records, private reference URLs and unknown mutation fields", async () => {
    await register("A", A);
    const base = {
      operation_id: op(),
      version_id: null,
      unresolved_title: "Unknown",
      record_date: "2026-09-30",
    };
    for (const changes of [
      { record_date: "2026-02-30" },
      { record_date: "2026-13-40" },
      { record_date: "9999-01-01" },
      { reference_url: "https://[::1]/x" },
      { reference_url: "https://172.16.1.3/x" },
      { token_hash: "injected" },
    ]) {
      expect(
        (
          await api(
            "/records",
            "POST",
            { ...base, ...changes, operation_id: op() },
            A,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await api(
          "/admin/data/participants",
          "POST",
          {
            operation_id: op(),
            values: { name: "Malicious", token_hash: "injected" },
          },
          admin,
        )
      ).status,
    ).toBe(400);
  });
  it("rejects credit evidence from a different recording instead of asserting fabricated provenance", async () => {
    const first = await version("First"),
      second = await version("Second");
    const source = await row("sources", {
      version_id: first.id,
      url: "https://example.org/first",
      title: "First credits",
      excerpt: "User supplied",
      origin: "admin",
    });
    const entity = await row("entities", { name: "Vocalist", kind: "person" });
    const result = await api(
      "/admin/data/credits",
      "POST",
      {
        operation_id: op(),
        values: {
          version_id: second.id,
          entity_id: entity.id,
          role: "vocalist",
          source_id: source.id,
          confirmed: true,
        },
      },
      admin,
    );
    expect(result.status).toBe(409);
    expect(
      (await api("/admin/data/credits", "GET", undefined, admin)).data.items,
    ).toHaveLength(0);
  });
  it("resolving an unknown duplicate reports conflict without losing the record or lookup job", async () => {
    await register("A", A);
    const song = await version();
    await record(A, song.id, "2026-09-30");
    const unknown = await record(A, null, "2026-09-30");
    const before = (await api("/admin/export", "GET", undefined, admin)).data;
    const result = await api(
      `/records/${unknown.data.id}`,
      "PATCH",
      { operation_id: op(), expected_revision: 1, version_id: song.id },
      A,
    );
    expect(result.status).toBe(409);
    const after = (await api("/admin/export", "GET", undefined, admin)).data;
    expect(after.high_watermark).toBe(before.high_watermark);
    expect(after.tables.responses).toEqual(before.tables.responses);
    expect(after.tables.research_jobs).toEqual(before.tables.research_jobs);
    expect((await api("/records")).data.items).toHaveLength(2);
  });
  it("preserves one delete event when two concurrent deletes race and safely replays the winning operation", async () => {
    await register("A", A);
    const song = await version();
    const rec = await record(A, song.id, "2026-09-30");
    const operations = [op(), op()];
    const results = await Promise.all(
      operations.map((operation_id) =>
        api(
          `/records/${rec.data.id}`,
          "DELETE",
          { operation_id, expected_revision: 1 },
          A,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 200);
    const replay = await api(
      `/records/${rec.data.id}`,
      "DELETE",
      { operation_id: operations[winner], expected_revision: 1 },
      A,
    );
    expect(replay.status).toBe(200);
    expect(replay.data).toEqual(results[winner].data);
    const events = (
      await api(
        `/admin/audit?table=responses&row_id=${rec.data.id}`,
        "GET",
        undefined,
        admin,
      )
    ).data.items;
    expect(events.filter((e: any) => e.action === "delete")).toHaveLength(1);
  });
  it("adds a device through own transfer and rejects expired invitation or expired admin session", async () => {
    const person = await register("A", A);
    expect(
      (
        await api(
          "/guest/transfers",
          "POST",
          { operation_id: op(), invite_secret: INVITE },
          A,
        )
      ).status,
    ).toBe(201);
    const claim = await api("/guest/claim", "POST", {
      operation_id: op(),
      invite_secret: INVITE,
      device_secret: B,
      device_label: "Second device",
    });
    expect(claim.status).toBe(201);
    expect(claim.data.participant.id).toBe(person.id);
    const song = await version();
    expect((await record(B, song.id, "2026-09-30")).status).toBe(201);
    const expiredSecret = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    const invite = await api(
      "/admin/invites",
      "POST",
      {
        operation_id: op(),
        participant_id: person.id,
        invite_secret: expiredSecret,
      },
      admin,
    );
    await db
      .prepare(
        "UPDATE invites SET data=json_set(data,'$.expires_at','2000-01-01T00:00:00Z') WHERE id=?",
      )
      .bind(invite.data.id)
      .run();
    expect(
      (
        await api("/guest/claim", "POST", {
          operation_id: op(),
          invite_secret: expiredSecret,
          device_secret: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          device_label: "Expired",
        })
      ).status,
    ).toBe(409);
    await db
      .prepare("UPDATE admin_sessions SET expires_at=?")
      .bind("2000-01-01T00:00:00Z")
      .run();
    expect((await api("/admin/export", "GET", undefined, admin)).status).toBe(
      401,
    );
  });
  it("bounds failed admin login attempts, rejects arbitrary table operations and enforces CORS", async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (await api("/admin/login", "POST", { password: "wrong" })).status,
      ).toBe(401);
    expect(
      (await api("/admin/login", "POST", { password: "integration-password" }))
        .status,
    ).toBe(429);
    expect(
      (await api("/admin/data/admin_sessions", "GET", undefined, admin)).status,
    ).toBe(404);
    expect(
      (
        await api(
          "/admin/data/research_jobs",
          "POST",
          { operation_id: op(), values: {} },
          admin,
        )
      ).status,
    ).toBe(403);
    const blocked = await mf.dispatchFetch(
      "http://localhost/api/v1/participants",
      { headers: { Origin: "https://untrusted.example" } },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const allowed = await mf.dispatchFetch(
      "http://localhost/api/v1/participants",
      { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } },
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
  });
  it("keeps evidence and administrative locks, excludes disabled tags and reports job retry revisions", async () => {
    await register("A", A);
    const song = await version();
    const tags = (await api("/tags")).data.items;
    expect(tags).toHaveLength(50);
    expect(new Set(tags.map((t: any) => t.category)).size).toBe(7);
    const assignment = await row("tag_assignments", {
      version_id: song.id,
      tag_id: tags[0].id,
      evidence: "Administrator supplied evidence",
      confirmed: true,
      origin: "admin",
    });
    expect(assignment.manual_lock).toBe(true);
    await record(A, song.id, "2026-09-30");
    const disabled = await api(
      `/admin/data/tags/${tags[0].id}`,
      "PATCH",
      { operation_id: op(), expected_revision: 1, values: { active: false } },
      admin,
    );
    expect(disabled.status).toBe(200);
    expect((await api("/catalog/versions/" + song.id)).data.tags).toHaveLength(
      0,
    );
    const job = (await api("/admin/jobs", "GET", undefined, admin)).data
      .items[0];
    const retry = await api(
      `/admin/jobs/${job.id}/retry`,
      "POST",
      { operation_id: op(), expected_revision: 1 },
      admin,
    );
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({
      status: "queued",
      revision: 2,
      attempts: 0,
    });
    expect(
      (
        await api(
          `/admin/jobs/${job.id}/retry`,
          "POST",
          { operation_id: op(), expected_revision: 1 },
          admin,
        )
      ).status,
    ).toBe(409);
  });
  it("normalizes known recording URLs and rejects catalog duplicates without merging same-name songs", async () => {
    const work = await row("works", { title: "Same title" });
    const first = await row("versions", {
      work_id: work.id,
      title: "Known recording",
      reference_url: "https://youtu.be/c56TpxfO9q0?si=tracking",
      kind: "original",
    });
    expect(first.reference_url).toBe(
      "https://www.youtube.com/watch?v=c56TpxfO9q0",
    );
    const duplicate = await api(
      "/admin/data/versions",
      "POST",
      {
        operation_id: op(),
        values: {
          work_id: work.id,
          title: "Wrong duplicate name",
          reference_url: "https://www.youtube.com/watch?v=c56TpxfO9q0&t=30",
          kind: "cover",
        },
      },
      admin,
    );
    expect(duplicate.status).toBe(409);
    const other = await row("versions", {
      work_id: work.id,
      title: "Known recording",
      reference_url: "https://www.youtube.com/watch?v=02x6GYqPl-g",
      kind: "cover",
    });
    expect(other.id).not.toBe(first.id);
  });
  it("allows configuring the monthly research cap before any external job executes", async () => {
    const operationId = op();
    const body = { operation_id: operationId, tavily_credit_cap: 400 };
    const created = await api("/admin/usage", "POST", body, admin);
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      tavily_credit_cap: 400,
      tavily_credits: 0,
      groq_requests: 0,
    });
    expect((await api("/admin/usage", "POST", body, admin)).data.id).toBe(
      created.data.id,
    );
    expect(
      (await api("/admin/usage", "GET", undefined, admin)).data
        .tavily_credit_cap,
    ).toBe(400);
    const changed = await api(
      `/admin/usage/${created.data.id}`,
      "PATCH",
      { operation_id: op(), expected_revision: 1, tavily_credit_cap: 800 },
      admin,
    );
    expect(changed.status).toBe(200);
  });
  it("protects catalog credit references and cancels a deleted version research job atomically", async () => {
    const song = await version(),
      entity = await row("entities", { name: "Singer", kind: "person" });
    const credit = await row("credits", {
      version_id: song.id,
      entity_id: entity.id,
      role: "vocalist",
    });
    const remove = () =>
      api(
        `/admin/data/versions/${song.id}`,
        "DELETE",
        { operation_id: op(), expected_revision: 1 },
        admin,
      );
    expect((await remove()).status).toBe(409);
    expect(
      (
        await api(
          `/admin/data/credits/${credit.id}`,
          "DELETE",
          { operation_id: op(), expected_revision: 1 },
          admin,
        )
      ).status,
    ).toBe(200);
    expect((await remove()).status).toBe(200);
    expect(
      (await api("/admin/jobs", "GET", undefined, admin)).data.items,
    ).toHaveLength(0);
    const exported = (await api("/admin/export", "GET", undefined, admin)).data;
    expect(exported.tables.research_jobs[0].deleted_at).toBeTruthy();
  });
  it("rejects bad admin passwords, public-name impersonation and editing somebody else", async () => {
    expect(
      (await api("/admin/login", "POST", { password: "wrong" })).status,
    ).toBe(401);
    const a = await register("A", A),
      b = await register("B", B),
      song = await version();
    expect((await registerAttempt("A", B)).status).toBe(409);
    const rec = await record(B, song.id, "2026-09-28");
    expect(rec.status).toBe(201);
    expect((await record(A, song.id, "2026-09-29", op(), b.id)).status).toBe(
      403,
    );
    expect(
      (
        await api(
          `/records/${rec.data.id}`,
          "PATCH",
          {
            operation_id: op(),
            expected_revision: 1,
            record_date: "2026-09-29",
          },
          A,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api("/records", "POST", {
          operation_id: op(),
          participant_id: a.id,
          version_id: song.id,
          record_date: "2026-09-29",
        })
      ).status,
    ).toBe(401);
  });
  it("claims an invitation exactly once and revokes a device without granting name-selected rights", async () => {
    const person = await row("participants", { name: "Invited" });
    const invite = await api(
      "/admin/invites",
      "POST",
      { operation_id: op(), participant_id: person.id, invite_secret: INVITE },
      admin,
    );
    expect(invite.status).toBe(201);
    const claims = await Promise.all(
      [A, B].map((device_secret) =>
        api("/guest/claim", "POST", {
          operation_id: op(),
          invite_secret: INVITE,
          device_secret,
          device_label: "phone",
        }),
      ),
    );
    expect(claims.map((r) => r.status).sort()).toEqual([201, 409]);
    const granted = claims.find((r) => r.status === 201)!;
    const token = claims[0].status === 201 ? A : B;
    expect(
      (await api("/guest/me", "GET", undefined, token)).data.participant.id,
    ).toBe(person.id);
    expect(
      (
        await api(
          `/admin/devices/${granted.data.device_id}`,
          "DELETE",
          { operation_id: op(), expected_revision: 1 },
          admin,
        )
      ).status,
    ).toBe(200);
    expect((await api("/guest/me", "GET", undefined, token)).status).toBe(401);
  });
  it("counts daily records rather than supporters and rejects same-day duplicates under concurrency", async () => {
    await register("A", A);
    await register("B", B);
    const song = await version();
    const duplicate = await Promise.all([
      record(A, song.id, "2026-09-28"),
      record(A, song.id, "2026-09-28"),
    ]);
    expect(duplicate.map((r) => r.status).sort()).toEqual([201, 409]);
    for (const date of ["2026-09-29", "2026-09-30"])
      expect((await record(A, song.id, date)).status).toBe(201);
    expect((await record(B, song.id, "2026-09-28")).status).toBe(201);
    const stats = await api("/statistics?from=2026-09-28&to=2026-09-30");
    expect(stats.data.rankings[0]).toMatchObject({
      count: 4,
      supporter_count: 2,
      rank: 1,
    });
    expect(
      stats.data.rankings[0].supporters.map((p: any) => p.name).sort(),
    ).toEqual(["A", "B"]);
  });
  it("replays an operation once and rejects a changed payload and concurrent revision overwrite", async () => {
    await register("A", A);
    const song = await version(),
      operationId = op();
    const responses = await Promise.all([
      record(A, song.id, "2026-09-28", operationId),
      record(A, song.id, "2026-09-28", operationId),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses[0].data.id).toBe(responses[1].data.id);
    expect(
      (await record(A, song.id, "2026-09-29", operationId)).error.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    const id = responses[0].data.id;
    const updates = await Promise.all(
      ["2026-09-29", "2026-09-30"].map((record_date) =>
        api(
          `/records/${id}`,
          "PATCH",
          { operation_id: op(), expected_revision: 1, record_date },
          A,
        ),
      ),
    );
    expect(updates.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await api("/records")).data.items).toHaveLength(1);
    const audits = await api(
      `/admin/audit?table=responses&row_id=${id}`,
      "GET",
      undefined,
      admin,
    );
    expect(audits.data.items).toHaveLength(2);
  });
  it("soft deletion disappears publicly while original and corrected audit history remain exported", async () => {
    await register("A", A);
    const song = await version();
    const rec = await record(A, song.id, "2026-09-28");
    expect(
      (
        await api(
          `/records/${rec.data.id}`,
          "DELETE",
          { operation_id: op(), expected_revision: 1 },
          A,
        )
      ).status,
    ).toBe(200);
    expect((await api("/records")).data.items).toHaveLength(0);
    expect((await api("/statistics")).data.total_records).toBe(0);
    const audit = await api(
      `/admin/audit?table=responses&row_id=${rec.data.id}`,
      "GET",
      undefined,
      admin,
    );
    const original = audit.data.items[0];
    const correction = await api(
      `/admin/audit/${original.id}/corrections`,
      "POST",
      {
        operation_id: op(),
        reason: "Display correction",
        corrected: { note: "corrected historical description" },
      },
      admin,
    );
    expect(correction.status).toBe(201);
    const corrected = (
      await api(
        `/admin/audit?table=responses&row_id=${rec.data.id}`,
        "GET",
        undefined,
        admin,
      )
    ).data.items.find((a: any) => a.id === original.id);
    expect(corrected.after).toEqual(original.after);
    expect(corrected.effective).toEqual({
      note: "corrected historical description",
    });
    const exported = await api("/admin/export", "GET", undefined, admin);
    expect(exported.data.tables.responses[0].deleted_at).toBeTruthy();
    expect(exported.data.tables.audit_corrections).toHaveLength(1);
    const text = JSON.stringify(exported);
    for (const secret of [
      A,
      "token_hash",
      "ADMIN_PASSWORD_HASH",
      "session_token",
      INVITE,
    ])
      expect(text).not.toContain(secret);
    expect((await api("/admin/export")).status).toBe(401);
  });
  it("admin answer search joins participant, work and version names before opaque cursor pagination", async () => {
    const person = await register("葵", A);
    const work = await row("works", { title: "星の歌" });
    const song = await version("弾き語り版", "cover", work.id);
    const first = (await record(A, song.id, "2026-09-28")).data;
    const second = (await record(A, song.id, "2026-09-29")).data;
    expect(first.unresolved_title).toBeNull();
    for (const q of ["葵", "星の歌", "弾き語り版"]) {
      const one = await api(`/admin/records?q=${encodeURIComponent(q)}&limit=1`, "GET", undefined, admin);
      expect(one.status).toBe(200);
      expect(one.data.items).toHaveLength(1);
      expect(one.data.next_cursor).toBeTruthy();
      const two = await api(`/admin/records?q=${encodeURIComponent(q)}&limit=1&cursor=${one.data.next_cursor}`, "GET", undefined, admin);
      expect(two.data.items).toHaveLength(1);
      expect(new Set([one.data.items[0].id, two.data.items[0].id])).toEqual(new Set([first.id, second.id]));
    }
    const unresolved = (await record(A, null, "2026-09-30")).data;
    expect((await api("/admin/records?q=Unconfirmed", "GET", undefined, admin)).data.items.map((r: any) => r.id)).toEqual([unresolved.id]);
    expect((await api(`/admin/records?q=${first.id}`, "GET", undefined, admin)).data.items.map((r: any) => r.id)).toEqual([first.id]);
    await api(`/records/${first.id}`, "DELETE", { operation_id: op(), expected_revision: 1 }, A);
    expect((await api("/admin/records?q=" + encodeURIComponent(person.name), "GET", undefined, admin)).data.items).toHaveLength(2);
    expect((await api("/admin/records?include_deleted=true&q=" + encodeURIComponent(person.name), "GET", undefined, admin)).data.items).toHaveLength(3);
    expect((await api("/admin/records?q=" + encodeURIComponent(person.name))).status).toBe(401);
  });
  it("preserves work/version distinction, entity aliases and distinct credit roles in statistics", async () => {
    const person = await register("A", A);
    const original = await version("Same title");
    const cover = await version("Same title", "cover", original.work_id);
    const another = await version("Same title");
    const singer = await row("entities", {
      name: "倚水",
      kind: "person",
      manual_lock: true,
    });
    await row("aliases", { entity_id: singer.id, name: "isui" });
    const composer = await row("entities", {
      name: "Composer",
      kind: "person",
      manual_lock: true,
    });
    await row("credits", {
      version_id: cover.id,
      entity_id: singer.id,
      role: "vocalist",
      source_id: null,
      confirmed: false,
      manual_lock: true,
    });
    await row("credits", {
      version_id: cover.id,
      entity_id: composer.id,
      role: "composer",
      source_id: null,
      confirmed: false,
      manual_lock: true,
    });
    await record(A, original.id, "2026-09-28");
    await record(A, cover.id, "2026-09-29");
    await record(A, another.id, "2026-09-30");
    expect(
      (
        await api("/statistics?from=2026-09-28&to=2026-09-30")
      ).data.rankings.map((r: any) => r.count),
    ).toEqual([2, 1]);
    expect(
      (await api("/statistics?group_by=version&from=2026-09-28&to=2026-09-30"))
        .data.rankings,
    ).toHaveLength(3);
    const stats = (
      await api(
        `/statistics?participant_id=${person.id}&from=2026-09-28&to=2026-09-30`,
      )
    ).data;
    expect(stats.roles.vocalist).toEqual([]);
    expect(stats.roles.composer).toEqual([]);
    const provisional = (await api("/admin/data/credits", "GET", undefined, admin)).data.items;
    expect(provisional).toHaveLength(2);
    expect(provisional.every((credit: any) => credit.confirmed === false)).toBe(true);
    await row("credits", { version_id: cover.id, entity_id: singer.id, role: "release_name", source_id: null, confirmed: true, manual_lock: true });
    const confirmedStats = (await api("/statistics?from=2026-09-28&to=2026-09-30")).data;
    expect(confirmedStats.roles.release_name).toEqual([{ entity_id: singer.id, name: "倚水", count: 1 }]);
    expect(confirmedStats.total_records).toBe(3);
    const candidates = await api("/catalog/search?q=isui");
    expect(candidates.data.items.some((v: any) => v.id === cover.id)).toBe(
      true,
    );
  });
  it("uses all active responses as denominator and JST Monday weeks including unparsed records", async () => {
    const person = await register("A", A),
      song = await version();
    const tag = (await api("/tags")).data.items[0];
    await row("tag_assignments", {
      version_id: song.id,
      tag_id: tag.id,
      evidence: "User supplied description",
      source_id: null,
      origin: "admin",
      confirmed: true,
      manual_lock: true,
    });
    await record(A, song.id, "2026-09-28");
    await record(A, null, "2026-09-29");
    const stats = (
      await api(
        `/statistics?participant_id=${person.id}&from=2026-09-28&to=2026-09-30&anchor=2026-09-30`,
      )
    ).data;
    expect(stats.total_records).toBe(2);
    expect(stats.unparsed_records).toBe(1);
    expect(stats.weekly_tags).toHaveLength(12);
    const week = stats.weekly_tags[11];
    expect(week).toMatchObject({
      week_start: "2026-09-28",
      total_records: 2,
      unparsed_records: 1,
    });
    expect(week.tags[0]).toMatchObject({ count: 1, percentage: 50 });
  });
  it("delivers a schema-versioned stable high-watermark feed and rejects unsafe cursor acknowledgement", async () => {
    await register("A", A);
    const song = await version();
    await record(A, song.id, "2026-09-28");
    let cursor = 0;
    const first = await api(
      "/sync/feed?cursor=0&limit=2&schema_version=1",
      "GET",
      undefined,
      SYNC,
    );
    expect(first.status).toBe(200);
    expect(first.data.schema_version).toBe(1);
    const watermark = first.data.high_watermark;
    let events = first.data.events;
    cursor = first.data.next_cursor;
    await record(A, song.id, "2026-09-29");
    while (cursor < watermark) {
      const page = await api(
        `/sync/feed?cursor=${cursor}&high_watermark=${watermark}&limit=2&schema_version=1`,
        "GET",
        undefined,
        SYNC,
      );
      expect(page.status).toBe(200);
      events.push(...page.data.events);
      cursor = page.data.next_cursor;
    }
    expect(new Set(events.map((e: any) => e.sequence)).size).toBe(
      events.length,
    );
    expect(events.at(-1).sequence).toBe(watermark);
    expect(JSON.stringify(events)).not.toContain("token_hash");
    expect(events.filter((e: any) => e.table === "responses")).toHaveLength(1);
    expect(
      (
        await api(
          "/sync/feed?cursor=0&schema_version=99",
          "GET",
          undefined,
          SYNC,
        )
      ).status,
    ).toBe(409);
    expect(
      (await api("/sync/feed?cursor=999999", "GET", undefined, SYNC)).status,
    ).toBe(409);
    expect(
      (
        await api(
          "/sync/ack",
          "POST",
          { schema_version: 1, cursor: 999999, collector_id: "pc" },
          SYNC,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api(
          "/sync/ack",
          "POST",
          { schema_version: 1, cursor: watermark, collector_id: "pc" },
          SYNC,
        )
      ).status,
    ).toBe(200);
  });
});
async function registerAttempt(name: string, secret: string) {
  return api("/guest/create", "POST", {
    name,
    device_label: "another",
    device_secret: secret,
    operation_id: op(),
  });
}
// Task 3 lifecycle regressions use the existing real-D1 HTTP harness.
it('cancels unresolved lookup when owner resolves or deletes and refreshes evidence on query change',async()=>{
 await register('Lifecycle',A); const s=await version(); const r=await record(A,null,'2026-09-29');
 const jobs=()=>api('/admin/jobs','GET',undefined,admin); const initial=(await jobs()).data.items.find((j:any)=>j.response_id===r.data.id);
 await db.prepare("UPDATE research_jobs SET data=json_set(data,'$.stage','infer','$.evidence',json('[{\"id\":\"old\"}]'),'$.candidates',json('[{\"id\":\"stale\"}]')) WHERE id=?").bind(initial.id).run();
 const changed=await api(`/records/${r.data.id}`,'PATCH',{operation_id:op(),expected_revision:1,unresolved_title:'Another tune'},A);expect(changed.status).toBe(200);
 const refreshed=(await jobs()).data.items.find((j:any)=>j.response_id===r.data.id);expect(refreshed.stage).toBe('search');expect(refreshed.evidence).toEqual([]);expect(refreshed.candidates).toEqual([]);
 const resolved=await api(`/records/${r.data.id}`,'PATCH',{operation_id:op(),expected_revision:2,version_id:s.id},A);expect(resolved.status).toBe(200);
 expect((await jobs()).data.items.some((j:any)=>j.response_id===r.data.id)).toBe(false);
 const choices=await api(`/records/${r.data.id}/candidates`,'GET',undefined,A);expect(choices.data.candidates).toEqual([]);
 const second=await record(A,null,'2026-09-30');expect((await api(`/records/${second.data.id}`,'DELETE',{operation_id:op(),expected_revision:1},A)).status).toBe(200);
 expect((await jobs()).data.items.some((j:any)=>j.response_id===second.data.id)).toBe(false);
 const exp=(await api('/admin/export','GET',undefined,admin)).data;expect(exp.tables.research_jobs.filter((j:any)=>j.response_id&&j.deleted_at)).toHaveLength(2);
});
it('cancels invitations and permits participant tombstone after revocation while preserving grant history',async()=>{
 const p=await register('Remove grants',A);const invite=await api('/admin/invites','POST',{operation_id:op(),participant_id:p.id,invite_secret:INVITE},admin);
 const device=(await api(`/admin/devices?participant_id=${p.id}`,'GET',undefined,admin)).data.items[0];
 expect((await api(`/admin/participants/${p.id}`,'DELETE',{operation_id:op(),expected_revision:1},admin)).status).toBe(409);
 const cancelled=await api(`/admin/invites/${invite.data.id}`,'DELETE',{operation_id:op(),expected_revision:1},admin);expect(cancelled.status).toBe(200);
 expect((await api('/guest/claim','POST',{operation_id:op(),invite_secret:INVITE,device_label:'new',device_secret:B})).status).not.toBe(201);
 expect((await api(`/admin/devices/${device.id}`,'DELETE',{operation_id:op(),expected_revision:1},admin)).status).toBe(200);
 expect((await api(`/admin/participants/${p.id}`,'DELETE',{operation_id:op(),expected_revision:1},admin)).status).toBe(200);
 const exp=(await api('/admin/export','GET',undefined,admin)).data;expect(exp.tables.devices[0].revoked_at).toBeTruthy();expect(exp.tables.invites[0].deleted_at).toBeTruthy();expect(exp.tables.participants[0].deleted_at).toBeTruthy();expect(exp.tables.audit.filter((a:any)=>a.action==='delete')).toHaveLength(3);
});
