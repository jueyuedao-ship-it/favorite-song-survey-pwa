import { useState } from "react";
import type { CatalogCandidate, Participant, RecordCreate, ResearchStatus } from "../shared/contracts";
import { todayInJapan } from "./dates";
import type { PendingRegistration, StoredCredential } from "./storage";
import type { createApi } from "./api";

type SurveyApi = ReturnType<typeof createApi>;
type Props = {
  api: SurveyApi;
  selectedParticipant?: Participant;
  credential?: StoredCredential;
  pendingCount: number;
  online: boolean;
  pendingRegistration?: PendingRegistration;
  onCreateGuest: (name: string, deviceLabel: string) => Promise<void>;
  onRetryRegistration: () => Promise<void>;
  onSubmit: (record: Omit<RecordCreate, "operation_id" | "participant_id">, songTitle?: string) => Promise<"cloud" | "queued">;
  onAddDevice: () => Promise<void>;
};

function kindName(kind: string): string {
  return ({ original: "原曲", cover: "カバー", remix: "リミックス", other: "その他" } as Record<string, string>)[kind] ?? kind;
}

function researchStatusName(status: ResearchStatus): string {
  return ({
    unconfirmed: "未確認",
    queued: "情報確認中",
    running: "情報確認中",
    complete: "情報確認済み",
    failed: "調査に失敗しました",
    needs_review: "要確認",
  } as Record<ResearchStatus, string>)[status];
}

export function AnswerPanel({ api, selectedParticipant, credential, pendingCount, online, pendingRegistration, onCreateGuest, onRetryRegistration, onSubmit, onAddDevice }: Props) {
  const [name, setName] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("この端末");
  const [showRegistration, setShowRegistration] = useState(false);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [recordDate, setRecordDate] = useState(todayInJapan());
  const [candidates, setCandidates] = useState<CatalogCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CatalogCandidate>();
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function searchCatalog() {
    if (!title.trim()) {
      setError("曲名を入力してください。");
      return;
    }
    setSearching(true);
    setError("");
    setSelectedCandidate(undefined);
    try {
      const params = new URLSearchParams({ q: title.trim(), limit: "20" });
      const page = await api.get<{ items: CatalogCandidate[]; next_cursor: string | null }>(`/catalog/search?${params}`);
      setCandidates(page.items);
      if (!page.items.length) setMessage("一致する候補はありません。未特定として回答できます。");
      else setMessage("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "曲候補を読み込めませんでした。");
    } finally { setSearching(false); }
  }

  async function submitResolved() {
    if (!selectedCandidate) return;
    setSubmitting(true);
    setError("");
    try {
      const delivery = await onSubmit({ version_id: selectedCandidate.id, record_date: recordDate }, `${selectedCandidate.work_title} · ${selectedCandidate.title}`);
      setTitle("");
      setArtist("");
      setReferenceUrl("");
      setCandidates([]);
      setSelectedCandidate(undefined);
      setMessage(delivery === "cloud" ? "クラウドに保存しました。" : "端末内に保存しました。クラウドにはまだ反映されていません。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "回答を送信できませんでした。"); }
    finally { setSubmitting(false); }
  }

  async function submitUnresolved() {
    if (!title.trim()) { setError("曲名を入力してください。"); return; }
    setSubmitting(true);
    setError("");
    try {
      const delivery = await onSubmit({ version_id: null, record_date: recordDate, unresolved_title: title.trim(), artist_hint: artist.trim() || null, reference_url: referenceUrl.trim() || null });
      setTitle("");
      setArtist("");
      setReferenceUrl("");
      setCandidates([]);
      setSelectedCandidate(undefined);
      setMessage(delivery === "cloud" ? "クラウドに保存しました。" : "端末内に保存しました。クラウドにはまだ反映されていません。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "回答を送信できませんでした。"); }
    finally { setSubmitting(false); }
  }

  return <section className="answer-layout">
    <div className="answer-card content-panel">
      <div className="section-heading">
        <div><p className="eyebrow">今日の気分を記録</p><h2>最近ハマった曲は？</h2><p className="panel-intro">曲名から探すか、見つからない曲として記録できます。</p></div>
        <span className="record-disc" aria-hidden="true"><span>♪</span></span>
      </div>

      {!credential && <section className="identity-card">
        {pendingRegistration ? <>
          <h3>端末登録の再試行</h3>
          <p>サーバー応答が確認できていないため、保存した同じ登録要求を再送します。資格情報や操作IDは作り直しません。</p>
          {pendingRegistration.kind === "create" ? <div className="registration-form">
            <label>お名前<input value={pendingRegistration.request.name} disabled /></label>
            <label>端末の呼び名<input value={pendingRegistration.request.device_label} disabled /></label>
            <button className="primary-button" type="button" onClick={() => { setError(""); void onRetryRegistration().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "登録を再試行できませんでした。")); }}>登録を再試行</button>
          </div> : <button className="primary-button" type="button" onClick={() => { setError(""); void onRetryRegistration().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "招待登録を再試行できませんでした。")); }}>招待登録を再試行</button>}
        </> : <>
          {selectedParticipant ? <><h3>{selectedParticipant.name}さんの回答端末</h3><p>名前の切り替えだけでは編集権限は付きません。招待リンクで本人の端末を登録するか、新しい名前で参加できます。</p></>
            : <><h3>はじめての回答</h3><p>参加者名と、この端末だけが使う本人確認情報を登録します。</p></>}
          {!showRegistration ? <button className="secondary-button" type="button" onClick={() => setShowRegistration(true)}>新しく参加する</button>
            : <form className="registration-form" onSubmit={(event) => { event.preventDefault(); setError(""); void onCreateGuest(name.trim(), deviceLabel.trim() || "この端末").catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "参加登録できませんでした。")); }}>
            <label>お名前<input autoComplete="nickname" maxLength={80} required value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>端末の呼び名<input maxLength={80} value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} /></label>
            <div className="button-row"><button className="primary-button" type="submit">参加登録</button><button className="quiet-button" type="button" onClick={() => setShowRegistration(false)}>戻る</button></div>
          </form>}
        </>}
      </section>}

      {credential && <div className="identity-banner"><span className="status-dot" />
        <div><strong>{credential.participant.name}さんの本人端末</strong><span>閲覧名とは別に保存されています。</span></div>
        <button type="button" className="quiet-button" onClick={() => { setError(""); void onAddDevice().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "招待を作成できませんでした。")); }}>別の端末を追加</button>
      </div>}

      <div className="composer-form">
        <label>曲名<input aria-label="曲名" value={title} maxLength={240} placeholder="例：曲名や動画タイトル" onChange={(event) => { setTitle(event.target.value); setSelectedCandidate(undefined); setMessage(""); }} /></label>
        <button type="button" className="secondary-button search-song" disabled={searching || !title.trim()} onClick={() => void searchCatalog()}>{searching ? "候補を探しています…" : "曲を検索"}</button>
        {candidates.length > 1 && <p className="candidate-count" role="status">同名の候補が{candidates.length}件あります。作品と歌唱版を確認してください。</p>}
        {candidates.length > 0 && <div className="candidate-list" aria-label="曲候補">
          {candidates.map((candidate) => {
            const creditNames = candidate.credits.filter((credit) => credit.entity_name).map((credit) => `${credit.entity_name}${credit.confirmed ? "" : "（未確認）"}`);
            return <button type="button" key={candidate.id} className={`candidate-card${selectedCandidate?.id === candidate.id ? " candidate-selected" : ""}`} aria-pressed={selectedCandidate?.id === candidate.id} onClick={() => { setSelectedCandidate(candidate); setMessage(""); }}>
              <span className="candidate-title">{candidate.work_title}</span>
              <span className="candidate-version">{candidate.title} · {kindName(candidate.kind)}</span>
              <span className="candidate-credits">{creditNames.length ? creditNames.join("・") : "確認済みクレジットなし"}</span>
              <span className="candidate-status">{researchStatusName(candidate.research_status)}</span>
            </button>;
          })}
        </div>}
        {candidates.length > 0 && !selectedCandidate && <button type="button" className="text-button" onClick={submitUnresolved} disabled={submitting}>候補を決めず、未特定として登録</button>}
        {selectedCandidate && <p className="selected-song" role="status">選択中：{selectedCandidate.work_title} · {selectedCandidate.title}</p>}
        {!candidates.length && title.trim() && <div className="optional-fields">
          <p className="muted-note">曲が特定できない場合は、曲名だけでも回答を残せます。後で候補を確認できます。</p>
          <label>アーティストなど（任意）<input value={artist} maxLength={160} onChange={(event) => setArtist(event.target.value)} /></label>
          <label>参照URL（任意）<input type="url" value={referenceUrl} placeholder="https://" onChange={(event) => setReferenceUrl(event.target.value)} /></label>
        </div>}
        <label>記録日<input type="date" aria-label="記録日" max={todayInJapan()} value={recordDate} onChange={(event) => setRecordDate(event.target.value)} required /></label>
        {selectedCandidate ? <button type="button" className="primary-button submit-answer" disabled={submitting || !credential} title={!credential ? "本人端末の登録が必要です" : undefined} onClick={() => void submitResolved()}>{submitting ? "送信中…" : "回答を送信"}</button>
          : <button type="button" className="primary-button submit-answer" disabled={submitting || !credential || !title.trim()} title={!credential ? "本人端末の登録が必要です" : undefined} onClick={() => void submitUnresolved()}>{submitting ? "送信中…" : "未特定の曲として送信"}</button>}
      </div>
      {!online && <p className="notice notice-offline" role="status">オフラインです。共有データの更新と既存回答の編集は、接続後に利用できます。</p>}
      {pendingCount > 0 && <p className="notice notice-pending" role="status">送信待ち {pendingCount}件 · この端末に保存済み · クラウド統計には未反映</p>}
      {message && <p className="notice notice-success" role="status">{message}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <p className="muted-note">回答は同じ日に同じ歌唱・演奏版を1件まで登録できます。連日記録すると曲への応援件数に反映されます。</p>
    </div>
    <aside className="side-note content-panel"><p className="eyebrow">曲名だけで大丈夫</p><h3>見つからない曲も残せます</h3><p>一致しない場合は未特定として送信できます。候補が見つかると、この記録から曲を確認できます。</p><div className="offline-chip"><span className="status-dot" />オフライン回答はこの端末で保管</div></aside>
  </section>;
}
