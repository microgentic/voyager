export type AttachmentVariant = "original" | "preview" | "thumbnail";

export const DEFAULT_ATTACHMENT_DAYS = 30;

export const MEDIA_KINDS = new Set(["image", "video", "audio", "file", "unknown"]);
export const VARIANTS = new Set(["original", "preview", "thumbnail"]);
export const MAX_FILENAME_LENGTH = 255;
export const MAX_MIME_LENGTH = 120;
export const MAX_VARIANT_MANIFEST_BYTES = 16_384;
export const MAX_PENDING_ATTACHMENTS_PER_DEVICE = 25;
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192;

export interface AttachmentRow {
  attachment_id: string;
  room_id: string;
  uploader_account_id: string;
  uploader_principal_id: string;
  uploader_device_id: string;
  object_key: string;
  state:
    | "allocated"
    | "uploaded"
    | "referenced"
    | "expired"
    | "deleted"
    | "quarantined_metadata";
  expected_bytes: number;
  ciphertext_bytes: number | null;
  ciphertext_sha256: string | null;
  content_category: string | null;
  retention_class: string;
  original_filename: string | null;
  declared_mime_type: string | null;
  media_kind: "image" | "video" | "audio" | "file" | "unknown";
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  original_object_key: string | null;
  preview_object_key: string | null;
  thumbnail_object_key: string | null;
  original_bytes: number | null;
  preview_bytes: number | null;
  thumbnail_bytes: number | null;
  variant_manifest_json: string | null;
  expires_at: string;
  created_at: string;
  uploaded_at: string | null;
  referenced_at: string | null;
  deleted_at: string | null;
}
