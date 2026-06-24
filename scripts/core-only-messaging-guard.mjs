import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { assertMessagingCoreBoundaryCatalog, endpointStabilityCatalog, messagingCoreBoundaryCatalog } from "./api-contract-assertions.mjs";

const ROOT = process.cwd();
const LEGACY_SOURCE = "voyager_" + "legacy";
const TEMPORARY_FALLBACK = "temporary-" + "fallback";

const DISALLOWED_LEGACY_RUNTIME_PATHS = [
  "src/backend/attachments",
  "src/backend/attachments.ts",
  "src/backend/conversation-coordinator.ts",
  "src/backend/message.ts",
  "src/backend/messages.ts",
  "src/backend/messaging",
  "src/backend/messaging.ts",
  "src/backend/routing/attachment-routes.ts",
  "src/backend/routing/message-routes.ts",
  "src/backend/routing/sync-routes.ts",
  "src/backend/routing/thread-routes.ts",
  "src/backend/sync.ts",
  "src/backend/threads.ts",
  "src/backend/call-coordinator.ts",
  "src/backend/calls.ts",
  "src/backend/calls",
  "src/backend/routing/call-routes.ts",
  "src/realtime.ts",
];

const TEXT_SCAN_ROOTS = ["src", "apps/client/src", "scripts", "docs"];
const TEXT_SCAN_FILES = ["package.json", "wrangler.jsonc"];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".svelte-kit",
  ".wrangler",
  "build",
  "dist",
  "node_modules",
]);
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".svelte", ".json", ".jsonc", ".md"]);

const LEGACY_SOURCE_ASSERTION_ALLOWLIST = new Map([
  ["docs/api-contract.md", [/must not emit/, /smoke fails/, /contains `source:/]],
  ["docs/dev-test-operations.md", [/fails if/]],
  ["scripts/backend-first-smoke.mjs", [/value\.source ===/, /unexpectedly returned/]],
  ["scripts/core-only-messaging-guard.mjs", [/LEGACY_SOURCE/]],
  ["scripts/voyager-messaging-core-parity-smoke.mjs", [/value\.source ===/, /unexpectedly returned/]],
]);

const CONVERSATION_COORDINATOR_DOC_ALLOWLIST = new Set([
  "docs/backend-contract-handoff.md",
  "docs/backend-source-layout.md",
  "docs/conversation-do-implementation-plan.md",
  "docs/realtime-messaging-handoff.md",
  "wrangler.jsonc",
]);

const failures = [];
const evidence = [];

assertNoDisallowedPaths();
assertRouteCatalog();
assertNoActiveLegacyDurableObjectBindings();
scanTextFiles();

if (failures.length) {
  console.error("Core-only messaging guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checks: evidence }, null, 2));

function assertNoDisallowedPaths() {
  const present = DISALLOWED_LEGACY_RUNTIME_PATHS.filter((path) => existsSync(path));
  if (present.length) {
    failures.push(`legacy Voyager messaging runtime paths are present: ${present.join(", ")}`);
    return;
  }
  evidence.push({ check: "legacy-runtime-paths-absent", count: DISALLOWED_LEGACY_RUNTIME_PATHS.length });
}

function assertRouteCatalog() {
  try {
    assertMessagingCoreBoundaryCatalog();
  } catch (error) {
    failures.push(`Messaging Core boundary catalog is invalid: ${error.message}`);
    return;
  }

  const blockedRoutes = new Set(["GET /v1/realtime", "POST /v1/realtime/token"]);
  const blockedCatalogRoutes = endpointStabilityCatalog
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .filter((key) => blockedRoutes.has(key));
  if (blockedCatalogRoutes.length) {
    failures.push(`legacy messaging realtime routes are still cataloged: ${blockedCatalogRoutes.join(", ")}`);
  }

  const fallbackBoundaries = messagingCoreBoundaryCatalog
    .filter((entry) => entry.boundary === TEMPORARY_FALLBACK || entry.boundary === "temporary-call-fallback")
    .map((entry) => `${entry.method} ${entry.path}`);
  if (fallbackBoundaries.length) {
    failures.push(`temporary fallback boundaries remain in the Core boundary catalog: ${fallbackBoundaries.join(", ")}`);
  }

  evidence.push({
    check: "route-catalog-core-only",
    endpointCount: endpointStabilityCatalog.length,
    boundaryCount: messagingCoreBoundaryCatalog.length,
  });
}

function assertNoActiveLegacyDurableObjectBindings() {
  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  const durableObjectsBlock = extractJsonObjectLikeBlock(wrangler, "durable_objects");
  if (!durableObjectsBlock) {
    evidence.push({ check: "no-active-voyager-durable-object-bindings" });
    assertNoLegacyDurableObjectsOnEnv();
    return;
  }
  if (/"CONVERSATION_COORDINATOR"|"ConversationCoordinator"|"CALL_COORDINATOR"|"CallCoordinator"|"REALTIME_MAILBOX"|"RealtimeMailbox"/.test(durableObjectsBlock)) {
    failures.push("wrangler.jsonc has an active legacy Voyager messaging/call Durable Object binding");
  }

  assertNoLegacyDurableObjectsOnEnv();
  evidence.push({ check: "no-active-voyager-durable-object-bindings" });
}

function assertNoLegacyDurableObjectsOnEnv() {
  const envSource = readFileSync("src/types.ts", "utf8");
  if (envSource.includes("CONVERSATION_COORDINATOR")) {
    failures.push("src/types.ts reintroduces CONVERSATION_COORDINATOR on Env");
  }
  if (envSource.includes("CALL_COORDINATOR")) {
    failures.push("src/types.ts reintroduces CALL_COORDINATOR on Env");
  }
  if (envSource.includes("REALTIME_MAILBOX")) {
    failures.push("src/types.ts reintroduces REALTIME_MAILBOX on Env");
  }
}

function scanTextFiles() {
  const files = [
    ...TEXT_SCAN_ROOTS.flatMap((root) => listTextFiles(root)),
    ...TEXT_SCAN_FILES.filter((file) => existsSync(file)),
  ].sort();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (line.includes(LEGACY_SOURCE) && !isAllowedLegacySourceAssertion(file, line)) {
        failures.push(`${file}:${lineNumber} contains ${LEGACY_SOURCE} outside an explicit negative assertion`);
      }
      if (line.includes(TEMPORARY_FALLBACK)) {
        failures.push(`${file}:${lineNumber} contains ${TEMPORARY_FALLBACK}`);
      }
      if (file !== "scripts/core-only-messaging-guard.mjs" && /temporary Voyager messaging fallback|temporary messaging fallback|legacy messaging fallback|legacy realtime fallback|fallback to Voyager legacy/i.test(line)) {
        failures.push(`${file}:${lineNumber} describes a legacy/temporary messaging fallback`);
      }
      if (/ConversationCoordinator/.test(line) && file.startsWith("src/")) {
        failures.push(`${file}:${lineNumber} reintroduces Voyager source reference to ConversationCoordinator`);
      }
      if (/(CallCoordinator|RealtimeMailbox|CALL_COORDINATOR|REALTIME_MAILBOX|voyager\.call-realtime\.v1)/.test(line) && file.startsWith("src/")) {
        failures.push(`${file}:${lineNumber} reintroduces Voyager call runtime source`);
      }
      if (
        /(call-runtime|call-realtime-runtime)/.test(line) &&
        file !== "scripts/core-only-messaging-guard.mjs" &&
        (file.startsWith("src/") || file.startsWith("scripts/"))
      ) {
        failures.push(`${file}:${lineNumber} reintroduces legacy call runtime boundary text`);
      }
      if (/ConversationCoordinator/.test(line) && !file.startsWith("src/") && !CONVERSATION_COORDINATOR_DOC_ALLOWLIST.has(file) && file !== "scripts/core-only-messaging-guard.mjs") {
        failures.push(`${file}:${lineNumber} mentions ConversationCoordinator outside approved historical/Core-boundary docs`);
      }
    });
  }

  evidence.push({ check: "text-scan-core-only", fileCount: files.length });
}

function isAllowedLegacySourceAssertion(file, line) {
  const patterns = LEGACY_SOURCE_ASSERTION_ALLOWLIST.get(file);
  return Boolean(patterns?.some((pattern) => pattern.test(line)));
}

function listTextFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) result.push(...listTextFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    if (TEXT_EXTENSIONS.has(extension(entry.name))) result.push(toRelativePath(path));
  }
  return result;
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function toRelativePath(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function extractJsonObjectLikeBlock(source, key) {
  const keyIndex = source.indexOf(`"${key}"`);
  if (keyIndex < 0) return null;
  const openBrace = source.indexOf("{", keyIndex);
  if (openBrace < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }
  return null;
}
