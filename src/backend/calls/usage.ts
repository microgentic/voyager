import { randomId } from "../../crypto";
import { HttpError, optionalObject, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { CallRealtimeSessionRow, JsonObject } from "../internal-types";
import { requireRoomMembership } from "../rooms";
import { insertCallEvent } from "./events";
import { getCall } from "./public-read";
import { requireCurrentParticipant } from "./participants";
import {
  CLIENT_USAGE_REPORT_SOURCE,
  MAX_USAGE_REPORT_BYTES,
  MAX_USAGE_REPORT_DURATION_MS,
  REALTIME_PROVIDER,
  type ParsedCallUsageReport,
} from "./types";

export async function recordCallUsageReport(
  env: Env,
  auth: AuthContext,
  callId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const call = await getCall(env, callId);
  await requireRoomMembership(env, auth, call.room_id);
  const participant = await requireCurrentParticipant(env, auth, callId);
  const report = parseCallUsageReport(body);
  if (report.providerSessionId) {
    await requireOwnedRealtimeSessionForUsage(
      env,
      auth,
      callId,
      report.providerSessionId,
    );
  }
  const existingReport = await existingCallUsageReport(
    env,
    call.call_id,
    auth.device.device_id,
    report.providerSessionId,
  );
  if (existingReport) {
    return { usageReport: publicCallUsageReport(existingReport) };
  }
  const usageReportId = randomId("cur");
  const createdAt = new Date().toISOString();

  const insertResult = await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO call_usage_reports (
      call_usage_report_id, call_id, account_id, principal_id, device_id,
      provider, provider_session_id, duration_ms, audio_duration_ms,
      video_duration_ms, screen_duration_ms, bytes_sent_estimate,
      bytes_received_estimate, relay_likely, candidate_type,
      provider_egress_bytes, provider_billing_source, source, tracks_json,
      network_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      usageReportId,
      call.call_id,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      REALTIME_PROVIDER,
      report.providerSessionId,
      report.durationMs,
      report.audioDurationMs,
      report.videoDurationMs,
      report.screenDurationMs,
      report.bytesSentEstimate,
      report.bytesReceivedEstimate,
      report.relayLikely ? 1 : 0,
      report.candidateType,
      null,
      null,
      report.source,
      JSON.stringify(report.tracks),
      report.network ? JSON.stringify(report.network) : null,
      createdAt,
    )
    .run();
  if (d1Changes(insertResult) === 0) {
    const currentReport = await existingCallUsageReport(
      env,
      call.call_id,
      auth.device.device_id,
      report.providerSessionId,
    );
    if (currentReport) {
      return { usageReport: publicCallUsageReport(currentReport) };
    }
    throw new HttpError(
      409,
      "usage_report_conflict",
      "Usage report already exists",
    );
  }

  await insertCallEvent(env, auth, call.call_id, "call.usage.reported", {
    roomId: call.room_id,
    callParticipantId: participant.call_participant_id,
    provider: REALTIME_PROVIDER,
    providerSessionId: report.providerSessionId,
    durationMs: report.durationMs,
    bytesSentEstimate: report.bytesSentEstimate,
    bytesReceivedEstimate: report.bytesReceivedEstimate,
    relayLikely: report.relayLikely,
    source: report.source,
  });

  return {
    usageReport: publicCallUsageReport({
      call_usage_report_id: usageReportId,
      call_id: call.call_id,
      provider: REALTIME_PROVIDER,
      provider_session_id: report.providerSessionId,
      duration_ms: report.durationMs,
      audio_duration_ms: report.audioDurationMs,
      video_duration_ms: report.videoDurationMs,
      screen_duration_ms: report.screenDurationMs,
      bytes_sent_estimate: report.bytesSentEstimate,
      bytes_received_estimate: report.bytesReceivedEstimate,
      relay_likely: report.relayLikely ? 1 : 0,
      candidate_type: report.candidateType,
      source: report.source,
      created_at: createdAt,
    }),
  };
}

function publicCallUsageReport(row: Record<string, unknown>): JsonObject {
  return {
    usageReportId: String(row.call_usage_report_id),
    callId: String(row.call_id),
    provider: REALTIME_PROVIDER,
    providerSessionId: typeof row.provider_session_id === "string" ? row.provider_session_id : null,
    source: row.source === "provider_authoritative" ? "provider_authoritative" : CLIENT_USAGE_REPORT_SOURCE,
    durationMs: Number(row.duration_ms ?? 0),
    audioDurationMs: Number(row.audio_duration_ms ?? 0),
    videoDurationMs: Number(row.video_duration_ms ?? 0),
    screenDurationMs: Number(row.screen_duration_ms ?? 0),
    bytesSentEstimate: Number(row.bytes_sent_estimate ?? 0),
    bytesReceivedEstimate: Number(row.bytes_received_estimate ?? 0),
    relayLikely: Number(row.relay_likely ?? 0) === 1,
    candidateType: typeof row.candidate_type === "string" ? row.candidate_type : null,
    createdAt: String(row.created_at),
  };
}

async function existingCallUsageReport(
  env: Env,
  callId: string,
  deviceId: string,
  providerSessionId: string | null,
): Promise<Record<string, unknown> | null> {
  return (
    (await env.CONTROL_DB.prepare(
      `SELECT *
       FROM call_usage_reports
       WHERE call_id = ?
         AND device_id = ?
         AND COALESCE(provider_session_id, '') = COALESCE(?, '')
       ORDER BY created_at ASC
       LIMIT 1`,
    )
      .bind(callId, deviceId, providerSessionId)
      .first<Record<string, unknown>>()) ?? null
  );
}

async function requireOwnedRealtimeSessionForUsage(
  env: Env,
  auth: AuthContext,
  callId: string,
  providerSessionId: string,
): Promise<CallRealtimeSessionRow> {
  const session = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM call_realtime_sessions
     WHERE call_id = ?
       AND provider = ?
       AND provider_session_id = ?
       AND account_id = ?
       AND principal_id = ?
       AND device_id = ?
     LIMIT 1`,
  )
    .bind(
      callId,
      REALTIME_PROVIDER,
      providerSessionId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
    )
    .first<CallRealtimeSessionRow>();
  if (!session) {
    throw new HttpError(
      404,
      "realtime_session_not_found",
      "Realtime session not found",
    );
  }
  return session;
}

function parseCallUsageReport(body: Record<string, unknown>): ParsedCallUsageReport {
  if (body.providerEgressBytes !== undefined || body.providerBillingSource !== undefined) {
    throw new HttpError(
      400,
      "provider_usage_not_authoritative",
      "Provider usage fields require an authoritative provider source",
    );
  }
  const sessionId = stringField(body, "sessionId", { max: 160 }) ?? null;
  const providerSessionIdAlias =
    stringField(body, "providerSessionId", { max: 160 }) ?? null;
  if (sessionId && providerSessionIdAlias && sessionId !== providerSessionIdAlias) {
    throw new HttpError(
      400,
      "invalid_field",
      "sessionId and providerSessionId must match when both are supplied",
    );
  }
  const providerSessionId = sessionId ?? providerSessionIdAlias;
  const durationMs = optionalIntegerField(
    body,
    "durationMs",
    0,
    MAX_USAGE_REPORT_DURATION_MS,
  ) ?? 0;
  return {
    providerSessionId,
    source: CLIENT_USAGE_REPORT_SOURCE,
    durationMs,
    audioDurationMs:
      optionalIntegerField(body, "audioDurationMs", 0, MAX_USAGE_REPORT_DURATION_MS) ??
      durationMs,
    videoDurationMs:
      optionalIntegerField(body, "videoDurationMs", 0, MAX_USAGE_REPORT_DURATION_MS) ??
      0,
    screenDurationMs:
      optionalIntegerField(body, "screenDurationMs", 0, MAX_USAGE_REPORT_DURATION_MS) ??
      0,
    bytesSentEstimate:
      optionalIntegerField(body, "bytesSentEstimate", 0, MAX_USAGE_REPORT_BYTES) ?? 0,
    bytesReceivedEstimate:
      optionalIntegerField(body, "bytesReceivedEstimate", 0, MAX_USAGE_REPORT_BYTES) ??
      0,
    relayLikely: body.relayLikely === true,
    candidateType: stringField(body, "candidateType", { max: 80 }) ?? null,
    tracks: Array.isArray(body.tracks)
      ? body.tracks
          .filter((track): track is JsonObject => !!track && typeof track === "object" && !Array.isArray(track))
          .slice(0, 20)
      : [],
    network: optionalObject(body, "network")
      ? {
          rttMs: optionalIntegerField(body.network as Record<string, unknown>, "rttMs", 0, 60_000) ?? null,
          jitterMs: optionalIntegerField(body.network as Record<string, unknown>, "jitterMs", 0, 60_000) ?? null,
          packetsLost: optionalIntegerField(body.network as Record<string, unknown>, "packetsLost", 0, MAX_USAGE_REPORT_BYTES) ?? null,
        }
      : null,
  };
}

function optionalIntegerField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_field", `Field must be a number: ${key}`);
  }
  if (value < min || value > max) {
    throw new HttpError(400, "invalid_field", `Field is out of range: ${key}`);
  }
  return Math.trunc(value);
}

function d1Changes(result: D1Result): number {
  const changes = (result.meta as { changes?: number } | undefined)?.changes;
  return typeof changes === "number" ? changes : 1;
}
