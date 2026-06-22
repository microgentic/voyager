import type { JsonObject } from "../shared/types";

export const MAX_MESSAGE_BYTES = 262_144;

export interface SendMessageMetrics {
  duplicate: boolean;
  totalMs: number;
  conversationDoMs?: number;
  conversationQueueMs?: number;
  conversationOperationMs?: number;
  contextMs: number;
  insertMs: number;
  postWriteMs: number;
  realtimeMs: number;
}

export interface SendMessageResult {
  message: JsonObject;
  metrics: SendMessageMetrics;
}

export interface ForwardSource {
  roomId: string;
  envelopeId: string;
  senderPrincipalId: string;
}

export interface ThreadReply {
  rootEnvelopeId: string;
  alsoSendToRoom: boolean;
}
