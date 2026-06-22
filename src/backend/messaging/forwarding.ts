import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { ForwardSource } from "./types";
import { requireRoomMembership } from "../rooms";

// Forward provenance is server-asserted: only the dedicated /forward route may
// resolve a source, and the result is threaded to sendMessageEnvelope as an
// internal option. Normal sends never carry forward metadata, so a caller
// cannot fabricate it through the public send body.
export async function resolveForwardSource(
  env: Env,
  auth: AuthContext,
  sourceRoomId: string,
  sourceEnvelopeId: string,
): Promise<ForwardSource> {
  await requireRoomMembership(env, auth, sourceRoomId);
  const source = await env.CONTROL_DB.prepare(
    `SELECT envelope_id, room_id, sender_principal_id
     FROM message_envelopes me
     WHERE me.room_id = ?
       AND me.envelope_id = ?
       AND me.state NOT IN ('expired', 'purged')
       AND me.expires_at > CURRENT_TIMESTAMP
       AND me.deleted_for_everyone_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )`,
  )
    .bind(sourceRoomId, sourceEnvelopeId, auth.account.account_id)
    .first<Record<string, unknown>>();
  if (!source) {
    throw new HttpError(
      404,
      "forward_source_not_found",
      "Forward source message not found",
    );
  }
  return {
    roomId: sourceRoomId,
    envelopeId: sourceEnvelopeId,
    senderPrincipalId: String(source.sender_principal_id),
  };
}
