import type {
  WorkerEnv,
  SurveyRecord,
  SongTagEditorData,
  TagAssignment,
  ManualTagOverride,
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

function manualOverrideOf(
  assignment?: TagAssignment,
): ManualTagOverride {
  if (!assignment) return "auto";
  if (assignment.manual_override === "force_on" || assignment.manual_override === "force_off")
    return assignment.manual_override;
  if (assignment.manual_lock)
    return assignment.confirmed ? "force_on" : "force_off";
  return "auto";
}

function automaticConfirmedOf(assignment?: TagAssignment) {
  if (!assignment) return false;
  if (typeof assignment.auto_confirmed === "boolean")
    return assignment.auto_confirmed;
  return assignment.origin === "research" && !assignment.manual_lock
    ? assignment.confirmed
    : false;
}

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
        const manual_override = manualOverrideOf(a);
        const auto_selected = automaticConfirmedOf(a);
        const selected =
          manual_override === "force_on"
            ? true
            : manual_override === "force_off"
              ? false
              : auto_selected;
        return {
          ...t,
          selected,
          auto_selected,
          manual_override,
          assignment_id: a?.id ?? null,
          assignment_revision: a?.revision ?? null,
          manual_lock: manual_override !== "auto",
          origin: a?.origin ?? null,
          evidence: a?.evidence ?? null,
          source_id: a?.source_id ?? null,
          automatic_evidence_type: a?.automatic_evidence_type ?? null,
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
      "override",
      "confirmed",
      "assignment_id",
      "expected_revision",
    ]);
    const override: ManualTagOverride =
      value.override === "auto" ||
      value.override === "force_on" ||
      value.override === "force_off"
        ? value.override
        : typeof value.confirmed === "boolean"
          ? value.confirmed
            ? "force_on"
            : "force_off"
          : invalid("タグの手動設定を選んでください。");
    if (
      typeof value.tag_id !== "string" ||
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
    const autoConfirmed = automaticConfirmedOf(before);
    const autoEvidence =
      before?.automatic_evidence ??
      (before?.origin === "research" && !before.manual_lock
        ? before.evidence
        : null);
    const autoSourceId =
      before?.automatic_source_id ??
      (before?.origin === "research" && !before.manual_lock
        ? before.source_id
        : null);
    const manualOrigin =
      actor.type === "admin" ? ("admin" as const) : ("participant" as const);
    const values = {
      version_id: record.version_id!,
      tag_id: value.tag_id,
      auto_confirmed: autoConfirmed,
      manual_override: override === "auto" ? null : override,
      confirmed:
        override === "force_on"
          ? true
          : override === "force_off"
            ? false
            : autoConfirmed,
      manual_lock: override !== "auto",
      origin: override === "auto" && autoEvidence ? ("research" as const) : manualOrigin,
      automatic_evidence: autoEvidence,
      automatic_source_id: autoSourceId,
      automatic_evidence_type: before?.automatic_evidence_type ?? null,
      dictionary_version: before?.dictionary_version ?? null,
      research_result_id: before?.research_result_id ?? null,
      source_id: override === "auto" ? autoSourceId : null,
      evidence:
        override === "force_on"
          ? "手動設定：タグを追加"
          : override === "force_off"
            ? "手動設定：タグを解除"
            : autoEvidence ?? "手動設定を解除し、自動判定に戻しました（自動根拠なし）",
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
