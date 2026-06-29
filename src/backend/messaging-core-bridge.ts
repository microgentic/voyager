import { randomId } from "../crypto";
import { HttpError } from "../http";
import type { AccountRow, DeviceRow, Env, PrincipalRow } from "../types";
import { ROOM_INVITATION_DAYS } from "./rooms/types";
import type { JsonObject } from "./shared/types";

export const VOYAGER_DEFAULT_MESSAGING_TENANT_ID = "tenant_voyager_default";

type MessagingCoreMode = "proxy";
type PublicCoreMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type PrincipalType = "human" | "agent" | "service";
type IdentitySyncStep = "tenant" | "account" | "principal" | "device";
type IdentitySyncSource = "unconfigured" | "cache" | "internal_service" | "stale_cache";
type MessageCutoverResponseKind =
  | "messages"
  | "message"
  | "deleted"
  | "receipt"
  | "thread"
  | "threads"
  | "threadState"
  | "attachment"
  | "ok";
type CallCutoverResponseKind = "calls" | "call" | "realtime" | "signal" | "usageReport";

const DEFAULT_APP_ID = "voyager";
const DEFAULT_TENANT_DISPLAY_NAME = "Voyager";
const DEFAULT_TOKEN_AUDIENCE = "messaging-core";
const DEFAULT_INTERNAL_AUDIENCE = "messaging-core-internal";
const DEFAULT_TOKEN_ISSUER = "voyager";
const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_INTERNAL_TOKEN_TTL_SECONDS = 5 * 60;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_IDENTITY_SYNC_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IDENTITY_SYNC_STALE_GRACE_MS = 60 * 60 * 1000;
const MAX_IDENTITY_SYNC_MEMORY_CACHE_ENTRIES = 1000;
const CORE_MESSAGE_COMPAT_EXPIRES_AT = "9999-12-31T23:59:59.000Z";
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const encoder = new TextEncoder();
const identitySyncMemoryCache = new Map<string, IdentitySyncCacheRow>();

export interface MessagingCoreIdentity {
  account: AccountRow;
  principal: PrincipalRow;
  device: DeviceRow;
  roles: string[];
}

interface BridgeConfig {
  mode: MessagingCoreMode;
  allCutoverEnabled: boolean;
  roomCutoverEnabled: boolean;
  messageCutoverEnabled: boolean;
  syncCutoverEnabled: boolean;
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
  identitySyncTtlMs: number;
  identitySyncStaleGraceMs: number;
}

interface IdentitySyncResult {
  attempted: boolean;
  ok: boolean;
  source: IdentitySyncSource;
  reason: string | null;
  upstreamError?: JsonObject | null;
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

class MessagingCoreInternalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly upstreamCode: string,
    readonly upstreamMessage: string,
    readonly path: string,
  ) {
    super(`internal_service_http_${status}`);
  }
}

interface IdentitySyncCacheRow {
  synced_at: string;
  expires_at: string;
}

interface IdentitySyncCacheLookup {
  fresh: boolean;
  staleUsable: boolean;
  row: IdentitySyncCacheRow | null;
}

export function messagingCoreBridgeStatus(env: Env): JsonObject {
  const config = resolveBridgeConfig(env);
  return {
    enabled: true,
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
      required: true,
      ttlMs: config.identitySyncTtlMs,
      staleGraceMs: config.identitySyncStaleGraceMs,
    },
    cutover: {
      allCoreMessaging: config.allCutoverEnabled,
      roomRoutes: config.roomCutoverEnabled,
      messageRoutes: config.messageCutoverEnabled,
      syncRoute: config.syncCutoverEnabled,
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
  if (!bridgeCanMintClientToken(config)) {
    return base;
  }

  return (await createConfiguredMessagingCoreSession(env, config, base, identity)).session;
}

export async function syncMessagingCorePrincipal(env: Env, principalId: string): Promise<void> {
  const config = resolveBridgeConfig(env);
  if (!config.baseUrl || !config.internalSecret) {
    throw new HttpError(
      503,
      "messaging_core_unconfigured",
      "Messaging Core is not configured.",
      { reason: bridgeStatusReason(config) },
    );
  }

  const identity = await loadVoyagerPrincipalIdentity(env, principalId);
  const token = await mintInternalServiceToken(config, [
    "internal:tenants:upsert",
    "internal:accounts:upsert",
    "internal:principals:upsert",
  ]);
  await syncMessagingCoreTenantAccountPrincipal(env, config, token, identity.account, identity.principal);
}

export async function fetchMessagingCoreAttachmentUsage(env: Env): Promise<JsonObject | null> {
  const config = resolveBridgeConfig(env);
  if (!config.baseUrl || !config.internalSecret) {
    return null;
  }
  const token = await mintInternalServiceToken(config, ["internal:usage"]);
  const response = await fetchMessagingCore(
    config,
    new Request(
      messagingCoreUrl(
        config,
        `/internal/usage?tenantId=${encodeURIComponent(config.tenantId)}&limit=1`,
      ),
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(config.fetchTimeoutMs),
      },
    ),
  );
  const payload = await parseJsonObjectResponse(response);
  if (!response.ok) {
    throw new HttpError(
      502,
      "messaging_core_usage_unavailable",
      "Messaging Core usage summary is unavailable.",
      { upstreamStatus: response.status, upstreamError: stringValue(payload.error) },
    );
  }
  const usage = objectField(payload, "attachmentUsage");
  return {
    activeAttachmentCount: requiredCoreNumber(usage, "activeAttachmentCount"),
    activeExpectedBytes: requiredCoreNumber(usage, "activeExpectedBytes"),
    allocatedExpectedBytesLast24h: requiredCoreNumber(usage, "allocatedExpectedBytesLast24h"),
    uploadedStoredBytes: requiredCoreNumber(usage, "uploadedStoredBytes"),
  };
}

export async function fetchMessagingCoreSyncCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  query?: URLSearchParams,
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_unconfigured",
      "Messaging Core is not configured.",
      { reason: bridgeStatusReason(config) },
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

  const route = appendQuery("/sync", query);
  const upstream = await getPublicCoreJson(config, token, route);
  const coreRooms = arrayField(upstream.payload, "rooms");
  const roomViews: JsonObject[] = [];
  for (const coreRoom of coreRooms) {
    const roomId = requiredCoreString(coreRoom, "roomId");
    roomViews.push((await getPublicCoreJson(config, token, `/rooms/${encodeURIComponent(roomId)}`)).payload);
  }
  const rooms = await adaptCoreRoomViews(env, roomViews);
  await syncVoyagerRoomShadows(env, rooms);
  const pendingMessages = await adaptCoreMessages(env, arrayField(upstream.payload, "pendingMessages"));
  return {
    status: upstream.status,
    payload: {
      ok: true,
      sync: {
        rooms,
        roomsNextCursor: stringValue(upstream.payload.roomsNextCursor),
        pendingMessages,
        serverTime: stringValue(upstream.payload.serverTime),
      },
      messagingCoreCutover: cutoverDiagnostics(config, {
        route,
        upstreamStatus: upstream.status,
      }),
    },
  };
}

export async function fetchMessagingCoreRealtimeTokenProxy(
  env: Env,
  identity: MessagingCoreIdentity,
): Promise<JsonObject> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_proxy_unconfigured",
      "Messaging Core proxy is not configured.",
      { reason: bridgeStatusReason(config) },
    );
  }

  const { session, token } = await createConfiguredMessagingCoreSession(env, config, base, identity);
  const route = "/realtime/token";
  const upstream = await publicCoreJson(config, token, "POST", route, {});
  return {
    messagingCore: session,
    realtime: upstream.payload,
    proxied: {
      route,
      upstreamStatus: upstream.status,
    },
  };
}

export async function fetchMessagingCoreCallCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  method: PublicCoreMethod,
  path: string,
  options: {
    body?: Record<string, unknown>;
    query?: URLSearchParams;
    responseKind: CallCutoverResponseKind;
  },
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_unconfigured",
      "Messaging Core is not configured.",
      { reason: bridgeStatusReason(config) },
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
  const upstream = await publicCoreJson(config, token, method, route, options.body, {
    preserveClientErrors: true,
  });
  return {
    status: upstream.status,
    payload: {
      ok: true,
      ...adaptCallCutoverPayload(upstream.payload, options.responseKind),
      messagingCoreCutover: cutoverDiagnostics(config, {
        route,
        upstreamStatus: upstream.status,
      }),
    },
  };
}

export async function fetchMessagingCoreCallRealtimeStatus(env: Env): Promise<JsonObject> {
  const config = resolveBridgeConfig(env);
  if (!config.baseUrl) {
    return coreRealtimeStatusPayload({
      features: {},
      calls: {},
      configured: false,
      configurationStatus: "base_url_unconfigured",
    });
  }
  const response = await fetchPublicCore(
    config,
    new Request(messagingCoreUrl(config, "/meta"), {
      method: "GET",
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    }),
  );
  const payload = await parseJsonObjectResponse(response);
  if (!response.ok) {
    throwCorePayloadError(response.status, payload);
  }
  return coreRealtimeStatusPayload(payload);
}

export async function revokeMessagingCoreDevice(env: Env, deviceId: string): Promise<JsonObject | null> {
  const config = resolveBridgeConfig(env);
  if (!config.baseUrl || !config.internalSecret) return null;
  const token = await mintInternalServiceToken(config, ["internal:devices:upsert"]);
  const payload = await postInternal(
    config,
    token,
    `/internal/tenants/${encodeURIComponent(config.tenantId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
    {},
  );
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonObject : null;
}

export function messagingCoreAttachmentAllocateBody(body: Record<string, unknown>): Record<string, unknown> {
  const expectedBytes = numberValue(body.expectedBytes);
  if (expectedBytes === null || !Number.isInteger(expectedBytes) || expectedBytes < 1) {
    throw new HttpError(400, "invalid_field", "Field must be a positive integer: expectedBytes");
  }
  const declaredMimeType = stringValue(body.declaredMimeType);
  const contentCategory = stringValue(body.contentCategory);
  return {
    contentType: messagingCoreAttachmentContentType(declaredMimeType, contentCategory),
    byteSize: expectedBytes,
    metadata: voyagerAttachmentMetadata(body),
  };
}

export function messagingCoreAttachmentCompleteBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    metadata: voyagerAttachmentMetadata(body),
  };
}

type RoomCutoverResponseKind =
  | "rooms"
  | "room"
  | "member"
  | "invitation"
  | "invitations"
  | "transfer"
  | "ok";

export async function fetchMessagingCoreRoomCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  method: PublicCoreMethod,
  path: string,
  options: {
    body?: Record<string, unknown>;
    query?: URLSearchParams;
    responseKind: RoomCutoverResponseKind;
    memberPrincipalId?: string;
  },
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_unconfigured",
      "Messaging Core is not configured.",
      { reason: bridgeStatusReason(config) },
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
  const upstream = await publicCoreJson(config, token, method, route, options.body, {
    preserveClientErrors: true,
    voyagerMessageCompatibility: true,
  });
  const adapted = await adaptRoomCutoverPayload(env, config, token, upstream.payload, options);
  await syncVoyagerRoomShadows(env, adapted);
  if (options.responseKind === "invitation") {
    await syncVoyagerRoomShadowForInvitation(env, config, token, adapted);
  }
  return {
    status: upstream.status,
    payload: {
      ok: true,
      ...adapted,
      messagingCoreCutover: cutoverDiagnostics(config, {
        route,
        upstreamStatus: upstream.status,
      }),
    },
  };
}

export async function fetchMessagingCoreMessageCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  method: PublicCoreMethod,
  path: string,
  options: {
    body?: Record<string, unknown>;
    query?: URLSearchParams;
    responseKind?: MessageCutoverResponseKind;
    roomId?: string;
  } = {},
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_unconfigured",
      "Messaging Core is not configured.",
      { reason: bridgeStatusReason(config) },
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
  const upstream = await publicCoreJson(config, token, method, route, options.body, {
    preserveClientErrors: true,
    voyagerMessageCompatibility: true,
  });
  const payload = await adaptMessageCutoverPayload(env, config, token, upstream.payload, options.responseKind ?? "ok", options);
  return {
    status: upstream.status,
    payload: {
      ok: true,
      ...payload,
      messagingCoreCutover: cutoverDiagnostics(config, {
        route,
        upstreamStatus: upstream.status,
      }),
    },
  };
}

export async function fetchMessagingCoreAttachmentUploadCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  path: string,
  request: Request,
  query?: URLSearchParams,
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const { token, sync } = await requireMessageCutoverSession(env, config, identity);
  if (!sync.ok) {
    throw new HttpError(
      503,
      "messaging_core_identity_sync_failed",
      "Messaging Core identity sync failed",
      { reason: sync.reason },
    );
  }

  const route = appendQuery(path, query);
  const upstream = await publicCoreRaw(config, token, "PUT", route, request, {
    preserveClientErrors: true,
    voyagerMessageCompatibility: true,
  });
  const payload = await parseJsonObjectResponse(upstream.response);
  const adapted = await adaptMessageCutoverPayload(env, config, token, payload, "attachment");
  return {
    status: upstream.response.status,
    payload: {
      ok: true,
      ...adapted,
      messagingCoreCutover: cutoverDiagnostics(config, {
        route,
        upstreamStatus: upstream.response.status,
      }),
    },
  };
}

export async function fetchMessagingCoreAttachmentDownloadCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  path: string,
  query?: URLSearchParams,
): Promise<Response> {
  const config = resolveBridgeConfig(env);
  const { token, sync } = await requireMessageCutoverSession(env, config, identity);
  if (!sync.ok) {
    throw new HttpError(
      503,
      "messaging_core_identity_sync_failed",
      "Messaging Core identity sync failed",
      { reason: sync.reason },
    );
  }

  const route = appendQuery(path, query);
  const upstream = await publicCoreRaw(config, token, "GET", route, undefined, {
    preserveClientErrors: true,
    voyagerMessageCompatibility: true,
  });
  if (!upstream.response.ok) {
    await throwCoreResponseError(upstream.response, {
      preserveClientErrors: true,
      voyagerMessageCompatibility: true,
    });
  }
  return new Response(upstream.response.body, {
    status: upstream.response.status,
    statusText: upstream.response.statusText,
    headers: upstream.response.headers,
  });
}

async function requireMessageCutoverSession(
  env: Env,
  config: BridgeConfig,
  identity: MessagingCoreIdentity,
): Promise<{ token: string; sync: IdentitySyncResult }> {
  const base = messagingCoreBridgeStatus(env);
  if (!bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_unconfigured",
      "Messaging Core is not configured.",
      { reason: bridgeStatusReason(config) },
    );
  }
  return createConfiguredMessagingCoreSession(env, config, base, identity);
}

function cutoverDiagnostics(
  config: BridgeConfig,
  options: {
    route: string;
    upstreamStatus: number;
    fallbackReason?: string | null;
  },
): JsonObject {
  return {
    source: "core",
    fallbackReason: options.fallbackReason ?? null,
    route: options.route,
    upstreamStatus: options.upstreamStatus,
    flags: cutoverFlagSnapshot(config),
  };
}

function cutoverFlagSnapshot(config: BridgeConfig): JsonObject {
  return {
    mode: config.mode,
    allCoreMessaging: config.allCutoverEnabled,
    roomRoutes: config.roomCutoverEnabled,
    messageRoutes: config.messageCutoverEnabled,
    syncRoute: config.syncCutoverEnabled,
  };
}

async function adaptRoomCutoverPayload(
  env: Env,
  config: BridgeConfig,
  token: string,
  payload: JsonObject,
  options: {
    responseKind: RoomCutoverResponseKind;
    query?: URLSearchParams;
    memberPrincipalId?: string;
  },
): Promise<JsonObject> {
  if (options.responseKind === "rooms") {
    const coreRooms = arrayField(payload, "rooms");
    const page = roomCutoverPage(options.query);
    const pagedCoreRooms = coreRooms.slice(page.offset, page.offset + page.limit);
    const roomViews: JsonObject[] = [];
    for (const coreRoom of pagedCoreRooms) {
      const roomId = requiredCoreString(coreRoom, "roomId");
      roomViews.push((await getPublicCoreJson(config, token, `/rooms/${encodeURIComponent(roomId)}`)).payload);
    }
    return {
      rooms: await adaptCoreRoomViews(env, roomViews),
      nextCursor: pagedCoreRooms.length === page.limit ? String(page.offset + page.limit) : null,
    };
  }

  if (options.responseKind === "room") {
    const room = (await adaptCoreRoomViews(env, [payload]))[0];
    return { room };
  }

  if (options.responseKind === "member") {
    const room = (await adaptCoreRoomViews(env, [payload]))[0];
    const member = room.members.find((candidate) => candidate.principalId === options.memberPrincipalId);
    if (!member) {
      throw new HttpError(
        502,
        "messaging_core_proxy_invalid_response",
        "Messaging Core room response did not include the expected member.",
        { principalId: options.memberPrincipalId },
      );
    }
    return { member };
  }

  if (options.responseKind === "invitation") {
    return { invitation: await adaptCoreInvitation(env, objectValue(payload.invitation) ?? payload) };
  }

  if (options.responseKind === "invitations") {
    const invitations = await Promise.all(arrayField(payload, "invitations").map((invitation) => adaptCoreInvitation(env, invitation)));
    return { invitations, nextCursor: null };
  }

  if (options.responseKind === "transfer") {
    return { transfer: adaptCoreOwnershipTransfer(objectValue(payload.transfer) ?? payload) };
  }

  return {};
}

async function adaptCoreRoomViews(env: Env, roomViews: JsonObject[]): Promise<Array<JsonObject & { members: JsonObject[] }>> {
  const rooms = roomViews.map((view) => objectField(view, "room"));
  const membersByRoom = roomViews.map((view) => arrayField(view, "members"));
  const principalIds = uniqueStrings([
    ...rooms.map((room) => stringValue(room.createdByPrincipalId)),
    ...membersByRoom.flat().map((member) => stringValue(member.principalId)),
  ]);
  const roomIds = rooms.map((room) => requiredCoreString(room, "roomId"));
  const profiles = await loadVoyagerPrincipalProfiles(env, principalIds);
  const pinnedSummaries = await loadVoyagerPinnedSummaries(env, roomIds);

  return rooms.map((room, index) => {
    const roomId = requiredCoreString(room, "roomId");
    const createdByPrincipalId = requiredCoreString(room, "createdByPrincipalId");
    const createdBy = profiles.get(createdByPrincipalId);
    if (!createdBy) {
      throw new HttpError(
        502,
        "messaging_core_proxy_invalid_response",
        "Messaging Core room references a principal Voyager cannot resolve.",
        { principalId: createdByPrincipalId },
      );
    }
    const corePinnedCount = numberValue(room.pinnedMessageCount);
    const coreLatestPinnedMessageId = stringValue(room.latestPinnedMessageId);
    const pinned = corePinnedCount !== null || coreLatestPinnedMessageId !== null
      ? { pinnedMessageCount: corePinnedCount ?? 0, latestPinnedMessageId: coreLatestPinnedMessageId }
      : (pinnedSummaries.get(roomId) ?? { pinnedMessageCount: 0, latestPinnedMessageId: null });
    return {
      roomId,
      type: requiredCoreString(room, "type"),
      name: stringValue(room.title),
      description: stringValue(room.description),
      status: requiredCoreString(room, "status"),
      version: numberValue(room.version) ?? 1,
      createdByAccountId: createdBy.accountId,
      createdByPrincipalId,
      createdAt: requiredCoreString(room, "createdAt"),
      updatedAt: requiredCoreString(room, "updatedAt"),
      archivedAt: stringValue(room.archivedAt),
      pinnedMessageCount: pinned.pinnedMessageCount,
      latestPinnedMessageId: pinned.latestPinnedMessageId,
      members: membersByRoom[index].map((member) => adaptCoreRoomMember(roomId, member, profiles)),
    };
  });
}

async function syncVoyagerRoomShadows(env: Env, payload: JsonObject | JsonObject[]): Promise<void> {
  const rooms = Array.isArray(payload)
    ? payload
    : [
        ...jsonObjectArrayValue(payload.rooms),
        ...jsonObjectArrayValue(payload.room ? [payload.room] : []),
      ];
  for (const room of rooms) {
    await upsertVoyagerRoomShadow(env, room);
  }
}

async function syncVoyagerRoomShadowForInvitation(
  env: Env,
  config: BridgeConfig,
  token: string,
  payload: JsonObject,
): Promise<void> {
  const invitation = objectValue(payload.invitation);
  const roomId = invitation ? stringValue(invitation.roomId) : null;
  const status = invitation ? stringValue(invitation.status) : null;
  if (!roomId || (status !== "pending" && status !== "accepted")) return;

  const roomView = await getPublicCoreJson(config, token, `/rooms/${encodeURIComponent(roomId)}`);
  const room = (await adaptCoreRoomViews(env, [roomView.payload]))[0];
  await syncVoyagerRoomShadows(env, { room });
}

async function upsertVoyagerRoomShadow(env: Env, room: JsonObject): Promise<void> {
  const roomId = requiredCoreString(room, "roomId");
  const type = requiredCoreString(room, "type");
  const createdByAccountId = requiredCoreString(room, "createdByAccountId");
  const createdByPrincipalId = requiredCoreString(room, "createdByPrincipalId");
  const status = requiredCoreString(room, "status");
  const version = numberValue(room.version) ?? 1;
  const createdAt = requiredCoreString(room, "createdAt");
  const updatedAt = requiredCoreString(room, "updatedAt");
  await env.CONTROL_DB.prepare(
    `INSERT INTO rooms (
       room_id, type, name, description, created_by_account_id,
       created_by_principal_id, status, version, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET
       type = excluded.type,
       name = excluded.name,
       description = excluded.description,
       status = excluded.status,
       version = excluded.version,
       updated_at = excluded.updated_at,
       archived_at = excluded.archived_at`,
  )
    .bind(
      roomId,
      type,
      stringValue(room.name),
      stringValue(room.description),
      createdByAccountId,
      createdByPrincipalId,
      status,
      version,
      createdAt,
      updatedAt,
      stringValue(room.archivedAt),
    )
    .run();

  for (const member of jsonObjectArrayValue(room.members)) {
    await upsertVoyagerMembershipShadow(env, roomId, member, createdByPrincipalId);
  }
}

async function upsertVoyagerMembershipShadow(
  env: Env,
  roomId: string,
  member: JsonObject,
  fallbackInviterPrincipalId: string,
): Promise<void> {
  const membershipId = stringValue(member.membershipId) ?? randomId("mem");
  const accountId = requiredCoreString(member, "accountId");
  const principalId = requiredCoreString(member, "principalId");
  const role = requiredCoreString(member, "role");
  const status = requiredCoreString(member, "status");
  const createdAt = requiredCoreString(member, "createdAt");
  const updatedAt = requiredCoreString(member, "updatedAt");
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_memberships (
       membership_id, room_id, account_id, principal_id, role, status,
       invited_by_principal_id, created_at, updated_at, removed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id, principal_id) DO UPDATE SET
       account_id = excluded.account_id,
       role = excluded.role,
       status = excluded.status,
       updated_at = excluded.updated_at,
       removed_at = excluded.removed_at`,
  )
    .bind(
      membershipId,
      roomId,
      accountId,
      principalId,
      role,
      status,
      fallbackInviterPrincipalId,
      createdAt,
      updatedAt,
      stringValue(member.removedAt),
    )
    .run();
}

function adaptCoreRoomMember(
  roomId: string,
  member: JsonObject,
  profiles: Map<string, VoyagerPrincipalProfile>,
): JsonObject {
  const principalId = requiredCoreString(member, "principalId");
  const profile = profiles.get(principalId);
  if (!profile) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core room member references a principal Voyager cannot resolve.",
      { principalId },
    );
  }
  const state = requiredCoreString(member, "state");
  return {
    membershipId: `${roomId}:${principalId}`,
    roomId,
    accountId: profile.accountId,
    principalId,
    principalType: profile.principalType,
    displayName: profile.displayName,
    role: requiredCoreString(member, "role"),
    status: voyagerMembershipStatus(state),
    createdAt: requiredCoreString(member, "createdAt"),
    updatedAt: requiredCoreString(member, "updatedAt"),
    removedAt: state === "active" || state === "invited"
      ? null
      : stringValue(member.leftAt) ?? stringValue(member.updatedAt),
  };
}

function voyagerMembershipStatus(coreState: string): string {
  if (coreState === "left") return "leaving";
  return coreState;
}

async function adaptCoreInvitation(env: Env, invitation: JsonObject): Promise<JsonObject> {
  const invitedPrincipalId = requiredCoreString(invitation, "inviteePrincipalId");
  const invitedByPrincipalId = requiredCoreString(invitation, "inviterPrincipalId");
  const profiles = await loadVoyagerPrincipalProfiles(env, [invitedPrincipalId, invitedByPrincipalId]);
  const invitee = profiles.get(invitedPrincipalId);
  const inviter = profiles.get(invitedByPrincipalId);
  if (!invitee || !inviter) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core room invitation references a principal Voyager cannot resolve.",
      { invitedPrincipalId, invitedByPrincipalId },
    );
  }
  return {
    roomInvitationId: requiredCoreString(invitation, "roomInvitationId"),
    roomId: requiredCoreString(invitation, "roomId"),
    roomName: stringValue(invitation.roomTitle),
    roomType: requiredCoreString(invitation, "roomType"),
    invitedAccountId: invitee.accountId,
    invitedPrincipalId,
    invitedByAccountId: inviter.accountId,
    invitedByPrincipalId,
    invitedByDisplayName: inviter.displayName,
    role: requiredCoreString(invitation, "role"),
    status: requiredCoreString(invitation, "status"),
    expiresAt: stringValue(invitation.expiresAt) ?? requiredCoreString(invitation, "createdAt"),
    respondedAt: stringValue(invitation.respondedAt),
    createdAt: requiredCoreString(invitation, "createdAt"),
  };
}

function adaptCoreOwnershipTransfer(transfer: JsonObject): JsonObject {
  return {
    transferId: requiredCoreString(transfer, "ownershipTransferId"),
    roomId: requiredCoreString(transfer, "roomId"),
    fromPrincipalId: requiredCoreString(transfer, "fromPrincipalId"),
    toPrincipalId: requiredCoreString(transfer, "toPrincipalId"),
    status: voyagerOwnershipTransferStatus(requiredCoreString(transfer, "status")),
    expiresAt: stringValue(transfer.expiresAt) ?? requiredCoreString(transfer, "createdAt"),
    createdAt: requiredCoreString(transfer, "createdAt"),
    respondedAt: stringValue(transfer.completedAt),
  };
}

function adaptCallCutoverPayload(payload: JsonObject, responseKind: CallCutoverResponseKind): JsonObject {
  if (responseKind === "calls") {
    return {
      calls: arrayField(payload, "calls"),
      nextCursor: stringValue(payload.nextCursor),
    };
  }
  if (responseKind === "call") {
    return { call: objectValue(payload.call) ?? payload };
  }
  if (responseKind === "realtime") {
    return { realtime: adaptCallRealtimePayload(payload) };
  }
  if (responseKind === "signal") {
    return {
      delivered: Boolean(payload.delivered),
      signal: objectValue(payload.signal) ?? payload,
    };
  }
  return { usageReport: objectValue(payload.usageReport) ?? payload };
}

function adaptCallRealtimePayload(payload: JsonObject): JsonObject {
  const realtime = objectValue(payload.realtime) ?? payload;
  const features = objectValue(realtime.features);
  const message = stringValue(realtime.message) ?? coreCallRealtimeMessage(realtime);
  const session = adaptCallRealtimeSession(objectValue(realtime.session));
  if (!features) {
    return {
      ...realtime,
      message,
      ...(session ? { session } : {}),
    };
  }
  return {
    ...realtime,
    message,
    ...(session ? { session } : {}),
    features: coreCallFeatureFlags(features),
  };
}

function coreRealtimeStatusPayload(payload: JsonObject): JsonObject {
  const features = objectValue(payload.features) ?? {};
  const calls = objectValue(payload.calls) ?? {};
  const provider = callMediaProvider(calls);
  const realtimeMediaEnabled = Boolean(features.realtimeMedia);
  const configured = Boolean(calls.mediaConfigured ?? calls.realtimeMediaConfigured);
  const mock = Boolean(calls.mockEnabled);
  const configurationStatus = stringValue(payload.configurationStatus)
    ?? (realtimeMediaEnabled ? (configured ? "configured" : "not_configured") : "disabled");
  return {
    provider,
    configured,
    configurationStatus,
    status: configurationStatus,
    configurationCheckedAt: new Date().toISOString(),
    providerHealthStatus: "not_checked",
    providerHealthCheckedAt: null,
    mock,
    apiBase: "managed-by-messaging-core",
    turnConfigured: Boolean(calls.turnConfigured),
    lastProviderCheckAt: null,
    lastProviderCheckStatus: "not_checked",
    estimatedSfuTurnEgressStatus: "owned_by_messaging_core",
    features: coreCallFeatureFlags(features),
    credentialState: {
      appIdConfigured: provider === "cloudflare_realtime" && configured && !mock,
      appSecretConfigured: provider === "cloudflare_realtime" && configured && !mock,
      turnCredentialsConfigured: Boolean(calls.turnConfigured),
    },
    messagingCore: {
      source: "core",
      serviceName: stringValue(payload.serviceName),
      routePrefix: stringValue(payload.routePrefix),
    },
  };
}

function callMediaProvider(calls: JsonObject): "cloudflare_realtime" | "p2p_webrtc" {
  return stringValue(calls.mediaProvider) === "p2p_webrtc" || stringValue(calls.provider) === "p2p_webrtc"
    ? "p2p_webrtc"
    : "cloudflare_realtime";
}

function coreCallFeatureFlags(features: JsonObject): JsonObject {
  return {
    callsEnabled: Boolean(features.callsEnabled ?? features.calls),
    audioCallsEnabled: Boolean(features.audioCallsEnabled ?? features.audioCalls),
    videoCallsEnabled: Boolean(features.videoCallsEnabled ?? features.videoCalls),
    screenShareEnabled: Boolean(features.screenShareEnabled ?? features.screenShare),
    p2pCallsEnabled: Boolean(features.p2pCallsEnabled ?? features.p2pCalls),
    realtimeMediaEnabled: Boolean(features.realtimeMediaEnabled ?? features.realtimeMedia),
  };
}

function coreCallRealtimeMessage(realtime: JsonObject): string {
  const provider = callMediaProvider(realtime);
  if (provider === "p2p_webrtc") {
    if (!Boolean(realtime.configured)) {
      return "P2P WebRTC media is not configured by Messaging Core.";
    }
    return "P2P WebRTC media is configured by Messaging Core.";
  }
  if (!Boolean(realtime.configured)) {
    return "Cloudflare Realtime is not configured by Messaging Core.";
  }
  if (Boolean(realtime.mock)) {
    return "Cloudflare Realtime mock is configured by Messaging Core.";
  }
  return "Cloudflare Realtime is configured by Messaging Core.";
}

function adaptCallRealtimeSession(session: JsonObject | null): JsonObject | null {
  if (!session) return null;
  const providerSessionId = stringValue(session.providerSessionId);
  if (!providerSessionId) return session;
  return {
    ...session,
    coreSessionId: stringValue(session.sessionId),
    sessionId: providerSessionId,
  };
}

async function adaptMessageCutoverPayload(
  env: Env,
  config: BridgeConfig,
  token: string,
  payload: JsonObject,
  responseKind: MessageCutoverResponseKind,
  context: { roomId?: string } = {},
): Promise<JsonObject> {
  if (responseKind === "messages") {
    return {
      messages: await adaptCoreMessages(env, arrayField(payload, "messages")),
      nextCursor: stringValue(payload.nextCursor),
    };
  }

  if (responseKind === "message") {
    return { message: (await adaptCoreMessages(env, [objectValue(payload.message) ?? payload]))[0] };
  }

  if (responseKind === "thread") {
    const root = objectField(payload, "root");
    const replies = arrayField(payload, "replies");
    const adapted = await adaptCoreMessages(env, [root, ...replies]);
    return {
      thread: {
        root: adapted[0],
        replies: adapted.slice(1),
        olderCursor: stringValue(payload.olderCursor),
      },
    };
  }

  if (responseKind === "threads") {
    const coreItems = arrayField(payload, "items");
    const roots = coreItems.map((item) => objectField(item, "root"));
    const roomIds = uniqueStrings(roots.map((root) => stringValue(root.roomId)));
    const roomViews: JsonObject[] = [];
    for (const roomId of roomIds) {
      roomViews.push((await getPublicCoreJson(config, token, `/rooms/${encodeURIComponent(roomId)}`)).payload);
    }
    const rooms = new Map((await adaptCoreRoomViews(env, roomViews)).map((room) => [requiredCoreString(room, "roomId"), room]));
    const adaptedRoots = await adaptCoreMessages(env, roots);
    return {
      items: coreItems.map((item, index) => {
        const root = adaptedRoots[index];
        const roomId = requiredCoreString(roots[index], "roomId");
        const room = rooms.get(roomId);
        if (!room) {
          throw new HttpError(
            502,
            "messaging_core_proxy_invalid_response",
            "Messaging Core thread inbox references a room Voyager cannot adapt.",
            { roomId },
          );
        }
        const subscriptionState = stringValue(item.subscriptionState);
        return {
          room,
          root,
          following: subscriptionState === "following",
          muted: subscriptionState === "muted",
          unreadCount: numberValue(item.unreadCount) ?? 0,
          lastReadSequence: numberValue(item.lastReadReplySequence) ?? 0,
          updatedAt: stringValue(item.updatedAt) ?? stringValue(roots[index].updatedAt) ?? requiredCoreString(roots[index], "createdAt"),
        };
      }),
      nextCursor: stringValue(payload.nextCursor),
    };
  }

  if (responseKind === "threadState") {
    return { threadState: adaptCoreThreadState(objectValue(payload.threadState) ?? payload, context.roomId) };
  }

  if (responseKind === "receipt") {
    return { receipt: adaptCoreReceipt(objectValue(payload.receipt) ?? payload, context.roomId) };
  }

  if (responseKind === "attachment") {
    return { attachment: await adaptCoreAttachment(env, objectValue(payload.attachment) ?? payload) };
  }

  if (responseKind === "deleted") {
    return { deleted: payload.deleted ?? payload };
  }

  return payload;
}

async function adaptCoreMessages(env: Env, messages: JsonObject[]): Promise<JsonObject[]> {
  const profiles = await loadVoyagerPrincipalProfiles(
    env,
    uniqueStrings(messages.map((message) => stringValue(message.senderPrincipalId))),
  );
  return messages.map((message) => adaptCoreMessage(message, profiles));
}

function adaptCoreMessage(
  message: JsonObject,
  profiles: Map<string, VoyagerPrincipalProfile>,
): JsonObject {
  const senderPrincipalId = requiredCoreString(message, "senderPrincipalId");
  const sender = profiles.get(senderPrincipalId);
  if (!sender) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core message references a principal Voyager cannot resolve.",
      { principalId: senderPrincipalId },
    );
  }
  const ciphertext = stringValue(message.bodyCiphertext) ?? "deleted-for-everyone";
  const deletedAt = stringValue(message.deletedAt);
  const deletedForEveryone = objectValue(message.deletedForEveryone);
  const receipt = objectValue(message.receiptSummary) ?? {};
  const receiptStatus = coreReceiptStatus(receipt);
  return {
    envelopeId: requiredCoreString(message, "envelopeId"),
    roomId: requiredCoreString(message, "roomId"),
    senderAccountId: sender.accountId,
    senderPrincipalId,
    senderDeviceId: stringValue(message.senderDeviceId) ?? "",
    idempotencyKey: stringValue(message.idempotencyKey) ?? "",
    protocolType: voyagerProtocolType(stringValue(message.protocolType)),
    ciphertext,
    ciphertextBytes: encoder.encode(ciphertext).byteLength,
    clientCreatedAt: null,
    serverSequence: numberValue(message.serverSequence) ?? 0,
    serverReceivedAt: requiredCoreString(message, "createdAt"),
    expiresAt: CORE_MESSAGE_COMPAT_EXPIRES_AT,
    state: "available",
    editedAt: requiredCoreString(message, "status") === "edited" ? stringValue(message.updatedAt) : null,
    editCount: requiredCoreString(message, "status") === "edited" ? 1 : 0,
    forwardedFrom: adaptCoreForwardedFrom(objectValue(message.forwardedFrom)),
    deletedForEveryone: {
      deleted: requiredCoreString(message, "status") === "deleted_for_everyone",
      deletedAt: stringValue(deletedForEveryone?.deletedAt) ?? deletedAt,
      deletedByPrincipalId: stringValue(deletedForEveryone?.deletedByPrincipalId),
      reason: stringValue(deletedForEveryone?.reason),
    },
    threadRootEnvelopeId: stringValue(message.rootEnvelopeId),
    alsoSentToRoom: Boolean(message.alsoSentToRoom),
    threadSummary: adaptCoreThreadSummary(objectValue(message.threadSummary)),
    receiptSummary: {
      total: numberValue(receipt.total) ?? 0,
      pending: Math.max(0, (numberValue(receipt.total) ?? 0) - (numberValue(receipt.delivered) ?? 0)),
      delivered: numberValue(receipt.delivered) ?? 0,
      read: numberValue(receipt.read) ?? 0,
      status: receiptStatus,
    },
    reactions: jsonObjectArrayValue(message.reactions).map((reaction) => ({
      reaction: requiredCoreString(reaction, "reaction"),
      count: numberValue(reaction.count) ?? 0,
      reactedByMe: Boolean(reaction.reactedByMe),
    })),
    pin: adaptCorePin(objectValue(message.pin)),
  };
}

function coreReceiptStatus(receipt: JsonObject): "sent" | "delivered" | "read" {
  const status = stringValue(receipt.status);
  if (status === "sent" || status === "delivered" || status === "read") {
    return status;
  }
  const read = numberValue(receipt.read) ?? 0;
  if (read > 0) return "read";
  const delivered = numberValue(receipt.delivered) ?? 0;
  if (delivered > 0) return "delivered";
  return "sent";
}

function adaptCoreForwardedFrom(forwardedFrom: JsonObject | null): JsonObject | null {
  if (!forwardedFrom) return null;
  return {
    forwardedByPrincipalId: stringValue(forwardedFrom.forwardedByPrincipalId),
  };
}

function adaptCoreThreadSummary(summary: JsonObject | null): JsonObject | null {
  if (!summary) return null;
  return {
    replyCount: numberValue(summary.replyCount) ?? 0,
    lastReplyEnvelopeId: stringValue(summary.lastReplyEnvelopeId),
    lastReplySenderPrincipalId: stringValue(summary.lastReplySenderPrincipalId),
    lastReplyAt: stringValue(summary.lastReplyAt),
  };
}

function adaptCorePin(pin: JsonObject | null): JsonObject {
  return {
    pinned: Boolean(pin?.pinned),
    pinnedAt: pin ? stringValue(pin.pinnedAt) : null,
    pinnedByPrincipalId: pin ? stringValue(pin.pinnedByPrincipalId) : null,
  };
}

function adaptCoreReceipt(receipt: JsonObject, roomId: string | undefined): JsonObject {
  const envelopeId = requiredCoreString(receipt, "envelopeId");
  const recipientDeviceId = stringValue(receipt.recipientDeviceId) ?? "";
  const readAt = stringValue(receipt.readAt);
  const deliveredAt = stringValue(receipt.deliveredAt);
  return {
    receiptId: `rcp_core_${envelopeId}_${recipientDeviceId}`,
    envelopeId,
    roomId: roomId ?? "",
    recipientDeviceId,
    status: readAt ? "read" : deliveredAt ? "stored" : "pending",
    storedAt: deliveredAt,
    readAt,
  };
}

function adaptCoreThreadState(state: JsonObject, roomId: string | undefined): JsonObject {
  const subscriptionState = stringValue(state.subscriptionState);
  return {
    rootEnvelopeId: requiredCoreString(state, "rootEnvelopeId"),
    roomId: roomId ?? stringValue(state.roomId) ?? "",
    following: subscriptionState === "following",
    muted: subscriptionState === "muted",
    lastReadSequence: numberValue(state.lastReadReplySequence) ?? 0,
    updatedAt: requiredCoreString(state, "updatedAt"),
  };
}

async function adaptCoreAttachment(env: Env, attachment: JsonObject): Promise<JsonObject> {
  const ownerPrincipalId = requiredCoreString(attachment, "ownerPrincipalId");
  const profiles = await loadVoyagerPrincipalProfiles(env, [ownerPrincipalId]);
  const owner = profiles.get(ownerPrincipalId);
  if (!owner) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core attachment references a principal Voyager cannot resolve.",
      { principalId: ownerPrincipalId },
    );
  }
  const metadata = objectValue(attachment.metadata) ?? {};
  const variants = jsonObjectArrayValue(attachment.variants);
  const original = coreAttachmentVariant(attachment, variants, "original", metadata)!;
  const preview = coreAttachmentVariant(attachment, variants, "preview", metadata);
  const thumbnail = coreAttachmentVariant(attachment, variants, "thumbnail", metadata);
  const publicVariants: JsonObject = { original };
  if (preview) publicVariants.preview = preview;
  if (thumbnail) publicVariants.thumbnail = thumbnail;
  return {
    attachmentId: requiredCoreString(attachment, "attachmentId"),
    roomId: requiredCoreString(attachment, "roomId"),
    uploaderAccountId: owner.accountId,
    uploaderPrincipalId: ownerPrincipalId,
    uploaderDeviceId: stringValue(attachment.ownerDeviceId) ?? "",
    state: voyagerAttachmentState(requiredCoreString(attachment, "state")),
    expectedBytes: numberValue(attachment.byteSize) ?? 0,
    ciphertextBytes: original.bytes,
    ciphertextSha256: stringValue(metadata.ciphertextSha256),
    contentCategory: stringValue(metadata.contentCategory) ?? stringValue(attachment.contentType),
    retentionClass: stringValue(metadata.retentionClass) ?? "default",
    originalFilename: stringValue(metadata.originalFilename),
    declaredMimeType: stringValue(metadata.declaredMimeType) ?? stringValue(attachment.contentType),
    mediaKind: voyagerAttachmentMediaKind(stringValue(metadata.mediaKind), stringValue(attachment.contentType)),
    width: numberValue(metadata.width),
    height: numberValue(metadata.height),
    durationMs: numberValue(metadata.durationMs),
    variants: publicVariants,
    variantManifest: metadata.variantManifest ?? null,
    expiresAt: stringValue(metadata.expiresAt) ?? CORE_MESSAGE_COMPAT_EXPIRES_AT,
    createdAt: requiredCoreString(attachment, "allocatedAt"),
    uploadedAt: stringValue(attachment.uploadedAt),
    referencedAt: stringValue(metadata.referencedAt),
    deletedAt: stringValue(attachment.deletedAt),
  };
}

function coreAttachmentVariant(
  attachment: JsonObject,
  variants: JsonObject[],
  kind: "original" | "preview" | "thumbnail",
  metadata: JsonObject,
): JsonObject | null {
  const matched = variants.find((variant) => stringValue(variant.kind) === kind);
  if (!matched && kind !== "original") return null;
  const width = kind === "thumbnail" ? null : numberValue(metadata.width);
  const height = kind === "thumbnail" ? null : numberValue(metadata.height);
  return {
    variant: kind,
    bytes: matched ? numberValue(matched.byteSize) : null,
    width,
    height,
    downloadPath: `/v1/attachments/${requiredCoreString(attachment, "attachmentId")}/blob?variant=${kind}`,
  };
}

function voyagerAttachmentState(state: string): string {
  if (state === "completed") return "uploaded";
  return state;
}

function voyagerAttachmentMediaKind(value: string | null, contentType: string | null): string {
  if (value === "image" || value === "video" || value === "audio" || value === "file" || value === "unknown") {
    return value;
  }
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}

function messagingCoreAttachmentContentType(declaredMimeType: string | null, contentCategory: string | null): string {
  const declared = mimeTypeValue(declaredMimeType);
  if (declared) return declared;

  // Some older Voyager clients sent a MIME type in contentCategory; preserve only
  // valid MIME-ish values. Category labels such as "image" are metadata, not R2
  // content types.
  const categoryMime = mimeTypeValue(contentCategory);
  if (categoryMime) return categoryMime;

  return "application/octet-stream";
}

function mimeTypeValue(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized && MIME_TYPE_PATTERN.test(normalized) ? normalized : null;
}

function voyagerProtocolType(value: string | null): string {
  if (
    value === "opaque-test" ||
    value === "mls_application" ||
    value === "mls_commit" ||
    value === "mls_proposal" ||
    value === "mls_welcome"
  ) {
    return value;
  }
  return "opaque-test";
}

function roomCutoverPage(query: URLSearchParams | undefined): { limit: number; offset: number } {
  const limit = numericRoomCutoverQuery(query, "limit", 1, 200, 50);
  const cursor = query?.get("cursor");
  if (!cursor) return { limit, offset: 0 };
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, "invalid_cursor", "Cursor is invalid");
  }
  return { limit, offset };
}

function numericRoomCutoverQuery(
  query: URLSearchParams | undefined,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = query?.get(key);
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "invalid_query", `Query parameter must be an integer between ${min} and ${max}: ${key}`);
  }
  return parsed;
}

interface VoyagerPrincipalProfile {
  accountId: string;
  principalType: "human" | "agent";
  displayName: string;
}

async function loadVoyagerPrincipalProfiles(
  env: Env,
  principalIds: string[],
): Promise<Map<string, VoyagerPrincipalProfile>> {
  const rows = principalIds.length
    ? await selectIn<PrincipalRow>(
        env,
        `SELECT principal_id, account_id, principal_type, display_name, avatar_ref, status, owner_principal_id, created_at, revoked_at
         FROM principals
         WHERE principal_id IN ({ids})
         ORDER BY principal_id`,
        principalIds,
      )
    : [];
  const profiles = new Map<string, VoyagerPrincipalProfile>();
  for (const row of rows) {
    profiles.set(row.principal_id, {
      accountId: row.account_id,
      principalType: row.principal_type === "agent" ? "agent" : "human",
      displayName: row.display_name,
    });
  }
  return profiles;
}

async function loadVoyagerPinnedSummaries(
  env: Env,
  roomIds: string[],
): Promise<Map<string, { pinnedMessageCount: number; latestPinnedMessageId: string | null }>> {
  const rows = roomIds.length
    ? await selectIn<{
        room_id: string;
        pinned_message_count: number;
        latest_pinned_message_id: string | null;
      }>(
        env,
        `SELECT mp.room_id,
                COUNT(*) AS pinned_message_count,
                (
                  SELECT latest.envelope_id
                  FROM message_pins latest
                  WHERE latest.room_id = mp.room_id
                    AND latest.unpinned_at IS NULL
                  ORDER BY latest.pinned_at DESC
                  LIMIT 1
                ) AS latest_pinned_message_id
         FROM message_pins mp
         WHERE mp.room_id IN ({ids})
           AND mp.unpinned_at IS NULL
         GROUP BY mp.room_id`,
        roomIds,
      )
    : [];
  const summaries = new Map<string, { pinnedMessageCount: number; latestPinnedMessageId: string | null }>();
  for (const row of rows) {
    summaries.set(row.room_id, {
      pinnedMessageCount: Number(row.pinned_message_count ?? 0),
      latestPinnedMessageId: row.latest_pinned_message_id ?? null,
    });
  }
  return summaries;
}

function voyagerOwnershipTransferStatus(status: string): string {
  if (status === "pending") return "proposed";
  if (status === "accepted") return "completed";
  if (status === "declined") return "rejected";
  return status;
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
      { reason: sync.reason, sync },
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
      source: "unconfigured",
      reason: "internal_service_unconfigured",
      failedStep: null,
      tenantSynced: false,
      accountSynced: false,
      principalSynced: false,
      deviceSynced: false,
    };
  }

  const now = new Date();
  const cache = await loadIdentitySyncCache(env, config, identity, now.getTime());
  if (cache.fresh) {
    return {
      attempted: false,
      ok: true,
      source: "cache",
      reason: null,
      failedStep: null,
      tenantSynced: true,
      accountSynced: true,
      principalSynced: true,
      deviceSynced: true,
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
    await syncMessagingCoreTenant(env, config, token, identity.account);
    tenantSynced = true;
    failedStep = "account";
    await syncMessagingCoreAccount(config, token, identity.account);
    accountSynced = true;
    failedStep = "principal";
    await syncMessagingCorePrincipalRecord(config, token, identity.principal, identity.account);
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
    await storeIdentitySyncCache(env, config, identity, now);
    return {
      attempted: true,
      ok: true,
      source: "internal_service",
      reason: null,
      failedStep: null,
      tenantSynced,
      accountSynced,
      principalSynced,
      deviceSynced,
    };
  } catch (error) {
    const reason = publicIdentitySyncFailureReason(error);
    const upstreamError = internalSyncUpstreamError(error);
    if (cache.staleUsable) {
      return {
        attempted: true,
        ok: true,
        source: "stale_cache",
        reason: `stale_cache_after_${reason}`,
        upstreamError,
        failedStep,
        tenantSynced: true,
        accountSynced: true,
        principalSynced: true,
        deviceSynced: true,
      };
    }
    return {
      attempted: true,
      ok: false,
      source: "internal_service",
      reason,
      upstreamError,
      failedStep,
      tenantSynced,
      accountSynced,
      principalSynced,
      deviceSynced,
    };
  }
}

async function syncMessagingCoreTenantAccountPrincipal(
  env: Env,
  config: BridgeConfig,
  token: string,
  account: AccountRow,
  principal: PrincipalRow,
): Promise<void> {
  await syncMessagingCoreTenant(env, config, token, account);
  await syncMessagingCoreAccount(config, token, account);
  await syncMessagingCorePrincipalRecord(config, token, principal, account);
}

async function syncMessagingCoreTenant(
  _env: Env,
  config: BridgeConfig,
  token: string,
  account: AccountRow,
): Promise<void> {
  await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/bootstrap`, {
    externalTenantRef: config.tenantExternalRef,
    displayName: config.tenantDisplayName,
    status: "active",
    policies: [
      {
        policyId: account.policy_id,
        name: account.policy_id,
        policyJson: { source: "voyager" },
      },
    ],
  });
}

async function syncMessagingCoreAccount(
  config: BridgeConfig,
  token: string,
  account: AccountRow,
): Promise<void> {
  await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/accounts/upsert`, {
    accountId: account.account_id,
    externalSubjectId: account.account_id,
    displayName: account.display_name,
    status: publicCoreAccountStatus(account),
    policyId: account.policy_id,
  });
}

async function syncMessagingCorePrincipalRecord(
  config: BridgeConfig,
  token: string,
  principal: PrincipalRow,
  account: AccountRow,
): Promise<void> {
  await postInternal(config, token, `/internal/tenants/${encodeURIComponent(config.tenantId)}/principals/upsert`, {
    principalId: principal.principal_id,
    accountId: account.account_id,
    type: publicCorePrincipalType(principal.principal_type),
    externalPrincipalRef: principal.principal_id,
    displayName: principal.display_name,
    avatarRef: principal.avatar_ref,
    status: publicCorePrincipalStatus(principal),
    ownerPrincipalId: principal.owner_principal_id,
  });
}

async function loadVoyagerPrincipalIdentity(
  env: Env,
  principalId: string,
): Promise<{ account: AccountRow; principal: PrincipalRow }> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT
       a.account_id AS account_id,
       a.status AS account_status,
       a.display_name AS account_display_name,
       a.email AS account_email,
       a.phone AS account_phone,
       a.policy_id AS account_policy_id,
       a.default_principal_id AS account_default_principal_id,
       a.activated_at AS account_activated_at,
       a.suspended_at AS account_suspended_at,
       a.deletion_state AS account_deletion_state,
       a.created_at AS account_created_at,
       a.updated_at AS account_updated_at,
       p.principal_id,
       p.account_id AS principal_account_id,
       p.principal_type,
       p.display_name AS principal_display_name,
       p.avatar_ref,
       p.status AS principal_status,
       p.owner_principal_id,
       p.created_at AS principal_created_at,
       p.revoked_at
     FROM principals p
     INNER JOIN accounts a ON a.account_id = p.account_id
     WHERE p.principal_id = ?`,
  )
    .bind(principalId)
    .first<VoyagerPrincipalIdentityRow>();
  if (!row) {
    throw new HttpError(404, "principal_not_found", "Principal was not found");
  }
  return {
    account: {
      account_id: row.account_id,
      status: row.account_status,
      display_name: row.account_display_name,
      email: row.account_email,
      phone: row.account_phone,
      policy_id: row.account_policy_id,
      default_principal_id: row.account_default_principal_id,
      activated_at: row.account_activated_at,
      suspended_at: row.account_suspended_at,
      deletion_state: row.account_deletion_state,
      created_at: row.account_created_at,
      updated_at: row.account_updated_at,
    },
    principal: {
      principal_id: row.principal_id,
      account_id: row.principal_account_id,
      principal_type: row.principal_type,
      display_name: row.principal_display_name,
      avatar_ref: row.avatar_ref,
      status: row.principal_status,
      owner_principal_id: row.owner_principal_id,
      created_at: row.principal_created_at,
      revoked_at: row.revoked_at,
    },
  };
}

interface VoyagerPrincipalIdentityRow {
  account_id: string;
  account_status: AccountRow["status"];
  account_display_name: string;
  account_email: string | null;
  account_phone: string | null;
  account_policy_id: string;
  account_default_principal_id: string | null;
  account_activated_at: string | null;
  account_suspended_at: string | null;
  account_deletion_state: string | null;
  account_created_at: string;
  account_updated_at: string;
  principal_id: string;
  principal_account_id: string;
  principal_type: PrincipalRow["principal_type"];
  principal_display_name: string;
  avatar_ref: string | null;
  principal_status: PrincipalRow["status"];
  owner_principal_id: string | null;
  principal_created_at: string;
  revoked_at: string | null;
}

async function loadIdentitySyncCache(
  env: Env,
  config: BridgeConfig,
  identity: MessagingCoreIdentity,
  nowMs: number,
): Promise<IdentitySyncCacheLookup> {
  const cacheKey = identitySyncCacheKey(config, identity);
  const memoryRow = identitySyncMemoryCache.get(cacheKey);
  const memoryLookup = classifyIdentitySyncCache(memoryRow ?? null, config, nowMs);
  if (memoryLookup.fresh) return memoryLookup;

  try {
    const row = await env.CONTROL_DB.prepare(
      `SELECT synced_at, expires_at
       FROM messaging_core_identity_sync_cache
       WHERE tenant_id = ?
         AND account_id = ?
         AND principal_id = ?
         AND device_id = ?`,
    )
      .bind(
        config.tenantId,
        identity.account.account_id,
        identity.principal.principal_id,
        identity.device.device_id,
      )
      .first<IdentitySyncCacheRow>();
    const lookup = classifyIdentitySyncCache(row ?? null, config, nowMs);
    if (lookup.fresh || lookup.staleUsable) {
      rememberIdentitySyncCache(cacheKey, lookup.row, nowMs, config.identitySyncStaleGraceMs);
    }
    return lookup;
  } catch {
    return memoryLookup;
  }
}

async function storeIdentitySyncCache(
  env: Env,
  config: BridgeConfig,
  identity: MessagingCoreIdentity,
  now: Date,
): Promise<void> {
  const syncedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.identitySyncTtlMs).toISOString();
  const row = { synced_at: syncedAt, expires_at: expiresAt };
  rememberIdentitySyncCache(identitySyncCacheKey(config, identity), row, now.getTime(), config.identitySyncStaleGraceMs);
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO messaging_core_identity_sync_cache
         (tenant_id, account_id, principal_id, device_id, synced_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, account_id, principal_id, device_id)
       DO UPDATE SET
         synced_at = excluded.synced_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
      .bind(
        config.tenantId,
        identity.account.account_id,
        identity.principal.principal_id,
        identity.device.device_id,
        syncedAt,
        expiresAt,
        syncedAt,
      )
      .run();
  } catch {
    // Identity sync succeeded; a cache write failure should not fail the message path.
  }
}

function identitySyncCacheKey(config: BridgeConfig, identity: MessagingCoreIdentity): string {
  return [
    config.tenantId,
    identity.account.account_id,
    identity.principal.principal_id,
    identity.device.device_id,
  ].join("\u001f");
}

function classifyIdentitySyncCache(
  row: IdentitySyncCacheRow | null,
  config: BridgeConfig,
  nowMs: number,
): IdentitySyncCacheLookup {
  if (!row) return { fresh: false, staleUsable: false, row: null };
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs)) return { fresh: false, staleUsable: false, row };
  return {
    fresh: expiresMs > nowMs,
    staleUsable: expiresMs + config.identitySyncStaleGraceMs > nowMs,
    row,
  };
}

function rememberIdentitySyncCache(
  key: string,
  row: IdentitySyncCacheRow | null,
  nowMs: number,
  staleGraceMs: number,
): void {
  if (!row) return;
  if (identitySyncMemoryCache.size >= MAX_IDENTITY_SYNC_MEMORY_CACHE_ENTRIES) {
    for (const [candidateKey, candidate] of identitySyncMemoryCache) {
      const expiresMs = Date.parse(candidate.expires_at);
      if (!Number.isFinite(expiresMs) || expiresMs + staleGraceMs <= nowMs) {
        identitySyncMemoryCache.delete(candidateKey);
      }
    }
  }
  if (identitySyncMemoryCache.size < MAX_IDENTITY_SYNC_MEMORY_CACHE_ENTRIES) {
    identitySyncMemoryCache.set(key, row);
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
  const response = await fetchMessagingCore(config, request);
  const contentType = response.headers.get("content-type") ?? "";
  let payload: JsonObject | null = null;
  let text: string | null = null;
  if (contentType.includes("application/json")) {
    const parsed = await response.json();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } else {
    text = await response.text();
  }
  if (!response.ok) {
    const upstream = payload
      ? coreError(payload)
      : {
          code: `http_${response.status}`,
          message: text?.slice(0, 240) || "Messaging Core internal service request failed.",
        };
    throw new MessagingCoreInternalHttpError(response.status, upstream.code, upstream.message, path);
  }
  return payload ?? text ?? null;
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
  options: { preserveClientErrors?: boolean; voyagerMessageCompatibility?: boolean } = {},
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
  const response = await fetchPublicCore(config, request);
  const payload = await parseJsonObjectResponse(response);
  if (!response.ok) {
    throwCorePayloadError(response.status, payload, options);
  }
  return { status: response.status, payload };
}

async function publicCoreRaw(
  config: BridgeConfig,
  token: string,
  method: PublicCoreMethod,
  path: string,
  upstreamRequest?: Request,
  options: { preserveClientErrors?: boolean; voyagerMessageCompatibility?: boolean } = {},
): Promise<{ response: Response }> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  };
  if (upstreamRequest) {
    const contentType = upstreamRequest.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    init.body = await upstreamRequest.arrayBuffer();
  }
  const request = new Request(messagingCoreUrl(config, path), init);
  const response = await fetchPublicCore(config, request, {
    forceNetwork: Boolean(upstreamRequest && isLocalMessagingCoreUrl(config.baseUrl)),
  });
  if (!response.ok && method !== "GET") {
    await throwCoreResponseError(response, options);
  }
  return { response };
}

async function fetchPublicCore(
  config: BridgeConfig,
  request: Request,
  options: { forceNetwork?: boolean } = {},
): Promise<Response> {
  try {
    return await fetchMessagingCore(config, request, options.forceNetwork === true);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new HttpError(
        504,
        "messaging_core_proxy_timeout",
        "Messaging Core proxy request timed out.",
        { timeoutMs: config.fetchTimeoutMs, retryable: true },
      );
    }
    throw error;
  }
}

function fetchMessagingCore(config: BridgeConfig, request: Request, forceNetwork = false): Promise<Response> {
  return !forceNetwork && config.serviceBinding ? config.serviceBinding.fetch(request) : fetch(request);
}

async function throwCoreResponseError(
  response: Response,
  options: { preserveClientErrors?: boolean; voyagerMessageCompatibility?: boolean } = {},
): Promise<never> {
  const payload = await parseJsonObjectResponse(response);
  throwCorePayloadError(response.status, payload, options);
}

function throwCorePayloadError(
  status: number,
  payload: JsonObject,
  options: { preserveClientErrors?: boolean; voyagerMessageCompatibility?: boolean } = {},
): never {
  if (options.preserveClientErrors && status >= 400 && status < 500) {
    const upstreamError = coreError(payload);
    if (options.voyagerMessageCompatibility && status === 404 && upstreamError.code === "room_not_found") {
      throw new HttpError(
        403,
        "room_membership_required",
        "Active room membership required",
        { upstreamStatus: status },
      );
    }
    throw new HttpError(
      status,
      upstreamError.code,
      upstreamError.message,
      { upstreamStatus: status },
    );
  }
  throw new HttpError(
    502,
    "messaging_core_proxy_failed",
    "Messaging Core proxy request failed.",
    { upstreamStatus: status, upstreamError: stringValue(payload.error) },
  );
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

function objectValue(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function arrayField(value: JsonObject, key: string): JsonObject[] {
  const field = value[key];
  if (!Array.isArray(field) || field.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core proxy response is missing the expected array field.",
      { field: key },
    );
  }
  return field as JsonObject[];
}

function jsonObjectArrayValue(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = objectValue(item);
    return object ? [object] : [];
  });
}

function requiredCoreString(value: JsonObject, key: string): string {
  const result = stringValue(value[key]);
  if (result === null) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core proxy response is missing the expected string field.",
      { field: key },
    );
  }
  return result;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredCoreNumber(value: JsonObject, key: string): number {
  const result = numberValue(value[key]);
  if (result === null) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core proxy response is missing the expected numeric field.",
      { field: key },
    );
  }
  return result;
}

function voyagerAttachmentMetadata(body: Record<string, unknown>): JsonObject {
  const metadata: JsonObject = {};
  copyMetadataField(body, metadata, "ciphertextSha256");
  copyMetadataField(body, metadata, "contentCategory");
  copyMetadataField(body, metadata, "retentionClass");
  copyMetadataField(body, metadata, "originalFilename");
  copyMetadataField(body, metadata, "declaredMimeType");
  copyMetadataField(body, metadata, "mediaKind");
  copyMetadataField(body, metadata, "width");
  copyMetadataField(body, metadata, "height");
  copyMetadataField(body, metadata, "durationMs");
  copyMetadataField(body, metadata, "variantManifest");
  copyMetadataField(body, metadata, "expiresAt");
  return metadata;
}

function copyMetadataField(
  source: Record<string, unknown>,
  target: JsonObject,
  key: string,
): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function messagingCoreUrl(config: BridgeConfig, path: string): string {
  if (!config.baseUrl) {
    throw new Error("Messaging Core base URL is not configured.");
  }
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

function isLocalMessagingCoreUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
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
  return {
    mode: "proxy",
    allCutoverEnabled: true,
    roomCutoverEnabled: true,
    messageCutoverEnabled: true,
    syncCutoverEnabled: true,
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
    identitySyncTtlMs: positiveInteger(env.VOYAGER_MESSAGING_CORE_IDENTITY_SYNC_TTL_MS, DEFAULT_IDENTITY_SYNC_TTL_MS),
    identitySyncStaleGraceMs: positiveInteger(
      env.VOYAGER_MESSAGING_CORE_IDENTITY_SYNC_STALE_GRACE_MS,
      DEFAULT_IDENTITY_SYNC_STALE_GRACE_MS,
    ),
  };
}

function bridgeCanMintClientToken(config: BridgeConfig): boolean {
  return Boolean(config.baseUrl && config.tokenSecret);
}

function bridgeStatusReason(config: BridgeConfig): string | null {
  if (!config.baseUrl) return "base_url_unconfigured";
  if (!config.tokenSecret) return "token_secret_unconfigured";
  return null;
}

function publicIdentitySyncFailureReason(error: unknown): string {
  if (isTimeoutError(error)) return "internal_service_timeout";
  if (error instanceof Error) {
    if (/^internal_service_http_\d{3}$/.test(error.message)) return error.message;
  }
  return "internal_service_unavailable";
}

function internalSyncUpstreamError(error: unknown): JsonObject | null {
  if (!(error instanceof MessagingCoreInternalHttpError)) return null;
  return {
    status: error.status,
    code: error.upstreamCode,
    message: error.upstreamMessage,
    path: error.path,
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
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
    "messaging:calls:read",
    "messaging:calls:write",
    "messaging:calls:media",
    "messaging:calls:usage",
  ];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
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
