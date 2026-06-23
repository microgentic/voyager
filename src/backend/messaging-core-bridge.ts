import { randomId } from "../crypto";
import { HttpError } from "../http";
import type { AccountRow, DeviceRow, Env, PolicyRow, PrincipalRow } from "../types";
import type { JsonObject } from "./shared/types";

export const VOYAGER_DEFAULT_MESSAGING_TENANT_ID = "tenant_voyager_default";

type MessagingCoreMode = "off" | "shadow" | "proxy";
type PublicCoreMethod = "GET" | "POST" | "PATCH" | "DELETE";
type PrincipalType = "human" | "agent" | "service";
type IdentitySyncStep = "tenant" | "account" | "principal" | "device";

const DEFAULT_APP_ID = "voyager";
const DEFAULT_TENANT_DISPLAY_NAME = "Voyager";
const DEFAULT_TOKEN_AUDIENCE = "messaging-core";
const DEFAULT_INTERNAL_AUDIENCE = "messaging-core-internal";
const DEFAULT_TOKEN_ISSUER = "voyager";
const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_INTERNAL_TOKEN_TTL_SECONDS = 5 * 60;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_BACKFILL_ROOM_LIMIT = 50;
const DEFAULT_BACKFILL_MESSAGE_LIMIT = 200;
const BACKFILL_IMPORT_TIMEOUT_MS = 30_000;
const MAX_BACKFILL_BATCH_ITEMS = 500;
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
  messageCutoverEnabled: boolean;
  tenantId: string;
  tenantExternalRef: string;
  tenantDisplayName: string;
  app: string;
  baseUrl: string | null;
  serviceBinding: Fetcher | null;
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
  failedStep: IdentitySyncStep | null;
  tenantSynced: boolean;
  accountSynced: boolean;
  principalSynced: boolean;
  deviceSynced: boolean;
}

interface ConfiguredMessagingCoreSession {
  session: JsonObject;
  token: string;
  sync: IdentitySyncResult;
}

type VoyagerReadonlyBackfillSnapshot = JsonObject & {
  policies: JsonObject[];
  accounts: JsonObject[];
  principals: JsonObject[];
  devices: JsonObject[];
  rooms: JsonObject[];
  memberships: JsonObject[];
  messages: JsonObject[];
};

interface VoyagerRoomBackfillRow {
  room_id: string;
  type: "direct" | "group" | "channel";
  name: string | null;
  status: "active" | "archived" | "deleted";
  created_by_principal_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  owner_principal_id: string | null;
}

interface VoyagerMembershipBackfillRow {
  room_id: string;
  account_id: string;
  principal_id: string;
  role: "owner" | "admin" | "member" | "agent";
  status: "invited" | "active" | "leaving" | "removed" | "banned";
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

interface VoyagerMessageBackfillRow {
  envelope_id: string;
  room_id: string;
  sender_account_id: string;
  sender_principal_id: string;
  sender_device_id: string;
  idempotency_key: string;
  ciphertext: string;
  server_sequence: number;
  server_received_at: string;
  state: string;
  edited_at: string | null;
  deleted_for_everyone_at: string | null;
  thread_root_envelope_id: string | null;
  also_sent_to_room: number;
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
      available: Boolean((config.baseUrl || config.serviceBinding) && config.internalSecret),
      required: config.mode === "proxy",
    },
    cutover: {
      messageRoutes: config.messageCutoverEnabled,
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

  return (await createConfiguredMessagingCoreSession(env, config, base, identity)).session;
}

export async function fetchMessagingCoreBootstrapProxy(
  env: Env,
  identity: MessagingCoreIdentity,
): Promise<JsonObject> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (config.mode === "off" || !bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_proxy_unconfigured",
      "Messaging Core proxy is not configured.",
      { reason: bridgeStatusReason(config) },
    );
  }

  const { session, token } = await createConfiguredMessagingCoreSession(env, config, base, identity);
  const upstream = await getPublicCoreJson(config, token, "/bootstrap");
  const bootstrap = objectField(upstream.payload, "bootstrap");
  return {
    messagingCore: session,
    bootstrap,
    proxied: {
      route: "/bootstrap",
      upstreamStatus: upstream.status,
    },
  };
}

export async function fetchMessagingCoreReadProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  path: string,
  query?: URLSearchParams,
): Promise<JsonObject> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (config.mode === "off" || !bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_proxy_unconfigured",
      "Messaging Core proxy is not configured.",
      { reason: bridgeStatusReason(config) },
    );
  }

  const { session, token } = await createConfiguredMessagingCoreSession(env, config, base, identity);
  const route = appendQuery(path, query);
  const upstream = await getPublicCoreJson(config, token, route);
  return {
    messagingCore: session,
    ...upstream.payload,
    proxied: {
      route,
      upstreamStatus: upstream.status,
    },
  };
}

export function messagingCoreMessageCutoverEnabled(env: Env): boolean {
  const config = resolveBridgeConfig(env);
  return config.messageCutoverEnabled;
}

export async function fetchMessagingCoreMessageCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  method: PublicCoreMethod,
  path: string,
  options: { body?: Record<string, unknown>; query?: URLSearchParams; responseField?: string } = {},
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!config.messageCutoverEnabled || !bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_cutover_unconfigured",
      "Messaging Core message cutover is not configured.",
      { reason: bridgeStatusReason(config) ?? "message_cutover_disabled" },
    );
  }

  const { token, sync } = await createConfiguredMessagingCoreSession(env, config, base, identity);
  if (!sync.ok) {
    throw new HttpError(
      503,
      "messaging_core_identity_sync_failed",
      "Messaging Core identity sync failed",
      { reason: sync.reason },
    );
  }

  const route = appendQuery(path, options.query);
  const upstream = await publicCoreJson(config, token, method, route, options.body, { preserveClientErrors: true });
  const payload = options.responseField && !(options.responseField in upstream.payload)
    ? { [options.responseField]: upstream.payload }
    : upstream.payload;
  return {
    status: upstream.status,
    payload: {
      ok: true,
      ...payload,
      messagingCoreCutover: {
        route,
        upstreamStatus: upstream.status,
      },
    },
  };
}

export async function backfillMessagingCoreReadonly(
  env: Env,
  input: Record<string, unknown> = {},
): Promise<JsonObject> {
  const config = resolveBridgeConfig(env);
  const roomLimit = importLimit(input, "roomLimit", DEFAULT_BACKFILL_ROOM_LIMIT);
  const messageLimit = importLimit(input, "messageLimit", DEFAULT_BACKFILL_MESSAGE_LIMIT);
  const dryRun = booleanOption(input, "dryRun", false);
  const snapshot = await buildVoyagerReadonlySnapshot(env, roomLimit, messageLimit);

  if (dryRun) {
    return {
      ok: true,
      dryRun,
      tenantId: config.tenantId,
      limits: { roomLimit, messageLimit },
      snapshot: snapshotSummary(snapshot),
      messagingCore: messagingCoreBridgeStatus(env),
    };
  }

  if (!config.baseUrl || !config.internalSecret) {
    throw new HttpError(
      503,
      "messaging_core_internal_service_unconfigured",
      "Messaging Core internal service is not configured.",
      { reason: config.baseUrl ? "internal_secret_unconfigured" : "base_url_unconfigured" },
    );
  }

  const token = await mintInternalServiceToken(config, [
    "internal:tenants:upsert",
    "internal:imports:voyager-readonly",
  ]);
  const bootstrap = await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/bootstrap`, {
    externalTenantRef: config.tenantExternalRef,
    displayName: config.tenantDisplayName,
    status: "active",
    policies: snapshot.policies,
  });
  const imported = await postInternal(
    config,
    token,
    `/internal/tenants/${encodeURIComponent(config.tenantId)}/imports/voyager-readonly`,
    snapshot,
    Math.max(config.fetchTimeoutMs, BACKFILL_IMPORT_TIMEOUT_MS),
  );

  return {
    ok: true,
    dryRun,
    tenantId: config.tenantId,
    limits: { roomLimit, messageLimit },
    snapshot: snapshotSummary(snapshot),
    messagingCore: messagingCoreBridgeStatus(env),
    core: {
      bootstrap,
      imported,
    },
  };
}

async function createConfiguredMessagingCoreSession(
  env: Env,
  config: BridgeConfig,
  base: JsonObject,
  identity: MessagingCoreIdentity,
): Promise<ConfiguredMessagingCoreSession> {
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
    token,
    sync,
    session: {
      ...base,
      configured: true,
      tokenType: "Bearer",
      token,
      expiresAt,
      scopes: claims.scopes,
      identitySync: sync,
    },
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
      failedStep: null,
      tenantSynced: false,
      accountSynced: false,
      principalSynced: false,
      deviceSynced: false,
    };
  }

  const token = await mintInternalServiceToken(config, [
    "internal:tenants:upsert",
    "internal:accounts:upsert",
    "internal:principals:upsert",
    "internal:devices:upsert",
  ]);

  let failedStep: IdentitySyncStep = "tenant";
  let tenantSynced = false;
  let accountSynced = false;
  let principalSynced = false;
  let deviceSynced = false;

  try {
    await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/bootstrap`, {
      externalTenantRef: config.tenantExternalRef,
      displayName: config.tenantDisplayName,
      status: "active",
      policies: [
        {
          policyId: identity.account.policy_id,
          name: identity.account.policy_id,
          policyJson: { source: "voyager" },
        },
      ],
    });
    tenantSynced = true;
    failedStep = "account";
    await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/accounts/upsert`, {
      accountId: identity.account.account_id,
      externalSubjectId: identity.account.account_id,
      displayName: identity.account.display_name,
      status: publicCoreAccountStatus(identity.account),
      policyId: identity.account.policy_id,
    });
    accountSynced = true;
    failedStep = "principal";
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
    principalSynced = true;
    failedStep = "device";
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
    deviceSynced = true;
    return {
      attempted: true,
      ok: true,
      reason: null,
      failedStep: null,
      tenantSynced,
      accountSynced,
      principalSynced,
      deviceSynced,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: publicIdentitySyncFailureReason(error),
      failedStep,
      tenantSynced,
      accountSynced,
      principalSynced,
      deviceSynced,
    };
  }
}

async function postInternal(
  config: BridgeConfig,
  token: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = config.fetchTimeoutMs,
): Promise<unknown> {
  const request = new Request(messagingCoreUrl(config, path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const response = config.serviceBinding ? await config.serviceBinding.fetch(request) : await fetch(request);
  if (!response.ok) {
    throw new Error(`internal_service_http_${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

async function getPublicCoreJson(
  config: BridgeConfig,
  token: string,
  path: string,
): Promise<{ status: number; payload: JsonObject }> {
  return publicCoreJson(config, token, "GET", path);
}

async function publicCoreJson(
  config: BridgeConfig,
  token: string,
  method: PublicCoreMethod,
  path: string,
  body?: Record<string, unknown>,
  options: { preserveClientErrors?: boolean } = {},
): Promise<{ status: number; payload: JsonObject }> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const request = new Request(messagingCoreUrl(config, path), init);
  const response = config.serviceBinding ? await config.serviceBinding.fetch(request) : await fetch(request);
  const payload = await parseJsonObjectResponse(response);
  if (!response.ok) {
    if (options.preserveClientErrors && response.status >= 400 && response.status < 500) {
      const upstreamError = coreError(payload);
      throw new HttpError(
        response.status,
        upstreamError.code,
        upstreamError.message,
        { upstreamStatus: response.status },
      );
    }
    throw new HttpError(
      502,
      "messaging_core_proxy_failed",
      "Messaging Core proxy request failed.",
      { upstreamStatus: response.status, upstreamError: stringValue(payload.error) },
    );
  }
  return { status: response.status, payload };
}

function coreError(payload: JsonObject): { code: string; message: string } {
  const error = payload.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = stringValue((error as Record<string, unknown>).code);
    const message = stringValue((error as Record<string, unknown>).message);
    if (code && message) return { code, message };
  }
  return {
    code: stringValue(payload.error) ?? "messaging_core_proxy_failed",
    message: stringValue(payload.message) ?? "Messaging Core proxy request failed.",
  };
}

async function buildVoyagerReadonlySnapshot(
  env: Env,
  roomLimit: number,
  messageLimit: number,
): Promise<VoyagerReadonlyBackfillSnapshot> {
  const rooms = await env.CONTROL_DB.prepare(
    `SELECT r.room_id,
            r.type,
            r.name,
            r.status,
            r.created_by_principal_id,
            r.version,
            r.created_at,
            r.updated_at,
            r.archived_at,
            (
              SELECT rm.principal_id
              FROM room_memberships rm
              WHERE rm.room_id = r.room_id
                AND rm.role = 'owner'
                AND rm.status IN ('active', 'leaving')
              ORDER BY CASE rm.status WHEN 'active' THEN 0 ELSE 1 END, rm.created_at
              LIMIT 1
            ) AS owner_principal_id
     FROM rooms r
     WHERE r.status != 'deleted'
     ORDER BY r.updated_at DESC, r.room_id
     LIMIT ?`,
  )
    .bind(roomLimit)
    .all<VoyagerRoomBackfillRow>();
  const roomRows = rooms.results ?? [];
  const roomIds = roomRows.map((room) => room.room_id);
  if (roomIds.length === 0) {
    return emptySnapshot();
  }

  const memberships = await selectIn<VoyagerMembershipBackfillRow>(
    env,
    `SELECT room_id, account_id, principal_id, role, status, created_at, updated_at, removed_at
     FROM room_memberships
     WHERE room_id IN ({ids})
     ORDER BY room_id, created_at, principal_id`,
    roomIds,
  );
  const messages = (await selectIn<VoyagerMessageBackfillRow>(
    env,
    `SELECT envelope_id,
            room_id,
            sender_account_id,
            sender_principal_id,
            sender_device_id,
            idempotency_key,
            ciphertext,
            server_sequence,
            server_received_at,
            state,
            edited_at,
            deleted_for_everyone_at,
            thread_root_envelope_id,
            also_sent_to_room
     FROM message_envelopes
     WHERE room_id IN ({ids})
       AND state != 'purged'
       AND expires_at > CURRENT_TIMESTAMP
       AND thread_root_envelope_id IS NULL
     ORDER BY room_id, server_sequence
     LIMIT ?`,
    roomIds,
    [messageLimit],
  ));

  const principalIds = uniqueStrings([
    ...roomRows.map((room) => room.created_by_principal_id),
    ...roomRows.map((room) => room.owner_principal_id),
    ...memberships.map((membership) => membership.principal_id),
    ...messages.map((message) => message.sender_principal_id),
  ]);
  const deviceIds = uniqueStrings(messages.map((message) => message.sender_device_id));

  const principals = principalIds.length
    ? await selectIn<PrincipalRow>(
        env,
        `SELECT principal_id, account_id, principal_type, display_name, avatar_ref, status, owner_principal_id, created_at, revoked_at
         FROM principals
         WHERE principal_id IN ({ids})
         ORDER BY principal_id`,
        principalIds,
      )
    : [];
  const accountIds = uniqueStrings([
    ...memberships.map((membership) => membership.account_id),
    ...messages.map((message) => message.sender_account_id),
    ...principals.map((principal) => principal.account_id),
  ]);
  const accounts = accountIds.length
    ? await selectIn<AccountRow>(
        env,
        `SELECT account_id, status, display_name, email, phone, policy_id, default_principal_id,
                activated_at, suspended_at, deletion_state, created_at, updated_at
         FROM accounts
         WHERE account_id IN ({ids})
         ORDER BY account_id`,
        accountIds,
      )
    : [];
  const policies = accounts.length
    ? await selectIn<PolicyRow>(
        env,
        `SELECT policy_id, name, require_passkey_or_mfa, require_local_lock, require_email, require_phone,
                maximum_devices, maximum_owned_groups, maximum_group_memberships, maximum_attachment_bytes,
                maximum_attachments_per_message, maximum_image_dimension, daily_attachment_bytes_per_account,
                daily_attachment_bytes_per_room, message_retention_days, attachment_retention_class,
                agent_allowed, created_at, updated_at
         FROM policies
         WHERE policy_id IN ({ids})
         ORDER BY policy_id`,
        uniqueStrings(accounts.map((account) => account.policy_id)),
      )
    : [];
  const devices = deviceIds.length
    ? await selectIn<DeviceRow>(
        env,
        `SELECT device_id, account_id, principal_id, platform, device_label, credential_fingerprint,
                credential_version, public_key_package, notification_capability, client_version,
                protocol_version, created_at, last_seen_at, revoked_at, revocation_reason
         FROM devices
         WHERE device_id IN ({ids})
         ORDER BY device_id`,
        deviceIds,
      )
    : [];

  return {
    policies: policies.map(importPolicy),
    accounts: accounts.map(importAccount),
    principals: principals.map(importPrincipal),
    devices: devices.map(importDevice),
    rooms: roomRows.map(importRoom),
    memberships: memberships.map(importMembership),
    messages: messages.map(importMessage),
  };
}

async function selectIn<T>(
  env: Env,
  sql: string,
  ids: string[],
  tailBindings: unknown[] = [],
): Promise<T[]> {
  const uniqueIds = uniqueStrings(ids);
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await env.CONTROL_DB.prepare(sql.replace("{ids}", placeholders))
    .bind(...uniqueIds, ...tailBindings)
    .all<T>();
  return result.results ?? [];
}

function emptySnapshot(): VoyagerReadonlyBackfillSnapshot {
  return {
    policies: [],
    accounts: [],
    principals: [],
    devices: [],
    rooms: [],
    memberships: [],
    messages: [],
  };
}

function snapshotSummary(snapshot: VoyagerReadonlyBackfillSnapshot): JsonObject {
  return {
    policies: snapshot.policies.length,
    accounts: snapshot.accounts.length,
    principals: snapshot.principals.length,
    devices: snapshot.devices.length,
    rooms: snapshot.rooms.length,
    memberships: snapshot.memberships.length,
    messages: snapshot.messages.length,
  };
}

function importPolicy(policy: PolicyRow): JsonObject {
  return {
    policyId: policy.policy_id,
    name: policy.name,
    policyJson: {
      source: "voyager",
      requirePasskeyOrMfa: Boolean(policy.require_passkey_or_mfa),
      requireLocalLock: Boolean(policy.require_local_lock),
      requireEmail: Boolean(policy.require_email),
      requirePhone: Boolean(policy.require_phone),
      maximumDevices: policy.maximum_devices,
      maximumOwnedGroups: policy.maximum_owned_groups,
      maximumGroupMemberships: policy.maximum_group_memberships,
      maximumAttachmentBytes: policy.maximum_attachment_bytes,
      maximumAttachmentsPerMessage: policy.maximum_attachments_per_message,
      maximumImageDimension: policy.maximum_image_dimension,
      dailyAttachmentBytesPerAccount: policy.daily_attachment_bytes_per_account,
      dailyAttachmentBytesPerRoom: policy.daily_attachment_bytes_per_room,
      messageRetentionDays: policy.message_retention_days,
      attachmentRetentionClass: policy.attachment_retention_class,
      agentAllowed: Boolean(policy.agent_allowed),
    },
  };
}

function importAccount(account: AccountRow): JsonObject {
  return {
    accountId: account.account_id,
    externalSubjectId: account.email ?? account.account_id,
    displayName: account.display_name,
    status: publicCoreAccountStatus(account),
    policyId: account.policy_id,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

function importPrincipal(principal: PrincipalRow): JsonObject {
  return {
    principalId: principal.principal_id,
    accountId: principal.account_id,
    type: publicCorePrincipalType(principal.principal_type),
    externalPrincipalRef: principal.principal_id,
    displayName: principal.display_name,
    avatarRef: principal.avatar_ref,
    status: publicCorePrincipalStatus(principal),
    ownerPrincipalId: principal.owner_principal_id,
    createdAt: principal.created_at,
    updatedAt: principal.revoked_at ?? principal.created_at,
    revokedAt: principal.revoked_at,
  };
}

function importDevice(device: DeviceRow): JsonObject {
  return {
    deviceId: device.device_id,
    accountId: device.account_id,
    principalId: device.principal_id,
    externalDeviceRef: device.device_id,
    platform: device.platform,
    label: device.device_label,
    credentialFingerprint: device.credential_fingerprint,
    publicKeyPackage: device.public_key_package,
    notificationCapability: device.notification_capability,
    clientVersion: device.client_version,
    protocolVersion: device.protocol_version,
    status: device.revoked_at ? "revoked" : "active",
    createdAt: device.created_at,
    updatedAt: device.revoked_at ?? device.last_seen_at ?? device.created_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
  };
}

function importRoom(room: VoyagerRoomBackfillRow): JsonObject {
  return {
    roomId: room.room_id,
    type: room.type,
    title: room.name,
    status: room.status,
    createdByPrincipalId: room.created_by_principal_id,
    ownerPrincipalId: room.owner_principal_id ?? room.created_by_principal_id,
    version: room.version,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
    archivedAt: room.archived_at,
  };
}

function importMembership(membership: VoyagerMembershipBackfillRow): JsonObject {
  const state = coreMembershipState(membership.status);
  return {
    roomId: membership.room_id,
    principalId: membership.principal_id,
    role: membership.role,
    state,
    joinedAt: state === "active" ? membership.created_at : null,
    leftAt: state === "left" || state === "removed" ? membership.removed_at ?? membership.updated_at : null,
    createdAt: membership.created_at,
    updatedAt: membership.updated_at,
  };
}

function importMessage(message: VoyagerMessageBackfillRow): JsonObject {
  const deletedAt = message.deleted_for_everyone_at;
  return {
    envelopeId: message.envelope_id,
    roomId: message.room_id,
    serverSequence: message.server_sequence,
    senderPrincipalId: message.sender_principal_id,
    senderDeviceId: message.sender_device_id,
    clientMessageId: null,
    idempotencyKey: message.idempotency_key,
    rootEnvelopeId: null,
    messageKind: "message",
    bodyCiphertext: deletedAt ? null : message.ciphertext,
    attachmentCount: 0,
    status: deletedAt ? "deleted_for_everyone" : message.edited_at ? "edited" : "active",
    forwardedFromRoomId: null,
    forwardedFromEnvelopeId: null,
    forwardedByPrincipalId: null,
    createdAt: message.server_received_at,
    updatedAt: message.edited_at ?? deletedAt ?? message.server_received_at,
    deletedAt,
  };
}

async function parseJsonObjectResponse(response: Response): Promise<JsonObject> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core proxy returned a non-JSON response.",
      { upstreamStatus: response.status },
    );
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core proxy returned an invalid JSON response.",
      { upstreamStatus: response.status },
    );
  }
  return payload as JsonObject;
}

function objectField(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core proxy response is missing the expected object field.",
      { field: key },
    );
  }
  return field as JsonObject;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function messagingCoreUrl(config: BridgeConfig, path: string): string {
  if (!config.baseUrl) {
    throw new Error("Messaging Core base URL is not configured.");
  }
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

function appendQuery(path: string, query?: URLSearchParams): string {
  const serialized = query?.toString();
  return serialized ? `${path}?${serialized}` : path;
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
    messageCutoverEnabled: booleanEnv(env.VOYAGER_MESSAGING_CORE_MESSAGE_CUTOVER),
    tenantId: env.MESSAGING_CORE_TENANT_ID?.trim() || VOYAGER_DEFAULT_MESSAGING_TENANT_ID,
    tenantExternalRef: env.MESSAGING_CORE_TENANT_EXTERNAL_REF?.trim() || DEFAULT_APP_ID,
    tenantDisplayName: env.MESSAGING_CORE_TENANT_DISPLAY_NAME?.trim() || DEFAULT_TENANT_DISPLAY_NAME,
    app: env.MESSAGING_CORE_APP_ID?.trim() || DEFAULT_APP_ID,
    baseUrl: trimmed(env.MESSAGING_CORE_BASE_URL),
    serviceBinding: env.MESSAGING_CORE_SERVICE ?? null,
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

function publicIdentitySyncFailureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "internal_service_timeout";
    if (/^internal_service_http_\d{3}$/.test(error.message)) return error.message;
  }
  return "internal_service_unavailable";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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

function importLimit(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_BACKFILL_BATCH_ITEMS
  ) {
    throw new HttpError(400, "invalid_field", `Field must be an integer between 1 and ${MAX_BACKFILL_BATCH_ITEMS}: ${key}`);
  }
  return value;
}

function booleanOption(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_field", `Field must be a boolean: ${key}`);
  }
  return value;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function coreMembershipState(status: VoyagerMembershipBackfillRow["status"]): "invited" | "active" | "left" | "removed" {
  if (status === "invited") return "invited";
  if (status === "active") return "active";
  if (status === "leaving") return "left";
  return "removed";
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
