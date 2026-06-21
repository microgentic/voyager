import { publicAccount } from "../http";
import type { AuthContext, Env } from "../types";
import type { AppBootstrapResult, JsonObject } from "./internal-types";
import { listRooms } from "./rooms";
import { durationSince, numberParam } from "./utils";
import { publicDevice, publicMessage, publicPrincipal } from "./serializers";

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
    `SELECT me.*
     FROM delivery_receipts dr
     JOIN message_envelopes me ON me.envelope_id = dr.envelope_id
     WHERE dr.recipient_device_id = ?
       AND dr.status = 'pending'
       AND me.expires_at > CURRENT_TIMESTAMP
       AND me.state != 'purged'
     ORDER BY me.server_received_at ASC
     LIMIT ?`,
  )
    .bind(auth.device.device_id, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}
