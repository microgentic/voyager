import { HttpError } from "../../http";
import type { AuthContext, Env, PolicyRow } from "../../types";
import type { JsonObject } from "../shared/types";
import { nextCursor, pageParams } from "../utils";
import type { PrincipalRecord, RoomRow } from "./types";
import { publicRoomsWithMembers } from "./serialization";

export function roomSelectColumns(alias = "r"): string {
  return `${alias}.*,
    (SELECT COUNT(*) FROM message_pins mp WHERE mp.room_id = ${alias}.room_id AND mp.unpinned_at IS NULL) AS pinned_message_count,
    (SELECT mp.envelope_id FROM message_pins mp WHERE mp.room_id = ${alias}.room_id AND mp.unpinned_at IS NULL ORDER BY mp.pinned_at DESC LIMIT 1) AS latest_pinned_message_id`;
}

export async function listRooms(
  env: Env,
  auth: AuthContext,
  url?: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT ${roomSelectColumns("r")}
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
    `SELECT ${roomSelectColumns("r")} FROM rooms r WHERE r.room_id = ?`,
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

export async function bumpRoom(env: Env, roomId: string): Promise<void> {
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
  )
    .bind(roomId)
    .run();
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
