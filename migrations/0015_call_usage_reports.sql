-- Metadata-only call media usage reports. Clients submit aggregate WebRTC
-- stats for operational cost diagnostics; no media payloads or SDP are stored.

CREATE TABLE IF NOT EXISTS call_usage_reports (
  call_usage_report_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  audio_duration_ms INTEGER NOT NULL DEFAULT 0,
  video_duration_ms INTEGER NOT NULL DEFAULT 0,
  screen_duration_ms INTEGER NOT NULL DEFAULT 0,
  bytes_sent_estimate INTEGER NOT NULL DEFAULT 0,
  bytes_received_estimate INTEGER NOT NULL DEFAULT 0,
  relay_likely INTEGER NOT NULL DEFAULT 0,
  candidate_type TEXT,
  provider_egress_bytes INTEGER,
  provider_billing_source TEXT,
  tracks_json TEXT,
  network_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_usage_reports_call
  ON call_usage_reports(call_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_usage_reports_provider_session
  ON call_usage_reports(provider, provider_session_id);

CREATE INDEX IF NOT EXISTS idx_call_usage_reports_principal
  ON call_usage_reports(principal_id, created_at DESC);
