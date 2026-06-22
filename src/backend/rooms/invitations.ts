import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { nextCursor, numberField, pageParams, sqliteTimestamp } from "../utils";
import { enforceMemberQuota, requireRoomManager } from "./authorization";
import { upsertMembership } from "./membership";
import { bumpRoom, getActivePrincipal, getRoom } from "./reads";
import { publicRoomInvitation } from "./serializers";
import { ROOM_INVITATION_DAYS, type RoomInvitationRow } from "./types";

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
