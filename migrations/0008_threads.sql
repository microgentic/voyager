-- Slack-style threads as a same-room sub-timeline.
-- Thread replies are ordinary message envelopes that point at a root envelope.
-- This keeps threads a generic messaging primitive: room membership controls
-- access, the Conversation DO still serializes writes, and D1 stays the source
-- of truth. Thread summaries (reply count, last reply) are computed on read from
-- these columns rather than denormalized, so deletes/tombstones never drift.

ALTER TABLE message_envelopes
  ADD COLUMN thread_root_envelope_id TEXT REFERENCES message_envelopes(envelope_id);

-- When true, a thread reply is also broadcast into the main room timeline.
-- Normal messages and thread roots keep the default 0.
ALTER TABLE message_envelopes
  ADD COLUMN also_sent_to_room INTEGER NOT NULL DEFAULT 0;

-- Fast thread reply lookups and summary subqueries, ordered within a thread.
CREATE INDEX IF NOT EXISTS idx_message_envelopes_thread_root
  ON message_envelopes(thread_root_envelope_id, server_sequence)
  WHERE thread_root_envelope_id IS NOT NULL;

-- Main-timeline filtering keeps thread-only replies out of room history while
-- still returning replies that were also sent to the room.
CREATE INDEX IF NOT EXISTS idx_message_envelopes_room_thread_visibility
  ON message_envelopes(room_id, thread_root_envelope_id, also_sent_to_room);
