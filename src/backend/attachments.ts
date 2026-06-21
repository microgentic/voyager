import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, Env } from "../types";
import {
  DEFAULT_ATTACHMENT_DAYS,
  type AttachmentRow,
  type JsonObject,
} from "./internal-types";
import { getPolicy, requireRoomMembership } from "./rooms";
import {
  numberField,
  optionalJsonText,
  optionalNumberField,
  sqliteTimestamp,
} from "./utils";
import { publicAttachment } from "./serializers";

type AttachmentVariant = "original" | "preview" | "thumbnail";

const MEDIA_KINDS = new Set(["image", "video", "audio", "file", "unknown"]);
const VARIANTS = new Set(["original", "preview", "thumbnail"]);
const MAX_FILENAME_LENGTH = 255;
const MAX_MIME_LENGTH = 120;
const MAX_VARIANT_MANIFEST_BYTES = 16_384;
const MAX_PENDING_ATTACHMENTS_PER_DEVICE = 25;

export async function allocateAttachment(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const policy = await getPolicy(env, auth.account.policy_id);
  const pending = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM attachments
     WHERE uploader_device_id = ?
       AND state IN ('allocated', 'uploaded')
       AND expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(auth.device.device_id)
    .first<{ count: number }>();
  if (Number(pending?.count ?? 0) >= MAX_PENDING_ATTACHMENTS_PER_DEVICE) {
    throw new HttpError(
      429,
      "too_many_pending_attachments",
      "Too many pending attachments for this device",
    );
  }
  const expectedBytes = numberField(
    body,
    "expectedBytes",
    1,
    policy.maximum_attachment_bytes,
  );
  const attachmentId = randomId("att");
  const objectKey = `attachments/${roomId}/${attachmentId}/original`;
  const expiresAt = sqliteTimestamp(
    Date.now() + DEFAULT_ATTACHMENT_DAYS * 24 * 60 * 60 * 1000,
  );
  const mediaKind = parseMediaKind(
    stringField(body, "mediaKind", { max: 20 }) ?? "unknown",
  );
  await env.CONTROL_DB.prepare(
    `INSERT INTO attachments (
      attachment_id, room_id, uploader_account_id, uploader_principal_id, uploader_device_id,
      object_key, state, expected_bytes, content_category, retention_class,
      original_filename, declared_mime_type, media_kind, width, height, duration_ms,
      original_object_key, variant_manifest_json, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      stringField(body, "originalFilename", {
        max: MAX_FILENAME_LENGTH,
      }) ?? null,
      stringField(body, "declaredMimeType", { max: MAX_MIME_LENGTH }) ?? null,
      mediaKind,
      optionalNumberField(body, "width", 1, 100_000),
      optionalNumberField(body, "height", 1, 100_000),
      optionalNumberField(body, "durationMs", 1, 24 * 60 * 60 * 1000),
      objectKey,
      optionalJsonText(body, "variantManifest", MAX_VARIANT_MANIFEST_BYTES),
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

  await updateUploadedVariant(env, attachment, variant, objectKey, uploadedBytes);
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
    await env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'uploaded',
           uploaded_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP),
           object_key = ?,
           original_object_key = ?,
           original_bytes = ?,
           ciphertext_bytes = ?
       WHERE attachment_id = ?`,
    )
      .bind(
        objectKey,
        objectKey,
        uploadedBytes,
        uploadedBytes,
        attachment.attachment_id,
      )
      .run();
    return;
  }

  const column =
    variant === "preview"
      ? ["preview_object_key", "preview_bytes"]
      : ["thumbnail_object_key", "thumbnail_bytes"];
  await env.CONTROL_DB.prepare(
    `UPDATE attachments
     SET uploaded_at = COALESCE(uploaded_at, CURRENT_TIMESTAMP),
         ${column[0]} = ?,
         ${column[1]} = ?
     WHERE attachment_id = ?`,
  )
    .bind(objectKey, uploadedBytes, attachment.attachment_id)
    .run();
}

export function parseAttachmentVariant(value: string | null): AttachmentVariant {
  const variant = value ?? "original";
  if (!VARIANTS.has(variant)) {
    throw new HttpError(
      400,
      "invalid_attachment_variant",
      "Attachment variant must be original, preview, or thumbnail",
    );
  }
  return variant as AttachmentVariant;
}

function parseMediaKind(value: string): AttachmentRow["media_kind"] {
  if (!MEDIA_KINDS.has(value)) {
    throw new HttpError(
      400,
      "invalid_media_kind",
      "Attachment media kind must be image, video, audio, file, or unknown",
    );
  }
  return value as AttachmentRow["media_kind"];
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(
      400,
      "invalid_content_length",
      "Content-Length must be a non-negative integer",
    );
  }
  return parsed;
}

function objectKeyForVariant(
  attachment: AttachmentRow,
  variant: AttachmentVariant,
  forUpload = false,
): string {
  if (variant === "original") {
    return attachment.original_object_key ?? attachment.object_key;
  }
  const existing =
    variant === "preview"
      ? attachment.preview_object_key
      : attachment.thumbnail_object_key;
  if (existing) return existing;
  if (forUpload) {
    return `attachments/${attachment.room_id}/${attachment.attachment_id}/${variant}`;
  }
  throw new HttpError(
    404,
    "attachment_variant_missing",
    "Attachment variant is not available",
  );
}

function uniqueObjectKeys(attachment: AttachmentRow): string[] {
  return Array.from(
    new Set(
      [
        attachment.object_key,
        attachment.original_object_key,
        attachment.preview_object_key,
        attachment.thumbnail_object_key,
      ].filter((key): key is string => typeof key === "string" && key.length > 0),
    ),
  );
}

function mimeForDownload(
  attachment: AttachmentRow,
  variant: AttachmentVariant,
  object: R2ObjectBody,
): string {
  return (
    object.httpMetadata?.contentType ??
    (variant === "original" ? attachment.declared_mime_type : null) ??
    "application/octet-stream"
  );
}

function variantByteLength(
  attachment: AttachmentRow,
  variant: AttachmentVariant,
): number | null {
  if (variant === "original") {
    return attachment.original_bytes ?? attachment.ciphertext_bytes;
  }
  if (variant === "preview") return attachment.preview_bytes;
  return attachment.thumbnail_bytes;
}

function currentVariantBytes(attachment: AttachmentRow): number {
  return (
    Number(attachment.original_bytes ?? 0) +
    Number(attachment.preview_bytes ?? 0) +
    Number(attachment.thumbnail_bytes ?? 0)
  );
}

function existingVariantBytes(
  attachment: AttachmentRow,
  variant: AttachmentVariant,
): number {
  return Number(variantByteLength(attachment, variant) ?? 0);
}

function assertProjectedVariantBudget(
  attachment: AttachmentRow,
  variant: AttachmentVariant,
  uploadedBytes: number,
): void {
  const projected =
    currentVariantBytes(attachment) -
    existingVariantBytes(attachment, variant) +
    uploadedBytes;
  if (projected > attachment.expected_bytes) {
    throw new HttpError(
      413,
      "attachment_too_large",
      "Attachment variants exceed allocation",
    );
  }
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
  if (!attachment.original_object_key || attachment.original_bytes === null) {
    throw new HttpError(
      409,
      "attachment_original_required",
      "Attachment original variant must be uploaded before completion",
    );
  }
  const mediaKind = stringField(body, "mediaKind", { max: 20 });
  await env.CONTROL_DB.prepare(
    `UPDATE attachments
     SET ciphertext_sha256 = COALESCE(?, ciphertext_sha256),
         ciphertext_bytes = COALESCE(?, ciphertext_bytes),
         original_filename = COALESCE(?, original_filename),
         declared_mime_type = COALESCE(?, declared_mime_type),
         media_kind = COALESCE(?, media_kind),
         width = COALESCE(?, width),
         height = COALESCE(?, height),
         duration_ms = COALESCE(?, duration_ms),
         variant_manifest_json = COALESCE(?, variant_manifest_json)
     WHERE attachment_id = ?`,
  )
    .bind(
      stringField(body, "ciphertextSha256", { max: 128 }) ?? null,
      optionalNumberField(
        body,
        "ciphertextBytes",
        1,
        attachment.expected_bytes,
      ) ?? null,
      stringField(body, "originalFilename", {
        max: MAX_FILENAME_LENGTH,
      }) ?? null,
      stringField(body, "declaredMimeType", { max: MAX_MIME_LENGTH }) ?? null,
      mediaKind ? parseMediaKind(mediaKind) : null,
      optionalNumberField(body, "width", 1, 100_000),
      optionalNumberField(body, "height", 1, 100_000),
      optionalNumberField(body, "durationMs", 1, 24 * 60 * 60 * 1000),
      optionalJsonText(body, "variantManifest", MAX_VARIANT_MANIFEST_BYTES),
      attachmentId,
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

export async function downloadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  variant: AttachmentVariant = "original",
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
  const objectKey = objectKeyForVariant(attachment, variant);
  const object = await env.ATTACHMENTS_BUCKET.get(objectKey);
  if (!object) {
    throw new HttpError(
      404,
      "attachment_blob_missing",
      "Attachment blob is missing",
    );
  }
  return new Response(object.body, {
    headers: {
      "content-type": mimeForDownload(attachment, variant, object),
      "cache-control": "no-store",
      "x-attachment-id": attachment.attachment_id,
      "x-attachment-variant": variant,
      ...(variantByteLength(attachment, variant) !== null
        ? { "content-length": String(variantByteLength(attachment, variant)) }
        : {}),
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
  await Promise.all(
    uniqueObjectKeys(attachment).map((objectKey) =>
      env.ATTACHMENTS_BUCKET.delete(objectKey),
    ),
  );
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
