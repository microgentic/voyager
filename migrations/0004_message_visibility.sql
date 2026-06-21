-- Per-account message visibility controls.
-- "Delete for me" hides an envelope from one account without mutating the
-- durable room timeline or removing it for other room members.

CREATE TABLE IF NOT EXISTS message_visibility (
  visibility_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES message_envelopes(envelope_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_id TEXT REFERENCES principals(principal_id),
  reason TEXT NOT NULL CHECK (reason IN ('delete_for_me')),
  hidden_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(envelope_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_message_visibility_account_room
  ON message_visibility(account_id, room_id, hidden_at);

CREATE INDEX IF NOT EXISTS idx_message_visibility_envelope
  ON message_visibility(envelope_id);
