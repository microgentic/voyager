import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { endpointStabilityCatalog } from "./api-contract-assertions.mjs";

const SOURCE_FILES = [
  "src/index.ts",
  "src/backend/routes.ts",
  "src/backend/routing/admin-routes.ts",
  "src/backend/routing/agent-routes.ts",
  "src/backend/routing/attachment-routes.ts",
  "src/backend/routing/call-routes.ts",
  "src/backend/routing/identity-routes.ts",
  "src/backend/routing/message-routes.ts",
  "src/backend/routing/room-routes.ts",
  "src/backend/routing/sidebar-routes.ts",
  "src/backend/routing/sync-routes.ts",
];
const ROUTE_KEY = (route) => `${route.method} ${normalizePath(route.path)}`;

export function implementedRouteInventory() {
  const routes = [];
  for (const file of SOURCE_FILES) {
    const source = readFileSync(file, "utf8");
    routes.push(...extractExactPathRoutes(source, file));
    routes.push(...extractRouteParamRoutes(source, file));
  }
  return uniqueRoutes(routes).filter(
    (route) => route.path === "/health" || route.path.startsWith("/v1/"),
  );
}

export function assertRouteInventory() {
  const implemented = implementedRouteInventory();
  const implementedKeys = new Set(implemented.map(ROUTE_KEY));
  const catalogKeys = new Set(endpointStabilityCatalog.map(ROUTE_KEY));

  const missingHandlers = endpointStabilityCatalog
    .filter((endpoint) => !implementedKeys.has(ROUTE_KEY(endpoint)))
    .map(
      (endpoint) =>
        `${endpoint.method} ${endpoint.path} (${endpoint.stability})`,
    );

  const uncategorizedRoutes = implemented
    .filter((route) => !catalogKeys.has(ROUTE_KEY(route)))
    .map((route) => `${route.method} ${route.path} (${route.file})`);

  if (missingHandlers.length || uncategorizedRoutes.length) {
    const details = [];
    if (missingHandlers.length) {
      details.push(
        `Missing implemented handlers for documented endpoints:\n${missingHandlers.map((route) => `  - ${route}`).join("\n")}`,
      );
    }
    if (uncategorizedRoutes.length) {
      details.push(
        `Implemented /v1 routes missing from endpointStabilityCatalog:\n${uncategorizedRoutes.map((route) => `  - ${route}`).join("\n")}`,
      );
    }
    throw new Error(`Route inventory mismatch:\n${details.join("\n\n")}`);
  }

  return {
    ok: true,
    implementedCount: implemented.length,
    catalogCount: endpointStabilityCatalog.length,
  };
}

function extractExactPathRoutes(source, file) {
  const routes = [];
  for (const block of ifBlocks(source)) {
    if (!block.condition.includes("url.pathname")) continue;
    const paths = [...block.condition.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    if (!paths.length) continue;
    const methods = methodsInBlock(block.body);
    for (const path of paths) {
      for (const method of methods) {
        routes.push({ method, path, file });
      }
    }
  }
  return routes;
}

function extractRouteParamRoutes(source, file) {
  const routes = [];
  const declarations = [
    ...source.matchAll(
      /const\s+(\w+)\s*=\s*routeParams\(\s*\/([\s\S]*?)\/,\s*url\.pathname,?\s*\);/g,
    ),
  ];
  for (const declaration of declarations) {
    const [, variableName, regexBody] = declaration;
    const block = findIfBlockForVariable(
      source,
      declaration.index + declaration[0].length,
      variableName,
    );
    if (!block) continue;
    const methods = methodsInBlock(block.body);
    const paths = pathsFromRouteRegex(regexBody);
    for (const path of paths) {
      for (const method of methods) {
        routes.push({ method, path, file });
      }
    }
  }
  return routes;
}

function ifBlocks(source) {
  const blocks = [];
  let searchIndex = 0;
  while (true) {
    const ifIndex = source.indexOf("if", searchIndex);
    if (ifIndex < 0) return blocks;
    if (
      !isWordBoundary(source, ifIndex - 1) ||
      !isWordBoundary(source, ifIndex + 2)
    ) {
      searchIndex = ifIndex + 2;
      continue;
    }
    const openParen = nextNonWhitespace(source, ifIndex + 2);
    if (source[openParen] !== "(") {
      searchIndex = ifIndex + 2;
      continue;
    }
    const closeParen = findMatching(source, openParen, "(", ")");
    const openBrace = nextNonWhitespace(source, closeParen + 1);
    if (source[openBrace] !== "{") {
      searchIndex = closeParen + 1;
      continue;
    }
    const closeBrace = findMatching(source, openBrace, "{", "}");
    blocks.push({
      index: ifIndex,
      condition: source.slice(openParen + 1, closeParen),
      body: source.slice(openBrace + 1, closeBrace),
    });
    searchIndex = ifIndex + 2;
  }
}

function findIfBlockForVariable(source, startIndex, variableName) {
  const blocks = ifBlocks(source.slice(startIndex));
  const target = new RegExp(`^\\s*${variableName}\\s*$`);
  const block = blocks.find((candidate) => target.test(candidate.condition));
  return block ? { ...block, index: block.index + startIndex } : null;
}

function methodsInBlock(block) {
  const methods = new Set();
  for (const match of block.matchAll(
    /requireMethod\(\s*request,\s*"([A-Z]+)"\s*\)/g,
  )) {
    methods.add(match[1]);
  }
  for (const match of block.matchAll(/request\.method\s*===\s*"([A-Z]+)"/g)) {
    methods.add(match[1]);
  }
  return [...methods].sort();
}

function pathsFromRouteRegex(regexBody) {
  let path = regexBody.trim();
  path = path.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/");
  path = path.replace(/\(\[\^\/\]\+\)/g, "{param}");
  return expandAlternatives(path).map(normalizePath);
}

function expandAlternatives(path) {
  const match = path.match(/\(([^()]*\|[^()]*)\)/);
  if (!match) return [path];
  const before = path.slice(0, match.index);
  const after = path.slice(match.index + match[0].length);
  return match[1].split("|").flatMap((option) => expandAlternatives(`${before}${option}${after}`));
}

function normalizePath(path) {
  return path.replace(/\{[^}]+\}/g, "{param}");
}

function uniqueRoutes(routes) {
  const seen = new Set();
  const result = [];
  for (const route of routes) {
    const key = ROUTE_KEY(route);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(route);
  }
  return result.sort((left, right) => ROUTE_KEY(left).localeCompare(ROUTE_KEY(right)));
}

function nextNonWhitespace(source, index) {
  let current = index;
  while (/\s/.test(source[current] ?? "")) current += 1;
  return current;
}

function findMatching(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Could not find matching ${closeChar} from index ${openIndex}`);
}

function isWordBoundary(source, index) {
  const char = source[index];
  return !char || !/[a-zA-Z0-9_$]/.test(char);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = assertRouteInventory();
  console.log(JSON.stringify(result, null, 2));
}
