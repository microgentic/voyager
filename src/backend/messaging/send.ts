import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import { notifyRoomRealtime } from "../../realtime";
import type { AuthContext, Env } from "../../types";
import {
  MAX_MESSAGE_BYTES,
  type ForwardSource,
  type SendMessageResult,
  type ThreadReply,
} from "./types";
import { getSendRoomContext } from "../rooms";
import {
  byteLength,
  durationSince,
  finalizeSendMetrics,
  logSendMessagePerformance,
  sqliteTimestamp,
  stringArrayField,
} from "../utils";
import {
  assertAttachmentCountWithinPolicy,
  assertAttachmentsReferenceable,
  assertAttachmentsReferenced,
  markAttachmentsReferencedStatements,
  purgeMessageAfterAttachmentReferenceFailure,
} from "./attachment-references";
import { MAX_ATTACHMENTS_PER_MESSAGE_HARD_LIMIT } from "./constants";
import { assertAllowedProtocolType } from "./helpers";
import { getPublicMessage } from "./select";
import { createDeliveryReceiptStatement } from "./receipts";
import { sendRealtimeEventFromMessage } from "./realtime";
import { assertThreadRootEligible } from "./threads";

export async function sendMessageEnvelope(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string,
  options: {
    forwardSource?: ForwardSource | null;
    threadReply?: ThreadReply | null;
  } = {},
): Promise<SendMessageResult> {
  const startedAt = performance.now();
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const threadReply = options.threadReply ?? null;
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
  assertAllowedProtocolType(protocolType);
  const clientCreatedAt =
    stringField(body, "clientCreatedAt", { max: 80 }) ?? null;
  const attachmentIds = stringArrayField(body, "attachmentIds", {
    maxItems: MAX_ATTACHMENTS_PER_MESSAGE_HARD_LIMIT,
  });
  await assertAttachmentCountWithinPolicy(env, auth, attachmentIds);
  await assertAttachmentsReferenceable(env, auth, roomId, attachmentIds);
  const forwardSource = options.forwardSource ?? null;

  if (threadReply) {
    const existingForIdempotency = await env.CONTROL_DB.prepare(
      "SELECT * FROM message_envelopes WHERE sender_device_id = ? AND idempotency_key = ?",
    )
      .bind(auth.device.device_id, idempotencyKey)
      .first<Record<string, unknown>>();
    if (
      existingForIdempotency &&
      isMatchingThreadReplyDuplicate(existingForIdempotency, roomId, threadReply)
    ) {
      return duplicateSendMessageResult(
        env,
        auth,
        roomId,
        requestId,
        existingForIdempotency,
        startedAt,
        durationSince(startedAt),
        0,
      );
    }
    await assertThreadRootEligible(env, auth, roomId, threadReply.rootEnvelopeId);
  }
  const contextMs = durationSince(startedAt);

  const envelopeId = randomId("msg");
  const expiresAt = sqliteTimestamp(
    Date.now() + Number(context.message_retention_days) * 24 * 60 * 60 * 1000,
  );
  const insertStartedAt = performance.now();
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT INTO message_envelopes (
      envelope_id, room_id, sender_account_id, sender_principal_id, sender_device_id,
      idempotency_key, protocol_type, ciphertext, ciphertext_bytes, client_created_at,
      server_sequence, expires_at, state, forwarded_from_room_id, forwarded_from_envelope_id,
      forwarded_from_sender_principal_id, forwarded_by_principal_id,
      thread_root_envelope_id, also_sent_to_room
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(server_sequence), 0) + 1 FROM message_envelopes WHERE room_id = ?),
      ?, 'available', ?, ?, ?, ?, ?, ?
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
      threadReply?.rootEnvelopeId ?? null,
      threadReply?.alsoSendToRoom ? 1 : 0,
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
    return duplicateSendMessageResult(
      env,
      auth,
      roomId,
      requestId,
      existing,
      startedAt,
      contextMs,
      insertMs,
    );
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
  try {
    await assertAttachmentsReferenced(env, auth, roomId, attachmentIds);
  } catch (error) {
    await purgeMessageAfterAttachmentReferenceFailure(env, envelopeId);
    throw error;
  }
  const postWriteMs = durationSince(postWriteStartedAt);

  const message = await getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
    auth.account.account_id,
  );
  const realtimeStartedAt = performance.now();
  await notifyRoomRealtime(
    env,
    roomId,
    sendRealtimeEventFromMessage(inserted, auth.device.device_id),
  ).catch((error) => console.warn("realtime notification failed", error));
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

function isMatchingThreadReplyDuplicate(
  existing: Record<string, unknown>,
  roomId: string,
  threadReply: ThreadReply,
): boolean {
  return (
    String(existing.room_id) === roomId &&
    existing.thread_root_envelope_id === threadReply.rootEnvelopeId
  );
}

async function duplicateSendMessageResult(
  env: Env,
  auth: AuthContext,
  roomId: string,
  requestId: string,
  existing: Record<string, unknown>,
  startedAt: number,
  contextMs: number,
  insertMs: number,
): Promise<SendMessageResult> {
  let realtimeMs = 0;
  if (String(existing.room_id) === roomId) {
    const realtimeStartedAt = performance.now();
    await notifyRoomRealtime(
      env,
      roomId,
      sendRealtimeEventFromMessage(existing, auth.device.device_id),
    ).catch((error) => console.warn("realtime notification failed", error));
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
      auth.account.account_id,
    ),
    metrics,
  };
}
