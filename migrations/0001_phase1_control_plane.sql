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

CREATE TABLE IF NOT EXISTS device_key_packages (
  key_package_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  protocol TEXT NOT NULL DEFAULT 'opaque-test',
  public_identity_key TEXT,
  signed_prekey TEXT,
  one_time_prekey TEXT,
  package_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'claimed', 'revoked', 'expired')),
  claimed_by_device_id TEXT REFERENCES devices(device_id),
  claimed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_key_packages_principal_id ON device_key_packages(principal_id);
CREATE INDEX IF NOT EXISTS idx_device_key_packages_device_id ON device_key_packages(device_id);
CREATE INDEX IF NOT EXISTS idx_device_key_packages_status ON device_key_packages(status, expires_at);

CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'channel')),
  name TEXT,
  description TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_created_by_account_id ON rooms(created_by_account_id);

CREATE TABLE IF NOT EXISTS room_memberships (
  membership_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'agent')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'leaving', 'removed', 'banned')),
  invited_by_principal_id TEXT REFERENCES principals(principal_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT,
  UNIQUE(room_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_room_memberships_room_id ON room_memberships(room_id);
CREATE INDEX IF NOT EXISTS idx_room_memberships_account_id ON room_memberships(account_id);
CREATE INDEX IF NOT EXISTS idx_room_memberships_principal_id ON room_memberships(principal_id);

CREATE TABLE IF NOT EXISTS ownership_transfers (
  transfer_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  from_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  to_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'expired', 'cancelled', 'completed')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_room_id ON ownership_transfers(room_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_to_principal_id ON ownership_transfers(to_principal_id);

CREATE TABLE IF NOT EXISTS message_envelopes (
  envelope_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  sender_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  sender_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  sender_device_id TEXT NOT NULL REFERENCES devices(device_id),
  idempotency_key TEXT NOT NULL,
  protocol_type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  ciphertext_bytes INTEGER NOT NULL,
  client_created_at TEXT,
  server_sequence INTEGER NOT NULL,
  server_received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'available', 'partially_acknowledged', 'fully_acknowledged', 'expired', 'purged')),
  UNIQUE(sender_device_id, idempotency_key),
  UNIQUE(room_id, server_sequence)
);

CREATE INDEX IF NOT EXISTS idx_message_envelopes_room_sequence ON message_envelopes(room_id, server_sequence);
CREATE INDEX IF NOT EXISTS idx_message_envelopes_expires_at ON message_envelopes(expires_at);

CREATE TABLE IF NOT EXISTS delivery_receipts (
  receipt_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES message_envelopes(envelope_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  recipient_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  recipient_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  recipient_device_id TEXT NOT NULL REFERENCES devices(device_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'read')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stored_at TEXT,
  read_at TEXT,
  UNIQUE(envelope_id, recipient_device_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_receipts_device_id ON delivery_receipts(recipient_device_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_room_id ON delivery_receipts(room_id);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  uploader_account_id TEXT NOT NULL REFERENCES accounts(account_id),
  uploader_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  uploader_device_id TEXT NOT NULL REFERENCES devices(device_id),
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('allocated', 'uploaded', 'referenced', 'expired', 'deleted', 'quarantined_metadata')),
  expected_bytes INTEGER NOT NULL,
  ciphertext_bytes INTEGER,
  ciphertext_sha256 TEXT,
  content_category TEXT,
  retention_class TEXT NOT NULL DEFAULT 'default',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uploaded_at TEXT,
  referenced_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_room_id ON attachments(room_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader_account_id ON attachments(uploader_account_id);
CREATE INDEX IF NOT EXISTS idx_attachments_state ON attachments(state, expires_at);

CREATE TABLE IF NOT EXISTS sidebar_collections (
  collection_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sidebar_collections_account_id ON sidebar_collections(account_id);

CREATE TABLE IF NOT EXISTS sidebar_collection_items (
  item_id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES sidebar_collections(collection_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(collection_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_sidebar_collection_items_collection_id ON sidebar_collection_items(collection_id);

CREATE TABLE IF NOT EXISTS agent_requests (
  request_id TEXT PRIMARY KEY,
  requester_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  requester_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  desired_agent_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected', 'provisioning', 'active', 'closed')),
  metadata_json TEXT,
  reviewed_by_account_id TEXT REFERENCES accounts(account_id),
  reviewed_at TEXT,
  created_agent_principal_id TEXT REFERENCES principals(principal_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_requests_requester_account_id ON agent_requests(requester_account_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status);

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
