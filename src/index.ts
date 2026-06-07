import {
  acceptInvitation,
  audit,
  bootstrapAdmin,
  createDeviceForPrincipal,
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
  revokeDevice,
  revokeSession,
  setAccountStatus,
  updateAccountPolicy
} from "./db";
import { randomId } from "./crypto";
import { errorResponse, HttpError, json, optionalObject, publicAccount, readJsonObject, requireMethod, routeParams, stringField } from "./http";
import type { AuthContext, DeviceInput, DeviceRow, Env, PrincipalRow, SessionRow } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = randomId("req");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    try {
      return await handleRequest(request, env, url, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
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
    const result = await loginWithPassword(env, {
      email: stringField(body, "email", { required: true, max: 254, pattern: EMAIL_PATTERN })!,
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

  if (url.pathname.startsWith("/v1/auth/passkeys/")) {
    throw new HttpError(501, "passkey_not_implemented", "Passkey schema is reserved; WebAuthn verification is a Phase 1 follow-up before production use");
  }

  const auth = await getAuthContext(env, request);

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
    await revokeDevice(env, deviceRevokeMatch[1], stringField(body, "reason", { max: 120 }) ?? "user_requested");
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

  const adminAccountAction = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/(suspend|restore|require-auth-reset)$/, url.pathname);
  if (adminAccountAction) {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["user_admin", "security_admin"]);
    const [, accountId, action] = adminAccountAction;
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

  const adminPolicyPatch = routeParams(/^\/v1\/admin\/accounts\/([^/]+)\/policy$/, url.pathname);
  if (adminPolicyPatch) {
    requireMethod(request, "PATCH");
    const adminRole = requireAdmin(auth, ["user_admin", "quota_operator", "security_admin"]);
    const body = await readJsonObject(request);
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
    const roles = await grantAdminRoleToAccount(env, adminRolePost[1], stringField(body, "roleName", { required: true, max: 80 })!, auth.account.account_id);
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
    const roles = await revokeAdminRoleFromAccount(env, adminRoleDelete[1], decodeURIComponent(adminRoleDelete[2]));
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
