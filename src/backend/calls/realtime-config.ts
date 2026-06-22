import { HttpError } from "../../http";
import type { Env } from "../../types";
import type { JsonObject } from "../shared/types";
import type { CallRow } from "./types";
import {
  DEFAULT_REALTIME_API_BASE,
  REALTIME_PROVIDER,
  type CallFeatureFlags,
  type CallType,
  type RealtimeConfig,
  type RealtimeTrackInput,
} from "./types";

const FEATURE_DISABLED_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

export function callFeatureFlags(env: Env): CallFeatureFlags {
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

export function assertCallsEnabled(env: Env): void {
  if (!callFeatureFlags(env).callsEnabled) {
    throw new HttpError(403, "feature_disabled", "Calls are disabled for this environment");
  }
}

export function assertCallTypeEnabled(env: Env, callType: CallType): void {
  if (callType === "audio" && !callFeatureFlags(env).audioCallsEnabled) {
    throw new HttpError(403, "feature_disabled", "Audio calls are disabled for this environment");
  }
  if (callType === "video") assertVideoCallsEnabled(env);
}

export function assertVideoCallsEnabled(env: Env): void {
  if (!callFeatureFlags(env).videoCallsEnabled) {
    throw new HttpError(403, "feature_disabled", "Video calls are disabled for this environment");
  }
}

export function assertScreenShareEnabled(env: Env): void {
  if (!callFeatureFlags(env).screenShareEnabled) {
    throw new HttpError(403, "feature_disabled", "Screen sharing is disabled for this environment");
  }
}

export function assertRealtimeMediaEnabled(env: Env): void {
  if (!callFeatureFlags(env).realtimeMediaEnabled) {
    throw new HttpError(403, "feature_disabled", "Realtime call media is disabled for this environment");
  }
}

export function assertRealtimeTrackKindsEnabled(env: Env, tracks: RealtimeTrackInput[]): void {
  for (const track of tracks) {
    if (track.kind === "video") assertVideoCallsEnabled(env);
    if (track.kind === "screen") assertScreenShareEnabled(env);
  }
}

export function realtimeConfig(env: Env): RealtimeConfig {
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

export function configuredMs(
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

export function realtimeResponse(
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
