import { randomId } from "../crypto";
import { HttpError, optionalObject, stringField } from "../http";
import { notifyRoomRealtime } from "../realtime";
import type { AuthContext, Env } from "../types";
import type {
  CallParticipantRow,
  CallRealtimeSessionRow,
  CallRealtimeTrackRow,
  CallRow,
  JsonObject,
  MembershipRow,
} from "./internal-types";
import { publicCall } from "./serializers";
import { nextCursor, pageParams, sqliteTimestamp } from "./utils";
import { requireActiveRoom, requireRoomMembership } from "./rooms";

type CallType = CallRow["call_type"];
type CallStatus = CallRow["status"];
type CallParticipantStatus = CallParticipantRow["status"];
type CallRealtimeTrackKind = CallRealtimeTrackRow["kind"];
type CallRealtimeTrackLocation = CallRealtimeTrackRow["location"];

const LIVE_CALL_STATUSES: CallStatus[] = ["ringing", "active"];
const CONNECTABLE_STATUSES: CallStatus[] = ["ringing", "active"];
const REALTIME_PROVIDER = "cloudflare_realtime" as const;
const DEFAULT_REALTIME_API_BASE = "https://rtc.live.cloudflare.com/v1";
const FEATURE_DISABLED_VALUES = new Set(["0", "false", "off", "disabled", "no"]);
const CLIENT_USAGE_REPORT_SOURCE = "client_estimate" as const;
const MAX_USAGE_REPORT_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_USAGE_REPORT_BYTES = 50 * 1024 * 1024 * 1024;

export type CallMediaMutationRunner = (
  operation: string,
  body?: Record<string, unknown>,
) => Promise<JsonObject | undefined>;

export async function createCall(
  env: Env,
  auth: AuthContext,
  callId: string,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const callType = parseCallType(body);
  assertCallsEnabled(env);
  assertCallTypeEnabled(env, callType);
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
        role, status, joined_at, audio_enabled, video_enabled, screen_enabled,
        last_seen_at
      ) VALUES (?, ?, ?, ?, ?, 'participant', ?, ${isCreator ? "CURRENT_TIMESTAMP" : "NULL"}, ?, 0, 0, ${isCreator ? "CURRENT_TIMESTAMP" : "NULL"})`,
    )
      .bind(
        randomId("cpart"),
        callId,
        member.account_id,
        member.principal_id,
        isCreator ? auth.device.device_id : null,
        isCreator ? "connected" : "ringing",
        isCreator ? 1 : 0,
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
  assertCallsEnabled(env);
  assertCallTypeEnabled(env, call.call_type);
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
             left_at = NULL, audio_enabled = 1, video_enabled = 0, screen_enabled = 0,
             last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE call_participant_id = ?`,
      )
        .bind(auth.device.device_id, pendingParticipant.call_participant_id)
        .run();
    } else {
      await env.CONTROL_DB.prepare(
        `INSERT INTO call_participants (
          call_participant_id, call_id, account_id, principal_id, device_id,
          role, status, joined_at, audio_enabled, video_enabled, screen_enabled,
          last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 'participant', 'connected', CURRENT_TIMESTAMP, 1, 0, 0, CURRENT_TIMESTAMP)`,
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
    clearMedia: true,
  });
  await closeParticipantRealtimeSessions(env, callId, participant.call_participant_id);
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
  assertCallsEnabled(env);
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
    clearMedia: true,
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
  assertCallsEnabled(env);
  assertCallTypeEnabled(env, call.call_type);
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

  await updateParticipantMediaState(env, participant.call_participant_id, {
    muted,
    audioEnabled: !muted,
    heartbeat: true,
  });
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
  const muted = optionalBoolean(body, "muted");
  const audioEnabled = optionalBoolean(body, "audioEnabled");
  const videoEnabled = optionalBoolean(body, "videoEnabled");
  const screenEnabled = optionalBoolean(body, "screenEnabled");
  const heartbeat = optionalBoolean(body, "heartbeat") ?? false;
  if (
    muted === undefined &&
    audioEnabled === undefined &&
    videoEnabled === undefined &&
    screenEnabled === undefined &&
    !heartbeat
  ) {
    throw new HttpError(
      400,
      "missing_field",
      "Missing participant update field",
    );
  }
  if (!heartbeat || muted !== undefined || audioEnabled !== undefined || videoEnabled !== undefined || screenEnabled !== undefined) {
    assertCallsEnabled(env);
  }
  if (videoEnabled === true) assertVideoCallsEnabled(env);
  if (screenEnabled === true) assertScreenShareEnabled(env);

  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  if (!LIVE_CALL_STATUSES.includes(call.status)) {
    throw new HttpError(409, "call_not_live", "Call is not live");
  }
  if (call.call_type === "audio" && (videoEnabled === true || screenEnabled === true)) {
    throw new HttpError(
      400,
      "invalid_call_media_state",
      "Audio calls cannot enable video or screen media",
    );
  }
  const participant = await requireCurrentParticipant(env, auth, callId);
  if (participant.status !== "connected") {
    throw new HttpError(
      409,
      "call_not_joined",
      "Join the call before updating participant state",
    );
  }

  const changed =
    muted !== undefined ||
    audioEnabled !== undefined ||
    videoEnabled !== undefined ||
    screenEnabled !== undefined;
  await updateParticipantMediaState(env, participant.call_participant_id, {
    muted,
    audioEnabled: audioEnabled ?? (muted !== undefined ? !muted : undefined),
    videoEnabled,
    screenEnabled,
    heartbeat: true,
  });
  if (changed) {
    await insertCallEvent(env, auth, callId, "call.participant.updated", {
      roomId: call.room_id,
      deviceId: auth.device.device_id,
      muted,
      audioEnabled: audioEnabled ?? (muted !== undefined ? !muted : undefined),
      videoEnabled,
      screenEnabled,
    });
    await emitCallEvent(env, call.room_id, {
      type: "call.updated",
      callId,
      callType: call.call_type,
      status: call.status,
      principalId: auth.principal.principal_id,
      deviceId: auth.device.device_id,
    });
  }
  return getPublicCall(env, auth, callId);
}

export async function getRealtimeSessionConfig(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown> = {},
  runMediaMutation?: CallMediaMutationRunner,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  assertConnectableCall(call);
  assertRealtimeMediaEnabled(env);
  const participant = await requireConnectedParticipant(env, auth, callId);
  const config = realtimeConfig(env);
  if (!config.configured) {
    return recordRealtimeUnavailable(
      env,
      auth,
      call,
      participant,
      config,
      "session",
      runMediaMutation,
    );
  }
  const requestedSessionDescription = parseOptionalSessionDescription(body);

  const existingSession = await activeRealtimeSessionForParticipant(
    env,
    callId,
    participant.call_participant_id,
  );
  if (existingSession) {
    if (requestedSessionDescription) {
      const payload = await realtimeProviderRequest(
        env,
        auth,
        call,
        participant,
        "session.renegotiate",
        config,
        `/sessions/${encodeURIComponent(existingSession.provider_session_id)}/renegotiate`,
        {
          method: "PUT",
          body: { sessionDescription: requestedSessionDescription },
        },
        runMediaMutation,
      );
      try {
        await commitCallMediaMutation(
          env,
          auth,
          call,
          "call.media.renegotiate.record",
          { providerSessionId: existingSession.provider_session_id },
          runMediaMutation,
          async () => {
            await recordRealtimeRenegotiated(
              env,
              auth,
              call,
              participant,
              existingSession.provider_session_id,
            );
          },
        );
      } catch (error) {
        await recordProviderCommitFailure(env, auth, call, {
          endpoint: "session.renegotiate",
          providerSessionId: existingSession.provider_session_id,
          cleanupAttempted: false,
          cleanupSucceeded: false,
          reason: errorMessage(error),
        });
        throw error;
      }
      const availableTracks = await availableRealtimeTracks(
        env,
        callId,
        existingSession.provider_session_id,
      );
      return realtimeResponse(env, call, config, {
        session: publicRealtimeSession(existingSession),
        sessionDescription: payload.sessionDescription ?? null,
        tracks: availableTracks,
        availableTracks,
        message: "Realtime session renegotiated",
      });
    }
    const availableTracks = await availableRealtimeTracks(
      env,
      callId,
      existingSession.provider_session_id,
    );
    return realtimeResponse(env, call, config, {
      session: publicRealtimeSession(existingSession),
      tracks: availableTracks,
      availableTracks,
      message: "Realtime session ready",
    });
  }

  const payload = await realtimeProviderRequest(
    env,
    auth,
    call,
    participant,
    "session",
    config,
    "/sessions/new",
    {
      method: "POST",
      query: { correlationId: `${callId}:${participant.call_participant_id}` },
      body: {
        sessionDescription: requestedSessionDescription,
      },
    },
    runMediaMutation,
  );
  const providerSessionId = stringPayload(payload, "sessionId", "realtime_session_missing");
  try {
    await commitCallMediaMutation(
      env,
      auth,
      call,
      "call.media.session.upsert",
      { providerSessionId },
      runMediaMutation,
      async () => {
        await upsertRealtimeSession(env, auth, participant, providerSessionId);
      },
    );
  } catch (error) {
    await recordProviderCommitFailure(env, auth, call, {
      endpoint: "session",
      providerSessionId,
      cleanupAttempted: false,
      cleanupSucceeded: false,
      reason: errorMessage(error),
    });
    throw error;
  }
  const session = await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  const availableTracks = await availableRealtimeTracks(env, callId, providerSessionId);

  return realtimeResponse(env, call, config, {
    session: {
      ...publicRealtimeSession(session),
      sessionDescription: payload.sessionDescription ?? null,
    },
    tracks: availableTracks,
    availableTracks,
    message: "Realtime session ready",
  });
}

export async function getRealtimeTrackConfig(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown> = {},
  runMediaMutation?: CallMediaMutationRunner,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  assertConnectableCall(call);
  assertRealtimeMediaEnabled(env);
  const participant = await requireConnectedParticipant(env, auth, callId);
  const config = realtimeConfig(env);
  if (!config.configured) {
    return recordRealtimeUnavailable(
      env,
      auth,
      call,
      participant,
      config,
      "tracks",
      runMediaMutation,
    );
  }

  const providerSessionId = stringField(body, "sessionId", { max: 160 });
  if (!providerSessionId) {
    const availableTracks = await availableRealtimeTracks(env, callId);
    return realtimeResponse(env, call, config, {
      tracks: availableTracks,
      availableTracks,
      message: "Realtime tracks ready",
    });
  }

  const session = await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  const requestedTracks = parseRealtimeTracks(body, call);
  assertRealtimeTrackKindsEnabled(env, requestedTracks);
  if (requestedTracks.length === 0) {
    const availableTracks = await availableRealtimeTracks(env, callId, providerSessionId);
    return realtimeResponse(env, call, config, {
      session: publicRealtimeSession(session),
      tracks: availableTracks,
      availableTracks,
      message: "Realtime tracks ready",
    });
  }

  const payload = await realtimeProviderRequest(
    env,
    auth,
    call,
    participant,
    "tracks",
    config,
    `/sessions/${encodeURIComponent(providerSessionId)}/tracks/new`,
    {
      method: "POST",
      body: {
        sessionDescription: parseOptionalSessionDescription(body),
        tracks: requestedTracks.map(providerTrackInput),
        autoDiscover: body.autoDiscover === true,
      },
    },
    runMediaMutation,
  );
  const tracks = tracksFromPayload(payload, requestedTracks);
  try {
    await commitCallMediaMutation(
      env,
      auth,
      call,
      "call.media.tracks.upsert",
      {
        providerSessionId,
        tracks,
      },
      runMediaMutation,
      async () => {
        await upsertRealtimeTracks(env, auth, session, tracks);
      },
    );
  } catch (error) {
    const cleanup = await bestEffortCloseProviderTracks(
      env,
      config,
      providerSessionId,
      tracks,
    );
    await recordProviderCommitFailure(env, auth, call, {
      endpoint: "tracks",
      providerSessionId,
      cleanupAttempted: cleanup.attempted,
      cleanupSucceeded: cleanup.succeeded,
      reason: errorMessage(error),
    });
    throw error;
  }
  if (tracks.some((track) => track.location === "local")) {
    await emitCallEvent(env, call.room_id, {
      type: "call.updated",
      callId,
      callType: call.call_type,
      status: call.status,
    });
  }
  const availableTracks = await availableRealtimeTracks(env, callId, providerSessionId);

  return realtimeResponse(env, call, config, {
    session: publicRealtimeSession(session),
    sessionDescription: payload.sessionDescription ?? null,
    requiresImmediateRenegotiation: payload.requiresImmediateRenegotiation === true,
    tracks,
    availableTracks,
    message: "Realtime tracks ready",
  });
}

export async function renegotiateRealtimeSession(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown> = {},
  runMediaMutation?: CallMediaMutationRunner,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  assertConnectableCall(call);
  assertRealtimeMediaEnabled(env);
  const participant = await requireConnectedParticipant(env, auth, callId);
  const config = realtimeConfig(env);
  if (!config.configured) {
    return recordRealtimeUnavailable(
      env,
      auth,
      call,
      participant,
      config,
      "renegotiate",
      runMediaMutation,
    );
  }

  const providerSessionId = stringField(body, "sessionId", { required: true, max: 160 })!;
  const session = await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  const payload = await realtimeProviderRequest(
    env,
    auth,
    call,
    participant,
    "renegotiate",
    config,
    `/sessions/${encodeURIComponent(providerSessionId)}/renegotiate`,
    {
      method: "PUT",
      body: { sessionDescription: parseRequiredSessionDescription(body) },
    },
    runMediaMutation,
  );
  try {
    await commitCallMediaMutation(
      env,
      auth,
      call,
      "call.media.renegotiate.record",
      { providerSessionId },
      runMediaMutation,
      async () => {
        await recordRealtimeRenegotiated(env, auth, call, participant, providerSessionId);
      },
    );
  } catch (error) {
    await recordProviderCommitFailure(env, auth, call, {
      endpoint: "renegotiate",
      providerSessionId,
      cleanupAttempted: false,
      cleanupSucceeded: false,
      reason: errorMessage(error),
    });
    throw error;
  }
  const availableTracks = await availableRealtimeTracks(env, callId, providerSessionId);

  return realtimeResponse(env, call, config, {
    session: publicRealtimeSession(session),
    sessionDescription: payload.sessionDescription ?? null,
    tracks: availableTracks,
    availableTracks,
    message: "Realtime session renegotiated",
  });
}

export async function closeRealtimeTracks(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown> = {},
  runMediaMutation?: CallMediaMutationRunner,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  assertRealtimeMediaEnabled(env);
  const participant = await requireConnectedParticipant(env, auth, callId);
  const config = realtimeConfig(env);
  if (!config.configured) {
    return recordRealtimeUnavailable(
      env,
      auth,
      call,
      participant,
      config,
      "tracks.close",
      runMediaMutation,
    );
  }

  const providerSessionId = stringField(body, "sessionId", { required: true, max: 160 })!;
  const session = await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  const tracks = parseCloseRealtimeTracks(body);
  const payload = await realtimeProviderRequest(
    env,
    auth,
    call,
    participant,
    "tracks.close",
    config,
    `/sessions/${encodeURIComponent(providerSessionId)}/tracks/close`,
    {
      method: "PUT",
      body: {
        sessionDescription: parseOptionalSessionDescription(body),
        tracks,
        force: body.force === true,
      },
    },
    runMediaMutation,
  );
  try {
    await commitCallMediaMutation(
      env,
      auth,
      call,
      "call.media.tracks.close",
      {
        providerSessionId,
        tracks,
      },
      runMediaMutation,
      async () => {
        await markRealtimeTracksClosed(env, session, tracks);
      },
    );
  } catch (error) {
    await recordProviderCommitFailure(env, auth, call, {
      endpoint: "tracks.close",
      providerSessionId,
      cleanupAttempted: false,
      cleanupSucceeded: false,
      reason: errorMessage(error),
    });
    throw error;
  }
  const availableTracks = await availableRealtimeTracks(env, callId, providerSessionId);

  return realtimeResponse(env, call, config, {
    session: publicRealtimeSession(session),
    sessionDescription: payload.sessionDescription ?? null,
    tracks: availableTracks,
    availableTracks,
    message: "Realtime tracks closed",
  });
}

export async function recordCallUsageReport(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  const participant = await requireCurrentParticipant(env, auth, callId);
  const report = parseCallUsageReport(body);
  if (report.providerSessionId) {
    await requireOwnedRealtimeSessionForUsage(
      env,
      auth,
      callId,
      report.providerSessionId,
    );
  }
  const existingReport = await existingCallUsageReport(
    env,
    call.call_id,
    auth.device.device_id,
    report.providerSessionId,
  );
  if (existingReport) {
    return { usageReport: publicCallUsageReport(existingReport) };
  }
  const usageReportId = randomId("cur");
  const createdAt = new Date().toISOString();

  const insertResult = await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO call_usage_reports (
      call_usage_report_id, call_id, account_id, principal_id, device_id,
      provider, provider_session_id, duration_ms, audio_duration_ms,
      video_duration_ms, screen_duration_ms, bytes_sent_estimate,
      bytes_received_estimate, relay_likely, candidate_type,
      provider_egress_bytes, provider_billing_source, source, tracks_json,
      network_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      usageReportId,
      call.call_id,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      REALTIME_PROVIDER,
      report.providerSessionId,
      report.durationMs,
      report.audioDurationMs,
      report.videoDurationMs,
      report.screenDurationMs,
      report.bytesSentEstimate,
      report.bytesReceivedEstimate,
      report.relayLikely ? 1 : 0,
      report.candidateType,
      null,
      null,
      report.source,
      JSON.stringify(report.tracks),
      report.network ? JSON.stringify(report.network) : null,
      createdAt,
    )
    .run();
  if (d1Changes(insertResult) === 0) {
    const currentReport = await existingCallUsageReport(
      env,
      call.call_id,
      auth.device.device_id,
      report.providerSessionId,
    );
    if (currentReport) {
      return { usageReport: publicCallUsageReport(currentReport) };
    }
    throw new HttpError(
      409,
      "usage_report_conflict",
      "Usage report already exists",
    );
  }

  await insertCallEvent(env, auth, call.call_id, "call.usage.reported", {
    roomId: call.room_id,
    callParticipantId: participant.call_participant_id,
    provider: REALTIME_PROVIDER,
    providerSessionId: report.providerSessionId,
    durationMs: report.durationMs,
    bytesSentEstimate: report.bytesSentEstimate,
    bytesReceivedEstimate: report.bytesReceivedEstimate,
    relayLikely: report.relayLikely,
    source: report.source,
  });

  return {
    usageReport: publicCallUsageReport({
      call_usage_report_id: usageReportId,
      call_id: call.call_id,
      provider: REALTIME_PROVIDER,
      provider_session_id: report.providerSessionId,
      duration_ms: report.durationMs,
      audio_duration_ms: report.audioDurationMs,
      video_duration_ms: report.videoDurationMs,
      screen_duration_ms: report.screenDurationMs,
      bytes_sent_estimate: report.bytesSentEstimate,
      bytes_received_estimate: report.bytesReceivedEstimate,
      relay_likely: report.relayLikely ? 1 : 0,
      candidate_type: report.candidateType,
      source: report.source,
      created_at: createdAt,
    }),
  };
}

function publicCallUsageReport(row: Record<string, unknown>): JsonObject {
  return {
    usageReportId: String(row.call_usage_report_id),
    callId: String(row.call_id),
    provider: REALTIME_PROVIDER,
    providerSessionId: typeof row.provider_session_id === "string" ? row.provider_session_id : null,
    source: row.source === "provider_authoritative" ? "provider_authoritative" : CLIENT_USAGE_REPORT_SOURCE,
    durationMs: Number(row.duration_ms ?? 0),
    audioDurationMs: Number(row.audio_duration_ms ?? 0),
    videoDurationMs: Number(row.video_duration_ms ?? 0),
    screenDurationMs: Number(row.screen_duration_ms ?? 0),
    bytesSentEstimate: Number(row.bytes_sent_estimate ?? 0),
    bytesReceivedEstimate: Number(row.bytes_received_estimate ?? 0),
    relayLikely: Number(row.relay_likely ?? 0) === 1,
    candidateType: typeof row.candidate_type === "string" ? row.candidate_type : null,
    createdAt: String(row.created_at),
  };
}

async function existingCallUsageReport(
  env: Env,
  callId: string,
  deviceId: string,
  providerSessionId: string | null,
): Promise<Record<string, unknown> | null> {
  return (
    (await env.CONTROL_DB.prepare(
      `SELECT *
       FROM call_usage_reports
       WHERE call_id = ?
         AND device_id = ?
         AND COALESCE(provider_session_id, '') = COALESCE(?, '')
       ORDER BY created_at ASC
       LIMIT 1`,
    )
      .bind(callId, deviceId, providerSessionId)
      .first<Record<string, unknown>>()) ?? null
  );
}

export async function getCall(env: Env, callId: string): Promise<CallRow> {
  const call = await env.CONTROL_DB.prepare("SELECT * FROM calls WHERE call_id = ?")
    .bind(callId)
    .first<CallRow>();
  if (!call) throw new HttpError(404, "call_not_found", "Call not found");
  return call;
}

export interface CallLifecycleReconcileResult {
  live: boolean;
  status?: CallStatus;
  nextAlarmAt?: number;
}

export async function reconcileCallLifecycleForCoordinator(
  env: Env,
  callId: string,
  options: {
    ringTimeoutMs: number;
    participantLivenessTimeoutMs: number;
    nowMs?: number;
  },
): Promise<CallLifecycleReconcileResult> {
  const nowMs = options.nowMs ?? Date.now();
  let call: CallRow;
  try {
    call = await getCall(env, callId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { live: false };
    }
    throw error;
  }
  if (!LIVE_CALL_STATUSES.includes(call.status)) {
    return { live: false, status: call.status };
  }

  await expireStaleConnectedParticipants(
    env,
    call,
    nowMs,
    options.participantLivenessTimeoutMs,
  );
  call = await getCall(env, callId);
  if (!LIVE_CALL_STATUSES.includes(call.status)) {
    return { live: false, status: call.status };
  }

  if (call.status === "ringing") {
    const connected = await participantCount(env, callId, "connected");
    if (connected >= 2) {
      await activateCallIfReady(env, call);
      call = await getCall(env, callId);
    } else if (nowMs >= timestampMs(call.created_at) + options.ringTimeoutMs) {
      await endCall(env, call, "missed", "ring_timeout");
      return { live: false, status: "missed" };
    }
  }

  const refreshed = await getCall(env, callId);
  if (!LIVE_CALL_STATUSES.includes(refreshed.status)) {
    return { live: false, status: refreshed.status };
  }
  return {
    live: true,
    status: refreshed.status,
    nextAlarmAt: await nextLifecycleAlarmAt(
      env,
      refreshed,
      nowMs,
      options.ringTimeoutMs,
      options.participantLivenessTimeoutMs,
    ),
  };
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

function callFeatureFlags(env: Env): CallFeatureFlags {
  return {
    callsEnabled: envFlagEnabled(env.CALLS_ENABLED, true),
    audioCallsEnabled: envFlagEnabled(env.AUDIO_CALLS_ENABLED, true),
    videoCallsEnabled: envFlagEnabled(env.VIDEO_CALLS_ENABLED, true),
    screenShareEnabled: envFlagEnabled(env.SCREEN_SHARE_ENABLED, true),
    realtimeMediaEnabled: envFlagEnabled(env.CALLS_REALTIME_MEDIA_ENABLED, true),
  };
}

function envFlagEnabled(raw: string | undefined, fallback: boolean): boolean {
  const value = trimmedEnv(raw);
  if (value === undefined) return fallback;
  return !FEATURE_DISABLED_VALUES.has(value.toLowerCase());
}

function assertCallsEnabled(env: Env): void {
  if (!callFeatureFlags(env).callsEnabled) {
    throw new HttpError(403, "feature_disabled", "Calls are disabled for this environment");
  }
}

function assertCallTypeEnabled(env: Env, callType: CallType): void {
  if (callType === "audio" && !callFeatureFlags(env).audioCallsEnabled) {
    throw new HttpError(403, "feature_disabled", "Audio calls are disabled for this environment");
  }
  if (callType === "video") assertVideoCallsEnabled(env);
}

function assertVideoCallsEnabled(env: Env): void {
  if (!callFeatureFlags(env).videoCallsEnabled) {
    throw new HttpError(403, "feature_disabled", "Video calls are disabled for this environment");
  }
}

function assertScreenShareEnabled(env: Env): void {
  if (!callFeatureFlags(env).screenShareEnabled) {
    throw new HttpError(403, "feature_disabled", "Screen sharing is disabled for this environment");
  }
}

function assertRealtimeMediaEnabled(env: Env): void {
  if (!callFeatureFlags(env).realtimeMediaEnabled) {
    throw new HttpError(403, "feature_disabled", "Realtime call media is disabled for this environment");
  }
}

function assertRealtimeTrackKindsEnabled(env: Env, tracks: RealtimeTrackInput[]): void {
  for (const track of tracks) {
    if (track.kind === "video") assertVideoCallsEnabled(env);
    if (track.kind === "screen") assertScreenShareEnabled(env);
  }
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_field", `Field must be a boolean: ${key}`);
  }
  return value;
}

function d1Changes(result: D1Result): number {
  const changes = (result.meta as { changes?: number } | undefined)?.changes;
  return typeof changes === "number" ? changes : 1;
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

async function requireConnectedParticipant(
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

async function updateParticipantStatus(
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

async function updateParticipantMediaState(
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

async function expireStaleConnectedParticipants(
  env: Env,
  call: CallRow,
  nowMs: number,
  participantLivenessTimeoutMs: number,
): Promise<void> {
  const cutoff = sqliteTimestamp(nowMs - participantLivenessTimeoutMs);
  const result = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM call_participants
     WHERE call_id = ?
       AND status = 'connected'
       AND COALESCE(last_seen_at, joined_at, updated_at, created_at) <= ?`,
  )
    .bind(call.call_id, cutoff)
    .all<CallParticipantRow>();
  const staleParticipants = result.results ?? [];
  for (const participant of staleParticipants) {
    const update = await env.CONTROL_DB.prepare(
      `UPDATE call_participants
       SET status = 'failed',
           left_at = COALESCE(left_at, CURRENT_TIMESTAMP),
           muted_at = NULL,
           audio_enabled = 0,
           video_enabled = 0,
           screen_enabled = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE call_participant_id = ? AND status = 'connected'`,
    )
      .bind(participant.call_participant_id)
      .run();
    if (d1Changes(update) === 0) continue;
    await closeParticipantRealtimeSessions(env, call.call_id, participant.call_participant_id);
    await insertCallEvent(env, null, call.call_id, "call.participant.timeout", {
      roomId: call.room_id,
      principalId: participant.principal_id,
      deviceId: participant.device_id,
    });
    await emitCallEvent(env, call.room_id, {
      type: "call.left",
      callId: call.call_id,
      callType: call.call_type,
      principalId: participant.principal_id,
      deviceId: participant.device_id ?? undefined,
      reason: "timeout",
    });
  }
  if (staleParticipants.length > 0) {
    await maybeEndCallAfterDeparture(env, call.call_id, "participant_timeout");
    await emitCallUpdated(env, call.call_id);
  }
}

async function nextLifecycleAlarmAt(
  env: Env,
  call: CallRow,
  nowMs: number,
  ringTimeoutMs: number,
  participantLivenessTimeoutMs: number,
): Promise<number | undefined> {
  const deadlines: number[] = [];
  if (call.status === "ringing") {
    deadlines.push(timestampMs(call.created_at) + ringTimeoutMs);
  }
  const result = await env.CONTROL_DB.prepare(
    `SELECT COALESCE(last_seen_at, joined_at, updated_at, created_at) AS seen_at
     FROM call_participants
     WHERE call_id = ? AND status = 'connected'`,
  )
    .bind(call.call_id)
    .all<{ seen_at: string | null }>();
  for (const row of result.results ?? []) {
    if (row.seen_at) deadlines.push(timestampMs(row.seen_at) + participantLivenessTimeoutMs);
  }
  const futureDeadlines = deadlines.filter((deadline) => Number.isFinite(deadline));
  if (!futureDeadlines.length) return undefined;
  return Math.max(nowMs + 1_000, Math.min(...futureDeadlines));
}

async function endCall(
  env: Env,
  call: CallRow,
  status: Extract<CallStatus, "ended" | "declined" | "missed" | "failed">,
  reason: string,
): Promise<void> {
  const result = await env.CONTROL_DB.prepare(
    `UPDATE calls
     SET status = ?,
         ended_reason = ?,
         ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ? AND status IN ('ringing', 'active')`,
  )
    .bind(status, reason, call.call_id)
    .run();
  if (d1Changes(result) === 0) return;
  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET status = CASE
           WHEN status IN ('invited', 'ringing', 'joining') THEN 'missed'
           WHEN status = 'connected' THEN 'left'
           ELSE status
         END,
         left_at = CASE WHEN left_at IS NULL AND status = 'connected' THEN CURRENT_TIMESTAMP ELSE left_at END,
         muted_at = CASE WHEN status = 'connected' THEN NULL ELSE muted_at END,
         audio_enabled = 0,
         video_enabled = 0,
         screen_enabled = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ? AND status IN ('invited', 'ringing', 'joining', 'connected')`,
  )
    .bind(call.call_id)
    .run();
  await closeCallRealtimeSessions(env, call.call_id);
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
  await emitCallEvent(env, call.room_id, {
    type: "call.updated",
    callId: call.call_id,
    callType: call.call_type,
    status,
  });
}

function timestampMs(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.now();
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

interface RealtimeConfig {
  configured: boolean;
  mock: boolean;
  appId?: string;
  appSecret?: string;
  apiBase: string;
  iceServers: JsonObject[];
}

interface RealtimeSessionDescription {
  sdp: string;
  type: string;
}

interface RealtimeTrackInput {
  location: CallRealtimeTrackLocation;
  sessionId?: string;
  trackName: string;
  kind: CallRealtimeTrackKind;
  mid?: string;
  bidirectionalMediaStream?: boolean;
  simulcast?: JsonObject;
}

interface RealtimeApiRequestOptions {
  method: "GET" | "POST" | "PUT";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

interface CloseRealtimeTrackInput {
  mid: string;
}

interface CallFeatureFlags extends JsonObject {
  callsEnabled: boolean;
  audioCallsEnabled: boolean;
  videoCallsEnabled: boolean;
  screenShareEnabled: boolean;
  realtimeMediaEnabled: boolean;
}

interface ParsedCallUsageReport {
  providerSessionId: string | null;
  source: typeof CLIENT_USAGE_REPORT_SOURCE;
  durationMs: number;
  audioDurationMs: number;
  videoDurationMs: number;
  screenDurationMs: number;
  bytesSentEstimate: number;
  bytesReceivedEstimate: number;
  relayLikely: boolean;
  candidateType: string | null;
  tracks: JsonObject[];
  network: JsonObject | null;
}

function realtimeConfig(env: Env): RealtimeConfig {
  const mock = env.CLOUDFLARE_REALTIME_MOCK === "1";
  const appId = trimmedEnv(env.CLOUDFLARE_REALTIME_APP_ID);
  const appSecret = trimmedEnv(env.CLOUDFLARE_REALTIME_APP_SECRET);
  const apiBase = trimmedEnv(env.CLOUDFLARE_REALTIME_API_BASE) ?? DEFAULT_REALTIME_API_BASE;
  const iceServers: JsonObject[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  const turnUsername = trimmedEnv(env.CLOUDFLARE_REALTIME_TURN_USERNAME);
  const turnCredential = trimmedEnv(env.CLOUDFLARE_REALTIME_TURN_CREDENTIAL);
  if (turnUsername && turnCredential) {
    iceServers.push({
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
      ],
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return {
    configured: mock || Boolean(appId && appSecret),
    mock,
    appId,
    appSecret,
    apiBase: apiBase.replace(/\/+$/, ""),
    iceServers,
  };
}

export function getCallRealtimeStatus(env: Env): JsonObject {
  const config = realtimeConfig(env);
  const features = callFeatureFlags(env);
  const turnConfigured = config.iceServers.some((server) => Array.isArray(server.urls)
    ? server.urls.some((url) => typeof url === "string" && url.startsWith("turn"))
    : typeof server.urls === "string" && server.urls.startsWith("turn"));
  const configurationStatus = !features.realtimeMediaEnabled
    ? "disabled"
    : config.configured
      ? "configured"
      : "not_configured";
  const checkedAt = new Date().toISOString();
  return {
    provider: REALTIME_PROVIDER,
    configured: config.configured,
    status: configurationStatus,
    configurationStatus,
    configurationCheckedAt: checkedAt,
    providerHealthStatus: "not_checked",
    providerHealthCheckedAt: null,
    mock: config.mock,
    apiBase: config.apiBase,
    turnConfigured,
    features,
    credentialState: {
      appIdConfigured: Boolean(config.appId) || config.mock,
      appSecretConfigured: Boolean(config.appSecret) || config.mock,
      turnCredentialsConfigured: turnConfigured,
    },
    lastProviderCheckAt: null,
    lastProviderCheckStatus: "not_checked",
    estimatedSfuTurnEgressStatus: "unavailable_provider_metric",
  };
}

function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configuredMs(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function realtimeUnavailable(env: Env, call: CallRow, config: RealtimeConfig): JsonObject {
  return realtimeResponse(env, call, config, {
    session: null,
    tracks: [],
    availableTracks: [],
    message: "Cloudflare Realtime is not configured for this environment.",
  });
}

async function recordRealtimeUnavailable(
  env: Env,
  auth: AuthContext,
  call: CallRow,
  participant: CallParticipantRow,
  config: RealtimeConfig,
  endpoint: string,
  runMediaMutation?: CallMediaMutationRunner,
): Promise<JsonObject> {
  await commitCallMediaMutation(
    env,
    auth,
    call,
    "call.media.unavailable.record",
    { endpoint, reason: "cloudflare_realtime_not_configured" },
    runMediaMutation,
    async () => {
      await recordRealtimeMediaFailure(
        env,
        auth,
        call,
        participant,
        endpoint,
        "cloudflare_realtime_not_configured",
      );
    },
  );
  return realtimeUnavailable(env, call, config);
}

async function commitCallMediaMutation(
  env: Env,
  auth: AuthContext,
  call: CallRow,
  operation: string,
  body: Record<string, unknown>,
  runMediaMutation: CallMediaMutationRunner | undefined,
  fallback: () => Promise<void>,
): Promise<void> {
  if (runMediaMutation) {
    await runMediaMutation(operation, body);
    return;
  }
  await fallback();
  await reconcileCallLifecycleForCoordinator(env, call.call_id, {
    ringTimeoutMs: configuredMs(env.CALL_RING_TIMEOUT_MS, 5_000, 10 * 60_000, 60_000),
    participantLivenessTimeoutMs: configuredMs(
      env.CALL_PARTICIPANT_LIVENESS_TIMEOUT_MS,
      30_000,
      30 * 60_000,
      120_000,
    ),
  });
}

async function realtimeProviderRequest(
  env: Env,
  auth: AuthContext,
  call: CallRow,
  participant: CallParticipantRow,
  endpoint: string,
  config: RealtimeConfig,
  path: string,
  options: RealtimeApiRequestOptions,
  runMediaMutation?: CallMediaMutationRunner,
): Promise<Record<string, unknown>> {
  try {
    return await realtimeApiRequest(env, config, path, options);
  } catch (error) {
    const reason = error instanceof HttpError ? error.code : "realtime_provider_error";
    await commitCallMediaMutation(
      env,
      auth,
      call,
      "call.media.provider_failure.record",
      { endpoint, reason },
      runMediaMutation,
      async () => {
        await recordRealtimeMediaFailure(env, auth, call, participant, endpoint, reason);
      },
    );
    throw error;
  }
}

async function bestEffortCloseProviderTracks(
  env: Env,
  config: RealtimeConfig,
  providerSessionId: string,
  tracks: RealtimeTrackInput[],
): Promise<{ attempted: boolean; succeeded: boolean }> {
  const mids = tracks
    .map((track) => track.mid)
    .filter((mid): mid is string => typeof mid === "string" && mid.length > 0);
  if (!mids.length) return { attempted: false, succeeded: false };
  try {
    await realtimeApiRequest(
      env,
      config,
      `/sessions/${encodeURIComponent(providerSessionId)}/tracks/close`,
      {
        method: "PUT",
        body: {
          tracks: mids.map((mid) => ({ mid })),
          force: true,
        },
      },
    );
    return { attempted: true, succeeded: true };
  } catch (error) {
    console.warn("best-effort realtime provider track cleanup failed", error);
    return { attempted: true, succeeded: false };
  }
}

async function recordProviderCommitFailure(
  env: Env,
  auth: AuthContext,
  call: CallRow,
  details: {
    endpoint: string;
    providerSessionId: string;
    cleanupAttempted: boolean;
    cleanupSucceeded: boolean;
    reason: string;
  },
): Promise<void> {
  await insertCallEvent(env, auth, call.call_id, "call.media.provider_orphan_risk", {
    roomId: call.room_id,
    provider: REALTIME_PROVIDER,
    ...details,
  }).catch((error) => {
    console.warn("could not record realtime provider orphan risk", error);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordRealtimeMediaFailure(
  env: Env,
  auth: AuthContext,
  call: CallRow,
  participant: CallParticipantRow,
  endpoint: string,
  reason: string,
): Promise<void> {
  await updateParticipantMediaState(env, participant.call_participant_id, {
    heartbeat: true,
  });
  await insertCallEvent(env, auth, call.call_id, "call.media.join_failed", {
    roomId: call.room_id,
    callParticipantId: participant.call_participant_id,
    deviceId: auth.device.device_id,
    provider: REALTIME_PROVIDER,
    endpoint,
    reason,
  });
}

async function recordRealtimeRenegotiated(
  env: Env,
  auth: AuthContext,
  call: CallRow,
  participant: CallParticipantRow,
  providerSessionId: string,
): Promise<void> {
  await updateParticipantMediaState(env, participant.call_participant_id, {
    heartbeat: true,
  });
  await insertCallEvent(env, auth, call.call_id, "call.media.renegotiated", {
    roomId: call.room_id,
    callParticipantId: participant.call_participant_id,
    deviceId: auth.device.device_id,
    provider: REALTIME_PROVIDER,
    providerSessionId,
  });
}

function realtimeResponse(
  env: Env,
  call: CallRow,
  config: RealtimeConfig,
  extra: JsonObject,
): JsonObject {
  return {
    provider: REALTIME_PROVIDER,
    configured: config.configured,
    features: callFeatureFlags(env),
    callId: call.call_id,
    callType: call.call_type,
    status: call.status,
    iceServers: config.iceServers,
    ...extra,
  };
}

async function realtimeApiRequest(
  _env: Env,
  config: RealtimeConfig,
  path: string,
  options: RealtimeApiRequestOptions,
): Promise<Record<string, unknown>> {
  if (config.mock) {
    return mockRealtimeApiRequest(path, options);
  }
  if (!config.appId || !config.appSecret) {
    throw new HttpError(
      503,
      "realtime_not_configured",
      "Cloudflare Realtime is not configured",
    );
  }

  const url = new URL(`${config.apiBase}/apps/${encodeURIComponent(config.appId)}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    method: options.method,
    headers: {
      authorization: `Bearer ${config.appSecret}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(stripUndefined(options.body)) : undefined,
  });

  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown = {};
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
  } else if (!response.ok) {
    payload = { errorDescription: await response.text().catch(() => "") };
  }
  const objectPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const providerError = typeof objectPayload.errorCode === "string" ? objectPayload.errorCode : undefined;
  if (!response.ok || providerError) {
    const description =
      typeof objectPayload.errorDescription === "string" && objectPayload.errorDescription.trim()
        ? objectPayload.errorDescription
        : "Cloudflare Realtime request failed";
    throw new HttpError(502, "realtime_provider_error", description, {
      status: response.status,
      errorCode: providerError,
    });
  }
  return objectPayload;
}

function mockRealtimeApiRequest(
  path: string,
  options: RealtimeApiRequestOptions,
): Record<string, unknown> {
  if (options.method === "POST" && path === "/sessions/new") {
    const correlationId = options.query?.correlationId ?? "session";
    return {
      sessionId: `mock_${stableToken(correlationId)}`,
      sessionDescription: mockSessionDescription(options.body?.sessionDescription),
    };
  }

  const tracksNewMatch = /^\/sessions\/([^/]+)\/tracks\/new$/.exec(path);
  if (options.method === "POST" && tracksNewMatch) {
    const providerSessionId = decodeURIComponent(tracksNewMatch[1]);
    const tracks = Array.isArray(options.body?.tracks)
      ? options.body.tracks.map((track, index) =>
          mockTrackPayload(track, providerSessionId, index),
        )
      : [];
    return {
      tracks,
      sessionDescription: mockSessionDescription(options.body?.sessionDescription),
      requiresImmediateRenegotiation: tracks.some((track) => track.location === "remote"),
    };
  }

  const renegotiateMatch = /^\/sessions\/([^/]+)\/renegotiate$/.exec(path);
  if (options.method === "PUT" && renegotiateMatch) {
    return {
      sessionId: decodeURIComponent(renegotiateMatch[1]),
      sessionDescription: mockSessionDescription(options.body?.sessionDescription),
    };
  }

  const closeMatch = /^\/sessions\/([^/]+)\/tracks\/close$/.exec(path);
  if (options.method === "PUT" && closeMatch) {
    return {
      sessionId: decodeURIComponent(closeMatch[1]),
      tracks: Array.isArray(options.body?.tracks) ? options.body.tracks : [],
      closed: true,
      sessionDescription: mockSessionDescription(options.body?.sessionDescription),
    };
  }

  throw new HttpError(404, "realtime_mock_route_not_found", "Realtime mock route not found");
}

function mockTrackPayload(
  rawTrack: unknown,
  providerSessionId: string,
  index: number,
): JsonObject {
  const track =
    rawTrack && typeof rawTrack === "object" && !Array.isArray(rawTrack)
      ? (rawTrack as Record<string, unknown>)
      : {};
  const location = providerString(track.location) === "remote" ? "remote" : "local";
  const kind = providerKind(track.kind) ?? "audio";
  const trackName =
    providerString(track.trackName) ?? `mock_${stableToken(`${providerSessionId}:${index}`)}`;
  return {
    location,
    sessionId:
      location === "remote"
        ? providerString(track.sessionId) ?? providerSessionId
        : providerSessionId,
    trackName,
    kind,
    mid: providerString(track.mid) ?? `${location}-${index}`,
    bidirectionalMediaStream:
      typeof track.bidirectionalMediaStream === "boolean"
        ? track.bidirectionalMediaStream
        : undefined,
    simulcast: providerObject(track.simulcast),
  };
}

function mockSessionDescription(value: unknown): RealtimeSessionDescription {
  const requested =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const requestedType = providerString(requested.type);
  return {
    type: requestedType === "offer" ? "answer" : "offer",
    sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Voyager mock realtime\r\nt=0 0\r\n",
  };
}

function stableToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]),
  );
}

function parseOptionalSessionDescription(
  body: Record<string, unknown>,
): RealtimeSessionDescription | undefined {
  const sessionDescription = optionalObject(body, "sessionDescription");
  return sessionDescription ? parseSessionDescription(sessionDescription) : undefined;
}

function parseRequiredSessionDescription(
  body: Record<string, unknown>,
): RealtimeSessionDescription {
  const sessionDescription = optionalObject(body, "sessionDescription");
  if (!sessionDescription) {
    throw new HttpError(400, "missing_field", "Missing required field: sessionDescription");
  }
  return parseSessionDescription(sessionDescription);
}

function parseSessionDescription(
  body: Record<string, unknown>,
): RealtimeSessionDescription {
  const sdp = stringField(body, "sdp", { required: true, min: 1, max: 2_000_000 })!;
  const type = stringField(body, "type", { required: true, max: 20 })!;
  if (!["offer", "answer", "pranswer", "rollback"].includes(type)) {
    throw new HttpError(400, "invalid_field", "Field is invalid: sessionDescription.type");
  }
  return { sdp, type };
}

function parseRealtimeTracks(
  body: Record<string, unknown>,
  call: CallRow,
): RealtimeTrackInput[] {
  const rawTracks = body.tracks;
  if (rawTracks === undefined || rawTracks === null) return [];
  if (!Array.isArray(rawTracks)) {
    throw new HttpError(400, "invalid_field", "Field must be an array: tracks");
  }
  if (rawTracks.length > 20) {
    throw new HttpError(400, "invalid_field", "Field has too many items: tracks");
  }
  return rawTracks.map((rawTrack, index) => {
    if (!rawTrack || typeof rawTrack !== "object" || Array.isArray(rawTrack)) {
      throw new HttpError(400, "invalid_field", `Field must be an object: tracks[${index}]`);
    }
    const track = rawTrack as Record<string, unknown>;
    const location = parseTrackLocation(track, `tracks[${index}].location`);
    const kind = parseTrackKind(track, `tracks[${index}].kind`);
    if (call.call_type === "audio" && kind !== "audio") {
      throw new HttpError(400, "invalid_track_kind", "Audio calls can only publish audio tracks");
    }
    const sessionId = stringField(track, "sessionId", { max: 160 });
    if (location === "remote" && !sessionId) {
      throw new HttpError(400, "missing_field", `Missing required field: tracks[${index}].sessionId`);
    }
    const bidirectionalMediaStream = track.bidirectionalMediaStream;
    if (bidirectionalMediaStream !== undefined && typeof bidirectionalMediaStream !== "boolean") {
      throw new HttpError(
        400,
        "invalid_field",
        `Field must be a boolean: tracks[${index}].bidirectionalMediaStream`,
      );
    }
    return {
      location,
      sessionId,
      trackName: stringField(track, "trackName", { max: 160 }) ?? randomId("rtrack"),
      kind,
      mid: stringField(track, "mid", { max: 80 }),
      bidirectionalMediaStream: bidirectionalMediaStream === true ? true : undefined,
      simulcast: parseRealtimeSimulcast(track, index),
    };
  });
}

function parseRealtimeSimulcast(
  track: Record<string, unknown>,
  index: number,
): JsonObject | undefined {
  const simulcast = optionalObject(track, "simulcast");
  if (!simulcast) return undefined;
  const preferredRid = stringField(simulcast, "preferredRid", {
    max: 16,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
  const priorityOrdering = stringField(simulcast, "priorityOrdering", { max: 40 });
  const ridNotAvailable = stringField(simulcast, "ridNotAvailable", { max: 40 });
  if (
    priorityOrdering !== undefined &&
    priorityOrdering !== "none" &&
    priorityOrdering !== "asciibetical"
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field is invalid: tracks[${index}].simulcast.priorityOrdering`,
    );
  }
  if (
    ridNotAvailable !== undefined &&
    ridNotAvailable !== "none" &&
    ridNotAvailable !== "asciibetical"
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field is invalid: tracks[${index}].simulcast.ridNotAvailable`,
    );
  }
  return {
    preferredRid,
    priorityOrdering,
    ridNotAvailable,
  };
}

function parseTrackLocation(
  track: Record<string, unknown>,
  field: string,
): CallRealtimeTrackLocation {
  const location = stringField(track, "location", { required: true, max: 20 });
  if (location !== "local" && location !== "remote") {
    throw new HttpError(400, "invalid_field", `Field is invalid: ${field}`);
  }
  return location;
}

function parseTrackKind(
  track: Record<string, unknown>,
  field: string,
): CallRealtimeTrackKind {
  const kind = stringField(track, "kind", { max: 20 }) ?? "audio";
  if (kind !== "audio" && kind !== "video" && kind !== "screen" && kind !== "data") {
    throw new HttpError(400, "invalid_field", `Field is invalid: ${field}`);
  }
  return kind;
}

function parseCloseRealtimeTracks(body: Record<string, unknown>): CloseRealtimeTrackInput[] {
  const rawTracks = body.tracks;
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    throw new HttpError(400, "invalid_field", "Field must be a non-empty array: tracks");
  }
  if (rawTracks.length > 20) {
    throw new HttpError(400, "invalid_field", "Field has too many items: tracks");
  }
  return rawTracks.map((rawTrack, index) => {
    if (!rawTrack || typeof rawTrack !== "object" || Array.isArray(rawTrack)) {
      throw new HttpError(400, "invalid_field", `Field must be an object: tracks[${index}]`);
    }
    const mid = stringField(rawTrack as Record<string, unknown>, "mid", {
      required: true,
      max: 80,
    })!;
    return { mid };
  });
}

function parseCallUsageReport(body: Record<string, unknown>): ParsedCallUsageReport {
  const providerSessionId = stringField(body, "sessionId", { max: 160 }) ?? null;
  if (body.providerEgressBytes !== undefined || body.providerBillingSource !== undefined) {
    throw new HttpError(
      400,
      "provider_usage_not_authoritative",
      "Provider billing metrics must come from an authoritative provider source",
    );
  }
  const rawTracks = body.tracks;
  if (rawTracks !== undefined && !Array.isArray(rawTracks)) {
    throw new HttpError(400, "invalid_field", "Field must be an array: tracks");
  }
  const trackInputs = (rawTracks ?? []) as unknown[];
  if (trackInputs.length > 32) {
    throw new HttpError(400, "invalid_field", "Field has too many items: tracks");
  }

  let audioDurationMs = 0;
  let videoDurationMs = 0;
  let screenDurationMs = 0;
  let bytesSentEstimate = 0;
  let bytesReceivedEstimate = 0;
  const tracks: JsonObject[] = [];
  for (const [index, rawTrack] of trackInputs.entries()) {
    if (!rawTrack || typeof rawTrack !== "object" || Array.isArray(rawTrack)) {
      throw new HttpError(400, "invalid_field", `Field must be an object: tracks[${index}]`);
    }
    const track = rawTrack as Record<string, unknown>;
    const kind = parseTrackKind(track, `tracks[${index}].kind`);
    const direction = stringField(track, "direction", { max: 20 }) ?? "send";
    if (direction !== "send" && direction !== "receive") {
      throw new HttpError(400, "invalid_field", `Field is invalid: tracks[${index}].direction`);
    }
    const durationMs = optionalIntegerField(track, "durationMs", 0, MAX_USAGE_REPORT_DURATION_MS) ?? 0;
    const bytes = optionalIntegerField(track, "bytes", 0, MAX_USAGE_REPORT_BYTES) ?? 0;
    const qualityLayer = stringField(track, "qualityLayer", { max: 40 }) ?? null;
    if (kind === "audio") audioDurationMs += durationMs;
    else if (kind === "video") videoDurationMs += durationMs;
    else if (kind === "screen") screenDurationMs += durationMs;
    if (direction === "send") bytesSentEstimate += bytes;
    else bytesReceivedEstimate += bytes;
    tracks.push({
      kind,
      direction,
      durationMs,
      bytes,
      qualityLayer,
    });
  }

  const network = optionalObject(body, "network");
  const relayLikely = network ? optionalBoolean(network, "relayLikely") === true : false;
  const candidateType = network ? stringField(network, "candidateType", { max: 40 }) ?? null : null;
  const declaredDurationMs = optionalIntegerField(body, "durationMs", 0, MAX_USAGE_REPORT_DURATION_MS);
  const durationMs = declaredDurationMs ?? Math.max(audioDurationMs, videoDurationMs, screenDurationMs, 0);
  const declaredBytesSent = optionalIntegerField(body, "bytesSentEstimate", 0, MAX_USAGE_REPORT_BYTES);
  const declaredBytesReceived = optionalIntegerField(body, "bytesReceivedEstimate", 0, MAX_USAGE_REPORT_BYTES);

  return {
    providerSessionId,
    source: CLIENT_USAGE_REPORT_SOURCE,
    durationMs,
    audioDurationMs,
    videoDurationMs,
    screenDurationMs,
    bytesSentEstimate: declaredBytesSent ?? bytesSentEstimate,
    bytesReceivedEstimate: declaredBytesReceived ?? bytesReceivedEstimate,
    relayLikely,
    candidateType,
    tracks,
    network: network
      ? {
          candidateType,
          relayLikely,
          roundTripTimeMs: optionalIntegerField(network, "roundTripTimeMs", 0, 60_000) ?? null,
          packetsLost: optionalIntegerField(network, "packetsLost", 0, MAX_USAGE_REPORT_BYTES) ?? null,
        }
      : null,
  };
}

function optionalIntegerField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_field", `Field must be a number: ${key}`);
  }
  if (value < min || value > max) {
    throw new HttpError(400, "invalid_field", `Field is out of range: ${key}`);
  }
  return Math.trunc(value);
}

function providerTrackInput(track: RealtimeTrackInput): JsonObject {
  return {
    location: track.location,
    sessionId: track.sessionId,
    trackName: track.trackName,
    kind: track.kind,
    mid: track.mid,
    bidirectionalMediaStream: track.bidirectionalMediaStream,
    simulcast: track.simulcast,
  };
}

function tracksFromPayload(
  payload: Record<string, unknown>,
  fallback: RealtimeTrackInput[],
): RealtimeTrackInput[] {
  const payloadTracks = payload.tracks;
  if (!Array.isArray(payloadTracks)) return fallback;
  return payloadTracks.map((rawTrack, index) => {
    const fallbackTrack = fallback[index] ?? {
      location: "local" as const,
      trackName: randomId("rtrack"),
      kind: "audio" as const,
    };
    if (!rawTrack || typeof rawTrack !== "object" || Array.isArray(rawTrack)) return fallbackTrack;
    const track = rawTrack as Record<string, unknown>;
    return {
      location: providerString(track.location) === "remote" ? "remote" : fallbackTrack.location,
      sessionId: providerString(track.sessionId) ?? fallbackTrack.sessionId,
      trackName: providerString(track.trackName) ?? fallbackTrack.trackName,
      kind: providerKind(track.kind) ?? fallbackTrack.kind,
      mid: providerString(track.mid) ?? fallbackTrack.mid,
      bidirectionalMediaStream:
        typeof track.bidirectionalMediaStream === "boolean"
          ? track.bidirectionalMediaStream
          : fallbackTrack.bidirectionalMediaStream,
      simulcast: providerObject(track.simulcast) ?? fallbackTrack.simulcast,
    };
  });
}

function providerString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function providerKind(value: unknown): CallRealtimeTrackKind | undefined {
  if (value === "audio" || value === "video" || value === "screen" || value === "data") return value;
  return undefined;
}

async function upsertRealtimeSession(
  env: Env,
  auth: AuthContext,
  participant: CallParticipantRow,
  providerSessionId: string,
): Promise<CallRealtimeSessionRow> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO call_realtime_sessions (
       call_realtime_session_id, call_id, call_participant_id, account_id,
       principal_id, device_id, provider, provider_session_id, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(provider, provider_session_id) DO UPDATE SET
       call_id = excluded.call_id,
       call_participant_id = excluded.call_participant_id,
       account_id = excluded.account_id,
       principal_id = excluded.principal_id,
       device_id = excluded.device_id,
       status = 'active',
       closed_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      randomId("crs"),
      participant.call_id,
      participant.call_participant_id,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      REALTIME_PROVIDER,
      providerSessionId,
    )
    .run();
  const session = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM call_realtime_sessions
     WHERE provider = ? AND provider_session_id = ?`,
  )
    .bind(REALTIME_PROVIDER, providerSessionId)
    .first<CallRealtimeSessionRow>();
  if (!session) {
    throw new HttpError(500, "realtime_session_not_saved", "Realtime session was not saved");
  }
  return session;
}

async function requireOwnedRealtimeSession(
  env: Env,
  auth: AuthContext,
  callId: string,
  providerSessionId: string,
): Promise<CallRealtimeSessionRow> {
  const session = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM call_realtime_sessions
     WHERE call_id = ?
       AND provider = ?
       AND provider_session_id = ?
       AND account_id = ?
       AND principal_id = ?
       AND device_id = ?
       AND status = 'active'
     LIMIT 1`,
  )
    .bind(
      callId,
      REALTIME_PROVIDER,
      providerSessionId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
    )
    .first<CallRealtimeSessionRow>();
  if (!session) {
    throw new HttpError(
      404,
      "realtime_session_not_found",
      "Realtime session not found",
    );
  }
  return session;
}

async function requireOwnedRealtimeSessionForUsage(
  env: Env,
  auth: AuthContext,
  callId: string,
  providerSessionId: string,
): Promise<CallRealtimeSessionRow> {
  const session = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM call_realtime_sessions
     WHERE call_id = ?
       AND provider = ?
       AND provider_session_id = ?
       AND account_id = ?
       AND principal_id = ?
       AND device_id = ?
     LIMIT 1`,
  )
    .bind(
      callId,
      REALTIME_PROVIDER,
      providerSessionId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
    )
    .first<CallRealtimeSessionRow>();
  if (!session) {
    throw new HttpError(
      404,
      "realtime_session_not_found",
      "Realtime session not found",
    );
  }
  return session;
}

async function activeRealtimeSessionForParticipant(
  env: Env,
  callId: string,
  callParticipantId: string,
): Promise<CallRealtimeSessionRow | null> {
  return env.CONTROL_DB.prepare(
    `SELECT *
     FROM call_realtime_sessions
     WHERE call_id = ?
       AND call_participant_id = ?
       AND provider = ?
       AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
    .bind(callId, callParticipantId, REALTIME_PROVIDER)
    .first<CallRealtimeSessionRow>();
}

export async function commitRealtimeSessionUpsertForCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const providerSessionId = stringField(body, "providerSessionId", {
    required: true,
    max: 160,
  })!;
  const { call, participant } = await requireConnectedMediaCommitContext(
    env,
    auth,
    callId,
  );
  const session = await upsertRealtimeSession(env, auth, participant, providerSessionId);
  await updateParticipantMediaState(env, participant.call_participant_id, {
    heartbeat: true,
  });
  return {
    callId: call.call_id,
    session: publicRealtimeSession(session),
  };
}

export async function commitRealtimeTracksUpsertForCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const providerSessionId = stringField(body, "providerSessionId", {
    required: true,
    max: 160,
  })!;
  const { call } = await requireConnectedMediaCommitContext(env, auth, callId);
  const session = await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  const tracks = parseRealtimeTracks({ tracks: body.tracks }, call);
  await upsertRealtimeTracks(env, auth, session, tracks);
  return {
    callId: call.call_id,
    trackCount: tracks.length,
  };
}

export async function commitRealtimeTracksCloseForCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const providerSessionId = stringField(body, "providerSessionId", {
    required: true,
    max: 160,
  })!;
  const { call } = await requireConnectedMediaCommitContext(env, auth, callId);
  const session = await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  const tracks = parseCloseRealtimeTracks({ tracks: body.tracks });
  await markRealtimeTracksClosed(env, session, tracks);
  return {
    callId: call.call_id,
    closedTrackCount: tracks.length,
  };
}

export async function commitRealtimeUnavailableForCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const endpoint = stringField(body, "endpoint", { required: true, max: 80 })!;
  const reason =
    stringField(body, "reason", { max: 120 }) ??
    "cloudflare_realtime_not_configured";
  const { call, participant } = await requireConnectedMediaCommitContext(
    env,
    auth,
    callId,
  );
  await recordRealtimeMediaFailure(env, auth, call, participant, endpoint, reason);
  return {
    callId: call.call_id,
    endpoint,
    reason,
  };
}

export async function commitRealtimeProviderFailureForCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const endpoint = stringField(body, "endpoint", { required: true, max: 80 })!;
  const reason =
    stringField(body, "reason", { max: 120 }) ?? "realtime_provider_error";
  const { call, participant } = await requireConnectedMediaCommitContext(
    env,
    auth,
    callId,
  );
  await recordRealtimeMediaFailure(env, auth, call, participant, endpoint, reason);
  return {
    callId: call.call_id,
    endpoint,
    reason,
  };
}

export async function commitRealtimeRenegotiateRecordForCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const providerSessionId = stringField(body, "providerSessionId", {
    required: true,
    max: 160,
  })!;
  const { call, participant } = await requireConnectedMediaCommitContext(
    env,
    auth,
    callId,
  );
  await requireOwnedRealtimeSession(env, auth, callId, providerSessionId);
  await recordRealtimeRenegotiated(env, auth, call, participant, providerSessionId);
  return {
    callId: call.call_id,
    providerSessionId,
  };
}

async function requireConnectedMediaCommitContext(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<{ call: CallRow; participant: CallParticipantRow }> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  assertConnectableCall(call);
  const participant = await requireConnectedParticipant(env, auth, callId);
  return { call, participant };
}

async function upsertRealtimeTracks(
  env: Env,
  auth: AuthContext,
  session: CallRealtimeSessionRow,
  tracks: RealtimeTrackInput[],
): Promise<void> {
  const localKinds = new Set<CallRealtimeTrackKind>();
  for (const track of tracks) {
    if (track.location === "local") localKinds.add(track.kind);
    const ownerProviderSessionId =
      track.location === "remote" ? track.sessionId ?? null : session.provider_session_id;
    await env.CONTROL_DB.prepare(
      `INSERT INTO call_realtime_tracks (
         call_realtime_track_id, call_id, call_realtime_session_id, provider,
         provider_session_id, owner_provider_session_id, provider_track_name,
         location, kind, mid, quality_layer, simulcast_json, account_id,
         principal_id, device_id, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT(call_realtime_session_id, provider_track_name, location) DO UPDATE SET
         owner_provider_session_id = excluded.owner_provider_session_id,
         kind = excluded.kind,
         mid = excluded.mid,
         quality_layer = excluded.quality_layer,
         simulcast_json = excluded.simulcast_json,
         status = 'active',
         closed_at = NULL,
         updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(
        randomId("crt"),
        session.call_id,
        session.call_realtime_session_id,
        REALTIME_PROVIDER,
        session.provider_session_id,
        ownerProviderSessionId,
        track.trackName,
        track.location,
        track.kind,
        track.mid ?? null,
        preferredQualityLayer(track.simulcast),
        track.simulcast ? JSON.stringify(track.simulcast) : null,
        auth.account.account_id,
        auth.principal.principal_id,
        auth.device.device_id,
      )
      .run();
  }
  if (localKinds.size > 0) {
    await updateParticipantMediaState(env, session.call_participant_id, {
      audioEnabled: localKinds.has("audio") ? true : undefined,
      videoEnabled: localKinds.has("video") ? true : undefined,
      screenEnabled: localKinds.has("screen") ? true : undefined,
      heartbeat: true,
    });
  }
}

async function availableRealtimeTracks(
  env: Env,
  callId: string,
  excludingProviderSessionId?: string,
): Promise<JsonObject[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT t.*, p.display_name, p.principal_type
     FROM call_realtime_tracks t
     JOIN principals p ON p.principal_id = t.principal_id
     WHERE t.call_id = ?
       AND t.provider = ?
       AND t.status = 'active'
       AND t.location = 'local'
       AND (? IS NULL OR t.provider_session_id <> ?)
     ORDER BY t.created_at ASC`,
  )
    .bind(
      callId,
      REALTIME_PROVIDER,
      excludingProviderSessionId ?? null,
      excludingProviderSessionId ?? null,
    )
    .all<
      CallRealtimeTrackRow & {
        display_name: string;
        principal_type: string;
      }
    >();
  return (result.results ?? []).map((track) => ({
    location: "remote",
    sessionId: track.provider_session_id,
    trackName: track.provider_track_name,
    kind: track.kind,
    mid: track.mid,
    qualityLayer: track.quality_layer,
    simulcast: parseJsonObject(track.simulcast_json),
    principalId: track.principal_id,
    deviceId: track.device_id,
    displayName: track.display_name,
    principalType: track.principal_type,
  }));
}

function preferredQualityLayer(simulcast: JsonObject | undefined): string | null {
  const preferredRid = simulcast?.preferredRid;
  return typeof preferredRid === "string" && preferredRid.trim()
    ? preferredRid.trim()
    : null;
}

function parseJsonObject(value: string | null): JsonObject | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    return null;
  }
  return null;
}

async function markRealtimeTracksClosed(
  env: Env,
  session: CallRealtimeSessionRow,
  tracks: CloseRealtimeTrackInput[],
): Promise<void> {
  const mids = tracks.map((track) => track.mid);
  const placeholders = mids.map(() => "?").join(", ");
  await env.CONTROL_DB.prepare(
    `UPDATE call_realtime_tracks
     SET status = 'closed',
         closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE call_realtime_session_id = ?
       AND status = 'active'
       AND mid IN (${placeholders})`,
  )
    .bind(session.call_realtime_session_id, ...mids)
    .run();
  await refreshParticipantMediaStateFromTracks(env, session.call_participant_id);
}

async function closeParticipantRealtimeSessions(
  env: Env,
  callId: string,
  callParticipantId: string,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE call_realtime_tracks
     SET status = 'closed',
         closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE status = 'active'
       AND call_id = ?
       AND call_realtime_session_id IN (
         SELECT call_realtime_session_id
         FROM call_realtime_sessions
         WHERE call_id = ? AND call_participant_id = ?
       )`,
  )
    .bind(callId, callId, callParticipantId)
    .run();
  await env.CONTROL_DB.prepare(
    `UPDATE call_realtime_sessions
     SET status = 'closed',
         closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ?
       AND call_participant_id = ?
       AND status = 'active'`,
  )
    .bind(callId, callParticipantId)
    .run();
  await updateParticipantMediaState(env, callParticipantId, {
    audioEnabled: false,
    videoEnabled: false,
    screenEnabled: false,
    muted: false,
    heartbeat: true,
  });
}

async function closeCallRealtimeSessions(env: Env, callId: string): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE call_realtime_tracks
     SET status = 'closed',
         closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ? AND status = 'active'`,
  )
    .bind(callId)
    .run();
  await env.CONTROL_DB.prepare(
    `UPDATE call_realtime_sessions
     SET status = 'closed',
         closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ? AND status = 'active'`,
  )
    .bind(callId)
    .run();
  await env.CONTROL_DB.prepare(
    `UPDATE call_participants
     SET audio_enabled = 0,
         video_enabled = 0,
         screen_enabled = 0,
         muted_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE call_id = ?`,
  )
    .bind(callId)
    .run();
}

async function refreshParticipantMediaStateFromTracks(
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

function publicRealtimeSession(session: CallRealtimeSessionRow): JsonObject {
  return {
    sessionId: session.provider_session_id,
    status: session.status,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

function stringPayload(
  payload: Record<string, unknown>,
  key: string,
  code: string,
): string {
  const value = payload[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new HttpError(502, code, "Cloudflare Realtime response was missing expected data");
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
