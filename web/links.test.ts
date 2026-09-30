import { describe, expect, it } from "vitest";
import { inviteLink, inviteSecretFromHash } from "./links";

describe("招待リンク", () => {
  it("招待能力をURLフラグメントに置き、クエリや履歴パスへ出さない", () => {
    const link = inviteLink("https://survey.example/app/", "x".repeat(43));
    const url = new URL(link);
    expect(url.hash).toBe(`#invite=${"x".repeat(43)}`);
    expect(url.search).toBe("");
    expect(inviteSecretFromHash(url.hash)).toBe("x".repeat(43));
    expect(inviteSecretFromHash("#anything=untrusted")).toBeUndefined();
  });
});
