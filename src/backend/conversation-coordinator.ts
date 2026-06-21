import { randomId } from "../crypto";
import {
  errorResponse,
  HttpError,
  json,
  optionalObject,
  readJsonObject,
  routeParams,
  stringField,
} from "../http";
import type { AuthContext, Env } from "../types";
import {
  acceptOwnershipTransfer,
  acceptRoomInvitation,
  addRoomMember,
  archiveRoom,
  createRoomInvitation,
  declineRoomInvitation,
  durationSince,
  editMessageEnvelope,
  leaveRoom,
  proposeOwnershipTransfer,
  removeRoomMember,
  requireActiveRoom,
  requireRoomInvitationInRoom,
  sendMessageEnvelope,
  updateRoom,
  updateRoomMemberRole,
} from "./operations";
import type {
  ConversationMutationMetrics,
  ConversationMutationRequest,
  ConversationMutationResponse,
  ConversationMutationResult,
  ConversationSendRequest,
  ConversationSendResponse,
  JsonObject,
  SendMessageMetrics,
  SendMessageResult,
} from "./internal-types";

export class ConversationCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let requestId = randomId("req");

    try {
      const url = new URL(request.url);
      const sendMatch = routeParams(
        /^\/rooms\/([^/]+)\/messages$/,
        url.pathname,
      );
      const mutationMatch = routeParams(
        /^\/rooms\/([^/]+)\/mutations$/,
        url.pathname,
      );
      if (request.method !== "POST" || (!sendMatch && !mutationMatch)) {
        throw new HttpError(
          404,
          "not_found",
          "Conversation coordinator route not found",
        );
      }

      const roomId = decodeURIComponent((sendMatch ?? mutationMatch)![1]);
      if (roomId.length === 0 || roomId.length > 160) {
        throw new HttpError(400, "invalid_field", "Field is invalid: roomId");
      }

      const body = await readJsonObject(request);
      if (sendMatch) {
        const payload = parseConversationSendRequest(body, roomId);
        requestId = payload.requestId;
        return this.enqueue((queueMs) => this.sendMessage(payload, queueMs));
      }

      const payload = parseConversationMutationRequest(body, roomId);
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

  private async sendMessage(
    payload: ConversationSendRequest,
    queueMs: number,
  ): Promise<Response> {
    const startedAt = performance.now();
    try {
      const { message, metrics } = await sendMessageEnvelope(
        this.env,
        payload.auth,
        payload.roomId,
        payload.body,
        payload.requestId,
      );
      const operationMs = durationSince(startedAt);
      const enrichedMetrics = {
        ...metrics,
        conversationQueueMs: queueMs,
        conversationOperationMs: operationMs,
      };
      logConversationMessage("success", payload, message, enrichedMetrics);
      return json({ ok: true, message, metrics: enrichedMetrics });
    } catch (error) {
      logConversationMessage(
        "error",
        payload,
        undefined,
        {
          duplicate: false,
          totalMs: durationSince(startedAt),
          conversationQueueMs: queueMs,
          conversationOperationMs: durationSince(startedAt),
          contextMs: 0,
          insertMs: 0,
          postWriteMs: 0,
          realtimeMs: 0,
        },
        error,
      );
      return errorResponse(error, payload.requestId);
    }
  }

  private async runMutation(
    payload: ConversationMutationRequest,
    queueMs: number,
  ): Promise<Response> {
    const startedAt = performance.now();
    try {
      const result = await runConversationMutation(this.env, payload);
      const metrics = finalizeMutationMetrics(queueMs, startedAt);
      logConversationMutation("success", payload, metrics);
      return json(
        result === undefined
          ? { ok: true, metrics }
          : { ok: true, result, metrics },
      );
    } catch (error) {
      const metrics = finalizeMutationMetrics(queueMs, startedAt);
      logConversationMutation("error", payload, metrics, error);
      return errorResponse(error, payload.requestId);
    }
  }
}

export function parseConversationSendRequest(
  body: Record<string, unknown>,
  roomId: string,
): ConversationSendRequest {
  const requestId = stringField(body, "requestId", {
    required: true,
    min: 4,
    max: 160,
  })!;
  const auth = body.auth;
  const messageBody = body.body;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new HttpError(400, "invalid_field", "Field must be an object: auth");
  }
  if (
    !messageBody ||
    typeof messageBody !== "object" ||
    Array.isArray(messageBody)
  ) {
    throw new HttpError(400, "invalid_field", "Field must be an object: body");
  }
  return {
    auth: auth as AuthContext,
    roomId,
    body: messageBody as Record<string, unknown>,
    requestId,
  };
}

export function parseConversationMutationRequest(
  body: Record<string, unknown>,
  roomId: string,
): ConversationMutationRequest {
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
    roomId,
    operation,
    requestId,
    body: optionalObject(body, "body"),
    envelopeId: stringField(body, "envelopeId", { max: 80 }),
    principalId: stringField(body, "principalId", { max: 80 }),
    roomInvitationId: stringField(body, "roomInvitationId", { max: 80 }),
    transferId: stringField(body, "transferId", { max: 80 }),
  };
}

export function requiredMutationBody(
  payload: ConversationMutationRequest,
): Record<string, unknown> {
  if (!payload.body) {
    throw new HttpError(400, "missing_field", "Missing required field: body");
  }
  return payload.body;
}

export function requiredMutationField(
  payload: ConversationMutationRequest,
  key: "envelopeId" | "principalId" | "roomInvitationId" | "transferId",
): string {
  const value = payload[key];
  if (!value) {
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  }
  return value;
}

export function requireCoordinatorResult(
  result: JsonObject | undefined,
): JsonObject {
  if (!result) {
    throw new HttpError(
      500,
      "conversation_do_error",
      "Conversation coordinator did not return a result",
    );
  }
  return result;
}

export async function runConversationMutation(
  env: Env,
  payload: ConversationMutationRequest,
): Promise<JsonObject | undefined> {
  switch (payload.operation) {
    case "room.update":
      await requireActiveRoom(env, payload.roomId);
      return updateRoom(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationBody(payload),
      );
    case "room.archive":
      return archiveRoom(env, payload.auth, payload.roomId);
    case "message.edit":
      return editMessageEnvelope(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationField(payload, "envelopeId"),
        requiredMutationBody(payload),
      );
    case "room.member.add":
      await requireActiveRoom(env, payload.roomId);
      return addRoomMember(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationBody(payload),
      );
    case "room.invitation.create":
      await requireActiveRoom(env, payload.roomId);
      return createRoomInvitation(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationBody(payload),
      );
    case "room.invitation.accept":
      await requireActiveRoom(env, payload.roomId);
      return acceptRoomInvitation(
        env,
        payload.auth,
        await requireRoomInvitationInRoom(
          env,
          payload.roomId,
          requiredMutationField(payload, "roomInvitationId"),
        ),
      );
    case "room.invitation.decline":
      return declineRoomInvitation(
        env,
        payload.auth,
        await requireRoomInvitationInRoom(
          env,
          payload.roomId,
          requiredMutationField(payload, "roomInvitationId"),
        ),
      );
    case "room.member.role.update":
      await requireActiveRoom(env, payload.roomId);
      return updateRoomMemberRole(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationField(payload, "principalId"),
        requiredMutationBody(payload),
      );
    case "room.member.remove":
      await removeRoomMember(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationField(payload, "principalId"),
      );
      return undefined;
    case "room.member.leave":
      await leaveRoom(env, payload.auth, payload.roomId);
      return undefined;
    case "room.ownership_transfer.propose":
      await requireActiveRoom(env, payload.roomId);
      return proposeOwnershipTransfer(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationBody(payload),
      );
    case "room.ownership_transfer.accept":
      await requireActiveRoom(env, payload.roomId);
      return acceptOwnershipTransfer(
        env,
        payload.auth,
        payload.roomId,
        requiredMutationField(payload, "transferId"),
      );
    default:
      throw new HttpError(
        400,
        "invalid_conversation_operation",
        "Conversation operation is invalid",
      );
  }
}

export function finalizeMutationMetrics(
  queueMs: number,
  startedAt: number,
): ConversationMutationMetrics {
  const operationMs = durationSince(startedAt);
  return {
    totalMs: queueMs + operationMs,
    queueMs,
    operationMs,
  };
}

export function logConversationMessage(
  result: "success" | "error",
  payload: ConversationSendRequest,
  message: JsonObject | undefined,
  metrics: SendMessageMetrics,
  error?: unknown,
): void {
  const logger = result === "success" ? console.info : console.warn;
  logger("conversation.do.message", {
    requestId: payload.requestId,
    roomId: payload.roomId,
    result,
    envelopeId: message?.envelopeId,
    serverSequence: message?.serverSequence,
    duplicate: metrics.duplicate,
    queueMs: metrics.conversationQueueMs ?? 0,
    operationMs: metrics.conversationOperationMs ?? metrics.totalMs,
    error: errorCode(error),
  });
}

export function logConversationMutation(
  result: "success" | "error",
  payload: ConversationMutationRequest,
  metrics: ConversationMutationMetrics,
  error?: unknown,
): void {
  const logger = result === "success" ? console.info : console.warn;
  logger("conversation.do.mutation", {
    requestId: payload.requestId,
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

export async function sendMessageThroughConversationCoordinator(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<SendMessageResult> {
  const startedAt = performance.now();
  const coordinatorId = env.CONVERSATION_COORDINATOR.idFromName(roomId);
  const coordinator = env.CONVERSATION_COORDINATOR.get(coordinatorId);
  const response = await coordinator.fetch(
    `https://voyager-conversation.local/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth, body, requestId }),
    },
  );
  const conversationDoMs = durationSince(startedAt);
  const payload = (await response
    .json()
    .catch(() => null)) as ConversationSendResponse | null;

  if (!payload || payload.ok !== true) {
    const errorPayload = payload && payload.ok === false ? payload : null;
    throw new HttpError(
      response.status || 500,
      errorPayload?.error ?? "conversation_do_error",
      errorPayload?.message ?? "Conversation coordinator failed",
      errorPayload?.details,
    );
  }

  return {
    message: payload.message,
    metrics: {
      ...payload.metrics,
      conversationDoMs,
      totalMs: conversationDoMs,
    },
  };
}

export async function runMutationThroughConversationCoordinator(
  env: Env,
  auth: AuthContext,
  roomId: string,
  requestId: string,
  input: Omit<ConversationMutationRequest, "auth" | "roomId" | "requestId">,
): Promise<ConversationMutationResult> {
  const coordinatorId = env.CONVERSATION_COORDINATOR.idFromName(roomId);
  const coordinator = env.CONVERSATION_COORDINATOR.get(coordinatorId);
  const startedAt = performance.now();
  const response = await coordinator.fetch(
    `https://voyager-conversation.local/rooms/${encodeURIComponent(roomId)}/mutations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth, requestId, ...input }),
    },
  );
  const conversationDoMs = durationSince(startedAt);
  const payload = (await response
    .json()
    .catch(() => null)) as ConversationMutationResponse | null;

  if (!payload || payload.ok !== true) {
    const errorPayload = payload && payload.ok === false ? payload : null;
    throw new HttpError(
      response.status || 500,
      errorPayload?.error ?? "conversation_do_error",
      errorPayload?.message ?? "Conversation coordinator failed",
      errorPayload?.details,
    );
  }

  return {
    result: payload.result,
    metrics: {
      ...payload.metrics,
      totalMs: conversationDoMs,
    },
  };
}
