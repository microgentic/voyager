import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../shared/types";
import { publicAttachment } from "./serializers";
import { runCounted } from "../utils";
import { getAttachment, ensureAttachmentUploader } from "./ownership";
import type { AttachmentRow, AttachmentVariant } from "./types";
import {
  assertProjectedVariantBudget,
  objectKeyForVariant,
  parseContentLength,
} from "./variants";

export async function uploadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  request: Request,
  variant: AttachmentVariant = "original",
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
  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > attachment.expected_bytes) {
    throw new HttpError(
      413,
      "attachment_too_large",
      "Attachment body exceeds allocation",
    );
  }
  if (contentLength !== null) {
    assertProjectedVariantBudget(attachment, variant, contentLength);
  }

  const objectKey = objectKeyForVariant(attachment, variant, true);
  const contentType =
    request.headers.get("content-type") ??
    attachment.declared_mime_type ??
    "application/octet-stream";
  const body = request.body;
  let uploadedBytes: number;
  if (body && contentLength !== null) {
    await env.ATTACHMENTS_BUCKET.put(objectKey, body, {
      httpMetadata: { contentType },
      customMetadata: { attachmentId, roomId: attachment.room_id, variant },
    });
    uploadedBytes = contentLength;
  } else {
    const buffered = await request.arrayBuffer();
    if (buffered.byteLength > attachment.expected_bytes) {
      throw new HttpError(
        413,
        "attachment_too_large",
        "Attachment body exceeds allocation",
      );
    }
    assertProjectedVariantBudget(attachment, variant, buffered.byteLength);
    await env.ATTACHMENTS_BUCKET.put(objectKey, buffered, {
      httpMetadata: { contentType },
      customMetadata: { attachmentId, roomId: attachment.room_id, variant },
    });
    uploadedBytes = buffered.byteLength;
  }

  try {
    await updateUploadedVariant(
      env,
      attachment,
      variant,
      objectKey,
      uploadedBytes,
    );
  } catch (error) {
    await env.ATTACHMENTS_BUCKET.delete(objectKey).catch(() => undefined);
    throw error;
  }
  return publicAttachment(await getAttachment(env, attachmentId));
}

async function updateUploadedVariant(
  env: Env,
  attachment: AttachmentRow,
  variant: AttachmentVariant,
  objectKey: string,
  uploadedBytes: number,
): Promise<void> {
  if (variant === "original") {
    const changed = await runCounted(
      env.CONTROL_DB.prepare(
        `UPDATE attachments
         SET state = 'uploaded',
             uploaded_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP),
             object_key = ?,
             original_object_key = ?,
             original_bytes = ?,
             ciphertext_bytes = ?
         WHERE attachment_id = ?
           AND state IN ('allocated', 'uploaded')`,
      ).bind(
        objectKey,
        objectKey,
        uploadedBytes,
        uploadedBytes,
        attachment.attachment_id,
      ),
    );
    if (changed !== 1) {
      throw new HttpError(
        409,
        "attachment_not_uploadable",
        "Attachment is not uploadable",
      );
    }
    return;
  }

  const column =
    variant === "preview"
      ? ["preview_object_key", "preview_bytes"]
      : ["thumbnail_object_key", "thumbnail_bytes"];
  const changed = await runCounted(
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET uploaded_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP),
           ${column[0]} = ?,
           ${column[1]} = ?
       WHERE attachment_id = ?
         AND state IN ('allocated', 'uploaded')`,
    ).bind(objectKey, uploadedBytes, attachment.attachment_id),
  );
  if (changed !== 1) {
    throw new HttpError(
      409,
      "attachment_not_uploadable",
      "Attachment is not uploadable",
    );
  }
}
