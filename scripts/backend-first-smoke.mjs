const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";
const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? "local-bootstrap-secret";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const fetchTimeoutMs = Number(process.env.SMOKE_FETCH_TIMEOUT_MS ?? 10_000);

async function api(path, options = {}) {
  const { response, payload } = await apiRaw(path, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function apiRaw(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const fetchOptions = { ...options };
  delete fetchOptions.json;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    fetchOptions.body = JSON.stringify(options.json);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...fetchOptions,
    headers,
    signal: fetchOptions.signal ?? AbortSignal.timeout(fetchTimeoutMs)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  return { response, payload };
}

async function expectFailure(path, options, status) {
  const { response, payload } = await apiRaw(path, options);
  if (response.status !== status) {
    throw new Error(`${options.method ?? "GET"} ${path} expected ${status} but got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function realtimeUrl() {
  return `${baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/v1/realtime`;
}

async function openRealtimeMessageWatcher(token, expectedRoomId, timeoutMs = 5_000) {
  if (typeof WebSocket === "undefined") {
    throw new Error("Node WebSocket global is required for realtime smoke coverage");
  }
  return await new Promise((resolveReady, rejectReady) => {
    const socket = new WebSocket(realtimeUrl(), ["voyager.realtime.v1", token]);
    let ready = false;
    let settled = false;
    let messageTimeout;
    let waitResolve;
    let waitReject;
    const readyTimeout = setTimeout(() => failReady(new Error("timed out waiting for realtime ready event")), timeoutMs);
    const wait = new Promise((resolve, reject) => {
      waitResolve = resolve;
      waitReject = reject;
    });

    function close() {
      socket.close(1000, "smoke_done");
    }

    function failReady(error) {
      if (ready) return;
      clearTimeout(readyTimeout);
      close();
      rejectReady(error);
    }

    function finishMessage(result) {
      if (settled) return;
      settled = true;
      clearTimeout(messageTimeout);
      close();
      if (result instanceof Error) waitReject(result);
      else waitResolve(result);
    }

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        if (payload.type === "ready" && !ready) {
          ready = true;
          clearTimeout(readyTimeout);
          messageTimeout = setTimeout(() => finishMessage(new Error("timed out waiting for realtime room.message event")), timeoutMs);
          resolveReady({ wait, close });
          return;
        }
        if (payload.type === "room.message" && payload.roomId === expectedRoomId) {
          finishMessage(payload);
        }
      } catch (error) {
        finishMessage(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => {
      if (ready) finishMessage(new Error("realtime websocket error"));
      else failReady(new Error("realtime websocket error before ready"));
    });
    socket.addEventListener("close", () => {
      if (!ready) failReady(new Error("realtime websocket closed before ready"));
      else if (!settled) finishMessage(new Error("realtime websocket closed before room.message event"));
    });
  });
}

const health = await api("/health");
if (!health.ok) throw new Error("health check failed");

const owner = await api("/v1/admin/bootstrap", {
  method: "POST",
  headers: { "x-bootstrap-token": bootstrapToken },
  json: {
    displayName: "Backend Owner",
    email: `owner-${suffix}@example.com`,
    password: "backend-owner-passphrase-very-long",
    device: { platform: "smoke", label: "Owner smoke device", publicKeyPackage: "owner-device-key" }
  }
});
const ownerHeaders = auth(owner.sessionToken);

const invite = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend User",
    email: `user-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const accepted = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: invite.activationToken,
    password: "backend-user-passphrase-very-long",
    device: { platform: "smoke", label: "User smoke device", publicKeyPackage: "user-device-key" }
  }
});

await expectFailure("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: invite.activationToken,
    password: "backend-user-passphrase-reuse",
    device: { platform: "smoke", label: "Reused invitation smoke device" }
  }
}, 400);

const adminInvite = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend Security Admin",
    email: `security-admin-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const acceptedAdmin = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: adminInvite.activationToken,
    password: "backend-security-admin-passphrase-very-long",
    device: { platform: "smoke", label: "Security admin smoke device" }
  }
});
const adminHeaders = auth(acceptedAdmin.sessionToken);

await api(`/v1/admin/accounts/${acceptedAdmin.account.accountId}/roles`, {
  method: "POST",
  headers: ownerHeaders,
  json: { roleName: "security_admin" }
});

await api(`/v1/admin/accounts/${acceptedAdmin.account.accountId}/roles`, {
  method: "POST",
  headers: ownerHeaders,
  json: { roleName: "user_admin" }
});

await expectFailure(`/v1/admin/accounts/${acceptedAdmin.account.accountId}/roles`, {
  method: "POST",
  headers: adminHeaders,
  json: { roleName: "platform_owner" }
}, 403);

await expectFailure(`/v1/admin/accounts/${owner.account.accountId}/suspend`, {
  method: "POST",
  headers: adminHeaders,
  json: {}
}, 403);

await expectFailure(`/v1/admin/accounts/${owner.account.accountId}/credential-reset`, {
  method: "POST",
  headers: adminHeaders,
  json: { reason: "should not reset platform owner" }
}, 403);

await expectFailure(`/v1/admin/accounts/${owner.account.accountId}/roles/platform_owner`, {
  method: "DELETE",
  headers: ownerHeaders
}, 409);

await expectFailure(`/v1/admin/accounts/${owner.account.accountId}/credential-reset`, {
  method: "POST",
  headers: ownerHeaders,
  json: { reason: "self reset should use password change" }
}, 409);

const managedInvite = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend Managed User",
    email: `managed-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const managedAccepted = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: managedInvite.activationToken,
    password: "backend-managed-passphrase-very-long",
    device: { platform: "smoke", label: "Managed user smoke device" }
  }
});

await api(`/v1/admin/accounts/${managedAccepted.account.accountId}/suspend`, {
  method: "POST",
  headers: adminHeaders,
  json: {}
});

await api(`/v1/admin/accounts/${managedAccepted.account.accountId}/restore`, {
  method: "POST",
  headers: adminHeaders,
  json: {}
});

await api(`/v1/admin/accounts/${managedAccepted.account.accountId}/roles`, {
  method: "POST",
  headers: ownerHeaders,
  json: { roleName: "user_admin" }
});

await expectFailure(`/v1/admin/accounts/${managedAccepted.account.accountId}/suspend`, {
  method: "POST",
  headers: adminHeaders,
  json: {}
}, 403);

await expectFailure(`/v1/admin/accounts/${managedAccepted.account.accountId}/credential-reset`, {
  method: "POST",
  headers: adminHeaders,
  json: { reason: "lower admin cannot reset another admin" }
}, 403);

const login = await api("/v1/auth/password/login", {
  method: "POST",
  json: {
    email: invite.account.email,
    password: "backend-user-passphrase-very-long",
    device: { platform: "smoke", label: "User browser smoke device" }
  }
});
let userHeaders = auth(login.sessionToken);

await api("/v1/auth/password/change", {
  method: "POST",
  headers: userHeaders,
  json: {
    currentPassword: "backend-user-passphrase-very-long",
    newPassword: "backend-user-passphrase-very-long-updated"
  }
});

const relogin = await api("/v1/auth/password/login", {
  method: "POST",
  json: {
    email: invite.account.email,
    password: "backend-user-passphrase-very-long-updated",
    device: { deviceId: login.device.deviceId, platform: "smoke", label: "User relogin smoke device" }
  }
});
if (relogin.device.deviceId !== login.device.deviceId) throw new Error("login did not reuse the supplied device ID");
userHeaders = auth(relogin.sessionToken);

await expectFailure(`/v1/devices/${owner.device.deviceId}/revoke`, {
  method: "POST",
  headers: userHeaders,
  json: { reason: "cross-account revoke should fail" }
}, 404);

const invitee = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend Invitee",
    email: `invitee-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const acceptedInvitee = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: invitee.activationToken,
    password: "backend-invitee-passphrase-very-long",
    device: { platform: "smoke", label: "Invitee smoke device" }
  }
});
const inviteeHeaders = auth(acceptedInvitee.sessionToken);

const resetInvite = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend Reset User",
    email: `reset-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const resetAccepted = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: resetInvite.activationToken,
    password: "backend-reset-passphrase-very-long",
    device: { platform: "smoke", label: "Reset user smoke device" }
  }
});

const credentialReset = await api(`/v1/admin/accounts/${resetAccepted.account.accountId}/credential-reset`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    reason: "backend smoke reset superseded token",
    expiresInDays: 2,
    revokeDevices: true
  }
});

const credentialResetReplacement = await api(`/v1/admin/accounts/${resetAccepted.account.accountId}/credential-reset`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    reason: "backend smoke reset replacement token",
    expiresInDays: 2,
    revokeDevices: true
  }
});

await expectFailure("/v1/auth/password/reset/complete", {
  method: "POST",
  json: {
    token: credentialReset.resetToken,
    password: "backend-reset-old-token-passphrase",
    device: { platform: "smoke", label: "Old reset token device" }
  }
}, 400);

const resetComplete = await api("/v1/auth/password/reset/complete", {
  method: "POST",
  json: {
    token: credentialResetReplacement.resetToken,
    password: "backend-reset-passphrase-very-long-updated",
    device: { platform: "smoke", label: "Reset completion smoke device" }
  }
});
const resetHeaders = auth(resetComplete.sessionToken);

await expectFailure("/v1/auth/password/reset/complete", {
  method: "POST",
  json: {
    token: credentialResetReplacement.resetToken,
    password: "backend-reset-reuse-passphrase",
    device: { platform: "smoke", label: "Reused reset token device" }
  }
}, 400);

const suspendedInvite = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend Suspended Reset User",
    email: `suspended-reset-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const suspendedAccepted = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: suspendedInvite.activationToken,
    password: "backend-suspended-reset-passphrase-very-long",
    device: { platform: "smoke", label: "Suspended reset smoke device" }
  }
});

const suspendedReset = await api(`/v1/admin/accounts/${suspendedAccepted.account.accountId}/credential-reset`, {
  method: "POST",
  headers: ownerHeaders,
  json: { reason: "will be suspended before completion" }
});

await api(`/v1/admin/accounts/${suspendedAccepted.account.accountId}/suspend`, {
  method: "POST",
  headers: ownerHeaders,
  json: {}
});

await expectFailure("/v1/auth/password/reset/complete", {
  method: "POST",
  json: {
    token: suspendedReset.resetToken,
    password: "backend-suspended-reset-updated-passphrase",
    device: { platform: "smoke", label: "Suspended reset completion device" }
  }
}, 409);

const ownerKeyPackage = await api(`/v1/devices/${owner.device.deviceId}/key-packages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    protocol: "opaque-test",
    package: { identity: "owner", key: "owner-key-package" },
    publicIdentityKey: "owner-public-identity",
    expiresInDays: 5
  }
});

const listedKeys = await api(`/v1/principals/${owner.principal.principalId}/key-packages`, {
  headers: userHeaders
});
if (listedKeys.keyPackages.length < 1) throw new Error("key package listing failed");

await api(`/v1/key-packages/${ownerKeyPackage.keyPackage.keyPackageId}/claim`, {
  method: "POST",
  headers: userHeaders
});

await expectFailure(`/v1/key-packages/${ownerKeyPackage.keyPackage.keyPackageId}/claim`, {
  method: "POST",
  headers: inviteeHeaders
}, 404);

const ownerRevokedKeyPackage = await api(`/v1/devices/${owner.device.deviceId}/key-packages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    protocol: "opaque-test",
    package: { identity: "owner", key: "revoked-owner-key-package" },
    expiresInDays: 5
  }
});

const ownKeyPackages = await api(`/v1/devices/${owner.device.deviceId}/key-packages?limit=1`, {
  headers: ownerHeaders
});
if (ownKeyPackages.keyPackages.length !== 1 || ownKeyPackages.nextCursor === null) throw new Error("own key package pagination failed");

await api(`/v1/key-packages/${ownerRevokedKeyPackage.keyPackage.keyPackageId}/revoke`, {
  method: "POST",
  headers: ownerHeaders
});

const direct = await api("/v1/rooms/direct", {
  method: "POST",
  headers: ownerHeaders,
  json: { principalIds: [accepted.principal.principalId], name: "Smoke direct" }
});

await expectFailure("/v1/rooms/direct", {
  method: "POST",
  headers: ownerHeaders,
  json: { principalIds: [accepted.principal.principalId, acceptedInvitee.principal.principalId], name: "Invalid direct" }
}, 400);

await expectFailure("/v1/rooms/groups", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    name: "Invalid group",
    memberPrincipalIds: [accepted.principal.principalId]
  }
}, 400);

const group = await api("/v1/rooms/groups", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    name: "Smoke group",
    description: "Backend-first smoke group"
  }
});

await expectFailure(`/v1/rooms/${group.room.roomId}/members`, {
  method: "POST",
  headers: ownerHeaders,
  json: { principalId: resetComplete.principal.principalId }
}, 400);

const roomInvitation = await api(`/v1/rooms/${group.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: acceptedInvitee.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});

const userRoomInvitation = await api(`/v1/rooms/${group.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: accepted.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});

const pendingRoomInvitations = await api("/v1/room-invitations", {
  headers: inviteeHeaders
});
if (!pendingRoomInvitations.invitations.some((invitation) => invitation.roomInvitationId === roomInvitation.invitation.roomInvitationId)) {
  throw new Error("pending room invitation was not listed for invitee");
}

await api(`/v1/room-invitations/${roomInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: inviteeHeaders
});

await api(`/v1/room-invitations/${userRoomInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: userHeaders
});

const roomsPage = await api("/v1/rooms?limit=1", { headers: ownerHeaders });
if (roomsPage.rooms.length !== 1 || roomsPage.nextCursor === null) throw new Error("room pagination failed");

const agentRequest = await api("/v1/agent-requests", {
  method: "POST",
  headers: userHeaders,
  json: {
    desiredAgentName: "Smoke Agent",
    summary: "Need a backend-first smoke agent",
    metadata: { department: "testing" }
  }
});

await api(`/v1/admin/agent-requests/${agentRequest.request.requestId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: { status: "approved" }
});

const agent = await api("/v1/admin/agents", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Smoke Agent",
    ownerPrincipalId: owner.principal.principalId,
    requestId: agentRequest.request.requestId
  }
});

await api(`/v1/rooms/${group.room.roomId}/members`, {
  method: "POST",
  headers: ownerHeaders,
  json: { principalId: agent.agent.principalId }
});

const realtimeWatcher = await openRealtimeMessageWatcher(relogin.sessionToken, direct.room.roomId);

const directMessage = await api(`/v1/rooms/${direct.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `direct-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-direct-smoke-payload"
  }
});

const realtimeEvent = await realtimeWatcher.wait;
if (realtimeEvent.envelopeId !== directMessage.message.envelopeId) {
  throw new Error("realtime event did not reference the sent message envelope");
}
if (realtimeEvent.serverSequence !== directMessage.message.serverSequence) {
  throw new Error("realtime event did not reference the sent message sequence");
}

const synced = await api("/v1/sync", { headers: userHeaders });
if (synced.sync.pendingMessages.length < 1) throw new Error("sync did not return pending messages");

await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/ack`, {
  method: "POST",
  headers: userHeaders,
  json: { status: "stored" }
});

const attachmentBody = new TextEncoder().encode("encrypted-smoke-blob");

const attachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: { expectedBytes: attachmentBody.byteLength, contentCategory: "opaque-test" }
});

await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentBody
});

await api(`/v1/attachments/${attachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { ciphertextBytes: attachmentBody.byteLength, ciphertextSha256: "smoke-sha256-placeholder" }
});

const groupRealtimeWatcher = await openRealtimeMessageWatcher(relogin.sessionToken, group.room.roomId);

const groupMessage = await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `group-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-group-smoke-payload",
    attachmentIds: [attachment.attachment.attachmentId]
  }
});

const groupRealtimeEvent = await groupRealtimeWatcher.wait;
if (groupRealtimeEvent.envelopeId !== groupMessage.message.envelopeId) {
  throw new Error("group realtime event did not reference the sent message envelope");
}
if (groupRealtimeEvent.serverSequence !== groupMessage.message.serverSequence) {
  throw new Error("group realtime event did not reference the sent message sequence");
}

await expectFailure(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: resetHeaders,
  json: {
    idempotencyKey: `forbidden-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "reset-user-should-not-send-here"
  }
}, 403);

const downloaded = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  headers: userHeaders
});
if (downloaded !== "encrypted-smoke-blob") throw new Error("attachment download mismatch");

const collection = await api("/v1/sidebar-collections", {
  method: "POST",
  headers: userHeaders,
  json: { name: "Smoke collection", sortOrder: 1 }
});

await api(`/v1/sidebar-collections/${collection.collection.collectionId}/items`, {
  method: "POST",
  headers: userHeaders,
  json: { roomId: group.room.roomId, sortOrder: 1 }
});

const usage = await api("/v1/admin/usage", { headers: ownerHeaders });

const adminRooms = await api("/v1/admin/rooms?limit=1&type=group", { headers: ownerHeaders });
if (adminRooms.rooms.length !== 1) throw new Error("admin room listing failed");

const ownAgentRequests = await api("/v1/agent-requests?limit=1", { headers: userHeaders });
if (ownAgentRequests.requests.length !== 1) throw new Error("own agent request listing failed");

const adminAgentRequests = await api("/v1/admin/agent-requests?limit=1&status=active", { headers: ownerHeaders });
if (adminAgentRequests.requests.length !== 1) throw new Error("admin agent request listing failed");

const cleanup = await api("/v1/admin/maintenance/cleanup", {
  method: "POST",
  headers: ownerHeaders
});

const maintenanceRuns = await api("/v1/admin/maintenance/runs", { headers: ownerHeaders });
if (!maintenanceRuns.runs.some((run) => run.maintenanceRunId === cleanup.cleanup.maintenanceRunId)) {
  throw new Error("maintenance run was not recorded");
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  ownerAccountId: owner.account.accountId,
  userAccountId: accepted.account.accountId,
  inviteeAccountId: acceptedInvitee.account.accountId,
  resetAccountId: resetComplete.account.accountId,
  directRoomId: direct.room.roomId,
  groupRoomId: group.room.roomId,
  roomInvitationId: roomInvitation.invitation.roomInvitationId,
  agentPrincipalId: agent.agent.principalId,
  messageId: directMessage.message.envelopeId,
  realtimeEventId: realtimeEvent.eventId,
  groupMessageId: groupMessage.message.envelopeId,
  groupRealtimeEventId: groupRealtimeEvent.eventId,
  attachmentId: attachment.attachment.attachmentId,
  maintenanceRunId: cleanup.cleanup.maintenanceRunId,
  usage: usage.usage
}, null, 2));
