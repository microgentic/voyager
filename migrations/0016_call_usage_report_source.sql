-- Keep call usage diagnostics explicit about data authority.
-- Client reports are estimates; provider-authoritative billing data must come
-- from a trusted provider integration before it can feed provider egress totals.

ALTER TABLE call_usage_reports
  ADD COLUMN source TEXT NOT NULL DEFAULT 'client_estimate'
    CHECK (source IN ('client_estimate', 'provider_authoritative'));
