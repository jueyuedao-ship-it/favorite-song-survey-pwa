import { authenticate, owner } from "./auth";
import { civilDate, jstToday } from "./statistics";
import { queueTagResearch } from "./record-research";
import { manualTagPlan } from "./manual-tags";
import type {
  BusinessTable,
  EditableTable,
  Version,
  ResearchJob,
  CatalogCandidate,
  WorkerEnv,
  SurveyRecord,
} from "../../shared/contracts";
import {
  invalid,
  ok,
  ApiError,
  businessTables,
  page,
  filterRows,
  notFound,
  requireKeys,
  bodyOf,
  replyMutation,
  expectRevision,
  now,
  text,
  optionalText,
  type Body,
  newRow,
  allRows,
  getRow,
  activeReference,
  check,
  type Change,
  type Actor,
  updated,
} from "./store";
export const editableTables: EditableTable[] = [
  "participants",
  "works",
  "versions",
  "entities",
  "aliases",
  "credits",
  "tags",
  "tag_assignments",
  "sources",
];
const fields: Record<EditableTable, string[]> = {
  participants: ["name"],
  works: ["title", "manual_lock"],
  versions: [
    "work_id",
    "title",
    "kind",
    "reference_url",
    "uploader_entity_id",
    "research_status",
    "manual_lock",
  ],
  entities: ["name", "kind", "manual_lock"],
  aliases: ["entity_id", "name"],
  credits: [
    "version_id",
    "entity_id",
    "role",
    "source_id",
    "confirmed",
    "manual_lock",
  ],
  tags: ["name", "category", "criterion", "evidence_policy", "active"],
  tag_assignments: [
    "version_id",
    "tag_id",
    "evidence",
    "source_id",
    "origin",
    "confirmed",
    "manual_lock",
  ],
  sources: ["version_id", "url", "title", "excerpt", "checked_at", "origin"],
};
export { text, optionalText } from "./store";
export function safeUrl(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const raw = text(value, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid("URLが無効です");
  }
  const host = url!.hostname.toLowerCase().replace(/\.+$/, "");
  url!.hostname = host;
  if (
    url!.protocol !== "https:" ||
    url!.username ||
    url!.password ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.startsWith("[") ||
    /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      host,
    )
  )
    invalid("公開HTTPS URLを入力してください");
  return url!.href;
}
/** Equality only for known recording IDs. Never canonicalize/merge songs by their title. */
export function catalogUrl(value: unknown) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe),
    host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1];
  else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "www.youtube-nocookie.com",
    ].includes(host)
  ) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/)?.[1] ?? null);
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id))
    return `https://www.youtube.com/watch?v=${id}`;
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith("utm_") || ["fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  return url.href;
}
function oneOf(value: any, values: string[]) {
  if (!values.includes(value)) invalid();
  return value;
}
function boolean(value: any) {
  if (typeof value !== "boolean") invalid();
  return value;
}
function tagEvidencePolicy(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  let parsed: any = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      invalid("判定ポリシーはJSONで入力してください");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    invalid("判定ポリシーが無効です");
  const patterns = (key: string, optional = false) => {
    const list = parsed[key];
    if (list === undefined && optional) return undefined;
    if (
      !Array.isArray(list) ||
      list.length > 32 ||
      list.some((item: unknown) => typeof item !== "string" || !item.trim() || item.length > 500)
    )
      invalid("判定ポリシーのパターンを確認してください");
    for (const pattern of list)
      try {
        new RegExp(pattern, "iu");
      } catch {
        invalid("判定ポリシーに無効な正規表現があります");
      }
    return list.map((item: string) => item.trim());
  };
  const positive_patterns = patterns("positive_patterns");
  if (!positive_patterns?.length)
    invalid("判定ポリシーにはpositive_patternsが必要です");
  const negative_patterns = patterns("negative_patterns", true);
  const required_context = parsed.required_context;
  const contexts = ["genre", "mood", "energy", "tempo", "voice", "lyrics"];
  if (
    required_context !== undefined &&
    (!Array.isArray(required_context) ||
      required_context.length > contexts.length ||
      required_context.some((item: unknown) => typeof item !== "string" || !contexts.includes(item)))
  )
    invalid("判定ポリシーのrequired_contextが無効です");
  const exclusive_group =
    parsed.exclusive_group === undefined || parsed.exclusive_group === null || parsed.exclusive_group === ""
      ? null
      : text(parsed.exclusive_group, 80);
  return {
    positive_patterns,
    ...(negative_patterns?.length ? { negative_patterns } : {}),
    ...(required_context?.length ? { required_context: [...new Set(required_context)] } : {}),
    ...(exclusive_group ? { exclusive_group } : {}),
  };
}
export function valuesFor(
  table: EditableTable,
  input: unknown,
  current?: Record<string, any>,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const given = input as Record<string, any>;
  if (Object.keys(given).some((k) => !fields[table].includes(k)))
    invalid("許可されていない編集項目です");
  const v = { ...(current ?? {}), ...given };
  const defaults = (key: string, value: any) => {
    if (v[key] === undefined) v[key] = value;
  };
  if (fields[table].includes("manual_lock")) defaults("manual_lock", true);
  switch (table) {
    case "participants":
      v.name = text(v.name, 80);
      break;
    case "works":
      v.title = text(v.title);
      break;
    case "versions":
      v.work_id = text(v.work_id, 128);
      v.title = text(v.title);
      defaults("kind", "original");
      oneOf(v.kind, ["original", "cover", "remix", "other"]);
      v.reference_url = catalogUrl(v.reference_url);
      v.uploader_entity_id = optionalText(v.uploader_entity_id, 128);
      defaults("research_status", "unconfirmed");
      oneOf(v.research_status, [
        "unconfirmed",
        "queued",
        "running",
        "complete",
        "failed",
        "needs_review",
      ]);
      break;
    case "entities":
      v.name = text(v.name);
      defaults("kind", "person");
      oneOf(v.kind, ["person", "group", "synthetic_voice", "channel"]);
      break;
    case "aliases":
      v.entity_id = text(v.entity_id, 128);
      v.name = text(v.name);
      break;
    case "credits":
      v.version_id = text(v.version_id, 128);
      v.entity_id = text(v.entity_id, 128);
      oneOf(v.role, ["vocalist", "composer", "release_name", "uploader"]);
      v.source_id = optionalText(v.source_id, 128);
      defaults("confirmed", false);
      boolean(v.confirmed);
      break;
    case "tags":
      v.name = text(v.name, 80);
      v.category = text(v.category, 80);
      v.criterion = text(v.criterion, 2000);
      v.evidence_policy = tagEvidencePolicy(v.evidence_policy);
      defaults("active", true);
      boolean(v.active);
      break;
    case "tag_assignments":
      v.version_id = text(v.version_id, 128);
      v.tag_id = text(v.tag_id, 128);
      v.evidence = text(v.evidence, 4000);
      v.source_id = optionalText(v.source_id, 128);
      defaults("origin", "admin");
      oneOf(v.origin, ["admin", "research", "participant"]);
      defaults("confirmed", false);
      boolean(v.confirmed);
      break;
    case "sources":
      v.version_id = text(v.version_id, 128);
      v.url = safeUrl(v.url);
      if (!v.url) invalid();
      v.title = text(v.title);
      v.excerpt = text(v.excerpt, 20000);
      defaults("checked_at", new Date().toISOString());
      if (
        typeof v.checked_at !== "string" ||
        !Number.isFinite(Date.parse(v.checked_at))
      )
        invalid();
      v.checked_at = new Date(v.checked_at).toISOString();
      defaults("origin", "admin");
      oneOf(v.origin, ["admin", "research"]);
      break;
  }
  if (fields[table].includes("manual_lock")) {
    if (current && !("manual_lock" in given)) v.manual_lock = true;
    boolean(v.manual_lock);
  }
  const result = Object.fromEntries(fields[table].map((k) => [k, v[k]]));
  if (current && table === "tag_assignments")
    for (const key of [
      "auto_confirmed",
      "manual_override",
      "automatic_evidence",
      "automatic_source_id",
      "automatic_evidence_type",
      "dictionary_version",
      "research_result_id",
    ])
      if (current[key] !== undefined) result[key] = current[key];
  if (current && table === "sources")
    for (const key of ["quality_tier", "quality_reason"])
      if (current[key] !== undefined) result[key] = current[key];
  return result;
}
export function referenceGuards(
  db: D1Database,
  table: BusinessTable,
  row: Record<string, any>,
) {
  const guards: D1PreparedStatement[] = [];
  const add = (key: string, target: BusinessTable) => {
    if (row[key]) guards.push(activeReference(db, target, row[key]));
  };
  if (table === "versions") {
    add("work_id", "works");
    add("uploader_entity_id", "entities");
  }
  if (table === "aliases") add("entity_id", "entities");
  if (table === "credits") {
    add("version_id", "versions");
    add("entity_id", "entities");
    add("source_id", "sources");
  }
  if (table === "tag_assignments") {
    add("version_id", "versions");
    add("tag_id", "tags");
    add("source_id", "sources");
  }
  if ((table === "credits" || table === "tag_assignments") && row.source_id)
    guards.push(
      check(
        db,
        "EXISTS(SELECT 1 FROM sources WHERE id=? AND json_extract(data,'$.version_id')=? AND json_extract(data,'$.deleted_at') IS NULL)",
        row.source_id,
        row.version_id,
      ),
    );
  if (table === "sources") {
    add("version_id", "versions");
    // Forward provenance checks on credit/tag writes are insufficient: moving
    // their source must recheck every active reverse reference in this batch.
    for (const dependent of ["credits", "tag_assignments"] as const) {
      guards.push(
        check(
          db,
          `NOT EXISTS(SELECT 1 FROM ${dependent} WHERE json_extract(data,'$.source_id')=? AND json_extract(data,'$.version_id')<>? AND json_extract(data,'$.deleted_at') IS NULL)`,
          row.id,
          row.version_id,
        ),
      );
    }
  }
  if (table === "responses") {
    add("participant_id", "participants");
    add("version_id", "versions");
  }
  return guards;
}
export function deletionGuards(
  db: D1Database,
  table: BusinessTable,
  id: string,
) {
  const relations: Partial<Record<BusinessTable, [BusinessTable, string][]>> = {
    participants: [
      ["responses", "participant_id"],
      ["devices", "participant_id"],
      ["invites", "participant_id"],
    ],
    works: [["versions", "work_id"]],
    versions: [
      ["responses", "version_id"],
      ["credits", "version_id"],
      ["sources", "version_id"],
      ["tag_assignments", "version_id"],
    ],
    entities: [
      ["aliases", "entity_id"],
      ["credits", "entity_id"],
      ["versions", "uploader_entity_id"],
    ],
    sources: [
      ["credits", "source_id"],
      ["tag_assignments", "source_id"],
    ],
  };
  return (relations[table] ?? []).map(([other, key]) =>
    check(
      db,
      `NOT EXISTS(SELECT 1 FROM ${other} WHERE json_extract(data,'$.${key}')=? AND json_extract(data,'$.deleted_at') IS NULL ${other === 'devices' ? "AND json_extract(data,'$.revoked_at') IS NULL" : other === 'invites' ? "AND json_extract(data,'$.claimed_at') IS NULL AND json_extract(data,'$.expires_at')>strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ''})`,
      id,
    ),
  );
}
export function researchJob(
  version: Version | null,
  response?: Record<string, any>,
): ResearchJob {
  return newRow({
    version_id: version?.id ?? null,
    response_id: response?.id ?? null,
    query: response
      ? {
          title: response.unresolved_title,
          artist_hint: response.artist_hint,
          reference_url: response.reference_url,
        }
      : null,
    candidates: [],
    status: "queued" as const,
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
    lease_until: null,
    dictionary_version: "1",
    analysis_version: "2",
  });
}
export async function candidates(
  db: D1Database,
  q = "",
): Promise<CatalogCandidate[]> {
  const [versions, works, credits, entities, aliases] = await Promise.all([
    allRows(db, "versions"),
    allRows(db, "works"),
    allRows(db, "credits"),
    allRows(db, "entities"),
    allRows(db, "aliases"),
  ]);
  let query = q.trim().normalize("NFKC").toLocaleLowerCase("ja");
  if (/^https:\/\//i.test(q)) { try { query = catalogUrl(q)!.toLocaleLowerCase("ja"); } catch {} }
  return versions
    .map((v) => ({
      ...v,
      work_title: works.find((w) => w.id === v.work_id)?.title ?? v.title,
      credits: credits
        .filter((c) => c.version_id === v.id)
        .map((c) => ({
          ...c,
          entity_name:
            entities.find((e) => e.id === c.entity_id)?.name ?? "未確認",
        })),
    }))
    .filter(
      (v) =>
        !query ||
        [
          v.title,
          v.work_title,
          v.reference_url ?? "",
          ...v.credits.flatMap((c) => [
            c.entity_name,
            ...aliases
              .filter((a) => a.entity_id === c.entity_id)
              .map((a) => a.name),
          ]),
        ].some((t) => t.toLocaleLowerCase("ja").includes(query)),
    );
}
export async function songDetail(db: D1Database, id: string) {
  const version = await getRow(db, "versions", id),
    work = await getRow(db, "works", version.work_id);
  const [credits, entities, aliases, tags, assignments, sources, jobs] =
    await Promise.all([
      allRows(db, "credits"),
      allRows(db, "entities"),
      allRows(db, "aliases"),
      allRows(db, "tags"),
      allRows(db, "tag_assignments"),
      allRows(db, "sources"),
      allRows(db, "research_jobs"),
    ]);
  const tagJob = jobs
    .filter((job) => job.version_id === id && job.purpose === "tag_enrichment")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const coverageGroups = [
    "genre_sound",
    "mood_energy_tempo",
    "voice",
    "lyric_theme",
  ] as const;
  return {
    version,
    work,
    credits: credits
      .filter((c) => c.version_id === id)
      .map((c) => ({
        ...c,
        entity: entities.find((e) => e.id === c.entity_id)!,
        aliases: aliases.filter((a) => a.entity_id === c.entity_id),
      })),
    tags: assignments
      .filter(
        (a) =>
          a.version_id === id &&
          a.confirmed &&
          tags.some((t) => t.id === a.tag_id && t.active),
      )
      .map((a) => ({ ...a, tag: tags.find((t) => t.id === a.tag_id)! })),
    sources: sources.filter((s) => s.version_id === id),
    tag_coverage: Object.fromEntries(
      coverageGroups.map((group) => [
        group,
        tagJob?.descriptive_coverage?.[group] ?? "unknown",
      ]),
    ),
  };
}

export function recordsFilter(rows: SurveyRecord[], url: URL) {
  const participant = url.searchParams.get("participant_id"),
    from = url.searchParams.get("from"),
    to = url.searchParams.get("to");
  if (from) civilDate(from);
  if (to) civilDate(to);
  return filterRows(
    rows.filter(
      (r) =>
        (!participant || r.participant_id === participant) &&
        (!from || r.record_date >= from) &&
        (!to || r.record_date <= to),
    ),
    url,
  );
}
export function ownRecord(actor: Actor, row: SurveyRecord) {
  owner(actor, row.participant_id);
}
function recordValues(
  input: Body,
  participantId: string,
  current?: SurveyRecord,
) {
  const v = {
    version_id: null,
    unresolved_title: null,
    artist_hint: null,
    reference_url: null,
    ...current,
    ...input,
    participant_id: participantId,
  };
  v.record_date = civilDate(v.record_date);
  if (v.record_date > jstToday())
    invalid("記録日は今日または過去の日付を指定してください");
  v.version_id = optionalText(v.version_id, 128);
  v.unresolved_title = optionalText(v.unresolved_title);
  v.artist_hint = optionalText(v.artist_hint);
  v.reference_url = catalogUrl(v.reference_url);
  if (!v.version_id && !v.unresolved_title)
    invalid("曲名またはバージョンを指定してください");
  return {
    participant_id: participantId,
    version_id: v.version_id,
    record_date: v.record_date,
    unresolved_title: v.unresolved_title,
    artist_hint: v.artist_hint,
    reference_url: v.reference_url,
  };
}
export async function recordMutation(
  request: Request,
  env: WorkerEnv,
  path: string,
  admin: boolean,
  id?: string,
  resolve = false,
) {
  const actor = await authenticate(request, env, admin ? "admin" : "guest"),
    body = await bodyOf(request),
    method = request.method;
  if (
    (method === "POST" && id && !resolve) ||
    (method !== "POST" && !id) ||
    (resolve && method !== "POST")
  )
    return notFound();
  requireKeys(
    body,
    method === "DELETE"
      ? ["operation_id", "expected_revision"]
      : [
          "operation_id",
          "expected_revision",
          "participant_id",
          "version_id",
          "record_date",
          "unresolved_title",
          "artist_hint",
          "reference_url",
          "tag_version_id",
          "tag_changes",
        ],
  );
  return replyMutation(env, actor, `${method}:${path}`, body, async () => {
    const changes: Change[] = [];
    let row: SurveyRecord;
    let before: SurveyRecord | null = null;
    if (method === "POST" && !id) {
      const participant = admin
        ? text(body.participant_id, 128)
        : actor.participant_id!;
      if (body.participant_id) owner(actor, body.participant_id);
      row = newRow(recordValues(body, participant));
    } else {
      before = await getRow(env.DB, "responses", id!);
      ownRecord(actor, before);
      expectRevision(before, body);
      if (
        body.participant_id &&
        body.participant_id !== before.participant_id
      ) {
        if (!admin) owner(actor, body.participant_id);
      }
      if (method === "DELETE") row = updated(before, { deleted_at: now() });
      else {
        if (resolve && !body.version_id) invalid();
        row = updated(
          before,
          recordValues(
            body,
            admin
              ? (body.participant_id ?? before.participant_id)
              : before.participant_id,
            before,
          ),
        );
      }
    }
    const dailyLimitGuards =
      !row.deleted_at &&
      (!before ||
        before.participant_id !== row.participant_id ||
        before.record_date !== row.record_date)
        ? [
            check(
              env.DB,
              "NOT EXISTS(SELECT 1 FROM responses WHERE id<>? AND json_extract(data,'$.participant_id')=? AND json_extract(data,'$.record_date')=? AND json_extract(data,'$.deleted_at') IS NULL)",
              row.id,
              row.participant_id,
              row.record_date,
            ),
          ]
        : [];
    changes.push({
      table: "responses",
      before,
      after: row,
      action: method === "DELETE" ? "delete" : before ? "update" : "create",
    });
    if (row.version_id && !row.deleted_at && before?.version_id !== row.version_id) {
      await queueTagResearch(env, await getRow(env.DB, "versions", row.version_id), changes, true, before ?? undefined);
    }
    // Every unknown answer has a lookup job, even in an empty catalog.
    if (!row.version_id && !row.deleted_at) {
      const existing = (await allRows(env.DB, "research_jobs")).find(
        (j) => j.response_id === row.id,
      );
      if (!existing) {
        const job = researchJob(null, row);
        changes.push({ table: "research_jobs", before: null, after: job });
      } else if (
        before &&
        JSON.stringify({ title: before.unresolved_title, artist_hint: before.artist_hint, reference_url: before.reference_url }) !==
          JSON.stringify({
            title: row.unresolved_title,
            artist_hint: row.artist_hint,
            reference_url: row.reference_url,
          })
      ) {
        changes.push({
          table: "research_jobs",
          before: existing,
          after: updated(existing, {
            stage: "search",
            evidence: [],
            analysis: undefined,
            metadata_cursor: 0,
            metadata_source_cursor: 0,
            catalog_cursor: 0,
            descriptive_status: undefined,
            descriptive_source_ids: undefined,
            descriptive_category: undefined,
            descriptive_coverage: undefined,
            analysis_version: "2",
            purpose: undefined,
            response_revision: undefined,
            query: {
              title: row.unresolved_title!,
              artist_hint: row.artist_hint,
              reference_url: row.reference_url,
            },
            status: "queued",
            attempts: 0,
            last_error: null,
            candidates: [],
            lease_until: null,
            next_attempt_at: now(),
          }),
        });
      }
    }
    if ((row.version_id && before?.version_id !== row.version_id) || row.deleted_at) {
      const existing = (await allRows(env.DB, "research_jobs")).find(j => j.response_id === row.id);
      if (existing) changes.push({table:"research_jobs", before:existing, after:updated(existing,{deleted_at:now(), status:"failed", last_error:"STALE_JOB", candidates:[], lease_until:null})});
    }
    if (before && !row.deleted_at && before.version_id === row.version_id && !changes.some(c => c.table === "research_jobs" && c.after.response_id === row.id)) {
      const existing = (await allRows(env.DB, "research_jobs")).find(j => j.response_id === row.id);
      if (existing?.purpose === "candidate_lookup") changes.push({table:"research_jobs", before:existing,
        after:updated(existing,{response_revision:row.revision,...(existing.status === "running" ? {status:"queued",lease_until:null} : {})})});
    }
    const tags = await manualTagPlan(env, actor, row, body);
    return {
      data: row,
      status: before ? 200 : 201,
      changes,
      guards: [
        ...referenceGuards(env.DB, "responses", row),
        ...dailyLimitGuards,
        ...(tags.guards ?? []),
      ],
      extra: tags.extra,
    };
  });
}
export async function dataRoute(
  request: Request,
  env: WorkerEnv,
  url: URL,
  table: BusinessTable,
  id?: string,
) {
  const actor = await authenticate(request, env, "admin");
  if (!businessTables.includes(table)) notFound();
  if (request.method === "GET" && !id) {
    const rows = await allRows(
      env.DB,
      table,
      url.searchParams.get("include_deleted") !== "true",
    );
    return ok(page(filterRows(rows, url), url));
  }
  if (
    (request.method === "POST" && id) ||
    (request.method !== "POST" && !id) ||
    request.method === "GET"
  )
    return notFound();
  if (!editableTables.includes(table as EditableTable))
    throw new ApiError(403, "FORBIDDEN", "専用操作を使用してください");
  const body = await bodyOf(request);
  requireKeys(
    body,
    request.method === "DELETE"
      ? ["operation_id", "expected_revision"]
      : ["operation_id", "expected_revision", "values"],
  );
  return replyMutation(
    env,
    actor,
    `${request.method}:${url.pathname}`,
    body,
    async () => {
      const before = id ? await getRow(env.DB, table, id) : null;
      if (before) expectRevision(before, body);
      if (request.method === "POST" && id) notFound();
      if (!["POST", "PATCH", "DELETE"].includes(request.method)) notFound();
      const row =
        request.method === "DELETE"
          ? updated(before!, { deleted_at: now() })
          : before
            ? updated(
                before,
                valuesFor(table as EditableTable, body.values, before),
              )
            : newRow(valuesFor(table as EditableTable, body.values));
      const changes: Change[] = [
        {
          table,
          before: before as any,
          after: row as any,
          action:
            request.method === "DELETE"
              ? "delete"
              : before
                ? "update"
                : "create",
        },
      ];
      // Catalog definitions and the corresponding durable job are one transaction.
      if (table === "versions" && !before) {
        const job = researchJob(row as Version);
        changes.push({ table: "research_jobs", before: null, after: job });
      }
      if (table === "versions" && request.method === "DELETE") {
        for (const job of (await allRows(env.DB, "research_jobs")).filter(
          (j) => j.version_id === row.id,
        )) {
          changes.push({
            table: "research_jobs",
            before: job,
            after: updated(job, { deleted_at: now(), lease_until: null }),
            action: "delete",
          });
        }
      }
      return {
        data: row,
        status: before ? 200 : 201,
        changes,
        guards:
          request.method === "DELETE"
            ? deletionGuards(env.DB, table, row.id)
            : referenceGuards(env.DB, table, row),
      };
    },
  );
}
