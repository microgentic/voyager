import { randomId } from "../crypto";
import { HttpError } from "../http";
import type { AuthContext, Env } from "../types";
import type { JsonObject, RoomRow } from "./internal-types";
import { publicRoomWithMembers } from "./rooms";
import { nextCursor, pageParams, runCounted } from "./utils";
import { publicMaintenanceRun } from "./serializers";

interface AttachmentObjectKeysRow {
  object_key: string;
  original_object_key: string | null;
  preview_object_key: string | null;
  thumbnail_object_key: string | null;
}

export async function listAdminRooms(env: Env, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status");
  if (status && !["active", "archived", "deleted"].includes(status)) {
    throw new HttpError(400, "invalid_room_status", "Room status is invalid");
  }
  const type = url.searchParams.get("type");
  if (type && !["direct", "group", "channel"].includes(type)) {
    throw new HttpError(400, "invalid_room_type", "Room type is invalid");
  }
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    filters.push("status = ?");
    binds.push(status);
  }
  if (type) {
    filters.push("type = ?");
    binds.push(type);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await env.CONTROL_DB.prepare(
    `SELECT * FROM rooms ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, page.limit, page.offset)
    .all<RoomRow>();
  const rooms = await Promise.all(
    (result.results ?? []).map((room) => publicRoomWithMembers(env, room)),
  );
  return { rooms, nextCursor: nextCursor(rooms.length, page) };
}

export async function listMaintenanceRuns(
  env: Env,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    "SELECT * FROM maintenance_runs ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(page.limit, page.offset)
    .all<Record<string, unknown>>();
  const runs = (result.results ?? []).map(publicMaintenanceRun);
  return { runs, nextCursor: nextCursor(runs.length, page) };
}

export async function runCleanup(
  env: Env,
  auth: AuthContext,
): Promise<JsonObject> {
  const expiredAttachmentRows = await env.CONTROL_DB.prepare(
    `SELECT object_key, original_object_key, preview_object_key, thumbnail_object_key
     FROM attachments
     WHERE expires_at <= CURRENT_TIMESTAMP
       AND state IN ('allocated', 'uploaded', 'referenced')`,
  ).all<AttachmentObjectKeysRow>();
  const expiredAttachmentObjectKeys = uniqueAttachmentObjectKeys(
    expiredAttachmentRows.results ?? [],
  );
  await Promise.all(
    expiredAttachmentObjectKeys.map((objectKey) =>
      env.ATTACHMENTS_BUCKET.delete(objectKey),
    ),
  );
  const expiredMessages = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE message_envelopes SET state = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND state NOT IN ('expired', 'purged')",
    ),
  );
  const expiredAttachments = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE attachments SET state = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND state IN ('allocated', 'uploaded', 'referenced')",
    ),
  );
  const expiredKeyPackages = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE device_key_packages SET status = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'available'",
    ),
  );
  const expiredRoomInvitations = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE room_invitations SET status = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'pending'",
    ),
  );
  const revokedCredentialResets = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE credential_reset_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE expires_at <= CURRENT_TIMESTAMP AND used_at IS NULL AND revoked_at IS NULL",
    ),
  );
  const revokedExpiredSessions = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE expires_at <= CURRENT_TIMESTAMP AND revoked_at IS NULL",
    ),
  );
  const deletedRealtimeTokens = await runCounted(
    env.CONTROL_DB.prepare(
      "DELETE FROM realtime_socket_tokens WHERE expires_at <= CURRENT_TIMESTAMP OR used_at IS NOT NULL OR revoked_at IS NOT NULL",
    ),
  );
  const deletedRateLimits = await runCounted(
    env.CONTROL_DB.prepare(
      "DELETE FROM rate_limits WHERE expires_at <= CURRENT_TIMESTAMP",
    ),
  );
  const cleanup = {
    maintenanceRunId: randomId("mrun"),
    action: "cleanup",
    expiredMessages,
    expiredAttachments,
    expiredKeyPackages,
    expiredRoomInvitations,
    revokedCredentialResets,
    revokedExpiredSessions,
    deletedRealtimeTokens,
    deletedRateLimits,
    deletedAttachmentObjects: expiredAttachmentObjectKeys.length,
  };
  await env.CONTROL_DB.prepare(
    "INSERT INTO maintenance_runs (maintenance_run_id, action, actor_account_id, result, metadata_json) VALUES (?, 'cleanup', ?, 'success', ?)",
  )
    .bind(
      cleanup.maintenanceRunId,
      auth.account.account_id,
      JSON.stringify(cleanup),
    )
    .run();
  return cleanup;
}

function uniqueAttachmentObjectKeys(rows: AttachmentObjectKeysRow[]): string[] {
  return Array.from(
    new Set(
      rows.flatMap((row) => [
        row.object_key,
        row.original_object_key,
        row.preview_object_key,
        row.thumbnail_object_key,
      ]).filter((key): key is string => typeof key === "string" && key.length > 0),
    ),
  );
}
