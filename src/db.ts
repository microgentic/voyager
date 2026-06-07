import { hashPassword, randomId, randomToken, sha256Base64Url, verifyPassword } from "./crypto";
import { HttpError } from "./http";
import type { AccountRow, AuthContext, DeviceInput, DeviceRow, Env, PolicyRow, PrincipalRow, SessionRow } from "./types";

const SESSION_DAYS = 30;
const INVITATION_DAYS = 7;
const CREDENTIAL_RESET_DAYS = 3;

export interface CredentialResetResult {
  account: AccountRow;
  resetId: string;
  resetToken: string;
  expiresAt: string;
}

export async function audit(
  env: Env,
  input: {
    actorAccountId?: string | null;
    actorAdminRole?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    requestId: string;
    sourceContext?: string | null;
    result: "success" | "failure";
    reasonCode?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO audit_events (
      event_id, actor_account_id, actor_admin_role, action, target_type, target_id,
      request_id, source_context, result, reason_code, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      randomId("aud"),
      input.actorAccountId ?? null,
      input.actorAdminRole ?? null,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.requestId,
      input.sourceContext ?? null,
      input.result,
      input.reasonCode ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    )
    .run();
}

export async function getAuthContext(env: Env, request: Request): Promise<AuthContext> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "Missing bearer token");
  }

  const tokenHash = await sha256Base64Url(auth.slice("Bearer ".length).trim());
  const row = await env.CONTROL_DB.prepare(
    `SELECT
      s.session_id, s.account_id AS session_account_id, s.device_id AS session_device_id,
      s.refresh_token_hash, s.created_at AS session_created_at, s.expires_at,
      s.last_used_at AS session_last_used_at, s.revoked_at AS session_revoked_at, s.risk_state,
      a.account_id, a.status, a.display_name, a.email, a.phone, a.policy_id,
      a.default_principal_id, a.activated_at, a.suspended_at, a.deletion_state,
      a.created_at AS account_created_at, a.updated_at AS account_updated_at,
      p.principal_id, p.principal_type, p.display_name AS principal_display_name,
      p.avatar_ref, p.status AS principal_status, p.owner_principal_id,
      p.created_at AS principal_created_at, p.revoked_at AS principal_revoked_at,
      d.device_id, d.platform, d.device_label, d.credential_fingerprint,
      d.credential_version, d.public_key_package, d.notification_capability,
      d.client_version, d.protocol_version, d.created_at AS device_created_at,
      d.last_seen_at, d.revoked_at AS device_revoked_at, d.revocation_reason
    FROM sessions s
    JOIN accounts a ON a.account_id = s.account_id
    JOIN devices d ON d.device_id = s.device_id
    JOIN principals p ON p.principal_id = d.principal_id
    WHERE s.refresh_token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > CURRENT_TIMESTAMP
      AND d.revoked_at IS NULL`
  )
    .bind(tokenHash)
    .first<Record<string, string | number | null>>();

  if (!row) {
    throw new HttpError(401, "unauthorized", "Invalid or expired session");
  }
  if (row.status !== "active") {
    throw new HttpError(403, "account_not_active", "Account is not active");
  }

  const roles = await getActiveAdminRoles(env, String(row.account_id));

  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE session_id = ?").bind(row.session_id),
    env.CONTROL_DB.prepare("UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP WHERE device_id = ?").bind(row.device_id)
  ]);

  return {
    account: {
      account_id: String(row.account_id),
      status: row.status as AccountRow["status"],
      display_name: String(row.display_name),
      email: nullableString(row.email),
      phone: nullableString(row.phone),
      policy_id: String(row.policy_id),
      default_principal_id: nullableString(row.default_principal_id),
      activated_at: nullableString(row.activated_at),
      suspended_at: nullableString(row.suspended_at),
      deletion_state: nullableString(row.deletion_state),
      created_at: String(row.account_created_at),
      updated_at: String(row.account_updated_at)
    },
    principal: {
      principal_id: String(row.principal_id),
      account_id: String(row.account_id),
      principal_type: row.principal_type as PrincipalRow["principal_type"],
      display_name: String(row.principal_display_name),
      avatar_ref: nullableString(row.avatar_ref),
      status: row.principal_status as PrincipalRow["status"],
      owner_principal_id: nullableString(row.owner_principal_id),
      created_at: String(row.principal_created_at),
      revoked_at: nullableString(row.principal_revoked_at)
    },
    device: {
      device_id: String(row.device_id),
      account_id: String(row.account_id),
      principal_id: String(row.principal_id),
      platform: String(row.platform),
      device_label: String(row.device_label),
      credential_fingerprint: nullableString(row.credential_fingerprint),
      credential_version: Number(row.credential_version),
      public_key_package: nullableString(row.public_key_package),
      notification_capability: nullableString(row.notification_capability),
      client_version: nullableString(row.client_version),
      protocol_version: nullableString(row.protocol_version),
      created_at: String(row.device_created_at),
      last_seen_at: nullableString(row.last_seen_at),
      revoked_at: nullableString(row.device_revoked_at),
      revocation_reason: nullableString(row.revocation_reason)
    },
    session: {
      session_id: String(row.session_id),
      account_id: String(row.account_id),
      device_id: String(row.device_id),
      refresh_token_hash: String(row.refresh_token_hash),
      created_at: String(row.session_created_at),
      expires_at: String(row.expires_at),
      last_used_at: nullableString(row.session_last_used_at),
      revoked_at: nullableString(row.session_revoked_at),
      risk_state: String(row.risk_state)
    },
    roles
  };
}

export function requireAdmin(auth: AuthContext, allowedRoles: string[]): string {
  const role = auth.roles.find((candidate) => allowedRoles.includes(candidate) || candidate === "platform_owner");
  if (!role) {
    throw new HttpError(403, "forbidden", "Admin role required");
  }
  return role;
}

export function isPlatformOwner(auth: AuthContext): boolean {
  return auth.roles.includes("platform_owner");
}

export async function assertCanAdministerAccount(env: Env, auth: AuthContext, targetAccountId: string): Promise<void> {
  if ((await accountHasAdminRole(env, targetAccountId, "platform_owner")) && !isPlatformOwner(auth)) {
    throw new HttpError(403, "platform_owner_required", "Platform owner authority is required for this account");
  }
}

export async function bootstrapAdmin(
  env: Env,
  input: {
    displayName: string;
    email: string;
    password: string;
    device: DeviceInput;
  }
): Promise<{ account: AccountRow; principal: PrincipalRow; device: DeviceRow; sessionToken: string }> {
  const existing = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM account_admin_roles aar
     JOIN admin_roles ar ON ar.role_id = aar.role_id
     WHERE aar.revoked_at IS NULL AND ar.name = 'platform_owner'`
  ).first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) {
    throw new HttpError(409, "already_bootstrapped", "Platform owner already exists");
  }

  const accountId = randomId("acct");
  const principalId = randomId("prn");
  const account = await createAccount(env, {
    accountId,
    principalId,
    displayName: input.displayName,
    email: input.email,
    status: "active",
    activated: true
  });
  const principal = await getPrincipal(env, principalId);
  await setPassword(env, accountId, input.password);
  await grantAdminRole(env, accountId, "platform_owner", null);
  const device = await createDeviceForPrincipal(env, accountId, principalId, input.device);
  const sessionToken = await createSession(env, accountId, device.device_id);
  return { account, principal, device, sessionToken };
}

export async function createInvitation(
  env: Env,
  input: {
    displayName: string;
    email?: string;
    phone?: string;
    policyId?: string;
    expiresInDays?: number;
    createdByAccountId: string;
  }
): Promise<{ account: AccountRow; invitationId: string; activationToken: string; expiresAt: string }> {
  const accountId = randomId("acct");
  const principalId = randomId("prn");
  const policyId = input.policyId ?? "pol_default";
  await assertPolicyExists(env, policyId);
  const account = await createAccount(env, {
    accountId,
    principalId,
    displayName: input.displayName,
    email: input.email,
    phone: input.phone,
    policyId,
    status: "invited",
    activated: false
  });
  const invitationId = randomId("inv");
  const activationToken = randomToken();
  const tokenHash = await sha256Base64Url(activationToken);
  const expiresAt = sqliteTimestamp(Date.now() + (input.expiresInDays ?? INVITATION_DAYS) * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    `INSERT INTO invitations (
      invitation_id, token_hash, account_id, intended_display_name, intended_contact,
      expires_at, created_by_account_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(invitationId, tokenHash, accountId, input.displayName, input.email ?? input.phone ?? null, expiresAt, input.createdByAccountId)
    .run();
  return { account, invitationId, activationToken, expiresAt };
}

export async function acceptInvitation(
  env: Env,
  input: { token: string; password: string; device: DeviceInput }
): Promise<{ account: AccountRow; principal: PrincipalRow; device: DeviceRow; sessionToken: string }> {
  const tokenHash = await sha256Base64Url(input.token);
  const invitation = await env.CONTROL_DB.prepare(
    `SELECT invitation_id, account_id
     FROM invitations
     WHERE token_hash = ?
       AND accepted_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`
  )
    .bind(tokenHash)
    .first<{ invitation_id: string; account_id: string }>();
  if (!invitation) {
    throw new HttpError(400, "invalid_invitation", "Invitation is invalid or expired");
  }

  const account = await getAccount(env, invitation.account_id);
  if (account.status !== "invited") {
    throw new HttpError(409, "account_not_invited", "Account is not waiting for activation");
  }
  if (!account.default_principal_id) {
    throw new HttpError(500, "missing_principal", "Account is missing its default principal");
  }

  await setPassword(env, account.account_id, input.password);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE accounts SET status = 'active', activated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?"
    ).bind(account.account_id),
    env.CONTROL_DB.prepare(
      "UPDATE invitations SET accepted_account_id = ?, accepted_at = CURRENT_TIMESTAMP WHERE invitation_id = ?"
    ).bind(account.account_id, invitation.invitation_id)
  ]);

  const activeAccount = await getAccount(env, account.account_id);
  const principal = await getPrincipal(env, account.default_principal_id);
  const device = await createDeviceForPrincipal(env, account.account_id, principal.principal_id, input.device);
  const sessionToken = await createSession(env, account.account_id, device.device_id);
  return { account: activeAccount, principal, device, sessionToken };
}

export async function loginWithPassword(
  env: Env,
  input: { email: string; password: string; device: DeviceInput }
): Promise<{ account: AccountRow; principal: PrincipalRow; device: DeviceRow; sessionToken: string }> {
  const account = await env.CONTROL_DB.prepare("SELECT * FROM accounts WHERE lower(email) = lower(?)")
    .bind(input.email)
    .first<AccountRow>();
  if (!account || account.status !== "active") {
    throw new HttpError(401, "invalid_credentials", "Invalid credentials");
  }
  const authenticator = await env.CONTROL_DB.prepare(
    `SELECT authenticator_id, password_verifier
     FROM authenticators
     WHERE account_id = ? AND type = 'password' AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(account.account_id)
    .first<{ authenticator_id: string; password_verifier: string }>();
  if (!authenticator || !(await verifyPassword(input.password, authenticator.password_verifier))) {
    throw new HttpError(401, "invalid_credentials", "Invalid credentials");
  }
  if (!account.default_principal_id) {
    throw new HttpError(500, "missing_principal", "Account is missing its default principal");
  }
  await env.CONTROL_DB.prepare("UPDATE authenticators SET last_used_at = CURRENT_TIMESTAMP WHERE authenticator_id = ?")
    .bind(authenticator.authenticator_id)
    .run();
  const principal = await getPrincipal(env, account.default_principal_id);
  const device = await getOrCreateLoginDevice(env, account.account_id, principal.principal_id, input.device);
  const sessionToken = await createSession(env, account.account_id, device.device_id);
  return { account, principal, device, sessionToken };
}

export async function changePassword(
  env: Env,
  auth: AuthContext,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const authenticator = await env.CONTROL_DB.prepare(
    `SELECT authenticator_id, password_verifier
     FROM authenticators
     WHERE account_id = ? AND type = 'password' AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(auth.account.account_id)
    .first<{ authenticator_id: string; password_verifier: string }>();
  if (!authenticator || !(await verifyPassword(currentPassword, authenticator.password_verifier))) {
    throw new HttpError(401, "invalid_credentials", "Invalid credentials");
  }
  await replacePassword(env, auth.account.account_id, newPassword);
}

export async function createCredentialReset(
  env: Env,
  input: {
    accountId: string;
    createdByAccountId: string;
    reason?: string;
    expiresInDays?: number;
    revokeDevices?: boolean;
  }
): Promise<CredentialResetResult> {
  const account = await getAccount(env, input.accountId);
  if (account.status !== "active" && account.status !== "locked") {
    throw new HttpError(409, "account_not_resettable", "Account cannot be reset");
  }
  const resetId = randomId("rst");
  const resetToken = randomToken();
  const tokenHash = await sha256Base64Url(resetToken);
  const expiresAt = sqliteTimestamp(Date.now() + (input.expiresInDays ?? CREDENTIAL_RESET_DAYS) * 24 * 60 * 60 * 1000);
  const statements = [
    env.CONTROL_DB.prepare(
      "UPDATE credential_reset_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL"
    ).bind(input.accountId),
    env.CONTROL_DB.prepare(
      `INSERT INTO credential_reset_tokens (
        reset_id, token_hash, account_id, created_by_account_id, reason, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(resetId, tokenHash, input.accountId, input.createdByAccountId, input.reason ?? null, expiresAt),
    env.CONTROL_DB.prepare("UPDATE accounts SET status = 'locked', updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND status IN ('active', 'locked')").bind(input.accountId),
    env.CONTROL_DB.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND revoked_at IS NULL").bind(input.accountId)
  ];
  if (input.revokeDevices ?? true) {
    statements.push(
      env.CONTROL_DB.prepare(
        "UPDATE devices SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'credential_reset' WHERE account_id = ? AND revoked_at IS NULL"
      ).bind(input.accountId)
    );
  }
  await env.CONTROL_DB.batch(statements);
  return { account: await getAccount(env, input.accountId), resetId, resetToken, expiresAt };
}

export async function completeCredentialReset(
  env: Env,
  input: { token: string; password: string; device: DeviceInput }
): Promise<{ account: AccountRow; principal: PrincipalRow; device: DeviceRow; sessionToken: string }> {
  const tokenHash = await sha256Base64Url(input.token);
  const reset = await env.CONTROL_DB.prepare(
    `SELECT reset_id, account_id
     FROM credential_reset_tokens
     WHERE token_hash = ?
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`
  )
    .bind(tokenHash)
    .first<{ reset_id: string; account_id: string }>();
  if (!reset) {
    throw new HttpError(400, "invalid_credential_reset", "Credential reset token is invalid or expired");
  }

  const account = await getAccount(env, reset.account_id);
  if (account.status === "deleted" || account.status === "pending_deletion") {
    throw new HttpError(409, "account_not_resettable", "Account cannot be reset");
  }
  if (account.status !== "locked") {
    throw new HttpError(409, "account_not_resettable", "Account is not locked for credential reset");
  }
  if (!account.default_principal_id) {
    throw new HttpError(500, "missing_principal", "Account is missing its default principal");
  }

  const claim = await env.CONTROL_DB.prepare(
    `UPDATE credential_reset_tokens
     SET used_at = CURRENT_TIMESTAMP
     WHERE reset_id = ?
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`
  )
    .bind(reset.reset_id)
    .run();
  if (changesFrom(claim) !== 1) {
    throw new HttpError(400, "invalid_credential_reset", "Credential reset token is invalid or expired");
  }

  const activation = await env.CONTROL_DB.prepare(
    "UPDATE accounts SET status = 'active', activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND status = 'locked'"
  )
    .bind(account.account_id)
    .run();
  if (changesFrom(activation) !== 1) {
    throw new HttpError(409, "account_not_resettable", "Account is not locked for credential reset");
  }
  await replacePassword(env, account.account_id, input.password);
  await env.CONTROL_DB.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND revoked_at IS NULL")
    .bind(account.account_id)
    .run();

  const activeAccount = await getAccount(env, account.account_id);
  const principal = await getPrincipal(env, account.default_principal_id);
  const device = await createDeviceForPrincipal(env, activeAccount.account_id, principal.principal_id, input.device);
  const sessionToken = await createSession(env, activeAccount.account_id, device.device_id);
  return { account: activeAccount, principal, device, sessionToken };
}

export async function getActiveAccountByEmail(env: Env, email: string): Promise<AccountRow | null> {
  const account = await env.CONTROL_DB.prepare("SELECT * FROM accounts WHERE lower(email) = lower(?)")
    .bind(email)
    .first<AccountRow>();
  if (!account || account.status !== "active") {
    return null;
  }
  return account;
}

export async function createDeviceForPrincipal(
  env: Env,
  accountId: string,
  principalId: string,
  input: DeviceInput
): Promise<DeviceRow> {
  const policy = await getPolicyForAccount(env, accountId);
  const activeDeviceCount = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM devices WHERE account_id = ? AND revoked_at IS NULL"
  )
    .bind(accountId)
    .first<{ count: number }>();
  if ((activeDeviceCount?.count ?? 0) >= policy.maximum_devices) {
    throw new HttpError(409, "device_limit_reached", "Maximum active device count reached");
  }

  const deviceId = randomId("dev");
  const platform = stringValue(input.platform, "unknown", 32);
  const label = stringValue(input.label, "Unnamed device", 80);
  const credentialFingerprint = optionalStringValue(input.credentialFingerprint, 256);
  const publicKeyPackage = optionalStringValue(input.publicKeyPackage, 8192);
  const notificationCapability = optionalStringValue(input.notificationCapability, 128);
  const clientVersion = optionalStringValue(input.clientVersion, 64);
  const protocolVersion = optionalStringValue(input.protocolVersion, 64);

  await env.CONTROL_DB.prepare(
    `INSERT INTO devices (
      device_id, account_id, principal_id, platform, device_label,
      credential_fingerprint, public_key_package, notification_capability,
      client_version, protocol_version, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(
      deviceId,
      accountId,
      principalId,
      platform,
      label,
      credentialFingerprint,
      publicKeyPackage,
      notificationCapability,
      clientVersion,
      protocolVersion
    )
    .run();
  return getDevice(env, deviceId);
}

async function getOrCreateLoginDevice(env: Env, accountId: string, principalId: string, input: DeviceInput): Promise<DeviceRow> {
  const deviceId = optionalStringValue(input.deviceId, 80);
  if (!deviceId) {
    return createDeviceForPrincipal(env, accountId, principalId, input);
  }
  const device = await env.CONTROL_DB.prepare(
    "SELECT * FROM devices WHERE device_id = ? AND account_id = ? AND principal_id = ? AND revoked_at IS NULL"
  )
    .bind(deviceId, accountId, principalId)
    .first<DeviceRow>();
  if (!device) {
    throw new HttpError(403, "device_not_available", "Device is not enrolled or has been revoked");
  }
  await env.CONTROL_DB.prepare("UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP WHERE device_id = ?").bind(deviceId).run();
  return getDevice(env, deviceId);
}

export async function createSession(env: Env, accountId: string, deviceId: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Base64Url(token);
  const expiresAt = sqliteTimestamp(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    "INSERT INTO sessions (session_id, account_id, device_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(randomId("ses"), accountId, deviceId, tokenHash, expiresAt)
    .run();
  return token;
}

export async function revokeSession(env: Env, sessionId: string, accountId?: string): Promise<void> {
  const query = accountId
    ? "UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_id = ? AND account_id = ? AND revoked_at IS NULL"
    : "UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_id = ? AND revoked_at IS NULL";
  const stmt = accountId ? env.CONTROL_DB.prepare(query).bind(sessionId, accountId) : env.CONTROL_DB.prepare(query).bind(sessionId);
  await stmt.run();
}

export async function revokeOwnDevice(env: Env, accountId: string, deviceId: string, reason: string): Promise<void> {
  const device = await env.CONTROL_DB.prepare("SELECT device_id FROM devices WHERE device_id = ? AND account_id = ?")
    .bind(deviceId, accountId)
    .first<{ device_id: string }>();
  if (!device) {
    throw new HttpError(404, "device_not_found", "Device not found");
  }
  await revokeDevice(env, deviceId, reason, accountId);
}

export async function revokeDevice(env: Env, deviceId: string, reason: string, accountId?: string): Promise<void> {
  const deviceWhere = accountId ? "device_id = ? AND account_id = ? AND revoked_at IS NULL" : "device_id = ? AND revoked_at IS NULL";
  const deviceBinds = accountId ? [reason, deviceId, accountId] : [reason, deviceId];
  const sessionWhere = accountId ? "device_id = ? AND account_id = ? AND revoked_at IS NULL" : "device_id = ? AND revoked_at IS NULL";
  const sessionBinds = accountId ? [deviceId, accountId] : [deviceId];
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE devices SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = ? WHERE ${deviceWhere}`
    ).bind(...deviceBinds),
    env.CONTROL_DB.prepare(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE ${sessionWhere}`
    ).bind(...sessionBinds)
  ]);
}

export async function getActiveAdminRoles(env: Env, accountId: string): Promise<string[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT ar.name
     FROM account_admin_roles aar
     JOIN admin_roles ar ON ar.role_id = aar.role_id
     WHERE aar.account_id = ? AND aar.revoked_at IS NULL`
  )
    .bind(accountId)
    .all<{ name: string }>();
  return (result.results ?? []).map((row) => row.name);
}

export async function listAccounts(env: Env): Promise<AccountRow[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM accounts ORDER BY created_at DESC LIMIT 200").all<AccountRow>();
  return result.results ?? [];
}

export async function listDevices(env: Env, accountId: string): Promise<DeviceRow[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<DeviceRow>();
  return result.results ?? [];
}

export async function listSessions(env: Env, accountId: string): Promise<SessionRow[]> {
  const result = await env.CONTROL_DB.prepare(
    "SELECT * FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT 100"
  )
    .bind(accountId)
    .all<SessionRow>();
  return result.results ?? [];
}

export async function listPolicies(env: Env): Promise<PolicyRow[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM policies ORDER BY name").all<PolicyRow>();
  return result.results ?? [];
}

export async function grantAdminRoleToAccount(
  env: Env,
  auth: AuthContext,
  accountId: string,
  roleName: string
): Promise<string[]> {
  await getAccount(env, accountId);
  await assertCanManageAdminRole(env, auth, accountId, roleName, "grant");
  await grantAdminRole(env, accountId, roleName, auth.account.account_id);
  return getActiveAdminRoles(env, accountId);
}

export async function revokeAdminRoleFromAccount(env: Env, auth: AuthContext, accountId: string, roleName: string): Promise<string[]> {
  const role = await env.CONTROL_DB.prepare("SELECT role_id FROM admin_roles WHERE name = ?")
    .bind(roleName)
    .first<{ role_id: string }>();
  if (!role) throw new HttpError(400, "invalid_role", "Unknown admin role");
  await assertCanManageAdminRole(env, auth, accountId, roleName, "revoke");
  await env.CONTROL_DB.prepare(
    "UPDATE account_admin_roles SET revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND role_id = ? AND revoked_at IS NULL"
  )
    .bind(accountId, role.role_id)
    .run();
  return getActiveAdminRoles(env, accountId);
}

export async function checkRateLimit(
  env: Env,
  input: { key: string; action: string; limit: number; windowSeconds: number }
): Promise<void> {
  const now = Date.now();
  const windowExpiresAt = sqliteTimestamp(now + input.windowSeconds * 1000);
  const existing = await env.CONTROL_DB.prepare("SELECT count, expires_at FROM rate_limits WHERE rate_limit_key = ?")
    .bind(input.key)
    .first<{ count: number; expires_at: string }>();
  if (!existing || existing.expires_at <= sqliteTimestamp(now)) {
    await env.CONTROL_DB.prepare(
      "INSERT INTO rate_limits (rate_limit_key, action, count, window_start, expires_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP, ?) ON CONFLICT(rate_limit_key) DO UPDATE SET action = excluded.action, count = 1, window_start = CURRENT_TIMESTAMP, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP"
    )
      .bind(input.key, input.action, windowExpiresAt)
      .run();
    return;
  }
  if (existing.count >= input.limit) {
    throw new HttpError(429, "rate_limited", "Too many attempts");
  }
  await env.CONTROL_DB.prepare("UPDATE rate_limits SET count = count + 1, updated_at = CURRENT_TIMESTAMP WHERE rate_limit_key = ?")
    .bind(input.key)
    .run();
}

export async function getUsage(env: Env): Promise<Record<string, number>> {
  const [accounts, activeDevices, activeSessions, invitations, audits, rooms, messages, attachments, agentRequests] = await Promise.all([
    count(env, "accounts"),
    count(env, "devices", "revoked_at IS NULL"),
    count(env, "sessions", "revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP"),
    count(env, "invitations", "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP"),
    count(env, "audit_events"),
    count(env, "rooms", "status != 'deleted'"),
    count(env, "message_envelopes", "state != 'purged'"),
    count(env, "attachments", "state != 'deleted'"),
    count(env, "agent_requests")
  ]);
  return { accounts, activeDevices, activeSessions, openInvitations: invitations, auditEvents: audits, rooms, messages, attachments, agentRequests };
}

export async function getAuditEvents(env: Env): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 200").all();
  return result.results ?? [];
}

export async function setAccountStatus(env: Env, accountId: string, status: "active" | "suspended" | "locked"): Promise<AccountRow> {
  await env.CONTROL_DB.prepare(
    "UPDATE accounts SET status = ?, suspended_at = CASE WHEN ? = 'suspended' THEN CURRENT_TIMESTAMP ELSE suspended_at END, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?"
  )
    .bind(status, status, accountId)
    .run();
  return getAccount(env, accountId);
}

export async function requireAuthReset(env: Env, accountId: string): Promise<AccountRow> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE accounts SET status = 'locked', updated_at = CURRENT_TIMESTAMP WHERE account_id = ?").bind(accountId),
    env.CONTROL_DB.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND revoked_at IS NULL").bind(accountId)
  ]);
  return getAccount(env, accountId);
}

export async function updateAccountPolicy(env: Env, accountId: string, policyId: string): Promise<AccountRow> {
  await assertPolicyExists(env, policyId);
  await env.CONTROL_DB.prepare("UPDATE accounts SET policy_id = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?")
    .bind(policyId, accountId)
    .run();
  return getAccount(env, accountId);
}

async function createAccount(
  env: Env,
  input: {
    accountId: string;
    principalId: string;
    displayName: string;
    email?: string;
    phone?: string;
    policyId?: string;
    status: "invited" | "active";
    activated: boolean;
  }
): Promise<AccountRow> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO accounts (
        account_id, status, display_name, email, phone, policy_id,
        default_principal_id, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ${input.activated ? "CURRENT_TIMESTAMP" : "NULL"})`
    ).bind(
      input.accountId,
      input.status,
      input.displayName,
      input.email?.toLowerCase() ?? null,
      input.phone ?? null,
      input.policyId ?? "pol_default",
      input.principalId
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (principal_id, account_id, principal_type, display_name, status) VALUES (?, ?, 'human', ?, 'active')"
    ).bind(input.principalId, input.accountId, input.displayName)
  ]);
  return getAccount(env, input.accountId);
}

async function setPassword(env: Env, accountId: string, password: string): Promise<void> {
  const passwordVerifier = await hashPassword(password);
  await env.CONTROL_DB.prepare(
    "INSERT INTO authenticators (authenticator_id, account_id, type, password_verifier) VALUES (?, ?, 'password', ?)"
  )
    .bind(randomId("auth"), accountId, passwordVerifier)
    .run();
}

async function replacePassword(env: Env, accountId: string, password: string): Promise<void> {
  const passwordVerifier = await hashPassword(password);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE authenticators SET revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND type = 'password' AND revoked_at IS NULL"
    ).bind(accountId),
    env.CONTROL_DB.prepare(
      "INSERT INTO authenticators (authenticator_id, account_id, type, password_verifier) VALUES (?, ?, 'password', ?)"
    ).bind(randomId("auth"), accountId, passwordVerifier)
  ]);
}

async function grantAdminRole(env: Env, accountId: string, roleName: string, grantedByAccountId: string | null): Promise<void> {
  const role = await env.CONTROL_DB.prepare("SELECT role_id FROM admin_roles WHERE name = ?")
    .bind(roleName)
    .first<{ role_id: string }>();
  if (!role) throw new HttpError(400, "invalid_role", "Unknown admin role");
  const existing = await env.CONTROL_DB.prepare(
    "SELECT account_id FROM account_admin_roles WHERE account_id = ? AND role_id = ? AND revoked_at IS NULL LIMIT 1"
  )
    .bind(accountId, role.role_id)
    .first<{ account_id: string }>();
  if (existing) {
    return;
  }
  await env.CONTROL_DB.prepare(
    "INSERT INTO account_admin_roles (account_id, role_id, granted_by_account_id) VALUES (?, ?, ?)"
  )
    .bind(accountId, role.role_id, grantedByAccountId)
    .run();
}

async function assertCanManageAdminRole(
  env: Env,
  auth: AuthContext,
  targetAccountId: string,
  roleName: string,
  action: "grant" | "revoke"
): Promise<void> {
  await assertCanAdministerAccount(env, auth, targetAccountId);
  if (roleName === "platform_owner" && !isPlatformOwner(auth)) {
    throw new HttpError(403, "platform_owner_required", "Only a platform owner can manage platform owner grants");
  }
  if (action === "revoke" && roleName === "platform_owner") {
    const targetHasRole = await accountHasAdminRole(env, targetAccountId, "platform_owner");
    const ownerCount = await countActiveAdminRoleAccounts(env, "platform_owner");
    if (targetHasRole && ownerCount <= 1) {
      throw new HttpError(409, "last_platform_owner_required", "At least one active platform owner is required");
    }
  }
}

async function accountHasAdminRole(env: Env, accountId: string, roleName: string): Promise<boolean> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT aar.account_id
     FROM account_admin_roles aar
     JOIN admin_roles ar ON ar.role_id = aar.role_id
     WHERE aar.account_id = ? AND ar.name = ? AND aar.revoked_at IS NULL
     LIMIT 1`
  )
    .bind(accountId, roleName)
    .first<{ account_id: string }>();
  return Boolean(row);
}

async function countActiveAdminRoleAccounts(env: Env, roleName: string): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(DISTINCT aar.account_id) AS count
     FROM account_admin_roles aar
     JOIN admin_roles ar ON ar.role_id = aar.role_id
     JOIN accounts a ON a.account_id = aar.account_id
     WHERE ar.name = ?
       AND aar.revoked_at IS NULL
       AND a.status = 'active'`
  )
    .bind(roleName)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getAccount(env: Env, accountId: string): Promise<AccountRow> {
  const account = await env.CONTROL_DB.prepare("SELECT * FROM accounts WHERE account_id = ?").bind(accountId).first<AccountRow>();
  if (!account) throw new HttpError(404, "account_not_found", "Account not found");
  return account;
}

export async function getPrincipal(env: Env, principalId: string): Promise<PrincipalRow> {
  const principal = await env.CONTROL_DB.prepare("SELECT * FROM principals WHERE principal_id = ?")
    .bind(principalId)
    .first<PrincipalRow>();
  if (!principal) throw new HttpError(404, "principal_not_found", "Principal not found");
  return principal;
}

async function getDevice(env: Env, deviceId: string): Promise<DeviceRow> {
  const device = await env.CONTROL_DB.prepare("SELECT * FROM devices WHERE device_id = ?").bind(deviceId).first<DeviceRow>();
  if (!device) throw new HttpError(404, "device_not_found", "Device not found");
  return device;
}

async function getPolicyForAccount(env: Env, accountId: string): Promise<PolicyRow> {
  const policy = await env.CONTROL_DB.prepare(
    `SELECT p.*
     FROM policies p
     JOIN accounts a ON a.policy_id = p.policy_id
     WHERE a.account_id = ?`
  )
    .bind(accountId)
    .first<PolicyRow>();
  if (!policy) throw new HttpError(404, "policy_not_found", "Policy not found");
  return policy;
}

async function assertPolicyExists(env: Env, policyId: string): Promise<void> {
  const policy = await env.CONTROL_DB.prepare("SELECT policy_id FROM policies WHERE policy_id = ?")
    .bind(policyId)
    .first<{ policy_id: string }>();
  if (!policy) throw new HttpError(400, "invalid_policy", "Unknown policy");
}

async function count(env: Env, table: string, where?: string): Promise<number> {
  const safeTable = table.replace(/[^a-z_]/g, "");
  const row = await env.CONTROL_DB.prepare(`SELECT COUNT(*) AS count FROM ${safeTable}${where ? ` WHERE ${where}` : ""}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : fallback;
}

function optionalStringValue(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

function changesFrom(result: D1Result): number {
  return (result.meta as { changes?: number } | undefined)?.changes ?? 0;
}

function sqliteTimestamp(value: number | Date): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
