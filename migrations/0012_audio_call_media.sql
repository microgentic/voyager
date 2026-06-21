-- Audio media integration metadata.
--
-- Media still flows through WebRTC/Cloudflare Realtime, never through D1.
-- These rows only map Voyager call participants to provider session and track
-- identifiers so clients can recover call state and subscribe to known tracks.

CREATE TABLE IF NOT EXISTS call_realtime_sessions (
  call_realtime_session_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  call_participant_id TEXT NOT NULL REFERENCES call_participants(call_participant_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare_realtime')),
  provider_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  UNIQUE(provider, provider_session_id)
);

CREATE INDEX IF NOT EXISTS idx_call_realtime_sessions_call
  ON call_realtime_sessions(call_id, status);

CREATE INDEX IF NOT EXISTS idx_call_realtime_sessions_participant
  ON call_realtime_sessions(call_participant_id, status);

CREATE TABLE IF NOT EXISTS call_realtime_tracks (
  call_realtime_track_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  call_realtime_session_id TEXT NOT NULL REFERENCES call_realtime_sessions(call_realtime_session_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare_realtime')),
  provider_session_id TEXT NOT NULL,
  owner_provider_session_id TEXT,
  provider_track_name TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN ('local', 'remote')),
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'video', 'screen', 'data')),
  mid TEXT,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  UNIQUE(call_realtime_session_id, provider_track_name, location)
);

CREATE INDEX IF NOT EXISTS idx_call_realtime_tracks_call
  ON call_realtime_tracks(call_id, status, kind);

CREATE INDEX IF NOT EXISTS idx_call_realtime_tracks_provider_owner
  ON call_realtime_tracks(provider, owner_provider_session_id, provider_track_name);
