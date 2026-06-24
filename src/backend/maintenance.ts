import { randomId } from "../crypto";
import { HttpError } from "../http";
import type { AuthContext, Env } from "../types";
import type { RoomRow } from "./rooms/types";
import type { JsonObject } from "./shared/types";
import { publicRoomWithMembers } from "./rooms";
import { nextCursor, pageParams, runCounted } from "./utils";
import { publicMaintenanceRun } from "./shared/serializers";

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
    expiredKeyPackages,
    expiredRoomInvitations,
    revokedCredentialResets,
    revokedExpiredSessions,
    deletedRealtimeTokens,
    deletedRateLimits,
    messagingRuntime: "core",
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
