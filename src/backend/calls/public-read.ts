import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { CallParticipantRow, CallRow, JsonObject } from "../internal-types";
import { requireRoomMembership } from "../rooms";
import { publicCall } from "../serializers";
import { nextCursor, pageParams } from "../utils";

export async function listRoomCalls(
  env: Env,
  auth: AuthContext,
  roomId: string,
  url: URL,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const page = pageParams(url, { defaultLimit: 20, maxLimit: 100 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM calls
     WHERE room_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(roomId, page.limit, page.offset)
    .all<CallRow>();
  const calls = await publicCallsWithParticipants(env, result.results ?? []);
  return { calls, nextCursor: nextCursor(calls.length, page) };
}

export async function getPublicCall(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  return publicCall(call, await callParticipants(env, callId));
}

export async function getCall(env: Env, callId: string): Promise<CallRow> {
  const call = await env.CONTROL_DB.prepare("SELECT * FROM calls WHERE call_id = ?")
    .bind(callId)
    .first<CallRow>();
  if (!call) throw new HttpError(404, "call_not_found", "Call not found");
  return call;
}

async function publicCallsWithParticipants(
  env: Env,
  calls: CallRow[],
): Promise<JsonObject[]> {
  if (!calls.length) return [];
  const placeholders = calls.map(() => "?").join(", ");
  const result = await env.CONTROL_DB.prepare(
    `SELECT cp.*, p.principal_type, p.display_name
     FROM call_participants cp
     JOIN principals p ON p.principal_id = cp.principal_id
     WHERE cp.call_id IN (${placeholders})
     ORDER BY cp.call_id ASC, cp.created_at ASC`,
  )
    .bind(...calls.map((call) => call.call_id))
    .all<CallParticipantRow>();
  const grouped = new Map<string, CallParticipantRow[]>();
  for (const participant of result.results ?? []) {
    const participants = grouped.get(participant.call_id) ?? [];
    participants.push(participant);
    grouped.set(participant.call_id, participants);
  }
  return calls.map((call) => publicCall(call, grouped.get(call.call_id) ?? []));
}

export async function callParticipants(
  env: Env,
  callId: string,
): Promise<CallParticipantRow[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT cp.*, p.principal_type, p.display_name
     FROM call_participants cp
     JOIN principals p ON p.principal_id = cp.principal_id
     WHERE cp.call_id = ?
     ORDER BY cp.created_at ASC`,
  )
    .bind(callId)
    .all<CallParticipantRow>();
  return result.results ?? [];
}
