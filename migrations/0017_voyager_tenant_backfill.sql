-- Voyager compatibility tenant backfill for Messaging Core extraction.
--
-- Existing Voyager deployments are single-tenant. Give every existing table row
-- a stable default tenant so later tenant-scoped Messaging Core code can read
-- existing Voyager data without rewriting historical R2 object keys.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO tenants (tenant_id, display_name)
VALUES ('tenant_voyager_default', 'Voyager Default Tenant');

ALTER TABLE account_admin_roles ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE accounts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE admin_roles ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE agent_requests ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE attachments ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE audit_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE authenticators ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE call_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE call_participants ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE call_realtime_sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE call_realtime_tracks ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE call_usage_reports ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE calls ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE credential_reset_tokens ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE delivery_receipts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE device_key_packages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE devices ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE invitations ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE maintenance_runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE message_edits ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE message_envelopes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE message_pins ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE message_reactions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE message_visibility ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE ownership_transfers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE policies ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE principals ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE rate_limits ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE realtime_socket_tokens ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE room_invitations ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE room_memberships ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE rooms ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE sidebar_collection_items ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE sidebar_collections ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';
ALTER TABLE thread_states ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_voyager_default';

-- Tenant-aware companion indexes. Existing non-tenant indexes remain for current
-- Voyager code paths until the later cutover/query-port PRs enforce tenant scope.
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_status ON accounts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_principals_tenant_account ON principals(tenant_id, account_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_account ON devices(tenant_id, account_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_status ON rooms(tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_room_memberships_tenant_room ON room_memberships(tenant_id, room_id, status);
CREATE INDEX IF NOT EXISTS idx_room_memberships_tenant_principal ON room_memberships(tenant_id, principal_id, status);
CREATE INDEX IF NOT EXISTS idx_room_invitations_tenant_room ON room_invitations(tenant_id, room_id, status);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_tenant_room ON ownership_transfers(tenant_id, room_id, status);
CREATE INDEX IF NOT EXISTS idx_message_envelopes_tenant_room_sequence ON message_envelopes(tenant_id, room_id, server_sequence);
CREATE INDEX IF NOT EXISTS idx_message_envelopes_tenant_sender_idempotency ON message_envelopes(tenant_id, sender_device_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_tenant_envelope_device ON delivery_receipts(tenant_id, envelope_id, recipient_device_id);
CREATE INDEX IF NOT EXISTS idx_message_visibility_tenant_account_room ON message_visibility(tenant_id, account_id, room_id);
CREATE INDEX IF NOT EXISTS idx_message_edits_tenant_envelope ON message_edits(tenant_id, envelope_id, edited_at);
CREATE INDEX IF NOT EXISTS idx_message_reactions_tenant_envelope ON message_reactions(tenant_id, envelope_id);
CREATE INDEX IF NOT EXISTS idx_message_pins_tenant_room ON message_pins(tenant_id, room_id, pinned_at);
CREATE INDEX IF NOT EXISTS idx_thread_states_tenant_account_updated ON thread_states(tenant_id, account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant_room_state ON attachments(tenant_id, room_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant_uploader_daily ON attachments(tenant_id, uploader_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_realtime_socket_tokens_tenant_token_hash ON realtime_socket_tokens(tenant_id, token_hash);
CREATE INDEX IF NOT EXISTS idx_rate_limits_tenant_action_key ON rate_limits(tenant_id, action, rate_limit_key, window_start);
CREATE INDEX IF NOT EXISTS idx_calls_tenant_room_created ON calls(tenant_id, room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_participants_tenant_call ON call_participants(tenant_id, call_id, status);
CREATE INDEX IF NOT EXISTS idx_call_events_tenant_call_created ON call_events(tenant_id, call_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_realtime_sessions_tenant_call ON call_realtime_sessions(tenant_id, call_id, status);
CREATE INDEX IF NOT EXISTS idx_call_realtime_tracks_tenant_call ON call_realtime_tracks(tenant_id, call_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_call_usage_reports_tenant_call ON call_usage_reports(tenant_id, call_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_timestamp ON audit_events(tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_maintenance_runs_tenant_created ON maintenance_runs(tenant_id, created_at);

-- Intentionally no UPDATE of attachments.object_key/original_object_key/etc.
-- Existing stored R2 object keys remain valid. New allocations use tenant-
-- prefixed object keys in application code.
