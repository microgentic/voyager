import type { PrincipalRow } from "../../types";
import type { JsonObject } from "../shared/types";

export interface CallRow {
  call_id: string;
  room_id: string;
  call_type: "audio" | "video";
  status: "ringing" | "active" | "ended" | "missed" | "declined" | "failed";
  created_by_account_id: string;
  created_by_principal_id: string;
  created_by_device_id: string;
  started_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallParticipantRow {
  call_participant_id: string;
  call_id: string;
  account_id: string;
  principal_id: string;
  device_id: string | null;
  role: "participant" | "moderator";
  status:
    | "invited"
    | "ringing"
    | "joining"
    | "connected"
    | "left"
    | "declined"
    | "missed"
    | "failed";
  joined_at: string | null;
  left_at: string | null;
  muted_at: string | null;
  audio_enabled: number;
  video_enabled: number;
  screen_enabled: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  principal_type?: PrincipalRow["principal_type"];
  display_name?: string;
}

export interface CallEventRow {
  call_event_id: string;
  call_id: string;
  actor_account_id: string | null;
  actor_principal_id: string | null;
  actor_device_id: string | null;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

export interface CallRealtimeSessionRow {
  call_realtime_session_id: string;
  call_id: string;
  call_participant_id: string;
  account_id: string;
  principal_id: string;
  device_id: string;
  provider: "cloudflare_realtime";
  provider_session_id: string;
  status: "active" | "closed" | "failed";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CallRealtimeTrackRow {
  call_realtime_track_id: string;
  call_id: string;
  call_realtime_session_id: string;
  provider: "cloudflare_realtime";
  provider_session_id: string;
  owner_provider_session_id: string | null;
  provider_track_name: string;
  location: "local" | "remote";
  kind: "audio" | "video" | "screen" | "data";
  mid: string | null;
  quality_layer: string | null;
  simulcast_json: string | null;
  account_id: string;
  principal_id: string;
  device_id: string;
  status: "active" | "closed" | "failed";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type CallType = CallRow["call_type"];
export type CallStatus = CallRow["status"];
export type CallParticipantStatus = CallParticipantRow["status"];
export type CallRealtimeTrackKind = CallRealtimeTrackRow["kind"];
export type CallRealtimeTrackLocation = CallRealtimeTrackRow["location"];

export const LIVE_CALL_STATUSES: CallStatus[] = ["ringing", "active"];
export const CONNECTABLE_STATUSES: CallStatus[] = ["ringing", "active"];
export const REALTIME_PROVIDER = "cloudflare_realtime" as const;
export const DEFAULT_REALTIME_API_BASE = "https://rtc.live.cloudflare.com/v1";
export const CLIENT_USAGE_REPORT_SOURCE = "client_estimate" as const;
export const MAX_USAGE_REPORT_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_USAGE_REPORT_BYTES = 50 * 1024 * 1024 * 1024;

export type CallMediaMutationRunner = (
  operation: string,
  body?: Record<string, unknown>,
) => Promise<JsonObject | undefined>;

export interface CallLifecycleReconcileResult {
  live: boolean;
  status?: CallStatus;
  nextAlarmAt?: number;
}

export interface RealtimeConfig {
  configured: boolean;
  mock: boolean;
  appId?: string;
  appSecret?: string;
  apiBase: string;
  iceServers: JsonObject[];
}

export interface RealtimeSessionDescription {
  sdp: string;
  type: string;
}

export interface RealtimeTrackInput {
  location: CallRealtimeTrackLocation;
  sessionId?: string;
  trackName: string;
  kind: CallRealtimeTrackKind;
  mid?: string;
  bidirectionalMediaStream?: boolean;
  simulcast?: JsonObject;
}

export interface RealtimeApiRequestOptions {
  method: "GET" | "POST" | "PUT";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface CloseRealtimeTrackInput {
  mid: string;
}

export interface CallFeatureFlags extends JsonObject {
  callsEnabled: boolean;
  audioCallsEnabled: boolean;
  videoCallsEnabled: boolean;
  screenShareEnabled: boolean;
  realtimeMediaEnabled: boolean;
}

export interface ParsedCallUsageReport {
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
