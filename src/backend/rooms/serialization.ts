import type { Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { publicMembership, publicRoom } from "./serializers";
import type { MembershipRow, RoomRow } from "./types";

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
