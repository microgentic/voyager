-- Message edit metadata and immutable edit history.
-- The current message envelope remains the active version; each edit preserves
-- the previous opaque payload for audit/recovery and future E2EE semantics.

ALTER TABLE message_envelopes ADD COLUMN edited_at TEXT;
ALTER TABLE message_envelopes ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS message_edits (
  edit_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES message_envelopes(envelope_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  editor_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  editor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  editor_device_id TEXT NOT NULL REFERENCES devices(device_id),
  previous_protocol_type TEXT NOT NULL,
  previous_ciphertext TEXT NOT NULL,
  previous_ciphertext_bytes INTEGER NOT NULL,
  new_protocol_type TEXT NOT NULL,
  new_ciphertext TEXT NOT NULL,
  new_ciphertext_bytes INTEGER NOT NULL,
  client_edited_at TEXT,
  edited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_edits_envelope_id
  ON message_edits(envelope_id, edited_at);

CREATE INDEX IF NOT EXISTS idx_message_edits_room_id
  ON message_edits(room_id, edited_at);
