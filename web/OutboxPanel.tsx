import { useEffect, useState } from "react";
import type { Participant, SongDetail } from "../shared/contracts";
import type { PendingRecord } from "./storage";
import type { createApi } from "./api";

export function failureExplanation(status: number): string {
  if (status === 401 || status === 403) return "保存時の本人端末の権限が確認できません。管理者に端末の権限を確認してください。";
  if (status === 409) return "同じ日・同じ版の記録または操作との競合があります。自分の記録を確認してください。";
  if (status === 404) return "保存先の曲や参加者が見つかりません。管理者に対象を確認してください。";
  return "保存内容が受け付けられませんでした。日付・曲の内容を確認してください。";
}

type Props = { api: ReturnType<typeof createApi>; entries: PendingRecord[]; participants: Participant[]; online: boolean; busy: boolean; onRetry: (operationId: string) => void; onRemove: (operationId: string) => void };
export function OutboxPanel({ api, entries, participants, online, busy, onRetry, onRemove }: Props) {
  const [expanded, setExpanded] = useState(10);
  const [removing, setRemoving] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const failed = entries.filter((entry) => entry.failure);
  const shown = failed.slice(0, expanded);
  const ids = [...new Set(shown.flatMap((entry) => !entry.song_title && entry.record.version_id ? [entry.record.version_id] : []))].join("|");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(ids ? ids.split("|").map(async (id) => {
      try {
        const song = await api.get<SongDetail>(`/catalog/versions/${encodeURIComponent(id)}`, { signal: controller.signal });
        return [id, [...new Set([song.work.title, song.version.title])].join(" · ")] as const;
      } catch { return [id, "登録曲の情報を取得できませんでした"] as const; }
    }) : []).then((values) => { if (!controller.signal.aborted) setTitles(Object.fromEntries(values)); });
    return () => controller.abort();
  }, [api, ids]);
  if (!failed.length) return null;
  return <section className="content-panel" aria-label="送信できなかった回答">
    <h2>確認が必要な送信待ち {failed.length}件</h2>
    <p>回答はこの端末に残っています。保存時の本人情報と同じ操作で再試行します。クラウドには未反映です。</p>
    {shown.map((entry) => <article className="history-card" key={entry.operation_id}>
      <div className="history-song">
        <strong>{(entry.participant_name || participants.find((p) => p.id === entry.participant_id)?.name || `保存時の参加者（${entry.participant_id}）`).slice(0, 100)}</strong>
        <p>{entry.record.record_date} · {(entry.song_title || entry.record.unresolved_title || (entry.record.version_id ? titles[entry.record.version_id] || "登録曲の情報を確認中…" : "曲名未入力")).slice(0, 240)}</p>
        <p>{failureExplanation(entry.failure!.status)}</p>
      </div>
      <div className="history-actions">
        <button type="button" className="secondary-button" disabled={!online || busy} onClick={() => onRetry(entry.operation_id)}>この回答を再試行</button>
        <button type="button" className="danger-button" disabled={busy} onClick={() => setRemoving(entry.operation_id)}>この送信待ちを削除</button>
        {removing === entry.operation_id && <div>
          <p>この端末の送信待ちから削除します。この保存内容を取り戻せなくなります。</p>
          <button type="button" className="danger-button" disabled={busy} onClick={() => { setRemoving(""); onRemove(entry.operation_id); }}>削除を確定</button>
          <button type="button" className="quiet-button" onClick={() => setRemoving("")}>取り消す</button>
        </div>}
      </div>
    </article>)}
    {failed.length > expanded && <button type="button" className="secondary-button" onClick={() => setExpanded((count) => count + 10)}>失敗した回答をもっと表示</button>}
  </section>;
}
