import type { WorkerEnv, BusinessTable, Health } from "../../shared/contracts";
import { SCHEMA_VERSION } from "../../shared/contracts";
import {
  ApiError,
  bodyOf,
  ok,
  notFound,
  replyMutation,
  filterRows,
  invalid,
  conflict,
  newRow,
  updated,
  stmt,
  check,
  getRow,
  allRows,
  expectRevision,
  businessTables,
  page,
  limitOf,
  requireKeys,
  now,
} from "./store";
import {
  authenticate,
  createGuest,
  claimGuest,
  inviteCreate,
  ownerOrAdmin,
  identity,
  login,
} from "./auth";
import {
  recordsFilter,
  ownRecord,
  recordMutation,
  dataRoute,
  text,
  candidates,
  songDetail,
} from "./catalog";
import { runResearchQueue } from "./research/runner";
import { activeTags } from "./tags";
import { statistics, jstToday } from "./statistics";

async function auditList(env: WorkerEnv, url: URL) {
  const table = url.searchParams.get("table"),
    rowId = url.searchParams.get("row_id");
  const rows = (await allRows(env.DB, "audit")).filter(
    (r) => (!table || r.table === table) && (!rowId || r.row_id === rowId),
  );
  const result = page(rows, url);
  const items = await Promise.all(
    result.items.map(async (audit) => {
      const correction = await stmt(
        env.DB,
        "SELECT data FROM audit_corrections WHERE json_extract(data,'$.audit_id')=? ORDER BY rowid DESC LIMIT 1",
        audit.id,
      ).first<{ data: string }>();
      return {
        ...audit,
        effective: correction
          ? JSON.parse(correction.data).corrected
          : audit.after,
      };
    }),
  );
  return ok({ ...result, items });
}
async function correctionCreate(request: Request, env: WorkerEnv, id: string) {
  const actor = await authenticate(request, env, "admin"),
    body = await bodyOf(request);
  requireKeys(body, ["operation_id", "reason", "corrected"]);
  return replyMutation(
    env,
    actor,
    `POST:/admin/audit/${id}/corrections`,
    body,
    async () => {
      await getRow(env.DB, "audit", id);
      if (
        !body.corrected ||
        typeof body.corrected !== "object" ||
        Array.isArray(body.corrected)
      )
        invalid();
      const row = newRow({
        audit_id: id,
        reason: text(body.reason, 2000),
        corrected: body.corrected,
        actor_id: actor.id,
      });
      return {
        status: 201,
        data: row,
        changes: [{ table: "audit_corrections", before: null, after: row }],
      };
    },
  );
}
async function exportBusiness(env: WorkerEnv) {
  const results = await env.DB.batch([
    env.DB.prepare(
      "SELECT coalesce(max(sequence),0) AS high_watermark FROM changes",
    ),
    ...businessTables.map((table) =>
      env.DB.prepare(`SELECT data FROM ${table} ORDER BY id`),
    ),
  ]);
  const tables = Object.fromEntries(
    businessTables.map((table, i) => [
      table,
      results[i + 1].results.map((r: any) => JSON.parse(r.data)),
    ]),
  );
  return ok({
    schema_version: SCHEMA_VERSION,
    high_watermark: (results[0].results[0] as any).high_watermark,
    exported_at: now(),
    tables,
  });
}
function integerParam(url: URL, key: string, defaultValue: number) {
  const raw = url.searchParams.get(key);
  const n = raw === null ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ApiError(409, "CURSOR_INVALID", "収集位置を確認してください");
  return n;
}
async function syncFeed(request: Request, env: WorkerEnv, url: URL) {
  await authenticate(request, env, "sync");
  const schema = integerParam(url, "schema_version", SCHEMA_VERSION);
  if (schema !== SCHEMA_VERSION)
    throw new ApiError(409, "SCHEMA_MISMATCH", "収集用スキーマが一致しません");
  const cursor = integerParam(url, "cursor", 0),
    requested = url.searchParams.has("high_watermark")
      ? integerParam(url, "high_watermark", 0)
      : null,
    limit = limitOf(url);
  const result = await env.DB.batch([
    env.DB.prepare("SELECT coalesce(max(sequence),0) AS maximum FROM changes"),
    stmt(
      env.DB,
      "SELECT sequence,table_name,row_id,data,occurred_at FROM changes WHERE sequence>? AND sequence<=coalesce(?,(SELECT coalesce(max(sequence),0) FROM changes)) ORDER BY sequence LIMIT ?",
      cursor,
      requested,
      limit + 1,
    ),
  ]);
  const maximum = (result[0].results[0] as any).maximum,
    watermark = requested ?? maximum;
  if (watermark > maximum || cursor > watermark)
    throw new ApiError(409, "CURSOR_INVALID", "収集位置がサーバーの範囲外です");
  const rows = result[1].results as any[],
    hasMore = rows.length > limit,
    events = rows.slice(0, limit).map((e) => ({
      sequence: e.sequence,
      table: e.table_name,
      row_id: e.row_id,
      action: "upsert",
      row: JSON.parse(e.data),
      occurred_at: e.occurred_at,
    }));
  return ok({
    schema_version: SCHEMA_VERSION,
    high_watermark: watermark,
    next_cursor: hasMore ? events.at(-1)!.sequence : watermark,
    has_more: hasMore,
    events,
  });
}
async function syncAck(request: Request, env: WorkerEnv) {
  const actor = await authenticate(request, env, "sync"),
    body = await bodyOf(request);
  requireKeys(body, ["collector_id", "cursor", "schema_version"]);
  if (body.schema_version !== SCHEMA_VERSION)
    throw new ApiError(409, "SCHEMA_MISMATCH", "収集用スキーマが一致しません");
  if (!Number.isSafeInteger(body.cursor) || body.cursor < 0) invalid();
  const collectorId = text(body.collector_id, 80);
  const maximum = await env.DB.prepare(
    "SELECT coalesce(max(sequence),0) AS maximum FROM changes",
  ).first<{ maximum: number }>();
  if (body.cursor > maximum!.maximum)
    throw new ApiError(409, "CURSOR_INVALID", "未配信の収集位置です");
  const existing = (await allRows(env.DB, "sync_status")).find(
    (s) => s.collector_id === collectorId,
  );
  if (existing && existing.cursor > body.cursor)
    throw new ApiError(409, "CURSOR_INVALID", "収集位置を戻すことはできません");
  if (existing?.cursor === body.cursor) return ok(existing);
  return replyMutation(
    env,
    actor,
    `POST:/sync/ack:${collectorId}`,
    {
      ...body,
      operation_id: `ack-${collectorId.replace(/[^A-Za-z0-9_-]/g, "_")}-${body.cursor}`,
    },
    async () => {
      const before = (await allRows(env.DB, "sync_status")).find(
          (s) => s.collector_id === collectorId,
        ),
        row = before
          ? updated(before, { cursor: body.cursor })
          : newRow({
              collector_id: collectorId,
              cursor: body.cursor,
              schema_version: SCHEMA_VERSION,
            });
      if (before && before.cursor > body.cursor)
        throw new ApiError(
          409,
          "CURSOR_INVALID",
          "収集位置を戻すことはできません",
        );
      return {
        data: row,
        changes: [{ table: "sync_status", before: before ?? null, after: row }],
        guards: [
          check(
            env.DB,
            "? <= (SELECT coalesce(max(sequence),0) FROM changes)",
            body.cursor,
          ),
        ],
      };
    },
  );
}
async function retryJob(request: Request, env: WorkerEnv, id: string) {
  const actor = await authenticate(request, env, "admin"),
    body = await bodyOf(request);
  requireKeys(body, ["operation_id", "expected_revision"]);
  return replyMutation(
    env,
    actor,
    `POST:/admin/jobs/${id}/retry`,
    body,
    async () => {
      const before = await getRow(env.DB, "research_jobs", id);
      expectRevision(before, body);
      if (
        before.status === "running" &&
        before.lease_until &&
        before.lease_until > now()
      )
        conflict("処理中です");
      const row = updated(before, {
        ...(before.stage === "done" ? {stage:"search" as const,evidence:[],analysis:undefined,candidates:[],metadata_cursor:0,catalog_cursor:0}:{}),
        status: "queued",
        attempts: 0,
        last_error: null,
        lease_until: null,
        next_attempt_at: now(),
      });
      return {
        data: row,
        changes: [{ table: "research_jobs", before, after: row }],
      };
    },
  );
}
export function configuration(env: WorkerEnv): Health["configured"] {
  return {
    admin: !!env.ADMIN_PASSWORD_HASH,
    sync: !!env.SYNC_TOKEN_HASH,
    groq: !!env.GROQ_API_KEY,
    tavily: !!env.TAVILY_API_KEY,
    research_runner: !!researchRunner,
  };
}
/** Task 3 installs a real runner by importing this registration API. No placeholder research is executed. */
let researchRunner:
  | ((env: WorkerEnv, ctx: ExecutionContext) => Promise<void>)
  | undefined;
export function registerResearchRunner(
  runner: (env: WorkerEnv, ctx: ExecutionContext) => Promise<void>,
) {
  researchRunner = runner;
}

registerResearchRunner(runResearchQueue);

async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url),
    prefix = "/api/v1";
  if (!url.pathname.startsWith(prefix + "/")) notFound();
  const path = url.pathname.slice(prefix.length),
    method = request.method;
  if (path === "/health" && method === "GET")
    return ok({
      schema_version: SCHEMA_VERSION,
      configured: configuration(env),
    });
  if (path === "/admin/login" && method === "POST") {
    const body = await bodyOf(request);
    requireKeys(body, ["password"]);
    return ok(await login(request, env, body));
  }
  if (path === "/admin/logout" && method === "POST") {
    const actor = await authenticate(request, env, "admin");
    await stmt(env.DB, "DELETE FROM admin_sessions WHERE id=?", actor.id).run();
    return ok({ logged_out: true });
  }
  if (path === "/guest/create" && method === "POST")
    return createGuest(request, env);
  if (path === "/guest/claim" && method === "POST")
    return claimGuest(request, env);
  if (path === "/guest/me" && method === "GET")
    return ok(await identity(env, await authenticate(request, env, "guest")));
  if (path === "/guest/transfers" && method === "POST")
    return inviteCreate(request, env, true);
  if (path === "/participants" && method === "GET")
    return ok(
      page(filterRows(await allRows(env.DB, "participants"), url), url),
    );
  if (path === "/tags" && method === "GET")
    return ok(page(await activeTags(env.DB), url));
  if (path === "/catalog/search" && method === "GET")
    return ok(
      page(await candidates(env.DB, url.searchParams.get("q") ?? ""), url),
    );
  const detail = path.match(/^\/catalog\/versions\/([^/]+)$/);
  if (detail && method === "GET")
    return ok(await songDetail(env.DB, detail[1]));
  if (path === "/statistics" && method === "GET")
    return ok(await statistics(env.DB, url));
  if (path === "/records" && method === "GET")
    return ok(
      page(recordsFilter(await allRows(env.DB, "responses"), url), url),
    );
  const choices = path.match(/^\/records\/([^/]+)\/candidates$/);
  if (choices && method === "GET") {
    const actor = await ownerOrAdmin(request, env),
      row = await getRow(env.DB, "responses", choices[1]);
    ownRecord(actor, row);
    const job =
      (await allRows(env.DB, "research_jobs")).find(
        (j) => j.response_id === row.id,
      ) ||
      (await allRows(env.DB, "research_jobs")).find(
        (j) => j.version_id === row.version_id && row.version_id !== null,
      );
    return ok({
      response_id: row.id,
      status: job?.status ?? "unconfirmed",
      candidates: job?.candidates ?? [],
      last_error: job?.last_error ?? null,
    });
  }
  const record = path.match(/^\/records(?:\/([^/]+))?$/);
  if (record && ["POST", "PATCH", "DELETE"].includes(method))
    return recordMutation(request, env, path, false, record[1]);
  if (path === "/sync/feed" && method === "GET")
    return syncFeed(request, env, url);
  if (path === "/sync/ack" && method === "POST") return syncAck(request, env);
  if (!path.startsWith("/admin/")) notFound();
  await authenticate(request, env, "admin");
  const data = path.match(/^\/admin\/data\/([^/]+)(?:\/([^/]+))?$/);
  if (data)
    return dataRoute(request, env, url, data[1] as BusinessTable, data[2]);
  const people = path.match(/^\/admin\/participants(?:\/([^/]+))?$/);
  if (people) return dataRoute(request, env, url, "participants", people[1]);
  if (path === "/admin/invites" && method === "POST")
    return inviteCreate(request, env, false);
  if (path === "/admin/invites" && method === "GET")
    return ok(page(await allRows(env.DB, "invites"), url));
  if (path === "/admin/devices" && method === "GET") {
    const p = url.searchParams.get("participant_id");
    return ok(
      page(
        (await allRows(env.DB, "devices")).filter(
          (d) => !p || d.participant_id === p,
        ),
        url,
      ),
    );
  }
  const invite = path.match(/^\/admin\/invites\/([^/]+)$/);
  if (invite && method === "DELETE") {
    const actor = await authenticate(request, env, "admin"), body = await bodyOf(request);
    requireKeys(body,["operation_id","expected_revision"]);
    return replyMutation(env, actor, `DELETE:${path}`,body,async()=>{
      const before=await getRow(env.DB,"invites",invite[1]); expectRevision(before,body);
      const row=updated(before,{deleted_at:now()});
      return {data:row,changes:[{table:"invites",before,after:row,action:"delete"}]};
    });
  }
  const device = path.match(/^\/admin\/devices\/([^/]+)$/);
  if (device && method === "DELETE") {
    const actor = await authenticate(request, env, "admin"),
      body = await bodyOf(request);
    requireKeys(body, ["operation_id", "expected_revision"]);
    return replyMutation(env, actor, `DELETE:${path}`, body, async () => {
      const before = await getRow(env.DB, "devices", device[1]);
      expectRevision(before, body);
      const row = updated(before, { revoked_at: now() });
      return {
        data: row,
        changes: [{ table: "devices", before, after: row, action: "delete" }],
      };
    });
  }
  if (path === "/admin/records" && method === "GET") {
    const rows = await allRows(env.DB, "responses", url.searchParams.get("include_deleted") !== "true");
    const q = url.searchParams.get("q")?.toLocaleLowerCase("ja");
    let matching = rows;
    if (q) {
      // Read-only display joins, before filtering/pagination. Include retained
      // labels for tombstones; authentication above still protects this route.
      const [participants, versions, works] = await Promise.all([
        allRows(env.DB, "participants", false), allRows(env.DB, "versions", false), allRows(env.DB, "works", false),
      ]);
      const people = new Map(participants.map((p) => [p.id, p.name]));
      const songs = new Map(versions.map((v) => [v.id, v]));
      const titles = new Map(works.map((w) => [w.id, w.title]));
      matching = rows.filter((record) => {
        const song = record.version_id ? songs.get(record.version_id) : undefined;
        return [JSON.stringify(record), people.get(record.participant_id), song?.title, song ? titles.get(song.work_id) : undefined]
          .some((value) => value?.toLocaleLowerCase("ja").includes(q));
      });
    }
    const filters = new URL(url);
    filters.searchParams.delete("q");
    return ok(
      page(
        recordsFilter(matching, filters),
        url,
      ),
    );
  }
  const adminRecord = path.match(
    /^\/admin\/records(?:\/([^/]+))?(?:\/(resolve))?$/,
  );
  if (adminRecord && ["POST", "PATCH", "DELETE"].includes(method))
    return recordMutation(
      request,
      env,
      path,
      true,
      adminRecord[1],
      !!adminRecord[2],
    );
  if (path === "/admin/audit" && method === "GET") return auditList(env, url);
  const correction = path.match(/^\/admin\/audit\/([^/]+)\/corrections$/);
  if (correction && method === "POST")
    return correctionCreate(request, env, correction[1]);
  if (path === "/admin/export" && method === "GET") return exportBusiness(env);
  if (path === "/admin/jobs" && method === "GET") {
    const status = url.searchParams.get("status");
    return ok(
      page(
        (await allRows(env.DB, "research_jobs")).filter(
          (j) => !status || j.status === status,
        ),
        url,
      ),
    );
  }
  const retry = path.match(/^\/admin\/jobs\/([^/]+)\/retry$/);
  if (retry && method === "POST") return retryJob(request, env, retry[1]);
  if (path === "/admin/usage" && method === "GET") {
    const month = jstToday().slice(0, 7),
      row = (await allRows(env.DB, "usage")).find((u) => u.month === month);
    return ok({
      ...row,
      month,
      tavily_credits: row?.tavily_credits ?? 0,
      tavily_credit_cap: row?.tavily_credit_cap ?? 800,
      groq_requests: row?.groq_requests ?? 0,
      last_error: row?.last_error ?? null,
      configured: {
        groq: !!env.GROQ_API_KEY,
        tavily: !!env.TAVILY_API_KEY,
        research_runner: !!researchRunner,
      },
    });
  }
  if (path === "/admin/usage" && method === "POST") {
    const actor = await authenticate(request, env, "admin"),
      body = await bodyOf(request);
    requireKeys(body, ["operation_id", "tavily_credit_cap"]);
    if (
      !Number.isInteger(body.tavily_credit_cap) ||
      body.tavily_credit_cap < 0 ||
      body.tavily_credit_cap > 1000
    )
      invalid();
    return replyMutation(env, actor, `POST:${path}`, body, async () => {
      const row = newRow({
        month: jstToday().slice(0, 7),
        tavily_credits: 0,
        tavily_credit_cap: body.tavily_credit_cap,
        groq_requests: 0,
        last_error: null,
      });
      return {
        status: 201,
        data: row,
        changes: [{ table: "usage", before: null, after: row }],
      };
    });
  }
  const usage = path.match(/^\/admin\/usage\/([^/]+)$/);
  if (usage && method === "PATCH") {
    const actor = await authenticate(request, env, "admin"),
      body = await bodyOf(request);
    requireKeys(body, [
      "operation_id",
      "expected_revision",
      "tavily_credit_cap",
    ]);
    if (
      !Number.isInteger(body.tavily_credit_cap) ||
      body.tavily_credit_cap < 0 ||
      body.tavily_credit_cap > 1000
    )
      invalid();
    return replyMutation(env, actor, `PATCH:${path}`, body, async () => {
      const before = await getRow(env.DB, "usage", usage[1]);
      expectRevision(before, body);
      const row = updated(before, {
        tavily_credit_cap: body.tavily_credit_cap,
      });
      return { data: row, changes: [{ table: "usage", before, after: row }] };
    });
  }
  if (path === "/admin/sync-status" && method === "GET") {
    const maximum = await env.DB.prepare(
      "SELECT coalesce(max(sequence),0) AS high_watermark FROM changes",
    ).first();
    return ok({ items: await allRows(env.DB, "sync_status"), ...maximum });
  }
  return notFound();
}
export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const origin = request.headers.get("Origin"),
      allowed = (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    let response: Response;
    if (origin && !allowed.includes(origin))
      response = Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "このサイトからの接続は許可されていません",
          },
        },
        { status: 403 },
      );
    else if (request.method === "OPTIONS")
      response = new Response(null, { status: 204 });
    else
      try {
        response = await route(request, env);
      } catch (error) {
        if (error instanceof ApiError)
          response = Response.json(
            { error: { code: error.code, message: error.message } },
            { status: error.status },
          );
        else
          response = Response.json(
            {
              error: {
                code: "DATABASE_UNAVAILABLE",
                message: "処理できませんでした。再試行してください",
              },
            },
            { status: 503 },
          );
      }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Vary", "Origin");
    if (origin && allowed.includes(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      headers.set(
        "Access-Control-Allow-Methods",
        "GET,POST,PATCH,DELETE,OPTIONS",
      );
    }
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ) {
    if (researchRunner && env.GROQ_API_KEY && env.TAVILY_API_KEY)
      ctx.waitUntil(researchRunner(env, ctx));
  },
};
