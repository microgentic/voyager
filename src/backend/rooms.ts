import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, Env, PolicyRow, PrincipalRow } from "../types";
import {
  OWNERSHIP_TRANSFER_DAYS,
  ROOM_INVITATION_DAYS,
  type JsonObject,
  type MembershipRow,
  type PrincipalRecord,
  type RoomInvitationRow,
  type RoomRow,
  type SendRoomContext,
} from "./internal-types";
import {
  nextCursor,
  numberField,
  pageParams,
  sqliteTimestamp,
  stringArrayField,
  uniqueStrings,
} from "./utils";
import {
  publicMembership,
  publicRoom,
  publicRoomInvitation,
} from "./serializers";

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
