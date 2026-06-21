import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import { notifyRoomRealtime } from "../realtime";
import type { AuthContext, Env } from "../types";
import {
  MAX_MESSAGE_BYTES,
  type JsonObject,
  type SendMessageResult,
} from "./internal-types";
import { getSendRoomContext, requireRoomMembership } from "./rooms";
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

export async function sendMessageEnvelope(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string,
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
  const insertStartedAt = performance.now();
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT INTO message_envelopes (
      envelope_id, room_id, sender_account_id, sender_principal_id, sender_device_id,
      idempotency_key, protocol_type, ciphertext, ciphertext_bytes, client_created_at,
      server_sequence, expires_at, state
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(server_sequence), 0) + 1 FROM message_envelopes WHERE room_id = ?),
      ?, 'available'
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
    return { message: publicMessage(existing), metrics };
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

  const message = publicMessage(inserted);
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
    `SELECT me.*
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
    .bind(roomId, after, auth.account.account_id, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
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
