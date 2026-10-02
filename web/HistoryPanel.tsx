import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogCandidate, Page, Participant, RecordCandidates, RecordUpdate, SongDetail, SurveyRecord } from "../shared/contracts";
import { createApi } from "./api";
import { todayInJapan } from "./dates";
import { newOperationId } from "./storage";
import type { StoredCredential } from "./storage";

type SurveyApi = ReturnType<typeof createApi>;
type Props = { api: SurveyApi; participant?: Participant; credential?: StoredCredential; online: boolean };

export function HistoryPanel({ api, participant, credential, online }: Props) {
  const [records, setRecords] = useState<SurveyRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SurveyRecord>();
  const [recordDate, setRecordDate] = useState("");
  const [searchTitle, setSearchTitle] = useState("");
  const [candidates, setCandidates] = useState<CatalogCandidate[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [candidateStatus, setCandidateStatus] = useState("");
  const [songDetails, setSongDetails] = useState<Record<string, SongDetail>>({});
  const [loadingVersionIds, setLoadingVersionIds] = useState<Set<string>>(new Set());
  const [unavailableVersionIds, setUnavailableVersionIds] = useState<Set<string>>(new Set());
  const requestedVersionIds = useRef(new Set<string>());

  const load = useCallback(async (cursor?: string | null, append = false) => {
    if (!participant) { setRecords([]); return; }
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ participant_id: participant.id, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const data = await api.get<Page<SurveyRecord>>(`/records?${params}`);
      setRecords((current) => append ? [...current, ...data.items] : data.items);
      setNextCursor(data.next_cursor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "履歴を読み込めませんでした。"); }
    finally { setLoading(false); }
  }, [api, participant]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const missing = [...new Set(records.flatMap((record) => record.version_id ? [record.version_id] : []))]
      .filter((versionId) => !requestedVersionIds.current.has(versionId));
    if (!missing.length) return;
    for (const versionId of missing) requestedVersionIds.current.add(versionId);
    setLoadingVersionIds((current) => new Set([...current, ...missing]));
    void Promise.all(missing.map(async (versionId) => {
      try {
        return [versionId, await api.get<SongDetail>(`/catalog/versions/${encodeURIComponent(versionId)}`)] as const;
      } catch {
        return [versionId, undefined] as const;
      }
    })).then((entries) => {
      setSongDetails((current) => ({ ...current, ...Object.fromEntries(entries.filter((entry): entry is readonly [string, SongDetail] => Boolean(entry[1]))) }));
      setUnavailableVersionIds((current) => new Set([...current, ...entries.filter((entry) => !entry[1]).map(([id]) => id)]));
      setLoadingVersionIds((current) => new Set([...current].filter((id) => !missing.includes(id))));
    });
  }, [api, records]);

  function startEdit(record: SurveyRecord) {
    setEditing(record);
    setRecordDate(record.record_date);
    setSearchTitle(record.unresolved_title ?? "");
    setSelectedVersion(record.version_id ?? "");
    setCandidates([]);
    setCandidateStatus("");
    setError("");
  }

  async function loadCandidates(record: SurveyRecord) {
    if (!credential) return;
    setCandidateStatus("確認中…");
    setError("");
    try {
      const data = await api.get<RecordCandidates>(`/records/${encodeURIComponent(record.id)}/candidates`, { token: credential.device_secret });
      setCandidates(data.candidates);
      setCandidateStatus(data.candidates.length ? `${data.candidates.length}件の候補があります。` : "候補はまだ見つかりません。");
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
    if (!editing || !credential) return;
    if (!navigator.onLine) { setError("自分の記録の編集にはインターネット接続が必要です。"); return; }
    setError("");
    try {
      const update: RecordUpdate = {
        operation_id: newOperationId(),
        expected_revision: editing.revision,
        record_date: recordDate,
      };
      if (selectedVersion) update.version_id = selectedVersion;
      else if (searchTitle.trim()) {
        update.version_id = null;
        update.unresolved_title = searchTitle.trim();
      }
      const row = await api.patch<SurveyRecord>(`/records/${encodeURIComponent(editing.id)}`, update, credential.device_secret);
      setRecords((current) => current.map((item) => item.id === row.id ? row : item));
      setEditing(undefined);
      setNotice("自分の記録を更新しました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "記録を更新できませんでした。"); }
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
    <header className="section-heading"><div><p className="eyebrow">記録の振り返り</p><h2>{participant.name}さんの曲の履歴</h2><p>記録日が新しい順です。</p></div>
      {!credential && <span className="read-only-label">閲覧のみ</span>}
    </header>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {notice && <p role="status" className="notice notice-success">{notice}</p>}
    {loading && <p role="status">履歴を読み込んでいます…</p>}
    {records.length ? <div className="history-list">{records.map((record) => {
      const own = Boolean(credential && credential.participant_id === participant.id && credential.participant_id === record.participant_id);
      const song = record.version_id ? songDetails[record.version_id] : undefined;
      const vocalistNames = song ? [...new Set(song.credits.filter((credit) => credit.role === "vocalist").map((credit) => credit.entity.name))] : [];
      const releaseNames = song ? [...new Set(song.credits.filter((credit) => credit.role === "release_name").map((credit) => credit.entity.name))] : [];
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
        {own && <div className="history-actions">
          <button type="button" className="quiet-button" disabled={!online} title={!online ? "接続後に利用できます" : undefined} onClick={() => startEdit(record)}>編集</button>
          <button type="button" className="danger-button" disabled={!online} title={!online ? "接続後に利用できます" : undefined} onClick={() => void deleteRecord(record)}>削除</button>
          {!record.version_id && <button type="button" className="text-button" disabled={!online} title={!online ? "接続後に利用できます" : undefined} onClick={() => void loadCandidates(record)}>候補を確認</button>}
        </div>}
        {own && editing?.id === record.id && <form className="editor-form history-editor" onSubmit={saveEdit}>
          <h4>記録を編集</h4>
          <label>記録日<input type="date" value={recordDate} max={todayInJapan()} onChange={(event) => setRecordDate(event.target.value)} required /></label>
          {!record.version_id && <>
            <label>曲名<input value={searchTitle} maxLength={240} onChange={(event) => setSearchTitle(event.target.value)} /></label>
            <div className="button-row"><button type="button" className="secondary-button" onClick={() => void searchCatalog()}>候補を探す</button><span role="status">{candidateStatus}</span></div>
            {candidates.map((candidate) => <button type="button" className={`candidate-card${selectedVersion === candidate.id ? " candidate-selected" : ""}`} aria-pressed={selectedVersion === candidate.id} key={candidate.id} onClick={() => setSelectedVersion(candidate.id)}>{candidate.work_title} · {candidate.title}</button>)}
          </>}
          <div className="button-row"><button className="primary-button" type="submit">記録を保存</button><button type="button" className="quiet-button" onClick={() => setEditing(undefined)}>閉じる</button></div>
        </form>}
      </article>;
    })}</div> : !loading && <p className="empty-state">この参加者の回答はまだありません。</p>}
    {nextCursor && <button type="button" className="secondary-button" disabled={loading} onClick={() => void load(nextCursor, true)}>履歴をもっと読み込む</button>}
  </section>;
}
