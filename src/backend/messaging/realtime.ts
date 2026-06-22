import { notifyRoomRealtime } from "../../realtime";
import type { AuthContext, Env } from "../../types";
import { getMessage } from "./reads";

export function sendRealtimeEventFromMessage(
  message: Record<string, unknown>,
  senderDeviceId: string,
): {
  type: "room.message" | "room.thread";
  envelopeId: string;
  serverSequence: number;
  senderDeviceId: string;
  rootEnvelopeId?: string;
  alsoSentToRoom?: boolean;
} {
  const envelopeId = String(message.envelope_id);
  const serverSequence = Number(message.server_sequence);
  const rootEnvelopeId = message.thread_root_envelope_id;
  if (typeof rootEnvelopeId !== "string" || rootEnvelopeId.length === 0) {
    return { type: "room.message", envelopeId, serverSequence, senderDeviceId };
  }
  return {
    type: "room.thread",
    envelopeId,
    serverSequence,
    senderDeviceId,
    rootEnvelopeId,
    alsoSentToRoom:
      message.also_sent_to_room === 1 || message.also_sent_to_room === true,
  };
}

export async function notifyMessageSync(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
): Promise<void> {
  const message = await getMessage(env, envelopeId);
  if (!message) return;
  await notifyRoomRealtime(
    env,
    roomId,
    messageSyncRealtimeEvent(message, auth.device.device_id),
  ).catch((error) => console.warn("realtime notification failed", error));
}

export function messageSyncRealtimeEvent(
  message: Record<string, unknown>,
  senderDeviceId: string,
): {
  type: "room.sync" | "room.thread";
  envelopeId: string;
  serverSequence: number;
  senderDeviceId: string;
  rootEnvelopeId?: string;
  alsoSentToRoom?: boolean;
} {
  const envelopeId = String(message.envelope_id);
  const serverSequence = Number(message.server_sequence);
  const rootEnvelopeId = message.thread_root_envelope_id;
  if (typeof rootEnvelopeId === "string" && rootEnvelopeId.length > 0) {
    return {
      type: "room.thread",
      envelopeId,
      serverSequence,
      senderDeviceId,
      rootEnvelopeId,
      alsoSentToRoom:
        message.also_sent_to_room === true ||
        Number(message.also_sent_to_room ?? 0) === 1,
    };
  }
  return {
    type: "room.sync",
    envelopeId,
    serverSequence,
    senderDeviceId,
  };
}
