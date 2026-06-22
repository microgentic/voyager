import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { publicMessage } from "./serializers";

// IMPORTANT: messageSelectColumns() introduces placeholders in this order:
// 1. viewer principal id for reactedByMe.
// 2-5. viewer account id for thread visibility subqueries.
// Callers must bind messageSelectBindValues(auth) before route-specific values.
export function messageSelectColumns(alias = "me"): string {
  return `${alias}.*,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id) AS receipt_total,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id AND drs.status = 'pending') AS receipt_pending,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id AND drs.status IN ('stored', 'read')) AS receipt_delivered,
    (SELECT COUNT(*) FROM delivery_receipts drs WHERE drs.envelope_id = ${alias}.envelope_id AND drs.status = 'read') AS receipt_read,
    (SELECT COALESCE(json_group_array(json_object(
       'reaction', reaction,
       'count', reaction_count,
       'reactedByMe', reacted_by_me
     )), '[]')
     FROM (
       SELECT
         mr.reaction AS reaction,
         COUNT(*) AS reaction_count,
         MAX(CASE WHEN mr.principal_id = ? THEN 1 ELSE 0 END) AS reacted_by_me
       FROM message_reactions mr
       WHERE mr.envelope_id = ${alias}.envelope_id
       GROUP BY mr.reaction
       ORDER BY reaction_count DESC, mr.reaction ASC
     )) AS reaction_summary,
    (SELECT mp.pinned_at FROM message_pins mp WHERE mp.envelope_id = ${alias}.envelope_id AND mp.room_id = ${alias}.room_id AND mp.unpinned_at IS NULL ORDER BY mp.pinned_at DESC LIMIT 1) AS pinned_at,
    (SELECT mp.pinned_by_principal_id FROM message_pins mp WHERE mp.envelope_id = ${alias}.envelope_id AND mp.room_id = ${alias}.room_id AND mp.unpinned_at IS NULL ORDER BY mp.pinned_at DESC LIMIT 1) AS pinned_by_principal_id,
    (SELECT COUNT(*) FROM message_envelopes tr WHERE tr.thread_root_envelope_id = ${alias}.envelope_id AND tr.room_id = ${alias}.room_id AND tr.state != 'purged' AND tr.expires_at > CURRENT_TIMESTAMP AND NOT EXISTS (SELECT 1 FROM message_visibility mv WHERE mv.envelope_id = tr.envelope_id AND mv.account_id = ?)) AS thread_reply_count,
    (SELECT tr.envelope_id FROM message_envelopes tr WHERE tr.thread_root_envelope_id = ${alias}.envelope_id AND tr.room_id = ${alias}.room_id AND tr.state != 'purged' AND tr.expires_at > CURRENT_TIMESTAMP AND NOT EXISTS (SELECT 1 FROM message_visibility mv WHERE mv.envelope_id = tr.envelope_id AND mv.account_id = ?) ORDER BY tr.server_sequence DESC LIMIT 1) AS thread_last_reply_envelope_id,
    (SELECT tr.sender_principal_id FROM message_envelopes tr WHERE tr.thread_root_envelope_id = ${alias}.envelope_id AND tr.room_id = ${alias}.room_id AND tr.state != 'purged' AND tr.expires_at > CURRENT_TIMESTAMP AND NOT EXISTS (SELECT 1 FROM message_visibility mv WHERE mv.envelope_id = tr.envelope_id AND mv.account_id = ?) ORDER BY tr.server_sequence DESC LIMIT 1) AS thread_last_reply_sender_principal_id,
    (SELECT tr.server_received_at FROM message_envelopes tr WHERE tr.thread_root_envelope_id = ${alias}.envelope_id AND tr.room_id = ${alias}.room_id AND tr.state != 'purged' AND tr.expires_at > CURRENT_TIMESTAMP AND NOT EXISTS (SELECT 1 FROM message_visibility mv WHERE mv.envelope_id = tr.envelope_id AND mv.account_id = ?) ORDER BY tr.server_sequence DESC LIMIT 1) AS thread_last_reply_at`;
}

export function messageSelectBindValues(auth: AuthContext): string[] {
  return [
    auth.principal.principal_id,
    auth.account.account_id,
    auth.account.account_id,
    auth.account.account_id,
    auth.account.account_id,
  ];
}

export async function getPublicMessage(
  env: Env,
  envelopeId: string,
  viewerPrincipalId: string,
  viewerAccountId: string,
): Promise<JsonObject> {
  const message = await env.CONTROL_DB.prepare(
    `SELECT ${messageSelectColumns("me")}
     FROM message_envelopes me
     WHERE me.envelope_id = ?`,
  )
    .bind(
      viewerPrincipalId,
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
      envelopeId,
    )
    .first<Record<string, unknown>>();
  if (!message) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  return publicMessage(message);
}
