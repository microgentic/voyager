import { execFileSync } from "node:child_process";

const requiredSecrets = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY"];

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function runWrangler(args, options = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    env: process.env,
    ...options,
  });
}

function listWorkerSecretNames() {
  const output = runWrangler(["secret", "list", "--format", "json"]);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(
    parsed
      .map((secret) => secret?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );
}

function putWorkerSecret(name, value) {
  runWrangler(["secret", "put", name], { input: value });
  console.log(`Synced Worker secret ${name}`);
}

const providedSecrets = new Map(
  requiredSecrets
    .map((name) => [name, envValue(name)])
    .filter((entry) => entry[1] !== null),
);

if (providedSecrets.size > 0 && providedSecrets.size !== requiredSecrets.length) {
  const missing = requiredSecrets.filter((name) => !providedSecrets.has(name));
  throw new Error(`Partial APNs GitHub secret configuration. Missing: ${missing.join(", ")}`);
}

if (providedSecrets.size === requiredSecrets.length) {
  for (const [name, value] of providedSecrets) {
    putWorkerSecret(name, value);
  }
} else {
  const existingSecrets = listWorkerSecretNames();
  const missing = requiredSecrets.filter((name) => !existingSecrets.has(name));
  if (missing.length > 0) {
    throw new Error(
      `APNs Worker secrets are missing: ${missing.join(", ")}. ` +
        "Add them as GitHub Actions secrets or run wrangler secret put before deploying.",
    );
  }
  console.log("APNs Worker secrets already exist in Cloudflare; no GitHub secret sync needed.");
}
