export type AttachmentVariant = "original" | "preview" | "thumbnail";

export const MEDIA_KINDS = new Set(["image", "video", "audio", "file", "unknown"]);
export const VARIANTS = new Set(["original", "preview", "thumbnail"]);
export const MAX_FILENAME_LENGTH = 255;
export const MAX_MIME_LENGTH = 120;
export const MAX_VARIANT_MANIFEST_BYTES = 16_384;
export const MAX_PENDING_ATTACHMENTS_PER_DEVICE = 25;
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192;
