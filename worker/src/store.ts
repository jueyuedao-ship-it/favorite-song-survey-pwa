import type {
  BusinessRows,
  BusinessTable,
  Row,
  WorkerEnv,
} from "../../shared/contracts";
export const businessTables: BusinessTable[] = [
  "participants",
  "works",
  "versions",
  "entities",
  "aliases",
  "credits",
  "responses",
  "tags",
  "tag_assignments",
  "sources",
  "research_results",
  "research_jobs",
  "usage",
  "devices",
  "invites",
  "audit",
  "audit_corrections",
  "sync_status",
];
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function invalid(message = "入力内容を確認してください"): never {
  throw new ApiError(400, "INVALID_INPUT", message);
}
export function conflict(
  message = "別の更新または同じ記録が存在します",
): never {
  throw new ApiError(409, "CONFLICT", message);
}
export const now = () => new Date().toISOString();
export function newRow<T extends object>(values: T): T & Row {
  const time = now();
  return {
    ...values,
    id: crypto.randomUUID(),
    revision: 1,
    created_at: time,
    updated_at: time,
    deleted_at: null,
  };
}
export function updated<T extends Row>(row: T, values: Partial<T>): T {
  return {
    ...row,
    ...values,
    id: row.id,
    created_at: row.created_at,
    revision: row.revision + 1,
    updated_at: now(),
  };
}
export interface Actor {
  id: string;
  type: "guest" | "admin" | "system";
  participant_id?: string;
  device_id?: string;
}
export interface Change {
  table: BusinessTable;
  before: (Row & Record<string, any>) | null;
  after: Row & Record<string, any>;
  action?: "create" | "update" | "delete";
}
export interface Plan<T> {
  changes: Change[];
  data: T;
  status?: number;
  guards?: D1PreparedStatement[];
  extra?: D1PreparedStatement[];
}
export const stmt = (db: D1Database, sql: string, ...values: unknown[]) =>
  db.prepare(sql).bind(...values);
export function check(db: D1Database, condition: string, ...values: unknown[]) {
  return stmt(
    db,
    `INSERT INTO mutation_checks(ok) SELECT CASE WHEN (${condition}) THEN 1 ELSE 0 END`,
    ...values,
  );
}
export async function getRow<T extends BusinessTable>(
  db: D1Database,
  table: T,
  id: string,
  active = true,
): Promise<BusinessRows[T]> {
  const value = await stmt(
    db,
    `SELECT data FROM ${table} WHERE id=? ${active ? "AND json_extract(data,'$.deleted_at') IS NULL" : ""}`,
    id,
  ).first<{ data: string }>();
  if (!value) throw new ApiError(404, "NOT_FOUND", "対象が見つかりません");
  return JSON.parse(value.data);
}
export async function allRows<T extends BusinessTable>(
  db: D1Database,
  table: T,
  active = true,
): Promise<BusinessRows[T][]> {
  const rows = await db
    .prepare(
      `SELECT data FROM ${table} ${active ? "WHERE json_extract(data,'$.deleted_at') IS NULL" : ""} ORDER BY id`,
    )
    .all<{ data: string }>();
  return rows.results.map((r) => JSON.parse(r.data));
}
export async function sha256(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Real D1 batch transaction. A failed precondition rolls back operation, rows, audit and feed. */
export async function mutate<T>(
  env: WorkerEnv,
  actor: Actor,
  scope: string,
  body: Record<string, any>,
  build: () => Promise<Plan<T>>,
): Promise<{ data: T; status: number }> {
  if (
    typeof body.operation_id !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(body.operation_id)
  )
    invalid("操作IDが必要です");
  const fingerprint = await sha256(scope + "\n" + canonical(body));
  const replay = async () => {
    const saved = await stmt(
      env.DB,
      "SELECT fingerprint,response,status FROM operations WHERE actor_id=? AND operation_id=?",
      actor.id,
      body.operation_id,
    ).first<{ fingerprint: string; response: string; status: number }>();
    if (!saved) return null;
    if (saved.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "同じ操作IDが異なる内容に使用されています",
      );
    return { data: JSON.parse(saved.response) as T, status: saved.status };
  };
  const saved = await replay();
  if (saved) return saved;
  let plan: Plan<T>;
  try {
    plan = await build();
  } catch (error) {
    // An identical request may commit after our first replay read, before the
    // builder reads the newly changed/deleted row or consumed invitation.
    const repeated = await replay();
    if (repeated) return repeated;
    throw error;
  }
  const status = plan.status ?? 200;
  const statements: D1PreparedStatement[] = [
    stmt(
      env.DB,
      "INSERT INTO operations(actor_id,operation_id,fingerprint,response,status) VALUES(?,?,?,?,?)",
      actor.id,
      body.operation_id,
      fingerprint,
      JSON.stringify(plan.data),
      status,
    ),
  ];
  // Revalidate the device in the mutation transaction, including concurrent revocations.
  if (actor.type === "guest")
    statements.push(
      check(
        env.DB,
        "EXISTS(SELECT 1 FROM devices WHERE id=? AND json_extract(data,'$.revoked_at') IS NULL AND json_extract(data,'$.deleted_at') IS NULL)",
        actor.device_id,
      ),
    );
  if (actor.type === "admin")
    statements.push(
      check(
        env.DB,
        "EXISTS(SELECT 1 FROM admin_sessions WHERE id=? AND expires_at>?)",
        actor.id,
        now(),
      ),
    );
  statements.push(...(plan.guards ?? []));
  for (const change of plan.changes) {
    if (!businessTables.includes(change.table)) invalid();
    if (change.before)
      statements.push(
        check(
          env.DB,
          `EXISTS(SELECT 1 FROM ${change.table} WHERE id=? AND revision=?)`,
          change.before.id,
          change.before.revision,
        ),
      );
    else
      statements.push(
        check(
          env.DB,
          `NOT EXISTS(SELECT 1 FROM ${change.table} WHERE id=?)`,
          change.after.id,
        ),
      );
    statements.push(
      change.before
        ? stmt(
            env.DB,
            `UPDATE ${change.table} SET data=? WHERE id=?`,
            JSON.stringify(change.after),
            change.after.id,
          )
        : stmt(
            env.DB,
            `INSERT INTO ${change.table}(id,data) VALUES(?,?)`,
            change.after.id,
            JSON.stringify(change.after),
          ),
    );
    // Registration's internal idempotency namespace contains a capability hash; it must never enter business history.
    const auditActor = /^(registration|claim):/.test(actor.id)
      ? (change.after.participant_id ?? change.after.id)
      : actor.id;
    const audit = newRow({
      table: change.table,
      row_id: change.after.id,
      action: change.action ?? (change.before ? "update" : "create"),
      actor_id: auditActor,
      actor_type: actor.type,
      participant_id:
        change.after.participant_id ?? actor.participant_id ?? null,
      before: change.before,
      after: change.after,
    });
    statements.push(
      stmt(
        env.DB,
        "INSERT INTO audit(id,data) VALUES(?,?)",
        audit.id,
        JSON.stringify(audit),
      ),
    );
  }
  statements.push(
    ...(plan.extra ?? []),
    env.DB.prepare("DELETE FROM mutation_checks"),
  );
  try {
    await env.DB.batch(statements);
    return { data: plan.data, status };
  } catch (error) {
    const repeated = await replay();
    if (repeated) return repeated;
    const text = String(error);
    if (/constraint|immutable|UNIQUE|CHECK/i.test(text)) conflict();
    throw new ApiError(
      503,
      "DATABASE_UNAVAILABLE",
      "保存に失敗しました。操作IDを保持して再試行してください",
    );
  }
}
export function expectRevision(row: Row, body: Record<string, any>) {
  if (
    !Number.isSafeInteger(body.expected_revision) ||
    body.expected_revision < 1
  )
    invalid("版番号が必要です");
  if (row.revision !== body.expected_revision)
    conflict("別の端末で変更されています。再取得してください");
}
export function activeReference(
  db: D1Database,
  table: BusinessTable,
  id: string,
) {
  return check(
    db,
    `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND json_extract(data,'$.deleted_at') IS NULL)`,
    id,
  );
}
export function limitOf(url: URL) {
  const raw = url.searchParams.get("limit");
  const n = raw === null ? 100 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) invalid("取得件数は1〜200です");
  return n;
}
export function page<T extends Row>(rows: T[], url: URL) {
  const cursor = url.searchParams.get("cursor") ?? "",
    limit = limitOf(url);
  const matching = rows
    .filter((r) => r.id > cursor)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    items: matching.slice(0, limit),
    next_cursor: matching.length > limit ? matching[limit - 1].id : null,
  };
}
export function requireKeys(body: Record<string, any>, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    invalid("許可されていない項目です");
}

export type Body = Record<string, any>;
export const ok = (data: unknown, status = 200) =>
  Response.json({ data }, { status });
export const notFound = (): never => {
  throw new ApiError(404, "NOT_FOUND", "対象が見つかりません");
};
export async function bodyOf(request: Request): Promise<Body> {
  const raw = await request.text();
  if (raw.length > 65536) invalid("入力が大きすぎます");
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    invalid("JSONを入力してください");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  return body;
}
export async function replyMutation<T>(
  env: WorkerEnv,
  actor: Actor,
  scope: string,
  body: Body,
  build: Parameters<typeof mutate<T>>[4],
) {
  const result = await mutate(env, actor, scope, body, build);
  return ok(result.data, result.status);
}
export function filterRows<T extends Row>(rows: T[], url: URL) {
  const q = url.searchParams.get("q")?.toLocaleLowerCase("ja");
  return rows.filter(
    (r) => !q || JSON.stringify(r).toLocaleLowerCase("ja").includes(q),
  );
}

export function text(value: unknown, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    invalid();
  return value.trim().normalize("NFKC");
}
export function optionalText(value: unknown, max = 256) {
  return value === null || value === undefined || value === ""
    ? null
    : text(value, max);
}
