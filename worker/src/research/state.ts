import type {
  WorkerEnv,
  ResearchJob,
  Usage,
  Version,
  BusinessTable,
} from "../../../shared/contracts";
import {
  newRow,
  updated,
  mutate,
  getRow,
  stmt,
  check,
  ApiError,
  now,
  activeReference,
  type Change,
} from "../store";
import { catalogUrl } from "../catalog";
import { jstToday } from "../statistics";
import { providerJson, ResearchError, norm } from "./providers";
export const actor = { id: "research", type: "system" as const };
export const operation = () => ({ operation_id: crypto.randomUUID() });
export async function rows<T>(
  db: D1Database,
  table: string,
  where = "1",
  ...values: unknown[]
): Promise<T[]> {
  const r = await stmt(
    db,
    `SELECT data FROM ${table} WHERE json_extract(data,'$.deleted_at') IS NULL AND (${where}) LIMIT 60`,
    ...values,
  ).all<{ data: string }>();
  return r.results.map((x) => JSON.parse(x.data));
}
export async function reserveCredits(env: WorkerEnv, n: number, quota: number) {
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(quota) || quota < n)
    throw new ResearchError("TAVILY_FREE_QUOTA_EXHAUSTED");
  await mutate(env, actor, "research:budget", operation(), async () => {
    const before = (
      await rows<Usage>(
        env.DB,
        "usage",
        "json_extract(data,'$.month')=?",
        jstToday().slice(0, 7),
      )
    )[0];
    const base =
      before ??
      newRow({
        month: jstToday().slice(0, 7),
        tavily_credits: 0,
        tavily_credit_cap: 800,
        groq_requests: 0,
        last_error: null,
      });
    if (base.tavily_credits + n > Math.min(1000, base.tavily_credit_cap))
      throw new ResearchError("MONTHLY_BUDGET_EXHAUSTED");
    const row = before
      ? updated(before, { tavily_credits: before.tavily_credits + n })
      : { ...base, tavily_credits: n };
    return {
      data: row,
      changes: [{ table: "usage", before: before ?? null, after: row }],
    };
  });
}
export async function quota(env: WorkerEnv, f: typeof fetch, n: number) {
  const p = await providerJson(
    f,
    "https://api.tavily.com/usage",
    env.TAVILY_API_KEY!,
  );
  const a = p.account,
    k = p.key;
  const keyLimit = k?.limit === null ? a?.plan_limit : k?.limit;
  if (
    !a ||
    !k ||
    a.current_plan !== "Researcher" ||
    a.plan_limit > 1000 ||
    a.paygo_usage !== 0 ||
    ![a.plan_usage, a.plan_limit, k.usage, keyLimit].every(Number.isFinite)
  )
    throw new ResearchError("TAVILY_FREE_PLAN_REQUIRED");
  await reserveCredits(
    env,
    n,
    Math.min(a.plan_limit - a.plan_usage, keyLimit - k.usage),
  );
}
export async function save(
  env: WorkerEnv,
  job: ResearchJob,
  patch: Partial<ResearchJob>,
  changes: Change[] = [],
) {
  if (
    job.version_id &&
    (patch.status === "needs_review" || patch.status === "failed") &&
    !changes.some(
      (c) => c.table === "versions" && c.after.id === job.version_id,
    )
  ) {
    const version = await getRow(env.DB, "versions", job.version_id);
    if (!version.manual_lock)
      changes.push({
        table: "versions",
        before: version,
        after: updated(version, { research_status: patch.status }),
      });
  }
  if (patch.last_error) {
    const usage = (
      await rows<Usage>(
        env.DB,
        "usage",
        "json_extract(data,'$.month')=?",
        jstToday().slice(0, 7),
      )
    )[0];
    if (usage)
      changes.push({
        table: "usage",
        before: usage,
        after: updated(usage, { last_error: patch.last_error }),
      });
  }
  const result = await mutate(
    env,
    actor,
    "research:stage",
    operation(),
    async () => ({
      data: null,
      changes: [
        ...changes,
        {
          table: "research_jobs",
          before: job,
          after: updated(job, {
            next_attempt_at: now(),
            ...patch,
            lease_until: null,
          }),
        },
      ],
      guards: changes.flatMap((c) => {
        const targets: Record<string, [string, string][]> = {
          versions: [["work_id", "works"]],
          responses: [
            ["participant_id", "participants"],
            ["version_id", "versions"],
          ],
          sources: [["version_id", "versions"]],
          credits: [
            ["version_id", "versions"],
            ["entity_id", "entities"],
            ["source_id", "sources"],
          ],
          aliases: [["entity_id", "entities"]],
          tag_assignments: [
            ["version_id", "versions"],
            ["tag_id", "tags"],
            ["source_id", "sources"],
          ],
        };
        const guards: D1PreparedStatement[] = [];
        if (
          (c.table === "credits" || c.table === "tag_assignments") &&
          c.after.source_id
        )
          guards.push(
            check(
              env.DB,
              "EXISTS(SELECT 1 FROM sources WHERE id=? AND json_extract(data,'$.version_id')=? AND json_extract(data,'$.deleted_at') IS NULL)",
              c.after.source_id,
              c.after.version_id,
            ),
          );
        if (c.table === "credits")
          guards.push(
            check(
              env.DB,
              "NOT EXISTS(SELECT 1 FROM credits WHERE json_extract(data,'$.version_id')=? AND json_extract(data,'$.role')=? AND json_extract(data,'$.manual_lock')=1 AND json_extract(data,'$.deleted_at') IS NULL)",
              c.after.version_id,
              c.after.role,
            ),
          );
        if (
          c.table === "aliases" &&
          !changes.some(
            (x) => x.table === "entities" && x.after.id === c.after.entity_id,
          )
        )
          guards.push(
            check(
              env.DB,
              "EXISTS(SELECT 1 FROM entities WHERE id=? AND json_extract(data,'$.manual_lock')=0)",
              c.after.entity_id,
            ),
          );
        return guards.concat(
          (targets[c.table] ?? [])
            .filter(
              ([key, table]) =>
                c.after[key] &&
                !changes.some(
                  (x) => x.table === table && x.after.id === c.after[key],
                ),
            )
            .map(([key, table]) =>
              activeReference(env.DB, table as BusinessTable, c.after[key]),
            ),
        );
      }),
    }),
  );
  return result;
}
export async function claim(env: WorkerEnv): Promise<ResearchJob | null> {
  const picked = await stmt(
    env.DB,
    "SELECT data FROM research_jobs WHERE json_extract(data,'$.deleted_at') IS NULL AND json_extract(data,'$.status') IN ('queued','running') AND json_extract(data,'$.next_attempt_at')<=? AND (json_extract(data,'$.lease_until') IS NULL OR json_extract(data,'$.lease_until')<=?) ORDER BY json_extract(data,'$.next_attempt_at'),id LIMIT 1",
    now(),
    now(),
  ).first<{ data: string }>();
  if (!picked) return null;
  const job: ResearchJob = JSON.parse(picked.data);
  const attempts =
    job.attempts + (job.status === "running" && job.lease_until ? 1 : 0);
  if (attempts >= 4) {
    await save(env, job, {
      status: "needs_review",
      last_error: "RETRY_LIMIT",
      attempts,
    });
    return null;
  }
  const after = updated(job, {
    status: "running",
    attempts,
    lease_until: new Date(Date.now() + 90000).toISOString(),
  });
  try {
    await mutate(env, actor, "research:lease", operation(), async () => ({
      data: null,
      changes: [{ table: "research_jobs", before: job, after }],
      guards: [
        check(
          env.DB,
          "NOT EXISTS(SELECT 1 FROM research_jobs WHERE id<>? AND json_extract(data,'$.lease_until')>?)",
          job.id,
          now(),
        ),
        check(
          env.DB,
          "NOT EXISTS(SELECT 1 FROM research_jobs WHERE json_extract(data,'$.next_attempt_at')>? AND json_extract(data,'$.last_error') LIKE 'PROVIDER_HTTP_429%')",
          now(),
        ),
      ],
    }));
    return after;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return null;
    throw e;
  }
}
export async function sourceQuery(env: WorkerEnv, job: ResearchJob) {
  if (job.response_id) {
    const r = await getRow(env.DB, "responses", job.response_id, false);
    if (
      r.deleted_at ||
      r.version_id ||
      JSON.stringify(job.query) !==
        JSON.stringify({
          title: r.unresolved_title,
          artist_hint: r.artist_hint,
          reference_url: r.reference_url,
        })
    )
      throw new ResearchError("STALE_JOB");
    return job.query!;
  }
  const v = await getRow(env.DB, "versions", job.version_id!);
  return { title: v.title, artist_hint: null, reference_url: v.reference_url };
}
export async function cached(
  env: WorkerEnv,
  job: ResearchJob,
  q: {
    title: string;
    reference_url: string | null;
    artist_hint?: string | null;
  },
) {
  if (!job.response_id || !q.reference_url) return false;
  const v = (
    await rows<Version>(
      env.DB,
      "versions",
      "json_extract(data,'$.reference_url')=? AND json_extract(data,'$.research_status')='complete'",
      catalogUrl(q.reference_url),
    )
  )[0];
  if (!v) return false;
  const sources = await rows<any>(
    env.DB,
    "sources",
    "json_extract(data,'$.version_id')=?",
    v.id,
  );
  if (!sources.some((s) => norm(s.excerpt).includes(norm(q.title))))
    return false;
  if (
    q.artist_hint &&
    !sources.some((s) => norm(s.excerpt).includes(norm(q.artist_hint!)))
  )
    return false;
  const r = await getRow(env.DB, "responses", job.response_id);
  await save(env, job, { status: "complete", candidates: [] }, [
    { table: "responses", before: r, after: updated(r, { version_id: v.id }) },
  ]);
  return true;
}
