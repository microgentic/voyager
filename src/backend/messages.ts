import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import { notifyRoomRealtime } from "../realtime";
import type { AuthContext, Env } from "../types";
import {
  MAX_MESSAGE_BYTES,
  type ForwardSource,
  type JsonObject,
  type SendMessageResult,
} from "./internal-types";
import {
  getRoom,
  getSendRoomContext,
  requireRoomManager,
  requireRoomMembership,
} from "./rooms";
import {
  byteLength,
  durationSince,
  finalizeSendMetrics,
  logSendMessagePerformance,
  numberParam,
  stringArrayField,
  uniqueStrings,
  sqliteTimestamp,
} from "./utils";
import { publicMessage } from "./serializers";

const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;

export function messageSelectColumns(alias = "me"): string {
  return `${alias}.*,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id) AS receipt_total,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id AND drs.status = 'pending') AS receipt_pending,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id AND drs.status IN ('stored', 'read')) AS receipt_delivered,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id AND drs.status = 'read') AS receipt_read,
    (SELECT COALESCE(json_group_array(json_object(
       'reaction', reaction,
       'count', reaction_count,
       'reactedByMe', reacted_by_me
     )), '[]')
     FROM (
       SELECT
         mr.reaction AS reaction,
         COUNT(*) AS reaction_count,
         MAX(CASE WHEN mr.principal_id = ? THEN 1 ELSE 0 END) AS reacted_by_me
       FROM message_reactions mr
       WHERE mr.envelope_id = ${alias}.envelope_id
       GROUP BY mr.reaction
       ORDER BY reaction_count DESC, mr.reaction ASC
     )) AS reaction_summary,
    (SELECT mp.pinned_at FROM message_pins mp WHERE mp.envelope_id = ${alias}.envelope_id AND mp.room_id = ${alias}.room_id AND mp.unpinned_at IS NULL ORDER BY mp.pinned_at DESC LIMIT 1) AS pinned_at,
    (SELECT mp.pinned_by_principal_id FROM message_pins mp WHERE mp.envelope_id = ${alias}.envelope_id AND mp.room_id = ${alias}.room_id AND mp.unpinned_at IS NULL ORDER BY mp.pinned_at DESC LIMIT 1) AS pinned_by_principal_id`;
}

export async function getPublicMessage(
  env: Env,
  envelopeId: string,
  viewerPrincipalId: string,
): Promise<JsonObject> {
  const message = await env.CONTROL_DB.prepare(
    `SELECT ${messageSelectColumns("me")}
     FROM message_envelopes me
     WHERE me.envelope_id = ?`,
  )
    .bind(viewerPrincipalId, envelopeId)
    .first<Record<string, unknown>>();
  if (!message) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  return publicMessage(message);
}

export async function sendMessageEnvelope(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string,
  options: { forwardSource?: ForwardSource | null } = {},
): Promise<SendMessageResult> {
  const startedAt = performance.now();
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const contextMs = durationSince(startedAt);
  const idempotencyKey = stringField(body, "idempotencyKey", {
    required: true,
    min: 8,
    max: 160,
  })!;
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
  if (
    ![
      "opaque-test",
      "mls_application",
      "mls_commit",
      "mls_proposal",
      "mls_welcome",
    ].includes(protocolType)
  ) {
    throw new HttpError(
      400,
      "invalid_protocol_type",
      "Protocol type is not allowed",
    );
  }
  const envelopeId = randomId("msg");
  const expiresAt = sqliteTimestamp(
    Date.now() + Number(context.message_retention_days) * 24 * 60 * 60 * 1000,
  );
  const clientCreatedAt =
    stringField(body, "clientCreatedAt", { max: 80 }) ?? null;
  const attachmentIds = stringArrayField(body, "attachmentIds", {
    maxItems: 20,
  });
  const forwardSource = options.forwardSource ?? null;
  const insertStartedAt = performance.now();
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT INTO message_envelopes (
      envelope_id, room_id, sender_account_id, sender_principal_id, sender_device_id,
      idempotency_key, protocol_type, ciphertext, ciphertext_bytes, client_created_at,
      server_sequence, expires_at, state, forwarded_from_room_id, forwarded_from_envelope_id,
      forwarded_from_sender_principal_id, forwarded_by_principal_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(server_sequence), 0) + 1 FROM message_envelopes WHERE room_id = ?),
      ?, 'available', ?, ?, ?, ?
    )
    ON CONFLICT(sender_device_id, idempotency_key) DO NOTHING
    RETURNING *`,
  )
    .bind(
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      idempotencyKey,
      protocolType,
      ciphertext,
      ciphertextBytes,
      clientCreatedAt,
      roomId,
      expiresAt,
      forwardSource?.roomId ?? null,
      forwardSource?.envelopeId ?? null,
      forwardSource?.senderPrincipalId ?? null,
      forwardSource ? auth.principal.principal_id : null,
    )
    .first<Record<string, unknown>>();
  const insertMs = durationSince(insertStartedAt);

  if (!inserted) {
    const existing = await env.CONTROL_DB.prepare(
      "SELECT * FROM message_envelopes WHERE sender_device_id = ? AND idempotency_key = ?",
    )
      .bind(auth.device.device_id, idempotencyKey)
      .first<Record<string, unknown>>();
    if (!existing)
      throw new HttpError(
        409,
        "message_idempotency_conflict",
        "Message idempotency key could not be resolved",
      );
    let realtimeMs = 0;
    if (String(existing.room_id) === roomId) {
      const realtimeStartedAt = performance.now();
      await notifyRoomRealtime(env, roomId, {
        type: "room.message",
        envelopeId: String(existing.envelope_id),
        serverSequence: Number(existing.server_sequence),
        senderDeviceId: auth.device.device_id,
      }).catch((error) => console.warn("realtime notification failed", error));
      realtimeMs = durationSince(realtimeStartedAt);
    }
    const metrics = finalizeSendMetrics({
      duplicate: true,
      startedAt,
      contextMs,
      insertMs,
      postWriteMs: 0,
      realtimeMs,
    });
    logSendMessagePerformance(requestId, roomId, existing, metrics);
    return {
      message: await getPublicMessage(
        env,
        String(existing.envelope_id),
        auth.principal.principal_id,
      ),
      metrics,
    };
  }

  const postWriteStartedAt = performance.now();
  await env.CONTROL_DB.batch([
    createDeliveryReceiptStatement(
      env,
      roomId,
      envelopeId,
      auth.device.device_id,
    ),
    ...markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds),
    env.CONTROL_DB.prepare(
      "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
    ).bind(roomId),
  ]);
  const postWriteMs = durationSince(postWriteStartedAt);

  const message = await getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
  );
  const realtimeStartedAt = performance.now();
  await notifyRoomRealtime(env, roomId, {
    type: "room.message",
    envelopeId,
    serverSequence: Number(inserted.server_sequence),
    senderDeviceId: auth.device.device_id,
  }).catch((error) => console.warn("realtime notification failed", error));
  const realtimeMs = durationSince(realtimeStartedAt);
  const metrics = finalizeSendMetrics({
    duplicate: false,
    startedAt,
    contextMs,
    insertMs,
    postWriteMs,
    realtimeMs,
  });
  logSendMessagePerformance(requestId, roomId, inserted, metrics);
  return { message, metrics };
}

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
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )
     ORDER BY server_sequence ASC
     LIMIT ?`,
  )
    .bind(auth.principal.principal_id, roomId, after, auth.account.account_id, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}

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
  if (
    ![
      "opaque-test",
      "mls_application",
      "mls_commit",
      "mls_proposal",
      "mls_welcome",
    ].includes(protocolType)
  ) {
    throw new HttpError(
      400,
      "invalid_protocol_type",
      "Protocol type is not allowed",
    );
  }
  const clientEditedAt =
    stringField(body, "clientEditedAt", { max: 80 }) ?? null;
  const attachmentIds = stringArrayField(body, "attachmentIds", {
    maxItems: 20,
  });
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
    ...markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds),
    env.CONTROL_DB.prepare(
      "UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?",
    ).bind(roomId),
  ]);

  await notifyRoomRealtime(env, roomId, {
    type: "room.sync",
    envelopeId,
    serverSequence: Number(current.server_sequence),
    senderDeviceId: auth.device.device_id,
  }).catch((error) => console.warn("realtime notification failed", error));

  return getPublicMessage(env, envelopeId, auth.principal.principal_id);
}

export async function setMessageReaction(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireActiveMessageInteraction(env, auth, roomId, envelopeId);
  const reaction = normalizeReaction(
    stringField(body, "reaction", { required: true, min: 1, max: 32 })!,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO message_reactions (
         reaction_id, envelope_id, room_id, account_id, principal_id, reaction
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(envelope_id, principal_id) DO UPDATE SET
         room_id = excluded.room_id,
         account_id = excluded.account_id,
         reaction = excluded.reaction,
         created_at = CURRENT_TIMESTAMP`,
    ).bind(
      randomId("react"),
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      reaction,
    ),
    touchRoomVersionStatement(env, roomId),
  ]);
  await notifyMessageSync(env, auth, roomId, envelopeId);
  return getPublicMessage(env, envelopeId, auth.principal.principal_id);
}

export async function deleteMessageReaction(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireActiveMessageInteraction(env, auth, roomId, envelopeId);
  const reaction = normalizeReaction(
    stringField(body, "reaction", { required: true, min: 1, max: 32 })!,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "DELETE FROM message_reactions WHERE envelope_id = ? AND principal_id = ? AND reaction = ?",
    ).bind(envelopeId, auth.principal.principal_id, reaction),
    touchRoomVersionStatement(env, roomId),
  ]);
  await notifyMessageSync(env, auth, roomId, envelopeId);
  return getPublicMessage(env, envelopeId, auth.principal.principal_id);
}

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
  return getPublicMessage(env, envelopeId, auth.principal.principal_id);
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
  return getPublicMessage(env, envelopeId, auth.principal.principal_id);
}

async function requireActiveMessageInteraction(
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

async function getActiveMessageInRoom(
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

function normalizeReaction(reaction: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(reaction)) {
    throw new HttpError(400, "invalid_reaction", "Reaction is invalid");
  }
  return reaction;
}

function touchRoomVersionStatement(
  env: Env,
  roomId: string,
): D1PreparedStatement {
  return env.CONTROL_DB.prepare(
    "UPDATE rooms SET version = version + 1 WHERE room_id = ?",
  ).bind(roomId);
}

async function notifyMessageSync(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
): Promise<void> {
  const message = await getMessage(env, envelopeId);
  if (!message) return;
  await notifyRoomRealtime(env, roomId, {
    type: "room.sync",
    envelopeId,
    serverSequence: Number(message.server_sequence),
    senderDeviceId: auth.device.device_id,
  }).catch((error) => console.warn("realtime notification failed", error));
}

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

export async function acknowledgeMessage(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const status =
    stringField(body, "status", { max: 20 }) === "read" ? "read" : "stored";
  const message = await getMessage(env, envelopeId);
  if (!message || message.room_id !== roomId) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  const receiptId = randomId("rcp");
  await env.CONTROL_DB.prepare(
    `INSERT INTO delivery_receipts (
      receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id,
      recipient_device_id, status, stored_at, read_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ${status === "read" ? "CURRENT_TIMESTAMP" : "NULL"})
    ON CONFLICT(envelope_id, recipient_device_id) DO UPDATE SET
      status = excluded.status,
      stored_at = COALESCE(delivery_receipts.stored_at, CURRENT_TIMESTAMP),
      read_at = CASE WHEN excluded.status = 'read' THEN CURRENT_TIMESTAMP ELSE delivery_receipts.read_at END`,
  )
    .bind(
      receiptId,
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      status,
    )
    .run();
  await updateMessageReceiptState(env, envelopeId);
  await notifyRoomRealtime(env, roomId, {
    type: "room.sync",
    envelopeId,
    serverSequence: Number(message.server_sequence),
    senderDeviceId: auth.device.device_id,
  }).catch((error) => console.warn("realtime notification failed", error));
  return getReceipt(env, envelopeId, auth.device.device_id);
}

export async function createDeliveryReceipts(
  env: Env,
  roomId: string,
  envelopeId: string,
  senderDeviceId: string,
): Promise<void> {
  await createDeliveryReceiptStatement(
    env,
    roomId,
    envelopeId,
    senderDeviceId,
  ).run();
}

export function createDeliveryReceiptStatement(
  env: Env,
  roomId: string,
  envelopeId: string,
  senderDeviceId: string,
): D1PreparedStatement {
  return env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO delivery_receipts (
       receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id, recipient_device_id, status
     )
     SELECT
       'rcp_' || lower(hex(randomblob(18))),
       ?,
       ?,
       rm.account_id,
       rm.principal_id,
       d.device_id,
       'pending'
     FROM room_memberships rm
     JOIN accounts a ON a.account_id = rm.account_id
     JOIN devices d ON d.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND a.status = 'active'
       AND d.revoked_at IS NULL
       AND d.device_id != ?`,
  ).bind(envelopeId, roomId, roomId, senderDeviceId);
}

export async function markAttachmentsReferenced(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): Promise<void> {
  await Promise.all(
    markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds).map(
      (statement) => statement.run(),
    ),
  );
}

export function markAttachmentsReferencedStatements(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): D1PreparedStatement[] {
  const ids = uniqueStrings(attachmentIds);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return [
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'referenced', referenced_at = CURRENT_TIMESTAMP
       WHERE attachment_id IN (${placeholders})
         AND room_id = ?
         AND uploader_account_id = ?
         AND state = 'uploaded'`,
    ).bind(...ids, roomId, auth.account.account_id),
  ];
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

// Forward provenance is server-asserted: only the dedicated /forward route may
// resolve a source, and the result is threaded to sendMessageEnvelope as an
// internal option. Normal sends never carry forward metadata, so a caller
// cannot fabricate it through the public send body.
export async function resolveForwardSource(
  env: Env,
  auth: AuthContext,
  sourceRoomId: string,
  sourceEnvelopeId: string,
): Promise<ForwardSource> {
  await requireRoomMembership(env, auth, sourceRoomId);
  const source = await env.CONTROL_DB.prepare(
    `SELECT envelope_id, room_id, sender_principal_id
     FROM message_envelopes me
     WHERE me.room_id = ?
       AND me.envelope_id = ?
       AND me.state NOT IN ('expired', 'purged')
       AND me.expires_at > CURRENT_TIMESTAMP
       AND me.deleted_for_everyone_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )`,
  )
    .bind(sourceRoomId, sourceEnvelopeId, auth.account.account_id)
    .first<Record<string, unknown>>();
  if (!source) {
    throw new HttpError(
      404,
      "forward_source_not_found",
      "Forward source message not found",
    );
  }
  return {
    roomId: sourceRoomId,
    envelopeId: sourceEnvelopeId,
    senderPrincipalId: String(source.sender_principal_id),
  };
}

function sqliteDateMs(value: string): number | null {
  const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function updateMessageReceiptState(
  env: Env,
  envelopeId: string,
): Promise<void> {
  const pending = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM delivery_receipts WHERE envelope_id = ? AND status = 'pending'",
  )
    .bind(envelopeId)
    .first<{ count: number }>();
  const total = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM delivery_receipts WHERE envelope_id = ?",
  )
    .bind(envelopeId)
    .first<{ count: number }>();
  const state =
    (total?.count ?? 0) === 0 || (pending?.count ?? 0) === 0
      ? "fully_acknowledged"
      : "partially_acknowledged";
  await env.CONTROL_DB.prepare(
    "UPDATE message_envelopes SET state = ? WHERE envelope_id = ?",
  )
    .bind(state, envelopeId)
    .run();
}

export async function getReceipt(
  env: Env,
  envelopeId: string,
  deviceId: string,
): Promise<JsonObject> {
  const receipt = await env.CONTROL_DB.prepare(
    "SELECT * FROM delivery_receipts WHERE envelope_id = ? AND recipient_device_id = ?",
  )
    .bind(envelopeId, deviceId)
    .first<Record<string, unknown>>();
  if (!receipt)
    throw new HttpError(404, "receipt_not_found", "Delivery receipt not found");
  return {
    receiptId: receipt.receipt_id,
    envelopeId: receipt.envelope_id,
    roomId: receipt.room_id,
    recipientDeviceId: receipt.recipient_device_id,
    status: receipt.status,
    storedAt: receipt.stored_at,
    readAt: receipt.read_at,
  };
}
