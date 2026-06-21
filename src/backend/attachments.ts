import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, Env } from "../types";
import {
  DEFAULT_ATTACHMENT_DAYS,
  type AttachmentRow,
  type JsonObject,
} from "./internal-types";
import { getPolicy, requireRoomMembership } from "./rooms";
import { numberField, optionalNumberField, sqliteTimestamp } from "./utils";
import { publicAttachment } from "./serializers";

export async function allocateAttachment(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const policy = await getPolicy(env, auth.account.policy_id);
  const expectedBytes = numberField(
    body,
    "expectedBytes",
    1,
    policy.maximum_attachment_bytes,
  );
  const attachmentId = randomId("att");
  const objectKey = `attachments/${roomId}/${attachmentId}`;
  const expiresAt = sqliteTimestamp(
    Date.now() + DEFAULT_ATTACHMENT_DAYS * 24 * 60 * 60 * 1000,
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO attachments (
      attachment_id, room_id, uploader_account_id, uploader_principal_id, uploader_device_id,
      object_key, state, expected_bytes, content_category, retention_class, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?, ?)`,
  )
    .bind(
      attachmentId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      objectKey,
      expectedBytes,
      stringField(body, "contentCategory", { max: 80 }) ?? "opaque",
      stringField(body, "retentionClass", { max: 40 }) ?? "default",
      expiresAt,
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function uploadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  request: Request,
): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state !== "allocated" && attachment.state !== "uploaded") {
    throw new HttpError(
      409,
      "attachment_not_uploadable",
      "Attachment is not uploadable",
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > attachment.expected_bytes) {
    throw new HttpError(
      413,
      "attachment_too_large",
      "Attachment body exceeds allocation",
    );
  }
  await env.ATTACHMENTS_BUCKET.put(attachment.object_key, body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { attachmentId, roomId: attachment.room_id },
  });
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET state = 'uploaded', ciphertext_bytes = ?, uploaded_at = CURRENT_TIMESTAMP WHERE attachment_id = ?",
  )
    .bind(body.byteLength, attachmentId)
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function completeAttachment(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state !== "uploaded" && attachment.state !== "referenced") {
    throw new HttpError(
      409,
      "attachment_not_uploaded",
      "Attachment has not been uploaded",
    );
  }
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET ciphertext_sha256 = COALESCE(?, ciphertext_sha256), ciphertext_bytes = COALESCE(?, ciphertext_bytes) WHERE attachment_id = ?",
  )
    .bind(
      stringField(body, "ciphertextSha256", { max: 128 }) ?? null,
      optionalNumberField(
        body,
        "ciphertextBytes",
        1,
        attachment.expected_bytes,
      ) ?? null,
      attachmentId,
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function downloadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
): Promise<Response> {
  const attachment = await getAttachment(env, attachmentId);
  await requireRoomMembership(env, auth, attachment.room_id);
  if (!["uploaded", "referenced"].includes(attachment.state)) {
    throw new HttpError(
      404,
      "attachment_not_available",
      "Attachment is not available",
    );
  }
  const object = await env.ATTACHMENTS_BUCKET.get(attachment.object_key);
  if (!object) {
    throw new HttpError(
      404,
      "attachment_blob_missing",
      "Attachment blob is missing",
    );
  }
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-attachment-id": attachment.attachment_id,
    },
  });
}

export async function deleteAttachment(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
): Promise<void> {
  const attachment = await getAttachment(env, attachmentId);
  const membership = await requireRoomMembership(env, auth, attachment.room_id);
  if (
    attachment.uploader_account_id !== auth.account.account_id &&
    !["owner", "admin"].includes(membership.role)
  ) {
    throw new HttpError(
      403,
      "forbidden",
      "Attachment deletion requires uploader or room admin",
    );
  }
  await env.ATTACHMENTS_BUCKET.delete(attachment.object_key);
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET state = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE attachment_id = ?",
  )
    .bind(attachmentId)
    .run();
}

export async function getAttachment(
  env: Env,
  attachmentId: string,
): Promise<AttachmentRow> {
  const attachment = await env.CONTROL_DB.prepare(
    "SELECT * FROM attachments WHERE attachment_id = ?",
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!attachment)
    throw new HttpError(404, "attachment_not_found", "Attachment not found");
  return attachment;
}

export function ensureAttachmentUploader(
  auth: AuthContext,
  attachment: AttachmentRow,
): void {
  if (
    attachment.uploader_account_id !== auth.account.account_id ||
    attachment.uploader_device_id !== auth.device.device_id
  ) {
    throw new HttpError(
      403,
      "attachment_uploader_required",
      "Only the allocating device can upload or complete this attachment",
    );
  }
}
