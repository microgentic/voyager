import { HttpError } from "../../http";
import type { AttachmentRow } from "./types";
import { MEDIA_KINDS, VARIANTS, type AttachmentVariant } from "./types";

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

export function parseMediaKind(value: string): AttachmentRow["media_kind"] {
  if (!MEDIA_KINDS.has(value)) {
    throw new HttpError(
      400,
      "invalid_media_kind",
      "Attachment media kind must be image, video, audio, file, or unknown",
    );
  }
  return value as AttachmentRow["media_kind"];
}

export function parseContentLength(value: string | null): number | null {
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

export function objectKeyForVariant(
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

export function uniqueObjectKeys(attachment: AttachmentRow): string[] {
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

export function mimeForDownload(
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

export function variantByteLength(
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

export function assertProjectedVariantBudget(
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
