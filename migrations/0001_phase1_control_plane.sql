PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS policies (
  policy_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  require_passkey_or_mfa INTEGER NOT NULL DEFAULT 0,
  require_local_lock INTEGER NOT NULL DEFAULT 0,
  require_email INTEGER NOT NULL DEFAULT 0,
  require_phone INTEGER NOT NULL DEFAULT 0,
  maximum_devices INTEGER NOT NULL DEFAULT 5,
  maximum_owned_groups INTEGER NOT NULL DEFAULT 5,
  maximum_group_memberships INTEGER NOT NULL DEFAULT 25,
  maximum_attachment_bytes INTEGER NOT NULL DEFAULT 10485760,
  message_retention_days INTEGER NOT NULL DEFAULT 14,
  attachment_retention_class TEXT NOT NULL DEFAULT 'default',
  agent_allowed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO policies (
  policy_id,
  name,
  require_passkey_or_mfa,
  require_local_lock,
  require_email,
  require_phone,
  maximum_devices,
  maximum_owned_groups,
  maximum_group_memberships,
  maximum_attachment_bytes,
  message_retention_days,
  attachment_retention_class,
  agent_allowed
) VALUES (
  'pol_default',
  'Default invited user policy',
  0,
  0,
  0,
  0,
  5,
  5,
  25,
  10485760,
  14,
  'default',
  0
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'locked', 'suspended', 'pending_deletion', 'deleted')),
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  policy_id TEXT NOT NULL DEFAULT 'pol_default' REFERENCES policies(policy_id),
  default_principal_id TEXT,
  activated_at TEXT,
  suspended_at TEXT,
  deletion_state TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'agent')),
  display_name TEXT NOT NULL,
  avatar_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  owner_principal_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_principals_account_id ON principals(account_id);

CREATE TABLE IF NOT EXISTS invitations (
  invitation_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  intended_display_name TEXT NOT NULL,
  intended_contact TEXT,
  expires_at TEXT NOT NULL,
  created_by_account_id TEXT REFERENCES accounts(account_id),
  accepted_account_id TEXT REFERENCES accounts(account_id),
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_invitations_account_id ON invitations(account_id);
CREATE INDEX IF NOT EXISTS idx_invitations_expires_at ON invitations(expires_at);

CREATE TABLE IF NOT EXISTS authenticators (
  authenticator_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('password', 'passkey')),
  password_verifier TEXT,
  public_credential_data TEXT,
  webauthn_credential_id TEXT,
  webauthn_public_key TEXT,
  webauthn_counter INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT,
  CHECK (
    (type = 'password' AND password_verifier IS NOT NULL)
    OR
    (type = 'passkey' AND webauthn_credential_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_authenticators_account_id ON authenticators(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_authenticators_webauthn_credential_id
  ON authenticators(webauthn_credential_id)
  WHERE webauthn_credential_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_account_type
  ON webauthn_challenges(account_id, type, expires_at);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  device_label TEXT NOT NULL,
  credential_fingerprint TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1,
  public_key_package TEXT,
  notification_capability TEXT,
  client_version TEXT,
  protocol_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  revoked_at TEXT,
  revocation_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_account_id ON devices(account_id);
CREATE INDEX IF NOT EXISTS idx_devices_principal_id ON devices(principal_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  risk_state TEXT NOT NULL DEFAULT 'normal'
);

CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_roles (
  role_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO admin_roles (role_id, name, description) VALUES
  ('role_platform_owner', 'platform_owner', 'Full platform owner for bootstrap and break-glass operations.'),
  ('role_security_admin', 'security_admin', 'Security administration, revocation, and audit access.'),
  ('role_user_admin', 'user_admin', 'User, invitation, and account lifecycle administration.'),
  ('role_agent_provisioner', 'agent_provisioner', 'Agent request and provisioning administration.'),
  ('role_quota_operator', 'quota_operator', 'Quota and policy operation.'),
  ('role_auditor', 'auditor', 'Read-only audit and support visibility.');

CREATE TABLE IF NOT EXISTS account_admin_roles (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES admin_roles(role_id),
  granted_by_account_id TEXT REFERENCES accounts(account_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  PRIMARY KEY (account_id, role_id, created_at)
);

CREATE INDEX IF NOT EXISTS idx_account_admin_roles_account_id ON account_admin_roles(account_id);
CREATE INDEX IF NOT EXISTS idx_account_admin_roles_role_id ON account_admin_roles(role_id);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  actor_account_id TEXT REFERENCES accounts(account_id),
  actor_admin_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  request_id TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_context TEXT,
  result TEXT NOT NULL,
  reason_code TEXT,
  metadata_json TEXT,
  integrity_link TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_account_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target_type, target_id);
