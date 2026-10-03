import { useEffect, useRef, useState } from "react";
import type {
  ManualTagChange,
  SongTagEditorData,
  SurveyRecord,
} from "../shared/contracts";
import type { createApi } from "./api";

export type SongTagDraft = { version_id: string; changes: ManualTagChange[] };
type Props = {
  api: ReturnType<typeof createApi>;
  record: SurveyRecord;
  selectedVersion: string;
  token: string;
  online: boolean;
  onDraftChange: (draft: SongTagDraft | undefined) => void;
};

export function SongTagEditor({
  api,
  record,
  selectedVersion,
  token,
  online,
  onDraftChange,
}: Props) {
  const [data, setData] = useState<SongTagEditorData>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadedScope = useRef("");
  const scope = `${record.id}:${record.revision}:${selectedVersion}`;
  const valid = Boolean(
    record.version_id && selectedVersion === record.version_id,
  );
  useEffect(() => {
    if (loadedScope.current === scope) return;
    loadedScope.current = "";
    setData(undefined);
    setSelected(new Set());
    onDraftChange(undefined);
    setFailed(false);
    setLoading(false);
    if (!valid || !online) return;
    const controller = new AbortController();
    setLoading(true);
    void api
      .get<SongTagEditorData>(
        `/records/${encodeURIComponent(record.id)}/tags`,
        { token, signal: controller.signal },
      )
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.version_id !== record.version_id)
          throw new Error("Version changed");
        loadedScope.current = scope;
        setData(value);
        setSelected(
          new Set(value.tags.filter((t) => t.selected).map((t) => t.id)),
        );
        onDraftChange({ version_id: value.version_id, changes: [] });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    api,
    record.id,
    record.revision,
    record.version_id,
    selectedVersion,
    token,
    online,
    valid,
    scope,
    onDraftChange,
  ]);

  function toggle(id: string) {
    if (!data || !online) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    onDraftChange({
      version_id: data.version_id,
      changes: data.tags
        .filter((t) => next.has(t.id) !== t.selected)
        .map((t) => ({
          tag_id: t.id,
          confirmed: next.has(t.id),
          assignment_id: t.assignment_id,
          expected_revision: t.assignment_revision,
        })),
    });
  }
  const categories = [...new Set(data?.tags.map((t) => t.category) ?? [])];
  return (
    <fieldset className="manual-tag-editor">
      <legend>タグの手動編集</legend>
      <p className="muted-note">
        同じ曲の版を登録した全員の表示・統計に反映されます。手動で付け外したタグは自動調査で上書きしません。「記録を保存」で確定します。
      </p>
      {!valid ? (
        <p>
          曲の候補を選んで保存してからタグを編集してください。曲を選び直すと未保存のタグ変更は取り消されます。
        </p>
      ) : !online && !data ? (
        <p>タグの編集にはインターネット接続が必要です。</p>
      ) : loading ? (
        <p>タグを読み込んでいます…</p>
      ) : failed ? (
        <p className="notice notice-error">
          タグを取得できませんでした。編集欄を開き直してください。記録の他の項目は保存できます。
        </p>
      ) : (
        data &&
        categories.map((category) => (
          <div className="manual-tag-category" key={category}>
            <h5>{category}</h5>
            <div className="manual-tag-options">
              {data.tags
                .filter((t) => t.category === category)
                .map((t) => (
                  <label
                    className="manual-tag-choice"
                    key={t.id}
                    title={t.criterion}
                  >
                    <input
                      type="checkbox"
                      aria-label={t.name}
                      checked={selected.has(t.id)}
                      disabled={!online}
                      onChange={() => toggle(t.id)}
                    />
                    <span>{t.name}</span>
                    {t.manual_lock && <small>手動</small>}
                  </label>
                ))}
            </div>
          </div>
        ))
      )}
    </fieldset>
  );
}
