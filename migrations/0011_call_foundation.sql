-- Call foundation without media transport.
--
-- Calls are durable room-associated communication primitives. Media is not
-- stored here; future audio/video PRs will attach provider/session metadata to
-- these rows while keeping D1 as lifecycle history and Durable Objects as live
-- coordination.

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  call_type TEXT NOT NULL CHECK (call_type IN ('audio', 'video')),
  status TEXT NOT NULL CHECK (status IN ('ringing', 'active', 'ended', 'missed', 'declined', 'failed')),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  created_by_device_id TEXT NOT NULL REFERENCES devices(device_id),
  started_at TEXT,
  ended_at TEXT,
  ended_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_one_live_per_room
  ON calls(room_id)
  WHERE status IN ('ringing', 'active');

CREATE INDEX IF NOT EXISTS idx_calls_room_created
  ON calls(room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calls_status
  ON calls(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS call_participants (
  call_participant_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  device_id TEXT REFERENCES devices(device_id),
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('participant', 'moderator')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'ringing', 'joining', 'connected', 'left', 'declined', 'missed', 'failed')),
  joined_at TEXT,
  left_at TEXT,
  muted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_participants_invite
  ON call_participants(call_id, principal_id)
  WHERE device_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_participants_device
  ON call_participants(call_id, principal_id, device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_participants_call
  ON call_participants(call_id, status);

CREATE INDEX IF NOT EXISTS idx_call_participants_principal
  ON call_participants(principal_id, status);

CREATE TABLE IF NOT EXISTS call_events (
  call_event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  actor_account_id TEXT,
  actor_principal_id TEXT,
  actor_device_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_events_call_created
  ON call_events(call_id, created_at ASC);
