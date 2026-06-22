import type { JsonObject } from "../shared/types";
import { parseJson } from "../utils";

export function publicMessage(row: Record<string, unknown>): JsonObject {
  const receiptTotal = Number(row.receipt_total ?? 0);
  const receiptPending = Number(row.receipt_pending ?? 0);
  const receiptDelivered = Number(row.receipt_delivered ?? 0);
  const receiptRead = Number(row.receipt_read ?? 0);
  const receiptStatus =
    receiptRead > 0
      ? "read"
      : receiptDelivered > 0
        ? "delivered"
        : "sent";
  const reactions = normalizeReactionSummary(row.reaction_summary);
  return {
    envelopeId: row.envelope_id,
    roomId: row.room_id,
    senderAccountId: row.sender_account_id,
    senderPrincipalId: row.sender_principal_id,
    senderDeviceId: row.sender_device_id,
    idempotencyKey: row.idempotency_key,
    protocolType: row.protocol_type,
    ciphertext: row.ciphertext,
    ciphertextBytes: row.ciphertext_bytes,
    clientCreatedAt: row.client_created_at,
    serverSequence: row.server_sequence,
    serverReceivedAt: row.server_received_at,
    expiresAt: row.expires_at,
    state: row.state,
    editedAt: row.edited_at ?? null,
    editCount: Number(row.edit_count ?? 0),
    // Source room/envelope/sender are retained in D1 and the audit log for
    // server-side traceability, but not exposed to target-room members. The
    // public envelope only reveals that the message was forwarded and by whom.
    forwardedFrom: row.forwarded_from_envelope_id
      ? {
          forwardedByPrincipalId: row.forwarded_by_principal_id,
        }
      : null,
    deletedForEveryone: {
      deleted: Boolean(row.deleted_for_everyone_at),
      deletedAt: row.deleted_for_everyone_at ?? null,
      deletedByPrincipalId: row.deleted_by_principal_id ?? null,
      reason: row.deletion_reason ?? null,
    },
    threadRootEnvelopeId: row.thread_root_envelope_id ?? null,
    alsoSentToRoom: Boolean(row.also_sent_to_room),
    // Summary is computed on read from thread replies, so it stays accurate as
    // replies are added, edited, or tombstoned. Null until the first reply.
    threadSummary: Number(row.thread_reply_count ?? 0)
      ? {
          replyCount: Number(row.thread_reply_count ?? 0),
          lastReplyEnvelopeId: row.thread_last_reply_envelope_id ?? null,
          lastReplySenderPrincipalId:
            row.thread_last_reply_sender_principal_id ?? null,
          lastReplyAt: row.thread_last_reply_at ?? null,
        }
      : null,
    receiptSummary: {
      total: receiptTotal,
      pending: receiptPending,
      delivered: receiptDelivered,
      read: receiptRead,
      status: receiptStatus,
    },
    reactions,
    pin: {
      pinned: Boolean(row.pinned_at),
      pinnedAt: row.pinned_at ?? null,
      pinnedByPrincipalId: row.pinned_by_principal_id ?? null,
    },
  };
}

function normalizeReactionSummary(value: unknown): JsonObject[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const summary: JsonObject[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const reaction = (entry as Record<string, unknown>).reaction;
    const count = (entry as Record<string, unknown>).count;
    const reactedByMe = (entry as Record<string, unknown>).reactedByMe;
    if (typeof reaction !== "string") continue;
    summary.push({
      reaction,
      count: Number(count ?? 0),
      reactedByMe: Boolean(reactedByMe),
    });
  }
  return summary;
}
