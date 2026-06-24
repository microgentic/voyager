import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TENANT_ID = "tenant_voyager_default";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const migrationDir = join(ROOT, "migrations");
const migrationFiles = readdirSync(migrationDir)
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();
const migrationSql = migrationFiles
  .map((file) => readFileSync(join(migrationDir, file), "utf8"))
  .join("\n\n");
const backfillSql = readFileSync(
  join(migrationDir, "0017_voyager_tenant_backfill.sql"),
  "utf8",
);

const sqliteOutput = execFileSync("sqlite3", [":memory:"], {
  input: [
    "PRAGMA foreign_keys = ON;",
    migrationSql,
    ".schema",
    `SELECT 'tenant_count=' || COUNT(*) FROM tenants WHERE tenant_id = '${DEFAULT_TENANT_ID}';`,
  ].join("\n"),
  encoding: "utf8",
});

const tenantBackfilledTables = [
  "account_admin_roles",
  "accounts",
  "admin_roles",
  "agent_requests",
  "attachments",
  "audit_events",
  "authenticators",
  "call_events",
  "call_participants",
  "call_realtime_sessions",
  "call_realtime_tracks",
  "call_usage_reports",
  "calls",
  "credential_reset_tokens",
  "delivery_receipts",
  "device_key_packages",
  "devices",
  "invitations",
  "maintenance_runs",
  "message_edits",
  "message_envelopes",
  "message_pins",
  "message_reactions",
  "message_visibility",
  "ownership_transfers",
  "policies",
  "principals",
  "rate_limits",
  "realtime_socket_tokens",
  "room_invitations",
  "room_memberships",
  "rooms",
  "sessions",
  "sidebar_collection_items",
  "sidebar_collections",
  "thread_states",
];

for (const table of tenantBackfilledTables) {
  const tableBody = tableSchemaBody(sqliteOutput, table);
  assert(
    tableBody !== null,
    `${table} should exist after applying all Voyager migrations`,
  );
  assert(
    tableBody.includes(`tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`),
    `${table} should have default Voyager tenant_id`,
  );
}

assert(
  sqliteOutput.includes("tenant_count=1"),
  "default Voyager tenant row should be inserted",
);
assert(
  /CREATE INDEX idx_message_envelopes_tenant_room_sequence/.test(sqliteOutput),
  "message envelopes should have a tenant-aware room sequence index",
);
assert(
  /CREATE INDEX idx_attachments_tenant_room_state/.test(sqliteOutput),
  "attachments should have a tenant-aware room/state index",
);
assert(
  /CREATE INDEX idx_calls_tenant_room_created/.test(sqliteOutput),
  "calls should have a tenant-aware room/created index",
);
assert(
  !/UPDATE\s+attachments[\s\S]*(object_key|original_object_key|preview_object_key|thumbnail_object_key)/i.test(backfillSql),
  "tenant backfill migration must not rewrite existing attachment object keys",
);

console.log(
  JSON.stringify({
    ok: true,
    defaultTenantId: DEFAULT_TENANT_ID,
    checkedTables: tenantBackfilledTables.length,
    coreOnlyAttachmentRuntime: true,
  }),
);

function tableSchemaBody(schema, table) {
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = schema.match(new RegExp(`CREATE TABLE ${escapedTable} \\(([\\s\\S]*?)\\n\\)`));
  return match?.[1] ?? null;
}
