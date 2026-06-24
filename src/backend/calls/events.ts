import { randomId } from "../../crypto";
import { notifyRoomCallRealtime } from "../../realtime";
import type { AuthContext, Env } from "../../types";
import { getCall } from "./public-read";
import type { CallStatus, CallType } from "./types";

export async function insertCallEvent(
  env: Env,
  auth: AuthContext | null,
  callId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO call_events (
      call_event_id, call_id, actor_account_id, actor_principal_id,
      actor_device_id, event_type, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomId("cevt"),
      callId,
      auth?.account.account_id ?? null,
      auth?.principal.principal_id ?? null,
      auth?.device.device_id ?? null,
      eventType,
      JSON.stringify(payload),
    )
    .run();
}

export async function emitCallUpdated(env: Env, callId: string): Promise<void> {
  const call = await getCall(env, callId);
  await emitCallEvent(env, call.room_id, {
    type: "call.updated",
    callId,
    callType: call.call_type,
    status: call.status,
  });
}

export async function emitCallEvent(
  env: Env,
  roomId: string,
  event: {
    type:
      | "call.invite"
      | "call.ringing"
      | "call.joined"
      | "call.left"
      | "call.updated"
      | "call.ended";
    callId: string;
    callType: CallType;
    status?: CallStatus;
    principalId?: string;
    deviceId?: string;
    createdByPrincipalId?: string;
    reason?: string;
    endedReason?: string;
  },
): Promise<void> {
  await notifyRoomCallRealtime(env, roomId, event);
}
