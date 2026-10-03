import type {
  WorkerEnv,
  SurveyRecord,
  SongTagEditorData,
  TagAssignment,
} from "../../shared/contracts";
import {
  allRows,
  invalid,
  conflict,
  requireKeys,
  newRow,
  updated,
  check,
  stmt,
  type Actor,
  type Plan,
} from "./store";

export async function songTagEditor(
  env: WorkerEnv,
  record: SurveyRecord,
): Promise<SongTagEditorData> {
  if (!record.version_id)
    invalid("曲の候補を選んで保存してからタグを編集してください。");
  const [tags, assignments] = await Promise.all([
    allRows(env.DB, "tags"),
    allRows(env.DB, "tag_assignments"),
  ]);
  return {
    version_id: record.version_id!,
    tags: tags
      .filter((t) => t.active)
      .map((t) => {
        const a = assignments.find(
          (a) => a.version_id === record.version_id && a.tag_id === t.id,
        );
        return {
          ...t,
          selected: a?.confirmed ?? false,
          assignment_id: a?.id ?? null,
          assignment_revision: a?.revision ?? null,
          manual_lock: a?.manual_lock ?? false,
          origin: a?.origin ?? null,
        };
      }),
  };
}

/** Bulk row/audit writes preserve the normal atomic mutation contract within D1's per-request budget. */
export async function manualTagPlan(
  env: WorkerEnv,
  actor: Actor,
  record: SurveyRecord,
  body: Record<string, any>,
): Promise<Pick<Plan<unknown>, "guards" | "extra">> {
  if (body.tag_changes === undefined) return {};
  if (!record.version_id || body.tag_version_id !== record.version_id)
    invalid("保存する曲の版とタグの対象が一致しません。");
  if (!Array.isArray(body.tag_changes) || body.tag_changes.length > 100)
    invalid();
  if (!body.tag_changes.length) return {};
  const [tags, assignments] = await Promise.all([
    allRows(env.DB, "tags"),
    allRows(env.DB, "tag_assignments"),
  ]);
  const seen = new Set<string>(),
    writes: { id: string; data: TagAssignment }[] = [],
    audits: { id: string; data: object }[] = [];
  for (const value of body.tag_changes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    requireKeys(value, [
      "tag_id",
      "confirmed",
      "assignment_id",
      "expected_revision",
    ]);
    if (
      typeof value.tag_id !== "string" ||
      typeof value.confirmed !== "boolean" ||
      seen.has(value.tag_id) ||
      !tags.some((t) => t.id === value.tag_id && t.active)
    )
      invalid("有効なタグを選んでください。");
    seen.add(value.tag_id);
    const before = assignments.find(
      (a) => a.version_id === record.version_id && a.tag_id === value.tag_id,
    );
    if (
      before
        ? value.assignment_id !== before.id ||
          value.expected_revision !== before.revision
        : value.assignment_id !== null || value.expected_revision !== null
    )
      conflict(
        "タグが別の端末または自動調査で変更されています。編集欄を開き直してください。",
      );
    const values = {
      version_id: record.version_id!,
      tag_id: value.tag_id,
      confirmed: value.confirmed,
      manual_lock: true,
      origin:
        actor.type === "admin" ? ("admin" as const) : ("participant" as const),
      source_id: null,
      evidence: value.confirmed
        ? "手動設定：タグを追加"
        : "手動設定：タグを解除",
    };
    const after = before ? updated(before, values) : newRow(values);
    writes.push({ id: after.id, data: after });
    const audit = newRow({
      table: "tag_assignments",
      row_id: after.id,
      action: before ? "update" : "create",
      actor_id: actor.id,
      actor_type: actor.type,
      participant_id: record.participant_id,
      before: before ?? null,
      after,
    });
    audits.push({ id: audit.id, data: audit });
  }
  return {
    guards: [
      check(
        env.DB,
        `NOT EXISTS (
    SELECT 1 FROM json_each(?) c
    LEFT JOIN tags t ON t.id=json_extract(c.value,'$.tag_id') AND json_extract(t.data,'$.deleted_at') IS NULL AND json_extract(t.data,'$.active')=1
    LEFT JOIN tag_assignments a ON json_extract(a.data,'$.version_id')=? AND json_extract(a.data,'$.tag_id')=json_extract(c.value,'$.tag_id') AND json_extract(a.data,'$.deleted_at') IS NULL
    WHERE t.id IS NULL OR (json_extract(c.value,'$.assignment_id') IS NULL AND a.id IS NOT NULL)
    OR (json_extract(c.value,'$.assignment_id') IS NOT NULL AND (a.id IS NULL OR a.id<>json_extract(c.value,'$.assignment_id') OR a.revision<>json_extract(c.value,'$.expected_revision')))
  )`,
        JSON.stringify(body.tag_changes),
        record.version_id,
      ),
    ],
    extra: [
      stmt(
        env.DB,
        "INSERT INTO tag_assignments(id,data) SELECT json_extract(value,'$.id'),json_extract(value,'$.data') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        JSON.stringify(writes),
      ),
      stmt(
        env.DB,
        "INSERT INTO audit(id,data) SELECT json_extract(value,'$.id'),json_extract(value,'$.data') FROM json_each(?)",
        JSON.stringify(audits),
      ),
    ],
  };
}
