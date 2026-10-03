import type {
  WorkerEnv,
  ResearchJob,
  CatalogCandidate,
  Version,
} from "../../../shared/contracts";
import { newRow, updated, getRow, now, type Change } from "../store";
import { researchJob } from "../catalog";
import {
  ResearchError,
  linkedRecording,
  knownIdentitySchema,
  norm,
  type Analysis,
} from "./providers";
import { rows, save } from "./state";
/** Publish one recording per invocation, creating its independent metadata job. */
export async function publishCatalog(
  env: WorkerEnv,
  j: ResearchJob,
  a: Analysis,
) {
  if (j.version_id && a.recordings.length !== 1)
    throw new ResearchError("AMBIGUOUS_RECORDING");
  const cursor = j.catalog_cursor ?? 0,
    r = a.recordings[cursor];
  if (!r) throw new ResearchError("INVALID_CATALOG_CURSOR");
  const changes: Change[] = [];
  let v = (
    await rows<Version>(
      env.DB,
      "versions",
      "json_extract(data,'$.reference_url')=?",
      r.reference_url,
    )
  )[0];
  if (j.version_id) {
    v = await getRow(env.DB, "versions", j.version_id);
    if (v.reference_url && v.reference_url !== r.reference_url)
      throw new ResearchError("RECORDING_MISMATCH");
  }
  let original: Version | undefined;
  if (r.original && j.purpose !== "tag_enrichment") {
    original = (
      await rows<Version>(
        env.DB,
        "versions",
        "json_extract(data,'$.reference_url')=?",
        r.original.reference_url,
      )
    )[0];
    if (!original) {
      const w = newRow({ title: r.original.title, manual_lock: false });
      original = newRow({
        work_id: w.id,
        title: r.original.title,
        kind: "original" as const,
        reference_url: r.original.reference_url,
        uploader_entity_id: null,
        research_status: "queued" as const,
        manual_lock: false,
      });
      changes.push(
        { table: "works", before: null, after: w },
        { table: "versions", before: null, after: original },
        { table: "research_jobs", before: null, after: researchJob(original) },
      );
    }
  }
  if (!v) {
    const w = original ? null : newRow({ title: r.title, manual_lock: false });
    v = newRow({
      work_id: original?.work_id ?? w!.id,
      title: r.title,
      kind: r.kind,
      reference_url: r.reference_url,
      uploader_entity_id: null,
      research_status: "running",
      manual_lock: false,
    });
    if (w) changes.push({ table: "works", before: null, after: w });
    changes.push({ table: "versions", before: null, after: v });
  } else if (
    !v.manual_lock &&
    j.purpose !== "tag_enrichment" &&
    j.purpose !== "candidate_lookup"
  ) {
    const next = updated(v, {
      work_id: original?.work_id ?? v.work_id,
      title: r.title,
      kind: r.kind,
      reference_url: r.reference_url,
    });
    changes.push({ table: "versions", before: v, after: next });
    v = next;
  }
  if (
    original &&
    v.manual_lock &&
    v.work_id !== original.work_id &&
    j.purpose !== "candidate_lookup"
  )
    throw new ResearchError("MANUAL_LOCK_RELATIONSHIP");
  const candidate = {
    ...v,
    work_title: r.original?.title ?? r.title,
    credits: [],
  };
  const choices = [...j.candidates, candidate];
  if (!j.version_id) {
    const shared = (
      await rows<ResearchJob>(
        env.DB,
        "research_jobs",
        "json_extract(data,'$.version_id')=?",
        v.id,
      )
    )[0];
    if (!shared || !["queued", "running", "complete"].includes(shared.status)) {
      const values = {
        stage: "metadata" as const,
        evidence: j.evidence,
        analysis: {
          recordings: [r],
          raw_model: a.raw_model,
          review_warnings: a.review_warnings,
        },
        candidates: [candidate],
        metadata_cursor: 0,
        catalog_cursor: 0,
        status: "queued" as const,
        next_attempt_at: now(),
        attempts: 0,
        last_error: null,
        lease_until: null,
      };
      changes.push({
        table: "research_jobs",
        before: shared ?? null,
        after: shared
          ? updated(shared, values)
          : { ...researchJob(v), ...values },
      });
    }
  }
  const last = cursor + 1 === a.recordings.length;
  await save(
    env,
    j,
    {
      catalog_cursor: cursor + 1,
      stage: last ? (j.version_id ? "metadata" : "await_versions") : "catalog",
      candidates: choices,
      metadata_cursor: 0,
    },
    changes,
  );
}
export async function awaitVersions(env: WorkerEnv, j: ResearchJob) {
  const jobs = await rows<ResearchJob>(
    env.DB,
    "research_jobs",
    "json_extract(data,'$.version_id') IN (" +
      j.candidates.map(() => "?").join(",") +
      ")",
    ...j.candidates.map((c) => c.id),
  );
  if (jobs.some((x) => x.status === "queued" || x.status === "running")) {
    await save(env, j, { status: "queued" });
    return;
  }
  if (jobs.some((x) => x.status !== "complete" && x.stage !== "done")) {
    await save(env, j, {
      status: "needs_review",
      last_error: "VERSION_RESEARCH_INCOMPLETE",
    });
    return;
  }
  await finish(env, j);
}
export async function publishClaim(env: WorkerEnv, j: ResearchJob) {
  const a = j.analysis!;
  const tasks = a.recordings.flatMap((r, idx) => [
    { type: "source" as const, r, idx },
    ...r.credits.map((c) => ({ type: "credit" as const, r, idx, c })),
    ...r.tags.map((t) => ({ type: "tag" as const, r, idx, t })),
    { type: "finish" as const, r, idx },
  ]);
  const cursor = j.metadata_cursor ?? 0;
  const task = tasks[cursor];
  if (!task) {
    await finish(env, j);
    return;
  }
  const version = await getRow(env.DB, "versions", j.candidates[task.idx].id);
  const evidence = j.evidence!.find((x) => x.id === task.r.source_id)!;
  const changes: Change[] = [];
  if (task.type === "source") {
    for (const e of j.evidence!.filter((e) =>
      linkedRecording(e, task.r.reference_url),
    )) {
      const existing = (
        await rows<any>(
          env.DB,
          "sources",
          "json_extract(data,'$.version_id')=? AND json_extract(data,'$.url')=?",
          version.id,
          e.url,
        )
      ).find((x) => x.excerpt === e.content);
      if (!existing)
        changes.push({
          table: "sources",
          before: null,
          after: newRow({
            version_id: version.id,
            url: e.url,
            title: e.title,
            excerpt: e.content,
            ...(e.metadata ? { metadata: e.metadata } : {}),
            checked_at: now(),
            origin: "research",
          }),
        });
    }
  }
  if (task.type === "credit" || task.type === "tag") {
    const s = j.evidence!.find(
      (e) =>
        e.id === (task.type === "credit" ? task.c.source_id : task.t.source_id),
    )!;
    const source = (
      await rows<any>(
        env.DB,
        "sources",
        "json_extract(data,'$.version_id')=? AND json_extract(data,'$.url')=?",
        version.id,
        s.url,
      )
    ).find((x) => x.excerpt === s.content);
    if (!source) throw new ResearchError("SOURCE_MISSING");
    if (task.type === "credit") {
      const c = task.c;
      const existing = await rows<any>(
        env.DB,
        "credits",
        "json_extract(data,'$.version_id')=? AND json_extract(data,'$.role')=?",
        version.id,
        c.role,
      );
      // A locked role is settled before entity creation; even a different source
      // spelling must not create a new, unused entity beside an admin correction.
      if (existing.some((x) => x.manual_lock)) {
        await save(env, j, { metadata_cursor: cursor + 1 });
        return;
      }
      const entities = await rows<any>(
        env.DB,
        "entities",
        "json_extract(data,'$.kind')=?",
        c.kind,
      );
      const aliases = await rows<any>(env.DB, "aliases");
      if (entities.length === 60 || aliases.length === 60) {
        await save(env, j, {
          metadata_cursor: cursor + 1,
          analysis: {
            ...a,
            review_warnings: [
              ...(a.review_warnings ?? []),
              "CANONICAL_ENTITY_LOOKUP_BOUND",
            ].slice(0, 24),
          },
        });
        return;
      }
      const matches = entities.filter(
        (e) =>
          norm(e.name) === norm(c.name) ||
          aliases.some(
            (a) => a.entity_id === e.id && norm(a.name) === norm(c.name),
          ),
      );
      if (matches.length > 1) {
        await save(env, j, {
          metadata_cursor: cursor + 1,
          analysis: {
            ...a,
            review_warnings: [
              ...(a.review_warnings ?? []),
              "AMBIGUOUS_CANONICAL_ENTITY",
            ].slice(0, 24),
          },
        });
        return;
      }
      let entity = matches[0];
      if (!entity) {
        entity = newRow({ name: c.name, kind: c.kind, manual_lock: false });
        changes.push({ table: "entities", before: null, after: entity });
      }
      if (!existing.some((x) => x.manual_lock)) {
        const old = existing.find((x) => x.entity_id === entity.id);
        const values = {
          version_id: version.id,
          entity_id: entity.id,
          role: c.role,
          source_id: source.id,
          confirmed: true,
          manual_lock: false,
        };
        changes.push({
          table: "credits",
          before: old ?? null,
          after: old ? updated(old, values) : newRow(values),
        });
      }
      if (
        c.role === "uploader" &&
        !version.manual_lock &&
        !existing.some((x) => x.manual_lock)
      )
        changes.push({
          table: "versions",
          before: version,
          after: updated(version, { uploader_entity_id: entity.id }),
        });
      if (!entity.manual_lock)
        for (const alias of c.aliases) {
          if (
            !(
              await rows<any>(
                env.DB,
                "aliases",
                "json_extract(data,'$.entity_id')=? AND json_extract(data,'$.name')=?",
                entity.id,
                alias.name,
              )
            ).length
          )
            changes.push({
              table: "aliases",
              before: null,
              after: newRow({ entity_id: entity.id, name: alias.name }),
            });
        }
    } else {
      const t = task.t;
      const tag = await getRow(env.DB, "tags", t.tag_id);
      if (!tag.active) throw new ResearchError("TAG_DISABLED");
      const existing = (
        await rows<any>(
          env.DB,
          "tag_assignments",
          "json_extract(data,'$.version_id')=? AND json_extract(data,'$.tag_id')=?",
          version.id,
          t.tag_id,
        )
      )[0];
      if (!existing?.manual_lock) {
        const values = {
          version_id: version.id,
          tag_id: t.tag_id,
          evidence: `AI判定: ${t.reasoning}\n引用: ${t.quote}`,
          source_id: source.id,
          origin: "research",
          confirmed: true,
          manual_lock: false,
        };
        changes.push({
          table: "tag_assignments",
          before: existing ?? null,
          after: existing ? updated(existing, values) : newRow(values),
        });
      }
    }
  }
  if (task.type === "finish") {
    const sources = await rows<any>(
      env.DB,
      "sources",
      "json_extract(data,'$.version_id')=?",
      version.id,
    );
    const result = newRow({
      version_id: version.id,
      model: env.GROQ_MODEL ?? "qwen/qwen3.8-27b",
      dictionary_version: j.dictionary_version,
      analysis_version: j.analysis_version,
      source_ids: sources.map((s) => s.id),
      payload: task.r,
      raw_model: a.raw_model,
      review_warnings: a.review_warnings ?? [],
    });
    changes.push({ table: "research_results", before: null, after: result });
    if (!version.manual_lock)
      changes.push({
        table: "versions",
        before: version,
        after: updated(version, {
          research_status:
            !a.review_warnings?.length &&
            (task.r.kind === "original" || task.r.original)
              ? "complete"
              : "needs_review",
        }),
      });
  }
  await save(env, j, { metadata_cursor: cursor + 1 }, changes);
}
async function finish(env: WorkerEnv, j: ResearchJob) {
  const choices: CatalogCandidate[] = [];
  for (const c of j.candidates) {
    const v = await getRow(env.DB, "versions", c.id);
    const credits = await rows<any>(
      env.DB,
      "credits",
      "json_extract(data,'$.version_id')=?",
      v.id,
    );
    for (const x of credits)
      x.entity_name = (await getRow(env.DB, "entities", x.entity_id)).name;
    choices.push({ ...v, work_title: c.work_title, credits });
  }
  const changes: Change[] = [];
  const single =
    choices.length === 1 &&
    (j.analysis!.recordings[0].kind === "original" ||
      !!j.analysis!.recordings[0].original);
  // Recording identity and metadata review are independent. Rejected secondary
  // claims cannot leave one validated original recording perpetually unresolved.
  const suppliedIdentity =
    j.query?.reference_url &&
    (knownIdentitySchema(j.evidence!, j.query).properties.recordings as any)
      .minItems === 1;
  const approvedIdentity =
    choices.length === 1 && (single || Boolean(suppliedIdentity));
  if (approvedIdentity && j.response_id && j.purpose !== "candidate_lookup") {
    const r = await getRow(env.DB, "responses", j.response_id);
    changes.push({
      table: "responses",
      before: r,
      after: updated(r, { version_id: choices[0].id }),
    });
  }
  await save(
    env,
    j,
    {
      status:
        single && !j.analysis!.review_warnings?.length
          ? "complete"
          : "needs_review",
      candidates:
        approvedIdentity && j.purpose !== "candidate_lookup" ? [] : choices,
      last_error: j.analysis!.review_warnings?.length
        ? "UNCONFIRMED_CLAIMS"
        : single
          ? null
          : approvedIdentity
            ? "CONFIRM_ORIGINAL_RELATIONSHIP"
            : "CONFIRM_RECORDING_OR_ORIGINAL_LINK",
      stage: "done",
    },
    changes,
  );
}
