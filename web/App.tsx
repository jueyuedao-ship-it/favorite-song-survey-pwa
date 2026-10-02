import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Participant, RecordCreate } from "../shared/contracts";
import { AdminPanel } from "./AdminPanel";
import { AnswerPanel } from "./AnswerPanel";
import { createApi, ApiError } from "./api";
import { clearInviteHash, inviteLink, inviteSecretFromHash } from "./links";
import { formatJapaneseDateTime } from "./dates";
import { HistoryPanel } from "./HistoryPanel";
import { InviteShare } from "./InviteShare";
import { StatisticsPanel } from "./StatisticsPanel";
import {
  clearPendingRegistration,
  createSecret,
  enqueueRecord,
  getPendingRegistration,
  getSelectedParticipant,
  listCredentials,
  listOutbox,
  newOperationId,
  removeFromOutbox,
  saveCredential,
  savePendingRegistration,
  saveSelectedParticipant,
  type PendingRegistration,
  type StoredCredential,
} from "./storage";
import type { GuestClaim, GuestCreate, GuestIdentity, Page, RecordCreate as RecordCreateBody } from "../shared/contracts";

type Env = { DEV?: boolean; VITE_API_BASE_URL?: string; BASE_URL?: string };
type AppProps = { apiBase?: string; fetcher?: typeof fetch };
type MainView = "answer" | "rankings" | "history" | "personal" | "admin";

function defaultApiBase(): string {
  const env = (import.meta as ImportMeta & { env?: Env }).env;
  return env?.VITE_API_BASE_URL?.trim() || (env?.DEV ? "/api/v1" : "");
}

function isTransportFailure(error: unknown): boolean {
  return !(error instanceof ApiError);
}

export function App({ apiBase = defaultApiBase(), fetcher }: AppProps) {
  const api = useMemo(() => createApi(apiBase, { fetch: fetcher }), [apiBase, fetcher]);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState<MainView>("answer");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [peopleNextCursor, setPeopleNextCursor] = useState<string | null>(null);
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [pendingRegistration, setPendingRegistration] = useState<PendingRegistration | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [inviteShareLink, setInviteShareLink] = useState("");
  const [updateWaiting, setUpdateWaiting] = useState<ServiceWorker | null>(null);
  const replaying = useRef(false);
  const registering = useRef(false);
  const selectedParticipantRef = useRef("");
  selectedParticipantRef.current = selectedParticipantId;
  const currentParticipant = participants.find((person) => person.id === selectedParticipantId);
  const credential = credentials.find((item) => item.participant_id === selectedParticipantId);
  const env = (import.meta as ImportMeta & { env?: Env }).env;
  const basePath = env?.BASE_URL ?? "./";

  const refreshOutbox = useCallback(async () => {
    try { setPendingCount((await listOutbox(apiBase)).length); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "送信待ちの記録を読み込めませんでした。"); }
  }, [apiBase]);

  const refreshParticipants = useCallback(async (cursor?: string | null, append = false) => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const page = await api.get<Page<Participant>>(`/participants?${params}`);
      setParticipants((current) => append ? [...current, ...page.items] : page.items);
      setPeopleNextCursor(page.next_cursor);
      return page.items;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "参加者を読み込めませんでした。");
      return [];
    }
  }, [api]);

  const completeRegistration = useCallback(async (pending: PendingRegistration) => {
    if (registering.current || !navigator.onLine) return;
    setPendingRegistration(pending);
    registering.current = true;
    setError("");
    try {
      const identity = pending.kind === "create"
        ? await api.post<GuestIdentity>("/guest/create", pending.request)
        : await api.post<GuestIdentity>("/guest/claim", pending.request);
      const secret = pending.request.device_secret;
      const stored: StoredCredential = { ...identity, participant_id: identity.participant.id, participant: identity.participant, device_secret: secret };
      await saveCredential(apiBase, stored);
      await saveSelectedParticipant(apiBase, identity.participant.id);
      await clearPendingRegistration(apiBase);
      setPendingRegistration(null);
      setCredentials((current) => [...current.filter((item) => item.participant_id !== stored.participant_id), stored]);
      setSelectedParticipantId(identity.participant.id);
      setParticipants((current) => current.some((item) => item.id === identity.participant.id) ? current.map((item) => item.id === identity.participant.id ? identity.participant : item) : [identity.participant, ...current]);
      setNotice(`${identity.participant.name}さんの端末を登録しました。`);
      setError("");
      void refreshParticipants();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 429) {
        await clearPendingRegistration(apiBase);
        setPendingRegistration(null);
      }
      const message = reason instanceof Error ? reason.message : "端末の登録を完了できませんでした。";
      setError(message);
      if (isTransportFailure(reason) || (reason instanceof ApiError && reason.status >= 500)) {
        setNotice("端末登録は未完了です。保存した同じ登録情報で、接続回復後に再試行します。");
      }
      throw reason;
    } finally { registering.current = false; }
  }, [api, apiBase, refreshParticipants]);

  const replayOutbox = useCallback(async () => {
    if (replaying.current || !navigator.onLine) return;
    replaying.current = true;
    try {
      const pending = await listOutbox(apiBase);
      setPendingCount(pending.length);
      for (const entry of pending) {
        const body: RecordCreateBody = { ...entry.record, operation_id: entry.operation_id };
        try {
          await api.post("/records", body, entry.device_secret);
          await removeFromOutbox(apiBase, entry.operation_id);
          setPendingCount((count) => Math.max(0, count - 1));
          setNotice("送信待ちの回答をクラウドへ保存しました。");
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "送信待ちの回答を送れませんでした。";
          setError(message);
          setNotice("送信待ちの回答は端末に残しています。本人確認または通信を確認して再試行します。");
          break;
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "送信待ちを確認できませんでした。"); }
    finally { replaying.current = false; }
  }, [api, apiBase]);

  useEffect(() => {
    let live = true;
    async function restore() {
      try {
        const [selected, savedCredentials, outbox, savedRegistration] = await Promise.all([
          getSelectedParticipant(apiBase), listCredentials(apiBase), listOutbox(apiBase), getPendingRegistration(apiBase),
        ]);
        if (!live) return;
        setSelectedParticipantId(selected ?? "");
        setCredentials(savedCredentials);
        setPendingCount(outbox.length);
        setBooted(true);
        let pending = savedRegistration;
        const inviteSecret = inviteSecretFromHash(globalThis.location.hash);
        if (!pending && inviteSecret) {
          const request: GuestClaim = { operation_id: newOperationId(), invite_secret: inviteSecret, device_label: "この端末", device_secret: createSecret() };
          pending = { kind: "claim", request };
          await savePendingRegistration(apiBase, pending);
          clearInviteHash();
        }
        setPendingRegistration(pending ?? null);
        if (pending && navigator.onLine) void completeRegistration(pending).catch(() => undefined);
      } catch (reason) {
        if (live) { setError(reason instanceof Error ? reason.message : "端末内の保存情報を読み込めませんでした。"); setBooted(true); }
      }
    }
    void restore();
    return () => { live = false; };
  }, [apiBase, completeRegistration]);

  useEffect(() => {
    if (!booted) return;
    void refreshParticipants().then((items) => {
      if (!selectedParticipantRef.current && items[0]) {
        setSelectedParticipantId(items[0].id);
        void saveSelectedParticipant(apiBase, items[0].id);
      }
    });
  }, [apiBase, booted, refreshParticipants, selectedParticipantId]);

  useEffect(() => {
    if (booted && online) void replayOutbox();
  }, [booted, online, replayOutbox]);

  useEffect(() => {
    function updateNetwork() {
      const state = navigator.onLine;
      setOnline(state);
      if (state) {
        const pending = getPendingRegistration(apiBase).then((registration) => registration ? completeRegistration(registration) : undefined).catch(() => undefined);
        void pending.then(() => replayOutbox());
      }
    }
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => { window.removeEventListener("online", updateNetwork); window.removeEventListener("offline", updateNetwork); };
  }, [apiBase, completeRegistration, replayOutbox]);

  useEffect(() => {
    if (env?.DEV || !("serviceWorker" in navigator) || !globalThis.isSecureContext && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;
    const script = new URL(`${basePath}sw.js`, globalThis.location.href);
    const scope = new URL(basePath, globalThis.location.href).pathname;
    void navigator.serviceWorker.register(script, { scope }).then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) setUpdateWaiting(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) setUpdateWaiting(worker);
        });
      });
    }).catch(() => setNotice("オフライン用のアプリ更新を確認できませんでした。"));
    const handleController = () => globalThis.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", handleController);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", handleController);
  }, [basePath, env?.DEV]);

  async function createGuest(name: string, deviceLabel: string) {
    const existing = await getPendingRegistration(apiBase);
    if (existing) {
      setPendingRegistration(existing);
      if (existing.kind !== "create") throw new Error("受け取った招待の登録を先に完了してください。");
      if (!navigator.onLine) {
        setNotice("登録情報は端末内に残っています。接続後に同じ要求を再試行してください。");
        return;
      }
      await completeRegistration(existing);
      return;
    }
    const pending: PendingRegistration = {
      kind: "create",
      request: { operation_id: newOperationId(), name, device_label: deviceLabel, device_secret: createSecret() } satisfies GuestCreate,
    };
    await savePendingRegistration(apiBase, pending);
    setPendingRegistration(pending);
    if (!navigator.onLine) {
      setNotice("登録情報を端末内に保存しました。接続すると同じ登録内容を再送します。");
      return;
    }
    await completeRegistration(pending);
  }

  async function retryRegistration() {
    if (!navigator.onLine) throw new Error("登録を再試行するにはインターネット接続が必要です。");
    const pending = await getPendingRegistration(apiBase);
    if (!pending) throw new Error("再試行する登録はありません。新しく参加できます。");
    setPendingRegistration(pending);
    await completeRegistration(pending);
  }

  async function addDevice() {
    if (!credential) throw new Error("登録済み本人端末を選んでください。");
    if (!navigator.onLine) throw new Error("別の端末を追加するにはインターネット接続が必要です。");
    const inviteSecret = createSecret();
    await api.post("/guest/transfers", { operation_id: newOperationId(), invite_secret: inviteSecret }, credential.device_secret);
    setInviteShareLink(inviteLink(globalThis.location.href, inviteSecret));
    setNotice("一度だけ使える端末追加リンクを作成しました。");
  }

  async function submitRecord(record: Omit<RecordCreate, "operation_id" | "participant_id">) {
    if (!credential || credential.participant_id !== selectedParticipantId) throw new Error("この閲覧名の本人端末は登録されていません。招待を受け取ってから回答してください。");
    const operationId = newOperationId();
    const body: RecordCreateBody = { ...record, operation_id: operationId };
    if (!navigator.onLine) {
      await enqueueRecord(apiBase, credential, operationId, record);
      await refreshOutbox();
      setNotice("端末内に送信待ちで保存しました。クラウドにはまだ反映されていません。");
      return "queued";
    }
    try {
      await api.post("/records", body, credential.device_secret);
      setNotice("クラウドに保存しました。");
      return "cloud";
    } catch (reason) {
      if (!isTransportFailure(reason)) throw reason;
      await enqueueRecord(apiBase, credential, operationId, record);
      await refreshOutbox();
      setNotice("通信に失敗したため、回答を端末内の送信待ちに保存しました。クラウドには未反映です。");
      return "queued";
    }
  }

  async function changeParticipant(nextId: string) {
    setSelectedParticipantId(nextId);
    await saveSelectedParticipant(apiBase, nextId);
  }

  async function loginAdmin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!navigator.onLine) { setError("管理者ログインにはインターネット接続が必要です。"); return; }
    try {
      const session = await api.post<{ session_token: string; expires_at: string }>("/admin/login", { password: adminPassword });
      setAdminToken(session.session_token);
      setAdminPassword("");
      setNotice(`管理者としてログインしました。セッション期限 ${formatJapaneseDateTime(session.expires_at)}。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "管理者ログインに失敗しました。"); }
  }

  async function logoutAdmin() {
    if (!adminToken) return;
    if (!navigator.onLine) { setError("管理者ログアウトには接続が必要です。接続回復後にもう一度操作してください。"); return; }
    try { await api.post("/admin/logout", {}, adminToken); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "ログアウトを確認できませんでした。"); }
    finally { setAdminToken(null); setView("answer"); setNotice("管理者セッションを終了しました。"); }
  }

  function loadMoreParticipants() {
    if (peopleNextCursor) void refreshParticipants(peopleNextCursor, true);
  }

  if (!booted) return <main className="app-shell loading-shell"><p role="status">端末内の回答と本人情報を確認しています…</p></main>;

  return <main className="app-shell">
    <header className="app-header">
      <a className="brand" href={basePath} aria-label="好きな曲アンケート・ホーム" onClick={(event) => { event.preventDefault(); setView("answer"); }}>
        <span className="brand-disc" aria-hidden="true"><span>♪</span></span><span className="brand-copy"><strong>好きな曲アンケート</strong><small>あなたの一曲を、みんなの記録に</small></span>
      </a>
      <label className="participant-picker">表示する参加者
        <select aria-label="表示する参加者" value={selectedParticipantId} onChange={(event) => void changeParticipant(event.target.value)}>
          <option value="">参加者を選ぶ</option>{participants.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      </label>
    </header>

    <nav className="main-nav" aria-label="メインメニュー">
      <button type="button" className={view === "answer" ? "active" : ""} aria-current={view === "answer" ? "page" : undefined} onClick={() => setView("answer")}>回答する</button>
      <button type="button" className={view === "rankings" ? "active" : ""} aria-current={view === "rankings" ? "page" : undefined} onClick={() => setView("rankings")}>みんなのランキング</button>
      <button type="button" className={view === "history" ? "active" : ""} aria-current={view === "history" ? "page" : undefined} onClick={() => setView("history")}>自分の記録</button>
      <button type="button" className={view === "personal" ? "active" : ""} aria-current={view === "personal" ? "page" : undefined} onClick={() => setView("personal")}>個人統計</button>
      <span className="nav-spacer" />
      <button type="button" className={`admin-entry${view === "admin" ? " active" : ""}`} aria-current={view === "admin" ? "page" : undefined} onClick={() => setView("admin")}>{adminToken ? "管理画面" : "管理者ログイン"}</button>
    </nav>

    <section className="status-line" aria-live="polite">
      <span className={`online-state ${online ? "is-online" : "is-offline"}`}><span className="status-dot" />{online ? "オンライン" : "オフライン"}</span>
      {pendingCount > 0 && <span>送信待ち {pendingCount}件</span>}
      {!apiBase && <span className="notice-inline">API接続先が未設定です。管理者が配布環境を設定してください。</span>}
      {peopleNextCursor && <button type="button" className="small-link" onClick={loadMoreParticipants}>参加者をもっと読み込む</button>}
    </section>

    {(notice || error) && <div className={`global-message ${error ? "notice-error" : "notice-success"}`} role={error ? "alert" : "status"}>
      <div>{error && <span>{error}</span>}{notice && <span className="message-detail" role={error ? "status" : undefined}>{notice}</span>}</div>
      <button type="button" aria-label="メッセージを閉じる" onClick={() => { setError(""); setNotice(""); }}>閉じる</button>
    </div>}
    {updateWaiting && <div className="update-banner" role="status"><span>新しいアプリ版を利用できます。</span><button type="button" className="primary-button" onClick={() => updateWaiting.postMessage({ type: "SKIP_WAITING" })}>更新して再読み込み</button></div>}

    {view === "answer" && <AnswerPanel api={api} selectedParticipant={currentParticipant} credential={credential} pendingCount={pendingCount} online={online} pendingRegistration={pendingRegistration ?? undefined} onRetryRegistration={retryRegistration} onCreateGuest={createGuest} onSubmit={submitRecord} onAddDevice={addDevice} />}
    {view === "rankings" && <StatisticsPanel api={api} mode="rankings" />}
    {view === "history" && <HistoryPanel api={api} participant={currentParticipant} credential={credential} online={online} />}
    {view === "personal" && <StatisticsPanel api={api} mode="personal" participantId={selectedParticipantId || undefined} />}
    {view === "admin" && (adminToken
      ? <AdminPanel api={api} token={adminToken} onLogout={logoutAdmin} />
      : <section className="login-panel content-panel"><p className="eyebrow">管理者専用</p><h2>管理者ログイン</h2><p>管理操作には接続が必要です。セッションはこの画面を閉じると破棄されます。</p>
        <form onSubmit={loginAdmin}><label>管理者パスワード<input type="password" aria-label="管理者パスワード" autoComplete="current-password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} required /></label><button className="primary-button" type="submit" disabled={!online}>ログイン</button></form>
      </section>)}

    {inviteShareLink && <div className="modal-backdrop"><InviteShare title="別の端末を追加" link={inviteShareLink} onClose={() => setInviteShareLink("")} /></div>}
    <footer className="app-footer"><span>記録日は日本時間で集計されます。</span></footer>
  </main>;
}
