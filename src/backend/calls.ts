import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import { notifyRoomRealtime } from "../realtime";
import type { AuthContext, Env } from "../types";
import type {
  CallParticipantRow,
  CallRow,
  JsonObject,
  MembershipRow,
} from "./internal-types";
import { publicCall } from "./serializers";
import { nextCursor, pageParams } from "./utils";
import { requireActiveRoom, requireRoomMembership } from "./rooms";

type CallType = CallRow["call_type"];
type CallStatus = CallRow["status"];
type CallParticipantStatus = CallParticipantRow["status"];

const LIVE_CALL_STATUSES: CallStatus[] = ["ringing", "active"];
const CONNECTABLE_STATUSES: CallStatus[] = ["ringing", "active"];

export async function createCall(
  env: Env,
  auth: AuthContext,
  callId: string,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const callType = parseCallType(body);
  await requireActiveRoom(env, roomId);
  await requireRoomMembership(env, auth, roomId);
  await assertNoLiveCallInRoom(env, roomId);

  const memberships = await activeRoomMemberships(env, roomId);
  if (!memberships.some((member) => member.principal_id === auth.principal.principal_id)) {
    throw new HttpError(
      403,
      "room_membership_required",
      "Active room membership required",
    );
  }

  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO calls (
        call_id, room_id, call_type, status, created_by_account_id,
        created_by_principal_id, created_by_device_id
      ) VALUES (?, ?, ?, 'ringing', ?, ?, ?)`,
    )
      .bind(
        callId,
        roomId,
        callType,
        auth.account.account_id,
        auth.principal.principal_id,
        auth.device.device_id,
      )
      .run();
  } catch (error) {
    if (isLiveCallConstraintError(error)) {
      throw new HttpError(
        409,
        "call_already_live",
        "A live call already exists in this room",
      );
    }
    throw error;
  }

  for (const member of memberships) {
    const isCreator = member.principal_id === auth.principal.principal_id;
    await env.CONTROL_DB.prepare(
      `INSERT INTO call_participants (
        call_participant_id, call_id, account_id, principal_id, device_id,
        role, status, joined_at
      ) VALUES (?, ?, ?, ?, ?, 'participant', ?, ${isCreator ? "CURRENT_TIMESTAMP" : "NULL"})`,
    )
      .bind(
        randomId("cpart"),
        callId,
        member.account_id,
        member.principal_id,
        isCreator ? auth.device.device_id : null,
        isCreator ? "connected" : "ringing",
      )
      .run();
  }

  await insertCallEvent(env, auth, callId, "call.created", { roomId, callType });
  const call = await getPublicCall(env, auth, callId);
  await emitCallEvent(env, roomId, {
    type: "call.invite",
    callId,
    callType,
    createdByPrincipalId: auth.principal.principal_id,
  });
  await emitCallEvent(env, roomId, {
    type: "call.ringing",
    callId,
    callType,
    createdByPrincipalId: auth.principal.principal_id,
  });
  return call;
}

export async function listRoomCalls(
  env: Env,
  auth: AuthContext,
  roomId: string,
  url: URL,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const page = pageParams(url, { defaultLimit: 20, maxLimit: 100 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM calls
     WHERE room_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(roomId, page.limit, page.offset)
    .all<CallRow>();
  const calls = await publicCallsWithParticipants(env, result.results ?? []);
  return { calls, nextCursor: nextCursor(calls.length, page) };
}

export async function getPublicCall(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  return publicCall(call, await callParticipants(env, callId));
}

export async function joinCall(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireActiveRoom(env, call.room_id);
  await requireRoomMembership(env, auth, call.room_id);
  assertConnectableCall(call);

  const existingDeviceParticipant = await getDeviceParticipant(
    env,
    callId,
    auth.principal.principal_id,
    auth.device.device_id,
  );
  if (existingDeviceParticipant) {
    if (existingDeviceParticipant.status !== "connected") {
      await updateParticipantStatus(env, existingDeviceParticipant.call_participant_id, "connected", {
        joined: true,
        clearLeft: true,
      });
    }
  } else {
    const pendingParticipant = await getPendingPrincipalParticipant(
      env,
      callId,
      auth.principal.principal_id,
    );
    if (pendingParticipant) {
      await env.CONTROL_DB.prepare(
        `UPDATE call_participants
         SET device_id = ?, status = 'connected', joined_at = COALESCE(joined_at, CURRENT_TIMESTAMP),
             left_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE call_participant_id = ?`,
      )
        .bind(auth.device.device_id, pendingParticipant.call_participant_id)
        .run();
    } else {
      await env.CONTROL_DB.prepare(
        `INSERT INTO call_participants (
          call_participant_id, call_id, account_id, principal_id, device_id,
          role, status, joined_at
        ) VALUES (?, ?, ?, ?, ?, 'participant', 'connected', CURRENT_TIMESTAMP)`,
      )
        .bind(
          randomId("cpart"),
          callId,
          auth.account.account_id,
          auth.principal.principal_id,
          auth.device.device_id,
        )
        .run();
    }
  }

  await activateCallIfReady(env, call);
  await insertCallEvent(env, auth, callId, "call.joined", {
    roomId: call.room_id,
    deviceId: auth.device.device_id,
  });
  await emitCallEvent(env, call.room_id, {
    type: "call.joined",
    callId,
    callType: call.call_type,
    principalId: auth.principal.principal_id,
    deviceId: auth.device.device_id,
  });
  await emitCallUpdated(env, callId);
  return getPublicCall(env, auth, callId);
}

export async function leaveCall(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  const participant = await requireCurrentParticipant(env, auth, callId);
  if (["left", "declined", "missed", "failed"].includes(participant.status)) {
    return getPublicCall(env, auth, callId);
  }

  await updateParticipantStatus(env, participant.call_participant_id, "left", {
    left: true,
    clearMute: true,
  });
  await insertCallEvent(env, auth, callId, "call.left", {
    roomId: call.room_id,
    deviceId: auth.device.device_id,
  });
  await maybeEndCallAfterDeparture(env, callId, "all_left");
  await emitCallEvent(env, call.room_id, {
    type: "call.left",
    callId,
    callType: call.call_type,
    principalId: auth.principal.principal_id,
    deviceId: auth.device.device_id,
    reason: "left",
  });
  await emitCallUpdated(env, callId);
  return getPublicCall(env, auth, callId);
}

export async function declineCall(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  if (!LIVE_CALL_STATUSES.includes(call.status)) {
    return getPublicCall(env, auth, callId);
  }
  const participant =
    (await getDeviceParticipant(env, callId, auth.principal.principal_id, auth.device.device_id)) ??
    (await getPendingPrincipalParticipant(env, callId, auth.principal.principal_id));
  if (!participant) {
    throw new HttpError(
      404,
      "call_participant_not_found",
      "Call participant not found",
    );
  }
  if (participant.status === "connected") {
    throw new HttpError(
      409,
      "call_already_joined",
      "Leave an active call instead of declining it",
    );
  }

  await updateParticipantStatus(env, participant.call_participant_id, "declined", {
    left: true,
    clearMute: true,
  });
  await insertCallEvent(env, auth, callId, "call.declined", {
    roomId: call.room_id,
    deviceId: auth.device.device_id,
  });
  await maybeEndDeclinedCall(env, callId);
  await emitCallEvent(env, call.room_id, {
    type: "call.left",
    callId,
    callType: call.call_type,
    principalId: auth.principal.principal_id,
    deviceId: auth.device.device_id,
    reason: "declined",
  });
  await emitCallUpdated(env, callId);
  return getPublicCall(env, auth, callId);
}

export async function setCallMuted(
  env: Env,
  auth: AuthContext,
  callId: string,
  muted: boolean,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  if (!LIVE_CALL_STATUSES.includes(call.status)) {
    throw new HttpError(409, "call_not_live", "Call is not live");
  }
  const participant = await requireCurrentParticipant(env, auth, callId);
  if (participant.status !== "connected") {
    throw new HttpError(
      409,
      "call_not_joined",
      "Join the call before changing mute state",
    );
  }

  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET muted_at = ${muted ? "CURRENT_TIMESTAMP" : "NULL"},
         updated_at = CURRENT_TIMESTAMP
     WHERE call_participant_id = ?`,
  )
    .bind(participant.call_participant_id)
    .run();
  await insertCallEvent(env, auth, callId, muted ? "call.muted" : "call.unmuted", {
    roomId: call.room_id,
    deviceId: auth.device.device_id,
  });
  await emitCallEvent(env, call.room_id, {
    type: "call.updated",
    callId,
    callType: call.call_type,
    status: call.status,
    principalId: auth.principal.principal_id,
    deviceId: auth.device.device_id,
  });
  return getPublicCall(env, auth, callId);
}

export async function updateCurrentCallParticipant(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const muted = body.muted;
  if (muted === undefined || muted === null) {
    throw new HttpError(400, "missing_field", "Missing required field: muted");
  }
  if (typeof muted !== "boolean") {
    throw new HttpError(400, "invalid_field", "Field must be a boolean: muted");
  }
  return setCallMuted(env, auth, callId, muted);
}

export async function getRealtimeSessionConfig(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  return {
    provider: "cloudflare_realtime",
    configured: false,
    callId,
    callType: call.call_type,
    status: call.status,
    session: null,
    message: "Realtime media integration is reserved for the audio PR.",
  };
}

export async function getRealtimeTrackConfig(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  return {
    provider: "cloudflare_realtime",
    configured: false,
    callId,
    callType: call.call_type,
    status: call.status,
    tracks: [],
    message: "Realtime media track publishing is reserved for the audio PR.",
  };
}

export async function getCall(env: Env, callId: string): Promise<CallRow> {
  const call = await env.CONTROL_DB.prepare("SELECT * FROM calls WHERE call_id = ?")
    .bind(callId)
    .first<CallRow>();
  if (!call) throw new HttpError(404, "call_not_found", "Call not found");
  return call;
}

async function assertNoLiveCallInRoom(env: Env, roomId: string): Promise<void> {
  const existing = await env.CONTROL_DB.prepare(
    "SELECT call_id FROM calls WHERE room_id = ? AND status IN ('ringing', 'active') LIMIT 1",
  )
    .bind(roomId)
    .first<{ call_id: string }>();
  if (existing) {
    throw new HttpError(
      409,
      "call_already_live",
      "A live call already exists in this room",
    );
  }
}

function isLiveCallConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unique constraint failed/i.test(message) &&
    /idx_calls_one_live_per_room|calls\.room_id/i.test(message)
  );
}

function parseCallType(body: Record<string, unknown>): CallType {
  const value = stringField(body, "callType", { required: true, max: 20 });
  if (value !== "audio" && value !== "video") {
    throw new HttpError(400, "invalid_call_type", "Call type is invalid");
  }
  return value;
}

function assertConnectableCall(call: CallRow): void {
  if (!CONNECTABLE_STATUSES.includes(call.status)) {
    throw new HttpError(409, "call_not_live", "Call is not live");
  }
}

async function activeRoomMemberships(
  env: Env,
  roomId: string,
): Promise<MembershipRow[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     JOIN accounts a ON a.account_id = rm.account_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND p.status = 'active'
       AND a.status = 'active'
     ORDER BY rm.created_at ASC`,
  )
    .bind(roomId)
    .all<MembershipRow>();
  return result.results ?? [];
}

async function publicCallsWithParticipants(
  env: Env,
  calls: CallRow[],
): Promise<JsonObject[]> {
  if (!calls.length) return [];
  const placeholders = calls.map(() => "?").join(", ");
  const result = await env.CONTROL_DB.prepare(
    `SELECT cp.*, p.principal_type, p.display_name
     FROM call_participants cp
     JOIN principals p ON p.principal_id = cp.principal_id
     WHERE cp.call_id IN (${placeholders})
     ORDER BY cp.call_id ASC, cp.created_at ASC`,
  )
    .bind(...calls.map((call) => call.call_id))
    .all<CallParticipantRow>();
  const grouped = new Map<string, CallParticipantRow[]>();
  for (const participant of result.results ?? []) {
    const participants = grouped.get(participant.call_id) ?? [];
    participants.push(participant);
    grouped.set(participant.call_id, participants);
  }
  return calls.map((call) => publicCall(call, grouped.get(call.call_id) ?? []));
}

async function callParticipants(
  env: Env,
  callId: string,
): Promise<CallParticipantRow[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT cp.*, p.principal_type, p.display_name
     FROM call_participants cp
     JOIN principals p ON p.principal_id = cp.principal_id
     WHERE cp.call_id = ?
     ORDER BY cp.created_at ASC`,
  )
    .bind(callId)
    .all<CallParticipantRow>();
  return result.results ?? [];
}

async function getDeviceParticipant(
  env: Env,
  callId: string,
  principalId: string,
  deviceId: string,
): Promise<CallParticipantRow | null> {
  return (
    (await env.CONTROL_DB.prepare(
      "SELECT * FROM call_participants WHERE call_id = ? AND principal_id = ? AND device_id = ?",
    )
      .bind(callId, principalId, deviceId)
      .first<CallParticipantRow>()) ?? null
  );
}

async function getPendingPrincipalParticipant(
  env: Env,
  callId: string,
  principalId: string,
): Promise<CallParticipantRow | null> {
  return (
    (await env.CONTROL_DB.prepare(
      `SELECT *
       FROM call_participants
       WHERE call_id = ? AND principal_id = ? AND device_id IS NULL
         AND status IN ('invited', 'ringing', 'joining')
       LIMIT 1`,
    )
      .bind(callId, principalId)
      .first<CallParticipantRow>()) ?? null
  );
}

async function requireCurrentParticipant(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<CallParticipantRow> {
  const participant =
    (await getDeviceParticipant(env, callId, auth.principal.principal_id, auth.device.device_id)) ??
    (await getPendingPrincipalParticipant(env, callId, auth.principal.principal_id));
  if (!participant) {
    throw new HttpError(
      404,
      "call_participant_not_found",
      "Call participant not found",
    );
  }
  return participant;
}

async function updateParticipantStatus(
  env: Env,
  callParticipantId: string,
  status: CallParticipantStatus,
  options: { joined?: boolean; left?: boolean; clearLeft?: boolean; clearMute?: boolean } = {},
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET status = ?,
         joined_at = CASE WHEN ? THEN COALESCE(joined_at, CURRENT_TIMESTAMP) ELSE joined_at END,
         left_at = CASE WHEN ? THEN CURRENT_TIMESTAMP WHEN ? THEN NULL ELSE left_at END,
         muted_at = CASE WHEN ? THEN NULL ELSE muted_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE call_participant_id = ?`,
  )
    .bind(
      status,
      options.joined ? 1 : 0,
      options.left ? 1 : 0,
      options.clearLeft ? 1 : 0,
      options.clearMute ? 1 : 0,
      callParticipantId,
    )
    .run();
}

async function activateCallIfReady(env: Env, call: CallRow): Promise<void> {
  const connected = await participantCount(env, call.call_id, "connected");
  if (call.status === "ringing" && connected >= 2) {
    await env.CONTROL_DB.prepare(
      `UPDATE calls
       SET status = 'active',
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE call_id = ? AND status = 'ringing'`,
    )
      .bind(call.call_id)
      .run();
    await insertCallEvent(env, null, call.call_id, "call.active", {
      roomId: call.room_id,
    });
  }
}

async function maybeEndCallAfterDeparture(
  env: Env,
  callId: string,
  reason: string,
): Promise<void> {
  const call = await getCall(env, callId);
  if (!LIVE_CALL_STATUSES.includes(call.status)) return;
  const connected = await participantCount(env, callId, "connected");
  if (connected > 0) return;
  await endCall(env, call, "ended", reason);
}

async function maybeEndDeclinedCall(env: Env, callId: string): Promise<void> {
  const call = await getCall(env, callId);
  if (!LIVE_CALL_STATUSES.includes(call.status)) return;
  const [connected, stillRinging] = await Promise.all([
    participantCount(env, callId, "connected"),
    openInviteCount(env, callId),
  ]);
  if (connected <= 1 && stillRinging === 0) {
    await endCall(env, call, "declined", "declined");
  }
}

async function endCall(
  env: Env,
  call: CallRow,
  status: Extract<CallStatus, "ended" | "declined" | "missed" | "failed">,
  reason: string,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE calls
     SET status = ?,
         ended_reason = ?,
         ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ? AND status IN ('ringing', 'active')`,
  )
    .bind(status, reason, call.call_id)
    .run();
  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET status = CASE
           WHEN status IN ('invited', 'ringing', 'joining') THEN 'missed'
           WHEN status = 'connected' THEN 'left'
           ELSE status
         END,
         left_at = CASE WHEN left_at IS NULL AND status = 'connected' THEN CURRENT_TIMESTAMP ELSE left_at END,
         muted_at = CASE WHEN status = 'connected' THEN NULL ELSE muted_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ? AND status IN ('invited', 'ringing', 'joining', 'connected')`,
  )
    .bind(call.call_id)
    .run();
  await insertCallEvent(env, null, call.call_id, "call.ended", {
    roomId: call.room_id,
    status,
    reason,
  });
  await emitCallEvent(env, call.room_id, {
    type: "call.ended",
    callId: call.call_id,
    callType: call.call_type,
    endedReason: reason,
  });
}

async function participantCount(
  env: Env,
  callId: string,
  status: CallParticipantStatus,
): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM call_participants WHERE call_id = ? AND status = ?",
  )
    .bind(callId, status)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function openInviteCount(env: Env, callId: string): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM call_participants
     WHERE call_id = ? AND status IN ('invited', 'ringing', 'joining')`,
  )
    .bind(callId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function insertCallEvent(
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

async function emitCallUpdated(env: Env, callId: string): Promise<void> {
  const call = await getCall(env, callId);
  await emitCallEvent(env, call.room_id, {
    type: "call.updated",
    callId,
    callType: call.call_type,
    status: call.status,
  });
}

async function emitCallEvent(
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
  await notifyRoomRealtime(env, roomId, event);
}
