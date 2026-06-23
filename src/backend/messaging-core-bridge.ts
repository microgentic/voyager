import { randomId } from "../crypto";
import { HttpError } from "../http";
import type { AccountRow, DeviceRow, Env, PrincipalRow } from "../types";
import type { JsonObject } from "./shared/types";

export const VOYAGER_DEFAULT_MESSAGING_TENANT_ID = "tenant_voyager_default";

type MessagingCoreMode = "off" | "shadow" | "proxy";
type PrincipalType = "human" | "agent" | "service";

const DEFAULT_APP_ID = "voyager";
const DEFAULT_TOKEN_AUDIENCE = "messaging-core";
const DEFAULT_INTERNAL_AUDIENCE = "messaging-core-internal";
const DEFAULT_TOKEN_ISSUER = "voyager";
const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_INTERNAL_TOKEN_TTL_SECONDS = 5 * 60;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;
const encoder = new TextEncoder();

export interface MessagingCoreIdentity {
  account: AccountRow;
  principal: PrincipalRow;
  device: DeviceRow;
  roles: string[];
}

interface BridgeConfig {
  mode: MessagingCoreMode;
  invalidMode: string | null;
  tenantId: string;
  app: string;
  baseUrl: string | null;
  tokenIssuer: string;
  tokenAudience: string;
  tokenSecret: string | null;
  tokenTtlSeconds: number;
  internalIssuer: string;
  internalAudience: string;
  internalSecret: string | null;
  internalTtlSeconds: number;
  fetchTimeoutMs: number;
}

interface IdentitySyncResult {
  attempted: boolean;
  ok: boolean;
  reason: string | null;
  accountSynced: boolean;
  principalSynced: boolean;
  deviceSynced: boolean;
}

export function messagingCoreBridgeStatus(env: Env): JsonObject {
  const config = resolveBridgeConfig(env);
  return {
    enabled: config.mode !== "off",
    mode: config.mode,
    configured: bridgeCanMintClientToken(config),
    tenantId: config.tenantId,
    app: config.app,
    baseUrl: config.baseUrl,
    tokenConfig: {
      audience: config.tokenAudience,
      issuer: config.tokenIssuer,
      hmacConfigured: Boolean(config.tokenSecret),
      ttlSeconds: config.tokenTtlSeconds,
    },
    internalService: {
      audience: config.internalAudience,
      issuer: config.internalIssuer,
      configured: Boolean(config.internalSecret),
      ttlSeconds: config.internalTtlSeconds,
    },
    identitySync: {
      available: Boolean(config.baseUrl && config.internalSecret),
      required: config.mode === "proxy",
    },
    reason: bridgeStatusReason(config),
  };
}

export async function createMessagingCoreSessionPayload(
  env: Env,
  identity: MessagingCoreIdentity,
): Promise<JsonObject> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (config.mode === "off" || !bridgeCanMintClientToken(config)) {
    return base;
  }

  const sync = await syncMessagingCoreIdentity(env, config, identity);
  if (config.mode === "proxy" && !sync.ok) {
    throw new HttpError(
      503,
      "messaging_core_identity_sync_failed",
      "Messaging Core identity sync failed",
      { reason: sync.reason },
    );
  }

  const { token, expiresAt, claims } = await mintScopedMessagingToken(config, identity);
  return {
    ...base,
    configured: true,
    tokenType: "Bearer",
    token,
    expiresAt,
    scopes: claims.scopes,
    identitySync: sync,
  };
}

async function syncMessagingCoreIdentity(
  env: Env,
  config: BridgeConfig,
  identity: MessagingCoreIdentity,
): Promise<IdentitySyncResult> {
  if (!config.baseUrl || !config.internalSecret) {
    return {
      attempted: false,
      ok: false,
      reason: "internal_service_unconfigured",
      accountSynced: false,
      principalSynced: false,
      deviceSynced: false,
    };
  }

  const token = await mintInternalServiceToken(config, [
    "internal:accounts:upsert",
    "internal:principals:upsert",
    "internal:devices:upsert",
  ]);

  try {
    await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/accounts/upsert`, {
      accountId: identity.account.account_id,
      externalSubjectId: identity.account.account_id,
      displayName: identity.account.display_name,
      status: publicCoreAccountStatus(identity.account),
      policyId: identity.account.policy_id,
    });
    await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/principals/upsert`, {
      principalId: identity.principal.principal_id,
      accountId: identity.account.account_id,
      type: publicCorePrincipalType(identity.principal.principal_type),
      externalPrincipalRef: identity.principal.principal_id,
      displayName: identity.principal.display_name,
      avatarRef: identity.principal.avatar_ref,
      status: publicCorePrincipalStatus(identity.principal),
      ownerPrincipalId: identity.principal.owner_principal_id,
    });
    await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/devices/upsert`, {
      deviceId: identity.device.device_id,
      accountId: identity.account.account_id,
      principalId: identity.principal.principal_id,
      externalDeviceRef: identity.device.device_id,
      platform: identity.device.platform,
      label: identity.device.device_label,
      credentialFingerprint: identity.device.credential_fingerprint,
      publicKeyPackage: identity.device.public_key_package,
      notificationCapability: identity.device.notification_capability,
      clientVersion: identity.device.client_version,
      protocolVersion: identity.device.protocol_version,
      status: identity.device.revoked_at ? "revoked" : "active",
      lastSeenAt: identity.device.last_seen_at,
    });
    return {
      attempted: true,
      ok: true,
      reason: null,
      accountSynced: true,
      principalSynced: true,
      deviceSynced: true,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      accountSynced: false,
      principalSynced: false,
      deviceSynced: false,
    };
  }
}

async function postInternal(
  config: BridgeConfig,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(messagingCoreUrl(config, path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Messaging Core ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function messagingCoreUrl(config: BridgeConfig, path: string): string {
  if (!config.baseUrl) {
    throw new Error("Messaging Core base URL is not configured.");
  }
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

async function mintScopedMessagingToken(
  config: BridgeConfig,
  identity: MessagingCoreIdentity,
): Promise<{ token: string; expiresAt: string; claims: JsonObject & { scopes: string[] } }> {
  if (!config.tokenSecret) {
    throw new HttpError(503, "messaging_core_token_unconfigured", "Messaging Core token secret is not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  const expires = now + config.tokenTtlSeconds;
  const claims = {
    aud: config.tokenAudience,
    iss: config.tokenIssuer,
    sub: identity.account.account_id,
    subjectId: identity.account.account_id,
    app: config.app,
    tenantId: config.tenantId,
    principalId: identity.principal.principal_id,
    accountId: identity.account.account_id,
    deviceId: identity.device.device_id,
    principalType: publicCorePrincipalType(identity.principal.principal_type),
    scopes: clientScopes(),
    roles: identity.roles,
    exp: expires,
    iat: now,
    jti: randomId("mct"),
  };
  return {
    token: await signHmacJwt(claims, config.tokenSecret),
    expiresAt: new Date(expires * 1000).toISOString(),
    claims,
  };
}

async function mintInternalServiceToken(config: BridgeConfig, scopes: string[]): Promise<string> {
  if (!config.internalSecret) {
    throw new HttpError(503, "messaging_core_internal_service_unconfigured", "Messaging Core internal service secret is not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  return signHmacJwt(
    {
      aud: config.internalAudience,
      iss: config.internalIssuer,
      sub: "voyager-product-backend",
      app: config.app,
      tenantId: config.tenantId,
      scopes,
      exp: now + config.internalTtlSeconds,
      iat: now,
      jti: randomId("mci"),
    },
    config.internalSecret,
  );
}

async function signHmacJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = stringToBase64Url(JSON.stringify({ typ: "JWT", alg: "HS256" }));
  const payload = stringToBase64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = await hmacSha256Base64Url(secret, signingInput);
  return `${signingInput}.${signature}`;
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function stringToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function resolveBridgeConfig(env: Env): BridgeConfig {
  const { mode, invalidMode } = bridgeMode(env.VOYAGER_MESSAGING_CORE_MODE);
  return {
    mode,
    invalidMode,
    tenantId: env.MESSAGING_CORE_TENANT_ID?.trim() || VOYAGER_DEFAULT_MESSAGING_TENANT_ID,
    app: env.MESSAGING_CORE_APP_ID?.trim() || DEFAULT_APP_ID,
    baseUrl: trimmed(env.MESSAGING_CORE_BASE_URL),
    tokenIssuer: env.MESSAGING_CORE_TOKEN_ISSUER?.trim() || DEFAULT_TOKEN_ISSUER,
    tokenAudience: env.MESSAGING_CORE_TOKEN_AUDIENCE?.trim() || DEFAULT_TOKEN_AUDIENCE,
    tokenSecret: trimmed(env.MESSAGING_CORE_TOKEN_SECRET),
    tokenTtlSeconds: positiveInteger(env.MESSAGING_CORE_TOKEN_TTL_SECONDS, DEFAULT_TOKEN_TTL_SECONDS),
    internalIssuer: env.MESSAGING_CORE_INTERNAL_SERVICE_ISSUER?.trim() || DEFAULT_TOKEN_ISSUER,
    internalAudience: env.MESSAGING_CORE_INTERNAL_SERVICE_AUDIENCE?.trim() || DEFAULT_INTERNAL_AUDIENCE,
    internalSecret: trimmed(env.MESSAGING_CORE_INTERNAL_SERVICE_SECRET),
    internalTtlSeconds: positiveInteger(env.MESSAGING_CORE_INTERNAL_SERVICE_TTL_SECONDS, DEFAULT_INTERNAL_TOKEN_TTL_SECONDS),
    fetchTimeoutMs: positiveInteger(env.VOYAGER_MESSAGING_CORE_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
  };
}

function bridgeMode(value: string | undefined): { mode: MessagingCoreMode; invalidMode: string | null } {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return { mode: "off", invalidMode: null };
  if (normalized === "off" || normalized === "shadow" || normalized === "proxy") {
    return { mode: normalized, invalidMode: null };
  }
  return { mode: "off", invalidMode: normalized };
}

function bridgeCanMintClientToken(config: BridgeConfig): boolean {
  return config.mode !== "off" && Boolean(config.baseUrl && config.tokenSecret && !config.invalidMode);
}

function bridgeStatusReason(config: BridgeConfig): string | null {
  if (config.invalidMode) return "invalid_mode";
  if (config.mode === "off") return "bridge_disabled";
  if (!config.baseUrl) return "base_url_unconfigured";
  if (!config.tokenSecret) return "token_secret_unconfigured";
  return null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimmed(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function clientScopes(): string[] {
  return [
    "messaging:read",
    "messaging:rooms:write",
    "messaging:messages:write",
    "messaging:key-packages:write",
  ];
}

function publicCoreAccountStatus(account: AccountRow): "active" | "suspended" | "deleted" {
  if (account.status === "active") return "active";
  if (account.status === "deleted" || account.status === "pending_deletion") return "deleted";
  return "suspended";
}

function publicCorePrincipalStatus(principal: PrincipalRow): "active" | "suspended" | "deleted" {
  if (principal.status === "active") return "active";
  if (principal.status === "revoked") return "deleted";
  return "suspended";
}

function publicCorePrincipalType(type: PrincipalRow["principal_type"]): PrincipalType {
  return type === "agent" ? "agent" : "human";
}
