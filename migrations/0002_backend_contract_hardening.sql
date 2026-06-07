PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS credential_reset_tokens (
  reset_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  created_by_account_id TEXT REFERENCES accounts(account_id),
  reason TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credential_reset_tokens_account_id ON credential_reset_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_credential_reset_tokens_expires_at ON credential_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS room_invitations (
  room_invitation_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  invited_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  invited_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  invited_by_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  invited_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_room_invitations_invited_principal_id
  ON room_invitations(invited_principal_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_room_invitations_room_id ON room_invitations(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_invitations_pending_unique
  ON room_invitations(room_id, invited_principal_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS rate_limits (
  rate_limit_key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires_at ON rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  maintenance_run_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_account_id TEXT REFERENCES accounts(account_id),
  result TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_created_at ON maintenance_runs(created_at);
