-- Message reactions and room-level message pins.
-- These are generic messaging primitives: reaction values are client-visible
-- labels, and pins mark durable messages as highlighted within a room.

CREATE TABLE IF NOT EXISTS message_reactions (
  reaction_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES message_envelopes(envelope_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(envelope_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_envelope
  ON message_reactions(envelope_id, reaction);

CREATE INDEX IF NOT EXISTS idx_message_reactions_room
  ON message_reactions(room_id, created_at);

CREATE TABLE IF NOT EXISTS message_pins (
  pin_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  envelope_id TEXT NOT NULL REFERENCES message_envelopes(envelope_id) ON DELETE CASCADE,
  pinned_by_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  pinned_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  pinned_by_device_id TEXT NOT NULL REFERENCES devices(device_id),
  pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unpinned_by_principal_id TEXT REFERENCES principals(principal_id),
  unpinned_by_device_id TEXT REFERENCES devices(device_id),
  unpinned_at TEXT,
  UNIQUE(room_id, envelope_id)
);

CREATE INDEX IF NOT EXISTS idx_message_pins_room_active
  ON message_pins(room_id, pinned_at)
  WHERE unpinned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_message_pins_envelope
  ON message_pins(envelope_id);
