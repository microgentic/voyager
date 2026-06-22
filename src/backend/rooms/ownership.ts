import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { sqliteTimestamp } from "../utils";
import { requireRoomMembership, requireRoomOwner } from "./authorization";
import { getMembership } from "./membership";
import { bumpRoom, getActivePrincipal } from "./reads";
import { OWNERSHIP_TRANSFER_DAYS } from "./types";

export async function proposeOwnershipTransfer(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  const toPrincipalId = stringField(body, "toPrincipalId", {
    required: true,
    max: 80,
  })!;
  const targetMembership = await getMembership(env, roomId, toPrincipalId);
  const target = await getActivePrincipal(env, toPrincipalId);
  if (
    target.principal_type !== "human" ||
    targetMembership.status !== "active"
  ) {
    throw new HttpError(
      400,
      "invalid_owner_target",
      "Ownership can only transfer to an active human room member",
    );
  }
  const transferId = randomId("xfer");
  const expiresAt = sqliteTimestamp(
    Date.now() + OWNERSHIP_TRANSFER_DAYS * 24 * 60 * 60 * 1000,
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO ownership_transfers (transfer_id, room_id, from_principal_id, to_principal_id, status, expires_at)
     VALUES (?, ?, ?, ?, 'proposed', ?)`,
  )
    .bind(
      transferId,
      roomId,
      auth.principal.principal_id,
      toPrincipalId,
      expiresAt,
    )
    .run();
  return getOwnershipTransfer(env, transferId);
}

export async function acceptOwnershipTransfer(
  env: Env,
  auth: AuthContext,
  roomId: string,
  transferId: string,
): Promise<JsonObject> {
  const transfer = await env.CONTROL_DB.prepare(
    "SELECT * FROM ownership_transfers WHERE transfer_id = ? AND room_id = ? AND status = 'proposed' AND expires_at > CURRENT_TIMESTAMP",
  )
    .bind(transferId, roomId)
    .first<Record<string, string>>();
  if (!transfer || transfer.to_principal_id !== auth.principal.principal_id) {
    throw new HttpError(
      404,
      "ownership_transfer_not_found",
      "Ownership transfer not found",
    );
  }
  await requireRoomMembership(env, auth, roomId);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE room_memberships SET role = 'owner', updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?",
    ).bind(roomId, auth.principal.principal_id),
    env.CONTROL_DB.prepare(
      "UPDATE room_memberships SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?",
    ).bind(roomId, transfer.from_principal_id),
    env.CONTROL_DB.prepare(
      "UPDATE ownership_transfers SET status = 'completed', responded_at = CURRENT_TIMESTAMP WHERE transfer_id = ?",
    ).bind(transferId),
  ]);
  await bumpRoom(env, roomId);
  return getOwnershipTransfer(env, transferId);
}

export async function getOwnershipTransfer(
  env: Env,
  transferId: string,
): Promise<JsonObject> {
  const transfer = await env.CONTROL_DB.prepare(
    "SELECT * FROM ownership_transfers WHERE transfer_id = ?",
  )
    .bind(transferId)
    .first<Record<string, unknown>>();
  if (!transfer)
    throw new HttpError(
      404,
      "ownership_transfer_not_found",
      "Ownership transfer not found",
    );
  return {
    transferId: transfer.transfer_id,
    roomId: transfer.room_id,
    fromPrincipalId: transfer.from_principal_id,
    toPrincipalId: transfer.to_principal_id,
    status: transfer.status,
    expiresAt: transfer.expires_at,
    createdAt: transfer.created_at,
    respondedAt: transfer.responded_at,
  };
}
