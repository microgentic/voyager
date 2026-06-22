import type { AuthContext } from "../../types";
import type { JsonObject } from "../shared/types";
import type {
  ForwardSource,
  SendMessageMetrics,
  ThreadReply,
} from "../messaging/types";

export interface ConversationSendRequest {
  auth: AuthContext;
  roomId: string;
  body: Record<string, unknown>;
  requestId: string;
  forwardSource?: ForwardSource | null;
  threadReply?: ThreadReply | null;
}

export interface ConversationMutationRequest {
  auth: AuthContext;
  roomId: string;
  operation: string;
  requestId: string;
  body?: Record<string, unknown>;
  envelopeId?: string;
  principalId?: string;
  reaction?: string;
  roomInvitationId?: string;
  transferId?: string;
}

export interface ConversationMutationMetrics {
  totalMs: number;
  queueMs: number;
  operationMs: number;
}

export interface ConversationMutationResult {
  result?: JsonObject;
  metrics: ConversationMutationMetrics;
}

export type ConversationSendResponse =
  | { ok: true; message: JsonObject; metrics: SendMessageMetrics }
  | { ok: false; error: string; message: string; details?: unknown };

export type ConversationMutationResponse =
  | { ok: true; result?: JsonObject; metrics: ConversationMutationMetrics }
  | { ok: false; error: string; message: string; details?: unknown };
