import { useEffect, useRef, useState } from "react";
import type {
  ManualTagChange,
  ManualTagOverride,
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

function overrideOf(
  tag: SongTagEditorData["tags"][number],
): ManualTagOverride {
  if (
    tag.manual_override === "auto" ||
    tag.manual_override === "force_on" ||
    tag.manual_override === "force_off"
  )
    return tag.manual_override;
  return tag.manual_lock
    ? tag.selected
      ? "force_on"
      : "force_off"
    : "auto";
}
function autoSelectedOf(tag: SongTagEditorData["tags"][number]) {
  return typeof tag.auto_selected === "boolean" ? tag.auto_selected : tag.selected;
}

export function SongTagEditor({
  api,
  record,
  selectedVersion,
  token,
  online,
  onDraftChange,
}: Props) {
  const [data, setData] = useState<SongTagEditorData>();
  const [overrides, setOverrides] = useState<Map<string, ManualTagOverride>>(
    new Map(),
  );
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
    setOverrides(new Map());
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
        setOverrides(
          new Map(value.tags.map((tag) => [tag.id, overrideOf(tag)])),
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

  function setOverride(id: string, override: ManualTagOverride) {
    if (!data || !online) return;
    const next = new Map(overrides);
    next.set(id, override);
    setOverrides(next);
    onDraftChange({
      version_id: data.version_id,
      changes: data.tags
        .filter(
          (tag) =>
            (next.get(tag.id) ?? tag.manual_override) !== tag.manual_override,
        )
        .map((tag) => ({
          tag_id: tag.id,
          override: next.get(tag.id) ?? tag.manual_override,
          assignment_id: tag.assignment_id,
          expected_revision: tag.assignment_revision,
        })),
    });
  }
  const categories = [...new Set(data?.tags.map((t) => t.category) ?? [])];
  return (
    <fieldset className="manual-tag-editor">
      <legend>タグの手動編集</legend>
      <p className="muted-note">
        同じ曲の版を登録した全員の表示・統計に反映されます。「自動」は調査結果に従い、「付ける」「外す」は手動で固定します。後から「自動」に戻せます。「記録を保存」で確定します。
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
                .map((t) => {
                  const override = overrides.get(t.id) ?? overrideOf(t);
                  const effective =
                    override === "force_on"
                      ? true
                      : override === "force_off"
                        ? false
                        : autoSelectedOf(t);
                  return (
                    <label
                      className="manual-tag-choice manual-tag-choice-three-state"
                      key={t.id}
                      title={t.criterion}
                    >
                      <span>{t.name}</span>
                      <small>
                        {effective ? "現在: 付与" : "現在: なし"}
                        {override === "auto" ? "（自動）" : "（手動）"}
                      </small>
                      <select
                        aria-label={`${t.name} の設定`}
                        value={override}
                        disabled={!online}
                        onChange={(event) =>
                          setOverride(
                            t.id,
                            event.target.value as ManualTagOverride,
                          )
                        }
                      >
                        <option value="auto">自動</option>
                        <option value="force_on">付ける</option>
                        <option value="force_off">外す</option>
                      </select>
                    </label>
                  );
                })}
            </div>
          </div>
        ))
      )}
    </fieldset>
  );
}
