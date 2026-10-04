import type {
  Statistics,
  CreditRole,
  Ranking,
  SurveyRecord,
  TagCoverageGroup,
  TagCoverageStatus,
} from "../../shared/contracts";
import { allRows, invalid } from "./store";
export function civilDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    invalid("有効な記録日を入力してください");
  const date = new Date(value + "T00:00:00Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    invalid("有効な記録日を入力してください");
  return value;
}
export function jstToday() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function monday(date: string) {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
export function range(url: URL) {
  const anchor = civilDate(url.searchParams.get("anchor") ?? jstToday()),
    period = url.searchParams.get("period") ?? "week";
  let from: string, to: string;
  if (period === "all") {
    from = "0001-01-01";
    to = "9999-12-31";
  } else if (period === "day") {
    from = to = anchor;
  } else if (period === "month") {
    from = anchor.slice(0, 7) + "-01";
    const d = new Date(anchor + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    to = d.toISOString().slice(0, 10);
  } else if (period === "week") {
    from = monday(anchor);
    to = addDays(from, 6);
  } else invalid("集計期間が無効です");
  from = civilDate(url.searchParams.get("from") ?? from!);
  to = civilDate(url.searchParams.get("to") ?? to!);
  if (from > to) invalid("期間の開始と終了を確認してください");
  return { from, to, anchor };
}
export async function statistics(
  db: D1Database,
  url: URL,
): Promise<Statistics> {
  const { from, to, anchor } = range(url),
    participantId = url.searchParams.get("participant_id"),
    group = url.searchParams.get("group_by") ?? "work";
  if (!["work", "version"].includes(group)) invalid();
  const [
    responses,
    versions,
    works,
    participants,
    credits,
    entities,
    tags,
    assignments,
    researchJobs,
  ] = await Promise.all([
    allRows(db, "responses"),
    allRows(db, "versions"),
    allRows(db, "works"),
    allRows(db, "participants"),
    allRows(db, "credits"),
    allRows(db, "entities"),
    allRows(db, "tags"),
    allRows(db, "tag_assignments"),
    allRows(db, "research_jobs"),
  ]);
  const all = responses.filter(
      (r) => !participantId || r.participant_id === participantId,
    ),
    records = all.filter((r) => r.record_date >= from && r.record_date <= to);
  const map = new Map<string, Ranking>();
  for (const r of records) {
    const v = versions.find((v) => v.id === r.version_id);
    if (!v) continue;
    const id = group === "work" ? v.work_id : v.id,
      title =
        group === "work"
          ? (works.find((w) => w.id === v.work_id)?.title ?? v.title)
          : v.title;
    const entry = map.get(id) ?? {
      id,
      title,
      count: 0,
      rank: 0,
      supporter_count: 0,
      supporters: [],
    };
    entry.count++;
    const p = participants.find((p) => p.id === r.participant_id);
    if (p && !entry.supporters.some((s) => s.id === p.id))
      entry.supporters.push({ id: p.id, name: p.name });
    entry.supporter_count = entry.supporters.length;
    map.set(id, entry);
  }
  const rankings = [...map.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  for (let i = 0; i < rankings.length; i++)
    rankings[i].rank =
      i > 0 && rankings[i].count === rankings[i - 1].count
        ? rankings[i - 1].rank
        : i + 1;
  const roles: Statistics["roles"] = {
    vocalist: [],
    composer: [],
    release_name: [],
    uploader: [],
  };
  for (const role of Object.keys(roles) as CreditRole[]) {
    const counts = new Map<string, number>();
    for (const r of records) {
      const ids = new Set(
        credits
          .filter((c) => c.version_id === r.version_id && c.role === role && c.confirmed)
          .map((c) => c.entity_id),
      );
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    roles[role] = [...counts]
      .map(([entity_id, count]) => ({
        entity_id,
        name: entities.find((e) => e.id === entity_id)?.name ?? "未確認",
        count,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  const coverageGroups: TagCoverageGroup[] = [
    "genre_sound",
    "mood_energy_tempo",
    "voice",
    "lyric_theme",
  ];
  const coverageByVersion = new Map<
    string,
    Record<TagCoverageGroup, TagCoverageStatus>
  >();
  for (const version of versions) {
    const job = researchJobs
      .filter(
        (candidate) =>
          candidate.version_id === version.id &&
          candidate.purpose === "tag_enrichment",
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    coverageByVersion.set(
      version.id,
      Object.fromEntries(
        coverageGroups.map((group) => [
          group,
          job?.descriptive_coverage?.[group] ?? "unknown",
        ]),
      ) as Record<TagCoverageGroup, TagCoverageStatus>,
    );
  }
  const coverageOf = (r: SurveyRecord) =>
    r.version_id
      ? coverageByVersion.get(r.version_id) ??
        Object.fromEntries(
          coverageGroups.map((group) => [group, "unknown"]),
        ) as Record<TagCoverageGroup, TagCoverageStatus>
      : Object.fromEntries(
          coverageGroups.map((group) => [group, "unknown"]),
        ) as Record<TagCoverageGroup, TagCoverageStatus>;
  const parsed = (r: SurveyRecord) =>
    r.version_id !== null &&
    coverageGroups.every((group) => coverageOf(r)[group] !== "unknown");
  const weekly_tags = Array.from({ length: 12 }, (_, i) => {
    const start = addDays(monday(anchor), (i - 11) * 7),
      end = addDays(start, 6),
      week = all.filter((r) => r.record_date >= start && r.record_date <= end);
    return {
      week_start: start,
      total_records: week.length,
      unparsed_records: week.filter((r) => !parsed(r)).length,
      tags: tags
        .filter((t) => t.active)
        .flatMap((t) => {
          const versionIds = new Set(
            assignments
              .filter((a) => a.tag_id === t.id && a.confirmed)
              .map((a) => a.version_id),
          );
          const count = week.filter(
            (r) => r.version_id && versionIds.has(r.version_id),
          ).length;
          return count
            ? [
                {
                  tag_id: t.id,
                  name: t.name,
                  count,
                  percentage: week.length ? (count / week.length) * 100 : 0,
                },
              ]
            : [];
        }),
    };
  });
  const coverage = Object.fromEntries(
    coverageGroups.map((group) => {
      const counts = { complete: 0, unavailable: 0, unknown: 0 };
      for (const record of records)
        counts[coverageOf(record)[group]]++;
      return [group, counts];
    }),
  ) as Statistics["coverage"];
  return {
    from,
    to,
    group_by: group as "work" | "version",
    total_records: records.length,
    unparsed_records: records.filter((r) => !parsed(r)).length,
    rankings,
    roles,
    weekly_tags,
    coverage,
  };
}
