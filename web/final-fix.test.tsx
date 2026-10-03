// @vitest-environment jsdom
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { HistoryPanel } from "./HistoryPanel";
import { StatisticsPanel } from "./StatisticsPanel";
import { createApi } from "./api";
import { clearLocalState, enqueueRecord, listOutbox, saveCredential, saveSelectedParticipant } from "./storage";
import type { SongDetail, Statistics, SurveyRecord } from "../shared/contracts";
import type { StoredCredential } from "./storage";

const BASE = "http://127.0.0.1:8792/api/v1";
const rowBase = { revision: 1, created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", deleted_at: null };
const person = { ...rowBase, id: "p-a", name: "葵" };
const identity: StoredCredential = { participant_id: person.id, participant: person, device_id: "d-a", device_secret: "private-captured-capability" };
const record: SurveyRecord = { ...rowBase, id: "r-a", participant_id: person.id, version_id: "v-old", record_date: "2026-09-30", unresolved_title: null, artist_hint: "古い歌手", reference_url: "https://example.com/old" };
const detail = (title = "旧曲"): SongDetail => ({
  version: { ...rowBase, id: "v-old", title, work_id: "w-old", kind: "original", research_status: "unconfirmed", reference_url: null, uploader_entity_id: null, manual_lock: false },
  work: { ...rowBase, id: "w-old", title, manual_lock: false },
  credits: [{ ...rowBase, id: "c-a", version_id: "v-old", entity_id: "e-a", role: "vocalist", confirmed: false, manual_lock: false, source_id: null, entity: { ...rowBase, id: "e-a", name: "仮の歌手", kind: "person", manual_lock: false }, aliases: [] }], tags: [], sources: [],
});
const stats = (total = 4): Statistics => ({ from: "2026-09-28", to: "2026-10-04", group_by: "work", total_records: total, unparsed_records: 1, rankings: [], roles: { vocalist: [], composer: [], release_name: [], uploader: [] }, weekly_tags: [
  { week_start: "2026-09-21", total_records: 2, unparsed_records: 1, tags: [{ tag_id: "t", name: "ロック", count: 1, percentage: 50 }] },
  { week_start: "2026-09-28", total_records: 10, unparsed_records: 5, tags: [{ tag_id: "t", name: "ロック", count: 5, percentage: 50 }] },
] });
function result(data: unknown) { return Response.json({ data }); }
function failure(status: number) { return Response.json({ error: { code: "REJECTED", message: "private-captured-capability must never be displayed" } }, { status }); }
function fixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(new URL(String(input)), init)) as unknown as typeof fetch;
}
beforeEach(async () => {
  await clearLocalState(BASE);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("a delayed research start cannot populate a different record editor", async () => {
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  const other = {...record,id:"r-b",version_id:"v-b"};
  const fetcher = fixture(url => {
    if (url.pathname.endsWith("/research")) return delayed;
    if (url.pathname.endsWith("/candidates")) return result({response_id:record.id,status:"needs_review",candidates:[],last_error:null,tag_status:"needs_review",lookup_status:null});
    if (url.pathname.endsWith("/records")) return result({items:[record,other],next_cursor:null});
    if (url.pathname.includes("/catalog/versions/")) return result({...detail(),version:{...detail().version,id:url.pathname.endsWith("v-b")?"v-b":"v-old"}});
    throw new Error("Unexpected fixture route");
  });
  render(<HistoryPanel api={createApi(BASE,{fetch:fetcher})} participant={person} credential={identity} online />);
  const buttons=await screen.findAllByRole("button",{name:"編集"});
  fireEvent.click(buttons[0]); fireEvent.click(await screen.findByRole("button",{name:"曲候補を再検索"}));
  fireEvent.click(buttons[1]);
  await act(async()=>release(result({response_id:record.id,status:"complete",purpose:"candidate_lookup",candidates:[{...detail().version,id:"v-wrong",work_title:"wrong record candidate",credits:[]}],last_error:null})));
  expect(screen.queryByText(/wrong record candidate/)).not.toBeInTheDocument();
});
it("saved recording editor starts separate tag and web candidate requests and retains the selected recording", async () => {
  const requests: any[] = [];
  const fetcher = fixture((url, init) => {
    if (url.pathname.endsWith("/research")) {
      const body = JSON.parse(String(init.body)); requests.push(body);
      return result({ response_id: record.id, status: "queued", candidates: [], last_error: null, tag_status: body.kind === "tags" ? "queued" : "needs_review", lookup_status: body.kind === "candidates" ? "queued" : null });
    }
    if (url.pathname.endsWith("/candidates")) return result({ response_id: record.id, status: "needs_review", candidates: [], last_error: null, tag_status: "needs_review", lookup_status: null });
    if (url.pathname.endsWith("/records")) return result({ items: [record], next_cursor: null });
    if (url.pathname.endsWith("/catalog/versions/v-old")) return result(detail());
    throw new Error("Unexpected fixture route");
  });
  render(<HistoryPanel api={createApi(BASE, { fetch: fetcher })} participant={person} credential={identity} online />);
  fireEvent.click(await screen.findByRole("button", { name: "編集" }));
  fireEvent.click(await screen.findByRole("button", { name: "タグ調査開始" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ kind: "tags", expected_revision: 1 });
  fireEvent.click(screen.getByRole("button", { name: "曲候補を再検索" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toMatchObject({ kind: "candidates", expected_revision: 1 });
  expect(screen.getByRole("button", { name: "現在の曲を保持" })).toHaveAttribute("aria-pressed", "true");
});

it.each(["needs_review", "failed"])("owner sees stopped research instead of a waiting message: %s", async status => {
  const unresolved = { ...record, version_id: null, unresolved_title: "蜃気楼", artist_hint: "tayori" };
  const fetcher = fixture(url => {
    if (url.pathname.endsWith("/candidates")) return result({ response_id: record.id, status, candidates: [], last_error: "NO_SUPPORTED_RECORDINGS" });
    if (url.pathname.endsWith("/records")) return result({ items: [unresolved], next_cursor: null });
    throw new Error("Unexpected fixture route");
  });
  render(<HistoryPanel api={createApi(BASE, { fetch: fetcher })} participant={person} credential={identity} online />);
  fireEvent.click(await screen.findByRole("button", { name: "候補を確認" }));
  expect(await screen.findByText(/調査が停止しています/)).toBeInTheDocument();
  expect(screen.queryByText("候補はまだ見つかりません。")).not.toBeInTheDocument();
});

it("identified owner can select another catalog version and explicitly clear stale song hints", async () => {
  let saved: Record<string, unknown> | undefined;
  let bearer = "";
  const fetcher = fixture((url, init) => {
    if (init.method === "PATCH") { saved = JSON.parse(String(init.body)); bearer = new Headers(init.headers).get("authorization") ?? ""; return result({ ...record, ...saved }); }
    if (url.pathname.endsWith("/records")) return result({ items: [record], next_cursor: null });
    if (url.pathname.endsWith("/catalog/search")) return result({ items: [{ ...detail().version, id: "v-new", title: "新しい版", work_title: "新曲", credits: [] }], next_cursor: null });
    return result(detail());
  });
  render(<HistoryPanel api={createApi(BASE, { fetch: fetcher })} participant={person} credential={identity} online />);
  fireEvent.click(await screen.findByRole("button", { name: "編集" }));
  expect(screen.getByRole("button", { name: "現在の曲を保持" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("曲名"), { target: { value: "新曲" } });
  fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
  fireEvent.click(await screen.findByRole("button", { name: "新曲 · 新しい版" }));
  fireEvent.click(screen.getByRole("button", { name: "記録を保存" }));
  await waitFor(() => expect(saved).toMatchObject({ version_id: "v-new", expected_revision: 1, artist_hint: null, reference_url: null, unresolved_title: null }));
  expect(bearer).toBe("Bearer private-captured-capability");
  expect(saved?.participant_id).toBeUndefined();
});

it("identified owner can switch to unresolved while retaining date-only edits without losing hints", async () => {
  const updates: Record<string, unknown>[] = [];
  const fetcher = fixture((url, init) => {
    if (init.method === "PATCH") { const body = JSON.parse(String(init.body)); updates.push(body); return result({ ...record, ...body }); }
    if (url.pathname.endsWith("/records")) return result({ items: [record], next_cursor: null });
    return result(detail());
  });
  render(<HistoryPanel api={createApi(BASE, { fetch: fetcher })} participant={person} credential={identity} online />);
  fireEvent.click(await screen.findByRole("button", { name: "編集" }));
  fireEvent.click(screen.getByRole("button", { name: "記録を保存" }));
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).not.toHaveProperty("artist_hint");
  fireEvent.click(screen.getByRole("button", { name: "編集" }));
  fireEvent.change(screen.getByLabelText("曲名"), { target: { value: "別の未特定曲" } });
  fireEvent.click(screen.getByRole("button", { name: "未特定の曲名に切り替える" }));
  fireEvent.click(screen.getByRole("button", { name: "記録を保存" }));
  await waitFor(() => expect(updates[1]).toMatchObject({ version_id: null, unresolved_title: "別の未特定曲", artist_hint: null, reference_url: null }));
});

it("statistics sends a validated arbitrary range and anchor and switches actual bar scaling", async () => {
  const queries: URL[] = [];
  const api = createApi(BASE, { fetch: fixture((url) => { queries.push(url); return result(stats()); }) });
  render(<StatisticsPanel api={api} participantId={person.id} mode="personal" />);
  await screen.findByRole("img");
  fireEvent.change(screen.getByLabelText("集計期間"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-08-01" } });
  fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-08-31" } });
  fireEvent.change(screen.getByLabelText("基準日"), { target: { value: "2026-08-31" } });
  await waitFor(() => expect(queries.at(-1)?.searchParams.get("from")).toBe("2026-08-01"));
  expect(queries.at(-1)?.searchParams.get("to")).toBe("2026-08-31");
  expect(queries.at(-1)?.searchParams.get("anchor")).toBe("2026-08-31");
  expect(queries.at(-1)?.searchParams.get("participant_id")).toBe("p-a");
  const bars = () => [...screen.getByRole("img").querySelectorAll("rect")].map((bar) => Number(bar.getAttribute("width")));
  expect(bars()).toEqual([430, 430]);
  fireEvent.change(screen.getByLabelText("表示方法"), { target: { value: "count" } });
  expect(bars()).toEqual([86, 430]);
  const requests = queries.length;
  fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-09-02" } });
  await screen.findByRole("alert");
  expect(queries).toHaveLength(requests);
});

it("visible statistics refreshes every minute, coalesces foreground triggers and cleans up", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  let total = 4;
  let requests = 0;
  const api = createApi(BASE, { fetch: fixture(() => { requests++; return result(stats(total)); }) });
  const view = render(<StatisticsPanel api={api} mode="rankings" />);
  await waitFor(() => expect(screen.getByLabelText("集計概要")).toHaveTextContent("4"));
  total = 9;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getByLabelText("集計概要")).toHaveTextContent("9");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  total = 11;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getByLabelText("集計概要")).toHaveTextContent("9");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  expect(screen.getByLabelText("集計概要")).toHaveTextContent("11");
  expect(requests).toBe(3);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("offline duplicate retains its original operation while a later different answer reaches the cloud", async () => {
  await saveCredential(BASE, identity); await saveSelectedParticipant(BASE, person.id);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  // The trigger is chronological offline submission. Give entries distinct
  // captured times; same-millisecond IDB key order does not define FIFO.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
  for (const [operation, title] of [["one-operation", "同じ曲"], ["duplicate-operation", "同じ曲"], ["later-operation", "違う曲"]]) {
    await enqueueRecord(BASE, identity, operation, { version_id: null, record_date: "2026-09-30", unresolved_title: title });
    vi.setSystemTime(new Date(Date.now() + 1));
  }
  vi.useRealTimers();
  const saved = new Set<string>();
  const sent: string[] = [];
  const fetcher = fixture((url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)); sent.push(body.operation_id);
      if (saved.has(body.unresolved_title)) return failure(409);
      saved.add(body.unresolved_title); return result({ id: body.operation_id });
    }
    return result({ items: [person], next_cursor: null });
  });
  render(<App apiBase={BASE} fetcher={fetcher} />);
  await screen.findAllByText("オフライン");
  expect(sent).toEqual([]);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  fireEvent(window, new Event("online"));
  await waitFor(async () => expect(await listOutbox(BASE)).toHaveLength(1));
  expect(sent).toEqual(["one-operation", "duplicate-operation", "later-operation"]);
  expect([...saved]).toEqual(["同じ曲", "違う曲"]);
  expect((await listOutbox(BASE))[0]).toMatchObject({ operation_id: "duplicate-operation", failure: { status: 409 } });
});

it("a retained unknown revoked owner can remove a failure without granting the selected person write authority", async () => {
  const unknown = { ...identity, participant_id: "p-unknown", participant: { ...person, id: "p-unknown", name: "以前の参加者" }, device_secret: "revoked-captured-capability" };
  await enqueueRecord(BASE, unknown, "revoked-operation", { version_id: null, record_date: "2026-09-30", unresolved_title: "以前の曲" });
  await enqueueRecord(BASE, identity, "valid-operation", { version_id: null, record_date: "2026-09-29", unresolved_title: "葵の曲" });
  await saveSelectedParticipant(BASE, person.id);
  const bearers: string[] = [];
  const fetcher = fixture((url, init) => {
    if (init.method === "POST") { bearers.push(new Headers(init.headers).get("authorization") ?? ""); return JSON.parse(String(init.body)).operation_id === "revoked-operation" ? failure(401) : result({ id: "saved" }); }
    return result({ items: [person], next_cursor: null });
  });
  render(<App apiBase={BASE} fetcher={fetcher} />);
  await waitFor(async () => expect(await listOutbox(BASE)).toHaveLength(1));
  await screen.findByText("以前の参加者");
  expect(bearers).toEqual(["Bearer revoked-captured-capability", "Bearer private-captured-capability"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "この送信待ちを削除" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "この送信待ちを削除" }));
  fireEvent.click(screen.getByRole("button", { name: "削除を確定" }));
  await waitFor(async () => expect(await listOutbox(BASE)).toHaveLength(0));
  expect(bearers).toHaveLength(2);
});

it("statistics ignores a late response from an older participant selection", async () => {
  let finishOld!: (response: Response) => void;
  const api = createApi(BASE, { fetch: fixture((url) => url.searchParams.get("participant_id") === "p-a" ? new Promise<Response>((resolve) => { finishOld = resolve; }) : result(stats(17))) });
  const view = render(<StatisticsPanel api={api} participantId="p-a" mode="personal" />);
  view.rerender(<StatisticsPanel api={api} participantId="p-b" mode="personal" />);
  await waitFor(() => expect(screen.getByLabelText("集計概要")).toHaveTextContent("17"));
  await act(async () => { finishOld(result(stats(2))); });
  expect(screen.getByLabelText("集計概要")).toHaveTextContent("17");
});

it("history refreshes metadata and loaded pages while preserving the active edit draft", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  let title = "旧曲";
  const calls: string[] = [];
  const api = createApi(BASE, { fetch: fixture((url) => {
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/records")) return result(url.searchParams.has("cursor") ? { items: [{ ...record, id: "r-b", record_date: "2026-09-29" }], next_cursor: null } : { items: [record], next_cursor: "r-a" });
    return result(detail(title));
  }) });
  render(<HistoryPanel api={api} participant={person} credential={identity} online />);
  await screen.findByText("旧曲");
  expect(screen.getByText(/仮の歌手.*未確認/)).toBeInTheDocument();
  expect(screen.queryByText("記録日が新しい順です。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "履歴をもっと読み込む" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "編集" })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "編集" })[0]);
  fireEvent.change(screen.getByLabelText("曲名"), { target: { value: "保存前の草稿" } });
  title = "確認後の曲名";
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getAllByText("確認後の曲名")).toHaveLength(2);
  expect(screen.getByLabelText("曲名")).toHaveValue("保存前の草稿");
  expect(screen.getAllByRole("button", { name: "編集" })).toHaveLength(2);
  expect(calls.filter((path) => path.includes("cursor=r-a"))).toHaveLength(2);
});

it.each([409, 401, 400, 403, 404, 422])("outbox retains actionable %s failures, sends later independent entries and removes only on explicit action", async (status) => {
  await saveCredential(BASE, identity); await saveSelectedParticipant(BASE, person.id);
  await enqueueRecord(BASE, identity, "failed-operation", { version_id: null, record_date: "2026-09-30", unresolved_title: "重複した曲" });
  const other = { ...identity, participant_id: "p-b", participant: { ...person, id: "p-b", name: "陸" }, device_secret: "other-captured-secret" };
  await enqueueRecord(BASE, other, "valid-operation", { version_id: null, record_date: "2026-09-29", unresolved_title: "別の曲" });
  const sent: { body: Record<string, unknown>; bearer: string }[] = [];
  const fetcher = fixture((url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)); sent.push({ body, bearer: new Headers(init.headers).get("authorization") ?? "" });
      return body.operation_id === "failed-operation" ? failure(status) : result({ id: "saved" });
    }
    return result({ items: [person], next_cursor: null });
  });
  const view = render(<App apiBase={BASE} fetcher={fetcher} />);
  await waitFor(async () => expect(await listOutbox(BASE)).toHaveLength(1));
  expect(sent.map((item) => item.body.operation_id)).toEqual(["failed-operation", "valid-operation"]);
  expect(sent[1].bearer).toBe("Bearer other-captured-secret");
  const remaining = (await listOutbox(BASE))[0];
  expect(remaining).toMatchObject({ operation_id: "failed-operation", participant_id: "p-a", device_secret: "private-captured-capability", failure: { status } });
  expect(document.body).not.toHaveTextContent("private-captured-capability");
  view.unmount();
  render(<App apiBase={BASE} fetcher={fetcher} />);
  await screen.findByRole("button", { name: "この回答を再試行" });
  await waitFor(() => expect(screen.getByRole("button", { name: "この回答を再試行" })).toBeEnabled());
  expect(sent).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "この回答を再試行" }));
  await waitFor(() => expect(sent).toHaveLength(3));
  expect(sent[2]).toEqual(sent[0]);
  await waitFor(() => expect(screen.getByRole("button", { name: "この送信待ちを削除" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "この送信待ちを削除" }));
  await screen.findByRole("button", { name: "削除を確定" });
  expect(await listOutbox(BASE)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "削除を確定" }));
  await waitFor(async () => expect(await listOutbox(BASE)).toHaveLength(0));
});

it.each([429, 503, "transport"])("outbox stops on transient %s and preserves every entry", async (status) => {
  for (const operation of ["first-operation", "later-operation"]) await enqueueRecord(BASE, identity, operation, { version_id: null, record_date: "2026-09-30", unresolved_title: operation });
  const sent: string[] = [];
  const fetcher = fixture((url, init) => {
    if (init.method === "POST") { sent.push(JSON.parse(String(init.body)).operation_id); if (status === "transport") throw new TypeError("offline"); return failure(Number(status)); }
    return result({ items: [], next_cursor: null });
  });
  render(<App apiBase={BASE} fetcher={fetcher} />);
  await screen.findByText(/送信待ちの回答は端末に残しています/);
  expect(sent).toEqual(["first-operation"]);
  expect(await listOutbox(BASE)).toHaveLength(2);
});

it("public participant refresh retains loaded names and an active answer draft", async () => {
  await saveCredential(BASE, identity); await saveSelectedParticipant(BASE, person.id);
  let name = "葵";
  const fetcher = fixture((url) => result(url.searchParams.has("cursor")
    ? { items: [{ ...person, id: "p-b", name: "陸" }], next_cursor: null }
    : { items: [{ ...person, name }], next_cursor: "p-a" }));
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  render(<App apiBase={BASE} fetcher={fetcher} />);
  fireEvent.click(await screen.findByRole("button", { name: "参加者をもっと読み込む" }));
  await screen.findByRole("option", { name: "陸" });
  fireEvent.change(screen.getByLabelText("曲名"), { target: { value: "書きかけの回答" } });
  name = "葵の新しい名前";
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getByRole("option", { name: "葵の新しい名前" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "陸" })).toBeInTheDocument();
  expect(screen.getByLabelText("曲名")).toHaveValue("書きかけの回答");
  expect(screen.getByLabelText("表示する参加者")).toHaveValue("p-a");
});

it("history ignores old participant records and metadata arriving after switching", async () => {
  let finishOld!: (response: Response) => void;
  const api = createApi(BASE, { fetch: fixture((url) => {
    if (url.pathname.endsWith("/records") && url.searchParams.get("participant_id") === "p-a") return new Promise<Response>((resolve) => { finishOld = resolve; });
    if (url.pathname.endsWith("/records")) return result({ items: [{ ...record, id: "r-b", participant_id: "p-b", version_id: null, unresolved_title: "陸の曲" }], next_cursor: null });
    return result(detail());
  }) });
  const view = render(<HistoryPanel api={api} participant={person} online />);
  view.rerender(<HistoryPanel api={api} participant={{ ...person, id: "p-b", name: "陸" }} online />);
  await screen.findByText("陸の曲");
  await act(async () => { finishOld(result({ items: [record], next_cursor: null })); });
  expect(screen.getByText("陸の曲")).toBeInTheDocument();
  expect(screen.queryByText("旧曲")).not.toBeInTheDocument();
});
