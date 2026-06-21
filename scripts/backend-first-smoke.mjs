import {
  assertAgentRequestResponse,
  assertAgentResponse,
  assertApiErrorShape,
  assertAttachmentResponse,
  assertAuthResult,
  assertBootstrapResponse,
  assertDeleteMessagesResponse,
  assertEndpointCatalog,
  assertKeyPackageResponse,
  assertKeyPackagesResponse,
  assertMessageResponse,
  assertMessagesResponse,
  assertPaginatedAgentRequestsResponse,
  assertPaginatedKeyPackagesResponse,
  assertPaginatedRoomInvitationsResponse,
  assertPaginatedRoomsResponse,
  assertRealtimeRoomMessageEvent,
  assertRealtimeTokenResponse,
  assertRoomInvitationResponse,
  assertRoomResponse,
  assertSidebarCollectionResponse,
  assertSyncResponse,
  assertThreadResponse
} from "./api-contract-assertions.mjs";
import { assertRouteInventory } from "./route-inventory-check.mjs";

assertEndpointCatalog();
assertRouteInventory();

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

function assertServerTiming(header, metrics, context) {
  for (const metric of metrics) {
    if (!header.includes(`${metric};dur=`)) {
      throw new Error(`${context} missing server timing metric ${metric}: ${header}`);
    }
  }
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

async function expectRealtimeConnectFailure(token, timeoutMs = 5_000) {
  if (typeof WebSocket === "undefined") {
    throw new Error("Node WebSocket global is required for realtime smoke coverage");
  }
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(realtimeUrl(), ["voyager.realtime.v1", token]);
    const timeout = setTimeout(() => {
      socket.close(1000, "smoke_timeout");
      reject(new Error("realtime websocket unexpectedly stayed pending"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close(1000, "unexpected_ready");
      reject(new Error("realtime websocket unexpectedly opened"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
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
assertAuthResult(owner, "POST /v1/admin/bootstrap");
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
assertAuthResult(accepted, "POST /v1/invitations/accept");

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
assertAuthResult(acceptedAdmin, "POST /v1/invitations/accept admin");
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
assertAuthResult(login, "POST /v1/auth/password/login");
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
assertAuthResult(relogin, "POST /v1/auth/password/login relogin");
if (relogin.device.deviceId !== login.device.deviceId) throw new Error("login did not reuse the supplied device ID");
userHeaders = auth(relogin.sessionToken);

assertApiErrorShape(await expectFailure("/v1/app/bootstrap", {}, 401), "unauthenticated bootstrap");

await expectFailure(`/v1/devices/${owner.device.deviceId}/revoke`, {
  method: "POST",
  headers: userHeaders,
  json: { reason: "cross-account revoke should fail" }
}, 404);

await expectFailure("/v1/admin/devices/test-cleanup", {
  method: "POST",
  headers: userHeaders,
  json: { dryRun: true }
}, 403);

const cleanupDeviceA = await api("/v1/devices", {
  method: "POST",
  headers: ownerHeaders,
  json: { platform: "probe", label: "Cleanup smoke marker A" }
});
const cleanupDeviceB = await api("/v1/devices", {
  method: "POST",
  headers: ownerHeaders,
  json: { platform: "probe", label: "Cleanup smoke marker B" }
});
const cleanupDryRun = await api("/v1/admin/devices/test-cleanup", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    dryRun: true,
    accountEmails: [owner.account.email],
    labelMatchers: ["cleanup smoke marker"],
    keepNewestPerAccount: 0
  }
});
if (cleanupDryRun.cleanup.matched !== 2 || cleanupDryRun.cleanup.revoked !== 0) {
  throw new Error(`cleanup dry-run did not match the expected devices: ${JSON.stringify(cleanupDryRun.cleanup)}`);
}
const cleanupApply = await api("/v1/admin/devices/test-cleanup", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    dryRun: false,
    accountEmails: [owner.account.email],
    labelMatchers: ["cleanup smoke marker"],
    keepNewestPerAccount: 0
  }
});
if (cleanupApply.cleanup.revoked !== 2) {
  throw new Error(`cleanup apply did not revoke the expected devices: ${JSON.stringify(cleanupApply.cleanup)}`);
}
const ownerDevicesAfterCleanup = await api("/v1/devices", { headers: ownerHeaders });
const revokedCleanupIds = new Set(
  ownerDevicesAfterCleanup.devices
    .filter((device) => [cleanupDeviceA.device.deviceId, cleanupDeviceB.device.deviceId].includes(device.deviceId) && device.revokedAt)
    .map((device) => device.deviceId)
);
if (revokedCleanupIds.size !== 2) {
  throw new Error("cleanup apply did not mark both probe devices revoked");
}

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
assertAuthResult(resetComplete, "POST /v1/auth/password/reset/complete");
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
assertKeyPackageResponse(ownerKeyPackage, "POST /v1/devices/{deviceId}/key-packages");

const listedKeys = await api(`/v1/principals/${owner.principal.principalId}/key-packages`, {
  headers: userHeaders
});
assertKeyPackagesResponse(listedKeys, "GET /v1/principals/{principalId}/key-packages");
if (listedKeys.keyPackages.length < 1) throw new Error("key package listing failed");

const claimedKeyPackage = await api(`/v1/key-packages/${ownerKeyPackage.keyPackage.keyPackageId}/claim`, {
  method: "POST",
  headers: userHeaders
});
assertKeyPackageResponse(claimedKeyPackage, "POST /v1/key-packages/{keyPackageId}/claim");

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
assertKeyPackageResponse(ownerRevokedKeyPackage, "POST /v1/devices/{deviceId}/key-packages revoked");

const ownKeyPackages = await api(`/v1/devices/${owner.device.deviceId}/key-packages?limit=1`, {
  headers: ownerHeaders
});
assertPaginatedKeyPackagesResponse(ownKeyPackages, "GET /v1/devices/{deviceId}/key-packages");
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
assertRoomResponse(direct, "POST /v1/rooms/direct");

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
assertRoomResponse(group, "POST /v1/rooms/groups");

const updatedGroupResult = await apiRaw(`/v1/rooms/${group.room.roomId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: {
    name: "Smoke group updated",
    description: "Backend-first smoke group with serialized mutations"
  }
});
if (!updatedGroupResult.response.ok) {
  throw new Error(`PATCH room failed ${updatedGroupResult.response.status}: ${JSON.stringify(updatedGroupResult.payload)}`);
}
assertServerTiming(
  updatedGroupResult.response.headers.get("server-timing") ?? "",
  ["roomUpdate", "conversationDo", "conversationQueue", "conversationOperation"],
  "PATCH /v1/rooms/{roomId}"
);
const updatedGroup = updatedGroupResult.payload;
assertRoomResponse(updatedGroup, "PATCH /v1/rooms/{roomId}");
if (updatedGroup.room.name !== "Smoke group updated") {
  throw new Error("room metadata update did not persist");
}

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
assertRoomInvitationResponse(roomInvitation, "POST /v1/rooms/{roomId}/invitations");

const userRoomInvitation = await api(`/v1/rooms/${group.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: accepted.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});
assertRoomInvitationResponse(userRoomInvitation, "POST /v1/rooms/{roomId}/invitations user");

const declinedRoomInvitation = await api(`/v1/rooms/${group.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: resetComplete.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});
assertRoomInvitationResponse(declinedRoomInvitation, "POST /v1/rooms/{roomId}/invitations declined");

const pendingRoomInvitations = await api("/v1/room-invitations", {
  headers: inviteeHeaders
});
assertPaginatedRoomInvitationsResponse(pendingRoomInvitations, "GET /v1/room-invitations");
if (!pendingRoomInvitations.invitations.some((invitation) => invitation.roomInvitationId === roomInvitation.invitation.roomInvitationId)) {
  throw new Error("pending room invitation was not listed for invitee");
}

const acceptedRoomInvitation = await api(`/v1/room-invitations/${roomInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: inviteeHeaders
});
assertRoomInvitationResponse(acceptedRoomInvitation, "POST /v1/room-invitations/{roomInvitationId}/accept");

const acceptedUserRoomInvitation = await api(`/v1/room-invitations/${userRoomInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: userHeaders
});
assertRoomInvitationResponse(acceptedUserRoomInvitation, "POST /v1/room-invitations/{roomInvitationId}/accept user");

const declinedInvitation = await api(`/v1/room-invitations/${declinedRoomInvitation.invitation.roomInvitationId}/decline`, {
  method: "POST",
  headers: resetHeaders
});
assertRoomInvitationResponse(declinedInvitation, "POST /v1/room-invitations/{roomInvitationId}/decline");
if (declinedInvitation.invitation.status !== "declined") {
  throw new Error("declined room invitation did not return declined status");
}

const groupPinPermissionMessage = await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `group-pin-permission-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-group-pin-permission-smoke-payload"
  }
});
assertMessageResponse(groupPinPermissionMessage, "POST /v1/rooms/{roomId}/messages group pin permission");
await expectFailure(`/v1/rooms/${group.room.roomId}/messages/${groupPinPermissionMessage.message.envelopeId}/pin`, {
  method: "POST",
  headers: inviteeHeaders
}, 403);
const groupPinnedMessage = await api(`/v1/rooms/${group.room.roomId}/messages/${groupPinPermissionMessage.message.envelopeId}/pin`, {
  method: "POST",
  headers: ownerHeaders
});
assertMessageResponse(groupPinnedMessage, "POST /v1/rooms/{roomId}/messages/{envelopeId}/pin group owner");
if (!groupPinnedMessage.message.pin.pinned) {
  throw new Error("group owner pin did not return active pin summary");
}
await expectFailure(`/v1/rooms/${group.room.roomId}/messages/${groupPinPermissionMessage.message.envelopeId}/pin`, {
  method: "DELETE",
  headers: inviteeHeaders
}, 403);
const groupUnpinnedMessage = await api(`/v1/rooms/${group.room.roomId}/messages/${groupPinPermissionMessage.message.envelopeId}/pin`, {
  method: "DELETE",
  headers: ownerHeaders
});
assertMessageResponse(groupUnpinnedMessage, "DELETE /v1/rooms/{roomId}/messages/{envelopeId}/pin group owner");
if (groupUnpinnedMessage.message.pin.pinned) {
  throw new Error("group owner unpin response still marked message as pinned");
}

const promotedMember = await api(`/v1/rooms/${group.room.roomId}/members/${accepted.principal.principalId}/role`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: { role: "admin" }
});
if (promotedMember.member.role !== "admin") {
  throw new Error("room member role update did not persist");
}

const ownershipTransfer = await api(`/v1/rooms/${group.room.roomId}/ownership-transfers`, {
  method: "POST",
  headers: ownerHeaders,
  json: { toPrincipalId: accepted.principal.principalId }
});
if (!ownershipTransfer.transfer.transferId) {
  throw new Error("ownership transfer proposal did not return a transfer id");
}
const acceptedTransfer = await api(`/v1/rooms/${group.room.roomId}/ownership-transfers/${ownershipTransfer.transfer.transferId}/accept`, {
  method: "POST",
  headers: userHeaders
});
if (acceptedTransfer.transfer.status !== "completed") {
  throw new Error("ownership transfer accept did not complete");
}

await api(`/v1/rooms/${group.room.roomId}/members/${acceptedInvitee.principal.principalId}`, {
  method: "DELETE",
  headers: ownerHeaders
});
await expectFailure(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: inviteeHeaders,
  json: {
    idempotencyKey: `removed-member-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "removed-member-should-not-send-here"
  }
}, 403);

const archivalGroup = await api("/v1/rooms/groups", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    name: "Archival smoke group",
    description: "Exercises leave and archive serialization"
  }
});
assertRoomResponse(archivalGroup, "POST /v1/rooms/groups archival");
const archivalInvitation = await api(`/v1/rooms/${archivalGroup.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: resetComplete.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});
assertRoomInvitationResponse(archivalInvitation, "POST /v1/rooms/{roomId}/invitations archival");
const acceptedArchivalInvitation = await api(`/v1/room-invitations/${archivalInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: resetHeaders
});
assertRoomInvitationResponse(acceptedArchivalInvitation, "POST /v1/room-invitations/{roomInvitationId}/accept archival");
await api(`/v1/rooms/${archivalGroup.room.roomId}/leave`, {
  method: "POST",
  headers: resetHeaders
});
await expectFailure(`/v1/rooms/${archivalGroup.room.roomId}/messages`, {
  method: "POST",
  headers: resetHeaders,
  json: {
    idempotencyKey: `left-member-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "left-member-should-not-send-here"
  }
}, 403);
const archivedRoom = await api(`/v1/rooms/${archivalGroup.room.roomId}/archive`, {
  method: "POST",
  headers: ownerHeaders
});
assertRoomResponse(archivedRoom, "POST /v1/rooms/{roomId}/archive");
if (archivedRoom.room.status !== "archived") {
  throw new Error("archived room did not return archived status");
}
await expectFailure(`/v1/rooms/${archivalGroup.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `archived-room-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "archived-room-should-not-send-here"
  }
}, 409);

const archivedPendingGroup = await api("/v1/rooms/groups", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    name: "Archived pending invitation group",
    description: "Exercises active-room mutation guards"
  }
});
assertRoomResponse(archivedPendingGroup, "POST /v1/rooms/groups archived pending");
const archivedPendingInvitation = await api(`/v1/rooms/${archivedPendingGroup.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: resetComplete.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});
assertRoomInvitationResponse(archivedPendingInvitation, "POST /v1/rooms/{roomId}/invitations archived pending");
await api(`/v1/rooms/${archivedPendingGroup.room.roomId}/archive`, {
  method: "POST",
  headers: ownerHeaders
});
await expectFailure(`/v1/room-invitations/${archivedPendingInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: resetHeaders
}, 409);
await expectFailure(`/v1/rooms/${archivedPendingGroup.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: acceptedInvitee.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
}, 409);
await expectFailure(`/v1/rooms/${archivedPendingGroup.room.roomId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: {
    name: "Should not update archived room"
  }
}, 409);

const roomsPage = await api("/v1/rooms?limit=1", { headers: ownerHeaders });
assertPaginatedRoomsResponse(roomsPage, "GET /v1/rooms");
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
assertAgentRequestResponse(agentRequest, "POST /v1/agent-requests");

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
assertAgentResponse(agent, "POST /v1/admin/agents");

await api(`/v1/rooms/${group.room.roomId}/members`, {
  method: "POST",
  headers: ownerHeaders,
  json: { principalId: agent.agent.principalId }
});

await expectRealtimeConnectFailure(relogin.sessionToken);

const realtimeToken = await api("/v1/realtime/token", {
  method: "POST",
  headers: userHeaders
});
assertRealtimeTokenResponse(realtimeToken, "POST /v1/realtime/token");
const realtimeWatcher = await openRealtimeMessageWatcher(realtimeToken.realtimeToken, direct.room.roomId);

const directMessageResult = await apiRaw(`/v1/rooms/${direct.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `direct-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-direct-smoke-payload"
  }
});
if (!directMessageResult.response.ok) {
  throw new Error(`POST direct message failed ${directMessageResult.response.status}: ${JSON.stringify(directMessageResult.payload)}`);
}
const directTiming = directMessageResult.response.headers.get("server-timing") ?? "";
assertServerTiming(
  directTiming,
  ["message", "conversationDo", "conversationQueue", "conversationOperation", "context", "insert", "postwrite", "realtime"],
  "POST /v1/rooms/{roomId}/messages"
);
const directMessage = directMessageResult.payload;
assertMessageResponse(directMessage, "POST /v1/rooms/{roomId}/messages");
if (directMessage.message.receiptSummary.status !== "sent" || directMessage.message.receiptSummary.pending < 1) {
  throw new Error("new direct message did not expose sent/pending receipt summary");
}

const editedDirectMessage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: {
    protocolType: "opaque-test",
    ciphertext: "encrypted-direct-smoke-payload-edited",
    clientEditedAt: new Date().toISOString()
  }
});
assertMessageResponse(editedDirectMessage, "PATCH /v1/rooms/{roomId}/messages/{envelopeId}");
if (editedDirectMessage.message.envelopeId !== directMessage.message.envelopeId) {
  throw new Error("edited message returned a different envelope id");
}
if (editedDirectMessage.message.ciphertext !== "encrypted-direct-smoke-payload-edited") {
  throw new Error("edited message did not return updated ciphertext");
}
if (!editedDirectMessage.message.editedAt || editedDirectMessage.message.editCount !== 1) {
  throw new Error("edited message did not include edit metadata");
}

await expectFailure(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}`, {
  method: "PATCH",
  headers: userHeaders,
  json: {
    protocolType: "opaque-test",
    ciphertext: "forbidden-edit-smoke-payload"
  }
}, 403);

const reactedDirectMessage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/reactions`, {
  method: "POST",
  headers: userHeaders,
  json: { reaction: "👍" }
});
assertMessageResponse(reactedDirectMessage, "POST /v1/rooms/{roomId}/messages/{envelopeId}/reactions");
const userReaction = reactedDirectMessage.message.reactions.find((reaction) => reaction.reaction === "👍");
if (!userReaction || userReaction.count !== 1 || userReaction.reactedByMe !== true) {
  throw new Error("reaction summary did not include current user reaction");
}

const replacedReactionMessage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/reactions`, {
  method: "POST",
  headers: userHeaders,
  json: { reaction: "❤️" }
});
assertMessageResponse(replacedReactionMessage, "POST /v1/rooms/{roomId}/messages/{envelopeId}/reactions replacement");
if (replacedReactionMessage.message.reactions.some((reaction) => reaction.reaction === "👍")) {
  throw new Error("reaction replacement kept the previous reaction active");
}
const replacementReaction = replacedReactionMessage.message.reactions.find((reaction) => reaction.reaction === "❤️");
if (!replacementReaction || replacementReaction.count !== 1 || replacementReaction.reactedByMe !== true) {
  throw new Error("reaction replacement did not expose the new active reaction");
}

const ownerReactionView = await api(`/v1/rooms/${direct.room.roomId}/messages?after=${directMessage.message.serverSequence - 1}&limit=1`, {
  headers: ownerHeaders
});
assertMessagesResponse(ownerReactionView, "GET /v1/rooms/{roomId}/messages reaction owner view");
const ownerReaction = ownerReactionView.messages[0]?.reactions.find((reaction) => reaction.reaction === "❤️");
if (!ownerReaction || ownerReaction.count !== 1 || ownerReaction.reactedByMe !== false) {
  throw new Error("reaction summary did not preserve viewer-specific reactedByMe");
}

const removedReaction = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/reactions/${encodeURIComponent("❤️")}`, {
  method: "DELETE",
  headers: userHeaders
});
assertMessageResponse(removedReaction, "DELETE /v1/rooms/{roomId}/messages/{envelopeId}/reactions/{reaction}");
if (removedReaction.message.reactions.some((reaction) => reaction.reaction === "❤️")) {
  throw new Error("deleted reaction remained in message summary");
}

const pinnedDirectMessage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/pin`, {
  method: "POST",
  headers: ownerHeaders
});
assertMessageResponse(pinnedDirectMessage, "POST /v1/rooms/{roomId}/messages/{envelopeId}/pin");
if (!pinnedDirectMessage.message.pin.pinned || pinnedDirectMessage.message.pin.pinnedByPrincipalId !== owner.principal.principalId) {
  throw new Error("pin response did not include active pin summary");
}
const pinnedRoom = await api(`/v1/rooms/${direct.room.roomId}`, { headers: ownerHeaders });
assertRoomResponse(pinnedRoom, "GET /v1/rooms/{roomId} after pin");
if (pinnedRoom.room.pinnedMessageCount !== 1 || pinnedRoom.room.latestPinnedMessageId !== directMessage.message.envelopeId) {
  throw new Error("room did not expose pinned message summary after pin");
}

const unpinnedDirectMessage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/pin`, {
  method: "DELETE",
  headers: userHeaders
});
assertMessageResponse(unpinnedDirectMessage, "DELETE /v1/rooms/{roomId}/messages/{envelopeId}/pin");
if (unpinnedDirectMessage.message.pin.pinned) {
  throw new Error("unpin response still marked message as pinned");
}
const unpinnedRoom = await api(`/v1/rooms/${direct.room.roomId}`, { headers: ownerHeaders });
assertRoomResponse(unpinnedRoom, "GET /v1/rooms/{roomId} after unpin");
if (unpinnedRoom.room.pinnedMessageCount !== 0 || unpinnedRoom.room.latestPinnedMessageId !== null) {
  throw new Error("room did not clear pinned message summary after unpin");
}

const realtimeEvent = await realtimeWatcher.wait;
assertRealtimeRoomMessageEvent(realtimeEvent, "GET /v1/realtime room.message");
if (realtimeEvent.roomId !== direct.room.roomId) {
  throw new Error("realtime event did not reference the sent room");
}
if (typeof realtimeEvent.eventId !== "string" || realtimeEvent.eventId.length === 0) {
  throw new Error("realtime event did not include an event id");
}
if (typeof realtimeEvent.createdAt !== "string" || realtimeEvent.createdAt.length === 0) {
  throw new Error("realtime event did not include a creation timestamp");
}
if (realtimeEvent.envelopeId !== directMessage.message.envelopeId) {
  throw new Error("realtime event did not reference the sent message envelope");
}
if (realtimeEvent.serverSequence !== directMessage.message.serverSequence) {
  throw new Error("realtime event did not reference the sent message sequence");
}
if (realtimeEvent.senderDeviceId !== owner.device.deviceId) {
  throw new Error("realtime event did not reference the sender device");
}
await expectRealtimeConnectFailure(realtimeToken.realtimeToken);

const forwardedToGroup = await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/forward`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    targetRoomId: group.room.roomId,
    idempotencyKey: `forward-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-forwarded-smoke-payload"
  }
});
assertMessageResponse(forwardedToGroup, "POST /v1/rooms/{roomId}/messages/{envelopeId}/forward");
if (forwardedToGroup.message.roomId !== group.room.roomId) {
  throw new Error("forwarded message did not land in the target room");
}
if (forwardedToGroup.message.forwardedFrom?.forwardedByPrincipalId !== owner.principal.principalId) {
  throw new Error("forwarded message did not expose the forwarding principal");
}
const forwardedKeys = Object.keys(forwardedToGroup.message.forwardedFrom ?? {});
if (
  forwardedKeys.includes("roomId") ||
  forwardedKeys.includes("envelopeId") ||
  forwardedKeys.includes("senderPrincipalId")
) {
  throw new Error("forwardedFrom must not expose source room, envelope, or sender metadata");
}

// Forward provenance must be server-asserted: a normal send cannot fabricate it
// by smuggling forward fields through the public message body.
const forgedForward = await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `forge-forward-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "normal-send-should-not-be-forwarded",
    forwardedFromRoomId: direct.room.roomId,
    forwardedFromEnvelopeId: directMessage.message.envelopeId
  }
});
assertMessageResponse(forgedForward, "POST /v1/rooms/{roomId}/messages forged forward metadata");
if (forgedForward.message.forwardedFrom !== null) {
  throw new Error("normal send must not accept forwardedFrom metadata from the request body");
}

// The internal forwardSource channel must not be reachable from the public body
// either: a nested forwardSource object on a normal send is ignored because it
// is only read from the Conversation DO request envelope, never the message body.
const forgedNestedForward = await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `forge-forward-nested-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "nested-forward-source-should-not-be-forwarded",
    forwardSource: {
      roomId: direct.room.roomId,
      envelopeId: directMessage.message.envelopeId,
      senderPrincipalId: owner.principal.principalId
    }
  }
});
assertMessageResponse(forgedNestedForward, "POST /v1/rooms/{roomId}/messages nested forwardSource");
if (forgedNestedForward.message.forwardedFrom !== null) {
  throw new Error("normal send must not accept a nested forwardSource object from the request body");
}

const duplicatePayload = {
  idempotencyKey: `dup-${suffix}`,
  protocolType: "opaque-test",
  ciphertext: "encrypted-duplicate-smoke-payload"
};
const firstDuplicate = await api(`/v1/rooms/${direct.room.roomId}/messages`, {
  method: "POST",
  headers: userHeaders,
  json: duplicatePayload
});
assertMessageResponse(firstDuplicate, "POST /v1/rooms/{roomId}/messages duplicate first");
const secondDuplicate = await api(`/v1/rooms/${direct.room.roomId}/messages`, {
  method: "POST",
  headers: userHeaders,
  json: duplicatePayload
});
assertMessageResponse(secondDuplicate, "POST /v1/rooms/{roomId}/messages duplicate retry");
if (secondDuplicate.message.envelopeId !== firstDuplicate.message.envelopeId) {
  throw new Error("duplicate idempotency retry returned a different message envelope");
}
if (secondDuplicate.message.serverSequence !== firstDuplicate.message.serverSequence) {
  throw new Error("duplicate idempotency retry returned a different server sequence");
}

await expectFailure(`/v1/rooms/${direct.room.roomId}/messages/delete`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    scope: "everyone",
    envelopeIds: [firstDuplicate.message.envelopeId]
  }
}, 403);
const deleteForEveryone = await api(`/v1/rooms/${direct.room.roomId}/messages/delete`, {
  method: "POST",
  headers: userHeaders,
  json: {
    scope: "everyone",
    envelopeIds: [firstDuplicate.message.envelopeId]
  }
});
assertDeleteMessagesResponse(deleteForEveryone, "POST /v1/rooms/{roomId}/messages/delete everyone");
if (deleteForEveryone.deleted.scope !== "everyone" || !deleteForEveryone.deleted.envelopeIds.includes(firstDuplicate.message.envelopeId)) {
  throw new Error("delete-for-everyone response did not include deleted envelope id");
}
const tombstoneView = await api(`/v1/rooms/${direct.room.roomId}/messages?after=${firstDuplicate.message.serverSequence - 1}&limit=1`, {
  headers: ownerHeaders
});
assertMessagesResponse(tombstoneView, "GET /v1/rooms/{roomId}/messages delete-for-everyone tombstone");
const tombstoneMessage = tombstoneView.messages[0];
if (
  tombstoneMessage?.envelopeId !== firstDuplicate.message.envelopeId ||
  tombstoneMessage.deletedForEveryone.deleted !== true ||
  !tombstoneMessage.deletedForEveryone.deletedAt ||
  tombstoneMessage.deletedForEveryone.deletedByPrincipalId !== accepted.principal.principalId ||
  tombstoneMessage.reactions.length !== 0 ||
  tombstoneMessage.pin.pinned !== false
) {
  throw new Error("delete-for-everyone did not expose a clean tombstone");
}
await expectFailure(`/v1/rooms/${direct.room.roomId}/messages/${firstDuplicate.message.envelopeId}/forward`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    targetRoomId: group.room.roomId,
    idempotencyKey: `forward-deleted-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "deleted-message-should-not-forward"
  }
}, 404);

// --- Threads: same-room sub-timeline with also-send and tombstone rules. ---
const threadRoot = await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `thread-root-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "thread-root-smoke-payload"
  }
});
assertMessageResponse(threadRoot, "POST /v1/rooms/{roomId}/messages thread root");
const threadRootId = threadRoot.message.envelopeId;

const threadReply = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `thread-reply-1-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "thread-reply-1-smoke-payload"
  }
});
assertMessageResponse(threadReply, "POST /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread");
if (threadReply.message.threadRootEnvelopeId !== threadRootId || threadReply.message.alsoSentToRoom !== false) {
  throw new Error("thread reply did not carry server-asserted thread metadata");
}

const mainAfterReply = await api(`/v1/rooms/${group.room.roomId}/messages?after=${threadRoot.message.serverSequence - 1}&limit=50`, {
  headers: ownerHeaders
});
assertMessagesResponse(mainAfterReply, "GET /v1/rooms/{roomId}/messages thread-only excluded");
if (mainAfterReply.messages.some((message) => message.envelopeId === threadReply.message.envelopeId)) {
  throw new Error("thread-only reply leaked into the main timeline");
}
const rootInMain = mainAfterReply.messages.find((message) => message.envelopeId === threadRootId);
if (!rootInMain || rootInMain.threadSummary?.replyCount !== 1) {
  throw new Error("root thread summary did not reflect the reply");
}

const threadView = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  headers: ownerHeaders
});
assertThreadResponse(threadView, "GET /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread");
if (threadView.thread.root.envelopeId !== threadRootId) {
  throw new Error("thread endpoint returned the wrong root");
}
if (!threadView.thread.replies.some((message) => message.envelopeId === threadReply.message.envelopeId)) {
  throw new Error("thread endpoint did not include the reply");
}

const threadReplyBroadcast = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `thread-reply-2-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "thread-reply-2-smoke-payload",
    alsoSendToRoom: true
  }
});
assertMessageResponse(threadReplyBroadcast, "POST thread reply also-send");
if (threadReplyBroadcast.message.alsoSentToRoom !== true || threadReplyBroadcast.message.threadRootEnvelopeId !== threadRootId) {
  throw new Error("also-send reply metadata incorrect");
}
const mainAfterBroadcast = await api(`/v1/rooms/${group.room.roomId}/messages?after=${threadRoot.message.serverSequence - 1}&limit=50`, {
  headers: ownerHeaders
});
if (!mainAfterBroadcast.messages.some((message) => message.envelopeId === threadReplyBroadcast.message.envelopeId)) {
  throw new Error("also-send reply did not appear in the main timeline");
}

// Thread metadata is server-asserted: a normal send cannot smuggle it through the body.
const forgedThread = await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `forge-thread-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "normal-send-should-not-thread",
    threadRootEnvelopeId: threadRootId,
    alsoSentToRoom: true,
    threadReply: { rootEnvelopeId: threadRootId, alsoSendToRoom: true }
  }
});
assertMessageResponse(forgedThread, "POST normal send forged thread metadata");
if (forgedThread.message.threadRootEnvelopeId !== null || forgedThread.message.alsoSentToRoom !== false) {
  throw new Error("normal send must not accept thread metadata from the request body");
}

// Deleting an also-sent reply for everyone tombstones it inside the thread too.
const deleteThreadReply = await api(`/v1/rooms/${group.room.roomId}/messages/delete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { scope: "everyone", envelopeIds: [threadReplyBroadcast.message.envelopeId] }
});
assertDeleteMessagesResponse(deleteThreadReply, "POST delete thread reply everyone");
const threadAfterReplyDelete = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  headers: ownerHeaders
});
const deletedReplyInThread = threadAfterReplyDelete.thread.replies.find(
  (message) => message.envelopeId === threadReplyBroadcast.message.envelopeId
);
if (!deletedReplyInThread || deletedReplyInThread.deletedForEveryone.deleted !== true) {
  throw new Error("thread reply tombstone not reflected in the thread");
}

// Deleting the root for everyone keeps existing replies but rejects new ones.
const deleteRoot = await api(`/v1/rooms/${group.room.roomId}/messages/delete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { scope: "everyone", envelopeIds: [threadRootId] }
});
assertDeleteMessagesResponse(deleteRoot, "POST delete thread root everyone");
const threadAfterRootDelete = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  headers: ownerHeaders
});
assertThreadResponse(threadAfterRootDelete, "GET thread after root delete");
if (threadAfterRootDelete.thread.root.deletedForEveryone.deleted !== true) {
  throw new Error("tombstoned root was not returned by the thread endpoint");
}
if (!threadAfterRootDelete.thread.replies.some((message) => message.envelopeId === threadReply.message.envelopeId)) {
  throw new Error("existing replies should remain after the root is deleted");
}
await expectFailure(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `thread-after-root-delete-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "should-be-rejected"
  }
}, 404);

// Threads work in direct rooms too.
const directThreadRoot = await api(`/v1/rooms/${direct.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: { idempotencyKey: `direct-thread-root-${suffix}`, protocolType: "opaque-test", ciphertext: "direct-thread-root" }
});
assertMessageResponse(directThreadRoot, "POST direct thread root");
const directThreadReply = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadRoot.message.envelopeId}/thread`, {
  method: "POST",
  headers: userHeaders,
  json: { idempotencyKey: `direct-thread-reply-${suffix}`, protocolType: "opaque-test", ciphertext: "direct-thread-reply" }
});
assertMessageResponse(directThreadReply, "POST direct thread reply");
const directThreadView = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadRoot.message.envelopeId}/thread`, {
  headers: ownerHeaders
});
assertThreadResponse(directThreadView, "GET direct thread");
if (!directThreadView.thread.replies.some((message) => message.envelopeId === directThreadReply.message.envelopeId)) {
  throw new Error("direct room thread did not include the reply");
}

const concurrentMessages = await Promise.all(
  Array.from({ length: 6 }, (_, index) =>
    api(`/v1/rooms/${direct.room.roomId}/messages`, {
      method: "POST",
      headers: userHeaders,
      json: {
        idempotencyKey: `concurrent-${index}-${suffix}`,
        protocolType: "opaque-test",
        ciphertext: `encrypted-concurrent-smoke-payload-${index}`
      }
    })
  )
);
for (const [index, message] of concurrentMessages.entries()) {
  assertMessageResponse(message, `POST /v1/rooms/{roomId}/messages concurrent ${index}`);
}
const concurrentSequences = concurrentMessages.map((result) => result.message.serverSequence).sort((left, right) => left - right);
if (new Set(concurrentSequences).size !== concurrentSequences.length) {
  throw new Error(`concurrent sends did not produce unique server sequences: ${concurrentSequences.join(", ")}`);
}
for (let index = 1; index < concurrentSequences.length; index += 1) {
  if (concurrentSequences[index] !== concurrentSequences[index - 1] + 1) {
    throw new Error(`concurrent sends did not produce contiguous server sequences: ${concurrentSequences.join(", ")}`);
  }
}
const concurrentRecovery = await api(`/v1/rooms/${direct.room.roomId}/messages?after=${concurrentSequences[0] - 1}`, { headers: userHeaders });
assertMessagesResponse(concurrentRecovery, "GET /v1/rooms/{roomId}/messages concurrent recovery");
const recoveredEnvelopeIds = new Set(concurrentRecovery.messages.map((message) => message.envelopeId));
for (const message of concurrentMessages) {
  if (!recoveredEnvelopeIds.has(message.message.envelopeId)) {
    throw new Error(`D1 message recovery did not include concurrent envelope ${message.message.envelopeId}`);
  }
}

const synced = await api("/v1/sync", { headers: userHeaders });
assertSyncResponse(synced, "GET /v1/sync");
if (synced.sync.pendingMessages.length < 1) throw new Error("sync did not return pending messages");

const bootstrapResult = await apiRaw("/v1/app/bootstrap?limit=100", { headers: userHeaders });
if (!bootstrapResult.response.ok) {
  throw new Error(`GET bootstrap failed ${bootstrapResult.response.status}: ${JSON.stringify(bootstrapResult.payload)}`);
}
const bootstrapTiming = bootstrapResult.response.headers.get("server-timing") ?? "";
for (const metric of ["bootstrap;dur=", "auth;dur=", "read;dur=", "rooms;dur=", "messages;dur="]) {
  if (!bootstrapTiming.includes(metric)) throw new Error(`bootstrap missing server timing metric ${metric}: ${bootstrapTiming}`);
}
const bootstrap = bootstrapResult.payload.bootstrap;
assertBootstrapResponse(bootstrapResult.payload, "GET /v1/app/bootstrap");
if (bootstrap.account.accountId !== login.account.accountId) throw new Error("bootstrap identity did not match logged-in account");
if (!Array.isArray(bootstrap.roles) || !Array.isArray(bootstrap.rooms) || !Array.isArray(bootstrap.pendingMessages)) {
  throw new Error("bootstrap response shape is invalid");
}
if (!bootstrap.rooms.some((room) => Array.isArray(room.members) && room.members.length > 0)) {
  throw new Error("bootstrap rooms did not include members");
}
for (const room of synced.sync.rooms) {
  if (!bootstrap.rooms.some((candidate) => candidate.roomId === room.roomId)) {
    throw new Error("bootstrap room list was not compatible with sync room list");
  }
}
if (!bootstrap.pendingMessages.some((message) => message.envelopeId === directMessage.message.envelopeId)) {
  throw new Error("bootstrap pending messages were not compatible with sync pending messages");
}

const deleteForMe = await api(`/v1/rooms/${direct.room.roomId}/messages/delete`, {
  method: "POST",
  headers: userHeaders,
  json: { scope: "for_me", envelopeIds: [directMessage.message.envelopeId] }
});
assertDeleteMessagesResponse(deleteForMe, "POST /v1/rooms/{roomId}/messages/delete");
if (!deleteForMe.deleted.envelopeIds.includes(directMessage.message.envelopeId)) {
  throw new Error("delete-for-me response did not include deleted envelope id");
}

const hiddenHistory = await api(`/v1/rooms/${direct.room.roomId}/messages?after=${directMessage.message.serverSequence - 1}`, {
  headers: userHeaders
});
assertMessagesResponse(hiddenHistory, "GET /v1/rooms/{roomId}/messages after delete-for-me");
if (hiddenHistory.messages.some((message) => message.envelopeId === directMessage.message.envelopeId)) {
  throw new Error("delete-for-me message remained visible to deleting account history");
}

const senderHistory = await api(`/v1/rooms/${direct.room.roomId}/messages?after=${directMessage.message.serverSequence - 1}`, {
  headers: ownerHeaders
});
assertMessagesResponse(senderHistory, "GET /v1/rooms/{roomId}/messages sender after delete-for-me");
const senderVisibleMessage = senderHistory.messages.find((message) => message.envelopeId === directMessage.message.envelopeId);
if (!senderVisibleMessage) {
  throw new Error("delete-for-me hid the message from another account");
}
if (senderVisibleMessage.receiptSummary.status !== "delivered") {
  throw new Error(`delete-for-me did not clear pending receipt state: ${senderVisibleMessage.receiptSummary.status}`);
}
if (senderVisibleMessage.ciphertext !== "encrypted-direct-smoke-payload-edited" || senderVisibleMessage.editCount !== 1) {
  throw new Error("edited message was not recovered through room history");
}

const hiddenSync = await api("/v1/sync", { headers: userHeaders });
assertSyncResponse(hiddenSync, "GET /v1/sync after delete-for-me");
if (hiddenSync.sync.pendingMessages.some((message) => message.envelopeId === directMessage.message.envelopeId)) {
  throw new Error("delete-for-me message remained visible to deleting account sync");
}

const hiddenBootstrapResult = await apiRaw("/v1/app/bootstrap?limit=100", { headers: userHeaders });
if (!hiddenBootstrapResult.response.ok) {
  throw new Error(`GET bootstrap after delete-for-me failed ${hiddenBootstrapResult.response.status}: ${JSON.stringify(hiddenBootstrapResult.payload)}`);
}
assertBootstrapResponse(hiddenBootstrapResult.payload, "GET /v1/app/bootstrap after delete-for-me");
if (hiddenBootstrapResult.payload.bootstrap.pendingMessages.some((message) => message.envelopeId === directMessage.message.envelopeId)) {
  throw new Error("delete-for-me message remained visible to deleting account bootstrap");
}

await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/ack`, {
  method: "POST",
  headers: userHeaders,
  json: { status: "read" }
});

const senderReadHistory = await api(`/v1/rooms/${direct.room.roomId}/messages?after=${directMessage.message.serverSequence - 1}`, {
  headers: ownerHeaders
});
assertMessagesResponse(senderReadHistory, "GET /v1/rooms/{roomId}/messages sender after read");
const readMessage = senderReadHistory.messages.find((message) => message.envelopeId === directMessage.message.envelopeId);
if (!readMessage || readMessage.receiptSummary.status !== "read") {
  throw new Error("read receipt summary did not update after recipient read ack");
}

const attachmentBody = new TextEncoder().encode("encrypted-smoke-blob");

const attachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: { expectedBytes: attachmentBody.byteLength, contentCategory: "opaque-test" }
});
assertAttachmentResponse(attachment, "POST /v1/rooms/{roomId}/attachments");

await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentBody
});

const completedAttachment = await api(`/v1/attachments/${attachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { ciphertextBytes: attachmentBody.byteLength, ciphertextSha256: "smoke-sha256-placeholder" }
});
assertAttachmentResponse(completedAttachment, "POST /v1/attachments/{attachmentId}/complete");

const groupRealtimeToken = await api("/v1/realtime/token", {
  method: "POST",
  headers: userHeaders
});
assertRealtimeTokenResponse(groupRealtimeToken, "POST /v1/realtime/token group");
const groupRealtimeWatcher = await openRealtimeMessageWatcher(groupRealtimeToken.realtimeToken, group.room.roomId);

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
assertMessageResponse(groupMessage, "POST /v1/rooms/{roomId}/messages group");

const groupRealtimeEvent = await groupRealtimeWatcher.wait;
assertRealtimeRoomMessageEvent(groupRealtimeEvent, "GET /v1/realtime group room.message");
if (groupRealtimeEvent.roomId !== group.room.roomId) {
  throw new Error("group realtime event did not reference the sent room");
}
if (groupRealtimeEvent.envelopeId !== groupMessage.message.envelopeId) {
  throw new Error("group realtime event did not reference the sent message envelope");
}
if (groupRealtimeEvent.serverSequence !== groupMessage.message.serverSequence) {
  throw new Error("group realtime event did not reference the sent message sequence");
}
if (groupRealtimeEvent.senderDeviceId !== owner.device.deviceId) {
  throw new Error("group realtime event did not reference the sender device");
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
assertSidebarCollectionResponse(collection, "POST /v1/sidebar-collections");

await api(`/v1/sidebar-collections/${collection.collection.collectionId}/items`, {
  method: "POST",
  headers: userHeaders,
  json: { roomId: group.room.roomId, sortOrder: 1 }
});

const usage = await api("/v1/admin/usage", { headers: ownerHeaders });

const adminRooms = await api("/v1/admin/rooms?limit=1&type=group", { headers: ownerHeaders });
assertPaginatedRoomsResponse(adminRooms, "GET /v1/admin/rooms");
if (adminRooms.rooms.length !== 1) throw new Error("admin room listing failed");

const ownAgentRequests = await api("/v1/agent-requests?limit=1", { headers: userHeaders });
assertPaginatedAgentRequestsResponse(ownAgentRequests, "GET /v1/agent-requests");
if (ownAgentRequests.requests.length !== 1) throw new Error("own agent request listing failed");

const adminAgentRequests = await api("/v1/admin/agent-requests?limit=1&status=active", { headers: ownerHeaders });
assertPaginatedAgentRequestsResponse(adminAgentRequests, "GET /v1/admin/agent-requests");
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
