import type { JsonObject } from "../shared/types";
import { parseJson } from "../utils";
import type { CallEventRow, CallParticipantRow, CallRow } from "./types";

export function publicCall(
  call: CallRow,
  participants: CallParticipantRow[] = [],
): JsonObject {
  return {
    callId: call.call_id,
    roomId: call.room_id,
    callType: call.call_type,
    status: call.status,
    createdByAccountId: call.created_by_account_id,
    createdByPrincipalId: call.created_by_principal_id,
    createdByDeviceId: call.created_by_device_id,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    endedReason: call.ended_reason,
    createdAt: call.created_at,
    updatedAt: call.updated_at,
    participants: participants.map(publicCallParticipant),
  };
}

export function publicCallParticipant(
  participant: CallParticipantRow,
): JsonObject {
  return {
    callParticipantId: participant.call_participant_id,
    callId: participant.call_id,
    accountId: participant.account_id,
    principalId: participant.principal_id,
    principalType: participant.principal_type,
    displayName: participant.display_name,
    deviceId: participant.device_id,
    role: participant.role,
    status: participant.status,
    joinedAt: participant.joined_at,
    leftAt: participant.left_at,
    mutedAt: participant.muted_at,
    audioEnabled: participant.audio_enabled !== 0,
    videoEnabled: participant.video_enabled === 1,
    screenEnabled: participant.screen_enabled === 1,
    lastSeenAt: participant.last_seen_at ?? null,
    createdAt: participant.created_at,
    updatedAt: participant.updated_at,
  };
}

export function publicCallEvent(event: CallEventRow): JsonObject {
  return {
    callEventId: event.call_event_id,
    callId: event.call_id,
    actorAccountId: event.actor_account_id,
    actorPrincipalId: event.actor_principal_id,
    actorDeviceId: event.actor_device_id,
    eventType: event.event_type,
    payload: parseJson(event.payload_json),
    createdAt: event.created_at,
  };
}
