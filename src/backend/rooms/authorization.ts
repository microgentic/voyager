import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { publicRoomWithMembers } from "./serialization";
import type { MembershipRow, SendRoomContext } from "./types";
import { getPolicy, getRoom } from "./reads";

export async function getRoomForMember(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  return publicRoomWithMembers(env, await getRoom(env, roomId));
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
