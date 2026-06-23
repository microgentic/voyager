export const endpointStabilityCatalog = [
  { method: "GET", path: "/health", stability: "stable/current" },
  { method: "GET", path: "/v1/meta", stability: "stable/current" },
  { method: "POST", path: "/v1/auth/password/login", stability: "stable/current" },
  { method: "POST", path: "/v1/auth/logout", stability: "stable/current" },
  { method: "POST", path: "/v1/auth/password/change", stability: "stable/current" },
  { method: "POST", path: "/v1/auth/password/reset/complete", stability: "stable/current" },
  { method: "GET", path: "/v1/me", stability: "stable/current" },
  { method: "GET", path: "/v1/app/bootstrap", stability: "stable/current" },
  { method: "GET", path: "/v1/sessions", stability: "stable/current" },
  { method: "DELETE", path: "/v1/sessions/{sessionId}", stability: "stable/current" },
  { method: "GET", path: "/v1/devices", stability: "stable/current" },
  { method: "POST", path: "/v1/devices", stability: "stable/current" },
  { method: "POST", path: "/v1/devices/{deviceId}/revoke", stability: "stable/current" },
  { method: "GET", path: "/v1/principals", stability: "stable/current" },
  { method: "GET", path: "/v1/principals/{principalId}/devices", stability: "stable/current" },
  { method: "GET", path: "/v1/rooms", stability: "stable/current" },
  { method: "GET", path: "/v1/threads", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/direct", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/groups", stability: "stable/current" },
  { method: "GET", path: "/v1/rooms/{roomId}", stability: "stable/current" },
  { method: "PATCH", path: "/v1/rooms/{roomId}", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/archive", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/members", stability: "stable/current" },
  { method: "PATCH", path: "/v1/rooms/{roomId}/members/{principalId}/role", stability: "stable/current" },
  { method: "DELETE", path: "/v1/rooms/{roomId}/members/{principalId}", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/leave", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/ownership-transfers", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/ownership-transfers/{transferId}/accept", stability: "stable/current" },
  { method: "GET", path: "/v1/rooms/{roomId}/calls", stability: "future-sensitive" },
  { method: "POST", path: "/v1/rooms/{roomId}/calls", stability: "future-sensitive" },
  { method: "GET", path: "/v1/calls/{callId}", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/join", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/leave", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/decline", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/mute", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/unmute", stability: "future-sensitive" },
  { method: "PATCH", path: "/v1/calls/{callId}/participants/me", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/realtime/session", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/realtime/tracks", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/realtime/renegotiate", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/realtime/tracks/close", stability: "future-sensitive" },
  { method: "POST", path: "/v1/calls/{callId}/usage-report", stability: "future-sensitive" },
  { method: "GET", path: "/v1/rooms/{roomId}/messages", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/delete", stability: "stable/current" },
  { method: "PATCH", path: "/v1/rooms/{roomId}/messages/{envelopeId}", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/{envelopeId}/forward", stability: "stable/current" },
  { method: "GET", path: "/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/read", stability: "stable/current" },
  { method: "PATCH", path: "/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/subscription", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/{envelopeId}/reactions", stability: "stable/current" },
  { method: "DELETE", path: "/v1/rooms/{roomId}/messages/{envelopeId}/reactions/{reaction}", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/{envelopeId}/pin", stability: "stable/current" },
  { method: "DELETE", path: "/v1/rooms/{roomId}/messages/{envelopeId}/pin", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/messages/{envelopeId}/ack", stability: "stable/current" },
  { method: "GET", path: "/v1/sync", stability: "stable/current" },
  { method: "POST", path: "/v1/realtime/token", stability: "stable/current" },
  { method: "POST", path: "/v1/messaging-core/session", stability: "future-sensitive" },
  { method: "GET", path: "/v1/messaging-core/bootstrap", stability: "future-sensitive" },
  { method: "GET", path: "/v1/messaging-core/rooms", stability: "future-sensitive" },
  { method: "GET", path: "/v1/messaging-core/rooms/{roomId}", stability: "future-sensitive" },
  { method: "GET", path: "/v1/messaging-core/rooms/{roomId}/messages", stability: "future-sensitive" },
  { method: "POST", path: "/v1/rooms/{roomId}/invitations", stability: "stable/current" },
  { method: "GET", path: "/v1/room-invitations", stability: "stable/current" },
  { method: "POST", path: "/v1/room-invitations/{roomInvitationId}/accept", stability: "stable/current" },
  { method: "POST", path: "/v1/room-invitations/{roomInvitationId}/decline", stability: "stable/current" },
  { method: "POST", path: "/v1/rooms/{roomId}/attachments", stability: "stable/current" },
  { method: "PUT", path: "/v1/attachments/{attachmentId}/blob", stability: "stable/current" },
  { method: "GET", path: "/v1/attachments/{attachmentId}/blob", stability: "stable/current" },
  { method: "POST", path: "/v1/attachments/{attachmentId}/complete", stability: "stable/current" },
  { method: "DELETE", path: "/v1/attachments/{attachmentId}", stability: "stable/current" },
  { method: "GET", path: "/v1/sidebar-collections", stability: "stable/current" },
  { method: "POST", path: "/v1/sidebar-collections", stability: "stable/current" },
  { method: "PATCH", path: "/v1/sidebar-collections/{collectionId}", stability: "stable/current" },
  { method: "DELETE", path: "/v1/sidebar-collections/{collectionId}", stability: "stable/current" },
  { method: "POST", path: "/v1/sidebar-collections/{collectionId}/items", stability: "stable/current" },
  { method: "DELETE", path: "/v1/sidebar-collections/{collectionId}/items/{roomId}", stability: "stable/current" },
  { method: "GET", path: "/v1/agent-requests", stability: "stable/current" },
  { method: "POST", path: "/v1/agent-requests", stability: "stable/current" },
  { method: "GET", path: "/v1/realtime", stability: "stable/current" },
  { method: "GET", path: "/v1/devices/{deviceId}/key-packages", stability: "future-sensitive" },
  { method: "POST", path: "/v1/devices/{deviceId}/key-packages", stability: "future-sensitive" },
  { method: "GET", path: "/v1/principals/{principalId}/key-packages", stability: "future-sensitive" },
  { method: "POST", path: "/v1/key-packages/{keyPackageId}/claim", stability: "future-sensitive" },
  { method: "POST", path: "/v1/key-packages/{keyPackageId}/revoke", stability: "future-sensitive" },
  { method: "GET", path: "/v1/admin/bootstrap/status", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/bootstrap", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/invitations/accept", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/invitations", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/accounts", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/accounts/{accountId}/suspend", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/accounts/{accountId}/restore", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/accounts/{accountId}/require-auth-reset", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/accounts/{accountId}/credential-reset", stability: "admin/dev-only" },
  { method: "PATCH", path: "/v1/admin/accounts/{accountId}/policy", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/accounts/{accountId}/roles", stability: "admin/dev-only" },
  { method: "DELETE", path: "/v1/admin/accounts/{accountId}/roles/{roleName}", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/policies", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/usage", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/calls/realtime-status", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/audit-events", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/rooms", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/devices/test-cleanup", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/messaging-core/backfill-readonly", stability: "admin/dev-only" },
  { method: "GET", path: "/v1/admin/agent-requests", stability: "admin/dev-only" },
  { method: "PATCH", path: "/v1/admin/agent-requests/{requestId}", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/agents", stability: "future-sensitive" },
  { method: "GET", path: "/v1/admin/maintenance/runs", stability: "admin/dev-only" },
  { method: "POST", path: "/v1/admin/maintenance/cleanup", stability: "admin/dev-only" }
];

export function assertApiErrorShape(payload, context) {
  const value = object(payload, context);
  literal(value.ok, false, `${context}.ok`);
  string(value.error, `${context}.error`);
  string(value.message, `${context}.message`);
  string(value.requestId, `${context}.requestId`);
}

export function assertAuthResult(payload, context) {
  const value = success(payload, context);
  assertAccount(value.account, `${context}.account`);
  assertPrincipal(value.principal, `${context}.principal`);
  assertDevice(value.device, `${context}.device`);
  string(value.sessionToken, `${context}.sessionToken`);
  if ("messagingCore" in value) assertMessagingCoreSession(value.messagingCore, `${context}.messagingCore`);
}

export function assertMessagingCoreSessionResponse(payload, context) {
  const value = success(payload, context);
  assertMessagingCoreSession(value.messagingCore, `${context}.messagingCore`);
}

export function assertMessagingCoreBootstrapProxyResponse(payload, context) {
  const value = success(payload, context);
  assertMessagingCoreSession(value.messagingCore, `${context}.messagingCore`);
  const bootstrap = object(value.bootstrap, `${context}.bootstrap`);
  string(bootstrap.app, `${context}.bootstrap.app`);
  string(bootstrap.tenantId, `${context}.bootstrap.tenantId`);
  object(bootstrap.account, `${context}.bootstrap.account`);
  object(bootstrap.principal, `${context}.bootstrap.principal`);
  if (bootstrap.device !== null) object(bootstrap.device, `${context}.bootstrap.device`);
  array(bootstrap.roles, `${context}.bootstrap.roles`).forEach((role, index) => string(role, `${context}.bootstrap.roles[${index}]`));
  array(bootstrap.scopes, `${context}.bootstrap.scopes`).forEach((scope, index) => string(scope, `${context}.bootstrap.scopes[${index}]`));
  array(bootstrap.rooms, `${context}.bootstrap.rooms`);
  nullableString(bootstrap.roomsNextCursor, `${context}.bootstrap.roomsNextCursor`);
  array(bootstrap.pendingMessages, `${context}.bootstrap.pendingMessages`);
  string(bootstrap.serverTime, `${context}.bootstrap.serverTime`);
  string(bootstrap.requestId, `${context}.bootstrap.requestId`);
  const proxied = object(value.proxied, `${context}.proxied`);
  literal(proxied.route, "/bootstrap", `${context}.proxied.route`);
  number(proxied.upstreamStatus, `${context}.proxied.upstreamStatus`);
}

export function assertMessagingCoreRoomsProxyResponse(payload, context) {
  const value = assertMessagingCoreProxyBase(payload, context, "/rooms");
  array(value.rooms, `${context}.rooms`);
}

export function assertMessagingCoreRoomProxyResponse(payload, context) {
  const value = success(payload, context);
  assertMessagingCoreSession(value.messagingCore, `${context}.messagingCore`);
  object(value.room, `${context}.room`);
  array(value.members, `${context}.members`);
  const proxied = object(value.proxied, `${context}.proxied`);
  string(proxied.route, `${context}.proxied.route`);
  number(proxied.upstreamStatus, `${context}.proxied.upstreamStatus`);
}

export function assertMessagingCoreMessagesProxyResponse(payload, context) {
  const value = success(payload, context);
  assertMessagingCoreSession(value.messagingCore, `${context}.messagingCore`);
  array(value.messages, `${context}.messages`);
  const proxied = object(value.proxied, `${context}.proxied`);
  string(proxied.route, `${context}.proxied.route`);
  number(proxied.upstreamStatus, `${context}.proxied.upstreamStatus`);
}

function assertMessagingCoreProxyBase(payload, context, route) {
  const value = success(payload, context);
  assertMessagingCoreSession(value.messagingCore, `${context}.messagingCore`);
  const proxied = object(value.proxied, `${context}.proxied`);
  literal(proxied.route, route, `${context}.proxied.route`);
  number(proxied.upstreamStatus, `${context}.proxied.upstreamStatus`);
  return value;
}

export function assertBootstrapResponse(payload, context) {
  const value = success(payload, context);
  const bootstrap = object(value.bootstrap, `${context}.bootstrap`);
  assertAccount(bootstrap.account, `${context}.bootstrap.account`);
  assertPrincipal(bootstrap.principal, `${context}.bootstrap.principal`);
  assertDevice(bootstrap.device, `${context}.bootstrap.device`);
  array(bootstrap.roles, `${context}.bootstrap.roles`).forEach((role, index) => string(role, `${context}.bootstrap.roles[${index}]`));
  array(bootstrap.rooms, `${context}.bootstrap.rooms`).forEach((room, index) => assertRoom(room, `${context}.bootstrap.rooms[${index}]`));
  nullableString(bootstrap.roomsNextCursor, `${context}.bootstrap.roomsNextCursor`);
  array(bootstrap.pendingMessages, `${context}.bootstrap.pendingMessages`).forEach((message, index) =>
    assertMessage(message, `${context}.bootstrap.pendingMessages[${index}]`)
  );
  string(bootstrap.serverTime, `${context}.bootstrap.serverTime`);
  string(bootstrap.requestId, `${context}.bootstrap.requestId`);
}

export function assertSyncResponse(payload, context) {
  const value = success(payload, context);
  const sync = object(value.sync, `${context}.sync`);
  array(sync.rooms, `${context}.sync.rooms`).forEach((room, index) => assertRoom(room, `${context}.sync.rooms[${index}]`));
  nullableString(sync.roomsNextCursor, `${context}.sync.roomsNextCursor`);
  array(sync.pendingMessages, `${context}.sync.pendingMessages`).forEach((message, index) =>
    assertMessage(message, `${context}.sync.pendingMessages[${index}]`)
  );
}

export function assertRoomResponse(payload, context) {
  assertRoom(success(payload, context).room, `${context}.room`);
}

export function assertCallResponse(payload, context) {
  assertCall(success(payload, context).call, `${context}.call`);
}

export function assertCallsResponse(payload, context) {
  const value = success(payload, context);
  array(value.calls, `${context}.calls`).forEach((call, index) => assertCall(call, `${context}.calls[${index}]`));
  nullableString(value.nextCursor, `${context}.nextCursor`);
}

export function assertCallRealtimeConfigResponse(payload, context) {
  const value = success(payload, context);
  const realtime = object(value.realtime, `${context}.realtime`);
  literal(realtime.provider, "cloudflare_realtime", `${context}.realtime.provider`);
  boolean(realtime.configured, `${context}.realtime.configured`);
  if ("features" in realtime) assertCallFeatureFlags(realtime.features, `${context}.realtime.features`);
  string(realtime.callId, `${context}.realtime.callId`);
  enumValue(realtime.callType, ["audio", "video"], `${context}.realtime.callType`);
  enumValue(realtime.status, ["ringing", "active", "ended", "missed", "declined", "failed"], `${context}.realtime.status`);
  string(realtime.message, `${context}.realtime.message`);
  if ("iceServers" in realtime) array(realtime.iceServers, `${context}.realtime.iceServers`);
  if ("session" in realtime && realtime.session !== null) object(realtime.session, `${context}.realtime.session`);
  if ("sessionDescription" in realtime && realtime.sessionDescription !== null) {
    object(realtime.sessionDescription, `${context}.realtime.sessionDescription`);
  }
  if ("tracks" in realtime) array(realtime.tracks, `${context}.realtime.tracks`);
  if ("availableTracks" in realtime) array(realtime.availableTracks, `${context}.realtime.availableTracks`);
  if ("requiresImmediateRenegotiation" in realtime) {
    boolean(realtime.requiresImmediateRenegotiation, `${context}.realtime.requiresImmediateRenegotiation`);
  }
}

export function assertCallUsageReportResponse(payload, context) {
  const value = success(payload, context);
  const report = object(value.usageReport, `${context}.usageReport`);
  string(report.usageReportId, `${context}.usageReport.usageReportId`);
  string(report.callId, `${context}.usageReport.callId`);
  literal(report.provider, "cloudflare_realtime", `${context}.usageReport.provider`);
  nullableString(report.providerSessionId, `${context}.usageReport.providerSessionId`);
  enumValue(report.source, ["client_estimate", "provider_authoritative"], `${context}.usageReport.source`);
  [
    "durationMs",
    "audioDurationMs",
    "videoDurationMs",
    "screenDurationMs",
    "bytesSentEstimate",
    "bytesReceivedEstimate"
  ].forEach((key) => number(report[key], `${context}.usageReport.${key}`));
  boolean(report.relayLikely, `${context}.usageReport.relayLikely`);
  nullableString(report.candidateType, `${context}.usageReport.candidateType`);
  string(report.createdAt, `${context}.usageReport.createdAt`);
}

export function assertCallRealtimeStatusResponse(payload, context) {
  const value = success(payload, context);
  const realtime = object(value.realtime, `${context}.realtime`);
  literal(realtime.provider, "cloudflare_realtime", `${context}.realtime.provider`);
  boolean(realtime.configured, `${context}.realtime.configured`);
  enumValue(realtime.status, ["configured", "not_configured", "disabled"], `${context}.realtime.status`);
  enumValue(realtime.configurationStatus, ["configured", "not_configured", "disabled"], `${context}.realtime.configurationStatus`);
  string(realtime.configurationCheckedAt, `${context}.realtime.configurationCheckedAt`);
  enumValue(realtime.providerHealthStatus, ["not_checked", "ok", "error"], `${context}.realtime.providerHealthStatus`);
  nullableString(realtime.providerHealthCheckedAt, `${context}.realtime.providerHealthCheckedAt`);
  boolean(realtime.mock, `${context}.realtime.mock`);
  string(realtime.apiBase, `${context}.realtime.apiBase`);
  boolean(realtime.turnConfigured, `${context}.realtime.turnConfigured`);
  assertCallFeatureFlags(realtime.features, `${context}.realtime.features`);
  const credentialState = object(realtime.credentialState, `${context}.realtime.credentialState`);
  boolean(credentialState.appIdConfigured, `${context}.realtime.credentialState.appIdConfigured`);
  boolean(credentialState.appSecretConfigured, `${context}.realtime.credentialState.appSecretConfigured`);
  boolean(credentialState.turnCredentialsConfigured, `${context}.realtime.credentialState.turnCredentialsConfigured`);
  nullableString(realtime.lastProviderCheckAt, `${context}.realtime.lastProviderCheckAt`);
  enumValue(realtime.lastProviderCheckStatus, ["not_checked", "ok", "error"], `${context}.realtime.lastProviderCheckStatus`);
  string(realtime.estimatedSfuTurnEgressStatus, `${context}.realtime.estimatedSfuTurnEgressStatus`);
}

function assertCallFeatureFlags(payload, context) {
  const features = object(payload, context);
  [
    "callsEnabled",
    "audioCallsEnabled",
    "videoCallsEnabled",
    "screenShareEnabled",
    "realtimeMediaEnabled"
  ].forEach((key) => boolean(features[key], `${context}.${key}`));
}

export function assertPaginatedRoomsResponse(payload, context) {
  const value = success(payload, context);
  array(value.rooms, `${context}.rooms`).forEach((room, index) => assertRoom(room, `${context}.rooms[${index}]`));
  nullableString(value.nextCursor, `${context}.nextCursor`);
}

export function assertMessagesResponse(payload, context) {
  const value = success(payload, context);
  array(value.messages, `${context}.messages`).forEach((message, index) => assertMessage(message, `${context}.messages[${index}]`));
}

export function assertThreadResponse(payload, context) {
  const value = success(payload, context);
  const thread = object(value.thread, `${context}.thread`);
  assertMessage(thread.root, `${context}.thread.root`);
  array(thread.replies, `${context}.thread.replies`).forEach((reply, index) =>
    assertMessage(reply, `${context}.thread.replies[${index}]`)
  );
  nullableString(thread.olderCursor, `${context}.thread.olderCursor`);
}

export function assertThreadsResponse(payload, context) {
  const value = success(payload, context);
  array(value.items, `${context}.items`).forEach((item, index) =>
    assertThreadInboxItem(item, `${context}.items[${index}]`)
  );
  nullableString(value.nextCursor, `${context}.nextCursor`);
}

export function assertThreadStateResponse(payload, context) {
  const value = success(payload, context);
  assertThreadState(value.threadState, `${context}.threadState`);
}

export function assertDeleteMessagesResponse(payload, context) {
  const value = success(payload, context);
  const deleted = object(value.deleted, `${context}.deleted`);
  enumValue(deleted.scope, ["for_me", "everyone"], `${context}.deleted.scope`);
  array(deleted.envelopeIds, `${context}.deleted.envelopeIds`).forEach((envelopeId, index) =>
    string(envelopeId, `${context}.deleted.envelopeIds[${index}]`)
  );
}

export function assertMessageResponse(payload, context) {
  assertMessage(success(payload, context).message, `${context}.message`);
}

export function assertRoomInvitationResponse(payload, context) {
  assertRoomInvitation(success(payload, context).invitation, `${context}.invitation`);
}

export function assertPaginatedRoomInvitationsResponse(payload, context) {
  const value = success(payload, context);
  array(value.invitations, `${context}.invitations`).forEach((invitation, index) =>
    assertRoomInvitation(invitation, `${context}.invitations[${index}]`)
  );
  nullableString(value.nextCursor, `${context}.nextCursor`);
}

export function assertKeyPackageResponse(payload, context) {
  assertKeyPackage(success(payload, context).keyPackage, `${context}.keyPackage`);
}

export function assertKeyPackagesResponse(payload, context) {
  const value = success(payload, context);
  array(value.keyPackages, `${context}.keyPackages`).forEach((keyPackage, index) =>
    assertKeyPackage(keyPackage, `${context}.keyPackages[${index}]`)
  );
}

export function assertPaginatedKeyPackagesResponse(payload, context) {
  assertKeyPackagesResponse(payload, context);
  nullableString(object(payload, context).nextCursor, `${context}.nextCursor`);
}

export function assertAttachmentResponse(payload, context) {
  assertAttachment(success(payload, context).attachment, `${context}.attachment`);
}

export function assertSidebarCollectionResponse(payload, context) {
  assertSidebarCollection(success(payload, context).collection, `${context}.collection`);
}

export function assertPaginatedAgentRequestsResponse(payload, context) {
  const value = success(payload, context);
  array(value.requests, `${context}.requests`).forEach((request, index) => assertAgentRequest(request, `${context}.requests[${index}]`));
  nullableString(value.nextCursor, `${context}.nextCursor`);
}

export function assertAgentRequestResponse(payload, context) {
  assertAgentRequest(success(payload, context).request, `${context}.request`);
}

export function assertAgentResponse(payload, context) {
  const value = success(payload, context);
  assertPrincipal(value.agent, `${context}.agent`);
  literal(value.agent.principalType, "agent", `${context}.agent.principalType`);
}

export function assertRealtimeRoomMessageEvent(payload, context) {
  const value = object(payload, context);
  literal(value.type, "room.message", `${context}.type`);
  string(value.eventId, `${context}.eventId`);
  string(value.createdAt, `${context}.createdAt`);
  string(value.roomId, `${context}.roomId`);
  string(value.envelopeId, `${context}.envelopeId`);
  number(value.serverSequence, `${context}.serverSequence`);
  string(value.senderDeviceId, `${context}.senderDeviceId`);
}

export function assertRealtimeRoomThreadEvent(payload, context) {
  const value = object(payload, context);
  literal(value.type, "room.thread", `${context}.type`);
  string(value.eventId, `${context}.eventId`);
  string(value.createdAt, `${context}.createdAt`);
  string(value.roomId, `${context}.roomId`);
  string(value.envelopeId, `${context}.envelopeId`);
  number(value.serverSequence, `${context}.serverSequence`);
  string(value.senderDeviceId, `${context}.senderDeviceId`);
  string(value.rootEnvelopeId, `${context}.rootEnvelopeId`);
  boolean(value.alsoSentToRoom, `${context}.alsoSentToRoom`);
}

export function assertRealtimeCallEvent(payload, context, expectedType) {
  const value = object(payload, context);
  literal(value.type, expectedType, `${context}.type`);
  string(value.eventId, `${context}.eventId`);
  string(value.createdAt, `${context}.createdAt`);
  string(value.roomId, `${context}.roomId`);
  string(value.callId, `${context}.callId`);
  enumValue(value.callType, ["audio", "video"], `${context}.callType`);
  if ("status" in value) enumValue(value.status, ["ringing", "active", "ended", "missed", "declined", "failed"], `${context}.status`);
  if ("createdByPrincipalId" in value) string(value.createdByPrincipalId, `${context}.createdByPrincipalId`);
  if ("principalId" in value) string(value.principalId, `${context}.principalId`);
  if ("deviceId" in value) string(value.deviceId, `${context}.deviceId`);
  if ("reason" in value) string(value.reason, `${context}.reason`);
  if ("endedReason" in value) string(value.endedReason, `${context}.endedReason`);
}

export function assertRealtimeTokenResponse(payload, context) {
  const value = success(payload, context);
  string(value.realtimeToken, `${context}.realtimeToken`);
  string(value.expiresAt, `${context}.expiresAt`);
}

export function assertMessagingCoreSession(value, context) {
  const session = object(value, context);
  boolean(session.enabled, `${context}.enabled`);
  enumValue(session.mode, ["off", "shadow", "proxy"], `${context}.mode`);
  boolean(session.configured, `${context}.configured`);
  string(session.tenantId, `${context}.tenantId`);
  string(session.app, `${context}.app`);
  nullableString(session.baseUrl, `${context}.baseUrl`);
  const tokenConfig = object(session.tokenConfig, `${context}.tokenConfig`);
  string(tokenConfig.audience, `${context}.tokenConfig.audience`);
  string(tokenConfig.issuer, `${context}.tokenConfig.issuer`);
  boolean(tokenConfig.hmacConfigured, `${context}.tokenConfig.hmacConfigured`);
  number(tokenConfig.ttlSeconds, `${context}.tokenConfig.ttlSeconds`);
  const internalService = object(session.internalService, `${context}.internalService`);
  string(internalService.audience, `${context}.internalService.audience`);
  string(internalService.issuer, `${context}.internalService.issuer`);
  boolean(internalService.configured, `${context}.internalService.configured`);
  number(internalService.ttlSeconds, `${context}.internalService.ttlSeconds`);
  const identitySync = object(session.identitySync, `${context}.identitySync`);
  if ("available" in identitySync) {
    boolean(identitySync.available, `${context}.identitySync.available`);
    boolean(identitySync.required, `${context}.identitySync.required`);
  } else {
    boolean(identitySync.attempted, `${context}.identitySync.attempted`);
    boolean(identitySync.ok, `${context}.identitySync.ok`);
    nullableString(identitySync.reason, `${context}.identitySync.reason`);
    if ("failedStep" in identitySync) nullableString(identitySync.failedStep, `${context}.identitySync.failedStep`);
    if ("tenantSynced" in identitySync) boolean(identitySync.tenantSynced, `${context}.identitySync.tenantSynced`);
    boolean(identitySync.accountSynced, `${context}.identitySync.accountSynced`);
    boolean(identitySync.principalSynced, `${context}.identitySync.principalSynced`);
    boolean(identitySync.deviceSynced, `${context}.identitySync.deviceSynced`);
  }
  if ("cutover" in session) {
    const cutover = object(session.cutover, `${context}.cutover`);
    boolean(cutover.roomRoutes, `${context}.cutover.roomRoutes`);
    boolean(cutover.messageRoutes, `${context}.cutover.messageRoutes`);
  }
  nullableString(session.reason, `${context}.reason`);
  if (session.configured) {
    literal(session.tokenType, "Bearer", `${context}.tokenType`);
    string(session.token, `${context}.token`);
    string(session.expiresAt, `${context}.expiresAt`);
    array(session.scopes, `${context}.scopes`).forEach((scope, index) => string(scope, `${context}.scopes[${index}]`));
  }
}

export function assertAdminUsageResponse(payload, context) {
  const value = success(payload, context);
  const usage = object(value.usage, `${context}.usage`);
  [
    "accounts",
    "activeDevices",
    "activeSessions",
    "openInvitations",
    "auditEvents",
    "rooms",
    "messages",
    "attachments",
    "agentRequests"
  ].forEach((key) => number(usage[key], `${context}.usage.${key}`));

  const attachmentBytes = object(usage.attachmentBytes, `${context}.usage.attachmentBytes`);
  number(attachmentBytes.activeExpectedBytes, `${context}.usage.attachmentBytes.activeExpectedBytes`);
  number(attachmentBytes.allocatedExpectedBytesLast24h, `${context}.usage.attachmentBytes.allocatedExpectedBytesLast24h`);
  number(attachmentBytes.uploadedStoredBytes, `${context}.usage.attachmentBytes.uploadedStoredBytes`);

  const callMedia = object(usage.callMedia, `${context}.usage.callMedia`);
  [
    "totalCalls",
    "activeCalls",
    "endedCalls",
    "failedCalls",
    "participantRows",
    "failedParticipants",
    "maxParticipants",
    "totalDurationMs",
    "averageDurationMs",
    "realtimeSessions",
    "activeRealtimeSessions",
    "realtimeTracks",
    "failedMediaEvents",
    "failedProviderRequests",
    "usageReports",
    "reportedDurationMs",
    "reportedAudioDurationMs",
    "reportedVideoDurationMs",
    "reportedScreenDurationMs",
    "bytesSentEstimate",
    "bytesReceivedEstimate",
    "relayLikelyReports"
  ].forEach((key) => number(callMedia[key], `${context}.usage.callMedia.${key}`));
  assertNumericMap(callMedia.tracksByKind, `${context}.usage.callMedia.tracksByKind`);
  assertNumericMap(callMedia.tracksByQualityLayer, `${context}.usage.callMedia.tracksByQualityLayer`);
  boolean(callMedia.turnConfigured, `${context}.usage.callMedia.turnConfigured`);
  nullableNumber(callMedia.estimatedSfuTurnEgressBytes, `${context}.usage.callMedia.estimatedSfuTurnEgressBytes`);
  string(callMedia.estimatedSfuTurnEgressStatus, `${context}.usage.callMedia.estimatedSfuTurnEgressStatus`);
}

export function assertEndpointCatalog() {
  const seen = new Set();
  for (const endpoint of endpointStabilityCatalog) {
    string(endpoint.method, "endpoint.method");
    string(endpoint.path, "endpoint.path");
    if (!["stable/current", "admin/dev-only", "future-sensitive"].includes(endpoint.stability)) {
      fail(`endpoint ${endpoint.method} ${endpoint.path} has invalid stability ${endpoint.stability}`);
    }
    const key = `${endpoint.method} ${endpoint.path}`;
    if (seen.has(key)) fail(`duplicate endpoint catalog entry: ${key}`);
    seen.add(key);
  }
}

function assertAccount(value, context) {
  const account = object(value, context);
  string(account.accountId, `${context}.accountId`);
  enumValue(account.status, ["invited", "active", "locked", "suspended", "pending_deletion", "deleted"], `${context}.status`);
  string(account.displayName, `${context}.displayName`);
  nullableString(account.email, `${context}.email`);
  nullableString(account.phone, `${context}.phone`);
  string(account.policyId, `${context}.policyId`);
  nullableString(account.defaultPrincipalId, `${context}.defaultPrincipalId`);
  string(account.createdAt, `${context}.createdAt`);
  nullableString(account.activatedAt, `${context}.activatedAt`);
}

function assertPrincipal(value, context) {
  const principal = object(value, context);
  string(principal.principalId, `${context}.principalId`);
  string(principal.accountId, `${context}.accountId`);
  enumValue(principal.principalType, ["human", "agent"], `${context}.principalType`);
  string(principal.displayName, `${context}.displayName`);
  nullableString(principal.avatarRef ?? null, `${context}.avatarRef`);
  enumValue(principal.status, ["active", "suspended", "revoked"], `${context}.status`);
  nullableString(principal.ownerPrincipalId ?? null, `${context}.ownerPrincipalId`);
  string(principal.createdAt, `${context}.createdAt`);
  nullableString(principal.revokedAt ?? null, `${context}.revokedAt`);
}

function assertDevice(value, context) {
  const device = object(value, context);
  string(device.deviceId, `${context}.deviceId`);
  string(device.accountId, `${context}.accountId`);
  string(device.principalId, `${context}.principalId`);
  string(device.platform, `${context}.platform`);
  string(device.label, `${context}.label`);
  nullableString(device.credentialFingerprint, `${context}.credentialFingerprint`);
  number(device.credentialVersion, `${context}.credentialVersion`);
  nullableString(device.publicKeyPackage ?? null, `${context}.publicKeyPackage`);
  nullableString(device.notificationCapability, `${context}.notificationCapability`);
  nullableString(device.clientVersion, `${context}.clientVersion`);
  nullableString(device.protocolVersion, `${context}.protocolVersion`);
  string(device.createdAt, `${context}.createdAt`);
  nullableString(device.lastSeenAt, `${context}.lastSeenAt`);
  nullableString(device.revokedAt, `${context}.revokedAt`);
  nullableString(device.revocationReason, `${context}.revocationReason`);
}

function assertRoom(value, context) {
  const room = object(value, context);
  string(room.roomId, `${context}.roomId`);
  enumValue(room.type, ["direct", "group", "channel"], `${context}.type`);
  nullableString(room.name, `${context}.name`);
  nullableString(room.description, `${context}.description`);
  enumValue(room.status, ["active", "archived", "deleted"], `${context}.status`);
  number(room.version, `${context}.version`);
  string(room.createdByAccountId, `${context}.createdByAccountId`);
  string(room.createdByPrincipalId, `${context}.createdByPrincipalId`);
  string(room.createdAt, `${context}.createdAt`);
  string(room.updatedAt, `${context}.updatedAt`);
  nullableString(room.archivedAt, `${context}.archivedAt`);
  number(room.pinnedMessageCount, `${context}.pinnedMessageCount`);
  nullableString(room.latestPinnedMessageId, `${context}.latestPinnedMessageId`);
  array(room.members, `${context}.members`).forEach((member, index) => assertMembership(member, `${context}.members[${index}]`));
}

function assertCall(value, context) {
  const call = object(value, context);
  string(call.callId, `${context}.callId`);
  string(call.roomId, `${context}.roomId`);
  enumValue(call.callType, ["audio", "video"], `${context}.callType`);
  enumValue(call.status, ["ringing", "active", "ended", "missed", "declined", "failed"], `${context}.status`);
  string(call.createdByAccountId, `${context}.createdByAccountId`);
  string(call.createdByPrincipalId, `${context}.createdByPrincipalId`);
  string(call.createdByDeviceId, `${context}.createdByDeviceId`);
  nullableString(call.startedAt, `${context}.startedAt`);
  nullableString(call.endedAt, `${context}.endedAt`);
  nullableString(call.endedReason, `${context}.endedReason`);
  string(call.createdAt, `${context}.createdAt`);
  string(call.updatedAt, `${context}.updatedAt`);
  array(call.participants, `${context}.participants`).forEach((participant, index) =>
    assertCallParticipant(participant, `${context}.participants[${index}]`)
  );
}

function assertCallParticipant(value, context) {
  const participant = object(value, context);
  string(participant.callParticipantId, `${context}.callParticipantId`);
  string(participant.callId, `${context}.callId`);
  string(participant.accountId, `${context}.accountId`);
  string(participant.principalId, `${context}.principalId`);
  enumValue(participant.principalType, ["human", "agent"], `${context}.principalType`);
  string(participant.displayName, `${context}.displayName`);
  nullableString(participant.deviceId, `${context}.deviceId`);
  enumValue(participant.role, ["participant", "moderator"], `${context}.role`);
  enumValue(participant.status, ["invited", "ringing", "joining", "connected", "left", "declined", "missed", "failed"], `${context}.status`);
  nullableString(participant.joinedAt, `${context}.joinedAt`);
  nullableString(participant.leftAt, `${context}.leftAt`);
  nullableString(participant.mutedAt, `${context}.mutedAt`);
  boolean(participant.audioEnabled, `${context}.audioEnabled`);
  boolean(participant.videoEnabled, `${context}.videoEnabled`);
  boolean(participant.screenEnabled, `${context}.screenEnabled`);
  nullableString(participant.lastSeenAt, `${context}.lastSeenAt`);
  string(participant.createdAt, `${context}.createdAt`);
  string(participant.updatedAt, `${context}.updatedAt`);
}

function assertMembership(value, context) {
  const membership = object(value, context);
  string(membership.membershipId, `${context}.membershipId`);
  string(membership.roomId, `${context}.roomId`);
  string(membership.accountId, `${context}.accountId`);
  string(membership.principalId, `${context}.principalId`);
  enumValue(membership.principalType, ["human", "agent"], `${context}.principalType`);
  string(membership.displayName, `${context}.displayName`);
  enumValue(membership.role, ["owner", "admin", "member", "agent"], `${context}.role`);
  enumValue(membership.status, ["invited", "active", "leaving", "removed", "banned"], `${context}.status`);
  string(membership.createdAt, `${context}.createdAt`);
  string(membership.updatedAt, `${context}.updatedAt`);
  nullableString(membership.removedAt, `${context}.removedAt`);
}

function assertMessage(value, context) {
  const message = object(value, context);
  string(message.envelopeId, `${context}.envelopeId`);
  string(message.roomId, `${context}.roomId`);
  string(message.senderAccountId, `${context}.senderAccountId`);
  string(message.senderPrincipalId, `${context}.senderPrincipalId`);
  string(message.senderDeviceId, `${context}.senderDeviceId`);
  string(message.idempotencyKey, `${context}.idempotencyKey`);
  enumValue(message.protocolType, ["opaque-test", "mls_application", "mls_commit", "mls_proposal", "mls_welcome"], `${context}.protocolType`);
  string(message.ciphertext, `${context}.ciphertext`);
  number(message.ciphertextBytes, `${context}.ciphertextBytes`);
  nullableString(message.clientCreatedAt, `${context}.clientCreatedAt`);
  number(message.serverSequence, `${context}.serverSequence`);
  string(message.serverReceivedAt, `${context}.serverReceivedAt`);
  string(message.expiresAt, `${context}.expiresAt`);
  nullableString(message.editedAt, `${context}.editedAt`);
  number(message.editCount, `${context}.editCount`);
  assertForwardedFrom(message.forwardedFrom, `${context}.forwardedFrom`);
  assertDeletedForEveryone(message.deletedForEveryone, `${context}.deletedForEveryone`);
  nullableString(message.threadRootEnvelopeId, `${context}.threadRootEnvelopeId`);
  boolean(message.alsoSentToRoom, `${context}.alsoSentToRoom`);
  assertThreadSummary(message.threadSummary, `${context}.threadSummary`);
  assertReceiptSummary(message.receiptSummary, `${context}.receiptSummary`);
  assertReactionSummary(message.reactions, `${context}.reactions`);
  assertMessagePin(message.pin, `${context}.pin`);
  enumValue(
    message.state,
    ["accepted", "available", "partially_acknowledged", "fully_acknowledged", "expired", "purged"],
    `${context}.state`
  );
}

function assertForwardedFrom(value, context) {
  if (value === null) return;
  const forwarded = object(value, context);
  string(forwarded.forwardedByPrincipalId, `${context}.forwardedByPrincipalId`);
}

function assertThreadSummary(value, context) {
  if (value === null) return;
  const summary = object(value, context);
  number(summary.replyCount, `${context}.replyCount`);
  nullableString(summary.lastReplyEnvelopeId, `${context}.lastReplyEnvelopeId`);
  nullableString(summary.lastReplySenderPrincipalId, `${context}.lastReplySenderPrincipalId`);
  nullableString(summary.lastReplyAt, `${context}.lastReplyAt`);
}

function assertThreadInboxItem(value, context) {
  const item = object(value, context);
  assertRoom(item.room, `${context}.room`);
  assertMessage(item.root, `${context}.root`);
  boolean(item.following, `${context}.following`);
  boolean(item.muted, `${context}.muted`);
  number(item.unreadCount, `${context}.unreadCount`);
  number(item.lastReadSequence, `${context}.lastReadSequence`);
  string(item.updatedAt, `${context}.updatedAt`);
}

function assertThreadState(value, context) {
  const state = object(value, context);
  string(state.rootEnvelopeId, `${context}.rootEnvelopeId`);
  string(state.roomId, `${context}.roomId`);
  boolean(state.following, `${context}.following`);
  boolean(state.muted, `${context}.muted`);
  number(state.lastReadSequence, `${context}.lastReadSequence`);
  string(state.updatedAt, `${context}.updatedAt`);
}

function assertDeletedForEveryone(value, context) {
  const deleted = object(value, context);
  boolean(deleted.deleted, `${context}.deleted`);
  nullableString(deleted.deletedAt, `${context}.deletedAt`);
  nullableString(deleted.deletedByPrincipalId, `${context}.deletedByPrincipalId`);
  nullableString(deleted.reason, `${context}.reason`);
}

function assertReactionSummary(value, context) {
  array(value, context).forEach((reaction, index) => {
    const item = object(reaction, `${context}[${index}]`);
    string(item.reaction, `${context}[${index}].reaction`);
    number(item.count, `${context}[${index}].count`);
    boolean(item.reactedByMe, `${context}[${index}].reactedByMe`);
  });
}

function assertMessagePin(value, context) {
  const pin = object(value, context);
  boolean(pin.pinned, `${context}.pinned`);
  nullableString(pin.pinnedAt, `${context}.pinnedAt`);
  nullableString(pin.pinnedByPrincipalId, `${context}.pinnedByPrincipalId`);
}

function assertReceiptSummary(value, context) {
  const summary = object(value, context);
  number(summary.total, `${context}.total`);
  number(summary.pending, `${context}.pending`);
  number(summary.delivered, `${context}.delivered`);
  number(summary.read, `${context}.read`);
  enumValue(summary.status, ["sent", "delivered", "read"], `${context}.status`);
}

function assertRoomInvitation(value, context) {
  const invitation = object(value, context);
  string(invitation.roomInvitationId, `${context}.roomInvitationId`);
  string(invitation.roomId, `${context}.roomId`);
  nullableString(invitation.roomName, `${context}.roomName`);
  enumValue(invitation.roomType, ["direct", "group", "channel"], `${context}.roomType`);
  string(invitation.invitedAccountId, `${context}.invitedAccountId`);
  string(invitation.invitedPrincipalId, `${context}.invitedPrincipalId`);
  string(invitation.invitedByAccountId, `${context}.invitedByAccountId`);
  string(invitation.invitedByPrincipalId, `${context}.invitedByPrincipalId`);
  string(invitation.invitedByDisplayName, `${context}.invitedByDisplayName`);
  enumValue(invitation.role, ["admin", "member"], `${context}.role`);
  enumValue(invitation.status, ["pending", "accepted", "declined", "revoked", "expired"], `${context}.status`);
  string(invitation.expiresAt, `${context}.expiresAt`);
  nullableString(invitation.respondedAt, `${context}.respondedAt`);
  string(invitation.createdAt, `${context}.createdAt`);
}

function assertKeyPackage(value, context) {
  const keyPackage = object(value, context);
  string(keyPackage.keyPackageId, `${context}.keyPackageId`);
  string(keyPackage.accountId, `${context}.accountId`);
  string(keyPackage.principalId, `${context}.principalId`);
  string(keyPackage.deviceId, `${context}.deviceId`);
  string(keyPackage.protocol, `${context}.protocol`);
  nullableString(keyPackage.publicIdentityKey, `${context}.publicIdentityKey`);
  nullableString(keyPackage.signedPrekey, `${context}.signedPrekey`);
  nullableString(keyPackage.oneTimePrekey, `${context}.oneTimePrekey`);
  if (!("package" in keyPackage)) fail(`${context}.package is missing`);
  string(keyPackage.status, `${context}.status`);
  nullableString(keyPackage.claimedByDeviceId, `${context}.claimedByDeviceId`);
  nullableString(keyPackage.claimedAt, `${context}.claimedAt`);
  string(keyPackage.expiresAt, `${context}.expiresAt`);
  string(keyPackage.createdAt, `${context}.createdAt`);
}

function assertAttachment(value, context) {
  const attachment = object(value, context);
  string(attachment.attachmentId, `${context}.attachmentId`);
  string(attachment.roomId, `${context}.roomId`);
  string(attachment.uploaderAccountId, `${context}.uploaderAccountId`);
  string(attachment.uploaderPrincipalId, `${context}.uploaderPrincipalId`);
  string(attachment.uploaderDeviceId, `${context}.uploaderDeviceId`);
  string(attachment.state, `${context}.state`);
  number(attachment.expectedBytes, `${context}.expectedBytes`);
  if (attachment.ciphertextBytes !== null) number(attachment.ciphertextBytes, `${context}.ciphertextBytes`);
  nullableString(attachment.ciphertextSha256, `${context}.ciphertextSha256`);
  nullableString(attachment.contentCategory, `${context}.contentCategory`);
  string(attachment.retentionClass, `${context}.retentionClass`);
  nullableString(attachment.originalFilename, `${context}.originalFilename`);
  nullableString(attachment.declaredMimeType, `${context}.declaredMimeType`);
  enumValue(attachment.mediaKind, ["image", "video", "audio", "file", "unknown"], `${context}.mediaKind`);
  if (attachment.width !== null) number(attachment.width, `${context}.width`);
  if (attachment.height !== null) number(attachment.height, `${context}.height`);
  if (attachment.durationMs !== null) number(attachment.durationMs, `${context}.durationMs`);
  assertAttachmentVariants(attachment.variants, `${context}.variants`);
  if (!("variantManifest" in attachment)) fail(`${context}.variantManifest is missing`);
  string(attachment.expiresAt, `${context}.expiresAt`);
  string(attachment.createdAt, `${context}.createdAt`);
  nullableString(attachment.uploadedAt, `${context}.uploadedAt`);
  nullableString(attachment.referencedAt, `${context}.referencedAt`);
  nullableString(attachment.deletedAt, `${context}.deletedAt`);
}

function assertAttachmentVariants(value, context) {
  const variants = object(value, context);
  assertAttachmentVariant(variants.original, `${context}.original`, "original");
  if (variants.preview !== undefined) {
    assertAttachmentVariant(variants.preview, `${context}.preview`, "preview");
  }
  if (variants.thumbnail !== undefined) {
    assertAttachmentVariant(variants.thumbnail, `${context}.thumbnail`, "thumbnail");
  }
}

function assertAttachmentVariant(value, context, expectedVariant) {
  const variant = object(value, context);
  enumValue(variant.variant, ["original", "preview", "thumbnail"], `${context}.variant`);
  if (variant.variant !== expectedVariant) {
    fail(`${context}.variant expected ${expectedVariant} but got ${variant.variant}`);
  }
  if (variant.bytes !== null) number(variant.bytes, `${context}.bytes`);
  if (variant.width !== null) number(variant.width, `${context}.width`);
  if (variant.height !== null) number(variant.height, `${context}.height`);
  string(variant.downloadPath, `${context}.downloadPath`);
}

function assertSidebarCollection(value, context) {
  const collection = object(value, context);
  string(collection.collectionId, `${context}.collectionId`);
  string(collection.accountId, `${context}.accountId`);
  string(collection.name, `${context}.name`);
  number(collection.sortOrder, `${context}.sortOrder`);
  boolean(collection.collapsed, `${context}.collapsed`);
  string(collection.createdAt, `${context}.createdAt`);
  string(collection.updatedAt, `${context}.updatedAt`);
  array(collection.items, `${context}.items`).forEach((item, index) => {
    const value = object(item, `${context}.items[${index}]`);
    string(value.itemId, `${context}.items[${index}].itemId`);
    string(value.roomId, `${context}.items[${index}].roomId`);
    number(value.sortOrder, `${context}.items[${index}].sortOrder`);
    string(value.createdAt, `${context}.items[${index}].createdAt`);
  });
}

function assertAgentRequest(value, context) {
  const request = object(value, context);
  string(request.requestId, `${context}.requestId`);
  string(request.requesterAccountId, `${context}.requesterAccountId`);
  string(request.requesterPrincipalId, `${context}.requesterPrincipalId`);
  string(request.desiredAgentName, `${context}.desiredAgentName`);
  string(request.summary, `${context}.summary`);
  enumValue(request.status, ["submitted", "under_review", "approved", "rejected", "provisioning", "active", "closed"], `${context}.status`);
  if (!("metadata" in request)) fail(`${context}.metadata is missing`);
  nullableString(request.reviewedByAccountId, `${context}.reviewedByAccountId`);
  nullableString(request.reviewedAt, `${context}.reviewedAt`);
  nullableString(request.createdAgentPrincipalId, `${context}.createdAgentPrincipalId`);
  string(request.createdAt, `${context}.createdAt`);
  string(request.updatedAt, `${context}.updatedAt`);
}

function success(payload, context) {
  const value = object(payload, context);
  literal(value.ok, true, `${context}.ok`);
  return value;
}

function object(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value;
}

function array(value, context) {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function string(value, context) {
  if (typeof value !== "string" || value.length === 0) fail(`${context} must be a non-empty string`);
}

function nullableString(value, context) {
  if (value !== null && typeof value !== "string") fail(`${context} must be a string or null`);
}

function nullableNumber(value, context) {
  if (value !== null) number(value, context);
}

function assertNumericMap(value, context) {
  const map = object(value, context);
  for (const [key, count] of Object.entries(map)) {
    string(key, `${context}.key`);
    number(count, `${context}.${key}`);
  }
}

function number(value, context) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${context} must be a finite number`);
}

function boolean(value, context) {
  if (typeof value !== "boolean") fail(`${context} must be a boolean`);
}

function enumValue(value, values, context) {
  if (!values.includes(value)) fail(`${context} must be one of ${values.join(", ")}`);
}

function literal(value, expected, context) {
  if (value !== expected) fail(`${context} must be ${JSON.stringify(expected)}`);
}

function fail(message) {
  throw new Error(`API contract assertion failed: ${message}`);
}
