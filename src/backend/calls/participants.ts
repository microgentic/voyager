import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type {
  CallParticipantRow,
  MembershipRow,
} from "../internal-types";
import type {
  CallParticipantStatus,
  CallRealtimeTrackKind,
} from "./types";

export async function activeRoomMemberships(
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

export async function getDeviceParticipant(
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

export async function getPendingPrincipalParticipant(
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

export async function requireCurrentParticipant(
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

export async function requireConnectedParticipant(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<CallParticipantRow> {
  const participant = await requireCurrentParticipant(env, auth, callId);
  if (participant.status !== "connected") {
    throw new HttpError(
      409,
      "call_not_joined",
      "Join the call before connecting media",
    );
  }
  return participant;
}

export async function updateParticipantStatus(
  env: Env,
  callParticipantId: string,
  status: CallParticipantStatus,
  options: { joined?: boolean; left?: boolean; clearLeft?: boolean; clearMute?: boolean; clearMedia?: boolean } = {},
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET status = ?,
         joined_at = CASE WHEN ? THEN COALESCE(joined_at, CURRENT_TIMESTAMP) ELSE joined_at END,
         left_at = CASE WHEN ? THEN CURRENT_TIMESTAMP WHEN ? THEN NULL ELSE left_at END,
         muted_at = CASE WHEN ? THEN NULL ELSE muted_at END,
         audio_enabled = CASE WHEN ? THEN 0 WHEN ? THEN 1 ELSE audio_enabled END,
         video_enabled = CASE WHEN ? THEN 0 ELSE video_enabled END,
         screen_enabled = CASE WHEN ? THEN 0 ELSE screen_enabled END,
         last_seen_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_seen_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE call_participant_id = ?`,
  )
    .bind(
      status,
      options.joined ? 1 : 0,
      options.left ? 1 : 0,
      options.clearLeft ? 1 : 0,
      options.clearMute ? 1 : 0,
      options.clearMedia ? 1 : 0,
      options.joined ? 1 : 0,
      options.clearMedia ? 1 : 0,
      options.clearMedia ? 1 : 0,
      options.joined ? 1 : 0,
      callParticipantId,
    )
    .run();
}

export async function updateParticipantMediaState(
  env: Env,
  callParticipantId: string,
  update: {
    muted?: boolean;
    audioEnabled?: boolean;
    videoEnabled?: boolean;
    screenEnabled?: boolean;
    heartbeat?: boolean;
  },
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET muted_at = CASE
           WHEN ? THEN CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
           ELSE muted_at
         END,
         audio_enabled = CASE WHEN ? THEN ? ELSE audio_enabled END,
         video_enabled = CASE WHEN ? THEN ? ELSE video_enabled END,
         screen_enabled = CASE WHEN ? THEN ? ELSE screen_enabled END,
         last_seen_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_seen_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE call_participant_id = ?`,
  )
    .bind(
      update.muted === undefined ? 0 : 1,
      update.muted === true ? 1 : 0,
      update.audioEnabled === undefined ? 0 : 1,
      update.audioEnabled === true ? 1 : 0,
      update.videoEnabled === undefined ? 0 : 1,
      update.videoEnabled === true ? 1 : 0,
      update.screenEnabled === undefined ? 0 : 1,
      update.screenEnabled === true ? 1 : 0,
      update.heartbeat ? 1 : 0,
      callParticipantId,
    )
    .run();
}

export async function participantCount(
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

export async function openInviteCount(env: Env, callId: string): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM call_participants
     WHERE call_id = ? AND status IN ('invited', 'ringing', 'joining')`,
  )
    .bind(callId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function refreshParticipantMediaStateFromTracks(
  env: Env,
  callParticipantId: string,
): Promise<void> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT t.kind
     FROM call_realtime_tracks t
     JOIN call_realtime_sessions s
       ON s.call_realtime_session_id = t.call_realtime_session_id
     WHERE s.call_participant_id = ?
       AND s.status = 'active'
       AND t.status = 'active'
       AND t.location = 'local'`,
  )
    .bind(callParticipantId)
    .all<{ kind: CallRealtimeTrackKind }>();
  const kinds = new Set((result.results ?? []).map((row) => row.kind));
  await updateParticipantMediaState(env, callParticipantId, {
    audioEnabled: kinds.has("audio"),
    videoEnabled: kinds.has("video"),
    screenEnabled: kinds.has("screen"),
    heartbeat: true,
  });
}
