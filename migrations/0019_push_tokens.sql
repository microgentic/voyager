CREATE TABLE IF NOT EXISTS push_tokens (
  push_token_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('apns')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  bundle_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sent_at TEXT,
  disabled_at TEXT,
  invalidated_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_failure_code TEXT,
  last_failure_at TEXT,
  UNIQUE(provider, environment, bundle_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_current_device
  ON push_tokens(account_id, device_id, disabled_at, invalidated_at);

CREATE INDEX IF NOT EXISTS idx_push_tokens_principal
  ON push_tokens(principal_id, disabled_at, invalidated_at);

CREATE INDEX IF NOT EXISTS idx_push_tokens_session
  ON push_tokens(session_id, disabled_at, invalidated_at);
