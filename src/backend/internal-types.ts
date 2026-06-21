import type { AccountRow, AuthContext, PrincipalRow } from "../types";

export const MAX_MESSAGE_BYTES = 262_144;
export const MAX_KEY_PACKAGE_BYTES = 16_384;
export const DEFAULT_KEY_PACKAGE_DAYS = 30;
export const OWNERSHIP_TRANSFER_DAYS = 7;
export const DEFAULT_ATTACHMENT_DAYS = 30;
export const ROOM_INVITATION_DAYS = 7;

export type RouteResult = Response | null;
export type JsonObject = Record<string, unknown>;

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

export interface ConversationSendRequest {
  auth: AuthContext;
  roomId: string;
  body: Record<string, unknown>;
  requestId: string;
}

export interface ConversationMutationRequest {
  auth: AuthContext;
  roomId: string;
  operation: string;
  requestId: string;
  body?: Record<string, unknown>;
  envelopeId?: string;
  principalId?: string;
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

export interface AppBootstrapResult {
  bootstrap: JsonObject;
  metrics: {
    roomsMs: number;
    messagesMs: number;
  };
}

export interface PageParams {
  limit: number;
  offset: number;
}

export interface PrincipalRecord extends PrincipalRow {
  account_status: AccountRow["status"];
}

export interface RoomRow {
  room_id: string;
  type: "direct" | "group" | "channel";
  name: string | null;
  description: string | null;
  created_by_account_id: string;
  created_by_principal_id: string;
  status: "active" | "archived" | "deleted";
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface MembershipRow {
  membership_id: string;
  room_id: string;
  account_id: string;
  principal_id: string;
  role: "owner" | "admin" | "member" | "agent";
  status: "invited" | "active" | "leaving" | "removed" | "banned";
  invited_by_principal_id: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  principal_type?: PrincipalRow["principal_type"];
  display_name?: string;
}

export interface SendRoomContext extends MembershipRow {
  room_status: RoomRow["status"];
  message_retention_days: number;
}

export interface AttachmentRow {
  attachment_id: string;
  room_id: string;
  uploader_account_id: string;
  uploader_principal_id: string;
  uploader_device_id: string;
  object_key: string;
  state:
    | "allocated"
    | "uploaded"
    | "referenced"
    | "expired"
    | "deleted"
    | "quarantined_metadata";
  expected_bytes: number;
  ciphertext_bytes: number | null;
  ciphertext_sha256: string | null;
  content_category: string | null;
  retention_class: string;
  expires_at: string;
  created_at: string;
  uploaded_at: string | null;
  referenced_at: string | null;
  deleted_at: string | null;
}

export interface RoomInvitationRow {
  room_invitation_id: string;
  room_id: string;
  invited_account_id: string;
  invited_principal_id: string;
  invited_by_account_id: string;
  invited_by_principal_id: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  room_name?: string | null;
  room_type?: RoomRow["type"];
  invited_by_display_name?: string;
}
