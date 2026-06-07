const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";
const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? "local-bootstrap-secret";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    options.body = JSON.stringify(options.json);
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

const health = await api("/health");
if (!health.ok) throw new Error("health check failed");

const owner = await api("/v1/admin/bootstrap", {
  method: "POST",
  headers: { "x-bootstrap-token": bootstrapToken },
  json: {
    displayName: "Backend Owner",
    email: `owner-${suffix}@example.com`,
    password: "backend-owner-passphrase-very-long",
    device: { platform: "smoke", label: "Owner smoke device", publicKeyPackage: "owner-device-key" }
  }
});
const ownerHeaders = auth(owner.sessionToken);

const invite = await api("/v1/admin/invitations", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Backend User",
    email: `user-${suffix}@example.com`,
    expiresInDays: 3
  }
});

const accepted = await api("/v1/invitations/accept", {
  method: "POST",
  json: {
    token: invite.activationToken,
    password: "backend-user-passphrase-very-long",
    device: { platform: "smoke", label: "User smoke device", publicKeyPackage: "user-device-key" }
  }
});

const login = await api("/v1/auth/password/login", {
  method: "POST",
  json: {
    email: invite.account.email,
    password: "backend-user-passphrase-very-long",
    device: { platform: "smoke", label: "User browser smoke device" }
  }
});
const userHeaders = auth(login.sessionToken);

const ownerKeyPackage = await api(`/v1/devices/${owner.device.deviceId}/key-packages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    protocol: "opaque-test",
    package: { identity: "owner", key: "owner-key-package" },
    publicIdentityKey: "owner-public-identity",
    expiresInDays: 5
  }
});

const listedKeys = await api(`/v1/principals/${owner.principal.principalId}/key-packages`, {
  headers: userHeaders
});
if (listedKeys.keyPackages.length < 1) throw new Error("key package listing failed");

await api(`/v1/key-packages/${ownerKeyPackage.keyPackage.keyPackageId}/claim`, {
  method: "POST",
  headers: userHeaders
});

const direct = await api("/v1/rooms/direct", {
  method: "POST",
  headers: ownerHeaders,
  json: { principalIds: [accepted.principal.principalId], name: "Smoke direct" }
});

const group = await api("/v1/rooms/groups", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    name: "Smoke group",
    description: "Backend-first smoke group",
    memberPrincipalIds: [accepted.principal.principalId]
  }
});

const agentRequest = await api("/v1/agent-requests", {
  method: "POST",
  headers: userHeaders,
  json: {
    desiredAgentName: "Smoke Agent",
    summary: "Need a backend-first smoke agent",
    metadata: { department: "testing" }
  }
});

await api(`/v1/admin/agent-requests/${agentRequest.request.requestId}`, {
  method: "PATCH",
  headers: ownerHeaders,
  json: { status: "approved" }
});

const agent = await api("/v1/admin/agents", {
  method: "POST",
  headers: ownerHeaders,
  json: {
    displayName: "Smoke Agent",
    ownerPrincipalId: owner.principal.principalId,
    requestId: agentRequest.request.requestId
  }
});

await api(`/v1/rooms/${group.room.roomId}/members`, {
  method: "POST",
  headers: ownerHeaders,
  json: { principalId: agent.agent.principalId }
});

const directMessage = await api(`/v1/rooms/${direct.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `direct-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-direct-smoke-payload"
  }
});

const synced = await api("/v1/sync", { headers: userHeaders });
if (synced.sync.pendingMessages.length < 1) throw new Error("sync did not return pending messages");

await api(`/v1/rooms/${direct.room.roomId}/messages/${directMessage.message.envelopeId}/ack`, {
  method: "POST",
  headers: userHeaders,
  json: { status: "stored" }
});

const attachmentBody = new TextEncoder().encode("encrypted-smoke-blob");

const attachment = await api(`/v1/rooms/${group.room.roomId}/attachments`, {
  method: "POST",
  headers: ownerHeaders,
  json: { expectedBytes: attachmentBody.byteLength, contentCategory: "opaque-test" }
});

await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  method: "PUT",
  headers: ownerHeaders,
  body: attachmentBody
});

await api(`/v1/attachments/${attachment.attachment.attachmentId}/complete`, {
  method: "POST",
  headers: ownerHeaders,
  json: { ciphertextBytes: attachmentBody.byteLength, ciphertextSha256: "smoke-sha256-placeholder" }
});

await api(`/v1/rooms/${group.room.roomId}/messages`, {
  method: "POST",
  headers: ownerHeaders,
  json: {
    idempotencyKey: `group-${suffix}`,
    protocolType: "opaque-test",
    ciphertext: "encrypted-group-smoke-payload",
    attachmentIds: [attachment.attachment.attachmentId]
  }
});

const downloaded = await api(`/v1/attachments/${attachment.attachment.attachmentId}/blob`, {
  headers: userHeaders
});
if (downloaded !== "encrypted-smoke-blob") throw new Error("attachment download mismatch");

const collection = await api("/v1/sidebar-collections", {
  method: "POST",
  headers: userHeaders,
  json: { name: "Smoke collection", sortOrder: 1 }
});

await api(`/v1/sidebar-collections/${collection.collection.collectionId}/items`, {
  method: "POST",
  headers: userHeaders,
  json: { roomId: group.room.roomId, sortOrder: 1 }
});

const usage = await api("/v1/admin/usage", { headers: ownerHeaders });

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  ownerAccountId: owner.account.accountId,
  userAccountId: accepted.account.accountId,
  directRoomId: direct.room.roomId,
  groupRoomId: group.room.roomId,
  agentPrincipalId: agent.agent.principalId,
  messageId: directMessage.message.envelopeId,
  attachmentId: attachment.attachment.attachmentId,
  usage: usage.usage
}, null, 2));
