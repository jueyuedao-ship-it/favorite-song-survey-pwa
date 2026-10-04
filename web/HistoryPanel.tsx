import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogCandidate,
  Page,
  Participant,
  RecordCandidates,
  RecordUpdate,
  SongDetail,
  SurveyRecord,
  TagCoverageGroup,
} from "../shared/contracts";
import { createApi } from "./api";
import { todayInJapan } from "./dates";
import { newOperationId } from "./storage";
import type { StoredCredential } from "./storage";
import { useVisibleRefresh } from "./useVisibleRefresh";
import { SongTagEditor, type SongTagDraft } from "./SongTagEditor";

type SurveyApi = ReturnType<typeof createApi>;
type Props = { api: SurveyApi; participant?: Participant; credential?: StoredCredential; online: boolean };

const coverageLabels: Record<TagCoverageGroup, string> = {
  genre_sound: "ジャンル・音作り",
  mood_energy_tempo: "雰囲気・勢い・テンポ",
  voice: "歌声",
  lyric_theme: "歌詞テーマ",
};
const coverageStatusLabels = {
  complete: "完了",
  unavailable: "取得不可",
  unknown: "未調査",
} as const;
const qualityLabels = {
  official: "公式",
  platform: "配信/動画プラットフォーム",
  editorial: "解説記事",
  community: "コミュニティ",
  unknown: "品質未分類",
} as const;

export function HistoryPanel({ api, participant, credential, online }: Props) {
  const [records, setRecords] = useState<SurveyRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SurveyRecord>();
  const [editSession, setEditSession] = useState(0);
  const [saving, setSaving] = useState(false);
  const editSessionRef = useRef(editSession);
  editSessionRef.current = editSession;
  const [tagDraft, setTagDraft] = useState<SongTagDraft>();
  const [recordDate, setRecordDate] = useState("");
  const [searchTitle, setSearchTitle] = useState("");
  const [candidates, setCandidates] = useState<CatalogCandidate[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [candidateStatus, setCandidateStatus] = useState("");
  const [research, setResearch] = useState<RecordCandidates>();
  const [researchBusy, setResearchBusy] = useState<"tags" | "candidates" | null>(null);
  const researchGeneration = useRef(0);
  const researchRequestId = useRef(0);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [songDetails, setSongDetails] = useState<Record<string, SongDetail>>({});
  const [loadingVersionIds, setLoadingVersionIds] = useState<Set<string>>(new Set());
  const [unavailableVersionIds, setUnavailableVersionIds] = useState<Set<string>>(new Set());
  const loadedPages = useRef(1);
  const recordGeneration = useRef(0);
  const scopeSignal = useRef<AbortSignal | undefined>(undefined);
  const detailIds = useRef(new Set<string>());
  const participantId = participant?.id;

  const load = useCallback(async (cursor?: string | null, append = false, signal = scopeSignal.current) => {
    const generation = ++recordGeneration.current;
    const current = () => !signal?.aborted && generation === recordGeneration.current;
    if (!participantId) { setRecords([]); return; }
    setLoading(true);
    setError("");
    try {
      let next = cursor ?? null;
      const items: SurveyRecord[] = [];
      const pageCount = append ? 1 : loadedPages.current;
      for (let i = 0; i < pageCount; i++) {
        const params = new URLSearchParams({ participant_id: participantId, limit: "100" });
        if (next) params.set("cursor", next);
        const data = await api.get<Page<SurveyRecord>>(`/records?${params}`, { signal });
        if (!current()) return;
        items.push(...data.items);
        next = data.next_cursor;
        if (!next) break;
      }
      if (append) loadedPages.current++;
      setRecords((prior) => append ? [...prior.filter((r) => !items.some((item) => item.id === r.id)), ...items] : items);
      setNextCursor(next);
      const ids = [...new Set(items.flatMap((record) => record.version_id ? [record.version_id] : []))]
        .filter((id) => !append || !detailIds.current.has(id));
      setLoadingVersionIds(new Set(ids));
      const entries = await Promise.all(ids.map(async (id) => {
        try { return [id, await api.get<SongDetail>(`/catalog/versions/${encodeURIComponent(id)}`, { signal })] as const; }
        catch { return [id, undefined] as const; }
      }));
      if (!current()) return;
      for (const [id, detail] of entries) { if (detail) detailIds.current.add(id); else detailIds.current.delete(id); }
      setSongDetails((prior) => {
        const next = { ...prior };
        for (const [id, detail] of entries) { if (detail) next[id] = detail; else delete next[id]; }
        return next;
      });
      setUnavailableVersionIds((prior) => {
        const next = new Set(prior);
        for (const [id, detail] of entries) { if (detail) next.delete(id); else next.add(id); }
        return next;
      });
      setLoadingVersionIds(new Set());
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "履歴を読み込めませんでした。"); }
    finally { if (current()) setLoading(false); }
  }, [api, participantId]);

  useEffect(() => {
    loadedPages.current = 1;
    detailIds.current.clear();
    setEditing(undefined);
    setRecords([]);
    setSongDetails({});
  }, [api, participantId]);
  const refresh = useCallback(async (signal: AbortSignal) => {
    scopeSignal.current = signal;
    await load(undefined, false, signal);
  }, [load]);
  useVisibleRefresh(refresh);
  const researchRecordId = editing?.id;
  const researchRevision = editing?.revision;
  const refreshResearch = useCallback(async (signal: AbortSignal) => {
    if (!researchRecordId || !credential) return;
    const generation = ++researchGeneration.current;
    try {
      const data = await api.get<RecordCandidates>(`/records/${encodeURIComponent(researchRecordId)}/candidates`, { token: credential.device_secret, signal });
      if (signal.aborted || generation !== researchGeneration.current) return;
      setResearch(data);
      if (data.purpose === "candidate_lookup") setCandidates(data.candidates);
    } catch (reason) { if (!signal.aborted && generation === researchGeneration.current) setError(reason instanceof Error ? reason.message : "調査状況を確認できませんでした。"); }
  }, [api, credential, researchRecordId, researchRevision]);
  useVisibleRefresh(refreshResearch, Boolean(researchRecordId && credential && online));

  async function startResearch(kind: "tags" | "candidates") {
    if (!editing || !credential || researchBusy || !online) return;
    ++researchGeneration.current;
    const requestId = ++researchRequestId.current;
    const scope = editing;
    const current = () => researchRequestId.current === requestId && editingRef.current?.id === scope.id && editingRef.current?.revision === scope.revision;
    setResearchBusy(kind); setError("");
    try {
      const data = await api.post<RecordCandidates>(`/records/${encodeURIComponent(editing.id)}/research`, {
        operation_id: newOperationId(), expected_revision: editing.revision, kind,
        ...(kind === "candidates" ? { title: searchTitle.trim() } : {}),
      }, credential.device_secret);
      if (!current()) return;
      setResearch(data);
      if (kind === "candidates") { setCandidates(data.candidates); setCandidateStatus("Webで曲候補を調べています。結果はこの編集欄に反映されます。"); }
      setNotice(kind === "tags" ? "タグ調査を予約しました。結果は順次反映されます。" : "曲候補の再検索を予約しました。保存済みの回答は保持しています。");
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "調査を開始できませんでした。"); }
    finally { if (current()) setResearchBusy(null); }
  }
  function researchLabel(status?: RecordCandidates["status"] | null): string {
    return status === "queued" || status === "running" ? "調査中" : status === "complete" ? "完了" : status === "needs_review" || status === "failed" ? "確認が必要" : "未開始";
  }

  function startEdit(record: SurveyRecord) {
    setEditSession(value => value + 1);
    setTagDraft(undefined);
    ++researchRequestId.current;
    setResearch(undefined); setResearchBusy(null); ++researchGeneration.current;
    setEditing(record);
    setRecordDate(record.record_date);
    setSearchTitle(record.version_id ? songDetails[record.version_id]?.version.title ?? record.unresolved_title ?? "" : record.unresolved_title ?? "");
    setSelectedVersion(record.version_id ?? "");
    setCandidates([]);
    setCandidateStatus("");
    setError("");
  }

  async function loadCandidates(record: SurveyRecord) {
    setEditSession(value => value + 1);
    setTagDraft(undefined);
    ++researchRequestId.current;
    if (!credential) return;
    setCandidateStatus("確認中…");
    setError("");
    try {
      const data = await api.get<RecordCandidates>(`/records/${encodeURIComponent(record.id)}/candidates`, { token: credential.device_secret });
      setCandidates(data.candidates);
      setCandidateStatus(data.candidates.length ? `${data.candidates.length}件の候補があります。`
        : data.status === "needs_review" || data.status === "failed"
          ? "調査が停止しています。待つだけでは再開しません。管理者に確認・再試行を依頼してください。"
          : "候補はまだ見つかりません。");
      setEditing(record);
      setRecordDate(record.record_date);
      setSearchTitle(record.unresolved_title ?? "");
      setSelectedVersion("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "候補を確認できませんでした。"); }
  }

  async function searchCatalog() {
    if (!searchTitle.trim()) return;
    setError("");
    try {
      const params = new URLSearchParams({ q: searchTitle.trim(), limit: "20" });
      const data = await api.get<Page<CatalogCandidate>>(`/catalog/search?${params}`);
      setCandidates(data.items);
      setCandidateStatus(data.items.length ? `${data.items.length}件の候補があります。` : "一致する候補はありません。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "曲候補を読み込めませんでした。"); }
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !credential || saving) return;
    if (!navigator.onLine) { setError("自分の記録の編集にはインターネット接続が必要です。"); return; }
    const scope = editing, session = editSession;
    const current = () => editingRef.current?.id === scope.id && editingRef.current?.revision === scope.revision && editSessionRef.current === session;
    setSaving(true);
    setError("");
    try {
      const update: RecordUpdate = {
        operation_id: newOperationId(),
        expected_revision: editing.revision,
        record_date: recordDate,
      };
      if (tagDraft?.changes.length && tagDraft.version_id === selectedVersion) {
        update.tag_version_id = tagDraft.version_id;
        update.tag_changes = tagDraft.changes;
      }
      const unchanged = selectedVersion === (editing.version_id ?? "") && (Boolean(selectedVersion) || searchTitle.trim() === (editing.unresolved_title ?? ""));
      if (!unchanged && selectedVersion) {
        update.version_id = selectedVersion;
        update.unresolved_title = null;
        update.artist_hint = null;
        update.reference_url = null;
      } else if (!selectedVersion && searchTitle.trim()) {
        update.version_id = null;
        update.unresolved_title = searchTitle.trim();
        if (!unchanged) { update.artist_hint = null; update.reference_url = null; }
      } else if (!selectedVersion) {
        setError("未特定として保存する曲名を入力してください。");
        return;
      }
      const row = await api.patch<SurveyRecord>(`/records/${encodeURIComponent(editing.id)}`, update, credential.device_secret);
      setRecords((current) => current.map((item) => item.id === row.id ? row : item));
      if (!current()) return;
      setEditing(undefined);
      setNotice(row.version_id && row.version_id !== editing.version_id ? "自分の記録を更新しました。選んだ版のタグ調査を開始・継続します。" : "自分の記録を更新しました。");
      void load();
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : "記録を更新できませんでした。"); }
    finally { setSaving(false); }
  }

  async function deleteRecord(record: SurveyRecord) {
    if (!credential) return;
    if (!navigator.onLine) { setError("自分の記録の削除にはインターネット接続が必要です。"); return; }
    setError("");
    try {
      const row = await api.delete<SurveyRecord>(`/records/${encodeURIComponent(record.id)}`, { operation_id: newOperationId(), expected_revision: record.revision }, credential.device_secret);
      setRecords((current) => current.filter((item) => item.id !== row.id));
      setNotice("記録を削除しました。変更履歴には残ります。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "記録を削除できませんでした。"); }
  }

  if (!participant) return <section className="content-panel empty-state"><h2>自分の記録</h2><p>表示する参加者を選んでください。</p></section>;
  return <section className="content-panel history-panel">
    <header className="section-heading"><div><p className="eyebrow">記録の振り返り</p><h2>{participant.name}さんの曲の履歴</h2><p>保存された記録を一覧表示します。表示順は記録日順ではありません。</p></div>
      {!credential && <span className="read-only-label">閲覧のみ</span>}
    </header>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {notice && <p role="status" className="notice notice-success">{notice}</p>}
    {loading && <p role="status">履歴を読み込んでいます…</p>}
    {(records.length || editing) ? <div className="history-list">{(editing && !records.some((r) => r.id === editing.id) ? [...records, editing] : records).map((record) => {
      const own = Boolean(credential && credential.participant_id === participant.id && credential.participant_id === record.participant_id);
      const song = record.version_id ? songDetails[record.version_id] : undefined;
      const vocalistNames = song ? [...new Set(song.credits.filter((credit) => credit.role === "vocalist").map((credit) => `${credit.entity.name}${credit.confirmed ? "" : "（未確認）"}`))] : [];
      const releaseNames = song ? [...new Set(song.credits.filter((credit) => credit.role === "release_name").map((credit) => `${credit.entity.name}${credit.confirmed ? "" : "（未確認）"}`))] : [];
      const creditSummary = [
        vocalistNames.length ? `ボーカル: ${vocalistNames.join("・")}` : "",
        releaseNames.length ? `発表名義: ${releaseNames.join("・")}` : "",
      ].filter(Boolean).join(" · ");
      const identifiedTitle = song
        ? [...new Set([song.work.title, song.version.title].filter(Boolean))].join(" · ")
        : record.version_id
          ? unavailableVersionIds.has(record.version_id) && !loadingVersionIds.has(record.version_id) ? "曲情報を取得できませんでした" : "曲情報を読み込んでいます…"
          : "曲名未入力";
      const displayTitle = song
        ? identifiedTitle || record.unresolved_title || "曲情報を取得できませんでした"
        : record.unresolved_title ?? identifiedTitle;
      return <article className="history-card" key={record.id}>
        <div className="history-date"><span>{record.record_date}</span><span className="music-mark" aria-hidden="true">♪</span></div>
        <div className="history-song"><h3>{displayTitle}</h3>
          {record.artist_hint && <p>{record.artist_hint}</p>}
          {creditSummary && <p>{creditSummary}</p>}
          {record.reference_url && <a href={record.reference_url} target="_blank" rel="noreferrer">参照ページを開く</a>}
          {record.version_id && <span className="version-pill">曲が特定済み</span>}
        </div>
        {song && <section className="tag-evidence-panel" aria-label="タグと調査根拠">
          <div className="tag-coverage-row">
            {(Object.keys(coverageLabels) as TagCoverageGroup[]).map((group) => (
              <span className={`coverage-pill coverage-${song.tag_coverage?.[group] ?? "unknown"}`} key={group}>
                {coverageLabels[group]}: {coverageStatusLabels[song.tag_coverage?.[group] ?? "unknown"]}
              </span>
            ))}
          </div>
          {song.tags.length ? <div className="tag-evidence-list">
            {song.tags.map((assignment) => {
              const source = song.sources.find(
                (item) =>
                  item.id ===
                  (assignment.source_id ?? assignment.automatic_source_id),
              );
              const manual =
                assignment.manual_override === "force_on" ||
                assignment.manual_override === "force_off" ||
                assignment.manual_lock;
              const evidenceType =
                assignment.automatic_evidence_type === "direct"
                  ? "direct"
                  : assignment.automatic_evidence_type === "semantic_inference"
                    ? "semantic"
                    : null;
              return <details className="tag-evidence-item" key={assignment.id}>
                <summary>
                  <span>{assignment.tag.name}</span>
                  <small>{manual ? "手動" : "自動"}{evidenceType ? ` · ${evidenceType}` : ""}</small>
                </summary>
                <p>{assignment.evidence}</p>
                {manual && assignment.automatic_evidence && (
                  <p className="muted-note">
                    自動判定の根拠: {assignment.automatic_evidence}
                  </p>
                )}
                {source && <p className="tag-source-meta">
                  <span>{qualityLabels[source.quality_tier ?? "unknown"]}</span>
                  <span>{source.quality_reason ?? "品質区分の理由は未記録"}</span>
                  <span>確認: {new Date(source.checked_at).toLocaleString("ja-JP")}</span>
                  <a href={source.url} target="_blank" rel="noreferrer">{source.title || "参照元を開く"}</a>
                </p>}
              </details>;
            })}
          </div> : <p className="muted-note">現在有効なタグはありません。</p>}
        </section>}
        {own && <div className="history-actions">
          <button type="button" className="quiet-button" disabled={!online} title={!online ? "接続後に利用できます" : undefined} onClick={() => startEdit(record)}>編集</button>
          <button type="button" className="danger-button" disabled={!online} title={!online ? "接続後に利用できます" : undefined} onClick={() => void deleteRecord(record)}>削除</button>
          {!record.version_id && <button type="button" className="text-button" disabled={!online} title={!online ? "接続後に利用できます" : undefined} onClick={() => void loadCandidates(record)}>候補を確認</button>}
        </div>}
        {own && editing?.id === record.id && <form className="editor-form history-editor" onSubmit={saveEdit}>
          <fieldset className="edit-saving-controls" disabled={saving}>
          <h4>記録を編集</h4>
          <label>記録日<input type="date" value={recordDate} max={todayInJapan()} onChange={(event) => setRecordDate(event.target.value)} required /></label>
          <>
            <div className="button-row">
              <button type="button" className="quiet-button" aria-pressed={selectedVersion === (editing.version_id ?? "")} onClick={() => { setSelectedVersion(editing.version_id ?? ""); setSearchTitle(editing.version_id ? songDetails[editing.version_id]?.version.title ?? editing.unresolved_title ?? "" : editing.unresolved_title ?? ""); }}>現在の曲を保持</button>
              <button type="button" className="quiet-button" aria-pressed={!selectedVersion} onClick={() => setSelectedVersion("")}>未特定の曲名に切り替える</button>
            </div>
            <label>曲名<input value={searchTitle} maxLength={240} onChange={(event) => { setSearchTitle(event.target.value); setSelectedVersion(""); setCandidates([]); }} required={!selectedVersion} /></label>
            <p className="muted-note">{selectedVersion ? "選択した版を保存します。" : "入力した曲名を未特定として保存します。"} 曲を変更すると以前の歌手補足・参照URLは解除されます。</p>
            <div className="button-row"><button type="button" className="secondary-button" onClick={() => void searchCatalog()}>候補を探す</button><span role="status">{candidateStatus}</span></div>
            <div className="button-row">
              <button type="button" className="secondary-button" disabled={!online || Boolean(researchBusy) || !editing.version_id || selectedVersion !== editing.version_id || research?.tag_status === "queued" || research?.tag_status === "running"} onClick={() => void startResearch("tags")}>タグ調査開始</button>
              <button type="button" className="secondary-button" disabled={!online || Boolean(researchBusy) || !searchTitle.trim() || research?.lookup_status === "queued" || research?.lookup_status === "running"} onClick={() => void startResearch("candidates")}>曲候補を再検索</button>
            </div>
            <p className="muted-note">タグ調査は保存済みの曲の版が対象です。候補を選んで保存すると自動でも開始します。候補の再検索はWebで調べ直し、回答は選び直して保存するまで保持します。</p>
            <p role="status">タグ調査：{researchLabel(research?.tag_status)} · 候補再検索：{researchLabel(research?.lookup_status)}</p>
            {research?.tag_last_error && <p className="muted-note">タグ調査に確認が必要です。根拠が不足した場合はタグを付けずに結果を残します。</p>}
            {candidates.map((candidate) => <button type="button" className={`candidate-card${selectedVersion === candidate.id ? " candidate-selected" : ""}`} aria-pressed={selectedVersion === candidate.id} key={candidate.id} onClick={() => setSelectedVersion(candidate.id)}>{candidate.work_title} · {candidate.title}</button>)}
          </>
          {credential && <SongTagEditor key={`${editing.id}:${editing.revision}:${editSession}`} api={api} record={editing} selectedVersion={selectedVersion} token={credential.device_secret} online={online} onDraftChange={setTagDraft} />}
          <div className="button-row"><button className="primary-button" type="submit" disabled={!online}>{saving ? "保存中…" : "記録を保存"}</button><button type="button" className="quiet-button" onClick={() => setEditing(undefined)}>閉じる</button></div>
          </fieldset>
        </form>}
      </article>;
    })}</div> : !loading && <p className="empty-state">この参加者の回答はまだありません。</p>}
    {nextCursor && <button type="button" className="secondary-button" disabled={loading} onClick={() => void load(nextCursor, true)}>履歴をもっと読み込む</button>}
  </section>;
}
