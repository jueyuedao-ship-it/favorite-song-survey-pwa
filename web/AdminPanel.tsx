import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { BusinessTable, EditableTable, Page, Participant, SurveyRecord } from "../shared/contracts";
import { createApi } from "./api";
import { inviteLink } from "./links";
import { createSecret, newOperationId } from "./storage";
import { InviteShare } from "./InviteShare";

type SurveyApi = ReturnType<typeof createApi>;
type AnyRow = Record<string, unknown> & { id: string; revision: number; deleted_at?: string | null };
type NamedRow = { id: string; name?: string; title?: string; deleted_at?: string | null };
type Props = { api: SurveyApi; token: string; onLogout: () => void };
type AdminTab = "participants" | "catalog" | "records" | "database" | "history" | "operations";

const tabLabels: Record<AdminTab, string> = {
  participants: "参加者・端末",
  catalog: "カタログ",
  records: "全回答",
  database: "DBフォーム",
  history: "変更履歴",
  operations: "運用状況",
};

const tableLabels: Record<EditableTable, string> = {
  participants: "参加者",
  works: "作品",
  versions: "歌唱・演奏版",
  entities: "人物・グループ",
  aliases: "別表記",
  credits: "クレジット",
  tags: "タグ",
  tag_assignments: "タグの付与",
  sources: "情報源",
};

type Field = { key: string; label: string; type?: "text" | "textarea" | "select" | "checkbox" | "number"; options?: { value: string; label: string }[]; reference?: EditableTable; required?: boolean };

function fieldsFor(table: EditableTable, refs: Partial<Record<EditableTable, NamedRow[]>>): Field[] {
  const selectRef = (key: string, label: string, reference: EditableTable, value: (row: NamedRow) => string, required = true) => ({
    key, label, type: "select" as const, reference, required,
    options: (refs[reference] ?? []).filter((row) => !row.deleted_at).map((row) => ({ value: row.id, label: value(row) })),
  });
  switch (table) {
    case "participants": return [{ key: "name", label: "参加者名", required: true }];
    case "works": return [{ key: "title", label: "作品名", required: true }];
    case "versions": return [
      selectRef("work_id", "作品", "works", (row) => row.title ?? row.id),
      { key: "title", label: "歌唱・演奏版の名前", required: true },
      { key: "kind", label: "種別", type: "select", required: true, options: ["original", "cover", "remix", "other"].map((value) => ({ value, label: ({ original: "原曲", cover: "カバー", remix: "リミックス", other: "その他" } as Record<string, string>)[value] })) },
      { key: "reference_url", label: "参照URL" },
      selectRef("uploader_entity_id", "投稿チャンネル", "entities", (row) => row.name ?? row.id, false),
    ];
    case "entities": return [
      { key: "name", label: "人物・グループ名", required: true },
      { key: "kind", label: "種類", type: "select", required: true, options: ["person", "group", "synthetic_voice", "channel"].map((value) => ({ value, label: ({ person: "人物", group: "グループ", synthetic_voice: "合成音声", channel: "チャンネル" } as Record<string, string>)[value] })) },
    ];
    case "aliases": return [selectRef("entity_id", "人物・グループ", "entities", (row) => row.name ?? row.id), { key: "name", label: "別表記", required: true }];
    case "credits": return [
      selectRef("version_id", "歌唱・演奏版", "versions", (row) => row.title ?? row.id),
      selectRef("entity_id", "人物・グループ", "entities", (row) => row.name ?? row.id),
      { key: "role", label: "役割", type: "select", required: true, options: ["vocalist", "composer", "release_name", "uploader"].map((value) => ({ value, label: ({ vocalist: "ボーカル", composer: "作曲者", release_name: "発表名義", uploader: "投稿チャンネル" } as Record<string, string>)[value] })) },
      selectRef("source_id", "情報源", "sources", (row) => row.title ?? row.id, false),
      { key: "confirmed", label: "確認済み", type: "checkbox" },
    ];
    case "tags": return [
      { key: "name", label: "タグ名", required: true },
      { key: "category", label: "分類", required: true },
      { key: "criterion", label: "判定基準", type: "textarea", required: true },
      { key: "active", label: "利用中", type: "checkbox" },
    ];
    case "tag_assignments": return [
      selectRef("version_id", "歌唱・演奏版", "versions", (row) => row.title ?? row.id),
      selectRef("tag_id", "タグ", "tags", (row) => row.name ?? row.id),
      { key: "evidence", label: "根拠", type: "textarea", required: true },
      selectRef("source_id", "情報源", "sources", (row) => row.title ?? row.id, false),
      { key: "origin", label: "登録元", type: "select", required: true, options: [{ value: "admin", label: "管理者" }, { value: "research", label: "調査" }] },
      { key: "confirmed", label: "確認済み", type: "checkbox" },
    ];
    case "sources": return [
      selectRef("version_id", "歌唱・演奏版", "versions", (row) => row.title ?? row.id),
      { key: "url", label: "参照URL", required: true },
      { key: "title", label: "ページ名", required: true },
      { key: "excerpt", label: "引用要旨", type: "textarea", required: true },
      { key: "checked_at", label: "確認日時（UTC ISO）", required: true },
      { key: "origin", label: "登録元", type: "select", required: true, options: [{ value: "admin", label: "管理者" }, { value: "research", label: "調査" }] },
    ];
  }
}

function onlineGuard(): void {
  if (!navigator.onLine) throw new Error("管理者操作にはインターネット接続が必要です。接続後にもう一度お試しください。");
}

export function AdminPanel({ api, token, onLogout }: Props) {
  const [tab, setTab] = useState<AdminTab>("participants");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  return <section className="admin-panel content-panel">
    <header className="section-heading">
      <div><p className="eyebrow">管理者専用・通信が必要です</p><h2>アンケート管理</h2></div>
      <button type="button" className="quiet-button" onClick={onLogout}>ログアウト</button>
    </header>
    <nav className="admin-subnav" aria-label="管理メニュー">
      {(Object.keys(tabLabels) as AdminTab[]).map((key) => <button key={key} type="button" aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); setError(""); setNotice(""); }}>{tabLabels[key]}</button>)}
    </nav>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {notice && <p role="status" className="notice notice-success">{notice}</p>}
    {tab === "participants" && <ParticipantsAdmin api={api} token={token} onError={setError} onNotice={setNotice} />}
    {tab === "catalog" && <AdminTableEditor api={api} token={token} initialTable="works" tables={["works", "versions", "entities", "aliases", "credits", "tags", "tag_assignments", "sources"]} onError={setError} onNotice={setNotice} />}
    {tab === "records" && <AdminRecords api={api} token={token} onError={setError} onNotice={setNotice} />}
    {tab === "database" && <DatabaseForms api={api} token={token} onError={setError} onNotice={setNotice} />}
    {tab === "history" && <AuditHistory api={api} token={token} onError={setError} onNotice={setNotice} />}
    {tab === "operations" && <OperationsStatus api={api} token={token} onError={setError} onNotice={setNotice} />}
  </section>;
}

type ChildProps = { api: SurveyApi; token: string; onError: (message: string) => void; onNotice: (message: string) => void };

function ParticipantsAdmin({ api, token, onError, onNotice }: ChildProps) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [activeParticipant, setActiveParticipant] = useState<string>("");
  const [devices, setDevices] = useState<AnyRow[]>([]);
  const [invites, setInvites] = useState<AnyRow[]>([]);
  const [shareLink, setShareLink] = useState("");
  const [loading, setLoading] = useState(false);

  const loadParticipants = useCallback(async (pageCursor?: string | null, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (pageCursor) params.set("cursor", pageCursor);
      const data = await api.get<Page<Participant>>(`/admin/participants?${params}`, { token });
      setParticipants((current) => append ? [...current, ...data.items] : data.items);
      setNextCursor(data.next_cursor);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "参加者を読み込めませんでした。"); }
    finally { setLoading(false); }
  }, [api, onError, token]);

  useEffect(() => { void loadParticipants(); }, [loadParticipants]);
  useEffect(() => {
    api.get<Page<AnyRow>>("/admin/invites?limit=100", { token }).then((data) => setInvites(data.items)).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "招待一覧を読み込めませんでした。"));
  }, [api, onError, token]);

  async function createParticipant(event: FormEvent) {
    event.preventDefault();
    try {
      onlineGuard();
      const row = await api.post<Participant>("/admin/participants", { operation_id: newOperationId(), values: { name: name.trim() } }, token);
      setParticipants((current) => [row, ...current]);
      setName("");
      onNotice("参加者を登録しました。");
    } catch (reason) { onError(reason instanceof Error ? reason.message : "参加者を登録できませんでした。"); }
  }

  async function issueInvite(participantId: string) {
    try {
      onlineGuard();
      const inviteSecret = createSecret();
      await api.post<AnyRow>("/admin/invites", { operation_id: newOperationId(), participant_id: participantId, invite_secret: inviteSecret }, token);
      setShareLink(inviteLink(globalThis.location.href, inviteSecret));
      onNotice("招待を発行しました。使用されると再利用できません。");
      const data = await api.get<Page<AnyRow>>("/admin/invites?limit=100", { token });
      setInvites(data.items);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "招待を発行できませんでした。"); }
  }

  async function showDevices(participantId: string) {
    try {
      const data = await api.get<Page<AnyRow>>(`/admin/devices?participant_id=${encodeURIComponent(participantId)}&limit=100`, { token });
      setActiveParticipant(participantId);
      setDevices(data.items);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "端末一覧を読み込めませんでした。"); }
  }

  async function revokeDevice(device: AnyRow) {
    try {
      onlineGuard();
      const revoked = await api.delete<AnyRow>(`/admin/devices/${encodeURIComponent(device.id)}`, { operation_id: newOperationId(), expected_revision: device.revision }, token);
      setDevices((current) => current.map((item) => item.id === device.id ? { ...item, ...revoked } : item));
      onNotice("端末の権限を取り消しました。");
    } catch (reason) { onError(reason instanceof Error ? reason.message : "端末を取り消せませんでした。"); }
  }

  return <div className="admin-section">
    <section className="subsection"><h3>参加者</h3>
      <form className="inline-form" onSubmit={createParticipant}>
        <label>新しい参加者名<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
        <button type="submit" className="primary-button">参加者を追加</button>
      </form>
      {participants.length ? <div className="admin-row-list">{participants.map((person) => <article className="admin-row" key={person.id}>
        <div><h4>{person.name}</h4><p className="muted-note">{person.deleted_at ? "無効" : "参加中"} · revision {person.revision}</p></div>
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={() => issueInvite(person.id)}>招待リンク・QRを発行</button>
          <button type="button" className="quiet-button" onClick={() => void showDevices(person.id)}>端末を見る</button>
        </div>
      </article>)}</div> : <p className="empty-state">参加者はまだ登録されていません。</p>}
      {nextCursor && <button className="secondary-button" type="button" disabled={loading} onClick={() => void loadParticipants(nextCursor, true)}>参加者をもっと読み込む</button>}
    </section>
    {shareLink && <InviteShare title="参加者の招待" link={shareLink} onClose={() => setShareLink("")} />}
    {activeParticipant && <section className="subsection"><h3>{participants.find((person) => person.id === activeParticipant)?.name ?? "参加者"}の端末</h3>
      {devices.length ? <div className="admin-row-list">{devices.map((device) => <article className="admin-row" key={device.id}>
        <div><h4>{String(device.label ?? "端末")}</h4><p className="muted-note">{device.revoked_at ? "取り消し済み" : "利用中"} · {String(device.updated_at ?? device.created_at ?? "")}</p></div>
        {!device.revoked_at && <button className="danger-button" type="button" onClick={() => void revokeDevice(device)}>この端末を取り消す</button>}
      </article>)}</div> : <p className="empty-state">この参加者の端末はありません。</p>}
    </section>}
    <section className="subsection"><h3>招待の状態</h3>
      {invites.length ? <div className="table-scroll"><table><thead><tr><th>参加者ID</th><th>期限</th><th>使用状態</th></tr></thead><tbody>{invites.map((invite) => <tr key={invite.id}><td>{String(invite.participant_id)}</td><td>{String(invite.expires_at)}</td><td>{invite.claimed_at ? "使用済み" : "未使用"}</td></tr>)}</tbody></table></div> : <p className="empty-state">招待履歴はありません。</p>}
    </section>
  </div>;
}

function AdminTableEditor({ api, token, onError, onNotice, initialTable, tables }: ChildProps & { initialTable: EditableTable; tables: EditableTable[] }) {
  const [table, setTable] = useState<EditableTable>(initialTable);
  const [rows, setRows] = useState<AnyRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [refs, setRefs] = useState<Partial<Record<EditableTable, NamedRow[]>>>({});
  const [loading, setLoading] = useState(false);
  const fields = useMemo(() => fieldsFor(table, refs), [refs, table]);
  const referencesKey = fields.flatMap((field) => field.reference ? [field.reference] : []).sort().join(",");

  const load = useCallback(async (cursor?: string | null, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (search.trim()) params.set("q", search.trim());
      if (cursor) params.set("cursor", cursor);
      const data = await api.get<Page<AnyRow>>(`/admin/data/${table}?${params}`, { token });
      setRows((current) => append ? [...current, ...data.items] : data.items);
      setNextCursor(data.next_cursor);
      setEditingId(null);
      setCreating(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : `${tableLabels[table]}を読み込めませんでした。`); }
    finally { setLoading(false); }
  }, [api, onError, search, table, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const needed = [...new Set(referencesKey ? referencesKey.split(",") as EditableTable[] : [])];
    if (!needed.length) return;
    let live = true;
    Promise.all(needed.map(async (reference) => [reference, await api.get<Page<NamedRow>>(`/admin/data/${reference}?limit=200`, { token })] as const))
      .then((entries) => { if (live) setRefs((current) => ({ ...current, ...Object.fromEntries(entries.map(([key, value]) => [key, value.items])) })); })
      .catch((reason: unknown) => { if (live) onError(reason instanceof Error ? reason.message : "関連項目を読み込めませんでした。"); });
    return () => { live = false; };
  }, [api, onError, referencesKey, token]);

  function beginEdit(row: AnyRow) {
    setEditingId(row.id);
    setCreating(false);
    setDraft(Object.fromEntries(fields.map((field) => [field.key, row[field.key] ?? (field.type === "checkbox" ? false : "")])));
  }

  function beginCreate() {
    setEditingId(null);
    setCreating(true);
    setDraft(Object.fromEntries(fields.map((field) => [field.key, field.type === "checkbox" ? false : ""])));
  }

  async function saveForm(event: FormEvent) {
    event.preventDefault();
    try {
      onlineGuard();
      const values = Object.fromEntries(fields.filter((field) => draft[field.key] !== "").map((field) => [field.key, draft[field.key]]));
      const row = editingId ? rows.find((item) => item.id === editingId) : undefined;
      const body = editingId
        ? { operation_id: newOperationId(), expected_revision: row?.revision, values }
        : { operation_id: newOperationId(), values };
      const saved = await api.request<AnyRow>(editingId ? `/admin/data/${table}/${encodeURIComponent(editingId)}` : `/admin/data/${table}`, { method: editingId ? "PATCH" : "POST", body, token });
      setRows((current) => editingId ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
      setEditingId(null);
      setCreating(false);
      onNotice(`${tableLabels[table]}を${editingId ? "更新" : "登録"}しました。`);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "変更を保存できませんでした。"); }
  }

  async function deleteRow(row: AnyRow) {
    try {
      onlineGuard();
      const deleted = await api.delete<AnyRow>(`/admin/data/${table}/${encodeURIComponent(row.id)}`, { operation_id: newOperationId(), expected_revision: row.revision }, token);
      setRows((current) => current.map((item) => item.id === deleted.id ? deleted : item));
      onNotice("削除状態を保存しました。履歴データは残っています。");
    } catch (reason) { onError(reason instanceof Error ? reason.message : "削除できませんでした。"); }
  }

  function renderField(field: Field) {
    const value = draft[field.key];
    if (field.type === "checkbox") return <label className="check-field" key={field.key}><input type="checkbox" checked={Boolean(value)} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.checked }))} />{field.label}</label>;
    if (field.type === "textarea") return <label key={field.key}>{field.label}<textarea required={field.required} value={String(value ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} /></label>;
    if (field.type === "select") return <label key={field.key}>{field.label}<select required={field.required} value={String(value ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value || null }))}>
      <option value="">選択してください</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>;
    return <label key={field.key}>{field.label}<input type={field.type ?? "text"} required={field.required} value={String(value ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value }))} /></label>;
  }

  return <div className="admin-section">
    <header className="list-toolbar"><label>対象テーブル<select aria-label="対象テーブル" value={table} onChange={(event) => { const next = event.target.value as EditableTable; if (next !== table) { setTable(next); setRows([]); setRefs({}); } }}>
      {tables.map((item) => <option key={item} value={item}>{tableLabels[item]}</option>)}
    </select></label>
      <form className="search-form" onSubmit={(event) => { event.preventDefault(); void load(); }}><label>名前・内容を検索<input value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className="secondary-button" type="submit">検索</button></form>
      <button type="button" className="primary-button" onClick={beginCreate}>新規登録</button>
    </header>
    {(creating || editingId) && <form className="editor-form" onSubmit={saveForm}>
      <h3>{creating ? `${tableLabels[table]}を登録` : `${tableLabels[table]}を編集`}</h3>
      <div className="field-grid">{fields.map(renderField)}</div>
      <div className="button-row"><button className="primary-button" type="submit">変更を保存</button><button className="quiet-button" type="button" onClick={() => { setCreating(false); setEditingId(null); }}>キャンセル</button></div>
    </form>}
    {loading && <p role="status">読み込んでいます…</p>}
    {rows.length ? <div className="admin-row-list">{rows.map((row) => <article className="admin-row" key={row.id}>
      <div className="admin-row-values"><h4>{String(row.title ?? row.name ?? row.url ?? row.id)}</h4>
        <dl>{fields.filter((field) => field.key !== "title" && field.key !== "name").map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.options?.find((option) => option.value === row[field.key])?.label ?? String(row[field.key] ?? "—")}</dd></div>)}<div><dt>状態</dt><dd>{row.deleted_at ? "削除済み" : "有効"} · revision {row.revision}</dd></div></dl>
      </div>
      {!row.deleted_at && <div className="button-row"><button type="button" className="quiet-button" onClick={() => beginEdit(row)}>編集</button><button type="button" className="danger-button" onClick={() => void deleteRow(row)}>削除</button></div>}
    </article>)}</div> : !loading && <p className="empty-state">該当する{tableLabels[table]}はありません。新規登録から追加できます。</p>}
    {nextCursor && <button type="button" className="secondary-button" disabled={loading} onClick={() => void load(nextCursor, true)}>もっと読み込む</button>}
  </div>;
}

function DatabaseForms({ api, token, onError, onNotice }: ChildProps) {
  const businessTables: BusinessTable[] = ["participants", "works", "versions", "entities", "aliases", "credits", "responses", "tags", "tag_assignments", "sources", "research_results", "research_jobs", "usage", "devices", "invites", "audit", "audit_corrections", "sync_status"];
  const editable = new Set<BusinessTable>(["participants", "works", "versions", "entities", "aliases", "credits", "tags", "tag_assignments", "sources"]);
  const [selected, setSelected] = useState<BusinessTable>("participants");
  const [rows, setRows] = useState<AnyRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const label = tableLabels[selected as EditableTable] ?? selected;

  const load = useCallback(async (pageCursor?: string | null, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (query.trim()) params.set("q", query.trim());
      if (pageCursor) params.set("cursor", pageCursor);
      const data = await api.get<Page<AnyRow>>(`/admin/data/${selected}?${params}`, { token });
      setRows((current) => append ? [...current, ...data.items] : data.items);
      setNextCursor(data.next_cursor);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "保存データを読み込めませんでした。"); }
    finally { setLoading(false); }
  }, [api, onError, query, selected, token]);
  useEffect(() => { void load(); }, [load]);

  return <div className="admin-section">
    <p className="muted-note">SQL入力欄はありません。業務テーブルは確認用に一覧表示し、編集可能な項目は入力フォームを使います。監査・資格情報・調査結果は専用タブから操作してください。</p>
    <header className="list-toolbar"><label>データ表<select aria-label="データ表" value={selected} onChange={(event) => { setSelected(event.target.value as BusinessTable); setRows([]); }}>
      {businessTables.map((table) => <option key={table} value={table}>{tableLabels[table as EditableTable] ?? table}</option>)}
    </select></label>
      <form className="search-form" onSubmit={(event) => { event.preventDefault(); void load(); }}><label>検索<input value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary-button" type="submit">検索</button></form>
    </header>
    {editable.has(selected) ? <AdminTableEditor api={api} token={token} onError={onError} onNotice={onNotice} initialTable={selected as EditableTable} tables={[selected as EditableTable]} />
      : rows.length ? <div className="table-scroll"><table><caption>{label}（参照のみ）</caption><thead><tr><th>ID</th><th>版</th><th>状態</th><th>内容</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><th scope="row">{row.id}</th><td>{row.revision}</td><td>{row.deleted_at ? "削除済み" : "有効"}</td><td><details><summary>詳細</summary><pre>{JSON.stringify(row, null, 2)}</pre></details></td></tr>)}</tbody></table></div>
        : <p className="empty-state">{loading ? "読み込んでいます…" : `${label}はありません。`}</p>}
    {nextCursor && !editable.has(selected) && <button type="button" className="secondary-button" onClick={() => void load(nextCursor, true)}>もっと読み込む</button>}
  </div>;
}

function AdminRecords({ api, token, onError, onNotice }: ChildProps) {
  const [records, setRecords] = useState<SurveyRecord[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [versions, setVersions] = useState<NamedRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<SurveyRecord | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const load = useCallback(async (cursor?: string | null, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ include_deleted: "true", limit: "100" });
      if (search.trim()) params.set("q", search.trim());
      if (cursor) params.set("cursor", cursor);
      const data = await api.get<Page<SurveyRecord>>(`/admin/records?${params}`, { token });
      setRecords((current) => append ? [...current, ...data.items] : data.items);
      setNextCursor(data.next_cursor);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "回答一覧を読み込めませんでした。"); }
    finally { setLoading(false); }
  }, [api, onError, search, token]);
  useEffect(() => {
    void load();
    Promise.all([
      api.get<Page<Participant>>("/admin/participants?limit=200", { token }),
      api.get<Page<NamedRow>>("/admin/data/versions?limit=200", { token }),
    ]).then(([people, versionsPage]) => { setParticipants(people.items); setVersions(versionsPage.items); }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "回答の参照先を読み込めませんでした。"));
  }, [api, load, onError, token]);

  function edit(record: SurveyRecord) {
    setEditing(record);
    setDraft({ participant_id: record.participant_id, version_id: record.version_id ?? "", record_date: record.record_date, unresolved_title: record.unresolved_title ?? "", artist_hint: record.artist_hint ?? "", reference_url: record.reference_url ?? "" });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    try {
      onlineGuard();
      const body = { operation_id: newOperationId(), expected_revision: editing.revision, participant_id: draft.participant_id, version_id: draft.version_id || null, record_date: draft.record_date, unresolved_title: draft.unresolved_title || null, artist_hint: draft.artist_hint || null, reference_url: draft.reference_url || null };
      await api.patch<SurveyRecord>(`/admin/records/${encodeURIComponent(editing.id)}`, body, token);
      setEditing(null);
      onNotice("回答を更新しました。");
      void load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "回答を更新できませんでした。"); }
  }

  async function remove(record: SurveyRecord) {
    try {
      onlineGuard();
      await api.delete<SurveyRecord>(`/admin/records/${encodeURIComponent(record.id)}`, { operation_id: newOperationId(), expected_revision: record.revision }, token);
      onNotice("回答を削除状態にしました。履歴には残ります。");
      void load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "回答を削除できませんでした。"); }
  }

  return <div className="admin-section">
    <header className="list-toolbar"><form className="search-form" onSubmit={(event) => { event.preventDefault(); void load(); }}><label>回答を検索<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="曲名・参加者名" /></label><button className="secondary-button" type="submit">検索</button></form><span className="muted-note">削除済みも含む</span></header>
    {editing && <form className="editor-form" onSubmit={save}><h3>回答を編集</h3><div className="field-grid">
      <label>参加者<select value={draft.participant_id} onChange={(event) => setDraft((current) => ({ ...current, participant_id: event.target.value }))}>{participants.filter((item) => !item.deleted_at).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>歌唱・演奏版<select value={draft.version_id} onChange={(event) => setDraft((current) => ({ ...current, version_id: event.target.value }))}><option value="">未特定</option>{versions.filter((item) => !item.deleted_at).map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id}</option>)}</select></label>
      <label>記録日<input type="date" value={draft.record_date} onChange={(event) => setDraft((current) => ({ ...current, record_date: event.target.value }))} required /></label>
      <label>未特定の曲名<input value={draft.unresolved_title} onChange={(event) => setDraft((current) => ({ ...current, unresolved_title: event.target.value }))} /></label>
      <label>アーティスト補足<input value={draft.artist_hint} onChange={(event) => setDraft((current) => ({ ...current, artist_hint: event.target.value }))} /></label>
      <label>参照URL<input type="url" value={draft.reference_url} onChange={(event) => setDraft((current) => ({ ...current, reference_url: event.target.value }))} /></label>
    </div><div className="button-row"><button className="primary-button" type="submit">回答を保存</button><button className="quiet-button" type="button" onClick={() => setEditing(null)}>キャンセル</button></div></form>}
    {records.length ? <div className="admin-row-list">{records.map((record) => <article className="admin-row" key={record.id}>
      <div><h4>{versions.find((version) => version.id === record.version_id)?.title ?? record.unresolved_title ?? "未特定"}</h4><p>{participants.find((person) => person.id === record.participant_id)?.name ?? "参加者"} · {record.record_date}</p><p className="muted-note">{record.deleted_at ? "削除済み" : "有効"} · revision {record.revision}</p></div>
      {!record.deleted_at && <div className="button-row"><button type="button" className="quiet-button" onClick={() => edit(record)}>編集</button><button type="button" className="danger-button" onClick={() => void remove(record)}>削除</button></div>}
    </article>)}</div> : !loading && <p className="empty-state">回答はありません。</p>}
    {loading && <p role="status">読み込んでいます…</p>}
    {nextCursor && <button type="button" className="secondary-button" disabled={loading} onClick={() => void load(nextCursor, true)}>回答をもっと読み込む</button>}
  </div>;
}

function AuditHistory({ api, token, onError, onNotice }: ChildProps) {
  const [audits, setAudits] = useState<AnyRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<AnyRow | null>(null);
  const [reason, setReason] = useState("");
  const [corrected, setCorrected] = useState("{}");
  const [filterTable, setFilterTable] = useState("");

  const load = useCallback(async (pageCursor?: string | null, append = false) => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (pageCursor) params.set("cursor", pageCursor);
      if (filterTable) params.set("table", filterTable);
      const data = await api.get<Page<AnyRow>>(`/admin/audit?${params}`, { token });
      setAudits((current) => append ? [...current, ...data.items] : data.items);
      setNextCursor(data.next_cursor);
    } catch (error) { onError(error instanceof Error ? error.message : "変更履歴を読み込めませんでした。"); }
  }, [api, filterTable, onError, token]);
  useEffect(() => { void load(); }, [load]);

  async function correct(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      onlineGuard();
      const parsed: unknown = JSON.parse(corrected);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("訂正後のJSONはオブジェクトで入力してください。");
      await api.post(`/admin/audit/${encodeURIComponent(selected.id)}/corrections`, { operation_id: newOperationId(), reason: reason.trim(), corrected: parsed }, token);
      setSelected(null);
      setReason("");
      setCorrected("{}");
      onNotice("変更履歴への訂正を追加しました。元の記録は保持されています。");
      void load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "訂正を保存できませんでした。"); }
  }

  return <div className="admin-section">
    <header className="list-toolbar"><label>データ表で絞り込み<input value={filterTable} onChange={(event) => setFilterTable(event.target.value)} placeholder="例: responses" /></label><button type="button" className="secondary-button" onClick={() => void load()}>絞り込み</button></header>
    <p className="muted-note">元の変更と訂正は別々に保存されます。画面に表示する有効値はAPIのeffective内容です。</p>
    {selected && <form className="editor-form" onSubmit={correct}><h3>履歴を訂正 · {String(selected.table)} / {String(selected.row_id)}</h3>
      <label>訂正理由<textarea aria-label="訂正理由" required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <label>訂正後のJSON<textarea aria-label="訂正後のJSON" required value={corrected} onChange={(event) => setCorrected(event.target.value)} rows={6} /></label>
      <div className="button-row"><button type="submit" className="primary-button">履歴を訂正</button><button type="button" className="quiet-button" onClick={() => setSelected(null)}>キャンセル</button></div>
    </form>}
    {audits.length ? <div className="admin-row-list">{audits.map((audit) => <article className="admin-row audit-row" key={audit.id}>
      <div><h4>{String(audit.table)} · {String(audit.action)} · {String(audit.row_id)}</h4><p>{String(audit.actor_type)} / {String(audit.actor_id ?? "")} · {String(audit.created_at ?? "")}</p>
        <details><summary>変更前後と有効値</summary><pre>{JSON.stringify({ before: audit.before, after: audit.after, effective: audit.effective ?? audit.after }, null, 2)}</pre></details>
      </div><button type="button" className="secondary-button" onClick={() => { setSelected(audit); setReason(""); setCorrected(JSON.stringify(audit.effective ?? audit.after ?? {}, null, 2)); }}>この履歴を訂正</button>
    </article>)}</div> : <p className="empty-state">変更履歴はありません。</p>}
    {nextCursor && <button type="button" className="secondary-button" onClick={() => void load(nextCursor, true)}>履歴をもっと読み込む</button>}
  </div>;
}

function OperationsStatus({ api, token, onError, onNotice }: ChildProps) {
  const [jobs, setJobs] = useState<AnyRow[]>([]);
  const [usage, setUsage] = useState<Record<string, unknown>>();
  const [sync, setSync] = useState<Record<string, unknown>>();
  const [health, setHealth] = useState<Record<string, unknown>>();
  const [usageRows, setUsageRows] = useState<AnyRow[]>([]);
  const [cap, setCap] = useState("800");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const entries = await Promise.allSettled([
      api.get<Page<AnyRow>>("/admin/jobs?limit=100", { token }),
      api.get<Record<string, unknown>>("/admin/usage", { token }),
      api.get<Record<string, unknown>>("/admin/sync-status", { token }),
      api.get<Record<string, unknown>>("/health"),
      api.get<Page<AnyRow>>("/admin/data/usage?limit=100", { token }),
    ]);
    const [jobResult, usageResult, syncResult, healthResult, usageRowsResult] = entries;
    if (jobResult.status === "fulfilled") setJobs(jobResult.value.items);
    else onError(jobResult.reason instanceof Error ? jobResult.reason.message : "調査状況を読み込めませんでした。");
    if (usageResult.status === "fulfilled") {
      setUsage(usageResult.value);
      if (typeof usageResult.value.tavily_credit_cap === "number") setCap(String(usageResult.value.tavily_credit_cap));
    }
    if (syncResult.status === "fulfilled") setSync(syncResult.value);
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    if (usageRowsResult.status === "fulfilled") setUsageRows(usageRowsResult.value.items);
    setLoading(false);
  }, [api, onError, token]);
  useEffect(() => { void load(); }, [load]);

  async function saveUsage(event: FormEvent) {
    event.preventDefault();
    try {
      onlineGuard();
      const value = Number(cap);
      if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error("月間上限は0〜1000の整数にしてください。");
      const existing = usageRows.find((row) => row.month === usage?.month);
      if (existing) await api.patch(`/admin/usage/${encodeURIComponent(existing.id)}`, { operation_id: newOperationId(), expected_revision: existing.revision, tavily_credit_cap: value }, token);
      else await api.post("/admin/usage", { operation_id: newOperationId(), tavily_credit_cap: value }, token);
      onNotice("調査の月間上限を保存しました。");
      void load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "上限を保存できませんでした。"); }
  }

  async function retryJob(job: AnyRow) {
    try {
      onlineGuard();
      await api.post(`/admin/jobs/${encodeURIComponent(job.id)}/retry`, { operation_id: newOperationId(), expected_revision: job.revision }, token);
      onNotice("調査を再試行キューへ追加しました。");
      void load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "再試行できませんでした。"); }
  }

  return <div className="admin-section operations-grid">
    <div className="ops-card"><h3>調査の利用状況</h3>
      {usage ? <dl className="status-list">{Object.entries(usage).filter(([key]) => key !== "configured").map(([key, value]) => <div key={key}><dt>{({ month: "対象月", tavily_credits: "検索クレジット", tavily_credit_cap: "月間上限", groq_requests: "AI依頼数", last_error: "直近のエラー" } as Record<string, string>)[key] ?? key}</dt><dd>{String(value ?? "なし")}</dd></div>)}</dl> : <p>利用状況はまだありません。</p>}
      {Boolean(usage?.month) && <form className="inline-form" onSubmit={saveUsage}><label>検索クレジット月間上限<input type="number" min="0" max="1000" value={cap} onChange={(event) => setCap(event.target.value)} /></label><button className="secondary-button" type="submit">上限を保存</button></form>}
      {Boolean(health?.configured) && <ul className="configured-list">{Object.entries(health?.configured as Record<string, boolean>).map(([key, value]) => <li key={key}><span>{({ admin: "管理者", sync: "PC同期", groq: "AI解析", tavily: "Web検索", research_runner: "調査実行" } as Record<string, string>)[key] ?? key}</span><strong>{value ? "設定済み" : "未設定"}</strong></li>)}</ul>}
    </div>
    <div className="ops-card"><h3>調査ジョブ</h3>
      {jobs.length ? <div className="admin-row-list compact-list">{jobs.map((job) => <article className="admin-row" key={job.id}><div><strong>{String(job.query && typeof job.query === "object" ? (job.query as Record<string, unknown>).title ?? "曲情報" : "調査")}</strong><p>{String(job.status)} · 試行 {String(job.attempts ?? 0)} · {String(job.last_error ?? "エラーなし")}</p></div>{["failed", "needs_review"].includes(String(job.status)) && <button type="button" className="secondary-button" onClick={() => void retryJob(job)}>再試行</button>}</article>)}</div> : <p className="empty-state">待機中の調査はありません。</p>}
    </div>
    <div className="ops-card"><h3>PCへの同期</h3>
      {sync ? <><p>変更番号上限: <strong>{String(sync.high_watermark ?? 0)}</strong></p>{Array.isArray(sync.items) && sync.items.length ? <ul className="sync-list">{(sync.items as Record<string, unknown>[]).map((item, index) => <li key={String(item.id ?? index)}>{String(item.collector_id)} · 番号 {String(item.cursor)} · schema {String(item.schema_version)}</li>)}</ul> : <p className="muted-note">収集確認はまだありません。</p>}</> : <p className="empty-state">同期状況を読み込んでいます。</p>}
    </div>
    {loading && <p role="status">最新情報を読み込んでいます…</p>}
    <button type="button" className="secondary-button" onClick={() => void load()}>状態を更新</button>
  </div>;
}
