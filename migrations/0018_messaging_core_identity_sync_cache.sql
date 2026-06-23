CREATE TABLE IF NOT EXISTS messaging_core_identity_sync_cache (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id, principal_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_messaging_core_identity_sync_cache_expires_at
  ON messaging_core_identity_sync_cache(expires_at);
