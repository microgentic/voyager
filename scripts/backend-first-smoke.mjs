import {
  assertAdminUsageResponse,
  assertAgentRequestResponse,
  assertAgentResponse,
  assertApiErrorShape,
  assertAttachmentResponse,
  assertAuthResult,
  assertBootstrapResponse,
  assertCallRealtimeStatusResponse,
  assertCallRealtimeConfigResponse,
  assertCallResponse,
  assertCallsResponse,
  assertCallUsageReportResponse,
  assertDeleteMessagesResponse,
  assertEndpointCatalog,
  assertKeyPackageResponse,
  assertKeyPackagesResponse,
  assertMessagingCoreSessionResponse,
  assertMessageResponse,
  assertMessagesResponse,
  assertPaginatedAgentRequestsResponse,
  assertPaginatedKeyPackagesResponse,
  assertPaginatedRoomInvitationsResponse,
  assertPaginatedRoomsResponse,
  assertRealtimeRoomMessageEvent,
  assertRealtimeRoomThreadEvent,
  assertRealtimeCallEvent,
  assertRealtimeTokenResponse,
  assertRoomInvitationResponse,
  assertRoomResponse,
  assertSidebarCollectionResponse,
  assertSyncResponse,
  assertThreadResponse,
  assertThreadStateResponse,
  assertThreadsResponse
} from "./api-contract-assertions.mjs";
import { assertRouteInventory } from "./route-inventory-check.mjs";
import { createHmac } from "node:crypto";

assertEndpointCatalog();
assertRouteInventory();

const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";
const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? "local-bootstrap-secret";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const fetchTimeoutMs = Number(process.env.SMOKE_FETCH_TIMEOUT_MS ?? 10_000);
const realtimeMockEnabled = process.env.CLOUDFLARE_REALTIME_MOCK === "1";
const messagingCoreBridgeEnabled = process.env.SMOKE_MESSAGING_CORE_BRIDGE === "1";
const messagingCoreSmokeSecret = process.env.SMOKE_MESSAGING_CORE_TOKEN_SECRET ?? "local-messaging-core-token-secret";

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

function assertMessagingCoreFallbackDiagnostics(payload, fallbackReason, context) {
  const diagnostics = payload?.messagingCoreCutover;
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    throw new Error(`${context} missing messagingCoreCutover fallback diagnostics`);
  }
  if (
    diagnostics.source !== "voyager_legacy" ||
    diagnostics.fallbackReason !== fallbackReason ||
    diagnostics.route !== null ||
    diagnostics.upstreamStatus !== null
  ) {
    throw new Error(`${context} used unexpected Messaging Core fallback diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  const flags = diagnostics.flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags) || typeof flags.allCoreMessaging !== "boolean") {
    throw new Error(`${context} missing Messaging Core fallback flag snapshot`);
  }
}

function realtimeUrl() {
  return `${baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/v1/realtime`;
}

async function openRealtimeEventWatcher(
  token,
  expectedRoomId,
  expectedType,
  timeoutMs = 5_000,
) {
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
          messageTimeout = setTimeout(() => finishMessage(new Error(`timed out waiting for realtime ${expectedType} event`)), timeoutMs);
          resolveReady({ wait, close });
          return;
        }
        if (payload.type === expectedType && payload.roomId === expectedRoomId) {
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
      else if (!settled) finishMessage(new Error(`realtime websocket closed before ${expectedType} event`));
    });
  });
}

async function openRealtimeMessageWatcher(token, expectedRoomId, timeoutMs = 5_000) {
  return openRealtimeEventWatcher(token, expectedRoomId, "room.message", timeoutMs);
}

async function openRealtimeThreadWatcher(token, expectedRoomId, timeoutMs = 5_000) {
  return openRealtimeEventWatcher(token, expectedRoomId, "room.thread", timeoutMs);
}

async function openRealtimeCallWatcher(token, expectedRoomId, expectedType, timeoutMs = 5_000) {
  return openRealtimeEventWatcher(token, expectedRoomId, expectedType, timeoutMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockSessionDescription(label) {
  return {
    type: "offer",
    sdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=${label}\r\nt=0 0\r\n`
  };
}

function assertMessagingCoreBridgeSession(session, identity, context) {
  if (!session || typeof session !== "object") {
    throw new Error(`${context} missing messagingCore session`);
  }
  if (!session.configured || !session.token) {
    throw new Error(`${context} expected configured messagingCore token bridge: ${JSON.stringify(session)}`);
  }
  if (
    session.identitySync?.reason &&
    !/^internal_service_(unconfigured|unavailable|timeout|http_\d{3})$/.test(session.identitySync.reason)
  ) {
    throw new Error(`${context} messagingCore identity sync reason is not sanitized: ${session.identitySync.reason}`);
  }
  assertJwtSignature(session.token, messagingCoreSmokeSecret, context);
  const claims = decodeJwtPayload(session.token);
  const expected = {
    aud: "messaging-core",
    iss: "voyager",
    sub: identity.account.accountId,
    subjectId: identity.account.accountId,
    app: "voyager",
    tenantId: "tenant_voyager_default",
    accountId: identity.account.accountId,
    principalId: identity.principal.principalId,
    deviceId: identity.device.deviceId,
    principalType: identity.principal.principalType
  };
  for (const [key, value] of Object.entries(expected)) {
    if (claims[key] !== value) {
      throw new Error(`${context} messagingCore token ${key} expected ${value} but got ${claims[key]}`);
    }
  }
  if (
    !Array.isArray(claims.scopes) ||
    !claims.scopes.includes("messaging:read") ||
    !claims.scopes.includes("messaging:rooms:write") ||
    !claims.scopes.includes("messaging:messages:write") ||
    !claims.scopes.includes("messaging:key-packages:write")
  ) {
    throw new Error(`${context} messagingCore token scopes are missing messaging scopes`);
  }
  if (!Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || claims.exp <= claims.iat) {
    throw new Error(`${context} messagingCore token expiry claims are invalid`);
  }
}

function assertJwtSignature(token, secret, context) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error(`${context} messagingCore token is not a compact JWT`);
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest("base64url");
  if (parts[2] !== expected) {
    throw new Error(`${context} messagingCore token signature is invalid`);
  }
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("messagingCore token is not a compact JWT");
  return JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8"));
}

function base64UrlToBase64(value) {
  return value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
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
if (messagingCoreBridgeEnabled) {
  assertMessagingCoreBridgeSession(owner.messagingCore, owner, "POST /v1/admin/bootstrap");
  const bridgeSession = await api("/v1/messaging-core/session", {
    method: "POST",
    headers: ownerHeaders
  });
  assertMessagingCoreSessionResponse(bridgeSession, "POST /v1/messaging-core/session");
  assertMessagingCoreBridgeSession(bridgeSession.messagingCore, owner, "POST /v1/messaging-core/session");
}

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

const callRealtimeStatus = await api("/v1/admin/calls/realtime-status", { headers: ownerHeaders });
assertCallRealtimeStatusResponse(callRealtimeStatus, "GET /v1/admin/calls/realtime-status");
if (callRealtimeStatus.realtime.mock !== realtimeMockEnabled) {
  throw new Error("call realtime status did not reflect mock mode");
}

await expectFailure("/v1/rooms/direct", {
  method: "POST",
  headers: ownerHeaders,
  json: { principalIds: [accepted.principal.principalId, acceptedInvitee.principal.principalId], name: "Invalid direct" }
}, 400);

const callRealtimeToken = await api("/v1/realtime/token", {
  method: "POST",
  headers: userHeaders
});
assertRealtimeTokenResponse(callRealtimeToken, "POST /v1/realtime/token call invite");
const callInviteWatcher = await openRealtimeCallWatcher(callRealtimeToken.realtimeToken, direct.room.roomId, "call.invite");

const createdCallResult = await apiRaw(`/v1/rooms/${direct.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
});
if (!createdCallResult.response.ok) {
  throw new Error(`POST call failed ${createdCallResult.response.status}: ${JSON.stringify(createdCallResult.payload)}`);
}
assertServerTiming(
  createdCallResult.response.headers.get("server-timing") ?? "",
  ["callCreate", "callDo", "callQueue", "callOperation"],
  "POST /v1/rooms/{roomId}/calls"
);
const createdCall = createdCallResult.payload;
assertCallResponse(createdCall, "POST /v1/rooms/{roomId}/calls");
assertMessagingCoreFallbackDiagnostics(createdCall, "call_cutover_not_implemented", "POST /v1/rooms/{roomId}/calls");
if (createdCall.call.status !== "ringing" || createdCall.call.callType !== "audio") {
  throw new Error("created audio call did not enter ringing state");
}
const callerParticipant = createdCall.call.participants.find((participant) => participant.principalId === owner.principal.principalId);
const calleeParticipant = createdCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!callerParticipant || callerParticipant.status !== "connected" || callerParticipant.deviceId !== owner.device.deviceId) {
  throw new Error("call creator was not connected on the creating device");
}
if (!callerParticipant.audioEnabled || callerParticipant.videoEnabled || callerParticipant.screenEnabled || !callerParticipant.lastSeenAt) {
  throw new Error("call creator media/liveness state was not initialized");
}
if (!calleeParticipant || calleeParticipant.status !== "ringing" || calleeParticipant.deviceId !== null) {
  throw new Error("callee was not left in ringing invite state");
}
if (calleeParticipant.audioEnabled || calleeParticipant.videoEnabled || calleeParticipant.screenEnabled || calleeParticipant.lastSeenAt !== null) {
  throw new Error("ringing callee should not expose active media/liveness state");
}

const callInviteEvent = await callInviteWatcher.wait;
assertRealtimeCallEvent(callInviteEvent, "GET /v1/realtime call.invite", "call.invite");
if (
  callInviteEvent.callId !== createdCall.call.callId ||
  callInviteEvent.roomId !== direct.room.roomId ||
  callInviteEvent.createdByPrincipalId !== owner.principal.principalId
) {
  throw new Error("call invite realtime event did not identify the created call");
}

const listedCalls = await api(`/v1/rooms/${direct.room.roomId}/calls`, { headers: userHeaders });
assertCallsResponse(listedCalls, "GET /v1/rooms/{roomId}/calls");
assertMessagingCoreFallbackDiagnostics(listedCalls, "call_cutover_not_implemented", "GET /v1/rooms/{roomId}/calls");
if (!listedCalls.calls.some((call) => call.callId === createdCall.call.callId)) {
  throw new Error("room call list did not include the created call");
}

const fetchedCall = await api(`/v1/calls/${createdCall.call.callId}`, { headers: userHeaders });
assertCallResponse(fetchedCall, "GET /v1/calls/{callId}");
assertMessagingCoreFallbackDiagnostics(fetchedCall, "call_cutover_not_implemented", "GET /v1/calls/{callId}");
if (fetchedCall.call.callId !== createdCall.call.callId) {
  throw new Error("call fetch returned the wrong call");
}

let mockAudioSessionId = null;
if (realtimeMockEnabled) {
  const realtimeSessionConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/session`, {
    method: "POST",
    headers: ownerHeaders,
    json: { sessionDescription: mockSessionDescription("audio-session") }
  });
  assertCallRealtimeConfigResponse(realtimeSessionConfig, "POST /v1/calls/{callId}/realtime/session mock");
  if (realtimeSessionConfig.realtime.configured !== true || !realtimeSessionConfig.realtime.session?.sessionId) {
    throw new Error("mock realtime session did not return configured session data");
  }
  mockAudioSessionId = realtimeSessionConfig.realtime.session.sessionId;
  const duplicateRealtimeSessionConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/session`, {
    method: "POST",
    headers: ownerHeaders,
    json: { sessionDescription: mockSessionDescription("audio-session-duplicate") }
  });
  assertCallRealtimeConfigResponse(duplicateRealtimeSessionConfig, "POST /v1/calls/{callId}/realtime/session duplicate mock");
  if (duplicateRealtimeSessionConfig.realtime.session?.sessionId !== mockAudioSessionId) {
    throw new Error("duplicate mock realtime session did not return the existing active session");
  }
  if (!duplicateRealtimeSessionConfig.realtime.sessionDescription) {
    throw new Error("duplicate mock realtime session with a new offer did not return a fresh answer");
  }
  const realtimeTrackConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: mockAudioSessionId,
      sessionDescription: mockSessionDescription("audio-track"),
      tracks: [{ location: "local", trackName: `audio-${suffix}`, kind: "audio", mid: "audio0" }]
    }
  });
  assertCallRealtimeConfigResponse(realtimeTrackConfig, "POST /v1/calls/{callId}/realtime/tracks mock");
  const audioTrack = realtimeTrackConfig.realtime.tracks?.find((track) => track.trackName === `audio-${suffix}`);
  if (!audioTrack || audioTrack.kind !== "audio" || audioTrack.location !== "local") {
    throw new Error("mock realtime audio track was not persisted in the response");
  }
  const duplicateRealtimeTrackConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: mockAudioSessionId,
      sessionDescription: mockSessionDescription("audio-track-duplicate"),
      tracks: [{ location: "local", trackName: `audio-${suffix}`, kind: "audio", mid: "audio0" }]
    }
  });
  assertCallRealtimeConfigResponse(duplicateRealtimeTrackConfig, "POST /v1/calls/{callId}/realtime/tracks duplicate mock");
  if (
    duplicateRealtimeTrackConfig.realtime.tracks?.filter((track) => track.trackName === `audio-${suffix}`).length !== 1
  ) {
    throw new Error("duplicate mock audio track publication did not collapse to one track response");
  }
  await expectFailure(`/v1/calls/${createdCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: mockAudioSessionId,
      tracks: [{ location: "local", trackName: `audio-video-${suffix}`, kind: "video", mid: "video0" }]
    }
  }, 400);
  const realtimeRenegotiateConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/renegotiate`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: mockAudioSessionId,
      sessionDescription: mockSessionDescription("audio-renegotiate")
    }
  });
  assertCallRealtimeConfigResponse(realtimeRenegotiateConfig, "POST /v1/calls/{callId}/realtime/renegotiate mock");
  if (realtimeRenegotiateConfig.realtime.configured !== true || !realtimeRenegotiateConfig.realtime.sessionDescription) {
    throw new Error("mock realtime renegotiate did not return provider session description");
  }
  const realtimeCloseTracksConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/tracks/close`, {
    method: "POST",
    headers: ownerHeaders,
    json: { sessionId: mockAudioSessionId, tracks: [{ mid: "audio0" }], force: true }
  });
  assertCallRealtimeConfigResponse(realtimeCloseTracksConfig, "POST /v1/calls/{callId}/realtime/tracks/close mock");
  const duplicateRealtimeCloseTracksConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/tracks/close`, {
    method: "POST",
    headers: ownerHeaders,
    json: { sessionId: mockAudioSessionId, tracks: [{ mid: "audio0" }], force: true }
  });
  assertCallRealtimeConfigResponse(
    duplicateRealtimeCloseTracksConfig,
    "POST /v1/calls/{callId}/realtime/tracks/close duplicate mock"
  );
} else {
  const realtimeSessionConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/session`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallRealtimeConfigResponse(realtimeSessionConfig, "POST /v1/calls/{callId}/realtime/session");
  if (realtimeSessionConfig.realtime.configured !== false) {
    throw new Error("unconfigured realtime session config must not claim media is configured");
  }
  const realtimeTrackConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallRealtimeConfigResponse(realtimeTrackConfig, "POST /v1/calls/{callId}/realtime/tracks");
  if (!Array.isArray(realtimeTrackConfig.realtime.tracks) || realtimeTrackConfig.realtime.tracks.length !== 0) {
    throw new Error("unconfigured realtime track config must not expose media tracks");
  }
  const realtimeRenegotiateConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/renegotiate`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallRealtimeConfigResponse(realtimeRenegotiateConfig, "POST /v1/calls/{callId}/realtime/renegotiate");
  if (realtimeRenegotiateConfig.realtime.configured !== false) {
    throw new Error("unconfigured realtime renegotiate config must not claim media is configured");
  }
  const realtimeCloseTracksConfig = await api(`/v1/calls/${createdCall.call.callId}/realtime/tracks/close`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallRealtimeConfigResponse(realtimeCloseTracksConfig, "POST /v1/calls/{callId}/realtime/tracks/close");
  if (realtimeCloseTracksConfig.realtime.configured !== false) {
    throw new Error("unconfigured realtime close-tracks config must not claim media is configured");
  }
}

await expectFailure(`/v1/rooms/${direct.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
}, 409);

const joinedCall = await api(`/v1/calls/${createdCall.call.callId}/join`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(joinedCall, "POST /v1/calls/{callId}/join");
if (joinedCall.call.status !== "active" || !joinedCall.call.startedAt) {
  throw new Error("joining a ringing call did not activate it");
}
const joinedCallee = joinedCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!joinedCallee || joinedCallee.status !== "connected" || joinedCallee.deviceId !== relogin.device.deviceId) {
  throw new Error("callee join did not bind the current device");
}

const mutedCall = await api(`/v1/calls/${createdCall.call.callId}/mute`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(mutedCall, "POST /v1/calls/{callId}/mute");
const mutedParticipant = mutedCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!mutedParticipant?.mutedAt) {
  throw new Error("mute did not set participant mutedAt");
}
if (mutedParticipant.audioEnabled) {
  throw new Error("mute did not clear participant audioEnabled");
}

const unmutedCall = await api(`/v1/calls/${createdCall.call.callId}/participants/me`, {
  method: "PATCH",
  headers: userHeaders,
  json: { muted: false, audioEnabled: true, videoEnabled: false, screenEnabled: false, heartbeat: true }
});
assertCallResponse(unmutedCall, "PATCH /v1/calls/{callId}/participants/me");
const unmutedParticipant = unmutedCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!unmutedParticipant || unmutedParticipant.mutedAt !== null) {
  throw new Error("participant mute patch did not clear mutedAt");
}
if (!unmutedParticipant.audioEnabled || unmutedParticipant.videoEnabled || unmutedParticipant.screenEnabled || !unmutedParticipant.lastSeenAt) {
  throw new Error("participant media patch did not persist media/liveness state");
}

const mutedAgainCall = await api(`/v1/calls/${createdCall.call.callId}/participants/me`, {
  method: "PATCH",
  headers: userHeaders,
  json: { muted: true }
});
assertCallResponse(mutedAgainCall, "PATCH /v1/calls/{callId}/participants/me muted");
const mutedAgainParticipant = mutedAgainCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!mutedAgainParticipant?.mutedAt || mutedAgainParticipant.audioEnabled) {
  throw new Error("participant mute patch did not update audioEnabled");
}
const explicitlyUnmutedCall = await api(`/v1/calls/${createdCall.call.callId}/unmute`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(explicitlyUnmutedCall, "POST /v1/calls/{callId}/unmute");
const explicitlyUnmutedParticipant = explicitlyUnmutedCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!explicitlyUnmutedParticipant || explicitlyUnmutedParticipant.mutedAt !== null) {
  throw new Error("explicit unmute did not clear mutedAt");
}

const callUsageReport = await api(`/v1/calls/${createdCall.call.callId}/usage-report`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    ...(mockAudioSessionId ? { sessionId: mockAudioSessionId } : {}),
    durationMs: 42_000,
    bytesSentEstimate: 12_345,
    bytesReceivedEstimate: 67_890,
    tracks: [
      { kind: "audio", direction: "send", durationMs: 42_000, qualityLayer: "standard" },
      { kind: "audio", direction: "receive", durationMs: 40_000 }
    ],
    network: {
      candidateType: realtimeMockEnabled ? "host" : "relay",
      relayLikely: !realtimeMockEnabled,
      roundTripTimeMs: 12,
      packetsLost: 0
    }
  }
});
assertCallUsageReportResponse(callUsageReport, "POST /v1/calls/{callId}/usage-report");
if (
  callUsageReport.usageReport.callId !== createdCall.call.callId ||
  callUsageReport.usageReport.source !== "client_estimate" ||
  callUsageReport.usageReport.durationMs !== 42_000 ||
  callUsageReport.usageReport.bytesSentEstimate !== 12_345 ||
  callUsageReport.usageReport.bytesReceivedEstimate !== 67_890
) {
  throw new Error("call usage report did not echo expected aggregate fields");
}
const duplicateCallUsageReport = await api(`/v1/calls/${createdCall.call.callId}/usage-report`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    ...(mockAudioSessionId ? { sessionId: mockAudioSessionId } : {}),
    durationMs: 99_000,
    bytesSentEstimate: 99,
    tracks: [{ kind: "audio", direction: "send", durationMs: 99_000 }]
  }
});
assertCallUsageReportResponse(duplicateCallUsageReport, "POST /v1/calls/{callId}/usage-report duplicate");
if (duplicateCallUsageReport.usageReport.usageReportId !== callUsageReport.usageReport.usageReportId) {
  throw new Error("duplicate call usage report did not return the original report");
}
const clientProviderEgressReport = await expectFailure(`/v1/calls/${createdCall.call.callId}/usage-report`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    ...(mockAudioSessionId ? { sessionId: mockAudioSessionId } : {}),
    durationMs: 1_000,
    providerEgressBytes: 10_000,
    providerBillingSource: "client",
    tracks: [{ kind: "audio", direction: "send", durationMs: 1_000 }]
  }
}, 400);
assertApiErrorShape(clientProviderEgressReport, "POST /v1/calls/{callId}/usage-report client provider egress");
if (clientProviderEgressReport.error !== "provider_usage_not_authoritative") {
  throw new Error(`client provider egress report used unexpected error ${clientProviderEgressReport.error}`);
}
await expectFailure(`/v1/calls/${createdCall.call.callId}/usage-report`, {
  method: "POST",
  headers: userHeaders,
  json: {
    durationMs: 24 * 60 * 60 * 1000 + 1,
    tracks: [{ kind: "audio", direction: "send", durationMs: 1 }]
  }
}, 400);
if (mockAudioSessionId) {
  const foreignUsageSession = await expectFailure(`/v1/calls/${createdCall.call.callId}/usage-report`, {
    method: "POST",
    headers: userHeaders,
    json: {
      sessionId: mockAudioSessionId,
      durationMs: 1_000,
      tracks: [{ kind: "audio", direction: "send", durationMs: 1_000 }]
    }
  }, 404);
  assertApiErrorShape(foreignUsageSession, "POST /v1/calls/{callId}/usage-report foreign session");
  if (foreignUsageSession.error !== "realtime_session_not_found") {
    throw new Error(`foreign usage report used unexpected error ${foreignUsageSession.error}`);
  }
}

const calleeLeftCall = await api(`/v1/calls/${createdCall.call.callId}/leave`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(calleeLeftCall, "POST /v1/calls/{callId}/leave callee");
if (calleeLeftCall.call.status !== "active") {
  throw new Error("call should remain active while the creator is still connected");
}

const endedCall = await api(`/v1/calls/${createdCall.call.callId}/leave`, {
  method: "POST",
  headers: ownerHeaders
});
assertCallResponse(endedCall, "POST /v1/calls/{callId}/leave caller");
if (endedCall.call.status !== "ended" || !endedCall.call.endedAt || endedCall.call.endedReason !== "all_left") {
  throw new Error("call did not end after all connected participants left");
}
const endedHistory = await api(`/v1/rooms/${direct.room.roomId}/calls`, { headers: userHeaders });
assertCallsResponse(endedHistory, "GET /v1/rooms/{roomId}/calls ended history");
const endedHistoryCall = endedHistory.calls.find((call) => call.callId === createdCall.call.callId);
if (!endedHistoryCall || endedHistoryCall.status !== "ended" || endedHistoryCall.endedReason !== "all_left") {
  throw new Error("room call history did not include the ended call state");
}
if (mockAudioSessionId) {
  await expectFailure(`/v1/calls/${createdCall.call.callId}/realtime/renegotiate`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: mockAudioSessionId,
      sessionDescription: mockSessionDescription("audio-renegotiate-after-end")
    }
  }, 409);
  await expectFailure(`/v1/calls/${createdCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: mockAudioSessionId,
      tracks: [{ location: "local", trackName: `audio-after-end-${suffix}`, kind: "audio", mid: "audio-after-end" }]
    }
  }, 409);
}

const videoCall = await api(`/v1/rooms/${direct.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "video" }
});
assertCallResponse(videoCall, "POST /v1/rooms/{roomId}/calls video coverage");
if (videoCall.call.status !== "ringing" || videoCall.call.callType !== "video") {
  throw new Error("created video call did not enter ringing state");
}
await expectFailure(`/v1/calls/${videoCall.call.callId}`, {
  headers: inviteeHeaders
}, 403);

if (realtimeMockEnabled) {
  const videoRealtimeSessionConfig = await api(`/v1/calls/${videoCall.call.callId}/realtime/session`, {
    method: "POST",
    headers: ownerHeaders,
    json: { sessionDescription: mockSessionDescription("video-session") }
  });
  assertCallRealtimeConfigResponse(videoRealtimeSessionConfig, "POST /v1/calls/{callId}/realtime/session video mock");
  const videoSessionId = videoRealtimeSessionConfig.realtime.session?.sessionId;
  if (videoRealtimeSessionConfig.realtime.configured !== true || !videoSessionId) {
    throw new Error("mock video realtime session config returned the wrong shape");
  }
  const videoRealtimeTrackConfig = await api(`/v1/calls/${videoCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      sessionId: videoSessionId,
      sessionDescription: mockSessionDescription("video-tracks"),
      tracks: [
        { location: "local", trackName: `video-audio-${suffix}`, kind: "audio", mid: "video-audio0" },
        {
          location: "local",
          trackName: `video-camera-${suffix}`,
          kind: "video",
          mid: "video-camera0",
          simulcast: { preferredRid: "h", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" }
        },
        {
          location: "local",
          trackName: `video-screen-${suffix}`,
          kind: "screen",
          mid: "video-screen0",
          simulcast: { preferredRid: "q", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" }
        }
      ]
    }
  });
  assertCallRealtimeConfigResponse(videoRealtimeTrackConfig, "POST /v1/calls/{callId}/realtime/tracks video mock");
  const videoTrackKinds = new Set((videoRealtimeTrackConfig.realtime.tracks ?? []).map((track) => track.kind));
  if (!videoTrackKinds.has("audio") || !videoTrackKinds.has("video") || !videoTrackKinds.has("screen")) {
    throw new Error("mock video realtime track config did not include audio, video, and screen tracks");
  }
  const videoOwnerMedia = await api(`/v1/calls/${videoCall.call.callId}`, { headers: ownerHeaders });
  assertCallResponse(videoOwnerMedia, "GET /v1/calls/{callId} video owner media after mock tracks");
  const videoOwnerParticipant = videoOwnerMedia.call.participants.find(
    (participant) => participant.principalId === owner.principal.principalId
  );
  if (!videoOwnerParticipant?.audioEnabled || !videoOwnerParticipant.videoEnabled || !videoOwnerParticipant.screenEnabled) {
    throw new Error("mock video track upsert did not enable owner audio/video/screen state");
  }
  const videoCloseScreenConfig = await api(`/v1/calls/${videoCall.call.callId}/realtime/tracks/close`, {
    method: "POST",
    headers: ownerHeaders,
    json: { sessionId: videoSessionId, tracks: [{ mid: "video-screen0" }], force: true }
  });
  assertCallRealtimeConfigResponse(videoCloseScreenConfig, "POST /v1/calls/{callId}/realtime/tracks/close screen mock");
  const videoOwnerMediaAfterScreenClose = await api(`/v1/calls/${videoCall.call.callId}`, { headers: ownerHeaders });
  assertCallResponse(videoOwnerMediaAfterScreenClose, "GET /v1/calls/{callId} video owner media after screen close");
  const videoOwnerAfterScreenClose = videoOwnerMediaAfterScreenClose.call.participants.find(
    (participant) => participant.principalId === owner.principal.principalId
  );
  if (
    !videoOwnerAfterScreenClose?.audioEnabled ||
    !videoOwnerAfterScreenClose.videoEnabled ||
    videoOwnerAfterScreenClose.screenEnabled
  ) {
    throw new Error("mock video screen close did not preserve audio/video and clear screen state");
  }
} else {
  const videoRealtimeSessionConfig = await api(`/v1/calls/${videoCall.call.callId}/realtime/session`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallRealtimeConfigResponse(videoRealtimeSessionConfig, "POST /v1/calls/{callId}/realtime/session video");
  if (
    videoRealtimeSessionConfig.realtime.configured !== false ||
    videoRealtimeSessionConfig.realtime.callType !== "video"
  ) {
    throw new Error("unconfigured video realtime session config returned the wrong shape");
  }
  const videoRealtimeTrackConfig = await api(`/v1/calls/${videoCall.call.callId}/realtime/tracks`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallRealtimeConfigResponse(videoRealtimeTrackConfig, "POST /v1/calls/{callId}/realtime/tracks video");
  if (
    videoRealtimeTrackConfig.realtime.configured !== false ||
    !Array.isArray(videoRealtimeTrackConfig.realtime.tracks) ||
    videoRealtimeTrackConfig.realtime.tracks.length !== 0
  ) {
    throw new Error("unconfigured video realtime track config must not expose media tracks");
  }
}

const joinedVideoCall = await api(`/v1/calls/${videoCall.call.callId}/join`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(joinedVideoCall, "POST /v1/calls/{callId}/join video");
if (joinedVideoCall.call.status !== "active" || joinedVideoCall.call.callType !== "video") {
  throw new Error("joining a video call did not activate it");
}
const videoMediaStateCall = await api(`/v1/calls/${videoCall.call.callId}/participants/me`, {
  method: "PATCH",
  headers: userHeaders,
  json: { audioEnabled: true, videoEnabled: true, screenEnabled: false, heartbeat: true }
});
assertCallResponse(videoMediaStateCall, "PATCH /v1/calls/{callId}/participants/me video media");
const videoMediaParticipant = videoMediaStateCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!videoMediaParticipant?.audioEnabled || !videoMediaParticipant.videoEnabled || videoMediaParticipant.screenEnabled) {
  throw new Error("video media state patch did not persist participant camera state");
}
const screenMediaStateCall = await api(`/v1/calls/${videoCall.call.callId}/participants/me`, {
  method: "PATCH",
  headers: userHeaders,
  json: { audioEnabled: true, videoEnabled: true, screenEnabled: true, heartbeat: true }
});
assertCallResponse(screenMediaStateCall, "PATCH /v1/calls/{callId}/participants/me screen media");
const screenMediaParticipant = screenMediaStateCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!screenMediaParticipant?.audioEnabled || !screenMediaParticipant.videoEnabled || !screenMediaParticipant.screenEnabled) {
  throw new Error("video media state patch did not persist participant screen state");
}
const stoppedScreenMediaStateCall = await api(`/v1/calls/${videoCall.call.callId}/participants/me`, {
  method: "PATCH",
  headers: userHeaders,
  json: { screenEnabled: false, heartbeat: true }
});
assertCallResponse(stoppedScreenMediaStateCall, "PATCH /v1/calls/{callId}/participants/me stop screen media");
const stoppedScreenMediaParticipant = stoppedScreenMediaStateCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!stoppedScreenMediaParticipant || stoppedScreenMediaParticipant.screenEnabled) {
  throw new Error("video media state patch did not clear participant screen state");
}
const videoCalleeLeftCall = await api(`/v1/calls/${videoCall.call.callId}/leave`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(videoCalleeLeftCall, "POST /v1/calls/{callId}/leave video callee");
if (videoCalleeLeftCall.call.status !== "active") {
  throw new Error("video call should remain active while the creator is still connected");
}
const endedVideoCall = await api(`/v1/calls/${videoCall.call.callId}/leave`, {
  method: "POST",
  headers: ownerHeaders
});
assertCallResponse(endedVideoCall, "POST /v1/calls/{callId}/leave video caller");
if (endedVideoCall.call.status !== "ended" || endedVideoCall.call.endedReason !== "all_left") {
  throw new Error("video call did not end after all connected participants left");
}

const declineOnlyCall = await api(`/v1/rooms/${direct.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
});
assertCallResponse(declineOnlyCall, "POST /v1/rooms/{roomId}/calls decline coverage");
const declinedCall = await api(`/v1/calls/${declineOnlyCall.call.callId}/decline`, {
  method: "POST",
  headers: userHeaders
});
assertCallResponse(declinedCall, "POST /v1/calls/{callId}/decline");
if (declinedCall.call.status !== "declined" || !declinedCall.call.endedAt || declinedCall.call.endedReason !== "declined") {
  throw new Error("declining the only callee did not end the direct call as declined");
}
const declinedCaller = declinedCall.call.participants.find((participant) => participant.principalId === owner.principal.principalId);
const declinedCallee = declinedCall.call.participants.find((participant) => participant.principalId === accepted.principal.principalId);
if (!declinedCaller || declinedCaller.status !== "left" || !declinedCaller.leftAt) {
  throw new Error("declined call did not mark the caller as left");
}
if (!declinedCallee || declinedCallee.status !== "declined" || !declinedCallee.leftAt) {
  throw new Error("declined call did not preserve the callee decline state");
}
const declinedHistory = await api(`/v1/rooms/${direct.room.roomId}/calls`, { headers: userHeaders });
assertCallsResponse(declinedHistory, "GET /v1/rooms/{roomId}/calls declined history");
const declinedHistoryCall = declinedHistory.calls.find((call) => call.callId === declineOnlyCall.call.callId);
if (!declinedHistoryCall || declinedHistoryCall.status !== "declined") {
  throw new Error("room call history did not include declined call state");
}

const missedTimeoutCall = await api(`/v1/rooms/${direct.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
});
assertCallResponse(missedTimeoutCall, "POST /v1/rooms/{roomId}/calls missed timeout");
await sleep(6_500);
const missedAfterTimeout = await api(`/v1/calls/${missedTimeoutCall.call.callId}`, { headers: ownerHeaders });
assertCallResponse(missedAfterTimeout, "GET /v1/calls/{callId} missed timeout");
if (
  missedAfterTimeout.call.status !== "missed" ||
  missedAfterTimeout.call.endedReason !== "ring_timeout" ||
  !missedAfterTimeout.call.endedAt
) {
  throw new Error("ring timeout did not mark unanswered call as missed");
}
const missedHistory = await api(`/v1/rooms/${direct.room.roomId}/calls`, { headers: userHeaders });
assertCallsResponse(missedHistory, "GET /v1/rooms/{roomId}/calls missed history");
const missedHistoryCall = missedHistory.calls.find((call) => call.callId === missedTimeoutCall.call.callId);
if (!missedHistoryCall || missedHistoryCall.status !== "missed") {
  throw new Error("room call history did not include missed timeout call state");
}

const revokedCallLogin = await api("/v1/auth/password/login", {
  method: "POST",
  json: {
    email: invite.account.email,
    password: "backend-user-passphrase-very-long-updated",
    device: { platform: "smoke", label: "Revoked call join smoke device" }
  }
});
assertAuthResult(revokedCallLogin, "POST /v1/auth/password/login revoked call device");
const revokedCallHeaders = auth(revokedCallLogin.sessionToken);
const revocationGuardCall = await api(`/v1/rooms/${direct.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
});
assertCallResponse(revocationGuardCall, "POST /v1/rooms/{roomId}/calls revocation guard");
const joinedRevocationGuardCall = await api(`/v1/calls/${revocationGuardCall.call.callId}/join`, {
  method: "POST",
  headers: revokedCallHeaders
});
assertCallResponse(joinedRevocationGuardCall, "POST /v1/calls/{callId}/join revocation guard");
if (joinedRevocationGuardCall.call.status !== "active") {
  throw new Error("revocation guard call did not activate before revoking the joined device");
}
const revocationRealtimeToken = await api("/v1/realtime/token", {
  method: "POST",
  headers: ownerHeaders
});
assertRealtimeTokenResponse(revocationRealtimeToken, "POST /v1/realtime/token revocation watcher");
const revocationLeftWatcher = await openRealtimeCallWatcher(
  revocationRealtimeToken.realtimeToken,
  direct.room.roomId,
  "call.left"
);
await api(`/v1/devices/${revokedCallLogin.device.deviceId}/revoke`, {
  method: "POST",
  headers: revokedCallHeaders,
  json: { reason: "call_join_revocation_smoke" }
});
const revocationLeftEvent = await revocationLeftWatcher.wait;
assertRealtimeCallEvent(revocationLeftEvent, "GET /v1/realtime call.left after device revocation", "call.left");
if (
  revocationLeftEvent.callId !== revocationGuardCall.call.callId ||
  revocationLeftEvent.principalId !== accepted.principal.principalId ||
  revocationLeftEvent.deviceId !== revokedCallLogin.device.deviceId ||
  revocationLeftEvent.reason !== "device_revoked"
) {
  throw new Error("joined-device revocation did not emit a call.left event for the revoked participant");
}
await expectFailure(`/v1/calls/${revocationGuardCall.call.callId}`, {
  headers: revokedCallHeaders
}, 401);
const afterRevocationGuardCall = await api(`/v1/calls/${revocationGuardCall.call.callId}`, {
  headers: ownerHeaders
});
assertCallResponse(afterRevocationGuardCall, "GET /v1/calls/{callId} after joined-device revocation");
const revokedGuardParticipant = afterRevocationGuardCall.call.participants.find(
  (participant) => participant.deviceId === revokedCallLogin.device.deviceId
);
if (
  !revokedGuardParticipant ||
  revokedGuardParticipant.status !== "failed" ||
  revokedGuardParticipant.audioEnabled ||
  revokedGuardParticipant.videoEnabled ||
  revokedGuardParticipant.screenEnabled
) {
  throw new Error("revoked connected device remained joined or media-enabled");
}
const endedRevocationGuardCall = await api(`/v1/calls/${revocationGuardCall.call.callId}/leave`, {
  method: "POST",
  headers: ownerHeaders
});
assertCallResponse(endedRevocationGuardCall, "POST /v1/calls/{callId}/leave revocation guard");
if (endedRevocationGuardCall.call.status !== "ended") {
  throw new Error("revocation guard call did not end after caller left");
}

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
await expectFailure(`/v1/rooms/${archivalGroup.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
}, 409);

const archiveLiveCallGroup = await api("/v1/rooms/groups", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    name: "Archive live call smoke group",
    description: "Exercises live call cleanup on room archive"
  }
});
assertRoomResponse(archiveLiveCallGroup, "POST /v1/rooms/groups archive live call");
const archiveLiveCallInvitation = await api(`/v1/rooms/${archiveLiveCallGroup.room.roomId}/invitations`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    principalId: accepted.principal.principalId,
    role: "member",
    expiresInDays: 3
  }
});
assertRoomInvitationResponse(archiveLiveCallInvitation, "POST /v1/rooms/{roomId}/invitations archive live call");
await api(`/v1/room-invitations/${archiveLiveCallInvitation.invitation.roomInvitationId}/accept`, {
  method: "POST",
  headers: userHeaders
});
const archiveLiveCall = await api(`/v1/rooms/${archiveLiveCallGroup.room.roomId}/calls`, {
  method: "POST",
  headers: ownerHeaders,
  json: { callType: "audio" }
});
assertCallResponse(archiveLiveCall, "POST /v1/rooms/{roomId}/calls archive cleanup");
await api(`/v1/calls/${archiveLiveCall.call.callId}/join`, {
  method: "POST",
  headers: userHeaders
});
await api(`/v1/rooms/${archiveLiveCallGroup.room.roomId}/archive`, {
  method: "POST",
  headers: ownerHeaders
});
const archivedLiveCall = await api(`/v1/calls/${archiveLiveCall.call.callId}`, {
  headers: ownerHeaders
});
assertCallResponse(archivedLiveCall, "GET /v1/calls/{callId} archived room cleanup");
if (archivedLiveCall.call.status !== "ended" || archivedLiveCall.call.endedReason !== "room_archived") {
  throw new Error("archiving a room with a live call did not end the call");
}

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
if (threadView.thread.olderCursor !== null) {
  throw new Error("single-page thread unexpectedly returned an older cursor");
}

const ownerThreads = await api("/v1/threads?limit=20", { headers: ownerHeaders });
assertThreadsResponse(ownerThreads, "GET /v1/threads");
const ownerThreadItem = ownerThreads.items.find((item) => item.root.envelopeId === threadRootId);
if (!ownerThreadItem || ownerThreadItem.following !== true) {
  throw new Error("thread inbox did not include the participated thread");
}
if (ownerThreadItem.updatedAt !== threadReply.message.serverReceivedAt) {
  throw new Error("thread inbox activity timestamp did not use the latest reply time");
}
const ownerThreadRead = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread/read`, {
  method: "POST",
  headers: ownerHeaders
});
assertThreadStateResponse(ownerThreadRead, "POST /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/read");
if (
  ownerThreadRead.threadState.rootEnvelopeId !== threadRootId ||
  ownerThreadRead.threadState.lastReadSequence < threadReply.message.serverSequence
) {
  throw new Error("thread read state did not advance to the visible reply");
}
const ownerThreadsAfterRead = await api("/v1/threads?limit=20", { headers: ownerHeaders });
assertThreadsResponse(ownerThreadsAfterRead, "GET /v1/threads after read");
const ownerThreadItemAfterRead = ownerThreadsAfterRead.items.find((item) => item.root.envelopeId === threadRootId);
if (!ownerThreadItemAfterRead || ownerThreadItemAfterRead.updatedAt !== threadReply.message.serverReceivedAt) {
  throw new Error("thread read state should not change thread inbox activity time");
}
const ownerThreadUnfollow = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread/subscription`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: { following: false }
});
assertThreadStateResponse(ownerThreadUnfollow, "PATCH /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/subscription unfollow");
const ownerThreadsAfterUnfollow = await api("/v1/threads?limit=20", { headers: ownerHeaders });
assertThreadsResponse(ownerThreadsAfterUnfollow, "GET /v1/threads after unfollow");
if (ownerThreadsAfterUnfollow.items.some((item) => item.root.envelopeId === threadRootId)) {
  throw new Error("unfollowed thread remained in the thread inbox");
}
const ownerThreadRefollow = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread/subscription`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: { following: true }
});
assertThreadStateResponse(ownerThreadRefollow, "PATCH /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/subscription follow");
const ownerThreadsAfterRefollow = await api("/v1/threads?limit=20", { headers: ownerHeaders });
assertThreadsResponse(ownerThreadsAfterRefollow, "GET /v1/threads after follow");
if (!ownerThreadsAfterRefollow.items.some((item) => item.root.envelopeId === threadRootId)) {
  throw new Error("refollowed thread did not return to the thread inbox");
}
const observerThreadRead = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread/read`, {
  method: "POST",
  headers: userHeaders
});
assertThreadStateResponse(observerThreadRead, "POST /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/read unparticipated");
if (observerThreadRead.threadState.following !== false) {
  throw new Error("reading an unparticipated thread should not create an explicit follow");
}
const observerThreadsAfterRead = await api("/v1/threads?limit=20", { headers: userHeaders });
assertThreadsResponse(observerThreadsAfterRead, "GET /v1/threads unparticipated after read");
if (observerThreadsAfterRead.items.some((item) => item.root.envelopeId === threadRootId)) {
  throw new Error("unparticipated read-only thread appeared in the thread inbox");
}
const observerThreadFollow = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread/subscription`, {
  method: "PATCH",
  headers: userHeaders,
  json: { following: true }
});
assertThreadStateResponse(observerThreadFollow, "PATCH /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/subscription unparticipated follow");
const observerThreadsAfterFollow = await api("/v1/threads?limit=20", { headers: userHeaders });
assertThreadsResponse(observerThreadsAfterFollow, "GET /v1/threads unparticipated after follow");
if (!observerThreadsAfterFollow.items.some((item) => item.root.envelopeId === threadRootId && item.following === true)) {
  throw new Error("explicitly followed unparticipated thread did not appear in the thread inbox");
}

const threadMutationRealtimeToken = await api("/v1/realtime/token", {
  method: "POST",
  headers: ownerHeaders
});
assertRealtimeTokenResponse(threadMutationRealtimeToken, "POST /v1/realtime/token thread mutation");
const threadMutationRealtimeWatcher = await openRealtimeThreadWatcher(
  threadMutationRealtimeToken.realtimeToken,
  group.room.roomId
);
const editedThreadReply = await api(`/v1/rooms/${group.room.roomId}/messages/${threadReply.message.envelopeId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: {
    protocolType: "opaque-test",
    ciphertext: "thread-reply-1-smoke-payload-edited",
    clientEditedAt: new Date().toISOString()
  }
});
assertMessageResponse(editedThreadReply, "PATCH thread reply emits room.thread");
const threadMutationRealtimeEvent = await threadMutationRealtimeWatcher.wait;
assertRealtimeRoomThreadEvent(threadMutationRealtimeEvent, "GET /v1/realtime room.thread after thread reply edit");
if (
  threadMutationRealtimeEvent.roomId !== group.room.roomId ||
  threadMutationRealtimeEvent.envelopeId !== threadReply.message.envelopeId ||
  threadMutationRealtimeEvent.rootEnvelopeId !== threadRootId ||
  threadMutationRealtimeEvent.serverSequence !== threadReply.message.serverSequence ||
  threadMutationRealtimeEvent.senderDeviceId !== owner.device.deviceId ||
  threadMutationRealtimeEvent.alsoSentToRoom !== false
) {
  throw new Error("thread reply mutation did not emit a precise room.thread realtime event");
}

const hiddenThreadReply = await api(`/v1/rooms/${group.room.roomId}/messages/delete`, {
  method: "POST",
  headers: userHeaders,
  json: { scope: "for_me", envelopeIds: [threadReply.message.envelopeId] }
});
assertDeleteMessagesResponse(hiddenThreadReply, "POST delete thread reply for me");
const userThreadAfterHide = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  headers: userHeaders
});
assertThreadResponse(userThreadAfterHide, "GET thread after viewer hides reply");
if (userThreadAfterHide.thread.replies.some((message) => message.envelopeId === threadReply.message.envelopeId)) {
  throw new Error("delete-for-me did not hide the thread reply from the viewer");
}
if (userThreadAfterHide.thread.root.threadSummary !== null) {
  throw new Error("threadSummary counted a reply hidden for the viewer");
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
const duplicateThreadReplyAfterRootDelete = await api(`/v1/rooms/${group.room.roomId}/messages/${threadRootId}/thread`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `thread-reply-1-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "thread-reply-1-smoke-payload"
  }
});
assertMessageResponse(duplicateThreadReplyAfterRootDelete, "POST duplicate thread reply after root delete");
if (
  duplicateThreadReplyAfterRootDelete.message.envelopeId !== threadReply.message.envelopeId ||
  duplicateThreadReplyAfterRootDelete.message.serverSequence !== threadReply.message.serverSequence
) {
  throw new Error("duplicate thread reply retry after root delete did not recover the original message");
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
const secondDirectThreadReply = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadRoot.message.envelopeId}/thread`, {
  method: "POST",
  headers: ownerHeaders,
  json: { idempotencyKey: `direct-thread-reply-2-${suffix}`, protocolType: "opaque-test", ciphertext: "direct-thread-reply-2" }
});
assertMessageResponse(secondDirectThreadReply, "POST second direct thread reply");
const directThreadNewestPage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadRoot.message.envelopeId}/thread?limit=1`, {
  headers: ownerHeaders
});
assertThreadResponse(directThreadNewestPage, "GET direct thread newest page");
if (
  directThreadNewestPage.thread.olderCursor === null ||
  directThreadNewestPage.thread.replies.length !== 1 ||
  directThreadNewestPage.thread.replies[0].envelopeId !== secondDirectThreadReply.message.envelopeId
) {
  throw new Error("thread newest-page pagination did not return the expected older cursor");
}
const directThreadOlderPage = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadRoot.message.envelopeId}/thread?limit=1&before=${directThreadNewestPage.thread.olderCursor}`, {
  headers: ownerHeaders
});
assertThreadResponse(directThreadOlderPage, "GET direct thread older page");
if (
  directThreadOlderPage.thread.replies.length !== 1 ||
  directThreadOlderPage.thread.replies[0].envelopeId !== directThreadReply.message.envelopeId
) {
  throw new Error("thread older-page pagination did not return the previous reply");
}
const editedOlderDirectThreadReply = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadReply.message.envelopeId}`, {
  method: "PATCH",
  headers: userHeaders,
  json: {
    protocolType: "opaque-test",
    ciphertext: "direct-thread-reply-edited-targeted-refresh",
    clientEditedAt: new Date().toISOString()
  }
});
assertMessageResponse(editedOlderDirectThreadReply, "PATCH older direct thread reply");
const directThreadTargetedRefreshSlice = await api(`/v1/rooms/${direct.room.roomId}/messages/${directThreadRoot.message.envelopeId}/thread?after=${directThreadReply.message.serverSequence - 1}&limit=1`, {
  headers: ownerHeaders
});
assertThreadResponse(directThreadTargetedRefreshSlice, "GET direct thread targeted refresh slice");
if (
  directThreadTargetedRefreshSlice.thread.replies.length !== 1 ||
  directThreadTargetedRefreshSlice.thread.replies[0].envelopeId !== directThreadReply.message.envelopeId ||
  directThreadTargetedRefreshSlice.thread.replies[0].ciphertext !== "direct-thread-reply-edited-targeted-refresh"
) {
  throw new Error("targeted thread refresh slice did not return the mutated older reply");
}
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
const attachmentPreviewBody = new TextEncoder().encode("preview-smoke-blob");
const attachmentThumbnailBody = new TextEncoder().encode("thumbnail-smoke-blob");

const attachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    expectedBytes: 1024,
    contentCategory: "image",
    originalFilename: "smoke-image.webp",
    declaredMimeType: "image/webp",
    mediaKind: "image",
    width: 640,
    height: 480,
    variantManifest: {
      original: { encrypted: true },
      preview: { maxDimension: 640 },
      thumbnail: { maxDimension: 320 }
    }
  }
});
assertAttachmentResponse(attachment, "POST /v1/rooms/{roomId}/attachments");
if (
  attachment.attachment.mediaKind !== "image" ||
  attachment.attachment.originalFilename !== "smoke-image.webp" ||
  attachment.attachment.declaredMimeType !== "image/webp" ||
  attachment.attachment.width !== 640 ||
  attachment.attachment.height !== 480
) {
  throw new Error("attachment allocation did not preserve media metadata");
}

const thumbnailOnlyAttachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    expectedBytes: 128,
    contentCategory: "image",
    mediaKind: "image",
    originalFilename: "thumbnail-only.webp",
    declaredMimeType: "image/webp"
  }
});
assertAttachmentResponse(thumbnailOnlyAttachment, "POST /v1/rooms/{roomId}/attachments thumbnail-only");
const uploadedThumbnailOnlyAttachment = await api(`/v1/attachments/${thumbnailOnlyAttachment.attachment.attachmentId}/blob?variant=thumbnail`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentThumbnailBody
});
assertAttachmentResponse(uploadedThumbnailOnlyAttachment, "PUT /v1/attachments/{attachmentId}/blob thumbnail-only");
if (uploadedThumbnailOnlyAttachment.attachment.state !== "allocated") {
  throw new Error("thumbnail-only upload should not make an attachment referenceable");
}
await expectFailure(`/v1/attachments/${thumbnailOnlyAttachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { ciphertextBytes: attachmentThumbnailBody.byteLength }
}, 409);
await expectFailure(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `thumbnail-only-attachment-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "thumbnail-only-attachment-should-not-send",
    attachmentIds: [thumbnailOnlyAttachment.attachment.attachmentId]
  }
}, 409);

const overBudgetAttachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    expectedBytes: attachmentBody.byteLength + 1,
    contentCategory: "image",
    mediaKind: "image"
  }
});
assertAttachmentResponse(overBudgetAttachment, "POST /v1/rooms/{roomId}/attachments over budget");
await api(`/v1/attachments/${overBudgetAttachment.attachment.attachmentId}/blob`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentBody
});
await expectFailure(`/v1/attachments/${overBudgetAttachment.attachment.attachmentId}/blob?variant=preview`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentPreviewBody
}, 413);

const uploadedOriginalAttachment = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentBody
});
assertAttachmentResponse(uploadedOriginalAttachment, "PUT /v1/attachments/{attachmentId}/blob original");
if (uploadedOriginalAttachment.attachment.variants.original.bytes !== attachmentBody.byteLength) {
  throw new Error("original attachment variant did not record uploaded bytes");
}

const uploadedPreviewAttachment = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob?variant=preview`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentPreviewBody
});
assertAttachmentResponse(uploadedPreviewAttachment, "PUT /v1/attachments/{attachmentId}/blob preview");
if (
  !uploadedPreviewAttachment.attachment.variants.preview ||
  uploadedPreviewAttachment.attachment.variants.preview.bytes !== attachmentPreviewBody.byteLength
) {
  throw new Error("preview attachment variant did not record uploaded bytes");
}

const uploadedThumbnailAttachment = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob?variant=thumbnail`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentThumbnailBody
});
assertAttachmentResponse(uploadedThumbnailAttachment, "PUT /v1/attachments/{attachmentId}/blob thumbnail");
if (
  !uploadedThumbnailAttachment.attachment.variants.thumbnail ||
  uploadedThumbnailAttachment.attachment.variants.thumbnail.bytes !== attachmentThumbnailBody.byteLength
) {
  throw new Error("thumbnail attachment variant did not record uploaded bytes");
}

const completedAttachment = await api(`/v1/attachments/${attachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    ciphertextBytes: attachmentBody.byteLength,
    ciphertextSha256: "smoke-sha256-placeholder",
    variantManifest: {
      original: { bytes: attachmentBody.byteLength },
      preview: { bytes: attachmentPreviewBody.byteLength },
      thumbnail: { bytes: attachmentThumbnailBody.byteLength }
    }
  }
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

const referencedAttachmentDelete = await expectFailure(`/v1/attachments/${attachment.attachment.attachmentId}`, {
  method: "DELETE",
  headers: ownerHeaders
}, 409);
assertApiErrorShape(referencedAttachmentDelete, "DELETE /v1/attachments/{attachmentId} referenced");
if (referencedAttachmentDelete.error !== "attachment_already_referenced") {
  throw new Error(`referenced attachment delete used unexpected error ${referencedAttachmentDelete.error}`);
}
const referencedAttachmentComplete = await expectFailure(`/v1/attachments/${attachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    originalFilename: "mutated-after-send.bin",
    declaredMimeType: "text/plain",
    variantManifest: { original: { label: "mutated" } }
  }
}, 409);
assertApiErrorShape(referencedAttachmentComplete, "POST /v1/attachments/{attachmentId}/complete referenced");
if (referencedAttachmentComplete.error !== "attachment_already_referenced") {
  throw new Error(`referenced attachment complete used unexpected error ${referencedAttachmentComplete.error}`);
}
const editedReferencedAttachmentMessage = await api(`/v1/rooms/${group.room.roomId}/messages/${groupMessage.message.envelopeId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: {
    protocolType: "opaque-test",
    ciphertext: "encrypted-group-smoke-payload-edited-with-same-attachment",
    attachmentIds: [attachment.attachment.attachmentId],
    clientEditedAt: new Date().toISOString()
  }
});
assertMessageResponse(editedReferencedAttachmentMessage, "PATCH /v1/rooms/{roomId}/messages/{envelopeId} referenced attachment");
if (editedReferencedAttachmentMessage.message.envelopeId !== groupMessage.message.envelopeId) {
  throw new Error("editing with an already referenced attachment changed the envelope id");
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
const downloadedPreview = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob?variant=preview`, {
  headers: userHeaders
});
if (downloadedPreview !== "preview-smoke-blob") throw new Error("attachment preview download mismatch");
const downloadedThumbnail = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob?variant=thumbnail`, {
  headers: userHeaders
});
if (downloadedThumbnail !== "thumbnail-smoke-blob") throw new Error("attachment thumbnail download mismatch");
await expectFailure(`/v1/attachments/${attachment.attachment.attachmentId}/blob?variant=sidecar`, {
  headers: userHeaders
}, 400);

const deleteAttachmentMessage = await api(`/v1/rooms/${group.room.roomId}/messages/delete`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    scope: "everyone",
    envelopeIds: [groupMessage.message.envelopeId],
    reason: "attachment-delete-regression-smoke"
  }
});
assertDeleteMessagesResponse(deleteAttachmentMessage, "POST /v1/rooms/{roomId}/messages/delete attachment message");
const attachmentTombstoneView = await api(`/v1/rooms/${group.room.roomId}/messages?after=${groupMessage.message.serverSequence - 1}&limit=5`, {
  headers: userHeaders
});
assertMessagesResponse(attachmentTombstoneView, "GET /v1/rooms/{roomId}/messages attachment tombstone");
const attachmentTombstone = attachmentTombstoneView.messages.find((message) => message.envelopeId === groupMessage.message.envelopeId);
if (
  !attachmentTombstone ||
  attachmentTombstone.deletedForEveryone.deleted !== true ||
  attachmentTombstone.ciphertext !== "deleted-for-everyone"
) {
  throw new Error("delete-for-everyone did not tombstone attachment message content");
}
const referencedAttachmentDeleteAfterTombstone = await expectFailure(`/v1/attachments/${attachment.attachment.attachmentId}`, {
  method: "DELETE",
  headers: ownerHeaders
}, 409);
assertApiErrorShape(referencedAttachmentDeleteAfterTombstone, "DELETE /v1/attachments/{attachmentId} referenced after tombstone");
if (referencedAttachmentDeleteAfterTombstone.error !== "attachment_already_referenced") {
  throw new Error(`referenced attachment delete after tombstone used unexpected error ${referencedAttachmentDeleteAfterTombstone.error}`);
}
const downloadedAfterTombstone = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  headers: userHeaders
});
if (downloadedAfterTombstone !== "encrypted-smoke-blob") {
  throw new Error("referenced attachment blob disappeared after message tombstone");
}

const unreferencedAttachmentBody = new TextEncoder().encode("unreferenced-smoke-blob");
const unreferencedAttachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    expectedBytes: 128,
    contentCategory: "file",
    originalFilename: "unreferenced-smoke.bin",
    declaredMimeType: "application/octet-stream",
    mediaKind: "file"
  }
});
assertAttachmentResponse(unreferencedAttachment, "POST /v1/rooms/{roomId}/attachments unreferenced delete");
await api(`/v1/attachments/${unreferencedAttachment.attachment.attachmentId}/blob`, {
  method: "PUT",
  headers: ownerHeaders,
  body: unreferencedAttachmentBody
});
const completedUnreferencedAttachment = await api(`/v1/attachments/${unreferencedAttachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { ciphertextBytes: unreferencedAttachmentBody.byteLength }
});
assertAttachmentResponse(completedUnreferencedAttachment, "POST /v1/attachments/{attachmentId}/complete unreferenced delete");
const deletedUnreferencedAttachment = await api(`/v1/attachments/${unreferencedAttachment.attachment.attachmentId}`, {
  method: "DELETE",
  headers: ownerHeaders
});
if (deletedUnreferencedAttachment.ok !== true) {
  throw new Error("unreferenced attachment delete did not return ok");
}
const deletedUnreferencedBlob = await expectFailure(`/v1/attachments/${unreferencedAttachment.attachment.attachmentId}/blob`, {
  headers: ownerHeaders
}, 404);
assertApiErrorShape(deletedUnreferencedBlob, "GET /v1/attachments/{attachmentId}/blob deleted unreferenced");
const repeatedUnreferencedDelete = await expectFailure(`/v1/attachments/${unreferencedAttachment.attachment.attachmentId}`, {
  method: "DELETE",
  headers: ownerHeaders
}, 409);
assertApiErrorShape(repeatedUnreferencedDelete, "DELETE /v1/attachments/{attachmentId} deleted unreferenced");
if (repeatedUnreferencedDelete.error !== "attachment_not_deletable") {
  throw new Error(`deleted attachment delete used unexpected error ${repeatedUnreferencedDelete.error}`);
}
const staleDeletedAttachmentSend = await expectFailure(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `deleted-attachment-send-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "deleted-attachment-should-not-send",
    attachmentIds: [unreferencedAttachment.attachment.attachmentId]
  }
}, 409);
assertApiErrorShape(staleDeletedAttachmentSend, "POST /v1/rooms/{roomId}/messages deleted attachment");
if (staleDeletedAttachmentSend.error !== "attachment_not_referenceable") {
  throw new Error(`deleted attachment send used unexpected error ${staleDeletedAttachmentSend.error}`);
}

const tooManyAttachmentIds = Array.from({ length: 11 }, (_, index) => `att_smoke_${suffix}_${index}`);
const tooManyAttachments = await expectFailure(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `too-many-attachments-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "too-many-attachments-should-not-send",
    attachmentIds: tooManyAttachmentIds
  }
}, 400);
assertApiErrorShape(tooManyAttachments, "POST /v1/rooms/{roomId}/messages too many attachments");
if (tooManyAttachments.error !== "too_many_attachments") {
  throw new Error(`too many attachments used unexpected error ${tooManyAttachments.error}`);
}

const oversizedDimensions = await expectFailure(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    expectedBytes: 128,
    mediaKind: "image",
    width: 8193,
    height: 480
  }
}, 400);
assertApiErrorShape(oversizedDimensions, "POST /v1/rooms/{roomId}/attachments oversized dimensions");

let quotaFailure = null;
for (let index = 0; index < 12; index += 1) {
  const { response, payload } = await apiRaw(`/v1/rooms/${group.room.roomId}/attachments`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      expectedBytes: 10 * 1024 * 1024,
      mediaKind: "file",
      originalFilename: `quota-${index}.bin`
    }
  });
  if (response.status === 429) {
    quotaFailure = payload;
    break;
  }
  if (!response.ok) {
    throw new Error(`quota allocation failed unexpectedly ${response.status}: ${JSON.stringify(payload)}`);
  }
  assertAttachmentResponse(payload, `POST /v1/rooms/{roomId}/attachments quota ${index}`);
}
if (!quotaFailure) {
  throw new Error("attachment daily quota did not reject after repeated max-size allocations");
}
assertApiErrorShape(quotaFailure, "POST /v1/rooms/{roomId}/attachments daily quota");
if (quotaFailure.error !== "attachment_account_daily_quota_exceeded") {
  throw new Error(`daily quota used unexpected error ${quotaFailure.error}`);
}

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
assertAdminUsageResponse(usage, "GET /v1/admin/usage");
if (usage.usage.callMedia.usageReports !== 1 || usage.usage.callMedia.bytesSentEstimate !== 12_345) {
  throw new Error("admin usage did not preserve idempotent client-estimate call usage totals");
}
if (!realtimeMockEnabled && usage.usage.callMedia.failedMediaEvents < 4) {
  throw new Error("admin usage did not record unconfigured call media failures");
}
if (realtimeMockEnabled) {
  if (usage.usage.callMedia.realtimeSessions < 2) {
    throw new Error("admin usage did not record mock realtime sessions");
  }
  if (usage.usage.callMedia.realtimeTracks < 3) {
    throw new Error("admin usage did not record mock realtime tracks");
  }
  if ((usage.usage.callMedia.tracksByKind.audio ?? 0) < 1 || (usage.usage.callMedia.tracksByKind.video ?? 0) < 1) {
    throw new Error("admin usage did not record mock audio/video track kinds");
  }
}
if (usage.usage.attachmentBytes.allocatedExpectedBytesLast24h <= 0) {
  throw new Error("admin usage did not include attachment allocation bytes");
}

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
if (
  typeof cleanup.cleanup.abandonedAllocatedAttachments !== "number" ||
  typeof cleanup.cleanup.unreferencedUploadedAttachments !== "number" ||
  typeof cleanup.cleanup.attachmentCleanupWindows?.allocatedOlderThanMinutes !== "number" ||
  typeof cleanup.cleanup.attachmentCleanupWindows?.uploadedUnreferencedOlderThanHours !== "number"
) {
  throw new Error("maintenance cleanup did not expose attachment orphan cleanup counters");
}

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
