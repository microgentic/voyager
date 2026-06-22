ALTER TABLE policies ADD COLUMN maximum_attachments_per_message INTEGER NOT NULL DEFAULT 10;
ALTER TABLE policies ADD COLUMN maximum_image_dimension INTEGER NOT NULL DEFAULT 8192;
ALTER TABLE policies ADD COLUMN daily_attachment_bytes_per_account INTEGER NOT NULL DEFAULT 104857600;
ALTER TABLE policies ADD COLUMN daily_attachment_bytes_per_room INTEGER NOT NULL DEFAULT 524288000;

CREATE INDEX IF NOT EXISTS idx_attachments_account_daily_quota ON attachments(uploader_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_room_daily_quota ON attachments(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_allocated_cleanup ON attachments(state, created_at)
  WHERE state = 'allocated';
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_cleanup ON attachments(state, uploaded_at, referenced_at)
  WHERE state = 'uploaded';

ALTER TABLE call_realtime_tracks ADD COLUMN quality_layer TEXT;
ALTER TABLE call_realtime_tracks ADD COLUMN simulcast_json TEXT;

CREATE INDEX IF NOT EXISTS idx_call_events_media_failures ON call_events(event_type, created_at)
  WHERE event_type = 'call.media.join_failed';
