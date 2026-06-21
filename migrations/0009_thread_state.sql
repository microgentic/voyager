-- Account-scoped thread state for inbox/read/follow behavior.
-- Thread replies remain ordinary message_envelopes; this table stores only the
-- viewer-specific state needed for Slack-style "Threads" polish.

CREATE TABLE IF NOT EXISTS thread_states (
  thread_state_id TEXT PRIMARY KEY,
  root_envelope_id TEXT NOT NULL REFERENCES message_envelopes(envelope_id),
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  following INTEGER NOT NULL DEFAULT 1,
  muted INTEGER NOT NULL DEFAULT 0,
  last_read_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_envelope_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_states_account_updated
  ON thread_states(account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_thread_states_room_root
  ON thread_states(room_id, root_envelope_id);
