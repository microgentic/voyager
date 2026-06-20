import {
  assertAuthResult,
  assertBootstrapResponse,
  assertMessageResponse,
  assertMessagesResponse,
  assertRealtimeRoomMessageEvent,
  assertRealtimeTokenResponse,
  assertRoomResponse,
  assertSyncResponse
} from "./api-contract-assertions.mjs";

const BASE_URL = process.env.BASE_URL ?? "https://voyager-api-dev.microgentic-voyager.workers.dev";
const OWNER_EMAIL = process.env.REMOTE_SMOKE_OWNER_EMAIL ?? "ada@example.com";
const RECEIVER_EMAIL = process.env.REMOTE_SMOKE_RECEIVER_EMAIL ?? "grace@example.com";
const PASSWORD = process.env.REMOTE_SMOKE_PASSWORD ?? "voyager-demo-pass";
const KEEP_DEVICES = process.env.REMOTE_SMOKE_KEEP_DEVICES === "1";
const TIMEOUT_MS = Number(process.env.REMOTE_SMOKE_TIMEOUT_MS ?? 20_000);
const REALTIME_PROTOCOL = "voyager.realtime.v1";

const base = BASE_URL.replace(/\/+$/, "");
const runId = `remote-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdDevices = [];
const cleanupState = {
  ownerToken: null,
  receiverToken: null,
  roomId: null,
  createdRoom: false,
  envelopeId: null
};

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function realtimeUrl() {
  const url = new URL("/v1/realtime", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function api(path, { method = "GET", headers = {}, json } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(json ? { "content-type": "application/json" } : {}),
      ...headers
    },
    body: json ? JSON.stringify(json) : undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok === false) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
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

async function mintRealtimeToken(sessionToken, context) {
  const token = await api("/v1/realtime/token", {
    method: "POST",
    headers: auth(sessionToken)
  });
  assertRealtimeTokenResponse(token, context);
  return token.realtimeToken;
}

async function expectRealtimeConnectFailure(token) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(realtimeUrl(), [REALTIME_PROTOCOL, token]);
    const timeout = setTimeout(() => {
      socket.close(1000, "remote_smoke_timeout");
      reject(new Error("realtime WebSocket unexpectedly stayed pending with an invalid token"));
    }, TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close(1000, "remote_smoke_unexpected_open");
      reject(new Error("realtime WebSocket unexpectedly opened with a session token"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function openRealtimeWatcher(sessionToken, expectedRoomId) {
  const realtimeToken = await mintRealtimeToken(sessionToken, "POST /v1/realtime/token remote smoke");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(realtimeUrl(), [REALTIME_PROTOCOL, realtimeToken]);
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

async function main() {
  const health = await api("/health");
  if (health.status !== "healthy" || health.d1 !== "bound" || health.r2 !== "bound") {
    throw new Error(`health response is not ready: ${JSON.stringify(health)}`);
  }

  const owner = await login(OWNER_EMAIL, `Remote post-deploy smoke owner ${runId}`);
  const receiver = await login(RECEIVER_EMAIL, `Remote post-deploy smoke receiver ${runId}`);
  const ownerHeaders = auth(owner.sessionToken);
  const receiverHeaders = auth(receiver.sessionToken);
  cleanupState.ownerToken = owner.sessionToken;
  cleanupState.receiverToken = receiver.sessionToken;

  assertBootstrapResponse(await api("/v1/app/bootstrap?limit=100", { headers: ownerHeaders }), "GET /v1/app/bootstrap owner");
  assertBootstrapResponse(await api("/v1/app/bootstrap?limit=100", { headers: receiverHeaders }), "GET /v1/app/bootstrap receiver");

  await expectRealtimeConnectFailure(receiver.sessionToken);

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

  const watcher = await openRealtimeWatcher(receiver.sessionToken, roomId);
  const message = await api(`/v1/rooms/${roomId}/messages`, {
    method: "POST",
    headers: ownerHeaders,
    json: {
      idempotencyKey: runId,
      protocolType: "opaque-test",
      ciphertext: encodeSmokePayload(owner.principal.principalId),
      clientCreatedAt: new Date().toISOString()
    }
  });
  assertMessageResponse(message, "POST /v1/rooms/{roomId}/messages remote smoke");
  cleanupState.envelopeId = message.message.envelopeId;

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
  assertSyncResponse(await api("/v1/sync?limit=100", { headers: receiverHeaders }), "GET /v1/sync remote smoke");

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: base,
        runId,
        roomId,
        messageId: message.message.envelopeId,
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
