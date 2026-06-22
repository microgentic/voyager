import { publicAccount } from "../http";
import type { AuthContext, Env } from "../types";
import type { AppBootstrapResult, JsonObject } from "./shared/types";
import { messageSelectBindValues, messageSelectColumns } from "./messages";
import { publicMessage } from "./messaging/serializers";
import { listRooms } from "./rooms";
import { durationSince, numberParam } from "./utils";
import { publicDevice, publicPrincipal } from "./shared/serializers";

export async function syncAccount(
  env: Env,
  auth: AuthContext,
  url: URL,
): Promise<JsonObject> {
  const limit = numberParam(url, "limit", 1, 200, 50);
  const roomPage = await listRooms(env, auth, url);
  const pendingMessages = await listPendingMessages(env, auth, limit);
  return {
    rooms: roomPage.rooms,
    roomsNextCursor: roomPage.nextCursor,
    pendingMessages,
  };
}

export async function appBootstrap(
  env: Env,
  auth: AuthContext,
  url: URL,
  requestId: string,
): Promise<AppBootstrapResult> {
  const limit = numberParam(url, "limit", 1, 200, 100);
  const roomsStartedAt = performance.now();
  const roomPage = await listRooms(env, auth, url);
  const roomsMs = durationSince(roomsStartedAt);
  const messagesStartedAt = performance.now();
  const pendingMessages = await listPendingMessages(env, auth, limit);
  const messagesMs = durationSince(messagesStartedAt);
  return {
    bootstrap: {
      account: publicAccount(auth.account),
      principal: publicPrincipal(auth.principal),
      device: publicDevice(auth.device),
      roles: auth.roles,
      rooms: roomPage.rooms,
      roomsNextCursor: roomPage.nextCursor,
      pendingMessages,
      serverTime: new Date().toISOString(),
      requestId,
    },
    metrics: { roomsMs, messagesMs },
  };
}

export async function listPendingMessages(
  env: Env,
  auth: AuthContext,
  limit: number,
): Promise<JsonObject[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT ${messageSelectColumns("me")}
     FROM delivery_receipts dr
     JOIN message_envelopes me ON me.envelope_id = dr.envelope_id
     WHERE dr.recipient_device_id = ?
       AND dr.status = 'pending'
       AND me.expires_at > CURRENT_TIMESTAMP
       AND me.state != 'purged'
       AND (me.thread_root_envelope_id IS NULL OR me.also_sent_to_room = 1)
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )
     ORDER BY me.server_received_at ASC
     LIMIT ?`,
  )
    .bind(
      ...messageSelectBindValues(auth),
      auth.device.device_id,
      auth.account.account_id,
      limit,
    )
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}
