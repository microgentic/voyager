import { HttpError } from "../../http";
import type { Env } from "../../types";
import type { JsonObject } from "../internal-types";
import {
  commitRealtimeProviderFailureForCoordinator,
  commitRealtimeRenegotiateRecordForCoordinator,
  commitRealtimeSessionUpsertForCoordinator,
  commitRealtimeTracksCloseForCoordinator,
  commitRealtimeTracksUpsertForCoordinator,
  commitRealtimeUnavailableForCoordinator,
  createCall,
  declineCall,
  joinCall,
  leaveCall,
  setCallMuted,
  updateCurrentCallParticipant,
} from "./core";
import type { CallMutationRequest } from "./coordinator";

export async function runCallMutation(
  env: Env,
  payload: CallMutationRequest,
): Promise<JsonObject | undefined> {
  switch (payload.operation) {
    case "call.create":
      if (!payload.roomId) {
        throw new HttpError(400, "missing_field", "Missing required field: roomId");
      }
      return createCall(
        env,
        payload.auth,
        payload.callId,
        payload.roomId,
        payload.body ?? {},
      );
    case "call.join":
      return joinCall(env, payload.auth, payload.callId);
    case "call.leave":
      return leaveCall(env, payload.auth, payload.callId);
    case "call.decline":
      return declineCall(env, payload.auth, payload.callId);
    case "call.mute":
      return setCallMuted(env, payload.auth, payload.callId, true);
    case "call.unmute":
      return setCallMuted(env, payload.auth, payload.callId, false);
    case "call.participant.update":
      return updateCurrentCallParticipant(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    case "call.media.session.upsert":
      return commitRealtimeSessionUpsertForCoordinator(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    case "call.media.tracks.upsert":
      return commitRealtimeTracksUpsertForCoordinator(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    case "call.media.tracks.close":
      return commitRealtimeTracksCloseForCoordinator(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    case "call.media.unavailable.record":
      return commitRealtimeUnavailableForCoordinator(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    case "call.media.provider_failure.record":
      return commitRealtimeProviderFailureForCoordinator(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    case "call.media.renegotiate.record":
      return commitRealtimeRenegotiateRecordForCoordinator(
        env,
        payload.auth,
        payload.callId,
        payload.body ?? {},
      );
    default:
      throw new HttpError(
        400,
        "invalid_call_operation",
        "Call operation is invalid",
      );
  }
}
