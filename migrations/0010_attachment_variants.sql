-- Attachment media metadata and variant object support.
--
-- Existing rows keep `object_key` as the original blob. New rows may attach
-- media metadata and upload preview/thumbnail variants without changing the
-- stable attachment routes.

ALTER TABLE attachments ADD COLUMN original_filename TEXT;
ALTER TABLE attachments ADD COLUMN declared_mime_type TEXT;
ALTER TABLE attachments ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE attachments ADD COLUMN width INTEGER;
ALTER TABLE attachments ADD COLUMN height INTEGER;
ALTER TABLE attachments ADD COLUMN duration_ms INTEGER;
ALTER TABLE attachments ADD COLUMN original_object_key TEXT;
ALTER TABLE attachments ADD COLUMN preview_object_key TEXT;
ALTER TABLE attachments ADD COLUMN thumbnail_object_key TEXT;
ALTER TABLE attachments ADD COLUMN original_bytes INTEGER;
ALTER TABLE attachments ADD COLUMN preview_bytes INTEGER;
ALTER TABLE attachments ADD COLUMN thumbnail_bytes INTEGER;
ALTER TABLE attachments ADD COLUMN variant_manifest_json TEXT;

UPDATE attachments
SET original_object_key = object_key,
    original_bytes = ciphertext_bytes
WHERE original_object_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_media_kind
  ON attachments(media_kind, state);
