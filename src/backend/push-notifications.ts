import { randomId, sha256Base64Url } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, Env } from "../types";

type JsonObject = Record<string, unknown>;
type PushEnvironment = "development" | "production";
type PushEventType = "new_message" | "new_thread_reply" | "forwarded_message" | "incoming_call" | "room_invitation";

interface PushTokenRow {
  push_token_id: string;
  provider: "apns";
  environment: PushEnvironment;
  bundle_id: string;
  token_hash: string;
  token: string;
  account_id: string;
  principal_id: string;
  device_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  last_registered_at: string;
  last_sent_at: string | null;
  disabled_at: string | null;
  invalidated_at: string | null;
  failure_count: number;
  last_failure_code: string | null;
  last_failure_at: string | null;
}

interface PushTarget extends PushTokenRow {
  account_status: string;
  principal_status: string;
  device_revoked_at: string | null;
  session_revoked_at: string | null;
  session_expires_at: string;
}

interface QueueRoomPushInput {
  type: PushEventType;
  roomId: string;
  senderPrincipalId: string;
  envelopeId?: string | null;
  rootEnvelopeId?: string | null;
  callId?: string | null;
}

interface QueuePrincipalPushInput {
  type: PushEventType;
  principalId: string;
  roomId?: string | null;
  invitationId?: string | null;
}

interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
}

interface CachedApnsToken {
  cacheKey: string;
  token: string;
  issuedAtMs: number;
}

const APNS_PROVIDER = "apns";
const APNS_TOKEN_PATTERN = /^[0-9a-fA-F]+$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;
const APNS_JWT_TTL_MS = 50 * 60 * 1000;
const APNS_REQUEST_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

let cachedApnsToken: CachedApnsToken | null = null;

export async function listCurrentDevicePushTokens(env: Env, auth: AuthContext): Promise<JsonObject[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM push_tokens
     WHERE account_id = ?
       AND device_id = ?
       AND disabled_at IS NULL
       AND invalidated_at IS NULL
     ORDER BY last_registered_at DESC`,
  )
    .bind(auth.account.account_id, auth.device.device_id)
    .all<PushTokenRow>();
  return (result.results ?? []).map(publicPushToken);
}

export async function registerCurrentDevicePushToken(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const provider = stringField(body, "provider", { max: 16 }) ?? APNS_PROVIDER;
  if (provider !== APNS_PROVIDER) {
    throw new HttpError(400, "unsupported_push_provider", "Only APNs push tokens are supported.");
  }
  const environment = pushEnvironment(stringField(body, "environment", { required: true, max: 24 })!);
  const bundleId = stringField(body, "bundleId", {
    required: true,
    min: 1,
    max: 255,
    pattern: BUNDLE_ID_PATTERN,
  })!;
  assertBundleIdAllowed(env, bundleId);
  const token = stringField(body, "token", {
    required: true,
    min: 32,
    max: 512,
    pattern: APNS_TOKEN_PATTERN,
  })!.toLowerCase();
  const tokenHash = await sha256Base64Url(`${provider}:${environment}:${bundleId}:${token}`);
  const pushTokenId = randomId("pus");
  const existingToken = await env.CONTROL_DB.prepare(
    "SELECT device_id FROM push_tokens WHERE provider = ? AND environment = ? AND bundle_id = ? AND token_hash = ?",
  )
    .bind(provider, environment, bundleId, tokenHash)
    .first<{ device_id: string }>();

  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO push_tokens (
         push_token_id, provider, environment, bundle_id, token_hash, token,
         account_id, principal_id, device_id, session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, environment, bundle_id, token_hash) DO UPDATE SET
         token = excluded.token,
         account_id = excluded.account_id,
         principal_id = excluded.principal_id,
         device_id = excluded.device_id,
         session_id = excluded.session_id,
         updated_at = CURRENT_TIMESTAMP,
         last_registered_at = CURRENT_TIMESTAMP,
         disabled_at = NULL,
         invalidated_at = NULL,
         last_failure_code = NULL,
         last_failure_at = NULL`,
    ).bind(
      pushTokenId,
      provider,
      environment,
      bundleId,
      tokenHash,
      token,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      auth.session.session_id,
    ),
    env.CONTROL_DB.prepare(
      "UPDATE devices SET notification_capability = ? WHERE device_id = ? AND account_id = ?",
    ).bind(APNS_PROVIDER, auth.device.device_id, auth.account.account_id),
  ]);
  if (existingToken?.device_id && existingToken.device_id !== auth.device.device_id) {
    await refreshDeviceNotificationCapability(env, existingToken.device_id);
  }

  const row = await env.CONTROL_DB.prepare(
    "SELECT * FROM push_tokens WHERE provider = ? AND environment = ? AND bundle_id = ? AND token_hash = ?",
  )
    .bind(provider, environment, bundleId, tokenHash)
    .first<PushTokenRow>();
  if (!row) {
    throw new HttpError(500, "push_token_register_failed", "Push token could not be registered.");
  }
  return publicPushToken(row);
}

export async function unregisterCurrentDevicePushToken(
  env: Env,
  auth: AuthContext,
  pushTokenId: string,
): Promise<void> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT push_token_id
     FROM push_tokens
     WHERE push_token_id = ?
       AND account_id = ?
       AND device_id = ?
       AND disabled_at IS NULL
       AND invalidated_at IS NULL`,
  )
    .bind(pushTokenId, auth.account.account_id, auth.device.device_id)
    .first<{ push_token_id: string }>();
  if (!row) {
    throw new HttpError(404, "push_token_not_found", "Push token not found");
  }
  await env.CONTROL_DB.prepare(
    `UPDATE push_tokens
     SET disabled_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE push_token_id = ?
       AND account_id = ?
       AND device_id = ?`,
  )
    .bind(pushTokenId, auth.account.account_id, auth.device.device_id)
    .run();
  await refreshDeviceNotificationCapability(env, auth.device.device_id);
}

export async function disablePushTokensForDevice(env: Env, deviceId: string): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE push_tokens
     SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE device_id = ?
       AND disabled_at IS NULL
       AND invalidated_at IS NULL`,
  )
    .bind(deviceId)
    .run();
  await refreshDeviceNotificationCapability(env, deviceId);
}

export async function disablePushTokensForSession(env: Env, sessionId: string): Promise<void> {
  const devices = await env.CONTROL_DB.prepare(
    `SELECT DISTINCT device_id
     FROM push_tokens
     WHERE session_id = ?
       AND disabled_at IS NULL
       AND invalidated_at IS NULL`,
  )
    .bind(sessionId)
    .all<{ device_id: string }>();
  await env.CONTROL_DB.prepare(
    `UPDATE push_tokens
     SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE session_id = ?
       AND disabled_at IS NULL
       AND invalidated_at IS NULL`,
  )
    .bind(sessionId)
    .run();
  for (const device of devices.results ?? []) {
    await refreshDeviceNotificationCapability(env, device.device_id);
  }
}

export function queueRoomPushNotification(
  ctx: ExecutionContext,
  env: Env,
  input: QueueRoomPushInput,
): void {
  ctx.waitUntil(
    deliverRoomPushNotification(env, input).catch((error) => {
      console.warn("push.room_delivery_failed", publicPushError(error, input));
    }),
  );
}

export function queuePrincipalPushNotification(
  ctx: ExecutionContext,
  env: Env,
  input: QueuePrincipalPushInput,
): void {
  ctx.waitUntil(
    deliverPrincipalPushNotification(env, input).catch((error) => {
      console.warn("push.principal_delivery_failed", publicPushError(error, input));
    }),
  );
}

function publicPushToken(row: PushTokenRow): JsonObject {
  return {
    pushTokenId: row.push_token_id,
    provider: row.provider,
    environment: row.environment,
    bundleId: row.bundle_id,
    accountId: row.account_id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRegisteredAt: row.last_registered_at,
    lastSentAt: row.last_sent_at,
    disabledAt: row.disabled_at,
    invalidatedAt: row.invalidated_at,
    failureCount: row.failure_count,
    lastFailureCode: row.last_failure_code,
    lastFailureAt: row.last_failure_at,
  };
}

async function deliverRoomPushNotification(env: Env, input: QueueRoomPushInput): Promise<void> {
  const targets = await loadRoomPushTargets(env, input.roomId, input.senderPrincipalId);
  await deliverPushTargets(env, targets, pushPayload(input.type, input));
}

async function deliverPrincipalPushNotification(env: Env, input: QueuePrincipalPushInput): Promise<void> {
  const targets = await loadPrincipalPushTargets(env, input.principalId);
  await deliverPushTargets(env, targets, pushPayload(input.type, input));
}

async function loadRoomPushTargets(env: Env, roomId: string, senderPrincipalId: string): Promise<PushTarget[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
       pt.*,
       a.status AS account_status,
       p.status AS principal_status,
       d.revoked_at AS device_revoked_at,
       s.revoked_at AS session_revoked_at,
       s.expires_at AS session_expires_at
     FROM push_tokens pt
     JOIN room_memberships rm
       ON rm.account_id = pt.account_id
      AND rm.principal_id = pt.principal_id
     JOIN accounts a ON a.account_id = pt.account_id
     JOIN principals p ON p.principal_id = pt.principal_id
     JOIN devices d ON d.device_id = pt.device_id
     JOIN sessions s ON s.session_id = pt.session_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND rm.principal_id != ?
       AND pt.provider = 'apns'
       AND pt.disabled_at IS NULL
       AND pt.invalidated_at IS NULL
       AND a.status = 'active'
       AND p.status = 'active'
       AND d.revoked_at IS NULL
       AND s.revoked_at IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(roomId, senderPrincipalId)
    .all<PushTarget>();
  return result.results ?? [];
}

async function loadPrincipalPushTargets(env: Env, principalId: string): Promise<PushTarget[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT
       pt.*,
       a.status AS account_status,
       p.status AS principal_status,
       d.revoked_at AS device_revoked_at,
       s.revoked_at AS session_revoked_at,
       s.expires_at AS session_expires_at
     FROM push_tokens pt
     JOIN accounts a ON a.account_id = pt.account_id
     JOIN principals p ON p.principal_id = pt.principal_id
     JOIN devices d ON d.device_id = pt.device_id
     JOIN sessions s ON s.session_id = pt.session_id
     WHERE pt.principal_id = ?
       AND pt.provider = 'apns'
       AND pt.disabled_at IS NULL
       AND pt.invalidated_at IS NULL
       AND a.status = 'active'
       AND p.status = 'active'
       AND d.revoked_at IS NULL
       AND s.revoked_at IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(principalId)
    .all<PushTarget>();
  return result.results ?? [];
}

async function deliverPushTargets(env: Env, targets: PushTarget[], payload: JsonObject): Promise<void> {
  if (targets.length === 0) return;
  const config = apnsConfig(env);
  if (!config) {
    console.warn("push.apns_unconfigured", { targetCount: targets.length, type: payload.type });
    return;
  }
  const jwt = await apnsProviderToken(config);
  await Promise.all(targets.map(async (target) => {
    try {
      await sendApnsNotification(env, config, jwt, target, payload);
    } catch (error) {
      console.warn("push.apns_send_failed", {
        pushTokenId: target.push_token_id,
        environment: target.environment,
        code: error instanceof HttpError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}

async function sendApnsNotification(
  env: Env,
  _config: ApnsConfig,
  jwt: string,
  target: PushTarget,
  payload: JsonObject,
): Promise<void> {
  const host = target.environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const response = await fetch(`https://${host}/3/device/${target.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": target.bundle_id,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(APNS_REQUEST_TIMEOUT_MS),
  });

  if (response.ok) {
    await env.CONTROL_DB.prepare(
      `UPDATE push_tokens
       SET last_sent_at = CURRENT_TIMESTAMP,
           last_failure_code = NULL,
           last_failure_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE push_token_id = ?`,
    )
      .bind(target.push_token_id)
      .run();
    return;
  }

  const reason = await apnsFailureReason(response);
  const invalidated = apnsInvalidatesToken(response.status, reason);
  await env.CONTROL_DB.prepare(
    `UPDATE push_tokens
     SET failure_count = failure_count + 1,
         last_failure_code = ?,
         last_failure_at = CURRENT_TIMESTAMP,
         invalidated_at = CASE WHEN ? THEN COALESCE(invalidated_at, CURRENT_TIMESTAMP) ELSE invalidated_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE push_token_id = ?`,
  )
    .bind(reason ?? `http_${response.status}`, invalidated ? 1 : 0, target.push_token_id)
    .run();
  if (invalidated) {
    await refreshDeviceNotificationCapability(env, target.device_id);
  }
}

function pushPayload(type: PushEventType, input: QueueRoomPushInput | QueuePrincipalPushInput): JsonObject {
  return {
    aps: {
      alert: {
        title: "Voyager",
        body: pushBody(type),
      },
      sound: "default",
    },
    type,
    roomId: "roomId" in input ? input.roomId : undefined,
    envelopeId: "envelopeId" in input ? input.envelopeId ?? undefined : undefined,
    rootEnvelopeId: "rootEnvelopeId" in input ? input.rootEnvelopeId ?? undefined : undefined,
    callId: "callId" in input ? input.callId ?? undefined : undefined,
    invitationId: "invitationId" in input ? input.invitationId ?? undefined : undefined,
  };
}

function pushBody(type: PushEventType): string {
  if (type === "incoming_call") return "Incoming call";
  if (type === "room_invitation") return "New room invitation";
  if (type === "new_thread_reply") return "New reply";
  return "New message";
}

function apnsConfig(env: Env): ApnsConfig | null {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const privateKey = env.APNS_PRIVATE_KEY?.trim();
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey };
}

async function apnsProviderToken(config: ApnsConfig): Promise<string> {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  const now = Date.now();
  if (cachedApnsToken?.cacheKey === cacheKey && now - cachedApnsToken.issuedAtMs < APNS_JWT_TTL_MS) {
    return cachedApnsToken.token;
  }
  const issuedAtSeconds = Math.floor(now / 1000);
  const header = base64UrlJson({ alg: "ES256", kid: config.keyId });
  const claims = base64UrlJson({ iss: config.teamId, iat: issuedAtSeconds });
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  const token = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
  cachedApnsToken = { cacheKey, token, issuedAtMs: now };
  return token;
}

async function apnsFailureReason(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  const parsed = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const reason = (parsed as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : null;
}

function apnsInvalidatesToken(status: number, reason: string | null): boolean {
  return status === 410 ||
    reason === "BadDeviceToken" ||
    reason === "DeviceTokenNotForTopic" ||
    reason === "Unregistered";
}

function pushEnvironment(value: string): PushEnvironment {
  if (value === "development" || value === "production") return value;
  throw new HttpError(400, "invalid_push_environment", "APNs environment must be development or production.");
}

function assertBundleIdAllowed(env: Env, bundleId: string): void {
  const allowed = allowedBundleIds(env);
  if (apnsConfig(env) && allowed.size === 0) {
    throw new HttpError(503, "push_bundle_unconfigured", "APNs bundle ID allowlist is not configured.");
  }
  if (allowed.size > 0 && !allowed.has(bundleId)) {
    throw new HttpError(400, "invalid_push_bundle", "Push token bundle ID is not allowed.");
  }
}

function allowedBundleIds(env: Env): Set<string> {
  const entries = [
    env.APNS_BUNDLE_ID,
    ...(env.APNS_ALLOWED_BUNDLE_IDS ?? "").split(","),
  ];
  return new Set(entries.map((entry) => entry?.trim()).filter((entry): entry is string => Boolean(entry)));
}

async function refreshDeviceNotificationCapability(env: Env, deviceId: string): Promise<void> {
  const active = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM push_tokens
     WHERE device_id = ?
       AND disabled_at IS NULL
       AND invalidated_at IS NULL`,
  )
    .bind(deviceId)
    .first<{ count: number }>();
  await env.CONTROL_DB.prepare(
    "UPDATE devices SET notification_capability = ? WHERE device_id = ?",
  )
    .bind((active?.count ?? 0) > 0 ? APNS_PROVIDER : null, deviceId)
    .run();
}

function base64UrlJson(value: JsonObject): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

function pemToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function publicPushError(error: unknown, input: QueueRoomPushInput | QueuePrincipalPushInput): JsonObject {
  return {
    type: input.type,
    roomId: "roomId" in input ? input.roomId : undefined,
    principalId: "principalId" in input ? input.principalId : undefined,
    code: error instanceof HttpError ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}
