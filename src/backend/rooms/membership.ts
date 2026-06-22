import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import type { AuthContext, Env, PrincipalRow } from "../../types";
import type { JsonObject } from "../shared/types";
import {
  enforceMemberQuota,
  ensureAnotherHumanOwner,
  requireRoomManager,
  requireRoomMembership,
  requireRoomOwner,
} from "./authorization";
import { bumpRoom, getActivePrincipal, getRoom } from "./reads";
import { publicMembership } from "./serializers";
import type { MembershipRow, PrincipalRecord } from "./types";

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
