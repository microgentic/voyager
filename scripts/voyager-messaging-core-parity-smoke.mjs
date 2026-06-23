const voyagerBaseUrl = trimTrailingSlash(process.env.VOYAGER_BASE_URL ?? process.env.BASE_URL ?? "");
const sessionToken = process.env.VOYAGER_SESSION_TOKEN ?? "";
const loginEmail = process.env.VOYAGER_LOGIN_EMAIL ?? "";
const loginPassword = process.env.VOYAGER_LOGIN_PASSWORD ?? "";
const fetchTimeoutMs = Number(process.env.SMOKE_FETCH_TIMEOUT_MS ?? 10_000);

if (!voyagerBaseUrl) {
  throw new Error("Set VOYAGER_BASE_URL or BASE_URL to the Voyager API base URL.");
}
if (!sessionToken && (!loginEmail || !loginPassword)) {
  throw new Error("Set VOYAGER_SESSION_TOKEN, or set VOYAGER_LOGIN_EMAIL and VOYAGER_LOGIN_PASSWORD.");
}

const authResult = sessionToken
  ? null
  : await voyagerApi("/v1/auth/password/login", {
      method: "POST",
      auth: false,
      json: {
        email: loginEmail,
        password: loginPassword,
        device: {
          platform: "smoke",
          label: "Messaging Core parity smoke",
        },
      },
    });
const voyagerToken = sessionToken || authResult.sessionToken;

const bridge = await voyagerApi("/v1/messaging-core/session", {
  method: "POST",
  token: voyagerToken,
});

const messagingCore = bridge.messagingCore;
assertObject(messagingCore, "messagingCore");
if (!messagingCore.configured || !messagingCore.token || !messagingCore.baseUrl) {
  throw new Error(`Voyager Messaging Core bridge is not configured: ${JSON.stringify(messagingCore)}`);
}

const claims = decodeJwtPayload(messagingCore.token);
const coreBaseUrl = trimTrailingSlash(process.env.MESSAGING_CORE_BASE_URL ?? messagingCore.baseUrl);
const coreMe = await coreApi(coreBaseUrl, "/me", messagingCore.token);
assertEqual(coreMe.account?.accountId, claims.accountId, "Core /me accountId");
assertEqual(coreMe.principal?.principalId, claims.principalId, "Core /me principalId");
assertEqual(coreMe.device?.deviceId, claims.deviceId, "Core /me deviceId");
assertEqual(coreMe.account?.tenantId, claims.tenantId, "Core /me tenantId");

const coreBootstrap = await coreApi(coreBaseUrl, "/bootstrap", messagingCore.token);
if (!coreBootstrap.ok || !coreBootstrap.bootstrap) {
  throw new Error(`Core /bootstrap did not return bootstrap payload: ${JSON.stringify(coreBootstrap)}`);
}
assertEqual(coreBootstrap.bootstrap.tenantId, claims.tenantId, "Core /bootstrap tenantId");
assertEqual(coreBootstrap.bootstrap.account?.accountId, claims.accountId, "Core /bootstrap accountId");

console.log(JSON.stringify({
  ok: true,
  voyagerBaseUrl,
  messagingCoreBaseUrl: coreBaseUrl,
  tenantId: claims.tenantId,
  accountId: claims.accountId,
  principalId: claims.principalId,
  deviceId: claims.deviceId,
}, null, 2));

async function voyagerApi(path, options = {}) {
  return requestJson(`${voyagerBaseUrl}${path}`, options);
}

async function coreApi(baseUrl, path, token) {
  return requestJson(`${baseUrl}${path}`, { token });
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const fetchOptions = { ...options };
  delete fetchOptions.json;
  delete fetchOptions.auth;
  delete fetchOptions.token;
  if (options.auth !== false) {
    headers.set("authorization", `Bearer ${options.token ?? ""}`);
  }
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    fetchOptions.body = JSON.stringify(options.json);
  }
  const response = await fetch(url, {
    ...fetchOptions,
    headers,
    signal: fetchOptions.signal ?? AbortSignal.timeout(fetchTimeoutMs),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed ${response.status}: ${text}`);
  }
  return payload;
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Messaging Core token is not a compact JWT.");
  return JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8"));
}

function base64UrlToBase64(value) {
  return value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
}

function trimTrailingSlash(value) {
  return value.trim().replace(/\/+$/, "");
}

function assertObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
}

function assertEqual(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context} expected ${expected} but got ${actual}`);
  }
}
