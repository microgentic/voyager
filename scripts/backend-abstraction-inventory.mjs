import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { endpointStabilityCatalog } from "./api-contract-assertions.mjs";
import { assertRouteInventory, implementedRouteInventory } from "./route-inventory-check.mjs";

const VOYAGER_ROOT = process.cwd();
const MESSAGING_CORE_REPO = process.env.MESSAGING_CORE_REPO ?? "/Users/admin/messaging-core-service";
const INVENTORY_JSON_PATH = "docs/backend-abstraction/voyager-extraction-inventory.json";
const VOYAGER_MAP_PATH = "docs/backend-abstraction/voyager-extraction-map.md";
const CORE_MAP_PATH = join(MESSAGING_CORE_REPO, "docs/voyager-extraction-map.md");

const CATEGORY_ORDER = [
  "CORE_PUBLIC",
  "CORE_INTERNAL",
  "PRODUCT_VOYAGER",
  "DROP_FROM_CORE",
  "REMODEL_FOR_CORE",
  "COMPATIBILITY_ONLY",
];

const STRATEGY_SECTIONS = {
  routes: "backend-abstraction-implementation-strategy.md:404",
  coreInclusion: "backend-abstraction-implementation-strategy.md:241",
  coreExclusion: "backend-abstraction-implementation-strategy.md:277",
  authBoundary: "backend-abstraction-implementation-strategy.md:300",
  tenantSchema: "backend-abstraction-implementation-strategy.md:680",
  dbSplit: "backend-abstraction-implementation-strategy.md:842",
  doRealtime: "backend-abstraction-implementation-strategy.md:1046",
  attachments: "backend-abstraction-implementation-strategy.md:1153",
  calls: "backend-abstraction-implementation-strategy.md:1186",
  maintenance: "backend-abstraction-implementation-strategy.md:1221",
  outbox: "backend-abstraction-implementation-strategy.md:1249",
};

main();

function main() {
  const routeGuard = assertRouteInventory();
  const routeFiles = implementedRouteInventory();
  const routes = endpointStabilityCatalog
    .map((endpoint) => {
      const implemented = routeFiles.find((route) => routeKey(route) === routeKey(endpoint));
      const classification = classifyRoute(endpoint);
      return {
        ...endpoint,
        implementedIn: implemented?.file ?? null,
        ...classification,
      };
    })
    .sort((a, b) => categoryCompare(a.category, b.category) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const tables = tableInventory();
  const modules = moduleInventory();
  const inventory = {
    generatedFrom: {
      voyagerRoot: VOYAGER_ROOT,
      messagingCoreRepo: MESSAGING_CORE_REPO,
      strategy: "backend-abstraction-implementation-strategy.md",
      routeGuard,
    },
    categories: CATEGORY_ORDER,
    routes,
    tables,
    modules,
    summaries: {
      routes: countByCategory(routes),
      tables: countByCategory(tables),
      modules: countByCategory(modules),
    },
  };

  writeJson(INVENTORY_JSON_PATH, inventory);
  const markdown = renderMarkdown(inventory);
  writeText(VOYAGER_MAP_PATH, markdown);
  writeText(CORE_MAP_PATH, markdown);
  console.log(JSON.stringify({
    ok: true,
    wrote: [INVENTORY_JSON_PATH, VOYAGER_MAP_PATH, CORE_MAP_PATH],
    summaries: inventory.summaries,
  }, null, 2));
}

function classifyRoute(route) {
  const path = route.path;
  const method = route.method;

  if (path.startsWith("/v1/sidebar-collections")) {
    return {
      category: "DROP_FROM_CORE",
      extractionTarget: "Keep in Voyager/product UI only.",
      strategyReference: STRATEGY_SECTIONS.coreExclusion,
      rationale: "Voyager sidebar collections are product navigation, not messaging substrate.",
    };
  }

  if (path.includes("/agent-requests")) {
    return {
      category: "DROP_FROM_CORE",
      extractionTarget: "Keep Voyager agent request/review workflow outside Messaging Core.",
      strategyReference: STRATEGY_SECTIONS.coreExclusion,
      rationale: "Agent request workflow is product provisioning/configuration, not core messaging.",
    };
  }

  if (path === "/v1/admin/agents") {
    return {
      category: "REMODEL_FOR_CORE",
      extractionTarget: "Replace with internal service-principal/agent-principal provisioning.",
      strategyReference: STRATEGY_SECTIONS.routes,
      rationale: "Core supports agent principals, but not Voyager admin provisioning routes.",
    };
  }

  if ([
    "/v1/admin/usage",
    "/v1/admin/calls/realtime-status",
    "/v1/admin/audit-events",
    "/v1/admin/maintenance/runs",
    "/v1/admin/maintenance/cleanup",
  ].includes(path)) {
    return {
      category: "REMODEL_FOR_CORE",
      extractionTarget: "Move behind internal service-token routes.",
      strategyReference: STRATEGY_SECTIONS.maintenance,
      rationale: "Core keeps maintenance/usage/audit capabilities, but not Voyager admin dashboards.",
    };
  }

  if (
    path.startsWith("/v1/auth/") ||
    path === "/v1/sessions" ||
    path.startsWith("/v1/sessions/") ||
    path === "/v1/devices" ||
    path === "/v1/devices/{deviceId}/revoke" ||
    path === "/v1/invitations/accept" ||
    path.startsWith("/v1/admin/")
  ) {
    return {
      category: "PRODUCT_VOYAGER",
      extractionTarget: "Remain in Voyager product backend.",
      strategyReference: STRATEGY_SECTIONS.authBoundary,
      rationale: "Product auth/admin/session/device-management UI remains outside reusable Messaging Core.",
    };
  }

  if (
    path === "/health" ||
    path === "/v1/meta" ||
    path === "/v1/me" ||
    path === "/v1/app/bootstrap" ||
    path.startsWith("/v1/principals") ||
    path.includes("/key-packages") ||
    path.startsWith("/v1/key-packages") ||
    path === "/v1/rooms" ||
    path.startsWith("/v1/rooms/") ||
    path === "/v1/threads" ||
    path === "/v1/sync" ||
    path.startsWith("/v1/room-invitations") ||
    path.startsWith("/v1/attachments/") ||
    path.startsWith("/v1/calls/")
  ) {
    return {
      category: "CORE_PUBLIC",
      extractionTarget: publicRouteTarget(path, method),
      strategyReference: STRATEGY_SECTIONS.routes,
      rationale: publicRouteRationale(path),
    };
  }

  return {
    category: "REMODEL_FOR_CORE",
    extractionTarget: "Review manually before extraction.",
    strategyReference: STRATEGY_SECTIONS.routes,
    rationale: "No explicit strategy mapping matched this current route.",
  };
}

function publicRouteTarget(path, method) {
  if (path === "/v1/me") return "Messaging identity view only; strip product/session assumptions.";
  if (path === "/v1/app/bootstrap") return "Messaging bootstrap or compatibility alias for /v1/messaging/bootstrap.";
  if (path.includes("/calls")) return "Core call route, feature/config gated by deployment.";
  if (path.includes("/attachments")) return "Core private attachment route with tenant-scoped R2 keys.";
  if (path.includes("/messages") || path === "/v1/threads") return "Core messaging/thread route.";
  if (path.includes("/rooms") || path.includes("/room-invitations")) return "Core room/membership/invitation route.";
  if (path.includes("key-packages") || path.includes("/principals")) return "Core messaging identity/key-package route.";
  if (path.includes("/realtime")) return "Core realtime token/socket route.";
  return `Core public compatibility route (${method}).`;
}

function publicRouteRationale(path) {
  if (path.includes("/calls")) return "Calls are reusable core communication substrate and can be disabled per deployment.";
  if (path.includes("/attachments")) return "Attachment metadata/R2 access belongs to messaging substrate.";
  if (path.includes("/messages") || path === "/v1/threads") return "Messages, threads, receipts, pins, reactions, forwarding, and deletion are core semantics.";
  if (path.includes("/rooms") || path.includes("/room-invitations")) return "Rooms, membership, invitations, and ownership are core communication semantics.";
  if (path.includes("/realtime")) return "Realtime sockets are core hints; HTTP sync remains source of truth.";
  return "Strategy lists this as part of the core public messaging surface or compatibility surface.";
}

function classifyTable(name) {
  const drop = new Set(["sidebar_collections", "sidebar_collection_items", "agent_requests"]);
  const product = new Set(["invitations", "authenticators", "sessions", "credential_reset_tokens", "admin_roles", "account_admin_roles"]);
  const remodel = new Set(["accounts", "policies", "audit_events"]);
  const core = new Set([
    "principals",
    "devices",
    "device_key_packages",
    "rooms",
    "room_memberships",
    "room_invitations",
    "ownership_transfers",
    "message_envelopes",
    "delivery_receipts",
    "message_visibility",
    "message_edits",
    "message_reactions",
    "message_pins",
    "thread_states",
    "attachments",
    "realtime_socket_tokens",
    "rate_limits",
    "maintenance_runs",
    "calls",
    "call_participants",
    "call_events",
    "call_realtime_sessions",
    "call_realtime_tracks",
    "call_usage_reports",
  ]);

  if (drop.has(name)) {
    return {
      category: "DROP_FROM_CORE",
      extractionTarget: "Exclude from Messaging Core migrations.",
      strategyReference: STRATEGY_SECTIONS.coreExclusion,
      rationale: "Voyager navigation/provisioning workflow data is product-specific.",
    };
  }
  if (product.has(name)) {
    return {
      category: "PRODUCT_VOYAGER",
      extractionTarget: "Keep in Voyager product schema.",
      strategyReference: STRATEGY_SECTIONS.authBoundary,
      rationale: "Product authentication/admin/session data is outside Messaging Core.",
    };
  }
  if (remodel.has(name)) {
    return {
      category: "REMODEL_FOR_CORE",
      extractionTarget: tableRemodelTarget(name),
      strategyReference: tableStrategyReference(name),
      rationale: "Current table carries useful concepts but must be reshaped for tenant-aware product-neutral core.",
    };
  }
  if (core.has(name)) {
    return {
      category: "CORE_PUBLIC",
      extractionTarget: "Port to tenant-aware Messaging Core schema.",
      strategyReference: STRATEGY_SECTIONS.tenantSchema,
      rationale: "Table stores reusable messaging, room, attachment, realtime, call, or maintenance state.",
    };
  }
  return {
    category: "REMODEL_FOR_CORE",
    extractionTarget: "Review before extraction.",
    strategyReference: STRATEGY_SECTIONS.tenantSchema,
    rationale: "Table was discovered in migrations but has no explicit classification rule yet.",
  };
}

function tableRemodelTarget(name) {
  if (name === "accounts") return "Remodel into tenant-scoped messaging_accounts keyed by product subject.";
  if (name === "policies") return "Remodel into tenant-aware messaging policy/limits table.";
  if (name === "audit_events") return "Remodel into internal core_audit_events, not Voyager admin audit UI.";
  return "Remodel into product-neutral core shape.";
}

function tableStrategyReference(name) {
  if (name === "audit_events") return STRATEGY_SECTIONS.maintenance;
  return STRATEGY_SECTIONS.tenantSchema;
}

function classifyModule(file) {
  const productPatterns = [
    /^src\/backend\/routing\/admin-routes\.ts$/,
    /^src\/backend\/routing\/agent-routes\.ts$/,
  ];
  const dropPatterns = [
    /^src\/backend\/sidebar\.ts$/,
    /^src\/backend\/routing\/sidebar-routes\.ts$/,
    /^src\/backend\/agents\.ts$/,
  ];
  const remodelPatterns = [
    /^src\/index\.ts$/,
    /^src\/backend\/routes\.ts$/,
    /^src\/backend\/routing\/index\.ts$/,
    /^src\/backend\/routing\/types\.ts$/,
    /^src\/backend\/routing\/identity-routes\.ts$/,
    /^src\/types\.ts$/,
    /^src\/db\.ts$/,
    /^src\/backend\/operations\.ts$/,
    /^src\/backend\/maintenance\.ts$/,
    /^src\/backend\/routing\/maintenance-routes\.ts$/,
    /^src\/backend\/identity\.ts$/,
    /^src\/backend\/identity\//,
  ];
  const corePatterns = [
    /^src\/http\.ts$/,
    /^src\/crypto\.ts$/,
    /^src\/realtime\.ts$/,
    /^src\/backend\/shared\//,
    /^src\/backend\/utils\.ts$/,
    /^src\/backend\/serializers\.ts$/,
    /^src\/backend\/internal-types\.ts$/,
    /^src\/backend\/sync\.ts$/,
    /^src\/backend\/conversation\//,
    /^src\/backend\/conversation-coordinator\.ts$/,
    /^src\/backend\/call-coordinator\.ts$/,
    /^src\/backend\/rooms(?:\.ts|\/)/,
    /^src\/backend\/messaging(?:\/)/,
    /^src\/backend\/messages\.ts$/,
    /^src\/backend\/threads\.ts$/,
    /^src\/backend\/attachments(?:\.ts|\/)/,
    /^src\/backend\/calls(?:\.ts|\/)/,
    /^src\/backend\/routing\/(?:room|message|thread|attachment|call|sync)-routes\.ts$/,
  ];

  if (dropPatterns.some((pattern) => pattern.test(file))) {
    return {
      category: "DROP_FROM_CORE",
      extractionTarget: "Keep out of Messaging Core.",
      strategyReference: STRATEGY_SECTIONS.coreExclusion,
      rationale: "Current module owns Voyager product navigation or agent request workflow.",
    };
  }
  if (productPatterns.some((pattern) => pattern.test(file))) {
    return {
      category: "PRODUCT_VOYAGER",
      extractionTarget: "Remain in Voyager product backend.",
      strategyReference: STRATEGY_SECTIONS.authBoundary,
      rationale: "Current module routes Voyager product admin/auth/provisioning behavior.",
    };
  }
  if (remodelPatterns.some((pattern) => pattern.test(file))) {
    return {
      category: "REMODEL_FOR_CORE",
      extractionTarget: moduleRemodelTarget(file),
      strategyReference: moduleStrategyReference(file),
      rationale: "Useful extraction surface, but current shape contains Voyager auth/admin/session or deployment assumptions.",
    };
  }
  if (corePatterns.some((pattern) => pattern.test(file))) {
    return {
      category: "CORE_PUBLIC",
      extractionTarget: "Move or mirror into Messaging Core package with tenant/auth updates.",
      strategyReference: STRATEGY_SECTIONS.coreInclusion,
      rationale: "Module owns reusable messaging, rooms, attachments, calls, realtime, sync, or shared utility behavior.",
    };
  }
  return {
    category: "REMODEL_FOR_CORE",
    extractionTarget: "Review manually before extraction.",
    strategyReference: STRATEGY_SECTIONS.coreInclusion,
    rationale: "Backend module did not match an explicit extraction rule.",
  };
}

function moduleRemodelTarget(file) {
  if (file === "src/db.ts") return "Split; move reusable messaging primitives and keep product auth/admin/session logic in Voyager.";
  if (file === "src/types.ts") return "Rewrite Env/AuthContext into product-neutral MessagingEnv/MessagingAuthContext.";
  if (file === "src/index.ts") return "Replace hardcoded Worker entry with createMessagingWorker factory plus Voyager adapter.";
  if (file === "src/backend/operations.ts") return "Split compatibility barrel; export only core-safe operations from Messaging Core and keep Voyager-only barrels in Voyager.";
  if (file === "src/backend/routing/identity-routes.ts") return "Port messaging identity/key-package routes, but replace Voyager audit/auth assumptions with core service auth and event hooks.";
  if (file.includes("maintenance")) return "Move core cleanup behind internal service-token routes; keep admin dashboard outside core.";
  if (file.includes("identity")) return "Port messaging identity/key-package pieces, not product identity.";
  return "Remodel for route factory and product/core boundary.";
}

function moduleStrategyReference(file) {
  if (file === "src/db.ts") return STRATEGY_SECTIONS.dbSplit;
  if (file === "src/types.ts") return STRATEGY_SECTIONS.authBoundary;
  if (file.includes("maintenance")) return STRATEGY_SECTIONS.maintenance;
  if (file.includes("identity")) return STRATEGY_SECTIONS.authBoundary;
  return STRATEGY_SECTIONS.routes;
}

function tableInventory() {
  const migrations = listFiles("migrations").filter((file) => file.endsWith(".sql")).sort();
  const tableMap = new Map();
  for (const file of migrations) {
    const source = readFileSync(file, "utf8");
    const names = new Set();
    for (const match of source.matchAll(/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][\w]*)/gi)) {
      names.add(match[1]);
    }
    for (const match of source.matchAll(/\bALTER\s+TABLE\s+([A-Za-z_][\w]*)/gi)) {
      names.add(match[1]);
    }
    for (const name of names) {
      const entry = tableMap.get(name) ?? { name, migrations: [] };
      entry.migrations.push(file);
      tableMap.set(name, entry);
    }
  }
  return [...tableMap.values()]
    .map((entry) => ({
      ...entry,
      ...classifyTable(entry.name),
    }))
    .sort((a, b) => categoryCompare(a.category, b.category) || a.name.localeCompare(b.name));
}

function moduleInventory() {
  const files = [
    "src/index.ts",
    "src/db.ts",
    "src/http.ts",
    "src/crypto.ts",
    "src/realtime.ts",
    "src/types.ts",
    ...listFiles("src/backend").filter((file) => file.endsWith(".ts")),
  ].filter((file, index, array) => array.indexOf(file) === index);

  return files
    .sort()
    .map((file) => ({
      file,
      ...classifyModule(file),
    }))
    .sort((a, b) => categoryCompare(a.category, b.category) || a.file.localeCompare(b.file));
}

function renderMarkdown(inventory) {
  return `# Voyager Extraction Map

This map is generated from the current Voyager backend code and the backend abstraction strategy. It is the PR 1 inventory artifact for deciding what moves into Messaging Core, what stays in Voyager, what is dropped from the core, and what must be remodeled.

Generated by:

\`\`\`bash
node scripts/backend-abstraction-inventory.mjs
\`\`\`

## Source Inputs

- Strategy: \`/Users/admin/voyager/backend-abstraction-implementation-strategy.md\`
- Voyager backend: \`/Users/admin/voyager/src/backend\`
- Voyager migrations: \`/Users/admin/voyager/migrations\`
- Route catalog: \`/Users/admin/voyager/scripts/api-contract-assertions.mjs\`
- Route implementation scan: \`/Users/admin/voyager/scripts/route-inventory-check.mjs\`

## Category Definitions

- \`CORE_PUBLIC\`: reusable public messaging-core API, schema, or module surface.
- \`CORE_INTERNAL\`: reusable core capability that must be exposed only through internal service-token routes.
- \`PRODUCT_VOYAGER\`: Voyager product backend concern; keep out of Messaging Core.
- \`DROP_FROM_CORE\`: current Voyager feature/data that should not exist in Messaging Core.
- \`REMODEL_FOR_CORE\`: useful concept, but current Voyager shape must be redesigned before extraction.
- \`COMPATIBILITY_ONLY\`: transitional alias or compatibility behavior only.

## Summary

### Routes

${renderCounts(inventory.summaries.routes)}

### Tables

${renderCounts(inventory.summaries.tables)}

### Modules

${renderCounts(inventory.summaries.modules)}

## Boundary Confirmation

- Messaging Core includes rooms, messaging, threads, attachments, realtime hints, Conversation DO sequencing, calls, messaging identity/key packages, and agent/service principals as messaging participants.
- Messaging Core excludes Voyager password login, user/admin account workflows, platform-owner role model, sidebar collections, agent request/review/provisioning workflow, and Hospitality business workflows.
- Current Voyager routes/modules/tables marked \`REMODEL_FOR_CORE\` are not safe to copy directly. They need tenant-aware, product-neutral redesign before moving.
- Current routes/modules/tables marked \`DROP_FROM_CORE\` should not be recreated in Messaging Core.
- Current routes/modules/tables marked \`PRODUCT_VOYAGER\` may continue to exist in Voyager, but should interact with Messaging Core through scoped tokens or internal service routes later.

## Route Inventory

| Method | Path | Category | Implemented in | Stability | Extraction target | Strategy ref | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- |
${inventory.routes.map((route) => `| ${route.method} | \`${route.path}\` | ${route.category} | ${formatNullable(route.implementedIn)} | ${route.stability} | ${escapeCell(route.extractionTarget)} | ${route.strategyReference} | ${escapeCell(route.rationale)} |`).join("\n")}

## Table Inventory

| Table | Category | Migrations | Extraction target | Strategy ref | Rationale |
| --- | --- | --- | --- | --- | --- |
${inventory.tables.map((table) => `| \`${table.name}\` | ${table.category} | ${table.migrations.map((file) => `\`${file}\``).join("<br>")} | ${escapeCell(table.extractionTarget)} | ${table.strategyReference} | ${escapeCell(table.rationale)} |`).join("\n")}

## Module Inventory

| File | Category | Extraction target | Strategy ref | Rationale |
| --- | --- | --- | --- | --- |
${inventory.modules.map((mod) => `| \`${mod.file}\` | ${mod.category} | ${escapeCell(mod.extractionTarget)} | ${mod.strategyReference} | ${escapeCell(mod.rationale)} |`).join("\n")}

## Follow-Up Requirements For Later PRs

- PR 2 creates the real package skeleton in Messaging Core; this inventory should be treated as its source boundary.
- PR 3 through PR 6 must turn \`REMODEL_FOR_CORE\` entries into product-neutral env/config/auth/tenant foundations before broad code movement.
- PR 7 and later must not move \`PRODUCT_VOYAGER\` or \`DROP_FROM_CORE\` entries into Messaging Core.
- Every core table/query/DO/R2/realtime/idempotency path must become tenant-aware before reusable release.
`;
}

function renderCounts(counts) {
  return CATEGORY_ORDER
    .filter((category) => counts[category])
    .map((category) => `- ${category}: ${counts[category]}`)
    .join("\n");
}

function countByCategory(items) {
  return items.reduce((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
}

function routeKey(route) {
  return `${route.method} ${normalizeRoutePath(route.path)}`;
}

function normalizeRoutePath(path) {
  return path.replace(/\{[^}]+\}/g, "{param}");
}

function categoryCompare(left, right) {
  return CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right);
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(file));
    } else if (entry.isFile()) {
      files.push(file);
    }
  }
  return files.map((file) => relative(VOYAGER_ROOT, file));
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function formatNullable(value) {
  return value ? `\`${value}\`` : "";
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
