import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import { getPolicy } from "../rooms";
import { uniqueStrings } from "../utils";
import { DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE } from "./constants";

export async function markAttachmentsReferenced(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): Promise<void> {
  await Promise.all(
    markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds).map(
      (statement) => statement.run(),
    ),
  );
  await assertAttachmentsReferenced(env, auth, roomId, attachmentIds);
}

export function markAttachmentsReferencedStatements(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): D1PreparedStatement[] {
  const ids = uniqueStrings(attachmentIds);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return [
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'referenced', referenced_at = CURRENT_TIMESTAMP
       WHERE attachment_id IN (${placeholders})
         AND room_id = ?
         AND uploader_account_id = ?
         AND state = 'uploaded'`,
    ).bind(...ids, roomId, auth.account.account_id),
  ];
}

export async function assertAttachmentsReferenceable(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): Promise<void> {
  const ids = uniqueStrings(attachmentIds);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(", ");
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(DISTINCT attachment_id) AS count
     FROM attachments
     WHERE attachment_id IN (${placeholders})
       AND room_id = ?
       AND uploader_account_id = ?
       AND state IN ('uploaded', 'referenced')
       AND original_object_key IS NOT NULL
       AND original_bytes IS NOT NULL`,
  )
    .bind(...ids, roomId, auth.account.account_id)
    .first<{ count: number }>();
  if (Number(row?.count ?? 0) !== ids.length) {
    throw new HttpError(
      409,
      "attachment_not_referenceable",
      "All attachments must be uploaded by the sender before they can be referenced",
    );
  }
}

export async function assertAttachmentsReferenced(
  env: Env,
  auth: AuthContext,
  roomId: string,
  attachmentIds: string[],
): Promise<void> {
  const ids = uniqueStrings(attachmentIds);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(", ");
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(DISTINCT attachment_id) AS count
     FROM attachments
     WHERE attachment_id IN (${placeholders})
       AND room_id = ?
       AND uploader_account_id = ?
       AND state = 'referenced'
       AND original_object_key IS NOT NULL
       AND original_bytes IS NOT NULL`,
  )
    .bind(...ids, roomId, auth.account.account_id)
    .first<{ count: number }>();
  if (Number(row?.count ?? 0) !== ids.length) {
    throw new HttpError(
      409,
      "attachment_not_referenceable",
      "All attachments must remain referenced before a message can use them",
    );
  }
}

export async function purgeMessageAfterAttachmentReferenceFailure(
  env: Env,
  envelopeId: string,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `UPDATE message_envelopes
     SET state = 'purged'
     WHERE envelope_id = ?
       AND state NOT IN ('expired', 'purged')`,
  )
    .bind(envelopeId)
    .run();
}

export async function assertAttachmentCountWithinPolicy(
  env: Env,
  auth: AuthContext,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const policy = await getPolicy(env, auth.account.policy_id);
  const maxAttachments =
    Number.isFinite(policy.maximum_attachments_per_message) &&
    policy.maximum_attachments_per_message > 0
      ? policy.maximum_attachments_per_message
      : DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE;
  if (attachmentIds.length > maxAttachments) {
    throw new HttpError(
      400,
      "too_many_attachments",
      "Too many attachments for this message",
    );
  }
}
