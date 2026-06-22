import { randomId } from "../crypto";
import {
  errorResponse,
  HttpError,
  json,
  optionalObject,
  readJsonObject,
  routeParams,
  serverTimingHeader,
  stringField,
} from "../http";
import type { AuthContext, Env } from "../types";
import {
  createCall,
  declineCall,
  joinCall,
  leaveCall,
  reconcileCallLifecycleForCoordinator,
  setCallMuted,
  updateCurrentCallParticipant,
} from "./calls";
import type { JsonObject } from "./internal-types";
import { durationSince } from "./utils";

export interface CallMutationRequest {
  auth: AuthContext;
  callId: string;
  operation: string;
  requestId: string;
  roomId?: string;
  body?: Record<string, unknown>;
}

export interface CallMutationMetrics {
  totalMs: number;
  queueMs: number;
  operationMs: number;
}

export type CallMutationResponse =
  | { ok: true; result?: JsonObject; metrics: CallMutationMetrics }
  | { ok: false; error: string; message: string; details?: unknown };

export interface CallMutationResult {
  result?: JsonObject;
  metrics: CallMutationMetrics;
}

export class CallCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let requestId = randomId("req");

    try {
      const url = new URL(request.url);
      const mutationMatch = routeParams(
        /^\/calls\/([^/]+)\/mutations$/,
        url.pathname,
      );
      if (request.method !== "POST" || !mutationMatch) {
        throw new HttpError(
          404,
          "not_found",
          "Call coordinator route not found",
        );
      }

      const callId = decodeURIComponent(mutationMatch[1]);
      if (callId.length === 0 || callId.length > 160) {
        throw new HttpError(400, "invalid_field", "Field is invalid: callId");
      }

      const payload = parseCallMutationRequest(
        await readJsonObject(request),
        callId,
      );
      requestId = payload.requestId;
      return this.enqueue((queueMs) => this.runMutation(payload, queueMs));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  private enqueue(
    operation: (queueMs: number) => Promise<Response>,
  ): Promise<Response> {
    const enqueuedAt = performance.now();
    const run = this.queue.then(
      () => operation(durationSince(enqueuedAt)),
      () => operation(durationSince(enqueuedAt)),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runMutation(
    payload: CallMutationRequest,
    queueMs: number,
  ): Promise<Response> {
    const startedAt = performance.now();
    try {
      const result = await runCallMutation(this.env, payload);
      await this.reconcileLifecycle(payload.callId);
      const metrics = finalizeCallMetrics(queueMs, startedAt);
      logCallMutation("success", payload, metrics);
      return json(
        result === undefined
          ? { ok: true, metrics }
          : { ok: true, result, metrics },
      );
    } catch (error) {
      const metrics = finalizeCallMetrics(queueMs, startedAt);
      logCallMutation("error", payload, metrics, error);
      return errorResponse(error, payload.requestId);
    }
  }

  async alarm(): Promise<void> {
    const callId = await this.state.storage.get<string>("callId");
    if (!callId) return;
    await this.reconcileLifecycle(callId);
  }

  private async reconcileLifecycle(callId: string): Promise<void> {
    await this.state.storage.put("callId", callId);
    const result = await reconcileCallLifecycleForCoordinator(this.env, callId, {
      ringTimeoutMs: configuredMs(
        this.env.CALL_RING_TIMEOUT_MS,
        5_000,
        10 * 60_000,
        60_000,
      ),
      participantLivenessTimeoutMs: configuredMs(
        this.env.CALL_PARTICIPANT_LIVENESS_TIMEOUT_MS,
        30_000,
        30 * 60_000,
        120_000,
      ),
    });
    if (!result.live || result.nextAlarmAt === undefined) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(result.nextAlarmAt);
  }
}

export function parseCallMutationRequest(
  body: Record<string, unknown>,
  callId: string,
): CallMutationRequest {
  const requestId = stringField(body, "requestId", {
    required: true,
    min: 4,
    max: 160,
  })!;
  const operation = stringField(body, "operation", {
    required: true,
    min: 3,
    max: 120,
  })!;
  const auth = body.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new HttpError(400, "invalid_field", "Field must be an object: auth");
  }
  return {
    auth: auth as AuthContext,
    callId,
    operation,
    requestId,
    roomId: stringField(body, "roomId", { max: 80 }),
    body: optionalObject(body, "body"),
  };
}

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
    default:
      throw new HttpError(
        400,
        "invalid_call_operation",
        "Call operation is invalid",
      );
  }
}

export function requireCallCoordinatorResult(
  result: JsonObject | undefined,
): JsonObject {
  if (!result) {
    throw new HttpError(
      500,
      "call_do_error",
      "Call coordinator did not return a result",
    );
  }
  return result;
}

export function finalizeCallMetrics(
  queueMs: number,
  startedAt: number,
): CallMutationMetrics {
  const operationMs = durationSince(startedAt);
  return {
    totalMs: queueMs + operationMs,
    queueMs,
    operationMs,
  };
}

export function callMutationTimingHeaders(
  routeName: string,
  metrics: CallMutationMetrics,
): Record<string, string> {
  return {
    "server-timing": serverTimingHeader([
      [routeName, metrics.totalMs],
      ["callDo", metrics.totalMs],
      ["callQueue", metrics.queueMs],
      ["callOperation", metrics.operationMs],
    ]),
  };
}

export function logCallMutation(
  result: "success" | "error",
  payload: CallMutationRequest,
  metrics: CallMutationMetrics,
  error?: unknown,
): void {
  const logger = result === "success" ? console.info : console.warn;
  logger("call.do.mutation", {
    requestId: payload.requestId,
    callId: payload.callId,
    roomId: payload.roomId,
    operation: payload.operation,
    result,
    queueMs: metrics.queueMs,
    operationMs: metrics.operationMs,
    error: errorCode(error),
  });
}

export function errorCode(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof HttpError) return error.code;
  if (error instanceof Error) return error.name || "error";
  return "unknown_error";
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

export async function runCallMutationThroughCallCoordinator(
  env: Env,
  auth: AuthContext,
  callId: string,
  requestId: string,
  input: Omit<CallMutationRequest, "auth" | "callId" | "requestId">,
): Promise<CallMutationResult> {
  const coordinatorId = env.CALL_COORDINATOR.idFromName(callId);
  const coordinator = env.CALL_COORDINATOR.get(coordinatorId);
  const startedAt = performance.now();
  const response = await coordinator.fetch(
    `https://voyager-call.local/calls/${encodeURIComponent(callId)}/mutations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth, requestId, ...input }),
    },
  );
  const callDoMs = durationSince(startedAt);
  const payload = (await response
    .json()
    .catch(() => null)) as CallMutationResponse | null;

  if (!payload || payload.ok !== true) {
    const errorPayload = payload && payload.ok === false ? payload : null;
    throw new HttpError(
      response.status || 500,
      errorPayload?.error ?? "call_do_error",
      errorPayload?.message ?? "Call coordinator failed",
      errorPayload?.details,
    );
  }

  return {
    result: payload.result,
    metrics: {
      ...payload.metrics,
      totalMs: callDoMs,
    },
  };
}
