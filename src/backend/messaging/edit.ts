import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import { MAX_MESSAGE_BYTES, type JsonObject } from "../internal-types";
import { getSendRoomContext } from "../rooms";
import { byteLength, sqliteTimestamp, stringArrayField } from "../utils";
import {
  assertAttachmentCountWithinPolicy,
  assertAttachmentsReferenceable,
  markAttachmentsReferenced,
} from "./attachment-references";
import { MAX_ATTACHMENTS_PER_MESSAGE_HARD_LIMIT } from "./constants";
import { assertAllowedProtocolType } from "./helpers";
import { getMessage } from "./reads";
import { getPublicMessage } from "./select";
import { notifyMessageSync } from "./realtime";

export async function editMessageEnvelope(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }

  const current = await getMessage(env, envelopeId);
  if (
    !current ||
    current.room_id !== roomId ||
    current.state === "purged" ||
    current.state === "expired" ||
    current.deleted_for_everyone_at
  ) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  if (current.sender_principal_id !== auth.principal.principal_id) {
    throw new HttpError(
      403,
      "message_author_required",
      "Only the sender can edit this message",
    );
  }

  const ciphertext = stringField(body, "ciphertext", {
    required: true,
    min: 1,
    max: MAX_MESSAGE_BYTES,
  })!;
  const ciphertextBytes = byteLength(ciphertext);
  if (ciphertextBytes > MAX_MESSAGE_BYTES) {
    throw new HttpError(
      413,
      "message_too_large",
      "Encrypted envelope is too large",
    );
  }
  const protocolType = stringField(body, "protocolType", {
    required: true,
    max: 60,
  })!;
  assertAllowedProtocolType(protocolType);
  const clientEditedAt =
    stringField(body, "clientEditedAt", { max: 80 }) ?? null;
  const attachmentIds = stringArrayField(body, "attachmentIds", {
    maxItems: MAX_ATTACHMENTS_PER_MESSAGE_HARD_LIMIT,
  });
  await assertAttachmentCountWithinPolicy(env, auth, attachmentIds);
  await assertAttachmentsReferenceable(env, auth, roomId, attachmentIds);
  await markAttachmentsReferenced(env, auth, roomId, attachmentIds);
  const editedAt = sqliteTimestamp(Date.now());

  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO message_edits (
         edit_id, envelope_id, room_id, editor_account_id, editor_principal_id,
         editor_device_id, previous_protocol_type, previous_ciphertext,
         previous_ciphertext_bytes, new_protocol_type, new_ciphertext,
         new_ciphertext_bytes, client_edited_at, edited_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      randomId("medit"),
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      current.protocol_type,
      current.ciphertext,
      current.ciphertext_bytes,
      protocolType,
      ciphertext,
      ciphertextBytes,
      clientEditedAt,
      editedAt,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE message_envelopes
       SET protocol_type = ?,
           ciphertext = ?,
           ciphertext_bytes = ?,
           edited_at = ?,
           edit_count = edit_count + 1
       WHERE envelope_id = ?
         AND room_id = ?
         AND sender_principal_id = ?
         AND state NOT IN ('expired', 'purged')`,
    ).bind(
      protocolType,
      ciphertext,
      ciphertextBytes,
      editedAt,
      envelopeId,
      roomId,
      auth.principal.principal_id,
    ),
    env.CONTROL_DB.prepare(
      "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
    ).bind(roomId),
  ]);

  await notifyMessageSync(env, auth, roomId, envelopeId);

  return getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
    auth.account.account_id,
  );
}
