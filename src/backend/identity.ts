import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, DeviceRow, Env, PrincipalRow } from "../types";
import {
  DEFAULT_KEY_PACKAGE_DAYS,
  MAX_KEY_PACKAGE_BYTES,
  type JsonObject,
} from "./internal-types";
import { getActivePrincipal } from "./rooms";
import {
  nextCursor,
  numberField,
  pageParams,
  requiredJsonText,
  runCounted,
  sqliteTimestamp,
} from "./utils";
import { publicDevice, publicKeyPackage, publicPrincipal } from "./serializers";

export async function listPrincipals(env: Env): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT principal_id, account_id, principal_type, display_name, avatar_ref, status, owner_principal_id, created_at, revoked_at
     FROM principals
     WHERE status = 'active'
     ORDER BY display_name
     LIMIT 200`,
  ).all<PrincipalRow>();
  return (result.results ?? []).map(publicPrincipal);
}

export async function listPrincipalDevices(
  env: Env,
  principalId: string,
): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT device_id, account_id, principal_id, platform, device_label, credential_fingerprint,
      credential_version, public_key_package, notification_capability, client_version,
      protocol_version, created_at, last_seen_at, revoked_at, revocation_reason
     FROM devices
     WHERE principal_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
  )
    .bind(principalId)
    .all<DeviceRow>();
  return (result.results ?? []).map(publicDevice);
}

export async function publishKeyPackage(
  env: Env,
  auth: AuthContext,
  deviceId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  if (deviceId !== auth.device.device_id) {
    throw new HttpError(
      403,
      "device_mismatch",
      "Key packages can only be published for the current authenticated device",
    );
  }
  const packageJson = requiredJsonText(body, "package", MAX_KEY_PACKAGE_BYTES);
  const keyPackageId = randomId("kpk");
  const expiresAt = sqliteTimestamp(
    Date.now() +
      numberField(body, "expiresInDays", 1, 90, DEFAULT_KEY_PACKAGE_DAYS) *
        24 *
        60 *
        60 *
        1000,
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO device_key_packages (
      key_package_id, account_id, principal_id, device_id, protocol,
      public_identity_key, signed_prekey, one_time_prekey, package_json, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
  )
    .bind(
      keyPackageId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      stringField(body, "protocol", { max: 40 }) ?? "opaque-test",
      stringField(body, "publicIdentityKey", { max: 4096 }) ?? null,
      stringField(body, "signedPrekey", { max: 4096 }) ?? null,
      stringField(body, "oneTimePrekey", { max: 4096 }) ?? null,
      packageJson,
      expiresAt,
    )
    .run();
  return getKeyPackage(env, keyPackageId, true);
}

export async function listAvailableKeyPackages(
  env: Env,
  principalId: string,
): Promise<unknown[]> {
  await getActivePrincipal(env, principalId);
  const result = await env.CONTROL_DB.prepare(
    `SELECT key_package_id, account_id, principal_id, device_id, protocol, public_identity_key,
      signed_prekey, one_time_prekey, package_json, status, claimed_by_device_id,
      claimed_at, expires_at, created_at
     FROM device_key_packages
     WHERE principal_id = ? AND status = 'available' AND expires_at > CURRENT_TIMESTAMP
     ORDER BY created_at ASC
     LIMIT 50`,
  )
    .bind(principalId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicKeyPackage);
}

export async function listOwnDeviceKeyPackages(
  env: Env,
  auth: AuthContext,
  deviceId: string,
  url: URL,
): Promise<JsonObject> {
  const device = await env.CONTROL_DB.prepare(
    "SELECT device_id FROM devices WHERE device_id = ? AND account_id = ?",
  )
    .bind(deviceId, auth.account.account_id)
    .first<{ device_id: string }>();
  if (!device) {
    throw new HttpError(404, "device_not_found", "Device not found");
  }
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT key_package_id, account_id, principal_id, device_id, protocol, public_identity_key,
      signed_prekey, one_time_prekey, package_json, status, claimed_by_device_id,
      claimed_at, expires_at, created_at
     FROM device_key_packages
     WHERE device_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(deviceId, page.limit, page.offset)
    .all<Record<string, unknown>>();
  const keyPackages = (result.results ?? []).map(publicKeyPackage);
  return { keyPackages, nextCursor: nextCursor(keyPackages.length, page) };
}

export async function claimKeyPackage(
  env: Env,
  auth: AuthContext,
  keyPackageId: string,
): Promise<JsonObject> {
  const existing = await getRawKeyPackage(env, keyPackageId);
  if (
    !existing ||
    existing.status !== "available" ||
    String(existing.expires_at) <= sqliteTimestamp(Date.now())
  ) {
    throw new HttpError(
      404,
      "key_package_not_available",
      "Key package is not available",
    );
  }
  if (existing.device_id === auth.device.device_id) {
    throw new HttpError(
      400,
      "cannot_claim_own_key_package",
      "A device cannot claim its own key package",
    );
  }
  const claimed = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE device_key_packages SET status = 'claimed', claimed_by_device_id = ?, claimed_at = CURRENT_TIMESTAMP WHERE key_package_id = ? AND status = 'available' AND expires_at > CURRENT_TIMESTAMP",
    ).bind(auth.device.device_id, keyPackageId),
  );
  if (claimed !== 1) {
    throw new HttpError(
      409,
      "key_package_claim_failed",
      "Key package was already claimed or expired",
    );
  }
  return getKeyPackage(env, keyPackageId, true);
}

export async function revokeKeyPackage(
  env: Env,
  auth: AuthContext,
  keyPackageId: string,
): Promise<void> {
  const existing = await getRawKeyPackage(env, keyPackageId);
  if (!existing) {
    throw new HttpError(404, "key_package_not_found", "Key package not found");
  }
  if (existing.account_id !== auth.account.account_id) {
    throw new HttpError(
      403,
      "forbidden",
      "Key package belongs to another account",
    );
  }
  await env.CONTROL_DB.prepare(
    "UPDATE device_key_packages SET status = 'revoked' WHERE key_package_id = ? AND status != 'revoked'",
  )
    .bind(keyPackageId)
    .run();
}

export async function getRawKeyPackage(
  env: Env,
  keyPackageId: string,
): Promise<Record<string, unknown> | null> {
  return env.CONTROL_DB.prepare(
    "SELECT * FROM device_key_packages WHERE key_package_id = ?",
  )
    .bind(keyPackageId)
    .first<Record<string, unknown>>();
}

export async function getKeyPackage(
  env: Env,
  keyPackageId: string,
  includePackage: boolean,
): Promise<JsonObject> {
  const keyPackage = await getRawKeyPackage(env, keyPackageId);
  if (!keyPackage)
    throw new HttpError(404, "key_package_not_found", "Key package not found");
  return includePackage ? publicKeyPackage(keyPackage) : { keyPackageId };
}
