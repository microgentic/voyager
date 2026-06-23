import { randomId } from "../crypto";
import { HttpError } from "../http";
import type { AccountRow, DeviceRow, Env, PolicyRow, PrincipalRow } from "../types";
import { ROOM_INVITATION_DAYS } from "./rooms/types";
import type { JsonObject } from "./shared/types";

export const VOYAGER_DEFAULT_MESSAGING_TENANT_ID = "tenant_voyager_default";

type MessagingCoreMode = "off" | "shadow" | "proxy";
type PublicCoreMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type PrincipalType = "human" | "agent" | "service";
type IdentitySyncStep = "tenant" | "account" | "principal" | "device";
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
const CORE_MESSAGE_COMPAT_EXPIRES_AT = "9999-12-31T23:59:59.000Z";
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
  description: string | null;
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
  protocol_type: string;
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

export async function fetchMessagingCoreSyncCutoverProxy(
  env: Env,
  identity: MessagingCoreIdentity,
  query?: URLSearchParams,
): Promise<{ status: number; payload: JsonObject }> {
  const config = resolveBridgeConfig(env);
  const base = messagingCoreBridgeStatus(env);
  if (!config.syncCutoverEnabled || !bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_cutover_unconfigured",
      "Messaging Core sync cutover is not configured.",
      { reason: bridgeStatusReason(config) ?? "sync_cutover_disabled" },
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
  if (config.mode === "off" || !bridgeCanMintClientToken(config)) {
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

export function messagingCoreMessageCutoverEnabled(env: Env): boolean {
  const config = resolveBridgeConfig(env);
  return config.messageCutoverEnabled;
}

export function messagingCoreRoomCutoverEnabled(env: Env): boolean {
  const config = resolveBridgeConfig(env);
  return config.roomCutoverEnabled;
}

export function messagingCoreSyncCutoverEnabled(env: Env): boolean {
  const config = resolveBridgeConfig(env);
  return config.syncCutoverEnabled;
}

export function messagingCoreAttachmentAllocateBody(body: Record<string, unknown>): Record<string, unknown> {
  const expectedBytes = numberValue(body.expectedBytes);
  if (expectedBytes === null || !Number.isInteger(expectedBytes) || expectedBytes < 1) {
    throw new HttpError(400, "invalid_field", "Field must be a positive integer: expectedBytes");
  }
  const declaredMimeType = stringValue(body.declaredMimeType);
  const contentCategory = stringValue(body.contentCategory);
  return {
    contentType: declaredMimeType ?? contentCategory ?? "application/octet-stream",
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
  if (!config.roomCutoverEnabled || !bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_cutover_unconfigured",
      "Messaging Core room cutover is not configured.",
      { reason: bridgeStatusReason(config) ?? "room_cutover_disabled" },
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
  const adapted = await adaptRoomCutoverPayload(env, config, token, upstream.payload, options);
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
  const upstream = await publicCoreRaw(config, token, "PUT", route, request, { preserveClientErrors: true });
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
  const upstream = await publicCoreRaw(config, token, "GET", route, undefined, { preserveClientErrors: true });
  if (!upstream.response.ok) {
    await throwCoreResponseError(upstream.response, { preserveClientErrors: true });
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
  if (!config.messageCutoverEnabled || !bridgeCanMintClientToken(config)) {
    throw new HttpError(
      503,
      "messaging_core_cutover_unconfigured",
      "Messaging Core message cutover is not configured.",
      { reason: bridgeStatusReason(config) ?? "message_cutover_disabled" },
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
    flags: {
      mode: config.mode,
      allCoreMessaging: config.allCutoverEnabled,
      roomRoutes: config.roomCutoverEnabled,
      messageRoutes: config.messageCutoverEnabled,
      syncRoute: config.syncCutoverEnabled,
    },
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
    const pinned = pinnedSummaries.get(roomId) ?? { pinnedMessageCount: 0, latestPinnedMessageId: null };
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
          following: subscriptionState !== "muted",
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
  const receipt = objectValue(message.receiptSummary) ?? {};
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
      deletedAt,
      deletedByPrincipalId: null,
      reason: null,
    },
    threadRootEnvelopeId: stringValue(message.rootEnvelopeId),
    alsoSentToRoom: false,
    threadSummary: adaptCoreThreadSummary(objectValue(message.threadSummary)),
    receiptSummary: {
      total: numberValue(receipt.total) ?? 0,
      pending: Math.max(0, (numberValue(receipt.total) ?? 0) - (numberValue(receipt.delivered) ?? 0)),
      delivered: numberValue(receipt.delivered) ?? 0,
      read: numberValue(receipt.read) ?? 0,
    },
    reactions: jsonObjectArrayValue(message.reactions).map((reaction) => ({
      reaction: requiredCoreString(reaction, "reaction"),
      count: numberValue(reaction.count) ?? 0,
      reactedByMe: Boolean(reaction.reactedByMe),
    })),
    pin: adaptCorePin(objectValue(message.pin)),
  };
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
    following: subscriptionState !== "muted",
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
  options: { preserveClientErrors?: boolean } = {},
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
    init.body = upstreamRequest.body;
  }
  const request = new Request(messagingCoreUrl(config, path), init);
  const response = config.serviceBinding ? await config.serviceBinding.fetch(request) : await fetch(request);
  if (!response.ok && method !== "GET") {
    await throwCoreResponseError(response, options);
  }
  return { response };
}

async function throwCoreResponseError(
  response: Response,
  options: { preserveClientErrors?: boolean } = {},
): Promise<never> {
  const payload = await parseJsonObjectResponse(response);
  throwCorePayloadError(response.status, payload, options);
}

function throwCorePayloadError(
  status: number,
  payload: JsonObject,
  options: { preserveClientErrors?: boolean } = {},
): never {
  if (options.preserveClientErrors && status >= 400 && status < 500) {
    const upstreamError = coreError(payload);
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

async function buildVoyagerReadonlySnapshot(
  env: Env,
  roomLimit: number,
  messageLimit: number,
): Promise<VoyagerReadonlyBackfillSnapshot> {
  const rooms = await env.CONTROL_DB.prepare(
    `SELECT r.room_id,
            r.type,
            r.name,
            r.description,
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
            protocol_type,
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
    description: room.description,
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
    protocolType: message.protocol_type,
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
  const allCutoverEnabled = booleanEnv(env.VOYAGER_MESSAGING_CORE_ALL_CUTOVER);
  return {
    mode,
    invalidMode,
    allCutoverEnabled,
    roomCutoverEnabled: allCutoverEnabled || booleanEnv(env.VOYAGER_MESSAGING_CORE_ROOM_CUTOVER),
    messageCutoverEnabled: allCutoverEnabled || booleanEnv(env.VOYAGER_MESSAGING_CORE_MESSAGE_CUTOVER),
    syncCutoverEnabled: allCutoverEnabled || booleanEnv(env.VOYAGER_MESSAGING_CORE_SYNC_CUTOVER),
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
