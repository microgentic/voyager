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
import { randomId } from "./crypto";
import { errorResponse, HttpError, json, optionalObject, publicAccount, readJsonObject, requireMethod, routeParams, stringField } from "./http";
import { handleRealtimeConnect, REALTIME_PROTOCOL, RealtimeMailbox } from "./realtime";
import type { AuthContext, DeviceInput, DeviceRow, Env, PrincipalRow, SessionRow } from "./types";

export { RealtimeMailbox };

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
      r2: Boolean(env.ATTACHMENTS_BUCKET) ? "bound" : "missing",
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
    return json(
      {
        ok: true,
        account: publicAccount(result.account),
        principal: publicPrincipal(result.principal),
        device: publicDevice(result.device),
        sessionToken: result.sessionToken
      },
      { status: 201 }
    );
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
    return json(
      {
        ok: true,
        account: publicAccount(result.account),
        principal: publicPrincipal(result.principal),
        device: publicDevice(result.device),
        sessionToken: result.sessionToken
      },
      { status: 201 }
    );
  }

  if (url.pathname === "/v1/auth/password/login") {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const email = stringField(body, "email", { required: true, max: 254, pattern: EMAIL_PATTERN })!;
    await checkRateLimit(env, { key: `password-login:${email.toLowerCase()}:${clientIp(request)}`, action: "password-login", limit: 12, windowSeconds: 15 * 60 });
    const result = await loginWithPassword(env, {
      email,
      password: stringField(body, "password", { required: true, min: 1, max: 512 })!,
      device: optionalObject(body, "device") ?? {}
    });
    await audit(env, {
      actorAccountId: result.account.account_id,
      action: "auth.password.login",
      targetType: "account",
      targetId: result.account.account_id,
      requestId,
      result: "success"
    });
    return json({
      ok: true,
      account: publicAccount(result.account),
      principal: publicPrincipal(result.principal),
      device: publicDevice(result.device),
      sessionToken: result.sessionToken
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
    return json(
      {
        ok: true,
        account: publicAccount(result.account),
        principal: publicPrincipal(result.principal),
        device: publicDevice(result.device),
        sessionToken: result.sessionToken
      },
      { status: 201 }
    );
  }

  if (url.pathname === "/v1/realtime") {
    requireMethod(request, "GET");
    const origin = request.headers.get("origin");
    if (origin && !isAllowedOrigin(origin, env)) {
      throw new HttpError(403, "origin_not_allowed", "Realtime origin is not allowed");
    }
    const auth = await getRealtimeAuthContext(env, request);
    return handleRealtimeConnect(request, env, auth);
  }

  const auth = await getAuthContext(env, request);
  const backendFirstResponse = await handleBackendFirstRoutes(request, env, url, requestId, auth);
  if (backendFirstResponse) {
    return backendFirstResponse;
  }

  if (url.pathname === "/v1/me") {
    requireMethod(request, "GET");
    return json({ ok: true, account: publicAccount(auth.account), principal: publicPrincipal(auth.principal), device: publicDevice(auth.device), roles: auth.roles });
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
    return json({ ok: true, usage: await getUsage(env) });
  }

  if (url.pathname === "/v1/admin/audit-events") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["auditor", "security_admin"]);
    return json({ ok: true, auditEvents: await getAuditEvents(env) });
  }

  throw new HttpError(404, "not_found", "Route not found");
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

async function getRealtimeAuthContext(env: Env, request: Request): Promise<AuthContext> {
  const token = realtimeToken(request);
  if (!token) {
    throw new HttpError(401, "unauthorized", "Missing realtime token");
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return getAuthContext(env, new Request(request.url, { method: "GET", headers }));
}

function realtimeToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  return protocols.find((protocol) => protocol !== REALTIME_PROTOCOL && protocol.startsWith("vgr_")) ?? null;
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
