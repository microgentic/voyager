-- Keep call usage diagnostics explicit about data authority.
-- Client reports are estimates; provider-authoritative billing data must come
-- from a trusted provider integration before it can feed provider egress totals.

ALTER TABLE call_usage_reports
  ADD COLUMN source TEXT NOT NULL DEFAULT 'client_estimate'
    CHECK (source IN ('client_estimate', 'provider_authoritative'));

DELETE FROM call_usage_reports
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM call_usage_reports
  GROUP BY call_id, device_id, COALESCE(provider_session_id, '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_usage_reports_device_session_unique
  ON call_usage_reports(call_id, device_id, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_usage_reports_device_no_session_unique
  ON call_usage_reports(call_id, device_id)
  WHERE provider_session_id IS NULL;
