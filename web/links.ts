export function inviteLink(pageUrl: string, secret: string): string {
  const url = new URL(pageUrl);
  url.hash = `invite=${secret}`;
  return url.toString();
}

export function inviteSecretFromHash(hash: string): string | undefined {
  const match = /^#invite=([A-Za-z0-9_-]{43})$/u.exec(hash);
  return match?.[1];
}

export function clearInviteHash(): void {
  const url = new URL(globalThis.location.href);
  url.hash = "";
  globalThis.history.replaceState(null, "", `${url.pathname}${url.search}`);
}
