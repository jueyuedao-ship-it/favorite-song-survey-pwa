import type { WorkerEnv, GuestIdentity } from "../../shared/contracts";
import {
  ApiError,
  conflict,
  invalid,
  sha256,
  stmt,
  getRow,
  type Actor,
  newRow,
  updated,
  now,
  check,
  requireKeys,
  activeReference,
  text,
  bodyOf,
  replyMutation,
} from "./store";
export function secret(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value))
    invalid("32バイト以上のランダムな端末資格情報が必要です");
  return value;
}
export function bearer(request: Request) {
  return (
    request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? ""
  );
}
export async function authenticate(
  request: Request,
  env: WorkerEnv,
  role: "guest" | "admin" | "sync",
): Promise<Actor> {
  const token = bearer(request);
  if (!token)
    throw new ApiError(401, "UNAUTHORIZED", "本人または管理者の認証が必要です");
  const hash = await sha256(token);
  if (role === "sync") {
    if (!env.SYNC_TOKEN_HASH)
      throw new ApiError(503, "NOT_CONFIGURED", "収集用資格情報が未設定です");
    if (!constantEqual(hash, env.SYNC_TOKEN_HASH))
      throw new ApiError(401, "UNAUTHORIZED", "収集用資格情報が無効です");
    return { id: "collector", type: "system" };
  }
  if (role === "admin") {
    const session = await stmt(
      env.DB,
      "SELECT id FROM admin_sessions WHERE token_hash=? AND expires_at>?",
      hash,
      new Date().toISOString(),
    ).first<{ id: string }>();
    if (!session)
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "管理者セッションが無効または期限切れです",
      );
    return { id: session.id, type: "admin" };
  }
  const device = await stmt(
    env.DB,
    "SELECT d.data FROM device_credentials c JOIN devices d ON c.device_id=d.id WHERE c.token_hash=? AND json_extract(d.data,'$.revoked_at') IS NULL AND json_extract(d.data,'$.deleted_at') IS NULL",
    hash,
  ).first<{ data: string }>();
  if (!device) throw new ApiError(401, "UNAUTHORIZED", "端末の権限が無効です");
  const row = JSON.parse(device.data);
  await getRow(env.DB, "participants", row.participant_id);
  return {
    id: row.id,
    type: "guest",
    device_id: row.id,
    participant_id: row.participant_id,
  };
}
export async function ownerOrAdmin(request: Request, env: WorkerEnv) {
  try {
    return await authenticate(request, env, "guest");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      return authenticate(request, env, "admin");
    throw error;
  }
}
export async function identity(
  env: WorkerEnv,
  actor: Actor,
): Promise<GuestIdentity> {
  return {
    participant: await getRow(env.DB, "participants", actor.participant_id!),
    device_id: actor.device_id!,
  };
}
export function owner(actor: Actor, participantId: string) {
  if (actor.type !== "admin" && actor.participant_id !== participantId)
    throw new ApiError(403, "FORBIDDEN", "他の参加者の記録は変更できません");
}
export function constantEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function passwordMatches(password: string, verifier: string) {
  const [, iterations, saltHex, keyHex] = verifier.split("$");
  if (!/^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(verifier))
    throw new ApiError(503, "NOT_CONFIGURED", "管理者の検証情報が未設定です");
  const salt = Uint8Array.from(saltHex.match(/../g)!, (v) => parseInt(v, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iterations), hash: "SHA-256" },
    key,
    256,
  );
  return constantEqual(
    [...new Uint8Array(bits)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join(""),
    keyHex,
  );
}
export async function login(
  request: Request,
  env: WorkerEnv,
  body: Record<string, any>,
) {
  if (!env.ADMIN_PASSWORD_HASH)
    throw new ApiError(503, "NOT_CONFIGURED", "管理者パスワードが未設定です");
  if (typeof body.password !== "string" || body.password.length > 1024)
    invalid();
  const bucket = await sha256(
      request.headers.get("CF-Connecting-IP") ?? "local",
    ),
    time = Date.now(),
    window = 15 * 60 * 1000;
  // One atomic statement reserves an attempt before expensive derivation, so parallel requests cannot bypass the cap.
  const result = await stmt(
    env.DB,
    `INSERT INTO login_limits(bucket,failures,window_start) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET failures=CASE WHEN window_start<? THEN 1 ELSE failures+1 END,window_start=CASE WHEN window_start<? THEN ? ELSE window_start END RETURNING failures`,
    bucket,
    time,
    time - window,
    time - window,
    time,
  ).first<{ failures: number }>();
  if (!result || result.failures > 5)
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "しばらく待ってから再試行してください",
    );
  if (!(await passwordMatches(body.password, env.ADMIN_PASSWORD_HASH)))
    throw new ApiError(401, "UNAUTHORIZED", "パスワードが違います");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const id = crypto.randomUUID(),
    expires_at = new Date(time + 8 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    stmt(
      env.DB,
      "INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES(?,?,?)",
      id,
      await sha256(token),
      expires_at,
    ),
    stmt(env.DB, "DELETE FROM login_limits WHERE bucket=?", bucket),
    stmt(
      env.DB,
      "DELETE FROM admin_sessions WHERE expires_at<?",
      new Date(time).toISOString(),
    ),
  ]);
  return { session_token: token, expires_at };
}

export async function createGuest(request: Request, env: WorkerEnv) {
  const body = await bodyOf(request);
  requireKeys(body, ["operation_id", "name", "device_label", "device_secret"]);
  const token = secret(body.device_secret),
    hash = await sha256(token),
    actor: Actor = { id: `registration:${hash}`, type: "system" };
  return replyMutation(env, actor, "POST:/guest/create", body, async () => {
    const participant = newRow({ name: text(body.name, 80) }),
      device = newRow({
        participant_id: participant.id,
        label: text(body.device_label, 80),
        revoked_at: null,
      });
    return {
      status: 201,
      data: { participant, device_id: device.id },
      changes: [
        { table: "participants", before: null, after: participant },
        { table: "devices", before: null, after: device },
      ],
      extra: [
        stmt(
          env.DB,
          "INSERT INTO device_credentials(device_id,token_hash) VALUES(?,?)",
          device.id,
          hash,
        ),
      ],
    };
  });
}
export async function claimGuest(request: Request, env: WorkerEnv) {
  const body = await bodyOf(request);
  requireKeys(body, [
    "operation_id",
    "invite_secret",
    "device_label",
    "device_secret",
  ]);
  const hash = await sha256(secret(body.device_secret)),
    inviteHash = await sha256(secret(body.invite_secret));
  const actor: Actor = { id: `claim:${hash}`, type: "system" };
  return replyMutation(env, actor, "POST:/guest/claim", body, async () => {
    const found = await stmt(
      env.DB,
      "SELECT invite_id FROM invite_credentials WHERE token_hash=?",
      inviteHash,
    ).first<{ invite_id: string }>();
    if (!found)
      throw new ApiError(401, "UNAUTHORIZED", "招待資格情報が無効です");
    const invite = await getRow(env.DB, "invites", found.invite_id);
    if (invite.claimed_at || invite.expires_at < now())
      conflict("招待は使用済みまたは期限切れです");
    const participant = await getRow(
        env.DB,
        "participants",
        invite.participant_id,
      ),
      device = newRow({
        participant_id: participant.id,
        label: text(body.device_label, 80),
        revoked_at: null,
      });
    return {
      status: 201,
      data: { participant, device_id: device.id },
      changes: [
        {
          table: "invites",
          before: invite,
          after: updated(invite, { claimed_at: now() }),
        },
        { table: "devices", before: null, after: device },
      ],
      guards: [
        activeReference(env.DB, "participants", participant.id),
        check(
          env.DB,
          "EXISTS(SELECT 1 FROM invites WHERE id=? AND json_extract(data,'$.claimed_at') IS NULL AND json_extract(data,'$.expires_at')>?)",
          invite.id,
          now(),
        ),
      ],
      extra: [
        stmt(
          env.DB,
          "INSERT INTO device_credentials(device_id,token_hash) VALUES(?,?)",
          device.id,
          hash,
        ),
      ],
    };
  });
}
export async function inviteCreate(
  request: Request,
  env: WorkerEnv,
  transfer: boolean,
) {
  const actor = await authenticate(request, env, transfer ? "guest" : "admin"),
    body = await bodyOf(request);
  requireKeys(body, ["operation_id", "participant_id", "invite_secret"]);
  if (transfer && body.participant_id) owner(actor, body.participant_id);
  const participantId = transfer
    ? actor.participant_id!
    : text(body.participant_id, 128);
  const hash = await sha256(secret(body.invite_secret));
  return replyMutation(
    env,
    actor,
    transfer ? "POST:/guest/transfers" : "POST:/admin/invites",
    body,
    async () => {
      await getRow(env.DB, "participants", participantId);
      const invite = newRow({
        participant_id: participantId,
        expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
        claimed_at: null,
      });
      return {
        status: 201,
        data: invite,
        changes: [{ table: "invites", before: null, after: invite }],
        guards: [activeReference(env.DB, "participants", participantId)],
        extra: [
          stmt(
            env.DB,
            "INSERT INTO invite_credentials(invite_id,token_hash) VALUES(?,?)",
            invite.id,
            hash,
          ),
        ],
      };
    },
  );
}
