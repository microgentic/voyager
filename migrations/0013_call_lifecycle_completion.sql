-- Call lifecycle completion metadata.
--
-- These fields keep participant media/liveness state server-visible without
-- storing media. Durable Object alarms use the timestamps to reconcile ringing
-- calls and stale participants back into D1 history.

ALTER TABLE call_participants ADD COLUMN audio_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE call_participants ADD COLUMN video_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_participants ADD COLUMN screen_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_participants ADD COLUMN last_seen_at TEXT;

CREATE INDEX IF NOT EXISTS idx_call_participants_liveness
  ON call_participants(call_id, status, last_seen_at);
