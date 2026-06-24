import {
  acceptInvitation,
  assertCanAdministerAccount,
  audit,
  bootstrapAdmin,
  changePassword,
  checkRateLimit,
  cleanupTestDevices,
  completeCredentialReset,
  createDeviceForPrincipal,
  createCredentialReset,
  createInvitation,
  getActiveAdminRoles,
  getAuditEvents,
  getAuthContext,
  getUsage,
  grantAdminRoleToAccount,
  listAccounts,
  listDevices,
  listPolicies,
  listSessions,
  loginWithPassword,
  requireAdmin,
  requireAuthReset,
  revokeAdminRoleFromAccount,
  revokeOwnDevice,
  revokeSession,
  setAccountStatus,
  updateAccountPolicy
} from "./db";
import { handleBackendFirstRoutes } from "./backend";
import {
  createMessagingCoreSessionPayload,
  fetchMessagingCoreAttachmentUsage,
  fetchMessagingCoreAttachmentDownloadCutoverProxy,
  fetchMessagingCoreAttachmentUploadCutoverProxy,
  fetchMessagingCoreCallCutoverProxy,
  fetchMessagingCoreCallRealtimeStatus,
  fetchMessagingCoreMessageCutoverProxy,
  fetchMessagingCoreRealtimeTokenProxy,
  fetchMessagingCoreRoomCutoverProxy,
  fetchMessagingCoreSyncCutoverProxy,
  messagingCoreAttachmentAllocateBody,
  messagingCoreAttachmentCompleteBody,
  revokeMessagingCoreDevice,
  syncMessagingCorePrincipal,
} from "./backend/messaging-core-bridge";
import { ROOM_INVITATION_DAYS } from "./backend/rooms/types";
import { sqliteTimestamp } from "./backend/utils";
import { randomId } from "./crypto";
import { errorResponse, HttpError, json, optionalObject, publicAccount, readJsonObject, readOptionalJsonObject, requireMethod, routeParams, serverTimingHeader, stringField } from "./http";
import type { AuthContext, DeviceInput, DeviceRow, Env, PrincipalRow, SessionRow } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TEST_DEVICE_LABEL_MATCHERS = [
  "codex",
  "probe",
  "smoke",
  "simulator",
  "emulator",
  "seed check",
  "cleanup cli",
  "dev test"
];
const DEFAULT_TEST_DEVICE_PLATFORM_MATCHERS = ["probe", "smoke", "test"];
const REALTIME_TOKEN_LIMIT = 60;
const REALTIME_TOKEN_WINDOW_SECONDS = 5 * 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = randomId("req");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      return applyCors(await handleRequest(request, env, url, requestId), request, env);
    } catch (error) {
      return applyCors(errorResponse(error, requestId), request, env);
    }
  }
};

async function handleRequest(request: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  if (url.pathname === "/" || url.pathname === "/health") {
    requireMethod(request, "GET");
    return json({
      ok: true,
      service: "voyager-api-dev",
      status: "healthy",
      d1: Boolean(env.CONTROL_DB) ? "bound" : "missing",
      messagingCoreService: Boolean(env.MESSAGING_CORE_SERVICE) ? "bound" : "base-url",
      timestamp: new Date().toISOString()
    });
  }

  if (url.pathname === "/v1/meta") {
    requireMethod(request, "GET");
    return json({
      ok: true,
      service: "voyager-api-dev",
      apiVersion: "v1",
      phase: "phase-1-control-plane"
    });
  }

  if (url.pathname === "/v1/admin/bootstrap/status") {
    requireMethod(request, "GET");
    const roles = await env.CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM account_admin_roles aar
       JOIN admin_roles ar ON ar.role_id = aar.role_id
       WHERE aar.revoked_at IS NULL AND ar.name = 'platform_owner'`
    ).first<{ count: number }>();
    return json({ ok: true, bootstrapped: (roles?.count ?? 0) > 0, bootstrapConfigured: Boolean(env.BOOTSTRAP_TOKEN) });
  }

  if (url.pathname === "/v1/admin/bootstrap") {
    requireMethod(request, "POST");
    if (!env.BOOTSTRAP_TOKEN) {
      throw new HttpError(503, "bootstrap_unconfigured", "BOOTSTRAP_TOKEN secret is not configured");
    }
    if (request.headers.get("x-bootstrap-token") !== env.BOOTSTRAP_TOKEN) {
      throw new HttpError(401, "unauthorized", "Invalid bootstrap token");
    }
    const body = await readJsonObject(request);
    const result = await bootstrapAdmin(env, {
      displayName: stringField(body, "displayName", { required: true, min: 2, max: 120 })!,
      email: stringField(body, "email", { required: true, max: 254, pattern: EMAIL_PATTERN })!,
      password: stringField(body, "password", { required: true, min: 14, max: 512 })!,
      device: optionalObject(body, "device") ?? {}
    });
    await audit(env, {
      actorAccountId: result.account.account_id,
      actorAdminRole: "platform_owner",
      action: "admin.bootstrap",
      targetType: "account",
      targetId: result.account.account_id,
      requestId,
      result: "success"
    });
    return json(await authResultPayload(env, result), { status: 201 });
  }

  if (url.pathname === "/v1/invitations/accept") {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const result = await acceptInvitation(env, {
      token: stringField(body, "token", { required: true, min: 20, max: 256 })!,
      password: stringField(body, "password", { required: true, min: 14, max: 512 })!,
      device: optionalObject(body, "device") ?? {}
    });
    await audit(env, {
      actorAccountId: result.account.account_id,
      action: "invitation.accept",
      targetType: "account",
      targetId: result.account.account_id,
      requestId,
      result: "success"
    });
    return json(await authResultPayload(env, result), { status: 201 });
  }

  if (url.pathname === "/v1/auth/password/login") {
    const routeStartedAt = performance.now();
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const email = stringField(body, "email", { required: true, max: 254, pattern: EMAIL_PATTERN })!;
    const rateLimitStartedAt = performance.now();
    await checkRateLimit(env, { key: `password-login:${email.toLowerCase()}:${clientIp(request)}`, action: "password-login", limit: 12, windowSeconds: 15 * 60 });
    const rateLimitMs = durationSince(rateLimitStartedAt);
    const result = await loginWithPassword(env, {
      email,
      password: stringField(body, "password", { required: true, min: 1, max: 512 })!,
      device: optionalObject(body, "device") ?? {}
    });
    const auditStartedAt = performance.now();
    await audit(env, {
      actorAccountId: result.account.account_id,
      action: "auth.password.login",
      targetType: "account",
      targetId: result.account.account_id,
      requestId,
      result: "success"
    });
    const auditMs = durationSince(auditStartedAt);
    return json(await authResultPayload(env, result), {
      headers: {
        "server-timing": serverTimingHeader([
          ["login", durationSince(routeStartedAt)],
          ["rateLimit", rateLimitMs],
          ["account", result.metrics.accountMs],
          ["authenticator", result.metrics.authenticatorMs],
          ["passwordVerify", result.metrics.passwordVerifyMs],
          ["authenticatorTouch", result.metrics.authenticatorTouchMs],
          ["principal", result.metrics.principalMs],
          ["device", result.metrics.deviceMs],
          ["session", result.metrics.sessionMs],
          ["audit", auditMs]
        ])
      }
    });
  }

  if (url.pathname === "/v1/auth/password/reset/complete") {
    requireMethod(request, "POST");
    await checkRateLimit(env, { key: `credential-reset:${clientIp(request)}`, action: "credential-reset", limit: 10, windowSeconds: 15 * 60 });
    const body = await readJsonObject(request);
    const result = await completeCredentialReset(env, {
      token: stringField(body, "token", { required: true, min: 20, max: 256 })!,
      password: stringField(body, "password", { required: true, min: 14, max: 512 })!,
      device: optionalObject(body, "device") ?? {}
    });
    await audit(env, {
      actorAccountId: result.account.account_id,
      action: "auth.password.reset.complete",
      targetType: "account",
      targetId: result.account.account_id,
      requestId,
      result: "success"
    });
    return json(await authResultPayload(env, result), { status: 201 });
  }

  if (url.pathname === "/v1/calls/realtime") {
    requireMethod(request, "GET");
    throw new HttpError(
      410,
      "call_realtime_socket_retired",
      "Voyager call realtime socket is retired. Messaging Core owns call state and media negotiation.",
    );
  }

  const authStartedAt = performance.now();
  const auth = await getAuthContext(env, request);
  const authTimingMs = durationSince(authStartedAt);

  if (url.pathname === "/v1/calls/realtime/token") {
    requireMethod(request, "POST");
    throw new HttpError(
      410,
      "call_realtime_socket_retired",
      "Voyager call realtime token minting is retired. Use Messaging Core call routes for call state.",
    );
  }

  if (url.pathname === "/v1/messaging-core/realtime/token") {
    requireMethod(request, "POST");
    await checkRateLimit(env, {
      key: `realtime-token:${auth.account.account_id}:${auth.device.device_id}`,
      action: "realtime-token",
      limit: REALTIME_TOKEN_LIMIT,
      windowSeconds: REALTIME_TOKEN_WINDOW_SECONDS
    });
    return json({
      ok: true,
      ...(await fetchMessagingCoreRealtimeTokenProxy(env, messagingCoreIdentity(auth))),
    });
  }

  const messagingCoreBootstrapResponse = await handleMessagingCoreBootstrap(request, env, url, requestId, auth, authTimingMs);
  if (messagingCoreBootstrapResponse) {
    return messagingCoreBootstrapResponse;
  }

  const messagingCoreRoomCutoverResponse = await handleMessagingCoreRoomCutover(request, env, url, auth);
  if (messagingCoreRoomCutoverResponse) {
    return messagingCoreRoomCutoverResponse;
  }

  const messagingCoreMessageCutoverResponse = await handleMessagingCoreMessageCutover(request, env, url, auth);
  if (messagingCoreMessageCutoverResponse) {
    return messagingCoreMessageCutoverResponse;
  }

  const messagingCoreSyncCutoverResponse = await handleMessagingCoreSyncCutover(request, env, url, auth, authTimingMs);
  if (messagingCoreSyncCutoverResponse) {
    return messagingCoreSyncCutoverResponse;
  }

  const messagingCoreCallCutoverResponse = await handleMessagingCoreCallCutover(request, env, url, auth);
  if (messagingCoreCallCutoverResponse) {
    return messagingCoreCallCutoverResponse;
  }

  const backendFirstResponse = await handleBackendFirstRoutes(request, env, url, requestId, auth, authTimingMs);
  if (backendFirstResponse) {
    return backendFirstResponse;
  }

  if (url.pathname === "/v1/me") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      {
        ok: true,
        account: publicAccount(auth.account),
        principal: publicPrincipal(auth.principal),
        device: publicDevice(auth.device),
        roles: auth.roles,
        messagingCore: await createMessagingCoreSessionPayload(env, {
          account: auth.account,
          principal: auth.principal,
          device: auth.device,
          roles: auth.roles
        })
      },
      { headers: readTimingHeaders("me", authTimingMs, startedAt) }
    );
  }

  if (url.pathname === "/v1/auth/logout") {
    requireMethod(request, "POST");
    await revokeSession(env, auth.session.session_id, auth.account.account_id);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "auth.logout",
      targetType: "session",
      targetId: auth.session.session_id,
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/auth/password/change") {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    await changePassword(
      env,
      auth,
      stringField(body, "currentPassword", { required: true, min: 1, max: 512 })!,
      stringField(body, "newPassword", { required: true, min: 14, max: 512 })!
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "auth.password.change",
      targetType: "account",
      targetId: auth.account.account_id,
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/sessions") {
    requireMethod(request, "GET");
    return json({ ok: true, sessions: (await listSessions(env, auth.account.account_id)).map(publicSession) });
  }

  const sessionDeleteMatch = routeParams(/^\/v1\/sessions\/([^/]+)$/, url.pathname);
  if (sessionDeleteMatch) {
    requireMethod(request, "DELETE");
    await revokeSession(env, sessionDeleteMatch[1], auth.account.account_id);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "session.revoke",
      targetType: "session",
      targetId: sessionDeleteMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/devices") {
    if (request.method === "GET") {
      return json({ ok: true, devices: (await listDevices(env, auth.account.account_id)).map(publicDevice) });
    }
    if (request.method === "POST") {
      const body = await readJsonObject(request);
      const device = await createDeviceForPrincipal(env, auth.account.account_id, auth.principal.principal_id, body as DeviceInput);
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "device.create",
        targetType: "device",
        targetId: device.device_id,
        requestId,
        result: "success"
      });
      return json({ ok: true, device: publicDevice(device) }, { status: 201 });
    }
  }

  const deviceRevokeMatch = routeParams(/^\/v1\/devices\/([^/]+)\/revoke$/, url.pathname);
  if (deviceRevokeMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    await revokeOwnDevice(env, auth.account.account_id, deviceRevokeMatch[1], stringField(body, "reason", { max: 120 }) ?? "user_requested");
    await revokeMessagingCoreDevice(env, deviceRevokeMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.revoke",
      targetType: "device",
      targetId: deviceRevokeMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/invitations") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["user_admin", "security_admin"]);
    const body = await readJsonObject(request);
    const invitation = await createInvitation(env, {
      displayName: stringField(body, "displayName", { required: true, min: 2, max: 120 })!,
      email: stringField(body, "email", { max: 254, pattern: EMAIL_PATTERN }),
      phone: stringField(body, "phone", { max: 40 }),
      policyId: stringField(body, "policyId", { max: 80 }),
      expiresInDays: numberField(body, "expiresInDays", 1, 30),
      createdByAccountId: auth.account.account_id
    });
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.invitation.create",
      targetType: "account",
      targetId: invitation.account.account_id,
      requestId,
      result: "success"
    });
    return json(
      {
        ok: true,
        account: publicAccount(invitation.account),
        invitationId: invitation.invitationId,
        activationToken: invitation.activationToken,
        expiresAt: invitation.expiresAt
      },
      { status: 201 }
    );
  }

  if (url.pathname === "/v1/admin/accounts") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["user_admin", "security_admin", "auditor"]);
    return json({ ok: true, accounts: (await listAccounts(env)).map(publicAccount) });
  }

  if (url.pathname === "/v1/admin/devices/test-cleanup") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["platform_owner"]);
    const body = await readJsonObject(request);
    const dryRun = body.dryRun === undefined ? true : booleanField(body, "dryRun");
    const labelMatchers = stringArrayField(body, "labelMatchers", { maxItems: 20, maxLength: 80 });
    const platformMatchers = stringArrayField(body, "platformMatchers", { maxItems: 20, maxLength: 32 });
    const cleanup = await cleanupTestDevices(env, auth, {
      dryRun,
      accountEmails: stringArrayField(body, "accountEmails", { maxItems: 50, maxLength: 254, pattern: EMAIL_PATTERN }).map((email) =>
        email.toLowerCase()
      ),
      labelMatchers: labelMatchers.length > 0 ? labelMatchers : DEFAULT_TEST_DEVICE_LABEL_MATCHERS,
      platformMatchers: platformMatchers.length > 0 ? platformMatchers : DEFAULT_TEST_DEVICE_PLATFORM_MATCHERS,
      includeKnownAppDevices: body.includeKnownAppDevices === undefined ? false : booleanField(body, "includeKnownAppDevices"),
      includeCurrentDevice: body.includeCurrentDevice === undefined ? false : booleanField(body, "includeCurrentDevice"),
      keepNewestPerAccount: numberField(body, "keepNewestPerAccount", 0, 20) ?? 1,
      reason: stringField(body, "reason", { max: 120 }) ?? "test_device_cleanup"
    });
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: dryRun ? "admin.device.test_cleanup.dry_run" : "admin.device.test_cleanup.apply",
      targetType: "device",
      targetId: null,
      requestId,
      result: "success",
      metadata: {
        scanned: cleanup.scanned,
        matched: cleanup.matched,
        revoked: cleanup.revoked,
        includeKnownAppDevices: body.includeKnownAppDevices === true
      }
    });
    return json({ ok: true, cleanup });
  }

  const adminAccountAction = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/(suspend|restore|require-auth-reset)$/, url.pathname);
  if (adminAccountAction) {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["user_admin", "security_admin"]);
    const [, accountId, action] = adminAccountAction;
    await assertCanAdministerAccount(env, auth, accountId);
    const account =
      action === "suspend"
        ? await setAccountStatus(env, accountId, "suspended")
        : action === "restore"
          ? await setAccountStatus(env, accountId, "active")
          : await requireAuthReset(env, accountId);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: `admin.account.${action}`,
      targetType: "account",
      targetId: accountId,
      requestId,
      result: "success"
    });
    return json({ ok: true, account: publicAccount(account) });
  }

  const adminCredentialReset = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/credential-reset$/, url.pathname);
  if (adminCredentialReset) {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["user_admin", "security_admin"]);
    const body = await readJsonObject(request);
    if (adminCredentialReset[1] === auth.account.account_id) {
      throw new HttpError(409, "self_admin_reset_not_allowed", "Use password change instead of admin reset for the current account");
    }
    await assertCanAdministerAccount(env, auth, adminCredentialReset[1]);
    const reset = await createCredentialReset(env, {
      accountId: adminCredentialReset[1],
      createdByAccountId: auth.account.account_id,
      reason: stringField(body, "reason", { max: 240 }),
      expiresInDays: numberField(body, "expiresInDays", 1, 14),
      revokeDevices: body.revokeDevices === undefined ? true : booleanField(body, "revokeDevices")
    });
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.account.credential_reset.create",
      targetType: "account",
      targetId: adminCredentialReset[1],
      requestId,
      result: "success",
      metadata: { resetId: reset.resetId }
    });
    return json(
      {
        ok: true,
        account: publicAccount(reset.account),
        resetId: reset.resetId,
        resetToken: reset.resetToken,
        expiresAt: reset.expiresAt
      },
      { status: 201 }
    );
  }

  const adminPolicyPatch = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/policy$/, url.pathname);
  if (adminPolicyPatch) {
    requireMethod(request, "PATCH");
    const adminRole = requireAdmin(auth, ["user_admin", "quota_operator", "security_admin"]);
    const body = await readJsonObject(request);
    await assertCanAdministerAccount(env, auth, adminPolicyPatch[1]);
    const account = await updateAccountPolicy(env, adminPolicyPatch[1], stringField(body, "policyId", { required: true, max: 80 })!);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.account.policy.update",
      targetType: "account",
      targetId: adminPolicyPatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true, account: publicAccount(account) });
  }

  const adminRolePost = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/roles$/, url.pathname);
  if (adminRolePost) {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["security_admin"]);
    const body = await readJsonObject(request);
    const roles = await grantAdminRoleToAccount(env, auth, adminRolePost[1], stringField(body, "roleName", { required: true, max: 80 })!);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.account.role.grant",
      targetType: "account",
      targetId: adminRolePost[1],
      requestId,
      result: "success"
    });
    return json({ ok: true, roles });
  }

  const adminRoleDelete = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/roles\/([^/]+)$/, url.pathname);
  if (adminRoleDelete) {
    requireMethod(request, "DELETE");
    const adminRole = requireAdmin(auth, ["security_admin"]);
    const roles = await revokeAdminRoleFromAccount(env, auth, adminRoleDelete[1], decodeURIComponent(adminRoleDelete[2]));
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.account.role.revoke",
      targetType: "account",
      targetId: adminRoleDelete[1],
      requestId,
      result: "success"
    });
    return json({ ok: true, roles });
  }

  if (url.pathname === "/v1/admin/policies") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["user_admin", "quota_operator", "security_admin", "auditor"]);
    return json({ ok: true, policies: await listPolicies(env) });
  }

  if (url.pathname === "/v1/admin/usage") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["quota_operator", "security_admin", "auditor"]);
    return json({ ok: true, usage: await getCoreOnlyUsage(env) });
  }

  if (url.pathname === "/v1/admin/calls/realtime-status") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["quota_operator", "security_admin", "auditor"]);
    return json({ ok: true, realtime: await fetchMessagingCoreCallRealtimeStatus(env) });
  }

  if (url.pathname === "/v1/admin/audit-events") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["auditor", "security_admin"]);
    return json({ ok: true, auditEvents: await getAuditEvents(env) });
  }

  throw new HttpError(404, "not_found", "Route not found");
}

async function getCoreOnlyUsage(env: Env): Promise<Record<string, unknown>> {
  const usage = await getUsage(env);
  const attachmentUsage = await fetchMessagingCoreAttachmentUsage(env);
  if (!attachmentUsage) return usage;
  const activeAttachmentCount = typeof attachmentUsage.activeAttachmentCount === "number"
    ? attachmentUsage.activeAttachmentCount
    : usage.attachments;
  return {
    ...usage,
    attachments: activeAttachmentCount,
    attachmentBytes: {
      activeExpectedBytes: attachmentUsage.activeExpectedBytes,
      allocatedExpectedBytesLast24h: attachmentUsage.allocatedExpectedBytesLast24h,
      uploadedStoredBytes: attachmentUsage.uploadedStoredBytes,
    },
  };
}

function publicPrincipal(principal: PrincipalRow) {
  return {
    principalId: principal.principal_id,
    accountId: principal.account_id,
    principalType: principal.principal_type,
    displayName: principal.display_name,
    status: principal.status,
    createdAt: principal.created_at
  };
}

function publicDevice(device: DeviceRow) {
  return {
    deviceId: device.device_id,
    accountId: device.account_id,
    principalId: device.principal_id,
    platform: device.platform,
    label: device.device_label,
    credentialFingerprint: device.credential_fingerprint,
    credentialVersion: device.credential_version,
    notificationCapability: device.notification_capability,
    clientVersion: device.client_version,
    protocolVersion: device.protocol_version,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
    revocationReason: device.revocation_reason
  };
}

function publicSession(session: SessionRow) {
  return {
    sessionId: session.session_id,
    accountId: session.account_id,
    deviceId: session.device_id,
    createdAt: session.created_at,
    expiresAt: session.expires_at,
    lastUsedAt: session.last_used_at,
    revokedAt: session.revoked_at,
    riskState: session.risk_state
  };
}

async function authResultPayload(
  env: Env,
  result: {
    account: AuthContext["account"];
    principal: AuthContext["principal"];
    device: AuthContext["device"];
    sessionToken: string;
  },
) {
  const roles = await getActiveAdminRoles(env, result.account.account_id);
  return {
    ok: true,
    account: publicAccount(result.account),
    principal: publicPrincipal(result.principal),
    device: publicDevice(result.device),
    sessionToken: result.sessionToken,
    messagingCore: await createMessagingCoreSessionPayload(env, {
      account: result.account,
      principal: result.principal,
      device: result.device,
      roles,
    }),
  };
}

function numberField(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, "invalid_field", `Field must be an integer between ${min} and ${max}: ${key}`);
  }
  return value;
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_field", `Field must be a boolean: ${key}`);
  }
  return value;
}

function stringArrayField(
  body: Record<string, unknown>,
  key: string,
  options: { maxItems: number; maxLength: number; pattern?: RegExp }
): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > options.maxItems) {
    throw new HttpError(400, "invalid_field", `Field must be an array with at most ${options.maxItems} items: ${key}`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new HttpError(400, "invalid_field", `Field item must be a string: ${key}[${index}]`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > options.maxLength) {
      throw new HttpError(400, "invalid_field", `Field item is invalid: ${key}[${index}]`);
    }
    if (options.pattern && !options.pattern.test(trimmed)) {
      throw new HttpError(400, "invalid_field", `Field item is invalid: ${key}[${index}]`);
    }
    return trimmed;
  });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

async function handleMessagingCoreBootstrap(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  auth: AuthContext,
  authTimingMs: number,
): Promise<Response | null> {
  if (url.pathname !== "/v1/app/bootstrap") return null;
  requireMethod(request, "GET");
  const startedAt = performance.now();
  const syncStartedAt = performance.now();
  const result = await fetchMessagingCoreSyncCutoverProxy(
    env,
    messagingCoreIdentity(auth),
    proxyQuery(url, ["limit"]),
  );
  const syncMs = durationSince(syncStartedAt);
  const sync = result.payload.sync;
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) {
    throw new HttpError(
      502,
      "messaging_core_proxy_invalid_response",
      "Messaging Core sync response is missing the expected bootstrap payload.",
    );
  }
  const syncPayload = sync as Record<string, unknown>;
  const rooms = Array.isArray(syncPayload.rooms) ? syncPayload.rooms : [];
  const pendingMessages = Array.isArray(syncPayload.pendingMessages) ? syncPayload.pendingMessages : [];
  const serverTime = typeof syncPayload.serverTime === "string" ? syncPayload.serverTime : new Date().toISOString();
  const roomsNextCursor = typeof syncPayload.roomsNextCursor === "string" ? syncPayload.roomsNextCursor : null;
  return json(
    {
      ok: true,
      bootstrap: {
        account: publicAccount(auth.account),
        principal: publicPrincipal(auth.principal),
        device: publicDevice(auth.device),
        roles: auth.roles,
        rooms,
        roomsNextCursor,
        pendingMessages,
        serverTime,
        requestId,
      },
      messagingCoreCutover: result.payload.messagingCoreCutover,
    },
    {
      status: result.status,
      headers: readTimingHeaders("bootstrap", authTimingMs, startedAt, [
        ["rooms", syncMs],
        ["messages", 0],
      ]),
    },
  );
}

async function handleMessagingCoreRoomCutover(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthContext,
): Promise<Response | null> {
  const startedAt = performance.now();
  const route = await messagingCoreRoomCutoverRoute(request, env, url);
  if (!route) return null;

  const result = await fetchMessagingCoreRoomCutoverProxy(
    env,
    messagingCoreIdentity(auth),
    route.method,
    route.path,
    {
      body: route.body,
      query: route.query,
      responseKind: route.responseKind,
      memberPrincipalId: route.memberPrincipalId,
    },
  );
  return json(result.payload, {
    status: result.status,
    headers: coreProxyTimingHeaders(messagingCoreRoomTimingMetric(route), startedAt),
  });
}

async function messagingCoreRoomCutoverRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<{
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  responseKind: "rooms" | "room" | "member" | "invitation" | "invitations" | "transfer" | "ok";
  memberPrincipalId?: string;
} | null> {
  if (url.pathname === "/v1/rooms" && request.method === "GET") {
    return { method: "GET", path: "/rooms", query: proxyQuery(url, ["limit", "cursor"]), responseKind: "rooms" };
  }

  if (url.pathname === "/v1/rooms/direct" && request.method === "POST") {
    return {
      method: "POST",
      path: "/rooms/direct",
      body: await messagingCoreDirectRoomBody(env, await readJsonObject(request)),
      responseKind: "room",
    };
  }

  if (url.pathname === "/v1/rooms/groups" && request.method === "POST") {
    return {
      method: "POST",
      path: "/rooms/groups",
      body: messagingCoreGroupRoomBody(await readJsonObject(request)),
      responseKind: "room",
    };
  }

  const roomMatch = routeParams(/^\/v1\/rooms\/([^/]+)$/, url.pathname);
  if (roomMatch) {
    if (request.method === "GET") {
      return { method: "GET", path: `/rooms/${roomMatch[1]}`, responseKind: "room" };
    }
    if (request.method === "PATCH") {
      return {
        method: "PATCH",
        path: `/rooms/${roomMatch[1]}`,
        body: messagingCoreRoomPatchBody(await readJsonObject(request)),
        responseKind: "room",
      };
    }
  }

  const roomArchiveMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/archive$/, url.pathname);
  if (request.method === "POST" && roomArchiveMatch) {
    return { method: "POST", path: `/rooms/${roomArchiveMatch[1]}/archive`, responseKind: "room" };
  }

  const roomMembersMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members$/, url.pathname);
  if (request.method === "POST" && roomMembersMatch) {
    const body = await messagingCoreMemberAddBody(env, await readJsonObject(request));
    const principalId = requiredMessagingCoreBodyString(body, "principalId");
    return {
      method: "POST",
      path: `/rooms/${roomMembersMatch[1]}/members`,
      body,
      responseKind: "member",
      memberPrincipalId: principalId,
    };
  }

  const roomInvitationsMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/invitations$/, url.pathname);
  if (request.method === "POST" && roomInvitationsMatch) {
    return {
      method: "POST",
      path: `/rooms/${roomInvitationsMatch[1]}/invitations`,
      body: await messagingCoreInvitationBody(env, await readJsonObject(request)),
      responseKind: "invitation",
    };
  }

  if (url.pathname === "/v1/room-invitations" && request.method === "GET") {
    return { method: "GET", path: "/room-invitations", responseKind: "invitations" };
  }

  const roomInvitationActionMatch = routeParams(/^\/v1\/room-invitations\/([^/]+)\/(accept|decline)$/, url.pathname);
  if (request.method === "POST" && roomInvitationActionMatch) {
    return {
      method: "POST",
      path: `/room-invitations/${roomInvitationActionMatch[1]}/${roomInvitationActionMatch[2]}`,
      responseKind: "invitation",
    };
  }

  const roomMemberRoleMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members\/([^/]+)\/role$/, url.pathname);
  if (request.method === "PATCH" && roomMemberRoleMatch) {
    return {
      method: "PATCH",
      path: `/rooms/${roomMemberRoleMatch[1]}/members/${roomMemberRoleMatch[2]}/role`,
      body: await messagingCoreMemberRoleBody(env, roomMemberRoleMatch[2], await readJsonObject(request)),
      responseKind: "member",
      memberPrincipalId: roomMemberRoleMatch[2],
    };
  }

  const roomMemberRemoveMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members\/([^/]+)$/, url.pathname);
  if (request.method === "DELETE" && roomMemberRemoveMatch) {
    return {
      method: "DELETE",
      path: `/rooms/${roomMemberRemoveMatch[1]}/members/${roomMemberRemoveMatch[2]}`,
      responseKind: "ok",
    };
  }

  const leaveRoomMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/leave$/, url.pathname);
  if (request.method === "POST" && leaveRoomMatch) {
    return { method: "POST", path: `/rooms/${leaveRoomMatch[1]}/leave`, responseKind: "ok" };
  }

  const proposeTransferMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/ownership-transfers$/, url.pathname);
  if (request.method === "POST" && proposeTransferMatch) {
    return {
      method: "POST",
      path: `/rooms/${proposeTransferMatch[1]}/ownership-transfers`,
      body: await messagingCoreOwnershipTransferBody(env, await readJsonObject(request)),
      responseKind: "transfer",
    };
  }

  const acceptTransferMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/ownership-transfers\/([^/]+)\/accept$/, url.pathname);
  if (request.method === "POST" && acceptTransferMatch) {
    return {
      method: "POST",
      path: `/rooms/${acceptTransferMatch[1]}/ownership-transfers/${acceptTransferMatch[2]}/accept`,
      responseKind: "transfer",
    };
  }

  return null;
}

async function messagingCoreDirectRoomBody(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const principalIds = stringArrayField(body, "principalIds", { maxItems: 1, maxLength: 128 });
  if (principalIds.length !== 1) {
    throw new HttpError(
      400,
      "invalid_direct_room",
      "Direct rooms require exactly two principals",
    );
  }
  await syncMessagingCorePrincipal(env, principalIds[0]);
  return {
    principalId: principalIds[0],
    title: optionalMessagingCoreBodyString(body, "name", { maxLength: 120 }),
    description: optionalMessagingCoreBodyString(body, "description", { maxLength: 1000 }),
  };
}

function messagingCoreGroupRoomBody(body: Record<string, unknown>): Record<string, unknown> {
  const memberPrincipalIds = stringArrayField(body, "memberPrincipalIds", { maxItems: 200, maxLength: 128 });
  if (memberPrincipalIds.length > 0) {
    throw new HttpError(
      400,
      "initial_group_members_not_supported",
      "Create the group first, then invite humans or add agents",
    );
  }
  return {
    title: requiredMessagingCoreBodyString(body, "name", { maxLength: 120 }),
    description: optionalMessagingCoreBodyString(body, "description", { maxLength: 1000 }),
  };
}

function messagingCoreRoomPatchBody(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.title = validateMessagingCoreString(body.name.trim(), "name", { maxLength: 120 });
  else if (body.name !== undefined && body.name !== null) {
    throw new HttpError(400, "invalid_field", "Field must be a string or null: name");
  }
  if (typeof body.description === "string") {
    patch.description = validateMessagingCoreString(body.description.trim(), "description", { maxLength: 1000 });
  } else if (body.description !== undefined && body.description !== null) {
    throw new HttpError(400, "invalid_field", "Field must be a string or null: description");
  }
  return patch;
}

function messagingCorePublicSendBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...body };
  delete sanitized.forwardedFromRoomId;
  delete sanitized.forwardedFromEnvelopeId;
  delete sanitized.forwardedFromSenderPrincipalId;
  delete sanitized.rootEnvelopeId;
  delete sanitized.threadRootEnvelopeId;
  delete sanitized.alsoSendToRoom;
  delete sanitized.alsoSentToRoom;
  delete sanitized.threadReply;
  return sanitized;
}

function messagingCoreDeleteMessagesBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    scope: body.scope === "me" ? "for_me" : body.scope,
  };
}

async function messagingCoreMemberAddBody(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const principalId = requiredMessagingCoreBodyString(body, "principalId");
  const principal = await loadActiveMessagingCoreCutoverPrincipal(env, principalId);
  if (principal.principal_type !== "agent") {
    throw new HttpError(
      400,
      "human_invitation_required",
      "Human principals must accept a room invitation",
    );
  }
  await syncMessagingCorePrincipal(env, principalId);
  return { principalId, role: "agent" };
}

async function messagingCoreMemberRoleBody(
  env: Env,
  principalId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const principal = await loadActiveMessagingCoreCutoverPrincipal(env, principalId);
  if (principal.principal_type === "agent") return { role: "agent" };
  const role = requiredMessagingCoreBodyString(body, "role", { maxLength: 20 });
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new HttpError(400, "invalid_room_role", "Room role is invalid");
  }
  return { role };
}

async function messagingCoreInvitationBody(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const principalId = requiredMessagingCoreBodyString(body, "principalId");
  const principal = await loadActiveMessagingCoreCutoverPrincipal(env, principalId);
  if (principal.principal_type !== "human") {
    throw new HttpError(
      400,
      "agent_invitation_not_supported",
      "Agent principals should be added directly by a room admin",
    );
  }
  await syncMessagingCorePrincipal(env, principalId);
  return {
    principalId,
    role: optionalMessagingCoreInvitationRole(body),
    expiresAt: messagingCoreInvitationExpiresAt(body.expiresInDays),
  };
}

async function messagingCoreOwnershipTransferBody(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const toPrincipalId = requiredMessagingCoreBodyString(body, "toPrincipalId");
  const principal = await loadActiveMessagingCoreCutoverPrincipal(env, toPrincipalId);
  if (principal.principal_type !== "human") {
    throw new HttpError(
      400,
      "invalid_owner_target",
      "Ownership can only transfer to an active human room member",
    );
  }
  await syncMessagingCorePrincipal(env, toPrincipalId);
  return {
    toPrincipalId,
    expiresAt: optionalMessagingCoreBodyString(body, "expiresAt"),
  };
}

async function loadActiveMessagingCoreCutoverPrincipal(env: Env, principalId: string): Promise<PrincipalRow> {
  const principal = await env.CONTROL_DB.prepare(
    `SELECT p.principal_id, p.account_id, p.principal_type, p.display_name, p.avatar_ref,
            p.status, p.owner_principal_id, p.created_at, p.revoked_at
     FROM principals p
     JOIN accounts a ON a.account_id = p.account_id
     WHERE p.principal_id = ?
       AND p.status = 'active'
       AND a.status = 'active'`,
  )
    .bind(principalId)
    .first<PrincipalRow>();
  if (!principal) {
    throw new HttpError(404, "principal_not_found", "Active principal not found");
  }
  return principal;
}

function optionalMessagingCoreInvitationRole(body: Record<string, unknown>): string {
  const role = optionalMessagingCoreBodyString(body, "role", { maxLength: 20 }) ?? "member";
  if (role !== "admin" && role !== "member") {
    throw new HttpError(400, "invalid_room_invitation_role", "Room invitation role must be admin or member");
  }
  return role;
}

function messagingCoreInvitationExpiresAt(value: unknown): string {
  const days = typeof value === "number" && Number.isFinite(value)
    ? Math.min(30, Math.max(1, Math.trunc(value)))
    : ROOM_INVITATION_DAYS;
  return sqliteTimestamp(Date.now() + days * 24 * 60 * 60 * 1000);
}

function requiredMessagingCoreBodyString(
  body: Record<string, unknown>,
  key: string,
  options: { maxLength?: number } = {},
): string {
  const value = stringValue(body[key])?.trim();
  if (!value) {
    throw new HttpError(400, "invalid_field", `Field is required: ${key}`);
  }
  return validateMessagingCoreString(value, key, options);
}

function optionalMessagingCoreBodyString(
  body: Record<string, unknown>,
  key: string,
  options: { maxLength?: number } = {},
): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `Field must be a string or null: ${key}`);
  }
  const string = value.trim();
  return string ? validateMessagingCoreString(string, key, options) : null;
}

function validateMessagingCoreString(
  value: string,
  key: string,
  options: { maxLength?: number },
): string {
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new HttpError(400, "invalid_field", `Field is too long: ${key}`);
  }
  return value;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function handleMessagingCoreMessageCutover(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthContext,
): Promise<Response | null> {
  const startedAt = performance.now();
  const route = await messagingCoreMessageCutoverRoute(request, url);
  if (!route) return null;

  if (route.kind !== "json") {
    if (route.kind === "attachmentUpload") {
      const result = await fetchMessagingCoreAttachmentUploadCutoverProxy(
        env,
        messagingCoreIdentity(auth),
        route.path,
        request,
        route.query,
      );
      return json(result.payload, {
        status: result.status,
        headers: coreProxyTimingHeaders("attachmentUpload", startedAt),
      });
    }

    return fetchMessagingCoreAttachmentDownloadCutoverProxy(
      env,
      messagingCoreIdentity(auth),
      route.path,
      route.query,
    );
  }

  const result = await fetchMessagingCoreMessageCutoverProxy(
    env,
    messagingCoreIdentity(auth),
    route.method,
    route.path,
    {
      body: route.body,
      query: route.query,
      responseKind: route.responseKind,
      roomId: route.roomId,
    },
  );
  return json(result.payload, {
    status: result.status,
    headers: coreProxyTimingHeaders(messagingCoreMessageTimingMetric(route), startedAt),
  });
}

async function messagingCoreMessageCutoverRoute(
  request: Request,
  url: URL,
): Promise<
  | {
      kind: "json";
      method: "GET" | "POST" | "PATCH" | "DELETE";
      path: string;
      query?: URLSearchParams;
      body?: Record<string, unknown>;
      responseKind: "messages" | "message" | "deleted" | "receipt" | "thread" | "threads" | "threadState" | "attachment" | "ok";
      roomId?: string;
    }
  | {
      kind: "attachmentUpload" | "attachmentDownload";
      path: string;
      query?: URLSearchParams;
    }
  | null
> {
  if (request.method === "GET" && url.pathname === "/v1/threads") {
    return {
      kind: "json",
      method: "GET",
      path: "/threads",
      query: proxyQuery(url, ["limit", "cursor"]),
      responseKind: "threads",
    };
  }

  const allocateAttachmentMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/attachments$/, url.pathname);
  if (request.method === "POST" && allocateAttachmentMatch) {
    return {
      kind: "json",
      method: "POST",
      path: `/rooms/${allocateAttachmentMatch[1]}/attachments`,
      body: messagingCoreAttachmentAllocateBody(await readJsonObject(request)),
      responseKind: "attachment",
    };
  }

  const attachmentBlobMatch = routeParams(/^\/v1\/attachments\/([^/]+)\/blob$/, url.pathname);
  if (attachmentBlobMatch) {
    const path = `/attachments/${attachmentBlobMatch[1]}/blob`;
    const query = proxyQuery(url, ["variant"]);
    if (request.method === "PUT") {
      return { kind: "attachmentUpload", path, query };
    }
    if (request.method === "GET") {
      return { kind: "attachmentDownload", path, query };
    }
  }

  const completeAttachmentMatch = routeParams(/^\/v1\/attachments\/([^/]+)\/complete$/, url.pathname);
  if (request.method === "POST" && completeAttachmentMatch) {
    return {
      kind: "json",
      method: "POST",
      path: `/attachments/${completeAttachmentMatch[1]}/complete`,
      body: messagingCoreAttachmentCompleteBody(await readJsonObject(request)),
      responseKind: "attachment",
    };
  }

  const attachmentMatch = routeParams(/^\/v1\/attachments\/([^/]+)$/, url.pathname);
  if (request.method === "DELETE" && attachmentMatch) {
    return {
      kind: "json",
      method: "DELETE",
      path: `/attachments/${attachmentMatch[1]}`,
      responseKind: "ok",
    };
  }

  const messagesMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages$/, url.pathname);
  if (messagesMatch) {
    const roomPath = `/rooms/${messagesMatch[1]}/messages`;
    if (request.method === "GET") {
      return {
        kind: "json",
        method: "GET",
        path: roomPath,
        query: proxyQuery(url, ["after", "limit"]),
        responseKind: "messages",
      };
    }
    if (request.method === "POST") {
      const body = await readJsonObject(request);
      return { kind: "json", method: "POST", path: roomPath, body: messagingCorePublicSendBody(body), responseKind: "message" };
    }
  }

  const deleteMessagesMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/delete$/, url.pathname);
  if (request.method === "POST" && deleteMessagesMatch) {
    return {
      kind: "json",
      method: "POST",
      path: `/rooms/${deleteMessagesMatch[1]}/messages/delete`,
      body: messagingCoreDeleteMessagesBody(await readJsonObject(request)),
      responseKind: "deleted",
    };
  }

  const messageMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)$/, url.pathname);
  if (request.method === "PATCH" && messageMatch) {
    const body = await readJsonObject(request);
    return {
      kind: "json",
      method: "PATCH",
      path: `/rooms/${messageMatch[1]}/messages/${messageMatch[2]}`,
      body,
      responseKind: "message",
    };
  }

  const messageForwardMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/forward$/, url.pathname);
  if (request.method === "POST" && messageForwardMatch) {
    const body = await readJsonObject(request);
    return {
      kind: "json",
      method: "POST",
      path: `/rooms/${messageForwardMatch[1]}/messages/${messageForwardMatch[2]}/forward`,
      body,
      responseKind: "message",
    };
  }

  const messageReactionsMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions$/, url.pathname);
  if (request.method === "POST" && messageReactionsMatch) {
    return {
      kind: "json",
      method: "POST",
      path: `/rooms/${messageReactionsMatch[1]}/messages/${messageReactionsMatch[2]}/reactions`,
      body: await readJsonObject(request),
      responseKind: "message",
    };
  }

  const messageReactionDeleteMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/, url.pathname);
  if (request.method === "DELETE" && messageReactionDeleteMatch) {
    return {
      kind: "json",
      method: "DELETE",
      path: `/rooms/${messageReactionDeleteMatch[1]}/messages/${messageReactionDeleteMatch[2]}/reactions/${messageReactionDeleteMatch[3]}`,
      responseKind: "message",
    };
  }

  const messagePinMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/pin$/, url.pathname);
  if ((request.method === "POST" || request.method === "DELETE") && messagePinMatch) {
    return {
      kind: "json",
      method: request.method,
      path: `/rooms/${messagePinMatch[1]}/messages/${messagePinMatch[2]}/pin`,
      responseKind: "message",
    };
  }

  const ackMessageMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/ack$/, url.pathname);
  if (request.method === "POST" && ackMessageMatch) {
    return {
      kind: "json",
      method: "POST",
      path: `/rooms/${ackMessageMatch[1]}/messages/${ackMessageMatch[2]}/ack`,
      body: await readJsonObject(request),
      responseKind: "receipt",
      roomId: ackMessageMatch[1],
    };
  }

  const threadMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread$/, url.pathname);
  if (threadMatch) {
    const threadPath = `/rooms/${threadMatch[1]}/messages/${threadMatch[2]}/thread`;
    if (request.method === "GET") {
      return {
        kind: "json",
        method: "GET",
        path: threadPath,
        query: proxyQuery(url, ["after", "before", "limit"]),
        responseKind: "thread",
      };
    }
    if (request.method === "POST") {
      const body = await readJsonObject(request);
      return {
        kind: "json",
        method: "POST",
        path: threadPath,
        body,
        responseKind: "message",
      };
    }
  }

  const threadReadMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread\/read$/, url.pathname);
  if (request.method === "POST" && threadReadMatch) {
    return {
      kind: "json",
      method: "POST",
      path: `/rooms/${threadReadMatch[1]}/messages/${threadReadMatch[2]}/thread/read`,
      responseKind: "threadState",
      roomId: threadReadMatch[1],
    };
  }

  const threadSubscriptionMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread\/subscription$/, url.pathname);
  if (request.method === "PATCH" && threadSubscriptionMatch) {
    return {
      kind: "json",
      method: "PATCH",
      path: `/rooms/${threadSubscriptionMatch[1]}/messages/${threadSubscriptionMatch[2]}/thread/subscription`,
      body: await readJsonObject(request),
      responseKind: "threadState",
      roomId: threadSubscriptionMatch[1],
    };
  }

  return null;
}

async function handleMessagingCoreSyncCutover(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthContext,
  authTimingMs: number,
): Promise<Response | null> {
  if (url.pathname !== "/v1/sync") return null;
  requireMethod(request, "GET");
  const startedAt = performance.now();
  const result = await fetchMessagingCoreSyncCutoverProxy(
    env,
    messagingCoreIdentity(auth),
    proxyQuery(url, ["limit"]),
  );
  return json(result.payload, {
    status: result.status,
    headers: readTimingHeaders("messagingCoreSync", authTimingMs, startedAt),
  });
}

async function handleMessagingCoreCallCutover(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthContext,
): Promise<Response | null> {
  const startedAt = performance.now();
  const route = await messagingCoreCallCutoverRoute(request, url);
  if (!route) return null;

  const result = await fetchMessagingCoreCallCutoverProxy(
    env,
    messagingCoreIdentity(auth),
    route.method,
    route.path,
    {
      body: route.body,
      query: route.query,
      responseKind: route.responseKind,
    },
  );
  return json(result.payload, {
    status: result.status,
    headers: coreProxyTimingHeaders(messagingCoreCallTimingMetric(route), startedAt),
  });
}

async function messagingCoreCallCutoverRoute(
  request: Request,
  url: URL,
): Promise<{
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  responseKind: "calls" | "call" | "realtime" | "usageReport";
} | null> {
  const roomCallsMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/calls$/, url.pathname);
  if (roomCallsMatch) {
    if (request.method === "GET") {
      return {
        method: "GET",
        path: `/rooms/${roomCallsMatch[1]}/calls`,
        query: proxyQuery(url, ["limit", "cursor"]),
        responseKind: "calls",
      };
    }
    if (request.method === "POST") {
      return {
        method: "POST",
        path: `/rooms/${roomCallsMatch[1]}/calls`,
        body: await readJsonObject(request),
        responseKind: "call",
      };
    }
  }

  const callUsageReportMatch = routeParams(/^\/v1\/calls\/([^/]+)\/usage-report$/, url.pathname);
  if (callUsageReportMatch) {
    requireMethod(request, "POST");
    return {
      method: "POST",
      path: `/calls/${callUsageReportMatch[1]}/usage-report`,
      body: await readJsonObject(request),
      responseKind: "usageReport",
    };
  }

  const callRealtimeRenegotiateMatch = routeParams(/^\/v1\/calls\/([^/]+)\/realtime\/renegotiate$/, url.pathname);
  if (callRealtimeRenegotiateMatch) {
    requireMethod(request, "POST");
    return {
      method: "POST",
      path: `/calls/${callRealtimeRenegotiateMatch[1]}/realtime/renegotiate`,
      body: await readOptionalJsonObject(request),
      responseKind: "realtime",
    };
  }

  const callRealtimeCloseTracksMatch = routeParams(/^\/v1\/calls\/([^/]+)\/realtime\/tracks\/close$/, url.pathname);
  if (callRealtimeCloseTracksMatch) {
    requireMethod(request, "POST");
    return {
      method: "POST",
      path: `/calls/${callRealtimeCloseTracksMatch[1]}/realtime/tracks/close`,
      body: await readOptionalJsonObject(request),
      responseKind: "realtime",
    };
  }

  const callRealtimeMatch = routeParams(/^\/v1\/calls\/([^/]+)\/realtime\/(session|tracks)$/, url.pathname);
  if (callRealtimeMatch) {
    requireMethod(request, "POST");
    return {
      method: "POST",
      path: `/calls/${callRealtimeMatch[1]}/realtime/${callRealtimeMatch[2]}`,
      body: await readOptionalJsonObject(request),
      responseKind: "realtime",
    };
  }

  const callParticipantMatch = routeParams(/^\/v1\/calls\/([^/]+)\/participants\/me$/, url.pathname);
  if (callParticipantMatch) {
    requireMethod(request, "PATCH");
    return {
      method: "PATCH",
      path: `/calls/${callParticipantMatch[1]}/participants/me`,
      body: await readJsonObject(request),
      responseKind: "call",
    };
  }

  const callActionMatch = routeParams(/^\/v1\/calls\/([^/]+)\/(join|leave|decline|mute|unmute)$/, url.pathname);
  if (callActionMatch) {
    requireMethod(request, "POST");
    return {
      method: "POST",
      path: `/calls/${callActionMatch[1]}/${callActionMatch[2]}`,
      responseKind: "call",
    };
  }

  const callMatch = routeParams(/^\/v1\/calls\/([^/]+)$/, url.pathname);
  if (callMatch) {
    requireMethod(request, "GET");
    return {
      method: "GET",
      path: `/calls/${callMatch[1]}`,
      responseKind: "call",
    };
  }

  return null;
}

function messagingCoreRoomTimingMetric(route: { method: string; path: string; responseKind: string }): string {
  if (route.method === "PATCH" && /^\/rooms\/[^/]+$/.test(route.path)) return "roomUpdate";
  if (route.method === "POST" && route.path.endsWith("/archive")) return "roomArchive";
  if (route.method === "POST" && route.path.endsWith("/members")) return "roomMemberAdd";
  if (route.method === "PATCH" && route.path.endsWith("/role")) return "roomMemberRole";
  if (route.method === "DELETE" && /\/members\/[^/]+$/.test(route.path)) return "roomMemberRemove";
  if (route.method === "POST" && route.path.endsWith("/leave")) return "roomLeave";
  if (route.method === "POST" && route.path.endsWith("/invitations")) return "roomInvitation";
  if (route.method === "POST" && route.path.includes("/ownership-transfers")) return "roomOwnershipTransfer";
  if (route.method === "POST" && route.path === "/rooms/direct") return "roomDirectCreate";
  if (route.method === "POST" && route.path === "/rooms/groups") return "roomGroupCreate";
  return route.responseKind === "rooms" ? "rooms" : "room";
}

function messagingCoreCallTimingMetric(route: { method: string; path: string; responseKind: string }): string {
  if (route.responseKind === "calls") return "calls";
  if (route.responseKind === "realtime") return "callRealtime";
  if (route.responseKind === "usageReport") return "callUsageReport";
  if (route.path.endsWith("/join")) return "callJoin";
  if (route.path.endsWith("/leave")) return "callLeave";
  if (route.path.endsWith("/decline")) return "callDecline";
  if (route.path.endsWith("/mute")) return "callMute";
  if (route.path.endsWith("/unmute")) return "callUnmute";
  if (route.method === "POST" && /\/rooms\/[^/]+\/calls$/.test(route.path)) return "callCreate";
  if (route.method === "PATCH") return "callParticipantUpdate";
  return "call";
}

function messagingCoreMessageTimingMetric(route: { method: string; path: string; responseKind: string }): string {
  if (route.method === "POST" && /^\/rooms\/[^/]+\/messages$/.test(route.path)) return "message";
  if (route.method === "PATCH" && /^\/rooms\/[^/]+\/messages\/[^/]+$/.test(route.path)) return "messageEdit";
  if (route.method === "POST" && route.path.endsWith("/messages/delete")) return "messageDelete";
  if (route.method === "POST" && route.path.endsWith("/forward")) return "messageForward";
  if (route.path.includes("/thread")) return "thread";
  if (route.path.includes("/reactions")) return "messageReaction";
  if (route.path.endsWith("/pin")) return "messagePin";
  if (route.path.endsWith("/ack")) return "messageAck";
  return route.responseKind === "messages" ? "messages" : "message";
}

function coreProxyTimingHeaders(routeName: string, startedAt: number): Record<string, string> {
  const elapsedMs = durationSince(startedAt);
  const legacyMutationMetrics = ["conversationDo", "conversationQueue", "conversationOperation"];
  const legacyMessageMetrics = routeName === "message"
    ? ["context", "insert", "postwrite", "realtime"]
    : [];
  return {
    "server-timing": serverTimingHeader([
      [routeName, elapsedMs],
      ...legacyMutationMetrics.map((metric): [string, number] => [metric, 0]),
      ...legacyMessageMetrics.map((metric): [string, number] => [metric, 0]),
    ]),
  };
}

function readTimingHeaders(
  routeName: string,
  authMs: number,
  startedAt: number,
  extraMetrics: Array<[string, number]> = [],
): Record<string, string> {
  const readMs = durationSince(startedAt);
  return {
    "server-timing": serverTimingHeader([
      [routeName, authMs + readMs],
      ["auth", authMs],
      ["read", readMs],
      ...extraMetrics,
    ])
  };
}

function durationSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function messagingCoreIdentity(auth: AuthContext) {
  return {
    account: auth.account,
    principal: auth.principal,
    device: auth.device,
    roles: auth.roles
  };
}

function proxyQuery(url: URL, allowedKeys: string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    const value = url.searchParams.get(key);
    if (value !== null) params.set(key, value);
  }
  return params;
}

// CORS. The app authenticates with Bearer tokens (no cookies), so credentialed
// CORS is not needed and origins can be reflected safely. Dev hosts and the
// Tauri app origins are always allowed; production web origins come from the
// CORS_ALLOWED_ORIGINS env allowlist. Requests without an Origin (curl, the
// smoke suite, same-origin) are unaffected.
const DEV_ORIGIN_PATTERNS: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^https?:\/\/\d{1,3}(\.\d{1,3}){3}:1420$/i, // LAN dev server (TAURI_DEV_HOST)
  /^tauri:\/\/localhost$/i,
  /^https?:\/\/tauri\.localhost$/i
];

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (DEV_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) return true;
  const allowList = env.CORS_ALLOWED_ORIGINS;
  if (!allowList) return false;
  return allowList
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedOrigin(origin, env)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-bootstrap-token",
    "access-control-expose-headers": "Server-Timing",
    "access-control-max-age": "86400"
  };
}

function applyCors(response: Response, request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}
