import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import { getSendRoomContext, requireRoomMembership } from "../rooms";
import { publicMessage } from "./serializers";
import { numberParam } from "../utils";
import {
  messageSelectBindValues,
  messageSelectColumns,
} from "./select";

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
    `SELECT ${messageSelectColumns("me")}
     FROM message_envelopes me
     WHERE me.room_id = ?
       AND me.server_sequence > ?
       AND me.state != 'purged'
       AND me.expires_at > CURRENT_TIMESTAMP
       AND (me.thread_root_envelope_id IS NULL OR me.also_sent_to_room = 1)
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )
     ORDER BY server_sequence ASC
     LIMIT ?`,
  )
    .bind(
      ...messageSelectBindValues(auth),
      roomId,
      after,
      auth.account.account_id,
      limit,
    )
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
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

export async function requireActiveMessageInteraction(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
): Promise<Record<string, unknown>> {
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  return getActiveMessageInRoom(env, roomId, envelopeId);
}

export async function getActiveMessageInRoom(
  env: Env,
  roomId: string,
  envelopeId: string,
): Promise<Record<string, unknown>> {
  const message = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM message_envelopes
     WHERE envelope_id = ?
       AND room_id = ?
       AND state NOT IN ('expired', 'purged')
       AND deleted_for_everyone_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(envelopeId, roomId)
    .first<Record<string, unknown>>();
  if (!message) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  return message;
}
