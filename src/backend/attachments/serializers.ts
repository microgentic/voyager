import type { JsonObject } from "../shared/types";
import { parseJson } from "../utils";
import type { AttachmentRow, AttachmentVariant } from "./types";

export function publicAttachment(attachment: AttachmentRow): JsonObject {
  const variants: JsonObject = {
    original: attachmentVariant(attachment, "original"),
  };
  const preview = attachmentVariant(attachment, "preview");
  if (preview) variants.preview = preview;
  const thumbnail = attachmentVariant(attachment, "thumbnail");
  if (thumbnail) variants.thumbnail = thumbnail;
  return {
    attachmentId: attachment.attachment_id,
    roomId: attachment.room_id,
    uploaderAccountId: attachment.uploader_account_id,
    uploaderPrincipalId: attachment.uploader_principal_id,
    uploaderDeviceId: attachment.uploader_device_id,
    state: attachment.state,
    expectedBytes: attachment.expected_bytes,
    ciphertextBytes: attachment.ciphertext_bytes,
    ciphertextSha256: attachment.ciphertext_sha256,
    contentCategory: attachment.content_category,
    retentionClass: attachment.retention_class,
    originalFilename: attachment.original_filename ?? null,
    declaredMimeType: attachment.declared_mime_type ?? null,
    mediaKind: attachment.media_kind ?? "unknown",
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    durationMs: attachment.duration_ms ?? null,
    variants,
    variantManifest: parseJson(attachment.variant_manifest_json),
    expiresAt: attachment.expires_at,
    createdAt: attachment.created_at,
    uploadedAt: attachment.uploaded_at,
    referencedAt: attachment.referenced_at,
    deletedAt: attachment.deleted_at,
  };
}

function attachmentVariant(
  attachment: AttachmentRow,
  variant: AttachmentVariant,
): JsonObject | null {
  const objectKey =
    variant === "original"
      ? (attachment.original_object_key ?? attachment.object_key)
      : variant === "preview"
        ? attachment.preview_object_key
        : attachment.thumbnail_object_key;
  if (!objectKey) return null;
  const bytes =
    variant === "original"
      ? (attachment.original_bytes ?? attachment.ciphertext_bytes)
      : variant === "preview"
        ? attachment.preview_bytes
        : attachment.thumbnail_bytes;
  return {
    variant,
    bytes: bytes ?? null,
    width: variant === "original" || variant === "preview" ? (attachment.width ?? null) : null,
    height: variant === "original" || variant === "preview" ? (attachment.height ?? null) : null,
    downloadPath: "/v1/attachments/" + attachment.attachment_id + "/blob?variant=" + variant,
  };
}
