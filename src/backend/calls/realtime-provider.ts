import { randomId } from "../../crypto";
import { HttpError } from "../../http";
import type { Env } from "../../types";
import type { JsonObject } from "../shared/types";
import type {
  CallRealtimeTrackKind,
  RealtimeApiRequestOptions,
  RealtimeConfig,
  RealtimeSessionDescription,
  RealtimeTrackInput,
} from "./types";

export async function realtimeApiRequest(
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

export function providerTrackInput(track: RealtimeTrackInput): JsonObject {
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

export function tracksFromPayload(
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
