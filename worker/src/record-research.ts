import type {
  WorkerEnv,
  ResearchJob,
  SurveyRecord,
  Version,
  RecordCandidates,
} from "../../shared/contracts";
import { ownerOrAdmin } from "./auth";
import { researchJob, ownRecord, catalogUrl } from "./catalog";
import { activeTags, tagDictionaryFingerprint } from "./tags";
import {
  allRows,
  getRow,
  updated,
  now,
  bodyOf,
  requireKeys,
  expectRevision,
  replyMutation,
  check,
  invalid,
  conflict,
  text,
  type Change,
} from "./store";

const pending = (j?: ResearchJob) =>
  j && !j.deleted_at && ["queued", "running"].includes(j.status);
const normalized = (s: string) =>
  s.normalize("NFKC").toLocaleLowerCase("ja").trim();
function lookupFor(jobs: ResearchJob[], responseId: string) {
  return (
    jobs.find((j) => j.response_id === responseId && !j.deleted_at) ??
    jobs
      .filter((j) => j.response_id === responseId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  );
}
const reset = () => ({
  analysis_version: "2",
  stage: "search" as const,
  evidence: [],
  analysis: undefined,
  raw_model: undefined,
  descriptive_status: undefined,
  descriptive_source_ids: undefined,
  descriptive_category: undefined,
  descriptive_coverage: undefined,
  catalog_cursor: 0,
  metadata_cursor: 0,
  metadata_source_cursor: 0,
  candidates: [],
  status: "queued" as const,
  attempts: 0,
  last_error: null,
  lease_until: null,
  next_attempt_at: now(),
  deleted_at: null,
});

export async function queueTagResearch(
  env: WorkerEnv,
  version: Version,
  changes: Change[],
  automatic: boolean,
  previous?: SurveyRecord,
) {
  const jobs = await allRows(env.DB, "research_jobs", false);
  const dictionaryVersion = tagDictionaryFingerprint(await activeTags(env.DB));
  const existing = jobs.find((j) => j.version_id === version.id);
  if (
    pending(existing) ||
    (automatic &&
      existing &&
      !existing.deleted_at &&
      existing.status === "complete" &&
      existing.analysis_version === "2" &&
      existing.dictionary_version === dictionaryVersion)
  )
    return;
  const lookup = previous ? lookupFor(jobs, previous.id) : undefined;
  const proposed =
    previous?.unresolved_title ??
    lookup?.query?.title ??
    existing?.query?.title;
  const title =
    proposed && normalized(version.title).includes(normalized(proposed))
      ? proposed
      : version.title;
  const query = {
    title,
    artist_hint:
      title === proposed
        ? (previous?.artist_hint ??
          lookup?.query?.artist_hint ??
          existing?.query?.artist_hint ??
          null)
        : null,
    reference_url: version.reference_url,
  };
  const values = {
    ...reset(),
    analysis_version: "2",
    purpose: "tag_enrichment" as const,
    query,
    dictionary_version: dictionaryVersion,
    response_revision: undefined,
  };
  const after = existing
    ? updated(existing, values)
    : { ...researchJob(version), ...values };
  changes.push({ table: "research_jobs", before: existing ?? null, after });
  if (!version.manual_lock)
    changes.push({
      table: "versions",
      before: version,
      after: updated(version, { research_status: "queued" }),
    });
}

export async function recordResearchStatus(
  env: WorkerEnv,
  row: SurveyRecord,
): Promise<RecordCandidates> {
  const jobs = await allRows(env.DB, "research_jobs");
  const lookup = jobs.find((j) => j.response_id === row.id);
  const tags = row.version_id
    ? jobs.find((j) => j.version_id === row.version_id)
    : undefined;
  return {
    response_id: row.id,
    status: lookup?.status ?? tags?.status ?? "unconfirmed",
    candidates: lookup?.candidates ?? tags?.candidates ?? [],
    last_error: lookup?.last_error ?? tags?.last_error ?? null,
    lookup_status: lookup?.status ?? null,
    tag_status: tags?.status ?? null,
    tag_last_error: tags?.last_error ?? null,
    purpose: lookup?.purpose,
  };
}

export async function requestRecordResearch(
  request: Request,
  env: WorkerEnv,
  id: string,
) {
  const actor = await ownerOrAdmin(request, env),
    body = await bodyOf(request);
  requireKeys(body, ["operation_id", "expected_revision", "kind", "title"]);
  if (!["tags", "candidates"].includes(body.kind)) invalid();
  return replyMutation(
    env,
    actor,
    `POST:/records/${id}/research`,
    body,
    async () => {
      const row = await getRow(env.DB, "responses", id);
      ownRecord(actor, row);
      expectRevision(row, body);
      const changes: Change[] = [];
      if (body.kind === "tags") {
        if (!row.version_id)
          invalid("候補を選んで記録を保存してからタグを調査してください。");
        const version = await getRow(env.DB, "versions", row.version_id!);
        await queueTagResearch(env, version, changes, false, row);
      } else {
        const jobs = await allRows(env.DB, "research_jobs", false);
        const existing = lookupFor(jobs, row.id);
        const version = row.version_id
          ? await getRow(env.DB, "versions", row.version_id)
          : null;
        let title = text(body.title ?? row.unresolved_title ?? version?.title);
        if (
          version &&
          title === version.title &&
          existing?.query?.title &&
          normalized(version.title).includes(normalized(existing.query.title))
        )
          title = existing.query.title;
        const query = {
          title,
          artist_hint: row.artist_hint ?? existing?.query?.artist_hint ?? null,
          reference_url: null,
        };
        if (pending(existing)) {
          if (JSON.stringify(existing!.query) !== JSON.stringify(query))
            conflict("候補を調査中です。完了後に再検索してください。");
        } else {
          const values = {
            ...reset(),
            query,
            purpose: "candidate_lookup" as const,
            response_revision: row.revision,
          };
          changes.push({
            table: "research_jobs",
            before: existing ?? null,
            after: existing
              ? updated(existing, values)
              : { ...researchJob(null, row), ...values },
          });
        }
      }
      const status = await recordResearchStatus(env, row);
      for (const change of changes.filter((c) => c.table === "research_jobs")) {
        const job = change.after as ResearchJob;
        if (job.version_id) {
          status.tag_status = job.status;
          status.tag_last_error = null;
        } else {
          status.lookup_status = job.status;
          status.status = job.status;
          status.candidates = [];
          status.last_error = null;
          status.purpose = job.purpose;
        }
      }
      return {
        data: status,
        changes,
        guards: [
          check(
            env.DB,
            "EXISTS(SELECT 1 FROM responses WHERE id=? AND revision=? AND json_extract(data,'$.deleted_at') IS NULL)",
            row.id,
            row.revision,
          ),
        ],
      };
    },
  );
}
