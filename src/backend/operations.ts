import { audit, requireAdmin } from "../db";
import { randomId } from "../crypto";
import {
  HttpError,
  json,
  optionalObject,
  publicAccount,
  readJsonObject,
  serverTimingHeader,
  stringField,
} from "../http";
import { notifyRoomRealtime } from "../realtime";
import type {
  AccountRow,
  AuthContext,
  DeviceRow,
  Env,
  PrincipalRow,
  PolicyRow,
} from "../types";
import {
  DEFAULT_ATTACHMENT_DAYS,
  DEFAULT_KEY_PACKAGE_DAYS,
  MAX_KEY_PACKAGE_BYTES,
  MAX_MESSAGE_BYTES,
  OWNERSHIP_TRANSFER_DAYS,
  ROOM_INVITATION_DAYS,
  type AppBootstrapResult,
  type AttachmentRow,
  type ConversationMutationMetrics,
  type JsonObject,
  type MembershipRow,
  type PageParams,
  type PrincipalRecord,
  type RoomInvitationRow,
  type RoomRow,
  type SendMessageMetrics,
  type SendMessageResult,
  type SendRoomContext,
} from "./internal-types";

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

export async function listRooms(
  env: Env,
  auth: AuthContext,
  url?: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT r.*
     FROM rooms r
     JOIN room_memberships rm ON rm.room_id = r.room_id
     WHERE rm.principal_id = ? AND rm.status = 'active' AND r.status != 'deleted'
     ORDER BY r.updated_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(auth.principal.principal_id, page.limit, page.offset)
    .all<RoomRow>();
  const rooms = await publicRoomsWithMembers(env, result.results ?? []);
  return { rooms, nextCursor: nextCursor(rooms.length, page) };
}

export async function createDirectRoom(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const targetPrincipalIds = stringArrayField(body, "principalIds", {
    required: true,
    maxItems: 1,
  });
  const uniquePrincipalIds = uniqueStrings([
    auth.principal.principal_id,
    ...targetPrincipalIds,
  ]);
  if (uniquePrincipalIds.length !== 2) {
    throw new HttpError(
      400,
      "invalid_direct_room",
      "Direct rooms require exactly two principals",
    );
  }
  const principals = await getActivePrincipals(env, uniquePrincipalIds);
  const room = await createRoom(env, auth, {
    type: "direct",
    name: stringField(body, "name", { max: 120 }),
    description: stringField(body, "description", { max: 1000 }),
    principals,
  });
  return publicRoomWithMembers(env, room);
}

export async function createGroupRoom(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const policy = await getPolicy(env, auth.account.policy_id);
  const ownedGroups = await countOwnedGroups(env, auth.principal.principal_id);
  if (ownedGroups >= policy.maximum_owned_groups) {
    throw new HttpError(
      409,
      "group_quota_reached",
      "Maximum owned group count reached",
    );
  }
  const memberPrincipalIds = stringArrayField(body, "memberPrincipalIds", {
    maxItems: policy.maximum_group_memberships - 1,
  });
  if (memberPrincipalIds.length > 0) {
    throw new HttpError(
      400,
      "initial_group_members_not_supported",
      "Create the group first, then invite humans or add agents",
    );
  }
  const principals = await getActivePrincipals(env, [
    auth.principal.principal_id,
  ]);
  const room = await createRoom(env, auth, {
    type: "group",
    name: stringField(body, "name", { required: true, min: 1, max: 120 }),
    description: stringField(body, "description", { max: 1000 }),
    principals,
  });
  return publicRoomWithMembers(env, room);
}

export async function createRoom(
  env: Env,
  auth: AuthContext,
  input: {
    type: RoomRow["type"];
    name?: string;
    description?: string;
    principals: PrincipalRecord[];
  },
): Promise<RoomRow> {
  const roomId = randomId("room");
  await env.CONTROL_DB.prepare(
    `INSERT INTO rooms (room_id, type, name, description, created_by_account_id, created_by_principal_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
  )
    .bind(
      roomId,
      input.type,
      input.name ?? null,
      input.description ?? null,
      auth.account.account_id,
      auth.principal.principal_id,
    )
    .run();

  for (const principal of input.principals) {
    const role =
      principal.principal_id === auth.principal.principal_id
        ? "owner"
        : principal.principal_type === "agent"
          ? "agent"
          : "member";
    await insertMembership(
      env,
      roomId,
      principal,
      role,
      auth.principal.principal_id,
    );
  }
  return getRoom(env, roomId);
}

export async function getRoomForMember(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

export async function updateRoom(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomManager(env, auth, roomId);
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET name = COALESCE(?, name), description = COALESCE(?, description), version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND status = 'active'",
  )
    .bind(
      stringField(body, "name", { max: 120 }) ?? null,
      stringField(body, "description", { max: 1000 }) ?? null,
      roomId,
    )
    .run();
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

export async function archiveRoom(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET status = 'archived', archived_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND status = 'active'",
  )
    .bind(roomId)
    .run();
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

export async function addRoomMember(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomManager(env, auth, roomId);
  const room = await getRoom(env, roomId);
  if (room.type === "direct") {
    throw new HttpError(
      409,
      "direct_room_members_locked",
      "Direct room members cannot be changed",
    );
  }
  const principal = await getActivePrincipal(
    env,
    stringField(body, "principalId", { required: true, max: 80 })!,
  );
  if (principal.principal_type !== "agent") {
    throw new HttpError(
      400,
      "human_invitation_required",
      "Human principals must accept a room invitation",
    );
  }
  const role = normalizedRole(
    stringField(body, "role", { max: 20 }),
    principal.principal_type,
  );
  await enforceMemberQuota(env, roomId);
  await upsertMembership(
    env,
    roomId,
    principal,
    role,
    auth.principal.principal_id,
  );
  await bumpRoom(env, roomId);
  return publicMembership(
    await getMembership(env, roomId, principal.principal_id),
  );
}

export async function createRoomInvitation(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomManager(env, auth, roomId);
  const room = await getRoom(env, roomId);
  if (room.type === "direct") {
    throw new HttpError(
      409,
      "direct_room_members_locked",
      "Direct room members cannot be changed",
    );
  }
  const principal = await getActivePrincipal(
    env,
    stringField(body, "principalId", { required: true, max: 80 })!,
  );
  if (principal.principal_type !== "human") {
    throw new HttpError(
      400,
      "agent_invitation_not_supported",
      "Agent principals should be added directly by a room admin",
    );
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_invitations SET status = 'expired' WHERE room_id = ? AND invited_principal_id = ? AND status = 'pending' AND expires_at <= CURRENT_TIMESTAMP",
  )
    .bind(roomId, principal.principal_id)
    .run();
  const activeMembership = await env.CONTROL_DB.prepare(
    "SELECT membership_id FROM room_memberships WHERE room_id = ? AND principal_id = ? AND status = 'active'",
  )
    .bind(roomId, principal.principal_id)
    .first<{ membership_id: string }>();
  if (activeMembership) {
    throw new HttpError(
      409,
      "room_member_already_active",
      "Principal is already an active room member",
    );
  }
  const existingInvitation = await env.CONTROL_DB.prepare(
    "SELECT room_invitation_id FROM room_invitations WHERE room_id = ? AND invited_principal_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP",
  )
    .bind(roomId, principal.principal_id)
    .first<{ room_invitation_id: string }>();
  if (existingInvitation) {
    throw new HttpError(
      409,
      "room_invitation_exists",
      "A pending room invitation already exists",
    );
  }
  await enforceMemberQuota(env, roomId);

  const roomInvitationId = randomId("rinv");
  const expiresAt = sqliteTimestamp(
    Date.now() +
      numberField(body, "expiresInDays", 1, 30, ROOM_INVITATION_DAYS) *
        24 *
        60 *
        60 *
        1000,
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_invitations (
      room_invitation_id, room_id, invited_account_id, invited_principal_id,
      invited_by_account_id, invited_by_principal_id, role, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      roomInvitationId,
      roomId,
      principal.account_id,
      principal.principal_id,
      auth.account.account_id,
      auth.principal.principal_id,
      normalizedInvitationRole(stringField(body, "role", { max: 20 })),
      expiresAt,
    )
    .run();
  return publicRoomInvitation(await getRoomInvitation(env, roomInvitationId));
}

export async function listRoomInvitations(
  env: Env,
  auth: AuthContext,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status") ?? "pending";
  if (
    !["pending", "accepted", "declined", "revoked", "expired"].includes(status)
  ) {
    throw new HttpError(
      400,
      "invalid_invitation_status",
      "Room invitation status is invalid",
    );
  }
  const pendingFilter =
    status === "pending" ? "AND ri.expires_at > CURRENT_TIMESTAMP" : "";
  const result = await env.CONTROL_DB.prepare(
    `SELECT ri.*, r.name AS room_name, r.type AS room_type, p.display_name AS invited_by_display_name
     FROM room_invitations ri
     JOIN rooms r ON r.room_id = ri.room_id
     JOIN principals p ON p.principal_id = ri.invited_by_principal_id
     WHERE ri.invited_principal_id = ?
       AND ri.status = ?
       ${pendingFilter}
     ORDER BY ri.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(auth.principal.principal_id, status, page.limit, page.offset)
    .all<RoomInvitationRow>();
  const invitations = (result.results ?? []).map(publicRoomInvitation);
  return { invitations, nextCursor: nextCursor(invitations.length, page) };
}

export async function acceptRoomInvitation(
  env: Env,
  auth: AuthContext,
  roomInvitationId: string,
): Promise<JsonObject> {
  const invitation = await getPendingRoomInvitationForPrincipal(
    env,
    roomInvitationId,
    auth.principal.principal_id,
  );
  const existingMembership = await env.CONTROL_DB.prepare(
    "SELECT membership_id FROM room_memberships WHERE room_id = ? AND principal_id = ? AND status = 'active'",
  )
    .bind(invitation.room_id, auth.principal.principal_id)
    .first<{ membership_id: string }>();
  if (!existingMembership) {
    await enforceMemberQuota(env, invitation.room_id);
    const principal = await getActivePrincipal(
      env,
      auth.principal.principal_id,
    );
    await upsertMembership(
      env,
      invitation.room_id,
      principal,
      invitation.role,
      invitation.invited_by_principal_id,
    );
    await bumpRoom(env, invitation.room_id);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_invitations SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE room_invitation_id = ? AND status = 'pending'",
  )
    .bind(roomInvitationId)
    .run();
  return publicRoomInvitation(await getRoomInvitation(env, roomInvitationId));
}

export async function declineRoomInvitation(
  env: Env,
  auth: AuthContext,
  roomInvitationId: string,
): Promise<JsonObject> {
  const invitation = await getPendingRoomInvitationForPrincipal(
    env,
    roomInvitationId,
    auth.principal.principal_id,
  );
  await env.CONTROL_DB.prepare(
    "UPDATE room_invitations SET status = 'declined', responded_at = CURRENT_TIMESTAMP WHERE room_invitation_id = ? AND status = 'pending'",
  )
    .bind(invitation.room_invitation_id)
    .run();
  return publicRoomInvitation(await getRoomInvitation(env, roomInvitationId));
}

export async function getRoomIdForPendingRoomInvitation(
  env: Env,
  auth: AuthContext,
  roomInvitationId: string,
): Promise<string> {
  const invitation = await getPendingRoomInvitationForPrincipal(
    env,
    roomInvitationId,
    auth.principal.principal_id,
  );
  return invitation.room_id;
}

export async function updateRoomMemberRole(
  env: Env,
  auth: AuthContext,
  roomId: string,
  principalId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  const principal = await getActivePrincipal(env, principalId);
  const role = normalizedRole(
    stringField(body, "role", { required: true, max: 20 }),
    principal.principal_type,
  );
  if (role !== "owner") {
    await ensureAnotherHumanOwner(env, roomId, principalId);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_memberships SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ? AND status = 'active'",
  )
    .bind(role, roomId, principalId)
    .run();
  await bumpRoom(env, roomId);
  return publicMembership(await getMembership(env, roomId, principalId));
}

export async function removeRoomMember(
  env: Env,
  auth: AuthContext,
  roomId: string,
  principalId: string,
): Promise<void> {
  await requireRoomManager(env, auth, roomId);
  const membership = await getMembership(env, roomId, principalId);
  if (membership.role === "owner") {
    await ensureAnotherHumanOwner(env, roomId, principalId);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_memberships SET status = 'removed', removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?",
  )
    .bind(roomId, principalId)
    .run();
  await bumpRoom(env, roomId);
}

export async function leaveRoom(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<void> {
  const membership = await requireRoomMembership(env, auth, roomId);
  if (membership.role === "owner") {
    await ensureAnotherHumanOwner(env, roomId, auth.principal.principal_id);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_memberships SET status = 'leaving', removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?",
  )
    .bind(roomId, auth.principal.principal_id)
    .run();
  await bumpRoom(env, roomId);
}

export async function proposeOwnershipTransfer(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  const toPrincipalId = stringField(body, "toPrincipalId", {
    required: true,
    max: 80,
  })!;
  const targetMembership = await getMembership(env, roomId, toPrincipalId);
  const target = await getActivePrincipal(env, toPrincipalId);
  if (
    target.principal_type !== "human" ||
    targetMembership.status !== "active"
  ) {
    throw new HttpError(
      400,
      "invalid_owner_target",
      "Ownership can only transfer to an active human room member",
    );
  }
  const transferId = randomId("xfer");
  const expiresAt = sqliteTimestamp(
    Date.now() + OWNERSHIP_TRANSFER_DAYS * 24 * 60 * 60 * 1000,
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO ownership_transfers (transfer_id, room_id, from_principal_id, to_principal_id, status, expires_at)
     VALUES (?, ?, ?, ?, 'proposed', ?)`,
  )
    .bind(
      transferId,
      roomId,
      auth.principal.principal_id,
      toPrincipalId,
      expiresAt,
    )
    .run();
  return getOwnershipTransfer(env, transferId);
}

export async function acceptOwnershipTransfer(
  env: Env,
  auth: AuthContext,
  roomId: string,
  transferId: string,
): Promise<JsonObject> {
  const transfer = await env.CONTROL_DB.prepare(
    "SELECT * FROM ownership_transfers WHERE transfer_id = ? AND room_id = ? AND status = 'proposed' AND expires_at > CURRENT_TIMESTAMP",
  )
    .bind(transferId, roomId)
    .first<Record<string, string>>();
  if (!transfer || transfer.to_principal_id !== auth.principal.principal_id) {
    throw new HttpError(
      404,
      "ownership_transfer_not_found",
      "Ownership transfer not found",
    );
  }
  await requireRoomMembership(env, auth, roomId);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE room_memberships SET role = 'owner', updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?",
    ).bind(roomId, auth.principal.principal_id),
    env.CONTROL_DB.prepare(
      "UPDATE room_memberships SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?",
    ).bind(roomId, transfer.from_principal_id),
    env.CONTROL_DB.prepare(
      "UPDATE ownership_transfers SET status = 'completed', responded_at = CURRENT_TIMESTAMP WHERE transfer_id = ?",
    ).bind(transferId),
  ]);
  await bumpRoom(env, roomId);
  return getOwnershipTransfer(env, transferId);
}

export async function sendMessageEnvelope(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<SendMessageResult> {
  const startedAt = performance.now();
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const contextMs = durationSince(startedAt);
  const idempotencyKey = stringField(body, "idempotencyKey", {
    required: true,
    min: 8,
    max: 160,
  })!;
  const ciphertext = stringField(body, "ciphertext", {
    required: true,
    min: 1,
    max: MAX_MESSAGE_BYTES,
  })!;
  const ciphertextBytes = byteLength(ciphertext);
  if (ciphertextBytes > MAX_MESSAGE_BYTES) {
    throw new HttpError(
      413,
      "message_too_large",
      "Encrypted envelope is too large",
    );
  }
  const protocolType = stringField(body, "protocolType", {
    required: true,
    max: 60,
  })!;
  if (
    ![
      "opaque-test",
      "mls_application",
      "mls_commit",
      "mls_proposal",
      "mls_welcome",
    ].includes(protocolType)
  ) {
    throw new HttpError(
      400,
      "invalid_protocol_type",
      "Protocol type is not allowed",
    );
  }
  const envelopeId = randomId("msg");
  const expiresAt = sqliteTimestamp(
    Date.now() + Number(context.message_retention_days) * 24 * 60 * 60 * 1000,
  );
  const clientCreatedAt =
    stringField(body, "clientCreatedAt", { max: 80 }) ?? null;
  const attachmentIds = stringArrayField(body, "attachmentIds", {
    maxItems: 20,
  });
  const insertStartedAt = performance.now();
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT INTO message_envelopes (
      envelope_id, room_id, sender_account_id, sender_principal_id, sender_device_id,
      idempotency_key, protocol_type, ciphertext, ciphertext_bytes, client_created_at,
      server_sequence, expires_at, state
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(server_sequence), 0) + 1 FROM message_envelopes WHERE room_id = ?),
      ?, 'available'
    )
    ON CONFLICT(sender_device_id, idempotency_key) DO NOTHING
    RETURNING *`,
  )
    .bind(
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      idempotencyKey,
      protocolType,
      ciphertext,
      ciphertextBytes,
      clientCreatedAt,
      roomId,
      expiresAt,
    )
    .first<Record<string, unknown>>();
  const insertMs = durationSince(insertStartedAt);

  if (!inserted) {
    const existing = await env.CONTROL_DB.prepare(
      "SELECT * FROM message_envelopes WHERE sender_device_id = ? AND idempotency_key = ?",
    )
      .bind(auth.device.device_id, idempotencyKey)
      .first<Record<string, unknown>>();
    if (!existing)
      throw new HttpError(
        409,
        "message_idempotency_conflict",
        "Message idempotency key could not be resolved",
      );
    let realtimeMs = 0;
    if (String(existing.room_id) === roomId) {
      const realtimeStartedAt = performance.now();
      await notifyRoomRealtime(env, roomId, {
        type: "room.message",
        envelopeId: String(existing.envelope_id),
        serverSequence: Number(existing.server_sequence),
        senderDeviceId: auth.device.device_id,
      }).catch((error) => console.warn("realtime notification failed", error));
      realtimeMs = durationSince(realtimeStartedAt);
    }
    const metrics = finalizeSendMetrics({
      duplicate: true,
      startedAt,
      contextMs,
      insertMs,
      postWriteMs: 0,
      realtimeMs,
    });
    logSendMessagePerformance(requestId, roomId, existing, metrics);
    return { message: publicMessage(existing), metrics };
  }

  const postWriteStartedAt = performance.now();
  await env.CONTROL_DB.batch([
    createDeliveryReceiptStatement(
      env,
      roomId,
      envelopeId,
      auth.device.device_id,
    ),
    ...markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds),
    env.CONTROL_DB.prepare(
      "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
    ).bind(roomId),
  ]);
  const postWriteMs = durationSince(postWriteStartedAt);

  const message = publicMessage(inserted);
  const realtimeStartedAt = performance.now();
  await notifyRoomRealtime(env, roomId, {
    type: "room.message",
    envelopeId,
    serverSequence: Number(inserted.server_sequence),
    senderDeviceId: auth.device.device_id,
  }).catch((error) => console.warn("realtime notification failed", error));
  const realtimeMs = durationSince(realtimeStartedAt);
  const metrics = finalizeSendMetrics({
    duplicate: false,
    startedAt,
    contextMs,
    insertMs,
    postWriteMs,
    realtimeMs,
  });
  logSendMessagePerformance(requestId, roomId, inserted, metrics);
  return { message, metrics };
}

export async function listRoomMessages(
  env: Env,
  auth: AuthContext,
  roomId: string,
  url: URL,
): Promise<unknown[]> {
  await requireRoomMembership(env, auth, roomId);
  const after = numberParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = numberParam(url, "limit", 1, 200, 50);
  const result = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM message_envelopes
     WHERE room_id = ? AND server_sequence > ? AND state != 'purged' AND expires_at > CURRENT_TIMESTAMP
     ORDER BY server_sequence ASC
     LIMIT ?`,
  )
    .bind(roomId, after, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}

export async function acknowledgeMessage(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const status =
    stringField(body, "status", { max: 20 }) === "read" ? "read" : "stored";
  const message = await getMessage(env, envelopeId);
  if (!message || message.room_id !== roomId) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  const receiptId = randomId("rcp");
  await env.CONTROL_DB.prepare(
    `INSERT INTO delivery_receipts (
      receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id,
      recipient_device_id, status, stored_at, read_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ${status === "read" ? "CURRENT_TIMESTAMP" : "NULL"})
    ON CONFLICT(envelope_id, recipient_device_id) DO UPDATE SET
      status = excluded.status,
      stored_at = COALESCE(delivery_receipts.stored_at, CURRENT_TIMESTAMP),
      read_at = CASE WHEN excluded.status = 'read' THEN CURRENT_TIMESTAMP ELSE delivery_receipts.read_at END`,
  )
    .bind(
      receiptId,
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      status,
    )
    .run();
  await updateMessageReceiptState(env, envelopeId);
  return getReceipt(env, envelopeId, auth.device.device_id);
}

export async function syncAccount(
  env: Env,
  auth: AuthContext,
  url: URL,
): Promise<JsonObject> {
  const limit = numberParam(url, "limit", 1, 200, 50);
  const roomPage = await listRooms(env, auth, url);
  const pendingMessages = await listPendingMessages(env, auth, limit);
  return {
    rooms: roomPage.rooms,
    roomsNextCursor: roomPage.nextCursor,
    pendingMessages,
  };
}

export async function appBootstrap(
  env: Env,
  auth: AuthContext,
  url: URL,
  requestId: string,
): Promise<AppBootstrapResult> {
  const limit = numberParam(url, "limit", 1, 200, 100);
  const roomsStartedAt = performance.now();
  const roomPage = await listRooms(env, auth, url);
  const roomsMs = durationSince(roomsStartedAt);
  const messagesStartedAt = performance.now();
  const pendingMessages = await listPendingMessages(env, auth, limit);
  const messagesMs = durationSince(messagesStartedAt);
  return {
    bootstrap: {
      account: publicAccount(auth.account),
      principal: publicPrincipal(auth.principal),
      device: publicDevice(auth.device),
      roles: auth.roles,
      rooms: roomPage.rooms,
      roomsNextCursor: roomPage.nextCursor,
      pendingMessages,
      serverTime: new Date().toISOString(),
      requestId,
    },
    metrics: { roomsMs, messagesMs },
  };
}

export async function listPendingMessages(
  env: Env,
  auth: AuthContext,
  limit: number,
): Promise<JsonObject[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT me.*
     FROM delivery_receipts dr
     JOIN message_envelopes me ON me.envelope_id = dr.envelope_id
     WHERE dr.recipient_device_id = ?
       AND dr.status = 'pending'
       AND me.expires_at > CURRENT_TIMESTAMP
       AND me.state != 'purged'
     ORDER BY me.server_received_at ASC
     LIMIT ?`,
  )
    .bind(auth.device.device_id, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}

export async function allocateAttachment(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const policy = await getPolicy(env, auth.account.policy_id);
  const expectedBytes = numberField(
    body,
    "expectedBytes",
    1,
    policy.maximum_attachment_bytes,
  );
  const attachmentId = randomId("att");
  const objectKey = `attachments/${roomId}/${attachmentId}`;
  const expiresAt = sqliteTimestamp(
    Date.now() + DEFAULT_ATTACHMENT_DAYS * 24 * 60 * 60 * 1000,
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO attachments (
      attachment_id, room_id, uploader_account_id, uploader_principal_id, uploader_device_id,
      object_key, state, expected_bytes, content_category, retention_class, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?, ?)`,
  )
    .bind(
      attachmentId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      objectKey,
      expectedBytes,
      stringField(body, "contentCategory", { max: 80 }) ?? "opaque",
      stringField(body, "retentionClass", { max: 40 }) ?? "default",
      expiresAt,
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function uploadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  request: Request,
): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state !== "allocated" && attachment.state !== "uploaded") {
    throw new HttpError(
      409,
      "attachment_not_uploadable",
      "Attachment is not uploadable",
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > attachment.expected_bytes) {
    throw new HttpError(
      413,
      "attachment_too_large",
      "Attachment body exceeds allocation",
    );
  }
  await env.ATTACHMENTS_BUCKET.put(attachment.object_key, body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { attachmentId, roomId: attachment.room_id },
  });
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET state = 'uploaded', ciphertext_bytes = ?, uploaded_at = CURRENT_TIMESTAMP WHERE attachment_id = ?",
  )
    .bind(body.byteLength, attachmentId)
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function completeAttachment(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state !== "uploaded" && attachment.state !== "referenced") {
    throw new HttpError(
      409,
      "attachment_not_uploaded",
      "Attachment has not been uploaded",
    );
  }
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET ciphertext_sha256 = COALESCE(?, ciphertext_sha256), ciphertext_bytes = COALESCE(?, ciphertext_bytes) WHERE attachment_id = ?",
  )
    .bind(
      stringField(body, "ciphertextSha256", { max: 128 }) ?? null,
      optionalNumberField(
        body,
        "ciphertextBytes",
        1,
        attachment.expected_bytes,
      ) ?? null,
      attachmentId,
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function downloadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
): Promise<Response> {
  const attachment = await getAttachment(env, attachmentId);
  await requireRoomMembership(env, auth, attachment.room_id);
  if (!["uploaded", "referenced"].includes(attachment.state)) {
    throw new HttpError(
      404,
      "attachment_not_available",
      "Attachment is not available",
    );
  }
  const object = await env.ATTACHMENTS_BUCKET.get(attachment.object_key);
  if (!object) {
    throw new HttpError(
      404,
      "attachment_blob_missing",
      "Attachment blob is missing",
    );
  }
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-attachment-id": attachment.attachment_id,
    },
  });
}

export async function deleteAttachment(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
): Promise<void> {
  const attachment = await getAttachment(env, attachmentId);
  const membership = await requireRoomMembership(env, auth, attachment.room_id);
  if (
    attachment.uploader_account_id !== auth.account.account_id &&
    !["owner", "admin"].includes(membership.role)
  ) {
    throw new HttpError(
      403,
      "forbidden",
      "Attachment deletion requires uploader or room admin",
    );
  }
  await env.ATTACHMENTS_BUCKET.delete(attachment.object_key);
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET state = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE attachment_id = ?",
  )
    .bind(attachmentId)
    .run();
}

export async function listSidebarCollections(
  env: Env,
  auth: AuthContext,
): Promise<unknown[]> {
  const collections = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collections WHERE account_id = ? ORDER BY sort_order ASC, created_at ASC",
  )
    .bind(auth.account.account_id)
    .all<Record<string, unknown>>();
  return publicSidebarCollections(env, collections.results ?? []);
}

export async function createSidebarCollection(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const collectionId = randomId("col");
  await env.CONTROL_DB.prepare(
    "INSERT INTO sidebar_collections (collection_id, account_id, name, sort_order, collapsed) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      collectionId,
      auth.account.account_id,
      stringField(body, "name", { required: true, min: 1, max: 80 })!,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
      booleanField(body, "collapsed") ? 1 : 0,
    )
    .run();
  return publicSidebarCollection(
    env,
    await getSidebarCollection(env, auth, collectionId),
  );
}

export async function updateSidebarCollection(
  env: Env,
  auth: AuthContext,
  collectionId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "UPDATE sidebar_collections SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order), collapsed = COALESCE(?, collapsed), updated_at = CURRENT_TIMESTAMP WHERE collection_id = ? AND account_id = ?",
  )
    .bind(
      stringField(body, "name", { max: 80 }) ?? null,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? null,
      body.collapsed === undefined
        ? null
        : booleanField(body, "collapsed")
          ? 1
          : 0,
      collectionId,
      auth.account.account_id,
    )
    .run();
  return publicSidebarCollection(
    env,
    await getSidebarCollection(env, auth, collectionId),
  );
}

export async function deleteSidebarCollection(
  env: Env,
  auth: AuthContext,
  collectionId: string,
): Promise<void> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "DELETE FROM sidebar_collections WHERE collection_id = ? AND account_id = ?",
  )
    .bind(collectionId, auth.account.account_id)
    .run();
}

export async function addSidebarCollectionItem(
  env: Env,
  auth: AuthContext,
  collectionId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await getSidebarCollection(env, auth, collectionId);
  const roomId = stringField(body, "roomId", { required: true, max: 80 })!;
  await requireRoomMembership(env, auth, roomId);
  const itemId = randomId("cit");
  await env.CONTROL_DB.prepare(
    `INSERT INTO sidebar_collection_items (item_id, collection_id, room_id, sort_order)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(collection_id, room_id) DO UPDATE SET sort_order = excluded.sort_order`,
  )
    .bind(
      itemId,
      collectionId,
      roomId,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
    )
    .run();
  return {
    collectionId,
    roomId,
    sortOrder: optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
  };
}

export async function deleteSidebarCollectionItem(
  env: Env,
  auth: AuthContext,
  collectionId: string,
  roomId: string,
): Promise<void> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "DELETE FROM sidebar_collection_items WHERE collection_id = ? AND room_id = ?",
  )
    .bind(collectionId, roomId)
    .run();
}

export async function createAgentRequest(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const requestId = randomId("agr");
  await env.CONTROL_DB.prepare(
    `INSERT INTO agent_requests (
      request_id, requester_account_id, requester_principal_id, desired_agent_name,
      summary, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'submitted', ?)`,
  )
    .bind(
      requestId,
      auth.account.account_id,
      auth.principal.principal_id,
      stringField(body, "desiredAgentName", {
        required: true,
        min: 1,
        max: 120,
      })!,
      stringField(body, "summary", { required: true, min: 1, max: 2000 })!,
      optionalJsonText(body, "metadata", 4096),
    )
    .run();
  return getAgentRequest(env, requestId);
}

export async function listOwnAgentRequests(
  env: Env,
  auth: AuthContext,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    "SELECT * FROM agent_requests WHERE requester_account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(auth.account.account_id, page.limit, page.offset)
    .all<Record<string, unknown>>();
  const requests = (result.results ?? []).map(publicAgentRequest);
  return { requests, nextCursor: nextCursor(requests.length, page) };
}

export async function listAdminAgentRequests(
  env: Env,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status");
  if (
    status &&
    ![
      "submitted",
      "under_review",
      "approved",
      "rejected",
      "provisioning",
      "active",
      "closed",
    ].includes(status)
  ) {
    throw new HttpError(
      400,
      "invalid_agent_request_status",
      "Unsupported agent request status",
    );
  }
  const where = status ? "WHERE status = ?" : "";
  const stmt = env.CONTROL_DB.prepare(
    `SELECT * FROM agent_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  );
  const result = status
    ? await stmt
        .bind(status, page.limit, page.offset)
        .all<Record<string, unknown>>()
    : await stmt.bind(page.limit, page.offset).all<Record<string, unknown>>();
  const requests = (result.results ?? []).map(publicAgentRequest);
  return { requests, nextCursor: nextCursor(requests.length, page) };
}

export async function reviewAgentRequest(
  env: Env,
  auth: AuthContext,
  requestId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const status = stringField(body, "status", { required: true, max: 40 })!;
  if (!["under_review", "approved", "rejected", "closed"].includes(status)) {
    throw new HttpError(
      400,
      "invalid_agent_request_status",
      "Unsupported agent request status",
    );
  }
  await env.CONTROL_DB.prepare(
    "UPDATE agent_requests SET status = ?, reviewed_by_account_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?",
  )
    .bind(status, auth.account.account_id, requestId)
    .run();
  return getAgentRequest(env, requestId);
}

export async function createAgentPrincipal(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const ownerPrincipalId =
    stringField(body, "ownerPrincipalId", { max: 80 }) ??
    auth.principal.principal_id;
  const owner = await getActivePrincipal(env, ownerPrincipalId);
  if (owner.principal_type !== "human") {
    throw new HttpError(
      400,
      "invalid_agent_owner",
      "Agent owner must be a human principal",
    );
  }
  const principalId = randomId("prn");
  await env.CONTROL_DB.prepare(
    `INSERT INTO principals (
      principal_id, account_id, principal_type, display_name, status, owner_principal_id
    ) VALUES (?, ?, 'agent', ?, 'active', ?)`,
  )
    .bind(
      principalId,
      owner.account_id,
      stringField(body, "displayName", { required: true, min: 1, max: 120 })!,
      ownerPrincipalId,
    )
    .run();
  const requestId = stringField(body, "requestId", { max: 80 });
  if (requestId) {
    await env.CONTROL_DB.prepare(
      "UPDATE agent_requests SET status = 'active', created_agent_principal_id = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?",
    )
      .bind(principalId, requestId)
      .run();
  }
  return publicPrincipal(await getActivePrincipal(env, principalId));
}

export async function listAdminRooms(env: Env, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status");
  if (status && !["active", "archived", "deleted"].includes(status)) {
    throw new HttpError(400, "invalid_room_status", "Room status is invalid");
  }
  const type = url.searchParams.get("type");
  if (type && !["direct", "group", "channel"].includes(type)) {
    throw new HttpError(400, "invalid_room_type", "Room type is invalid");
  }
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    filters.push("status = ?");
    binds.push(status);
  }
  if (type) {
    filters.push("type = ?");
    binds.push(type);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await env.CONTROL_DB.prepare(
    `SELECT * FROM rooms ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, page.limit, page.offset)
    .all<RoomRow>();
  const rooms = await Promise.all(
    (result.results ?? []).map((room) => publicRoomWithMembers(env, room)),
  );
  return { rooms, nextCursor: nextCursor(rooms.length, page) };
}

export async function listMaintenanceRuns(
  env: Env,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    "SELECT * FROM maintenance_runs ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(page.limit, page.offset)
    .all<Record<string, unknown>>();
  const runs = (result.results ?? []).map(publicMaintenanceRun);
  return { runs, nextCursor: nextCursor(runs.length, page) };
}

export async function runCleanup(
  env: Env,
  auth: AuthContext,
): Promise<JsonObject> {
  const expiredMessages = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE message_envelopes SET state = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND state NOT IN ('expired', 'purged')",
    ),
  );
  const expiredAttachments = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE attachments SET state = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND state IN ('allocated', 'uploaded', 'referenced')",
    ),
  );
  const expiredKeyPackages = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE device_key_packages SET status = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'available'",
    ),
  );
  const expiredRoomInvitations = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE room_invitations SET status = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'pending'",
    ),
  );
  const revokedCredentialResets = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE credential_reset_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE expires_at <= CURRENT_TIMESTAMP AND used_at IS NULL AND revoked_at IS NULL",
    ),
  );
  const revokedExpiredSessions = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE expires_at <= CURRENT_TIMESTAMP AND revoked_at IS NULL",
    ),
  );
  const deletedRealtimeTokens = await runCounted(
    env.CONTROL_DB.prepare(
      "DELETE FROM realtime_socket_tokens WHERE expires_at <= CURRENT_TIMESTAMP OR used_at IS NOT NULL OR revoked_at IS NOT NULL",
    ),
  );
  const deletedRateLimits = await runCounted(
    env.CONTROL_DB.prepare(
      "DELETE FROM rate_limits WHERE expires_at <= CURRENT_TIMESTAMP",
    ),
  );
  const cleanup = {
    maintenanceRunId: randomId("mrun"),
    action: "cleanup",
    expiredMessages,
    expiredAttachments,
    expiredKeyPackages,
    expiredRoomInvitations,
    revokedCredentialResets,
    revokedExpiredSessions,
    deletedRealtimeTokens,
    deletedRateLimits,
  };
  await env.CONTROL_DB.prepare(
    "INSERT INTO maintenance_runs (maintenance_run_id, action, actor_account_id, result, metadata_json) VALUES (?, 'cleanup', ?, 'success', ?)",
  )
    .bind(
      cleanup.maintenanceRunId,
      auth.account.account_id,
      JSON.stringify(cleanup),
    )
    .run();
  return cleanup;
}

export async function requireRoomMembership(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<MembershipRow> {
  const membership = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN rooms r ON r.room_id = rm.room_id
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.principal_id = ?
       AND rm.status = 'active'
       AND r.status != 'deleted'`,
  )
    .bind(roomId, auth.principal.principal_id)
    .first<MembershipRow>();
  if (!membership) {
    throw new HttpError(
      403,
      "room_membership_required",
      "Active room membership required",
    );
  }
  return membership;
}

export async function getSendRoomContext(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<SendRoomContext> {
  const context = await env.CONTROL_DB.prepare(
    `SELECT
       rm.*,
       p.principal_type,
       p.display_name,
       r.status AS room_status,
       policy.message_retention_days
     FROM room_memberships rm
     JOIN rooms r ON r.room_id = rm.room_id
     JOIN principals p ON p.principal_id = rm.principal_id
     JOIN policies policy ON policy.policy_id = ?
     WHERE rm.room_id = ?
       AND rm.principal_id = ?
       AND rm.status = 'active'
       AND r.status != 'deleted'`,
  )
    .bind(auth.account.policy_id, roomId, auth.principal.principal_id)
    .first<SendRoomContext>();
  if (!context) {
    throw new HttpError(
      403,
      "room_membership_required",
      "Active room membership required",
    );
  }
  return context;
}

export async function requireRoomManager(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<MembershipRow> {
  const membership = await requireRoomMembership(env, auth, roomId);
  if (!["owner", "admin"].includes(membership.role)) {
    throw new HttpError(403, "room_admin_required", "Room admin role required");
  }
  return membership;
}

export async function requireRoomOwner(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<MembershipRow> {
  const membership = await requireRoomMembership(env, auth, roomId);
  if (membership.role !== "owner") {
    throw new HttpError(403, "room_owner_required", "Room owner role required");
  }
  return membership;
}

export async function getActivePrincipal(
  env: Env,
  principalId: string,
): Promise<PrincipalRecord> {
  const principal = await env.CONTROL_DB.prepare(
    `SELECT p.*, a.status AS account_status
     FROM principals p
     JOIN accounts a ON a.account_id = p.account_id
     WHERE p.principal_id = ? AND p.status = 'active'`,
  )
    .bind(principalId)
    .first<PrincipalRecord>();
  if (!principal || principal.account_status !== "active") {
    throw new HttpError(
      404,
      "principal_not_found",
      "Active principal not found",
    );
  }
  return principal;
}

export async function getActivePrincipals(
  env: Env,
  principalIds: string[],
): Promise<PrincipalRecord[]> {
  const principals = [];
  for (const principalId of principalIds) {
    principals.push(await getActivePrincipal(env, principalId));
  }
  return principals;
}

export async function getRoom(env: Env, roomId: string): Promise<RoomRow> {
  const room = await env.CONTROL_DB.prepare(
    "SELECT * FROM rooms WHERE room_id = ?",
  )
    .bind(roomId)
    .first<RoomRow>();
  if (!room) throw new HttpError(404, "room_not_found", "Room not found");
  return room;
}

export async function requireActiveRoom(
  env: Env,
  roomId: string,
): Promise<RoomRow> {
  const room = await getRoom(env, roomId);
  if (room.status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  return room;
}

export async function requireRoomInvitationInRoom(
  env: Env,
  roomId: string,
  roomInvitationId: string,
): Promise<string> {
  const invitation = await getRoomInvitation(env, roomInvitationId);
  if (invitation.room_id !== roomId) {
    throw new HttpError(
      404,
      "room_invitation_not_found",
      "Room invitation not found",
    );
  }
  return roomInvitationId;
}

export async function insertMembership(
  env: Env,
  roomId: string,
  principal: PrincipalRecord,
  role: MembershipRow["role"],
  invitedByPrincipalId: string,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_memberships (
      membership_id, room_id, account_id, principal_id, role, status, invited_by_principal_id
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(
      randomId("mem"),
      roomId,
      principal.account_id,
      principal.principal_id,
      role,
      invitedByPrincipalId,
    )
    .run();
}

export async function upsertMembership(
  env: Env,
  roomId: string,
  principal: PrincipalRecord,
  role: MembershipRow["role"],
  invitedByPrincipalId: string,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_memberships (
      membership_id, room_id, account_id, principal_id, role, status, invited_by_principal_id
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(room_id, principal_id) DO UPDATE SET
      role = excluded.role,
      status = 'active',
      removed_at = NULL,
      updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      randomId("mem"),
      roomId,
      principal.account_id,
      principal.principal_id,
      role,
      invitedByPrincipalId,
    )
    .run();
}

export async function getMembership(
  env: Env,
  roomId: string,
  principalId: string,
): Promise<MembershipRow> {
  const membership = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ? AND rm.principal_id = ?`,
  )
    .bind(roomId, principalId)
    .first<MembershipRow>();
  if (!membership)
    throw new HttpError(
      404,
      "membership_not_found",
      "Room membership not found",
    );
  return membership;
}

export async function getRoomInvitation(
  env: Env,
  roomInvitationId: string,
): Promise<RoomInvitationRow> {
  const invitation = await env.CONTROL_DB.prepare(
    `SELECT ri.*, r.name AS room_name, r.type AS room_type, p.display_name AS invited_by_display_name
     FROM room_invitations ri
     JOIN rooms r ON r.room_id = ri.room_id
     JOIN principals p ON p.principal_id = ri.invited_by_principal_id
     WHERE ri.room_invitation_id = ?`,
  )
    .bind(roomInvitationId)
    .first<RoomInvitationRow>();
  if (!invitation)
    throw new HttpError(
      404,
      "room_invitation_not_found",
      "Room invitation not found",
    );
  return invitation;
}

export async function getPendingRoomInvitationForPrincipal(
  env: Env,
  roomInvitationId: string,
  principalId: string,
): Promise<RoomInvitationRow> {
  const invitation = await env.CONTROL_DB.prepare(
    `SELECT ri.*, r.name AS room_name, r.type AS room_type, p.display_name AS invited_by_display_name
     FROM room_invitations ri
     JOIN rooms r ON r.room_id = ri.room_id
     JOIN principals p ON p.principal_id = ri.invited_by_principal_id
     WHERE ri.room_invitation_id = ?
       AND ri.invited_principal_id = ?
       AND ri.status = 'pending'
       AND ri.expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(roomInvitationId, principalId)
    .first<RoomInvitationRow>();
  if (!invitation)
    throw new HttpError(
      404,
      "room_invitation_not_found",
      "Pending room invitation not found",
    );
  return invitation;
}

export async function publicRoomWithMembers(
  env: Env,
  room: RoomRow,
): Promise<JsonObject> {
  const members = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ?
     ORDER BY rm.created_at ASC`,
  )
    .bind(room.room_id)
    .all<MembershipRow>();
  return publicRoomFromMembers(room, members.results ?? []);
}

export async function publicRoomsWithMembers(
  env: Env,
  rooms: RoomRow[],
): Promise<JsonObject[]> {
  if (!rooms.length) return [];
  const placeholders = rooms.map(() => "?").join(", ");
  const members = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id IN (${placeholders})
     ORDER BY rm.room_id ASC, rm.created_at ASC`,
  )
    .bind(...rooms.map((room) => room.room_id))
    .all<MembershipRow>();
  const grouped = new Map<string, MembershipRow[]>();
  for (const member of members.results ?? []) {
    const group = grouped.get(member.room_id) ?? [];
    group.push(member);
    grouped.set(member.room_id, group);
  }
  return rooms.map((room) =>
    publicRoomFromMembers(room, grouped.get(room.room_id) ?? []),
  );
}

export function publicRoomFromMembers(
  room: RoomRow,
  members: MembershipRow[],
): JsonObject {
  return { ...publicRoom(room), members: members.map(publicMembership) };
}

export async function bumpRoom(env: Env, roomId: string): Promise<void> {
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
  )
    .bind(roomId)
    .run();
}

export async function ensureAnotherHumanOwner(
  env: Env,
  roomId: string,
  excludedPrincipalId: string,
): Promise<void> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND rm.role = 'owner'
       AND p.principal_type = 'human'
       AND rm.principal_id != ?`,
  )
    .bind(roomId, excludedPrincipalId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) < 1) {
    throw new HttpError(
      409,
      "last_owner_required",
      "Room must keep at least one active human owner",
    );
  }
}

export async function enforceMemberQuota(
  env: Env,
  roomId: string,
): Promise<void> {
  const room = await getRoom(env, roomId);
  const owner = await env.CONTROL_DB.prepare(
    "SELECT policy_id FROM accounts WHERE account_id = ?",
  )
    .bind(room.created_by_account_id)
    .first<{ policy_id: string }>();
  const policy = await getPolicy(env, owner?.policy_id ?? "pol_default");
  const active = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND status = 'active'",
  )
    .bind(roomId)
    .first<{ count: number }>();
  const pending = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM room_invitations WHERE room_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP",
  )
    .bind(roomId)
    .first<{ count: number }>();
  if (
    (active?.count ?? 0) + (pending?.count ?? 0) >=
    policy.maximum_group_memberships
  ) {
    throw new HttpError(
      409,
      "room_member_quota_reached",
      "Maximum room member count reached",
    );
  }
}

export async function countOwnedGroups(
  env: Env,
  principalId: string,
): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM room_memberships rm
     JOIN rooms r ON r.room_id = rm.room_id
     WHERE rm.principal_id = ?
       AND rm.status = 'active'
       AND rm.role = 'owner'
       AND r.type = 'group'
       AND r.status = 'active'`,
  )
    .bind(principalId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getPolicy(
  env: Env,
  policyId: string,
): Promise<PolicyRow> {
  const policy = await env.CONTROL_DB.prepare(
    "SELECT * FROM policies WHERE policy_id = ?",
  )
    .bind(policyId)
    .first<PolicyRow>();
  if (!policy) throw new HttpError(404, "policy_not_found", "Policy not found");
  return policy;
}

export async function getOwnershipTransfer(
  env: Env,
  transferId: string,
): Promise<JsonObject> {
  const transfer = await env.CONTROL_DB.prepare(
    "SELECT * FROM ownership_transfers WHERE transfer_id = ?",
  )
    .bind(transferId)
    .first<Record<string, unknown>>();
  if (!transfer)
    throw new HttpError(
      404,
      "ownership_transfer_not_found",
      "Ownership transfer not found",
    );
  return {
    transferId: transfer.transfer_id,
    roomId: transfer.room_id,
    fromPrincipalId: transfer.from_principal_id,
    toPrincipalId: transfer.to_principal_id,
    status: transfer.status,
    expiresAt: transfer.expires_at,
    createdAt: transfer.created_at,
    respondedAt: transfer.responded_at,
  };
}

export async function createDeliveryReceipts(
  env: Env,
  roomId: string,
  envelopeId: string,
  senderDeviceId: string,
): Promise<void> {
  await createDeliveryReceiptStatement(
    env,
    roomId,
    envelopeId,
    senderDeviceId,
  ).run();
}

export function createDeliveryReceiptStatement(
  env: Env,
  roomId: string,
  envelopeId: string,
  senderDeviceId: string,
): D1PreparedStatement {
  return env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO delivery_receipts (
       receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id, recipient_device_id, status
     )
     SELECT
       'rcp_' || lower(hex(randomblob(18))),
       ?,
       ?,
       rm.account_id,
       rm.principal_id,
       d.device_id,
       'pending'
     FROM room_memberships rm
     JOIN accounts a ON a.account_id = rm.account_id
     JOIN devices d ON d.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND a.status = 'active'
       AND d.revoked_at IS NULL
       AND d.device_id != ?`,
  ).bind(envelopeId, roomId, roomId, senderDeviceId);
}

export async function markAttachmentsReferenced(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): Promise<void> {
  await Promise.all(
    markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds).map(
      (statement) => statement.run(),
    ),
  );
}

export function markAttachmentsReferencedStatements(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): D1PreparedStatement[] {
  const ids = uniqueStrings(attachmentIds);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return [
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'referenced', referenced_at = CURRENT_TIMESTAMP
       WHERE attachment_id IN (${placeholders})
         AND room_id = ?
         AND uploader_account_id = ?
         AND state = 'uploaded'`,
    ).bind(...ids, roomId, auth.account.account_id),
  ];
}

export async function getMessage(
  env: Env,
  envelopeId: string,
): Promise<Record<string, unknown> | null> {
  return env.CONTROL_DB.prepare(
    "SELECT * FROM message_envelopes WHERE envelope_id = ?",
  )
    .bind(envelopeId)
    .first<Record<string, unknown>>();
}

export async function updateMessageReceiptState(
  env: Env,
  envelopeId: string,
): Promise<void> {
  const pending = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM delivery_receipts WHERE envelope_id = ? AND status = 'pending'",
  )
    .bind(envelopeId)
    .first<{ count: number }>();
  const total = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM delivery_receipts WHERE envelope_id = ?",
  )
    .bind(envelopeId)
    .first<{ count: number }>();
  const state =
    (total?.count ?? 0) === 0 || (pending?.count ?? 0) === 0
      ? "fully_acknowledged"
      : "partially_acknowledged";
  await env.CONTROL_DB.prepare(
    "UPDATE message_envelopes SET state = ? WHERE envelope_id = ?",
  )
    .bind(state, envelopeId)
    .run();
}

export async function getReceipt(
  env: Env,
  envelopeId: string,
  deviceId: string,
): Promise<JsonObject> {
  const receipt = await env.CONTROL_DB.prepare(
    "SELECT * FROM delivery_receipts WHERE envelope_id = ? AND recipient_device_id = ?",
  )
    .bind(envelopeId, deviceId)
    .first<Record<string, unknown>>();
  if (!receipt)
    throw new HttpError(404, "receipt_not_found", "Delivery receipt not found");
  return {
    receiptId: receipt.receipt_id,
    envelopeId: receipt.envelope_id,
    roomId: receipt.room_id,
    recipientDeviceId: receipt.recipient_device_id,
    status: receipt.status,
    storedAt: receipt.stored_at,
    readAt: receipt.read_at,
  };
}

export async function getAttachment(
  env: Env,
  attachmentId: string,
): Promise<AttachmentRow> {
  const attachment = await env.CONTROL_DB.prepare(
    "SELECT * FROM attachments WHERE attachment_id = ?",
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!attachment)
    throw new HttpError(404, "attachment_not_found", "Attachment not found");
  return attachment;
}

export function ensureAttachmentUploader(
  auth: AuthContext,
  attachment: AttachmentRow,
): void {
  if (
    attachment.uploader_account_id !== auth.account.account_id ||
    attachment.uploader_device_id !== auth.device.device_id
  ) {
    throw new HttpError(
      403,
      "attachment_uploader_required",
      "Only the allocating device can upload or complete this attachment",
    );
  }
}

export async function getSidebarCollection(
  env: Env,
  auth: AuthContext,
  collectionId: string,
): Promise<Record<string, unknown>> {
  const collection = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collections WHERE collection_id = ? AND account_id = ?",
  )
    .bind(collectionId, auth.account.account_id)
    .first<Record<string, unknown>>();
  if (!collection)
    throw new HttpError(
      404,
      "collection_not_found",
      "Sidebar collection not found",
    );
  return collection;
}

export async function publicSidebarCollection(
  env: Env,
  collection: Record<string, unknown>,
): Promise<JsonObject> {
  const items = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collection_items WHERE collection_id = ? ORDER BY sort_order ASC, created_at ASC",
  )
    .bind(collection.collection_id)
    .all<Record<string, unknown>>();
  return publicSidebarCollectionFromItems(collection, items.results ?? []);
}

export async function publicSidebarCollections(
  env: Env,
  collections: Record<string, unknown>[],
): Promise<JsonObject[]> {
  if (!collections.length) return [];
  const placeholders = collections.map(() => "?").join(", ");
  const items = await env.CONTROL_DB.prepare(
    `SELECT * FROM sidebar_collection_items
     WHERE collection_id IN (${placeholders})
     ORDER BY collection_id ASC, sort_order ASC, created_at ASC`,
  )
    .bind(...collections.map((collection) => collection.collection_id))
    .all<Record<string, unknown>>();
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of items.results ?? []) {
    const collectionId = String(item.collection_id);
    const group = grouped.get(collectionId) ?? [];
    group.push(item);
    grouped.set(collectionId, group);
  }
  return collections.map((collection) =>
    publicSidebarCollectionFromItems(
      collection,
      grouped.get(String(collection.collection_id)) ?? [],
    ),
  );
}

export function publicSidebarCollectionFromItems(
  collection: Record<string, unknown>,
  items: Record<string, unknown>[],
): JsonObject {
  return {
    collectionId: collection.collection_id,
    accountId: collection.account_id,
    name: collection.name,
    sortOrder: collection.sort_order,
    collapsed: Boolean(collection.collapsed),
    createdAt: collection.created_at,
    updatedAt: collection.updated_at,
    items: items.map((item) => ({
      itemId: item.item_id,
      roomId: item.room_id,
      sortOrder: item.sort_order,
      createdAt: item.created_at,
    })),
  };
}

export async function getAgentRequest(
  env: Env,
  requestId: string,
): Promise<JsonObject> {
  const request = await env.CONTROL_DB.prepare(
    "SELECT * FROM agent_requests WHERE request_id = ?",
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!request)
    throw new HttpError(
      404,
      "agent_request_not_found",
      "Agent request not found",
    );
  return publicAgentRequest(request);
}

export function normalizedRole(
  role: string | undefined,
  principalType: PrincipalRow["principal_type"],
): MembershipRow["role"] {
  if (principalType === "agent") return "agent";
  if (!role) return "member";
  if (["owner", "admin", "member"].includes(role))
    return role as MembershipRow["role"];
  throw new HttpError(400, "invalid_room_role", "Room role is invalid");
}

export function normalizedInvitationRole(
  role: string | undefined,
): RoomInvitationRow["role"] {
  if (!role) return "member";
  if (role === "admin" || role === "member") return role;
  throw new HttpError(
    400,
    "invalid_room_invitation_role",
    "Room invitation role must be admin or member",
  );
}

export function publicRoom(room: RoomRow): JsonObject {
  return {
    roomId: room.room_id,
    type: room.type,
    name: room.name,
    description: room.description,
    status: room.status,
    version: room.version,
    createdByAccountId: room.created_by_account_id,
    createdByPrincipalId: room.created_by_principal_id,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
    archivedAt: room.archived_at,
  };
}

export function publicMembership(membership: MembershipRow): JsonObject {
  return {
    membershipId: membership.membership_id,
    roomId: membership.room_id,
    accountId: membership.account_id,
    principalId: membership.principal_id,
    principalType: membership.principal_type,
    displayName: membership.display_name,
    role: membership.role,
    status: membership.status,
    createdAt: membership.created_at,
    updatedAt: membership.updated_at,
    removedAt: membership.removed_at,
  };
}

export function publicRoomInvitation(
  invitation: RoomInvitationRow,
): JsonObject {
  return {
    roomInvitationId: invitation.room_invitation_id,
    roomId: invitation.room_id,
    roomName: invitation.room_name,
    roomType: invitation.room_type,
    invitedAccountId: invitation.invited_account_id,
    invitedPrincipalId: invitation.invited_principal_id,
    invitedByAccountId: invitation.invited_by_account_id,
    invitedByPrincipalId: invitation.invited_by_principal_id,
    invitedByDisplayName: invitation.invited_by_display_name,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    respondedAt: invitation.responded_at,
    createdAt: invitation.created_at,
  };
}

export function publicPrincipal(principal: PrincipalRow): JsonObject {
  return {
    principalId: principal.principal_id,
    accountId: principal.account_id,
    principalType: principal.principal_type,
    displayName: principal.display_name,
    avatarRef: principal.avatar_ref,
    status: principal.status,
    ownerPrincipalId: principal.owner_principal_id,
    createdAt: principal.created_at,
    revokedAt: principal.revoked_at,
  };
}

export function publicDevice(device: DeviceRow): JsonObject {
  return {
    deviceId: device.device_id,
    accountId: device.account_id,
    principalId: device.principal_id,
    platform: device.platform,
    label: device.device_label,
    credentialFingerprint: device.credential_fingerprint,
    credentialVersion: device.credential_version,
    publicKeyPackage: device.public_key_package,
    notificationCapability: device.notification_capability,
    clientVersion: device.client_version,
    protocolVersion: device.protocol_version,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
    revocationReason: device.revocation_reason,
  };
}

export function publicKeyPackage(row: Record<string, unknown>): JsonObject {
  return {
    keyPackageId: row.key_package_id,
    accountId: row.account_id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    protocol: row.protocol,
    publicIdentityKey: row.public_identity_key,
    signedPrekey: row.signed_prekey,
    oneTimePrekey: row.one_time_prekey,
    package: parseJson(row.package_json),
    status: row.status,
    claimedByDeviceId: row.claimed_by_device_id,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
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

export function publicMessage(row: Record<string, unknown>): JsonObject {
  return {
    envelopeId: row.envelope_id,
    roomId: row.room_id,
    senderAccountId: row.sender_account_id,
    senderPrincipalId: row.sender_principal_id,
    senderDeviceId: row.sender_device_id,
    idempotencyKey: row.idempotency_key,
    protocolType: row.protocol_type,
    ciphertext: row.ciphertext,
    ciphertextBytes: row.ciphertext_bytes,
    clientCreatedAt: row.client_created_at,
    serverSequence: row.server_sequence,
    serverReceivedAt: row.server_received_at,
    expiresAt: row.expires_at,
    state: row.state,
  };
}

export function publicAttachment(attachment: AttachmentRow): JsonObject {
  return {
    attachmentId: attachment.attachment_id,
    roomId: attachment.room_id,
    uploaderAccountId: attachment.uploader_account_id,
    uploaderPrincipalId: attachment.uploader_principal_id,
    uploaderDeviceId: attachment.uploader_device_id,
    state: attachment.state,
    expectedBytes: attachment.expected_bytes,
    ciphertextBytes: attachment.ciphertext_bytes,
    ciphertextSha256: attachment.ciphertext_sha256,
    contentCategory: attachment.content_category,
    retentionClass: attachment.retention_class,
    expiresAt: attachment.expires_at,
    createdAt: attachment.created_at,
    uploadedAt: attachment.uploaded_at,
    referencedAt: attachment.referenced_at,
    deletedAt: attachment.deleted_at,
  };
}

export function publicAgentRequest(row: Record<string, unknown>): JsonObject {
  return {
    requestId: row.request_id,
    requesterAccountId: row.requester_account_id,
    requesterPrincipalId: row.requester_principal_id,
    desiredAgentName: row.desired_agent_name,
    summary: row.summary,
    status: row.status,
    metadata: parseJson(row.metadata_json),
    reviewedByAccountId: row.reviewed_by_account_id,
    reviewedAt: row.reviewed_at,
    createdAgentPrincipalId: row.created_agent_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicMaintenanceRun(row: Record<string, unknown>): JsonObject {
  return {
    maintenanceRunId: row.maintenance_run_id,
    action: row.action,
    actorAccountId: row.actor_account_id,
    result: row.result,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

export function stringArrayField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxItems?: number } = {},
): string[] {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required)
      throw new HttpError(
        400,
        "missing_field",
        `Missing required field: ${key}`,
      );
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    )
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be an array of strings: ${key}`,
    );
  }
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new HttpError(
      400,
      "invalid_field",
      `Too many items for field: ${key}`,
    );
  }
  return value.map((entry) => entry.trim());
}

export function requiredJsonText(
  body: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string {
  const value = body[key];
  if (value === undefined || value === null)
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) > maxBytes)
    throw new HttpError(413, "json_too_large", `Field is too large: ${key}`);
  return text;
}

export function optionalJsonText(
  body: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) > maxBytes)
    throw new HttpError(413, "json_too_large", `Field is too large: ${key}`);
  return text;
}

export function numberField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const value = body[key];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be an integer between ${min} and ${max}: ${key}`,
    );
  }
  return value;
}

export function optionalNumberField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be an integer between ${min} and ${max}: ${key}`,
    );
  }
  return value;
}

export function booleanField(
  body: Record<string, unknown>,
  key: string,
): boolean {
  const value = body[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean")
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be a boolean: ${key}`,
    );
  return value;
}

export function numberParam(
  url: URL,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = url.searchParams.get(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(
      400,
      "invalid_query",
      `Query parameter must be an integer between ${min} and ${max}: ${key}`,
    );
  }
  return parsed;
}

export function pageParams(
  url: URL | undefined,
  options: { defaultLimit: number; maxLimit: number },
): PageParams {
  const limit = url
    ? numberParam(url, "limit", 1, options.maxLimit, options.defaultLimit)
    : options.defaultLimit;
  const cursor = url?.searchParams.get("cursor");
  if (!cursor) return { limit, offset: 0 };
  const offset = Number(cursor);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > Number.MAX_SAFE_INTEGER
  ) {
    throw new HttpError(400, "invalid_cursor", "Cursor is invalid");
  }
  return { limit, offset };
}

export function nextCursor(
  resultCount: number,
  page: PageParams,
): string | null {
  return resultCount === page.limit ? String(page.offset + page.limit) : null;
}

export function sendMessageTimingHeaders(
  metrics: SendMessageMetrics,
): Record<string, string> {
  return {
    "server-timing": serverTimingHeader([
      ["message", metrics.totalMs],
      ["conversationDo", metrics.conversationDoMs],
      ["conversationQueue", metrics.conversationQueueMs],
      ["conversationOperation", metrics.conversationOperationMs],
      ["context", metrics.contextMs],
      ["insert", metrics.insertMs],
      ["postwrite", metrics.postWriteMs],
      ["realtime", metrics.realtimeMs],
    ]),
  };
}

export function mutationTimingHeaders(
  routeName: string,
  metrics: ConversationMutationMetrics,
): Record<string, string> {
  return {
    "server-timing": serverTimingHeader([
      [routeName, metrics.totalMs],
      ["conversationDo", metrics.totalMs],
      ["conversationQueue", metrics.queueMs],
      ["conversationOperation", metrics.operationMs],
    ]),
  };
}

export function readTimingHeaders(
  routeName: string,
  authMs: number,
  startedAt: number,
  extra: Array<[string, number]> = [],
): Record<string, string> {
  const readMs = durationSince(startedAt);
  return {
    "server-timing": serverTimingHeader([
      [routeName, authMs + readMs],
      ["auth", authMs],
      ["read", readMs],
      ...extra,
    ]),
  };
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function finalizeSendMetrics(input: {
  duplicate: boolean;
  startedAt: number;
  contextMs: number;
  insertMs: number;
  postWriteMs: number;
  realtimeMs: number;
}): SendMessageMetrics {
  return {
    duplicate: input.duplicate,
    totalMs: durationSince(input.startedAt),
    contextMs: input.contextMs,
    insertMs: input.insertMs,
    postWriteMs: input.postWriteMs,
    realtimeMs: input.realtimeMs,
  };
}

export function logSendMessagePerformance(
  requestId: string,
  roomId: string,
  message: Record<string, unknown>,
  metrics: SendMessageMetrics,
): void {
  console.info("message.send.performance", {
    requestId,
    roomId,
    envelopeId: message.envelope_id,
    serverSequence: message.server_sequence,
    ...metrics,
  });
}

export function durationSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export async function runCounted(
  statement: D1PreparedStatement,
): Promise<number> {
  const result = await statement.run();
  const meta = result.meta as { changes?: number } | undefined;
  return meta?.changes ?? 0;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function sqliteTimestamp(value: number | Date): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
