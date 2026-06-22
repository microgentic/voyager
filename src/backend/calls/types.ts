import type {
  CallParticipantRow,
  CallRealtimeTrackRow,
  CallRow,
  JsonObject,
} from "../internal-types";

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
