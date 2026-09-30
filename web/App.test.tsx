// @vitest-environment jsdom
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  clearLocalState,
  getPendingRegistration,
  listOutbox,
  saveCredential,
  saveSelectedParticipant,
} from "./storage";

const API_BASE = "http://127.0.0.1:8791/api/v1";
let activeFetch: typeof fetch | undefined;

function result(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const participant = (id: string, name: string) => ({
  id,
  revision: 1,
  created_at: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-09-30T00:00:00.000Z",
  deleted_at: null,
  name,
});

const version = (id: string, title: string, workTitle = "夜明け") => ({
  id,
  revision: 1,
  created_at: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-09-30T00:00:00.000Z",
  deleted_at: null,
  work_id: `work-${id}`,
  title,
  kind: "cover",
  reference_url: null,
  uploader_entity_id: null,
  research_status: "complete",
  manual_lock: false,
  work_title: workTitle,
  credits: [],
});

function installApi(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const mockFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  activeFetch = mockFetch;
  vi.stubGlobal("fetch", mockFetch);
  return calls;
}

function renderApp() {
  if (!activeFetch) throw new Error("Install the fixture API before rendering App.");
  return render(<App apiBase={API_BASE} fetcher={activeFetch} />);
}

async function seedIdentity(id: string, name: string, secret: string) {
  const person = participant(id, name);
  await saveCredential(API_BASE, {
    participant_id: id,
    participant: person,
    device_id: `device-${id}`,
    device_secret: secret,
  });
  return person;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  activeFetch = undefined;
  await clearLocalState(API_BASE);
  window.history.replaceState({}, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  activeFetch = undefined;
});

describe("回答と端末の本人情報", () => {
  it("初参加者が名前を作り、候補を選んで回答をクラウドへ送る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T14:59:59.000Z"));
    let guestBody: Record<string, unknown> | undefined;
    let recordBody: Record<string, unknown> | undefined;
    let guestAuthorization = "";
    const calls = installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/guest/create")) {
        guestBody = JSON.parse(String(init.body));
        return result({ participant: participant("p-new", "凛"), device_id: "d-new" }, 201);
      }
      if (url.pathname.endsWith("/catalog/search")) {
        return result({ items: [version("v-night", "夜明け - cover")], next_cursor: null });
      }
      if (url.pathname.endsWith("/records") && init.method === "POST") {
        guestAuthorization = new Headers(init.headers).get("Authorization") ?? "";
        recordBody = JSON.parse(String(init.body));
        return result({
          id: "r-new",
          revision: 1,
          participant_id: "p-new",
          version_id: "v-night",
          record_date: "2026-09-30",
          unresolved_title: null,
        }, 201);
      }
      return failure("NOT_FOUND", `${url.pathname} は未定義です`, 404);
    });

    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "新しく参加する" }));
    await user.type(screen.getByLabelText("お名前"), "凛");
    await user.click(screen.getByRole("button", { name: "参加登録" }));

    await user.type(await screen.findByLabelText("曲名"), "夜明け");
    await user.click(screen.getByRole("button", { name: "曲を検索" }));
    await user.click(await screen.findByRole("button", { name: /夜明け - cover/ }));
    await user.click(screen.getByRole("button", { name: "回答を送信" }));

    await screen.findAllByText("クラウドに保存しました。");
    expect(guestBody?.name).toBe("凛");
    expect(guestBody?.device_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(guestBody?.operation_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(calls.find(({ url }) => url.pathname.endsWith("/guest/create"))?.url.origin).toBe("http://127.0.0.1:8791");
    expect(guestAuthorization).toBe(`Bearer ${guestBody?.device_secret}`);
    expect(recordBody).toMatchObject({ version_id: "v-night", record_date: "2026-09-30" });
    expect(recordBody?.participant_id).toBeUndefined();
  });

  it("同名候補は作品名とクレジットを示し、選んだ版だけを回答に使う", async () => {
    const alice = await seedIdentity("p-alice", "葵", "alice-capability");
    await saveSelectedParticipant(API_BASE, alice.id);
    let submitted: Record<string, unknown> | undefined;
    installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [alice], next_cursor: null });
      if (url.pathname.endsWith("/catalog/search")) {
        return result({
          items: [
            { ...version("v-cover", "夜明け (cover)"), credits: [{ entity_name: "倚水" }] },
            { ...version("v-live", "夜明け (live)"), credits: [{ entity_name: "青葉" }] },
          ],
          next_cursor: null,
        });
      }
      if (url.pathname.endsWith("/records") && init.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return result({ id: "r-1", revision: 1, participant_id: alice.id, version_id: "v-cover", record_date: "2026-09-30" }, 201);
      }
      return failure("NOT_FOUND", "見つかりません", 404);
    });

    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText("曲名"), "夜明け");
    await user.click(screen.getByRole("button", { name: "曲を検索" }));
    expect(await screen.findByText("同名の候補が2件あります。作品と歌唱版を確認してください。")).toBeInTheDocument();
    expect(screen.getByText("倚水")).toBeInTheDocument();
    expect(screen.getByText("青葉")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /夜明け \(cover\)/ }));
    await user.click(screen.getByRole("button", { name: "回答を送信" }));
    await screen.findAllByText("クラウドに保存しました。");
    expect(submitted?.version_id).toBe("v-cover");
  });

  it("端末登録の要求を先に保存し、応答が失われた後も同じ秘密と操作IDで再送する", async () => {
    let attempts = 0;
    const bodies: Record<string, unknown>[] = [];
    const handler = (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/guest/create")) {
        attempts++;
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (attempts === 1) throw new TypeError("server accepted but response was lost");
        return result({ participant: participant("p-retry", String(body.name)), device_id: "device-retry" }, 201);
      }
      return failure("NOT_FOUND", "見つかりません", 404);
    };
    installApi(handler);
    const user = userEvent.setup();
    const first = renderApp();
    await user.click(await screen.findByRole("button", { name: "新しく参加する" }));
    await user.type(screen.getByLabelText("お名前"), "澪");
    await user.click(screen.getByRole("button", { name: "参加登録" }));
    await screen.findByText(/接続回復後に再試行/u);
    expect(attempts).toBe(1);
    const saved = await getPendingRegistration(API_BASE);
    expect(saved?.kind).toBe("create");
    expect(saved?.request).toEqual(bodies[0]);
    first.unmount();

    installApi(handler);
    renderApp();
    await waitFor(() => expect(attempts).toBe(2));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]?.device_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bodies[0]?.operation_id).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(async () => expect(await getPendingRegistration(API_BASE)).toBeUndefined());
    expect(await screen.findByText("澪さんの本人端末")).toBeInTheDocument();
  });

  it("登録ボタンをもう一度押しても失われた応答の同じ要求を再利用する", async () => {
    let attempts = 0;
    const bodies: Record<string, unknown>[] = [];
    installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/guest/create")) {
        attempts++;
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (attempts === 1) throw new TypeError("response lost after server accepted registration");
        if (JSON.stringify(body) !== JSON.stringify(bodies[0])) return failure("CONFLICT", "同じ名前です", 409);
        return result({ participant: participant("p-click-retry", String(body.name)), device_id: "device-click-retry" }, 201);
      }
      return failure("NOT_FOUND", "見つかりません", 404);
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "新しく参加する" }));
    await user.type(screen.getByLabelText("お名前"), "澪");
    await user.click(screen.getByRole("button", { name: "参加登録" }));
    await user.click(await screen.findByRole("button", { name: "登録を再試行" }));
    await screen.findByText("澪さんの本人端末");

    expect(attempts).toBe(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await getPendingRegistration(API_BASE)).toBeUndefined();
  });

  it("オフライン回答を再起動後も元の端末権限と操作IDで再送する", async () => {
    const alice = await seedIdentity("p-alice", "葵", "alice-device-secret");
    const bob = await seedIdentity("p-bob", "陸", "bob-device-secret");
    await saveSelectedParticipant(API_BASE, alice.id);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    installApi((url) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [alice, bob], next_cursor: null });
      return failure("NOT_FOUND", "見つかりません", 404);
    });

    const user = userEvent.setup();
    const first = renderApp();
    await user.type(await screen.findByLabelText("曲名"), "未特定の歌");
    await user.click(screen.getByRole("button", { name: "未特定の曲として送信" }));
    await screen.findByText("端末内に送信待ちで保存しました。クラウドにはまだ反映されていません。");
    const [queued] = await listOutbox(API_BASE);
    expect(queued.participant_id).toBe(alice.id);
    expect(queued.device_secret).toBe("alice-device-secret");
    expect(queued.operation_id).toMatch(/^[0-9a-f-]{36}$/i);

    fireEvent.change(screen.getByLabelText("表示する参加者"), { target: { value: bob.id } });
    first.unmount();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const replayBodies: Record<string, unknown>[] = [];
    const replayHeaders: string[] = [];
    let postNumber = 0;
    installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [alice, bob], next_cursor: null });
      if (url.pathname.endsWith("/records") && init.method === "POST") {
        postNumber++;
        replayBodies.push(JSON.parse(String(init.body)));
        replayHeaders.push(new Headers(init.headers).get("Authorization") ?? "");
        if (postNumber === 1) throw new TypeError("network down");
        return result({ id: "r-offline", revision: 1, participant_id: alice.id, version_id: null, unresolved_title: "未特定の歌", record_date: "2026-09-30" }, 201);
      }
      return result({ items: [], next_cursor: null });
    });
    const second = renderApp();
    await waitFor(() => expect(postNumber).toBe(1));
    await waitFor(() => expect(listOutbox(API_BASE)).resolves.toHaveLength(1));
    second.unmount();

    renderApp();
    await waitFor(() => expect(postNumber).toBe(2));
    await waitFor(() => expect(listOutbox(API_BASE)).resolves.toHaveLength(0));
    expect(replayBodies[0]).toEqual(replayBodies[1]);
    expect(replayBodies[0]?.operation_id).toBe(queued.operation_id);
    expect(replayHeaders).toEqual(["Bearer alice-device-secret", "Bearer alice-device-secret"]);
    expect(await screen.findByLabelText("表示する参加者")).toHaveValue(bob.id);
  });

  it("閲覧名の変更では編集権が移らず、登録端末の本人記録だけに編集操作を出す", async () => {
    const alice = await seedIdentity("p-alice", "葵", "alice-device-secret");
    const bob = participant("p-bob", "陸");
    await saveSelectedParticipant(API_BASE, bob.id);
    installApi((url) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [alice, bob], next_cursor: null });
      if (url.pathname.endsWith("/records")) {
        const id = url.searchParams.get("participant_id");
        const owner = id === alice.id ? alice : bob;
        return result({
          items: [{ id: `record-${owner.id}`, revision: 1, participant_id: owner.id, version_id: null, unresolved_title: `${owner.name}の曲`, record_date: "2026-09-29", deleted_at: null }],
          next_cursor: null,
        });
      }
      return result({ items: [], next_cursor: null });
    });

    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "自分の記録" }));
    expect(await screen.findByText("陸の曲")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /編集/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("表示する参加者"), { target: { value: alice.id } });
    expect(await screen.findByText("葵の曲")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /編集/ })).toBeInTheDocument();
  });
});

describe("管理と統計", () => {
  it("管理者だけがマスタ行を編集し、変更履歴へ訂正を追加できる", async () => {
    const audit = {
      id: "audit-1",
      revision: 1,
      table: "works",
      row_id: "work-1",
      action: "update",
      actor_type: "admin",
      before: { title: "旧題" },
      after: { title: "仮の題" },
      effective: { title: "仮の題" },
    };
    const calls = installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/admin/login")) return result({ session_token: "memory-admin-token", expires_at: "2026-09-30T08:00:00Z" });
      if (url.pathname.endsWith("/admin/data/works") && init.method === "GET") return result({ items: [{ id: "work-1", revision: 2, title: "仮の題", manual_lock: false }], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/works/work-1") && init.method === "PATCH") return result({ id: "work-1", revision: 3, title: "正式な曲名", manual_lock: true });
      if (url.pathname.endsWith("/admin/audit") && init.method === "GET") return result({ items: [audit], next_cursor: null });
      if (url.pathname.endsWith("/admin/audit/audit-1/corrections") && init.method === "POST") return result({ id: "correction-1", audit_id: "audit-1", reason: "入力を確認", corrected: { title: "正式な曲名" } }, 201);
      return failure("NOT_FOUND", "見つかりません", 404);
    });

    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "管理者ログイン" }));
    await user.type(screen.getByLabelText("管理者パスワード"), " raw admin password ");
    await user.click(screen.getByRole("button", { name: "ログイン" }));
    await user.click(await screen.findByRole("button", { name: "管理画面" }));
    await user.click(await screen.findByRole("button", { name: "カタログ" }));
    await user.selectOptions(screen.getByLabelText("対象テーブル"), "works");
    await waitFor(() => expect(calls.some(({ url, init }) => url.pathname.endsWith("/admin/data/works") && init.method === "GET")).toBe(true));
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await screen.findByDisplayValue("仮の題");
    await user.clear(screen.getByLabelText("作品名"));
    await user.type(screen.getByLabelText("作品名"), "正式な曲名");
    await user.click(screen.getByRole("button", { name: "変更を保存" }));
    await user.click(screen.getByRole("button", { name: "変更履歴" }));
    await user.click(await screen.findByRole("button", { name: "この履歴を訂正" }));
    await user.type(screen.getByLabelText("訂正理由"), "入力を確認");
    fireEvent.change(screen.getByLabelText("訂正後のJSON"), { target: { value: '{"title":"正式な曲名"}' } });
    await user.click(screen.getByRole("button", { name: "履歴を訂正" }));

    await waitFor(() => expect(calls.some(({ url, init }) => url.pathname.endsWith("/admin/audit/audit-1/corrections") && init.method === "POST")).toBe(true));
    const patch = calls.find(({ url, init }) => url.pathname.endsWith("/admin/data/works/work-1") && init.method === "PATCH");
    expect(new Headers(patch?.init.headers).get("Authorization")).toBe("Bearer memory-admin-token");
    expect(JSON.parse(String(patch?.init.body))).toMatchObject({ expected_revision: 2, values: { title: "正式な曲名" } });
    expect(calls.find(({ url }) => url.pathname.endsWith("/admin/login"))?.init.body).toBe('{"password":" raw admin password "}');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("カタログ編集フォームはテーブル切替直後に閉じて旧行を送信対象に残さない", async () => {
    let resolveVersions!: (response: Response) => void;
    const pendingVersions = new Promise<Response>((resolve) => { resolveVersions = resolve; });
    installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/admin/login")) return result({ session_token: "memory-admin-token", expires_at: "2026-09-30T08:00:00Z" });
      if (url.pathname.endsWith("/admin/data/works") && init.method === "GET") return result({ items: [{ id: "work-1", revision: 2, title: "旧作品" }], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/versions") && init.method === "GET") return pendingVersions;
      return failure("NOT_FOUND", "見つかりません", 404);
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "管理者ログイン" }));
    await user.type(screen.getByLabelText("管理者パスワード"), "secret");
    await user.click(screen.getByRole("button", { name: "ログイン" }));
    await user.click(await screen.findByRole("button", { name: "管理画面" }));
    await user.click(await screen.findByRole("button", { name: "カタログ" }));
    await screen.findByText("旧作品");
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await screen.findByDisplayValue("旧作品");

    await user.selectOptions(screen.getByLabelText("対象テーブル"), "versions");
    try {
      expect(screen.queryByRole("button", { name: "変更を保存" })).not.toBeInTheDocument();
    } finally {
      resolveVersions(result({ items: [], next_cursor: null }));
    }
  });

  it("DBフォームで編集対象のテーブルを切り替えると、そのテーブルへ保存する", async () => {
    const calls = installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/admin/login")) return result({ session_token: "memory-admin-token", expires_at: "2026-09-30T08:00:00Z" });
      if (url.pathname.endsWith("/admin/data/participants") && init.method === "GET") return result({ items: [{ id: "p-1", revision: 1, name: "参加者" }], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/works") && init.method === "GET") return result({ items: [{ id: "work-1", revision: 2, title: "以前の作品" }], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/works/work-1") && init.method === "PATCH") return result({ id: "work-1", revision: 3, title: "更新作品" });
      return failure("NOT_FOUND", "見つかりません", 404);
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "管理者ログイン" }));
    await user.type(screen.getByLabelText("管理者パスワード"), "secret");
    await user.click(screen.getByRole("button", { name: "ログイン" }));
    await user.click(await screen.findByRole("button", { name: "管理画面" }));
    await user.click(await screen.findByRole("button", { name: "DBフォーム" }));
    await user.selectOptions(screen.getByLabelText("データ表"), "works");
    await screen.findByText("以前の作品");
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.clear(screen.getByLabelText("作品名"));
    await user.type(screen.getByLabelText("作品名"), "更新作品");
    await user.click(screen.getByRole("button", { name: "変更を保存" }));
    await waitFor(() => expect(calls.some(({ url, init }) => url.pathname.endsWith("/admin/data/works/work-1") && init.method === "PATCH")).toBe(true));
    const patch = calls.find(({ url, init }) => url.pathname.endsWith("/admin/data/works/work-1") && init.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body))).toMatchObject({ expected_revision: 2, values: { title: "更新作品" } });
  });

  it("参照URLを空にして保存すると、既存値をnullへ更新する", async () => {
    const work = { id: "work-1", revision: 1, title: "原曲" };
    const entity = { id: "entity-1", revision: 1, name: "歌い手" };
    const existing = { id: "version-1", revision: 4, work_id: work.id, title: "カバー", kind: "cover", reference_url: "https://example.test/song", uploader_entity_id: entity.id, research_status: "complete", manual_lock: false };
    const calls = installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/admin/login")) return result({ session_token: "memory-admin-token", expires_at: "2026-09-30T08:00:00Z" });
      if (url.pathname.endsWith("/admin/data/versions") && init.method === "GET") return result({ items: [existing], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/works") && init.method === "GET") return result({ items: [work], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/entities") && init.method === "GET") return result({ items: [entity], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/versions/version-1") && init.method === "PATCH") return result({ ...existing, revision: 5, reference_url: null });
      return result({ items: [], next_cursor: null });
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "管理者ログイン" }));
    await user.type(screen.getByLabelText("管理者パスワード"), "secret");
    await user.click(screen.getByRole("button", { name: "ログイン" }));
    await user.click(await screen.findByRole("button", { name: "管理画面" }));
    await user.click(await screen.findByRole("button", { name: "カタログ" }));
    await user.selectOptions(screen.getByLabelText("対象テーブル"), "versions");
    await screen.findByRole("heading", { name: "カバー" });
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.clear(screen.getByLabelText("参照URL"));
    await user.click(screen.getByRole("button", { name: "変更を保存" }));
    await waitFor(() => expect(calls.some(({ url, init }) => url.pathname.endsWith("/admin/data/versions/version-1") && init.method === "PATCH")).toBe(true));
    const patch = calls.find(({ url, init }) => url.pathname.endsWith("/admin/data/versions/version-1") && init.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body)).values.reference_url).toBeNull();
  });

  it("招待・端末・調査ジョブ一覧の続きを読み込める", async () => {
    const alice = participant("p-alice", "葵");
    const calls = installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [alice], next_cursor: null });
      if (url.pathname.endsWith("/admin/login")) return result({ session_token: "memory-admin-token", expires_at: "2026-09-30T08:00:00Z" });
      if (url.pathname.endsWith("/admin/participants")) return result({ items: [alice], next_cursor: null });
      if (url.pathname.endsWith("/admin/invites")) {
        return url.searchParams.has("cursor")
          ? result({ items: [{ id: "invite-2", participant_id: "p-later", expires_at: "2026-10-02T00:00:00Z", claimed_at: null }], next_cursor: null })
          : result({ items: [{ id: "invite-1", participant_id: alice.id, expires_at: "2026-10-01T00:00:00Z", claimed_at: null }], next_cursor: "invite-1" });
      }
      if (url.pathname.endsWith("/admin/devices")) {
        return url.searchParams.has("cursor")
          ? result({ items: [{ id: "device-2", revision: 1, participant_id: alice.id, label: "二台目", revoked_at: null }], next_cursor: null })
          : result({ items: [{ id: "device-1", revision: 1, participant_id: alice.id, label: "一台目", revoked_at: null }], next_cursor: "device-1" });
      }
      if (url.pathname.endsWith("/admin/jobs")) {
        return url.searchParams.has("cursor")
          ? result({ items: [{ id: "job-2", revision: 1, query: { title: "後半の調査" }, status: "failed", attempts: 1 }], next_cursor: null })
          : result({ items: [{ id: "job-1", revision: 1, query: { title: "前半の調査" }, status: "failed", attempts: 1 }], next_cursor: "job-1" });
      }
      if (url.pathname.endsWith("/admin/usage")) return result({ month: "2026-09", tavily_credits: 0, tavily_credit_cap: 800, groq_requests: 0, configured: {} });
      if (url.pathname.endsWith("/admin/sync-status")) return result({ items: [], high_watermark: 0 });
      if (url.pathname.endsWith("/health")) return result({ configured: { admin: true, sync: false, groq: false, tavily: false, research_runner: false } });
      if (url.pathname.endsWith("/admin/data/usage")) return result({ items: [], next_cursor: null });
      return result({ items: [], next_cursor: null });
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "管理者ログイン" }));
    await user.type(screen.getByLabelText("管理者パスワード"), "secret");
    await user.click(screen.getByRole("button", { name: "ログイン" }));
    await user.click(await screen.findByRole("button", { name: "管理画面" }));
    await screen.findByRole("heading", { name: "葵" });
    await user.click(await screen.findByRole("button", { name: "招待をもっと読み込む" }));
    await waitFor(() => expect(calls.some(({ url }) => url.pathname.endsWith("/admin/invites") && url.searchParams.get("cursor") === "invite-1")).toBe(true));

    await user.click(screen.getByRole("button", { name: "端末を見る" }));
    await screen.findByText("一台目");
    await user.click(await screen.findByRole("button", { name: "端末をもっと読み込む" }));
    await screen.findByText("二台目");
    expect(calls.some(({ url }) => url.pathname.endsWith("/admin/devices") && url.searchParams.get("cursor") === "device-1")).toBe(true);

    await user.click(screen.getByRole("button", { name: "運用状況" }));
    await screen.findByText("前半の調査");
    await user.click(await screen.findByRole("button", { name: "調査をもっと読み込む" }));
    await screen.findByText("後半の調査");
    expect(calls.some(({ url }) => url.pathname.endsWith("/admin/jobs") && url.searchParams.get("cursor") === "job-1")).toBe(true);
  });

  it("カタログの関連名セレクターは後続ページの作品も選べる", async () => {
    const calls = installApi((url, init) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/admin/login")) return result({ session_token: "memory-admin-token", expires_at: "2026-09-30T08:00:00Z" });
      if (url.pathname.endsWith("/admin/data/works")) {
        return url.searchParams.has("cursor")
          ? result({ items: [{ id: "work-late", revision: 1, title: "後半作品" }], next_cursor: null })
          : result({ items: [{ id: "work-first", revision: 1, title: "前半作品" }], next_cursor: "work-first" });
      }
      if (url.pathname.endsWith("/admin/data/entities")) return result({ items: [], next_cursor: null });
      if (url.pathname.endsWith("/admin/data/versions")) return result({ items: [], next_cursor: null });
      return result({ items: [], next_cursor: null });
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "管理者ログイン" }));
    await user.type(screen.getByLabelText("管理者パスワード"), "secret");
    await user.click(screen.getByRole("button", { name: "ログイン" }));
    await user.click(await screen.findByRole("button", { name: "管理画面" }));
    await user.click(await screen.findByRole("button", { name: "カタログ" }));
    await user.selectOptions(screen.getByLabelText("対象テーブル"), "versions");
    await user.click(await screen.findByRole("button", { name: "新規登録" }));
    const workOptions = Array.from(screen.getByLabelText("作品").querySelectorAll("option")).map((option) => option.textContent);
    expect(workOptions).toContain("前半作品");
    expect(workOptions).toContain("後半作品");
    expect(calls.some(({ url }) => url.pathname.endsWith("/admin/data/works") && url.searchParams.get("cursor") === "work-first")).toBe(true);
  });

  it("人気順位は回答件数と支援人数を分け、タグ推移は件数・割合・未解析数を示す", async () => {
    const alice = participant("p-alice", "葵");
    const bob = participant("p-bob", "陸");
    await saveSelectedParticipant(API_BASE, alice.id);
    installApi((url) => {
      if (url.pathname.endsWith("/participants")) return result({ items: [alice, bob], next_cursor: null });
      if (url.pathname.endsWith("/statistics")) return result({
        from: "2026-09-28",
        to: "2026-10-04",
        group_by: "work",
        total_records: 4,
        unparsed_records: 1,
        rankings: [{ id: "work-1", title: "夜明け", count: 4, rank: 1, supporter_count: 2, supporters: [{ id: alice.id, name: alice.name }, { id: bob.id, name: bob.name }] }],
        roles: { vocalist: [], composer: [], release_name: [], uploader: [] },
        weekly_tags: [{ week_start: "2026-09-28", total_records: 4, unparsed_records: 1, tags: [
          { tag_id: "tag-1", name: "ロック", count: 3, percentage: 75 },
          { tag_id: "tag-2", name: "切ない", count: 2, percentage: 50 },
        ] }],
      });
      return result({ items: [], next_cursor: null });
    });

    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "みんなのランキング" }));
    expect(await screen.findByText("4件")).toBeInTheDocument();
    expect(screen.getByText("2人が記録")).toBeInTheDocument();
    expect(screen.getByText("葵、陸")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "個人統計" }));
    expect(await screen.findByRole("img", { name: "週ごとのタグ件数と割合" })).toBeInTheDocument();
    expect(screen.getByText("75％")).toBeInTheDocument();
    expect(screen.getByText("50％")).toBeInTheDocument();
    expect(screen.getByText("未解析 1件")).toBeInTheDocument();
    expect(screen.getByText(/複数のタグが付くため、割合の合計は100％を超えることがあります/)).toBeInTheDocument();
  });
});
it('管理者は招待を取り消せる', async () => {
 const alice=participant('p-alice','葵');
 const calls=installApi((url,init)=>{
   if(url.pathname.endsWith('/admin/login'))return result({session_token:'memory-admin-token',expires_at:'2026-10-01T08:00:00Z'});
   if(url.pathname.endsWith('/participants'))return result({items:[alice],next_cursor:null});
   if(url.pathname.endsWith('/admin/invites'))return result({items:[{id:'cancel-invite',revision:1,participant_id:alice.id,expires_at:'2099-10-02T00:00:00Z',claimed_at:null,deleted_at:null}],next_cursor:null});
   if(url.pathname.endsWith('/admin/invites/cancel-invite')&&init.method==='DELETE')return result({id:'cancel-invite',revision:2,deleted_at:'2026-10-01T00:00:00Z'});
   return result({items:[],next_cursor:null});
 });
 const user=userEvent.setup();renderApp();await user.click(await screen.findByRole('button',{name:'管理者ログイン'}));await user.type(screen.getByLabelText('管理者パスワード'),'secret');await user.click(screen.getByRole('button',{name:'ログイン'}));await user.click(await screen.findByRole('button',{name:'管理画面'}));await user.click(await screen.findByRole('button',{name:'この招待を取り消す'}));await screen.findByText('取り消し済み');const call=calls.find(c=>c.url.pathname.endsWith('/admin/invites/cancel-invite'));expect(call?.init.method).toBe('DELETE');expect(JSON.parse(String(call?.init.body))).toMatchObject({expected_revision:1});
});
