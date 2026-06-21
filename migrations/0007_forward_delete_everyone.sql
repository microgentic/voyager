-- Forward metadata and delete-for-everyone tombstones.
-- The backend still stores message ciphertext opaquely; forwarded messages are
-- client-reencoded sends with source metadata, and delete-for-everyone keeps the
-- room timeline row as a tombstone instead of physically removing it.

ALTER TABLE message_envelopes ADD COLUMN forwarded_from_room_id TEXT REFERENCES rooms(room_id);
ALTER TABLE message_envelopes ADD COLUMN forwarded_from_envelope_id TEXT REFERENCES message_envelopes(envelope_id);
ALTER TABLE message_envelopes ADD COLUMN forwarded_from_sender_principal_id TEXT REFERENCES principals(principal_id);
ALTER TABLE message_envelopes ADD COLUMN forwarded_by_principal_id TEXT REFERENCES principals(principal_id);

ALTER TABLE message_envelopes ADD COLUMN deleted_for_everyone_at TEXT;
ALTER TABLE message_envelopes ADD COLUMN deleted_by_account_id TEXT REFERENCES accounts(account_id);
ALTER TABLE message_envelopes ADD COLUMN deleted_by_principal_id TEXT REFERENCES principals(principal_id);
ALTER TABLE message_envelopes ADD COLUMN deleted_by_device_id TEXT REFERENCES devices(device_id);
ALTER TABLE message_envelopes ADD COLUMN deletion_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_message_envelopes_forwarded_from
  ON message_envelopes(forwarded_from_envelope_id)
  WHERE forwarded_from_envelope_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_envelopes_deleted_everyone
  ON message_envelopes(room_id, deleted_for_everyone_at)
  WHERE deleted_for_everyone_at IS NOT NULL;
