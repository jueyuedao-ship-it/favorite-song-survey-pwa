// @vitest-environment jsdom
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { clearLocalState, getPendingRegistration } from "./storage";

const API_BASE = "http://127.0.0.1:8791/api/v1";

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

const participant = {
  id: "p-invite",
  revision: 1,
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  deleted_at: null,
  name: "葵",
};

beforeEach(async () => {
  await clearLocalState(API_BASE);
  window.history.replaceState({}, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("招待リンクからのアカウントログイン", () => {
  it("URLを開いただけではclaimせず、貼り付けてログインしたときだけ端末登録する", async () => {
    const inviteSecret = "a".repeat(43);
    let claimCount = 0;
    let claimBody: Record<string, unknown> | undefined;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/participants")) {
        return result({ items: [participant], next_cursor: null });
      }
      if (url.pathname.endsWith("/guest/claim") && init.method === "POST") {
        claimCount++;
        claimBody = JSON.parse(String(init.body));
        return result({ participant, device_id: "device-invite" }, 201);
      }
      return failure("NOT_FOUND", "見つかりません", 404);
    }) as unknown as typeof fetch;

    window.history.replaceState({}, "", `/#invite=${inviteSecret}`);
    const user = userEvent.setup();
    render(<App apiBase={API_BASE} fetcher={mockFetch} />);

    await screen.findByRole("button", { name: "アカウントログイン" });
    expect(claimCount).toBe(0);
    expect(window.location.hash).toBe(`#invite=${inviteSecret}`);

    await user.click(screen.getByRole("button", { name: "アカウントログイン" }));
    fireEvent.change(screen.getByLabelText("招待リンク"), {
      target: { value: `https://survey.example/app/#invite=${inviteSecret}` },
    });
    await user.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByText("葵さんの本人端末")).toBeInTheDocument();
    expect(claimCount).toBe(1);
    expect(claimBody?.invite_secret).toBe(inviteSecret);
    expect(claimBody?.device_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claimBody?.operation_id).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(getPendingRegistration(API_BASE)).resolves.toBeUndefined());
  });

  it("形式が不正な招待リンクはclaimせずエラーにする", async () => {
    let claimCount = 0;
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/participants")) {
        return result({ items: [participant], next_cursor: null });
      }
      if (url.pathname.endsWith("/guest/claim") && init.method === "POST") {
        claimCount++;
      }
      return failure("NOT_FOUND", "見つかりません", 404);
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<App apiBase={API_BASE} fetcher={mockFetch} />);
    await user.click(await screen.findByRole("button", { name: "アカウントログイン" }));
    fireEvent.change(screen.getByLabelText("招待リンク"), {
      target: { value: "https://survey.example/app/#invite=short" },
    });
    await user.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("招待リンクの形式が正しくありません。");
    expect(claimCount).toBe(0);
  });
});
