import { randomId } from "../../crypto";
import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { getRoom, getSendRoomContext, requireRoomManager } from "../rooms";
import { touchRoomVersionStatement } from "./helpers";
import { getActiveMessageInRoom } from "./reads";
import { notifyMessageSync } from "./realtime";
import { getPublicMessage } from "./select";

export async function pinMessage(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
): Promise<JsonObject> {
  await requirePinPermission(env, auth, roomId);
  await getActiveMessageInRoom(env, roomId, envelopeId);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO message_pins (
         pin_id, room_id, envelope_id, pinned_by_account_id, pinned_by_principal_id,
         pinned_by_device_id, pinned_at, unpinned_by_principal_id, unpinned_by_device_id, unpinned_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, NULL, NULL)
       ON CONFLICT(room_id, envelope_id) DO UPDATE SET
         pinned_by_account_id = excluded.pinned_by_account_id,
         pinned_by_principal_id = excluded.pinned_by_principal_id,
         pinned_by_device_id = excluded.pinned_by_device_id,
         pinned_at = CURRENT_TIMESTAMP,
         unpinned_by_principal_id = NULL,
         unpinned_by_device_id = NULL,
         unpinned_at = NULL`,
    ).bind(
      randomId("pin"),
      roomId,
      envelopeId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
    ),
    touchRoomVersionStatement(env, roomId),
  ]);
  await notifyMessageSync(env, auth, roomId, envelopeId);
  return getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
    auth.account.account_id,
  );
}

export async function unpinMessage(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
): Promise<JsonObject> {
  await requirePinPermission(env, auth, roomId);
  await getActiveMessageInRoom(env, roomId, envelopeId);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE message_pins
       SET unpinned_by_principal_id = ?,
           unpinned_by_device_id = ?,
           unpinned_at = CURRENT_TIMESTAMP
       WHERE room_id = ?
         AND envelope_id = ?
         AND unpinned_at IS NULL`,
    ).bind(auth.principal.principal_id, auth.device.device_id, roomId, envelopeId),
    touchRoomVersionStatement(env, roomId),
  ]);
  await notifyMessageSync(env, auth, roomId, envelopeId);
  return getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
    auth.account.account_id,
  );
}

async function requirePinPermission(
  env: Env,
  auth: AuthContext,
  roomId: string,
): Promise<void> {
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const room = await getRoom(env, roomId);
  if (room.type === "direct") return;
  await requireRoomManager(env, auth, roomId);
}
