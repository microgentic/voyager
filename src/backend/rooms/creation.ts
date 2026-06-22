import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import { notifyRoomRealtime } from "../../realtime";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { sqliteTimestamp, stringArrayField, uniqueStrings } from "../utils";
import { requireRoomManager, requireRoomOwner } from "./authorization";
import { insertMembership } from "./membership";
import {
  countOwnedGroups,
  getActivePrincipals,
  getPolicy,
  getRoom,
} from "./reads";
import { publicRoomWithMembers } from "./serialization";
import type { PrincipalRecord, RoomRow } from "./types";

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
  const liveCalls = await env.CONTROL_DB.prepare(
    "SELECT call_id, call_type FROM calls WHERE room_id = ? AND status IN ('ringing', 'active')",
  )
    .bind(roomId)
    .all<{ call_id: string; call_type: "audio" | "video" }>();
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET status = 'archived', archived_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND status = 'active'",
  )
    .bind(roomId)
    .run();
  await endLiveCallsForArchivedRoom(env, roomId, liveCalls.results ?? []);
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

async function endLiveCallsForArchivedRoom(
  env: Env,
  roomId: string,
  liveCalls: Array<{ call_id: string; call_type: "audio" | "video" }>,
): Promise<void> {
  if (!liveCalls.length) return;
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE calls
       SET status = 'ended',
           ended_reason = 'room_archived',
           ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE room_id = ? AND status IN ('ringing', 'active')`,
    ).bind(roomId),
    env.CONTROL_DB.prepare(
      `UPDATE call_participants
       SET status = CASE
             WHEN status IN ('invited', 'ringing', 'joining') THEN 'missed'
             WHEN status = 'connected' THEN 'left'
             ELSE status
           END,
           left_at = CASE WHEN left_at IS NULL AND status = 'connected' THEN CURRENT_TIMESTAMP ELSE left_at END,
           muted_at = NULL,
           audio_enabled = 0,
           video_enabled = 0,
           screen_enabled = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE call_id IN (SELECT call_id FROM calls WHERE room_id = ?)
         AND status IN ('invited', 'ringing', 'joining', 'connected')`,
    ).bind(roomId),
    env.CONTROL_DB.prepare(
      `UPDATE call_realtime_tracks
       SET status = 'closed',
           closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE call_id IN (SELECT call_id FROM calls WHERE room_id = ?)
         AND status = 'active'`,
    ).bind(roomId),
    env.CONTROL_DB.prepare(
      `UPDATE call_realtime_sessions
       SET status = 'closed',
           closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE call_id IN (SELECT call_id FROM calls WHERE room_id = ?)
         AND status = 'active'`,
    ).bind(roomId),
  ]);
  for (const call of liveCalls) {
    await env.CONTROL_DB.prepare(
      `INSERT INTO call_events (
        call_event_id, call_id, actor_account_id, actor_principal_id,
        actor_device_id, event_type, payload_json
      ) VALUES (?, ?, NULL, NULL, NULL, 'call.ended', ?)`,
    )
      .bind(
        randomId("cevt"),
        call.call_id,
        JSON.stringify({ roomId, status: "ended", reason: "room_archived" }),
      )
      .run();
    await notifyRoomRealtime(env, roomId, {
      type: "call.ended",
      callId: call.call_id,
      callType: call.call_type,
      endedReason: "room_archived",
    });
    await notifyRoomRealtime(env, roomId, {
      type: "call.updated",
      callId: call.call_id,
      callType: call.call_type,
      status: "ended",
    });
  }
}
