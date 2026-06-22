import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { requireRoomMembership } from "../rooms";
import { getMessage } from "./reads";
import { notifyMessageSync } from "./realtime";

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
  await notifyMessageSync(env, auth, roomId, envelopeId);
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
