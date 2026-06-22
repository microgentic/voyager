import { audit } from "../../db";
import { randomId } from "../../crypto";
import { json, readJsonObject, readOptionalJsonObject, requireMethod, routeParams } from "../../http";
import {
  callMutationTimingHeaders,
  requireCallCoordinatorResult,
  runCallMutationThroughCallCoordinator,
} from "../call-coordinator";
import {
  closeRealtimeTracks,
  getPublicCall,
  getRealtimeSessionConfig,
  getRealtimeTrackConfig,
  listRoomCalls,
  recordCallUsageReport,
  renegotiateRealtimeSession,
} from "../calls";
import { capitalize, readTimingHeaders } from "../utils";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext } from "./types";

export async function handleCallRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  const roomCallsMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/calls$/,
    url.pathname,
  );
  if (roomCallsMatch) {
    if (request.method === "GET") {
      const startedAt = performance.now();
      return json(
        { ok: true, ...(await listRoomCalls(env, auth, roomCallsMatch[1], url)) },
        { headers: readTimingHeaders("calls", authTimingMs, startedAt) },
      );
    }
    if (request.method === "POST") {
      const callId = randomId("call");
      const mutation = await runCallMutationThroughCallCoordinator(
        env,
        auth,
        callId,
        requestId,
        {
          operation: "call.create",
          roomId: roomCallsMatch[1],
          body: await readJsonObject(request),
        },
      );
      const call = requireCallCoordinatorResult(mutation.result);
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "call.create",
        targetType: "call",
        targetId: callId,
        requestId,
        result: "success",
        metadata: {
          roomId: roomCallsMatch[1],
          callType: call.callType,
        },
      });
      return json(
        { ok: true, call },
        {
          status: 201,
          headers: callMutationTimingHeaders("callCreate", mutation.metrics),
        },
      );
    }
  }

  const callUsageReportMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/usage-report$/,
    url.pathname,
  );
  if (callUsageReportMatch) {
    requireMethod(request, "POST");
    return json({
      ok: true,
      ...(await recordCallUsageReport(env, auth, callUsageReportMatch[1], await readJsonObject(request))),
    });
  }

  const callMatch = routeParams(/^\/v1\/calls\/([^/]+)$/, url.pathname);
  if (callMatch) {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, call: await getPublicCall(env, auth, callMatch[1]) },
      { headers: readTimingHeaders("call", authTimingMs, startedAt) },
    );
  }

  const callActionMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/(join|leave|decline|mute|unmute)$/,
    url.pathname,
  );
  if (callActionMatch) {
    requireMethod(request, "POST");
    const [, callId, action] = callActionMatch;
    const mutation = await runCallMutationThroughCallCoordinator(
      env,
      auth,
      callId,
      requestId,
      {
        operation: `call.${action}`,
      },
    );
    const call = requireCallCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: `call.${action}`,
      targetType: "call",
      targetId: callId,
      requestId,
      result: "success",
    });
    return json(
      { ok: true, call },
      {
        headers: callMutationTimingHeaders(
          `call${capitalize(action)}`,
          mutation.metrics,
        ),
      },
    );
  }

  const callParticipantMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/participants\/me$/,
    url.pathname,
  );
  if (callParticipantMatch) {
    requireMethod(request, "PATCH");
    const mutation = await runCallMutationThroughCallCoordinator(
      env,
      auth,
      callParticipantMatch[1],
      requestId,
      {
        operation: "call.participant.update",
        body: await readJsonObject(request),
      },
    );
    const call = requireCallCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "call.participant.update",
      targetType: "call",
      targetId: callParticipantMatch[1],
      requestId,
      result: "success",
    });
    return json(
      { ok: true, call },
      { headers: callMutationTimingHeaders("callParticipantUpdate", mutation.metrics) },
    );
  }

  const callRealtimeRenegotiateMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/realtime\/renegotiate$/,
    url.pathname,
  );
  if (callRealtimeRenegotiateMatch) {
    requireMethod(request, "POST");
    const callId = callRealtimeRenegotiateMatch[1];
    return json({
      ok: true,
      realtime: await renegotiateRealtimeSession(
        env,
        auth,
        callId,
        await readOptionalJsonObject(request),
        (operation, body) =>
          runCallMutationThroughCallCoordinator(env, auth, callId, requestId, {
            operation,
            body,
          }).then((mutation) => mutation.result),
      ),
    });
  }

  const callRealtimeCloseTracksMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/realtime\/tracks\/close$/,
    url.pathname,
  );
  if (callRealtimeCloseTracksMatch) {
    requireMethod(request, "POST");
    const callId = callRealtimeCloseTracksMatch[1];
    return json({
      ok: true,
      realtime: await closeRealtimeTracks(
        env,
        auth,
        callId,
        await readOptionalJsonObject(request),
        (operation, body) =>
          runCallMutationThroughCallCoordinator(env, auth, callId, requestId, {
            operation,
            body,
          }).then((mutation) => mutation.result),
      ),
    });
  }

  const callRealtimeMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/realtime\/(session|tracks)$/,
    url.pathname,
  );
  if (callRealtimeMatch) {
    requireMethod(request, "POST");
    const callId = callRealtimeMatch[1];
    const body = await readOptionalJsonObject(request);
    const runMediaMutation = (operation: string, mutationBody?: Record<string, unknown>) =>
      runCallMutationThroughCallCoordinator(env, auth, callId, requestId, {
        operation,
        body: mutationBody,
      }).then((mutation) => mutation.result);
    const realtime =
      callRealtimeMatch[2] === "session"
        ? await getRealtimeSessionConfig(env, auth, callId, body, runMediaMutation)
        : await getRealtimeTrackConfig(env, auth, callId, body, runMediaMutation);
    return json({ ok: true, realtime });
  }

  return null;
}
