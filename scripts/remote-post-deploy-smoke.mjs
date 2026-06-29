import {
  assertAttachmentResponse,
  assertAuthResult,
  assertBootstrapResponse,
  assertCallRealtimeConfigResponse,
  assertCallResponse,
  assertCallUsageReportResponse,
  assertMessageResponse,
  assertMessagesResponse,
  assertRealtimeRoomMessageEvent,
  assertRoomResponse,
  assertSyncResponse
} from "./api-contract-assertions.mjs";

const BASE_URL = process.env.BASE_URL ?? "https://voyager-api-dev.microgentic-voyager.workers.dev";
const OWNER_EMAIL = process.env.REMOTE_SMOKE_OWNER_EMAIL ?? "ada@example.com";
const RECEIVER_EMAIL = process.env.REMOTE_SMOKE_RECEIVER_EMAIL ?? "grace@example.com";
const PASSWORD = process.env.REMOTE_SMOKE_PASSWORD ?? "voyager-demo-pass";
const KEEP_DEVICES = process.env.REMOTE_SMOKE_KEEP_DEVICES === "1";
const TIMEOUT_MS = Number(process.env.REMOTE_SMOKE_TIMEOUT_MS ?? 20_000);
const REALTIME_SMOKE_MEDIA = process.env.REALTIME_SMOKE_MEDIA === "1";

const base = BASE_URL.replace(/\/+$/, "");
const runId = `remote-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdDevices = [];
const cleanupState = {
  ownerToken: null,
  receiverToken: null,
  roomId: null,
  createdRoom: false,
  envelopeId: null,
  attachmentId: null,
  callId: null,
  receiverDeviceId: null
};

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function messagingCoreRealtimeUrl(token) {
  const url = new URL(token.connectPath, token.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token.realtimeToken);
  return url.toString();
}

async function apiRaw(path, { method = "GET", headers = {}, json, body } = {}) {
  if (json !== undefined && body !== undefined) {
    throw new Error(`apiRaw ${method} ${path} cannot send both json and body`);
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers
    },
    body: json !== undefined ? JSON.stringify(json) : body
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);
  return { response, payload };
}

async function api(path, options = {}) {
  const { response, payload } = await apiRaw(path, options);
  if (!response.ok || !payload || payload.ok === false) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function apiText(path, options = {}) {
  const { response, payload } = await apiRaw(path, options);
  if (!response.ok || typeof payload !== "string") {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function assertServerTiming(header, metrics, context) {
  for (const metric of metrics) {
    if (!header.includes(`${metric};dur=`)) {
      throw new Error(`${context} missing server timing metric ${metric}: ${header}`);
    }
  }
}

function mockSessionDescription(label) {
  return {
    type: "offer",
    sdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=${label}\r\nt=0 0\r\n`
  };
}

async function login(email, label) {
  try {
    const result = await api("/v1/auth/password/login", {
      method: "POST",
      json: {
        email,
        password: PASSWORD,
        device: {
          platform: "probe",
          label,
          clientVersion: "remote-post-deploy-smoke",
          protocolVersion: "opaque-test"
        }
      }
    });
    assertAuthResult(result, `POST /v1/auth/password/login ${email}`);
    createdDevices.push({ email, token: result.sessionToken, deviceId: result.device.deviceId });
    return result;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes("device_limit_reached")) {
      throw new Error(
        `${email} is at the active-device limit. Run npm run dev:cleanup-devices against ${base}, then retry remote smoke. Original error: ${message}`
      );
    }
    throw error;
  }
}

async function createMessagingCoreRealtimeToken(sessionToken, context) {
  const result = await api("/v1/messaging-core/realtime/token", {
    method: "POST",
    headers: auth(sessionToken)
  });
  const token = {
    baseUrl: result.messagingCore?.baseUrl,
    connectPath: result.realtime?.connectPath,
    protocol: result.realtime?.protocol,
    realtimeToken: result.realtime?.realtimeToken,
    expiresAt: result.realtime?.expiresAt
  };
  if (!token.baseUrl || !token.connectPath || !token.protocol || !token.realtimeToken) {
    throw new Error(`${context} returned incomplete Messaging Core realtime token: ${JSON.stringify(result)}`);
  }
  if (token.protocol !== "messaging.realtime.v1") {
    throw new Error(`${context} returned unexpected Messaging Core realtime protocol: ${token.protocol}`);
  }
  return token;
}

async function expectLegacyRealtimeRoutesRemoved(sessionToken) {
  const legacyToken = await apiRaw("/v1/realtime/token", {
    method: "POST",
    headers: auth(sessionToken)
  });
  if (legacyToken.response.status !== 404) {
    throw new Error(`legacy POST /v1/realtime/token expected 404 but got ${legacyToken.response.status}`);
  }
  const legacySocket = await apiRaw("/v1/realtime", {
    headers: auth(sessionToken)
  });
  if (legacySocket.response.status !== 404) {
    throw new Error(`legacy GET /v1/realtime expected 404 but got ${legacySocket.response.status}`);
  }
}

async function openRealtimeWatcher(sessionToken, expectedRoomId) {
  const realtimeToken = await createMessagingCoreRealtimeToken(sessionToken, "POST /v1/messaging-core/realtime/token remote smoke");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(messagingCoreRealtimeUrl(realtimeToken), [realtimeToken.protocol]);
    const bufferedRoomMessages = [];
    const readyTimeout = setTimeout(() => {
      socket.close(1000, "remote_smoke_timeout");
      reject(new Error("timed out waiting for realtime ready"));
    }, TIMEOUT_MS);

    socket.addEventListener("open", () => {
      // Wait for the server's ready frame before resolving the watcher.
    });
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.type === "room.message" && payload.roomId === expectedRoomId) {
        bufferedRoomMessages.push(payload);
      }
      if (payload.type === "ready") {
        clearTimeout(readyTimeout);
        resolve({
          waitForRoomMessage: (envelopeId) => waitForRoomMessage(socket, expectedRoomId, envelopeId, bufferedRoomMessages)
        });
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(readyTimeout);
      reject(new Error("realtime WebSocket failed before ready"));
    });
  });
}

async function waitForRoomMessage(socket, expectedRoomId, expectedEnvelopeId, bufferedRoomMessages) {
  const buffered = bufferedRoomMessages.find((payload) => payload.envelopeId === expectedEnvelopeId);
  if (buffered) {
    socket.close(1000, "remote_smoke_done");
    return buffered;
  }

  return new Promise((resolve, reject) => {
    const eventTimeout = setTimeout(() => {
      socket.close(1000, "remote_smoke_timeout");
      reject(new Error(`timed out waiting for remote smoke room.message ${expectedEnvelopeId}`));
    }, TIMEOUT_MS);

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.type === "room.message" && payload.roomId === expectedRoomId && payload.envelopeId === expectedEnvelopeId) {
        clearTimeout(eventTimeout);
        socket.close(1000, "remote_smoke_done");
        resolve(payload);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(eventTimeout);
      reject(new Error("realtime WebSocket errored while waiting for room.message"));
    });
  });
}

function encodeSmokePayload(senderPrincipalId) {
  const payload = {
    schema_version: 1,
    content_type: "text/plain",
    body: `Remote post-deploy smoke ${runId}`,
    reply_to_message_id: null,
    attachments: [],
    client_metadata: { sender_principal_id: senderPrincipalId, created_at: new Date().toISOString() }
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function cleanupSmokeArtifacts() {
  if (cleanupState.callId) {
    for (const token of [cleanupState.receiverToken, cleanupState.ownerToken].filter(Boolean)) {
      await api(`/v1/calls/${cleanupState.callId}/leave`, {
        method: "POST",
        headers: auth(token)
      }).catch((error) => {
        console.warn(`Could not leave remote smoke call ${cleanupState.callId}: ${error.message ?? error}`);
      });
    }
  }

  if (cleanupState.attachmentId && cleanupState.ownerToken) {
    await api(`/v1/attachments/${cleanupState.attachmentId}`, {
      method: "DELETE",
      headers: auth(cleanupState.ownerToken)
    }).catch((error) => {
      console.warn(`Could not delete remote smoke attachment ${cleanupState.attachmentId}: ${error.message ?? error}`);
    });
  }

  if (cleanupState.envelopeId && cleanupState.roomId && cleanupState.receiverToken) {
    await api(`/v1/rooms/${cleanupState.roomId}/messages/${cleanupState.envelopeId}/ack`, {
      method: "POST",
      headers: auth(cleanupState.receiverToken),
      json: { status: "stored" }
    }).catch((error) => {
      console.warn(`Could not acknowledge remote smoke message ${cleanupState.envelopeId}: ${error.message ?? error}`);
    });
  }

  if (cleanupState.createdRoom && cleanupState.roomId && cleanupState.ownerToken) {
    await api(`/v1/rooms/${cleanupState.roomId}/archive`, {
      method: "POST",
      headers: auth(cleanupState.ownerToken)
    }).catch((error) => {
      console.warn(`Could not archive remote smoke room ${cleanupState.roomId}: ${error.message ?? error}`);
    });
  }
}

async function cleanupDevices() {
  if (KEEP_DEVICES) {
    console.warn("REMOTE_SMOKE_KEEP_DEVICES=1 set; leaving temporary smoke devices active.");
    return;
  }
  for (const device of createdDevices.reverse()) {
    await api(`/v1/devices/${device.deviceId}/revoke`, {
      method: "POST",
      headers: auth(device.token),
      json: { reason: "remote_post_deploy_smoke_cleanup" }
    }).catch((error) => {
      console.warn(`Could not revoke remote smoke device ${device.deviceId} for ${device.email}: ${error.message ?? error}`);
    });
  }
}

async function cleanup() {
  await cleanupSmokeArtifacts();
  await cleanupDevices();
}

async function findDirectRoom(headers, counterpartPrincipalId) {
  const rooms = await api("/v1/rooms?limit=200", { headers });
  const room = rooms.rooms.find(
    (candidate) =>
      candidate.type === "direct" &&
      candidate.status === "active" &&
      candidate.members.some((member) => member.principalId === counterpartPrincipalId && member.status === "active")
  );
  return room ?? null;
}

async function runAttachmentMiniSmoke(roomId, ownerHeaders) {
  const originalBody = new TextEncoder().encode(`remote attachment original ${runId}`);
  const thumbnailBody = new TextEncoder().encode(`remote attachment thumbnail ${runId}`);
  const attachment = await api(`/v1/rooms/${roomId}/attachments`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      expectedBytes: originalBody.byteLength + thumbnailBody.byteLength + 32,
      contentCategory: "image",
      mediaKind: "image",
      originalFilename: `remote-smoke-${runId}.webp`,
      declaredMimeType: "image/webp",
      width: 2,
      height: 2,
      variantManifest: {
        original: { smoke: true },
        thumbnail: { smoke: true }
      }
    }
  });
  assertAttachmentResponse(attachment, "POST /v1/rooms/{roomId}/attachments remote smoke");
  const attachmentId = attachment.attachment.attachmentId;
  cleanupState.attachmentId = attachmentId;

  await api(`/v1/attachments/${attachmentId}/blob`, {
    method: "PUT",
    headers: ownerHeaders,
    body: originalBody
  });
  await api(`/v1/attachments/${attachmentId}/blob?variant=thumbnail`, {
    method: "PUT",
    headers: ownerHeaders,
    body: thumbnailBody
  });
  const completed = await api(`/v1/attachments/${attachmentId}/complete`, {
    method: "POST",
    headers: ownerHeaders,
    json: { ciphertextBytes: originalBody.byteLength }
  });
  assertAttachmentResponse(completed, "POST /v1/attachments/{attachmentId}/complete remote smoke");

  const originalDownload = await apiText(`/v1/attachments/${attachmentId}/blob`, {
    headers: ownerHeaders
  });
  if (originalDownload !== new TextDecoder().decode(originalBody)) {
    throw new Error("remote attachment original download mismatch");
  }
  const thumbnailDownload = await apiText(`/v1/attachments/${attachmentId}/blob?variant=thumbnail`, {
    headers: ownerHeaders
  });
  if (thumbnailDownload !== new TextDecoder().decode(thumbnailBody)) {
    throw new Error("remote attachment thumbnail download mismatch");
  }

  const deleted = await api(`/v1/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: ownerHeaders
  });
  if (deleted.ok !== true) {
    throw new Error("remote attachment delete did not return ok");
  }
  cleanupState.attachmentId = null;

  const deletedDownload = await apiRaw(`/v1/attachments/${attachmentId}/blob`, {
    headers: ownerHeaders
  });
  if (deletedDownload.response.status !== 404) {
    throw new Error(`remote deleted attachment download expected 404 but got ${deletedDownload.response.status}`);
  }

  return attachmentId;
}

async function runCallLifecycleMiniSmoke(roomId, ownerHeaders, receiverHeaders) {
  const created = await apiRaw(`/v1/rooms/${roomId}/calls`, {
    method: "POST",
    headers: ownerHeaders,
    json: { callType: "audio" }
  });
  if (!created.response.ok || !created.payload || created.payload.ok === false) {
    throw new Error(`POST /v1/rooms/${roomId}/calls -> ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  assertServerTiming(
    created.response.headers.get("server-timing") ?? "",
    ["callCreate"],
    "POST /v1/rooms/{roomId}/calls remote smoke"
  );
  assertCallResponse(created.payload, "POST /v1/rooms/{roomId}/calls remote smoke");
  const callId = created.payload.call.callId;
  cleanupState.callId = callId;
  if (created.payload.call.status !== "ringing" || created.payload.call.callType !== "audio") {
    throw new Error("remote smoke audio call did not start ringing");
  }

  const realtimeSession = await apiRaw(`/v1/calls/${callId}/realtime/session`, {
    method: "POST",
    headers: ownerHeaders,
    json: REALTIME_SMOKE_MEDIA ? { sessionDescription: mockSessionDescription(`${runId}-session`) } : undefined
  });
  let providerSessionId = null;
  if (realtimeSession.response.ok && realtimeSession.payload) {
    assertCallRealtimeConfigResponse(realtimeSession.payload, "POST /v1/calls/{callId}/realtime/session remote smoke");
    if (realtimeSession.payload.realtime.configured === false) {
      if (REALTIME_SMOKE_MEDIA) {
        throw new Error("REALTIME_SMOKE_MEDIA=1 requires Cloudflare Realtime to be configured");
      }
      const message = String(realtimeSession.payload.realtime.message ?? "");
      if (!/media|Realtime|WebRTC/i.test(message) || !/not configured/i.test(message)) {
        throw new Error("remote unconfigured realtime session returned unexpected message");
      }
    } else {
      providerSessionId = realtimeSession.payload.realtime.session?.sessionId ?? null;
      if (!REALTIME_SMOKE_MEDIA) {
        console.warn("Remote smoke found call media configured; set REALTIME_SMOKE_MEDIA=1 for opt-in provider media assertions.");
      }
    }
  } else if (realtimeSession.payload?.error === "realtime_provider_error") {
    if (REALTIME_SMOKE_MEDIA) {
      throw new Error(`REALTIME_SMOKE_MEDIA=1 provider session failed: ${JSON.stringify(realtimeSession.payload)}`);
    }
    console.warn("Remote smoke skipped live provider assertion after configured provider error.");
  } else {
    throw new Error(`POST /v1/calls/${callId}/realtime/session -> ${realtimeSession.response.status} ${JSON.stringify(realtimeSession.payload)}`);
  }

  if (REALTIME_SMOKE_MEDIA) {
    if (!providerSessionId) {
      throw new Error("REALTIME_SMOKE_MEDIA=1 did not receive a provider session id");
    }
    const tracks = await api(`/v1/calls/${callId}/realtime/tracks`, {
      method: "POST",
      headers: ownerHeaders,
      json: {
        sessionId: providerSessionId,
        sessionDescription: mockSessionDescription(`${runId}-tracks`),
        tracks: [{ location: "local", trackName: `${runId}-audio`, kind: "audio", mid: "audio0" }]
      }
    });
    assertCallRealtimeConfigResponse(tracks, "POST /v1/calls/{callId}/realtime/tracks remote media smoke");
    if (!tracks.realtime.tracks?.some((track) => track.trackName === `${runId}-audio`)) {
      throw new Error("remote media smoke did not publish the expected audio track");
    }
    const closedTracks = await api(`/v1/calls/${callId}/realtime/tracks/close`, {
      method: "POST",
      headers: ownerHeaders,
      json: { sessionId: providerSessionId, tracks: [{ mid: "audio0" }], force: true }
    });
    assertCallRealtimeConfigResponse(closedTracks, "POST /v1/calls/{callId}/realtime/tracks/close remote media smoke");
  }

  const joined = await api(`/v1/calls/${callId}/join`, {
    method: "POST",
    headers: receiverHeaders
  });
  assertCallResponse(joined, "POST /v1/calls/{callId}/join remote smoke");
  if (joined.call.status !== "active") {
    throw new Error("remote smoke call did not become active after receiver joined");
  }

  const muted = await api(`/v1/calls/${callId}/mute`, {
    method: "POST",
    headers: receiverHeaders
  });
  assertCallResponse(muted, "POST /v1/calls/{callId}/mute remote smoke");
  const receiverMuted = muted.call.participants.find((participant) => participant.deviceId === cleanupState.receiverDeviceId);
  if (!receiverMuted?.mutedAt) {
    throw new Error("remote smoke receiver mute did not persist mutedAt");
  }

  const unmuted = await api(`/v1/calls/${callId}/unmute`, {
    method: "POST",
    headers: receiverHeaders
  });
  assertCallResponse(unmuted, "POST /v1/calls/{callId}/unmute remote smoke");

  const usageReport = await api(`/v1/calls/${callId}/usage-report`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      ...(providerSessionId ? { sessionId: providerSessionId } : {}),
      durationMs: 15_000,
      bytesSentEstimate: 2_048,
      bytesReceivedEstimate: 4_096,
      tracks: [{ kind: "audio", direction: "send", durationMs: 15_000 }],
      network: {
        candidateType: providerSessionId ? "host" : "relay",
        relayLikely: !providerSessionId,
        roundTripTimeMs: 15,
        packetsLost: 0
      }
    }
  });
  assertCallUsageReportResponse(usageReport, "POST /v1/calls/{callId}/usage-report remote smoke");

  const receiverLeft = await api(`/v1/calls/${callId}/leave`, {
    method: "POST",
    headers: receiverHeaders
  });
  assertCallResponse(receiverLeft, "POST /v1/calls/{callId}/leave receiver remote smoke");
  if (receiverLeft.call.status !== "active") {
    throw new Error("remote smoke call ended before owner left");
  }

  const ownerLeft = await api(`/v1/calls/${callId}/leave`, {
    method: "POST",
    headers: ownerHeaders
  });
  assertCallResponse(ownerLeft, "POST /v1/calls/{callId}/leave owner remote smoke");
  if (ownerLeft.call.status !== "ended" || ownerLeft.call.endedReason !== "all_left") {
    throw new Error("remote smoke call did not end after both participants left");
  }

  const finalCall = await api(`/v1/calls/${callId}`, {
    headers: ownerHeaders
  });
  assertCallResponse(finalCall, "GET /v1/calls/{callId} remote smoke final");
  if (finalCall.call.status !== "ended") {
    throw new Error("remote smoke final call fetch was not ended");
  }
  cleanupState.callId = null;
  return callId;
}

async function main() {
  const health = await api("/health");
  if (health.status !== "healthy" || health.d1 !== "bound" || health.messagingCoreService !== "bound") {
    throw new Error(`health response is not ready: ${JSON.stringify(health)}`);
  }

  const owner = await login(OWNER_EMAIL, `Remote post-deploy smoke owner ${runId}`);
  const receiver = await login(RECEIVER_EMAIL, `Remote post-deploy smoke receiver ${runId}`);
  const ownerHeaders = auth(owner.sessionToken);
  const receiverHeaders = auth(receiver.sessionToken);
  cleanupState.ownerToken = owner.sessionToken;
  cleanupState.receiverToken = receiver.sessionToken;
  cleanupState.receiverDeviceId = receiver.device.deviceId;

  assertBootstrapResponse(await api("/v1/app/bootstrap?limit=100", { headers: ownerHeaders }), "GET /v1/app/bootstrap owner");
  assertBootstrapResponse(await api("/v1/app/bootstrap?limit=100", { headers: receiverHeaders }), "GET /v1/app/bootstrap receiver");

  await expectLegacyRealtimeRoutesRemoved(receiver.sessionToken);

  let room = await findDirectRoom(ownerHeaders, receiver.principal.principalId);
  if (!room) {
    const directRoom = await api("/v1/rooms/direct", {
      method: "POST",
      headers: ownerHeaders,
      json: { principalIds: [receiver.principal.principalId] }
    });
    assertRoomResponse(directRoom, "POST /v1/rooms/direct remote smoke");
    room = directRoom.room;
    cleanupState.createdRoom = true;
  }
  const roomId = room.roomId;
  cleanupState.roomId = roomId;

  const attachmentId = await runAttachmentMiniSmoke(roomId, ownerHeaders);
  const callId = await runCallLifecycleMiniSmoke(roomId, ownerHeaders, receiverHeaders);

  const watcher = await openRealtimeWatcher(receiver.sessionToken, roomId);
  const messageBody = {
    idempotencyKey: runId,
    protocolType: "opaque-test",
    ciphertext: encodeSmokePayload(owner.principal.principalId),
    clientCreatedAt: new Date().toISOString()
  };
  const messageResult = await apiRaw(`/v1/rooms/${roomId}/messages`, {
    method: "POST",
    headers: ownerHeaders,
    json: messageBody
  });
  if (!messageResult.response.ok || !messageResult.payload || messageResult.payload.ok === false) {
    throw new Error(`POST /v1/rooms/${roomId}/messages -> ${messageResult.response.status} ${JSON.stringify(messageResult.payload)}`);
  }
  assertServerTiming(
    messageResult.response.headers.get("server-timing") ?? "",
    ["message", "conversationDo", "conversationQueue", "conversationOperation", "realtime"],
    "POST /v1/rooms/{roomId}/messages remote smoke"
  );
  const message = messageResult.payload;
  assertMessageResponse(message, "POST /v1/rooms/{roomId}/messages remote smoke");
  cleanupState.envelopeId = message.message.envelopeId;

  const duplicate = await api(`/v1/rooms/${roomId}/messages`, {
    method: "POST",
    headers: ownerHeaders,
    json: messageBody
  });
  assertMessageResponse(duplicate, "POST /v1/rooms/{roomId}/messages remote duplicate");
  if (duplicate.message.envelopeId !== message.message.envelopeId) {
    throw new Error("remote smoke duplicate idempotency retry returned a different envelopeId");
  }
  if (duplicate.message.serverSequence !== message.message.serverSequence) {
    throw new Error("remote smoke duplicate idempotency retry returned a different serverSequence");
  }

  const realtimeEvent = await watcher.waitForRoomMessage(message.message.envelopeId);
  assertRealtimeRoomMessageEvent(realtimeEvent, "remote smoke room.message");
  if (realtimeEvent.envelopeId !== message.message.envelopeId) {
    throw new Error("remote smoke realtime event envelopeId did not match sent message");
  }
  if (realtimeEvent.serverSequence !== message.message.serverSequence) {
    throw new Error("remote smoke realtime event serverSequence did not match sent message");
  }
  if (realtimeEvent.senderDeviceId !== owner.device.deviceId) {
    throw new Error("remote smoke realtime event senderDeviceId did not match sender device");
  }

  assertRoomResponse(await api(`/v1/rooms/${roomId}`, { headers: receiverHeaders }), "GET /v1/rooms/{roomId} remote smoke");
  const messages = await api(`/v1/rooms/${roomId}/messages?after=${message.message.serverSequence - 1}`, { headers: receiverHeaders });
  assertMessagesResponse(messages, "GET /v1/rooms/{roomId}/messages remote smoke");
  if (!messages.messages.some((candidate) => candidate.envelopeId === message.message.envelopeId)) {
    throw new Error("remote smoke receiver message fetch did not include the sent message");
  }
  const sync = await api("/v1/sync?limit=100", { headers: receiverHeaders });
  assertSyncResponse(sync, "GET /v1/sync remote smoke");
  if (!sync.sync.pendingMessages.some((candidate) => candidate.envelopeId === message.message.envelopeId)) {
    throw new Error("remote smoke sync did not include the sent pending message before cleanup ack");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: base,
        runId,
        roomId,
        messageId: message.message.envelopeId,
        attachmentId,
        callId,
        realtimeEventId: realtimeEvent.eventId,
        ownerDeviceId: owner.device.deviceId,
        receiverDeviceId: receiver.device.deviceId
      },
      null,
      2
    )
  );
}

main()
  .finally(cleanup)
  .catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
