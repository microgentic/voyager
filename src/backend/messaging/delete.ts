import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../internal-types";
import { getRoom, getSendRoomContext, requireRoomMembership } from "../rooms";
import { byteLength, stringArrayField, uniqueStrings } from "../utils";
import { DELETE_FOR_EVERYONE_WINDOW_MS } from "./constants";
import { notifyMessageSync } from "./realtime";
import { updateMessageReceiptState } from "./receipts";

export async function deleteMessagesForMe(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const scope = stringField(body, "scope", { required: true, max: 20 });
  if (scope !== "for_me") {
    throw new HttpError(
      400,
      "invalid_delete_scope",
      "Only delete-for-me is supported",
    );
  }

  const envelopeIds = uniqueStrings(
    stringArrayField(body, "envelopeIds", {
      required: true,
      maxItems: 100,
    }),
  );
  if (!envelopeIds.length) {
    throw new HttpError(
      400,
      "missing_field",
      "Missing required field: envelopeIds",
    );
  }

  const placeholders = envelopeIds.map(() => "?").join(", ");
  const existing = await env.CONTROL_DB.prepare(
    `SELECT envelope_id
     FROM message_envelopes
     WHERE room_id = ?
       AND envelope_id IN (${placeholders})
       AND state != 'purged'`,
  )
    .bind(roomId, ...envelopeIds)
    .all<{ envelope_id: string }>();
  const existingIds = new Set(
    (existing.results ?? []).map((row) => row.envelope_id),
  );
  if (existingIds.size !== envelopeIds.length) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }

  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO message_visibility (
         visibility_id, envelope_id, room_id, account_id, principal_id, reason
       )
       SELECT
         'msgvis_' || lower(hex(randomblob(18))),
         envelope_id,
         room_id,
         ?,
         ?,
         'delete_for_me'
       FROM message_envelopes
       WHERE room_id = ?
         AND envelope_id IN (${placeholders})`,
    ).bind(
      auth.account.account_id,
      auth.principal.principal_id,
      roomId,
      ...envelopeIds,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE delivery_receipts
       SET status = 'stored',
           stored_at = COALESCE(stored_at, CURRENT_TIMESTAMP)
       WHERE room_id = ?
         AND recipient_account_id = ?
         AND status = 'pending'
         AND envelope_id IN (${placeholders})`,
    ).bind(roomId, auth.account.account_id, ...envelopeIds),
  ]);

  await Promise.all(
    envelopeIds.map((envelopeId) => updateMessageReceiptState(env, envelopeId)),
  );

  return {
    scope: "for_me",
    envelopeIds,
  };
}

export async function deleteMessagesForEveryone(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const scope = stringField(body, "scope", { required: true, max: 20 });
  if (scope !== "everyone") {
    throw new HttpError(
      400,
      "invalid_delete_scope",
      "Delete-for-everyone requires scope: everyone",
    );
  }

  const envelopeIds = uniqueStrings(
    stringArrayField(body, "envelopeIds", {
      required: true,
      maxItems: 100,
    }),
  );
  if (!envelopeIds.length) {
    throw new HttpError(
      400,
      "missing_field",
      "Missing required field: envelopeIds",
    );
  }

  const placeholders = envelopeIds.map(() => "?").join(", ");
  const existing = await env.CONTROL_DB.prepare(
    `SELECT envelope_id, sender_principal_id, server_received_at, deleted_for_everyone_at
     FROM message_envelopes
     WHERE room_id = ?
       AND envelope_id IN (${placeholders})
       AND state NOT IN ('expired', 'purged')
       AND expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(roomId, ...envelopeIds)
    .all<Record<string, unknown>>();
  const rows = existing.results ?? [];
  if (rows.length !== envelopeIds.length) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }

  const room = await getRoom(env, roomId);
  const isManager =
    room.type !== "direct" && ["owner", "admin"].includes(String(context.role));
  const now = Date.now();
  for (const row of rows) {
    if (row.deleted_for_everyone_at) continue;
    const isSender = row.sender_principal_id === auth.principal.principal_id;
    const sentAt = sqliteDateMs(String(row.server_received_at));
    const withinSenderWindow =
      isSender && sentAt !== null && now - sentAt <= DELETE_FOR_EVERYONE_WINDOW_MS;
    if (!withinSenderWindow && !isManager) {
      throw new HttpError(
        403,
        "delete_everyone_forbidden",
        "Only the sender within 48 hours, or a room owner/admin, can delete for everyone",
      );
    }
  }

  const reason = stringField(body, "reason", { max: 160 }) ?? null;
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE message_envelopes
       SET deleted_for_everyone_at = COALESCE(deleted_for_everyone_at, CURRENT_TIMESTAMP),
           deleted_by_account_id = COALESCE(deleted_by_account_id, ?),
           deleted_by_principal_id = COALESCE(deleted_by_principal_id, ?),
           deleted_by_device_id = COALESCE(deleted_by_device_id, ?),
           deletion_reason = COALESCE(deletion_reason, ?),
           ciphertext = CASE WHEN deleted_for_everyone_at IS NULL THEN 'deleted-for-everyone' ELSE ciphertext END,
           ciphertext_bytes = CASE WHEN deleted_for_everyone_at IS NULL THEN ? ELSE ciphertext_bytes END
       WHERE room_id = ?
         AND envelope_id IN (${placeholders})
         AND state NOT IN ('expired', 'purged')`,
    ).bind(
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      reason,
      byteLength("deleted-for-everyone"),
      roomId,
      ...envelopeIds,
    ),
    env.CONTROL_DB.prepare(
      `DELETE FROM message_reactions
       WHERE room_id = ?
         AND envelope_id IN (${placeholders})`,
    ).bind(roomId, ...envelopeIds),
    env.CONTROL_DB.prepare(
      `UPDATE message_pins
       SET unpinned_by_principal_id = ?,
           unpinned_by_device_id = ?,
           unpinned_at = CURRENT_TIMESTAMP
       WHERE room_id = ?
         AND envelope_id IN (${placeholders})
         AND unpinned_at IS NULL`,
    ).bind(auth.principal.principal_id, auth.device.device_id, roomId, ...envelopeIds),
    env.CONTROL_DB.prepare(
      "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
    ).bind(roomId),
  ]);

  await Promise.all(
    envelopeIds.map((envelopeId) => notifyMessageSync(env, auth, roomId, envelopeId)),
  );

  return {
    scope: "everyone",
    envelopeIds,
  };
}

function sqliteDateMs(value: string): number | null {
  const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}
