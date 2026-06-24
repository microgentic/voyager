const voyagerBaseUrl = trimTrailingSlash(process.env.VOYAGER_BASE_URL ?? process.env.BASE_URL ?? "");
const sessionToken = process.env.VOYAGER_SESSION_TOKEN ?? "";
const loginEmail = process.env.VOYAGER_LOGIN_EMAIL ?? "";
const loginPassword = process.env.VOYAGER_LOGIN_PASSWORD ?? "";
const fetchTimeoutMs = Number(process.env.SMOKE_FETCH_TIMEOUT_MS ?? 20_000);
const exerciseAllCoreCutover = process.env.SMOKE_MESSAGING_CORE_ALL_CUTOVER === "1";
const exerciseRoomCutover = exerciseAllCoreCutover || process.env.SMOKE_MESSAGING_CORE_ROOM_CUTOVER === "1";
const exerciseRoomWriteCutover = exerciseAllCoreCutover || process.env.SMOKE_MESSAGING_CORE_ROOM_WRITE_CUTOVER === "1";
const exerciseMessageWriteCutover = exerciseAllCoreCutover || process.env.SMOKE_MESSAGING_CORE_WRITE_CUTOVER === "1";
const exerciseSyncCutover = exerciseAllCoreCutover || process.env.SMOKE_MESSAGING_CORE_SYNC_CUTOVER === "1";
const exerciseRealtimeConnect = exerciseAllCoreCutover || process.env.SMOKE_MESSAGING_CORE_REALTIME_CONNECT === "1";
const roomWritePassword = process.env.SMOKE_MESSAGING_CORE_ROOM_WRITE_PASSWORD ?? loginPassword ?? "";
const roomWriteInviteeEmail = process.env.SMOKE_MESSAGING_CORE_ROOM_WRITE_INVITEE_EMAIL ?? "grace@example.com";
const roomWriteTransferEmail = process.env.SMOKE_MESSAGING_CORE_ROOM_WRITE_TRANSFER_EMAIL ?? "alan@example.com";
const roomWriteDeclineEmail = process.env.SMOKE_MESSAGING_CORE_ROOM_WRITE_DECLINE_EMAIL ?? "katherine@example.com";
const roomWriteDirectEmail = process.env.SMOKE_MESSAGING_CORE_ROOM_WRITE_DIRECT_EMAIL ?? "dorothy@example.com";

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

const appBootstrap = await voyagerApi("/v1/app/bootstrap?limit=20", {
  token: voyagerToken,
});
if (!appBootstrap.ok || !appBootstrap.bootstrap) {
  throw new Error(`Voyager /v1/app/bootstrap did not return a bootstrap payload: ${JSON.stringify(appBootstrap)}`);
}
const voyagerMe = await voyagerApi("/v1/me", {
  token: voyagerToken,
});
if (!voyagerMe.ok || !voyagerMe.messagingCore) {
  throw new Error(`Voyager /v1/me did not return a Messaging Core session payload: ${JSON.stringify(voyagerMe)}`);
}

const messagingCore = voyagerMe.messagingCore;
assertObject(messagingCore, "messagingCore");
if (!messagingCore.configured || !messagingCore.token || !messagingCore.baseUrl) {
  throw new Error(`Voyager Messaging Core bootstrap session is not configured: ${JSON.stringify(messagingCore)}`);
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
assertEqual(appBootstrap.bootstrap.account?.accountId, coreBootstrap.bootstrap.account?.accountId, "Voyager app bootstrap accountId");
assertEqual(voyagerMe.messagingCore.tenantId, coreBootstrap.bootstrap.tenantId, "Voyager /v1/me Messaging Core tenantId");

const coreSync = await coreApi(coreBaseUrl, "/sync?limit=20", messagingCore.token);
assertArray(coreSync.rooms, "Core /sync rooms");
assertArray(coreSync.pendingMessages, "Core /sync pendingMessages");

const coreRealtimeToken = await requestJson(`${coreBaseUrl}/realtime/token`, {
  method: "POST",
  token: messagingCore.token,
  json: {},
});
assertEqual(coreRealtimeToken.protocol, "messaging.realtime.v1", "Core realtime token protocol");
assertEqual(coreRealtimeToken.connectPath, "/realtime/connect", "Core realtime token connect path");
if (!coreRealtimeToken.realtimeToken?.startsWith("mrt_")) {
  throw new Error(`Core realtime token should use Messaging Core token format: ${JSON.stringify(coreRealtimeToken)}`);
}
const voyagerProxyRealtimeToken = await voyagerApi("/v1/messaging-core/realtime/token", {
  method: "POST",
  token: voyagerToken,
  json: {},
});
assertEqual(voyagerProxyRealtimeToken.proxied?.route, "/realtime/token", "Voyager proxy realtime token route");
assertEqual(voyagerProxyRealtimeToken.proxied?.upstreamStatus, 201, "Voyager proxy realtime token upstream status");
assertEqual(voyagerProxyRealtimeToken.realtime?.protocol, coreRealtimeToken.protocol, "Voyager proxy realtime token protocol");
assertEqual(voyagerProxyRealtimeToken.realtime?.connectPath, coreRealtimeToken.connectPath, "Voyager proxy realtime token connect path");
if (!voyagerProxyRealtimeToken.realtime?.realtimeToken?.startsWith("mrt_")) {
  throw new Error(`Voyager proxy realtime token should expose Core token format under realtime: ${JSON.stringify(voyagerProxyRealtimeToken)}`);
}
let coreRealtimeConnect = false;
if (exerciseRealtimeConnect) {
  coreRealtimeConnect = await runCoreRealtimeConnectSmoke({
    baseUrl: coreBaseUrl,
    realtime: voyagerProxyRealtimeToken.realtime,
    claims,
  });
}

const coreRooms = await coreApi(coreBaseUrl, "/rooms", messagingCore.token);
assertArray(coreRooms.rooms, "Core /rooms rooms");

let directCoreRoomDetail = false;
let normalRoomCutoverRead = false;
let normalRoomCutoverWrites = false;
let directCoreMessages = false;
let normalMessageWrite = false;
let normalSyncCutover = false;
let normalThreadInbox = false;
let normalAttachmentWrite = false;
let normalRealtimeMessage = false;
const firstRoomId = coreRooms.rooms[0]?.roomId;
if (!firstRoomId) {
  throw new Error("Core /rooms returned no rooms; populate the Core dev deployment before parity smoke.");
}
if (firstRoomId) {
  const encodedRoomId = encodeURIComponent(firstRoomId);
  const coreRoom = await coreApi(coreBaseUrl, `/rooms/${encodedRoomId}`, messagingCore.token);
  assertEqual(coreRoom.room?.roomId, firstRoomId, "Core room detail roomId");
  assertArray(coreRoom.members, "Core room detail members");
  directCoreRoomDetail = true;

  const coreMessages = await coreApi(coreBaseUrl, `/rooms/${encodedRoomId}/messages?limit=20`, messagingCore.token);
  assertArray(coreMessages.messages, "Core room messages");
  directCoreMessages = true;

  if (exerciseRoomCutover) {
    const normalRooms = await voyagerApi("/v1/rooms", {
      token: voyagerToken,
    });
    assertCoreCutoverDiagnostics(normalRooms.messagingCoreCutover, "/rooms", "normal Voyager room list cutover diagnostics");
    assertEqual(normalRooms.messagingCoreCutover?.route, "/rooms", "normal Voyager room list cutover route");
    assertEqual(normalRooms.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager room list cutover upstream status");
    assertArray(normalRooms.rooms, "normal Voyager room list cutover rooms");
    if (!normalRooms.rooms.some((room) => room.roomId === firstRoomId)) {
      throw new Error("normal Voyager room cutover list did not include the seeded Core room.");
    }
    const normalRoom = await voyagerApi(`/v1/rooms/${encodedRoomId}`, {
      token: voyagerToken,
    });
    assertCoreCutoverDiagnostics(normalRoom.messagingCoreCutover, `/rooms/${encodedRoomId}`, "normal Voyager room detail cutover diagnostics");
    assertEqual(normalRoom.messagingCoreCutover?.route, `/rooms/${encodedRoomId}`, "normal Voyager room detail cutover route");
    assertEqual(normalRoom.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager room detail cutover upstream status");
    assertEqual(normalRoom.room?.roomId, firstRoomId, "normal Voyager room detail cutover roomId");
    assertArray(normalRoom.room?.members, "normal Voyager room detail cutover members");
    normalRoomCutoverRead = true;

    if (exerciseRoomWriteCutover) {
      normalRoomCutoverWrites = await runRoomWriteCutoverSmoke({
        ownerToken: voyagerToken,
        ownerPrincipalId: claims.principalId,
      });
    }
  }

  if (exerciseSyncCutover) {
    const normalSync = await voyagerApi("/v1/sync?limit=20", {
      token: voyagerToken,
    });
    assertCoreCutoverDiagnostics(normalSync.messagingCoreCutover, "/sync?limit=20", "normal Voyager sync cutover diagnostics");
    assertArray(normalSync.sync?.rooms, "normal Voyager sync cutover rooms");
    assertArray(normalSync.sync?.pendingMessages, "normal Voyager sync cutover pendingMessages");
    if (!normalSync.sync.rooms.some((room) => room.roomId === firstRoomId)) {
      throw new Error("normal Voyager sync cutover did not include the seeded Core room.");
    }
    normalSyncCutover = true;
  }

  if (exerciseMessageWriteCutover) {
    const idempotencyKey = `messaging-core-cutover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const normalPayload = {
      idempotencyKey,
      protocolType: "opaque-test",
      ciphertext: `messaging-core-cutover-smoke-${idempotencyKey}`,
    };
    const normalSend = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages`, {
      method: "POST",
      token: voyagerToken,
      json: normalPayload,
    });
    assertCoreCutoverDiagnostics(normalSend.messagingCoreCutover, `/rooms/${encodedRoomId}/messages`, "normal Voyager message cutover diagnostics");
    assertEqual(normalSend.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/messages`, "normal Voyager message cutover route");
    assertEqual(normalSend.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager message cutover upstream status");
    if (!normalSend.message?.envelopeId) {
      throw new Error(`normal Voyager message cutover did not return a message: ${JSON.stringify(normalSend)}`);
    }
    assertEqual(normalSend.message.protocolType, "opaque-test", "normal Voyager message cutover protocol type");
    assertEqual(normalSend.message.ciphertext, `messaging-core-cutover-smoke-${idempotencyKey}`, "normal Voyager message cutover ciphertext");
    assertEqual(normalSend.message.receiptSummary?.status, "sent", "normal Voyager message cutover receipt status");
    const duplicateSend = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages`, {
      method: "POST",
      token: voyagerToken,
      json: normalPayload,
    });
    assertCoreCutoverDiagnostics(duplicateSend.messagingCoreCutover, `/rooms/${encodedRoomId}/messages`, "normal Voyager duplicate message cutover diagnostics");
    assertEqual(duplicateSend.message?.envelopeId, normalSend.message.envelopeId, "normal Voyager duplicate cutover envelopeId");
    assertEqual(duplicateSend.message?.serverSequence, normalSend.message.serverSequence, "normal Voyager duplicate cutover serverSequence");
    for (let index = 0; index < 3; index += 1) {
      const repeatedKey = `messaging-core-cutover-repeat-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
      const repeatedSend = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages`, {
        method: "POST",
        token: voyagerToken,
        json: {
          idempotencyKey: repeatedKey,
          protocolType: "opaque-test",
          ciphertext: `messaging-core-cutover-repeat-${repeatedKey}`,
        },
      });
      assertCoreCutoverDiagnostics(repeatedSend.messagingCoreCutover, `/rooms/${encodedRoomId}/messages`, `normal Voyager repeated message cutover diagnostics ${index}`);
      if (!repeatedSend.message?.envelopeId) {
        throw new Error(`normal Voyager repeated message cutover ${index} did not return a message: ${JSON.stringify(repeatedSend)}`);
      }
    }
    const listAfter = Math.max(0, Number(normalSend.message.serverSequence ?? 0) - 1);
    const normalListRoute = `/rooms/${encodedRoomId}/messages?after=${listAfter}&limit=20`;
    const normalList = await voyagerApi(`/v1${normalListRoute}`, {
      token: voyagerToken,
    });
    assertCoreCutoverDiagnostics(normalList.messagingCoreCutover, normalListRoute, "normal Voyager message list cutover diagnostics");
    assertEqual(normalList.messagingCoreCutover?.route, normalListRoute, "normal Voyager message list cutover route");
    assertEqual(normalList.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager message list cutover upstream status");
    assertArray(normalList.messages, "normal Voyager message list cutover messages");
    const listedNormalSend = normalList.messages.find((message) => message.envelopeId === normalSend.message.envelopeId);
    if (!listedNormalSend) {
      throw new Error("normal Voyager message list cutover did not include the sent Core message.");
    }
    if (listedNormalSend.receiptSummary?.status !== "sent") {
      throw new Error(`normal Voyager message list cutover dropped receipt status: ${JSON.stringify(listedNormalSend.receiptSummary)}`);
    }
    const deleteTargetKey = `messaging-core-cutover-delete-me-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const deleteTarget = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages`, {
      method: "POST",
      token: voyagerToken,
      json: {
        idempotencyKey: deleteTargetKey,
        protocolType: "opaque-test",
        ciphertext: `messaging-core-cutover-delete-me-${deleteTargetKey}`,
      },
    });
    assertCoreCutoverDiagnostics(deleteTarget.messagingCoreCutover, `/rooms/${encodedRoomId}/messages`, "normal Voyager delete-for-me target send diagnostics");
    const deleteTargetId = deleteTarget.message?.envelopeId;
    if (!deleteTargetId) {
      throw new Error(`normal Voyager delete-for-me target did not return a message: ${JSON.stringify(deleteTarget)}`);
    }
    const deleteForMe = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages/delete`, {
      method: "POST",
      token: voyagerToken,
      json: { scope: "me", envelopeIds: [deleteTargetId] },
    });
    assertCoreCutoverDiagnostics(deleteForMe.messagingCoreCutover, `/rooms/${encodedRoomId}/messages/delete`, "normal Voyager delete-for-me cutover diagnostics");
    assertEqual(deleteForMe.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager delete-for-me upstream status");
    const deleteListAfter = Math.max(0, Number(deleteTarget.message.serverSequence ?? 0) - 1);
    const deleteListRoute = `/rooms/${encodedRoomId}/messages?after=${deleteListAfter}&limit=20`;
    const afterDeleteForMe = await voyagerApi(`/v1${deleteListRoute}`, { token: voyagerToken });
    assertCoreCutoverDiagnostics(afterDeleteForMe.messagingCoreCutover, deleteListRoute, "normal Voyager delete-for-me list diagnostics");
    assertArray(afterDeleteForMe.messages, "normal Voyager delete-for-me list messages");
    if (afterDeleteForMe.messages.some((message) => message.envelopeId === deleteTargetId)) {
      throw new Error("normal Voyager delete-for-me cutover did not hide the message for the deleting account.");
    }
    normalMessageWrite = true;
    normalThreadInbox = await runThreadInboxCutoverSmoke({
      token: voyagerToken,
      encodedRoomId,
      rootEnvelopeId: normalSend.message.envelopeId,
    });

    normalAttachmentWrite = await runAttachmentMessageWriteCutoverSmoke({
      token: voyagerToken,
      roomId: firstRoomId,
      encodedRoomId,
    });

    if (exerciseRealtimeConnect) {
      normalRealtimeMessage = await runCoreRealtimeMessageDeliverySmoke({
        baseUrl: coreBaseUrl,
        token: voyagerToken,
        encodedRoomId,
        claims,
      });
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  voyagerBaseUrl,
  messagingCoreBaseUrl: coreBaseUrl,
  tenantId: claims.tenantId,
  accountId: claims.accountId,
  principalId: claims.principalId,
  deviceId: claims.deviceId,
  appBootstrap: true,
  meMessagingCore: true,
  directCoreBootstrap: true,
  directCoreSync: true,
  coreRealtimeToken: true,
  voyagerRealtimeTokenFacade: true,
  coreRealtimeConnect,
  directCoreRooms: true,
  directCoreRoomDetail,
  normalRoomCutoverRead,
  normalRoomCutoverWrites,
  directCoreMessages,
  normalMessageWrite,
  normalSyncCutover,
  normalThreadInbox,
  normalAttachmentWrite,
  normalRealtimeMessage,
}, null, 2));

async function runThreadInboxCutoverSmoke({ token, encodedRoomId, rootEnvelopeId }) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const encodedRootEnvelopeId = encodeURIComponent(rootEnvelopeId);
  const reply = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, {
    method: "POST",
    token,
    json: {
      idempotencyKey: `messaging-core-thread-cutover-${suffix}`,
      protocolType: "opaque-test",
      ciphertext: `messaging-core-thread-reply-${suffix}`,
    },
  });
  assertCoreCutoverDiagnostics(reply.messagingCoreCutover, `/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, "normal Voyager thread reply cutover diagnostics");
  assertEqual(reply.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, "normal Voyager thread reply cutover route");
  assertEqual(reply.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager thread reply cutover upstream status");
  assertEqual(reply.message?.threadRootEnvelopeId, rootEnvelopeId, "normal Voyager thread reply root");
  assertEqual(reply.message?.alsoSentToRoom, false, "normal Voyager thread-only reply flag");
  const threadOnlyListAfter = Math.max(0, Number(reply.message.serverSequence ?? 0) - 1);
  const threadOnlyListRoute = `/rooms/${encodedRoomId}/messages?after=${threadOnlyListAfter}&limit=20`;
  const threadOnlyRoomList = await voyagerApi(`/v1${threadOnlyListRoute}`, { token });
  assertCoreCutoverDiagnostics(threadOnlyRoomList.messagingCoreCutover, threadOnlyListRoute, "normal Voyager thread-only room list diagnostics");
  assertArray(threadOnlyRoomList.messages, "normal Voyager thread-only room list messages");
  if (threadOnlyRoomList.messages.some((candidate) => candidate.envelopeId === reply.message.envelopeId)) {
    throw new Error("normal Voyager room list included a thread-only reply.");
  }

  const broadcastReply = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, {
    method: "POST",
    token,
    json: {
      idempotencyKey: `messaging-core-thread-cutover-broadcast-${suffix}`,
      protocolType: "opaque-test",
      ciphertext: `messaging-core-thread-broadcast-reply-${suffix}`,
      alsoSendToRoom: true,
    },
  });
  assertCoreCutoverDiagnostics(
    broadcastReply.messagingCoreCutover,
    `/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`,
    "normal Voyager thread broadcast reply cutover diagnostics"
  );
  assertEqual(broadcastReply.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, "normal Voyager thread broadcast reply cutover route");
  assertEqual(broadcastReply.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager thread broadcast reply cutover upstream status");
  assertEqual(broadcastReply.message?.threadRootEnvelopeId, rootEnvelopeId, "normal Voyager thread broadcast reply root");
  assertEqual(broadcastReply.message?.alsoSentToRoom, true, "normal Voyager thread broadcast reply flag");

  const thread = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, { token });
  assertCoreCutoverDiagnostics(thread.messagingCoreCutover, `/rooms/${encodedRoomId}/messages/${encodedRootEnvelopeId}/thread`, "normal Voyager thread read cutover diagnostics");
  assertArray(thread.thread?.replies, "normal Voyager thread read cutover replies");
  if (!thread.thread.replies.some((candidate) => candidate.envelopeId === reply.message.envelopeId)) {
    throw new Error("normal Voyager thread read did not include the thread-only reply.");
  }
  if (!thread.thread.replies.some((candidate) => candidate.envelopeId === broadcastReply.message.envelopeId && candidate.alsoSentToRoom === true)) {
    throw new Error("normal Voyager thread read did not include the also-send reply with its flag.");
  }

  const listAfter = Math.max(0, Number(broadcastReply.message.serverSequence ?? 0) - 1);
  const listRoute = `/rooms/${encodedRoomId}/messages?after=${listAfter}&limit=20`;
  const roomList = await voyagerApi(`/v1${listRoute}`, { token });
  assertCoreCutoverDiagnostics(roomList.messagingCoreCutover, listRoute, "normal Voyager thread broadcast room list diagnostics");
  assertArray(roomList.messages, "normal Voyager thread broadcast room list messages");
  if (!roomList.messages.some((candidate) => candidate.envelopeId === broadcastReply.message.envelopeId && candidate.alsoSentToRoom === true)) {
    throw new Error("normal Voyager room list did not include the also-send thread reply.");
  }

  const inbox = await voyagerApi("/v1/threads?limit=20", { token });
  assertCoreCutoverDiagnostics(inbox.messagingCoreCutover, "/threads?limit=20", "normal Voyager thread inbox cutover diagnostics");
  assertEqual(inbox.messagingCoreCutover?.route, "/threads?limit=20", "normal Voyager thread inbox cutover route");
  assertEqual(inbox.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager thread inbox cutover upstream status");
  assertArray(inbox.items, "normal Voyager thread inbox cutover items");
  const item = inbox.items.find((candidate) => candidate.root?.envelopeId === rootEnvelopeId);
  if (!item) {
    throw new Error(`normal Voyager thread inbox did not include the cutover thread root: ${JSON.stringify(inbox.items)}`);
  }
  assertEqual(item.room?.roomId, decodeURIComponent(encodedRoomId), "normal Voyager thread inbox room id");
  assertEqual(item.root?.envelopeId, rootEnvelopeId, "normal Voyager thread inbox root id");
  assertEqual(typeof item.following, "boolean", "normal Voyager thread inbox following flag");
  assertEqual(typeof item.muted, "boolean", "normal Voyager thread inbox muted flag");
  assertEqual(typeof item.unreadCount, "number", "normal Voyager thread inbox unread count");
  assertEqual(typeof item.lastReadSequence, "number", "normal Voyager thread inbox last-read sequence");
  assertEqual(typeof item.updatedAt, "string", "normal Voyager thread inbox updatedAt");
  return true;
}

async function runAttachmentMessageWriteCutoverSmoke({ token, roomId, encodedRoomId }) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.from(`messaging-core-cutover-attachment-${suffix}`, "utf8");
  const allocated = await voyagerApi(`/v1/rooms/${encodedRoomId}/attachments`, {
    method: "POST",
    token,
    json: {
      expectedBytes: body.byteLength,
      contentCategory: "audio/ogg",
      retentionClass: "standard",
      originalFilename: `core-cutover-${suffix}.ogg`,
      declaredMimeType: "audio/ogg",
      mediaKind: "audio",
      durationMs: 1234,
      variantManifest: { smoke: "messaging-core-cutover" },
    },
  });
  assertCoreCutoverDiagnostics(allocated.messagingCoreCutover, `/rooms/${encodedRoomId}/attachments`, "normal Voyager attachment allocate cutover diagnostics");
  assertEqual(allocated.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/attachments`, "normal Voyager attachment allocate cutover route");
  assertEqual(allocated.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager attachment allocate cutover upstream status");
  assertEqual(allocated.attachment?.roomId, roomId, "normal Voyager attachment allocate roomId");
  assertEqual(allocated.attachment?.state, "allocated", "normal Voyager attachment allocate state");
  assertEqual(allocated.attachment?.mediaKind, "audio", "normal Voyager attachment allocate media kind");
  const attachmentId = allocated.attachment?.attachmentId;
  if (!attachmentId) {
    throw new Error(`normal Voyager attachment allocate did not return attachmentId: ${JSON.stringify(allocated)}`);
  }

  const encodedAttachmentId = encodeURIComponent(attachmentId);
  const uploaded = await voyagerApi(`/v1/attachments/${encodedAttachmentId}/blob?variant=original`, {
    method: "PUT",
    token,
    headers: { "content-type": "audio/ogg" },
    body,
  });
  assertCoreCutoverDiagnostics(uploaded.messagingCoreCutover, `/attachments/${encodedAttachmentId}/blob?variant=original`, "normal Voyager attachment upload cutover diagnostics");
  assertEqual(uploaded.messagingCoreCutover?.route, `/attachments/${encodedAttachmentId}/blob?variant=original`, "normal Voyager attachment upload cutover route");
  assertEqual(uploaded.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager attachment upload cutover upstream status");
  assertEqual(uploaded.attachment?.state, "uploaded", "normal Voyager attachment upload state");

  const completed = await voyagerApi(`/v1/attachments/${encodedAttachmentId}/complete`, {
    method: "POST",
    token,
    json: {
      ciphertextSha256: "sha256-smoke-placeholder",
      mediaKind: "audio",
      durationMs: 1234,
      variantManifest: { smoke: "messaging-core-cutover", completed: true },
    },
  });
  assertCoreCutoverDiagnostics(completed.messagingCoreCutover, `/attachments/${encodedAttachmentId}/complete`, "normal Voyager attachment complete cutover diagnostics");
  assertEqual(completed.messagingCoreCutover?.route, `/attachments/${encodedAttachmentId}/complete`, "normal Voyager attachment complete cutover route");
  assertEqual(completed.messagingCoreCutover?.upstreamStatus, 200, "normal Voyager attachment complete upstream status");
  assertEqual(completed.attachment?.state, "uploaded", "normal Voyager attachment complete compatibility state");
  assertEqual(completed.attachment?.variants?.original?.bytes, body.byteLength, "normal Voyager attachment complete original bytes");

  const idempotencyKey = `messaging-core-cutover-attachment-${suffix}`;
  const sent = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages`, {
    method: "POST",
    token,
    json: {
      idempotencyKey,
      protocolType: "opaque-test",
      ciphertext: `messaging-core-cutover-attachment-message-${suffix}`,
      attachmentIds: [attachmentId],
    },
  });
  assertCoreCutoverDiagnostics(sent.messagingCoreCutover, `/rooms/${encodedRoomId}/messages`, "normal Voyager attachment message cutover diagnostics");
  assertEqual(sent.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/messages`, "normal Voyager attachment message cutover route");
  assertEqual(sent.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager attachment message cutover upstream status");
  if (!sent.message?.envelopeId) {
    throw new Error(`normal Voyager attachment message did not return a message: ${JSON.stringify(sent)}`);
  }

  const listAfter = Math.max(0, Number(sent.message.serverSequence ?? 0) - 1);
  const listRoute = `/rooms/${encodedRoomId}/messages?after=${listAfter}&limit=20`;
  const listed = await voyagerApi(`/v1${listRoute}`, { token });
  assertCoreCutoverDiagnostics(listed.messagingCoreCutover, listRoute, "normal Voyager attachment message list cutover diagnostics");
  if (!listed.messages.some((message) => message.envelopeId === sent.message.envelopeId)) {
    throw new Error("normal Voyager attachment message list did not include the sent Core message.");
  }

  const downloaded = await requestBinary(`${voyagerBaseUrl}/v1/attachments/${encodedAttachmentId}/blob?variant=original`, {
    token,
  });
  assertEqual(downloaded.response.headers.get("x-attachment-id"), attachmentId, "normal Voyager attachment download id header");
  assertEqual(downloaded.response.headers.get("x-attachment-variant"), "original", "normal Voyager attachment download variant header");
  assertEqual(downloaded.buffer.toString("utf8"), body.toString("utf8"), "normal Voyager attachment download body");

  return true;
}

async function runCoreRealtimeConnectSmoke({ baseUrl, realtime, claims }) {
  if (typeof WebSocket === "undefined") {
    throw new Error("This Node runtime does not expose WebSocket; cannot run Messaging Core realtime connect smoke.");
  }
  const url = new URL(realtime.connectPath, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", realtime.realtimeToken);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [realtime.protocol]);
    const pingId = `core-realtime-smoke-${Date.now()}`;
    let ready = false;
    let pong = false;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("timed out waiting for Messaging Core realtime ready/pong"));
    }, fetchTimeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1000, "smoke_done");
      resolve(true);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1011, "smoke_failed");
      reject(error);
    }

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "ping", id: pingId }));
    };
    socket.onerror = () => {
      fail(new Error("Messaging Core realtime WebSocket errored before ready/pong"));
    };
    socket.onclose = () => {
      if (!settled && (!ready || !pong)) {
        fail(new Error("Messaging Core realtime WebSocket closed before ready/pong"));
      }
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") {
          assertEqual(message.tenantId, claims.tenantId, "Core realtime ready tenantId");
          assertEqual(message.accountId, claims.accountId, "Core realtime ready accountId");
          assertEqual(message.principalId, claims.principalId, "Core realtime ready principalId");
          assertEqual(message.deviceId, claims.deviceId, "Core realtime ready deviceId");
          assertEqual(message.protocol, realtime.protocol, "Core realtime ready protocol");
          ready = true;
        }
        if (message.type === "pong") {
          assertEqual(message.id, pingId, "Core realtime pong id");
          pong = true;
        }
        if (ready && pong) finish();
      } catch (error) {
        fail(error);
      }
    };
  });
}

async function runCoreRealtimeMessageDeliverySmoke({ baseUrl, token, encodedRoomId, claims }) {
  if (typeof WebSocket === "undefined") {
    throw new Error("This Node runtime does not expose WebSocket; cannot run Messaging Core realtime message delivery smoke.");
  }
  const realtimeResponse = await voyagerApi("/v1/messaging-core/realtime/token", {
    method: "POST",
    token,
    json: {},
  });
  assertEqual(realtimeResponse.realtime?.protocol, "messaging.realtime.v1", "Core realtime message smoke protocol");
  const realtime = realtimeResponse.realtime;
  const url = new URL(realtime.connectPath, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", realtime.realtimeToken);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [realtime.protocol]);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const roomMessageEvents = [];
    let sentMessage = null;
    let sendStarted = false;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("timed out waiting for Messaging Core realtime room.message delivery"));
    }, fetchTimeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1000, "smoke_done");
      resolve(true);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1011, "smoke_failed");
      reject(error);
    }

    function checkDelivery() {
      if (!sentMessage) return;
      const delivery = roomMessageEvents.find((event) => event.envelopeId === sentMessage.envelopeId);
      if (!delivery) return;
      assertEqual(delivery.tenantId, claims.tenantId, "Core realtime room.message tenantId");
      assertEqual(delivery.roomId, decodeURIComponent(encodedRoomId), "Core realtime room.message roomId");
      assertEqual(delivery.serverSequence, sentMessage.serverSequence, "Core realtime room.message serverSequence");
      assertEqual(delivery.senderPrincipalId, claims.principalId, "Core realtime room.message senderPrincipalId");
      assertEqual(delivery.senderDeviceId, claims.deviceId, "Core realtime room.message senderDeviceId");
      finish();
    }

    async function sendMessage() {
      if (sendStarted) return;
      sendStarted = true;
      try {
        const idempotencyKey = `messaging-core-realtime-cutover-${suffix}`;
        const sent = await voyagerApi(`/v1/rooms/${encodedRoomId}/messages`, {
          method: "POST",
          token,
          json: {
            idempotencyKey,
            protocolType: "opaque-test",
            ciphertext: `messaging-core-realtime-cutover-${suffix}`,
          },
        });
        assertCoreCutoverDiagnostics(sent.messagingCoreCutover, `/rooms/${encodedRoomId}/messages`, "normal Voyager realtime message cutover diagnostics");
        if (!sent.message?.envelopeId) {
          throw new Error(`normal Voyager realtime message cutover did not return a message: ${JSON.stringify(sent)}`);
        }
        sentMessage = sent.message;
        checkDelivery();
      } catch (error) {
        fail(error);
      }
    }

    socket.onopen = () => {};
    socket.onerror = () => {
      fail(new Error("Messaging Core realtime WebSocket errored before room.message delivery"));
    };
    socket.onclose = () => {
      if (!settled) {
        fail(new Error("Messaging Core realtime WebSocket closed before room.message delivery"));
      }
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") {
          assertEqual(message.tenantId, claims.tenantId, "Core realtime message smoke ready tenantId");
          assertEqual(message.accountId, claims.accountId, "Core realtime message smoke ready accountId");
          assertEqual(message.principalId, claims.principalId, "Core realtime message smoke ready principalId");
          assertEqual(message.deviceId, claims.deviceId, "Core realtime message smoke ready deviceId");
          void sendMessage();
        }
        if (message.type === "room.message") {
          roomMessageEvents.push(message);
          checkDelivery();
        }
      } catch (error) {
        fail(error);
      }
    };
  });
}

async function runRoomWriteCutoverSmoke({ ownerToken, ownerPrincipalId }) {
  if (!roomWritePassword) {
    throw new Error("Set VOYAGER_LOGIN_PASSWORD or SMOKE_MESSAGING_CORE_ROOM_WRITE_PASSWORD for room write cutover smoke.");
  }
  const invitee = await loginSmokeAccount(roomWriteInviteeEmail, "Messaging Core room write invitee");
  const transferTarget = await loginSmokeAccount(roomWriteTransferEmail, "Messaging Core room write transfer target");
  const declineTarget = await loginSmokeAccount(roomWriteDeclineEmail, "Messaging Core room write decline target");
  const directTarget = await loginSmokeAccount(roomWriteDirectEmail, "Messaging Core room write direct target");
  const principals = await voyagerApi("/v1/principals", { token: ownerToken });
  const agent = principals.principals?.find((principal) => principal.principalType === "agent");
  if (!agent?.principalId) {
    throw new Error("Room write cutover smoke requires an active agent principal from the seeded Voyager graph.");
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const directRoom = await voyagerApi("/v1/rooms/direct", {
    method: "POST",
    token: ownerToken,
    json: {
      principalIds: [directTarget.principal.principalId],
      name: `Core cutover direct ${suffix}`,
      description: "Direct room created through Messaging Core room write cutover",
    },
  });
  assertEqual(directRoom.messagingCoreCutover?.route, "/rooms/direct", "normal Voyager direct room cutover route");
  assertEqual(directRoom.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager direct room cutover upstream status");
  assertEqual(directRoom.room?.type, "direct", "normal Voyager direct room cutover type");

  const group = await voyagerApi("/v1/rooms/groups", {
    method: "POST",
    token: ownerToken,
    json: {
      name: `Core cutover group ${suffix}`,
      description: "Group created through Messaging Core room write cutover",
    },
  });
  assertEqual(group.messagingCoreCutover?.route, "/rooms/groups", "normal Voyager group create cutover route");
  assertEqual(group.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager group create cutover upstream status");
  assertEqual(group.room?.name, `Core cutover group ${suffix}`, "normal Voyager group create cutover name");
  const roomId = group.room.roomId;
  const encodedRoomId = encodeURIComponent(roomId);

  const patched = await voyagerApi(`/v1/rooms/${encodedRoomId}`, {
    method: "PATCH",
    token: ownerToken,
    json: {
      name: `Core cutover group updated ${suffix}`,
      description: "Updated through Messaging Core room write cutover",
    },
  });
  assertEqual(patched.messagingCoreCutover?.route, `/rooms/${encodedRoomId}`, "normal Voyager room patch cutover route");
  assertEqual(patched.room?.name, `Core cutover group updated ${suffix}`, "normal Voyager room patch cutover name");
  assertEqual(patched.room?.description, "Updated through Messaging Core room write cutover", "normal Voyager room patch cutover description");

  await expectFailure(`/v1/rooms/${encodedRoomId}/members`, {
    method: "POST",
    token: ownerToken,
    json: { principalId: invitee.principal.principalId },
  }, 400, "human_invitation_required");

  const agentMember = await voyagerApi(`/v1/rooms/${encodedRoomId}/members`, {
    method: "POST",
    token: ownerToken,
    json: { principalId: agent.principalId, role: "admin" },
  });
  assertEqual(agentMember.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/members`, "normal Voyager agent member cutover route");
  assertEqual(agentMember.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager agent member cutover upstream status");
  assertEqual(agentMember.member?.role, "agent", "normal Voyager agent member cutover role");

  await expectFailure(`/v1/rooms/${encodedRoomId}/invitations`, {
    method: "POST",
    token: ownerToken,
    json: { principalId: agent.principalId },
  }, 400, "agent_invitation_not_supported");

  const inviteeInvitation = await voyagerApi(`/v1/rooms/${encodedRoomId}/invitations`, {
    method: "POST",
    token: ownerToken,
    json: { principalId: invitee.principal.principalId, role: "member", expiresInDays: 3 },
  });
  assertEqual(inviteeInvitation.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/invitations`, "normal Voyager invitation create cutover route");
  assertEqual(inviteeInvitation.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager invitation create cutover upstream status");
  assertEqual(inviteeInvitation.invitation?.status, "pending", "normal Voyager invitation create cutover status");

  const inviteeInbox = await voyagerApi("/v1/room-invitations", { token: invitee.token });
  assertEqual(inviteeInbox.messagingCoreCutover?.route, "/room-invitations", "normal Voyager invitation inbox cutover route");
  if (!inviteeInbox.invitations.some((invitation) => invitation.roomInvitationId === inviteeInvitation.invitation.roomInvitationId)) {
    throw new Error("normal Voyager room write cutover invitee inbox did not include pending invitation.");
  }

  const acceptedInvitation = await voyagerApi(`/v1/room-invitations/${encodeURIComponent(inviteeInvitation.invitation.roomInvitationId)}/accept`, {
    method: "POST",
    token: invitee.token,
  });
  assertEqual(acceptedInvitation.messagingCoreCutover?.route, `/room-invitations/${encodeURIComponent(inviteeInvitation.invitation.roomInvitationId)}/accept`, "normal Voyager invitation accept cutover route");
  assertEqual(acceptedInvitation.invitation?.status, "accepted", "normal Voyager invitation accept cutover status");

  const transferInvitation = await voyagerApi(`/v1/rooms/${encodedRoomId}/invitations`, {
    method: "POST",
    token: ownerToken,
    json: { principalId: transferTarget.principal.principalId, role: "member", expiresInDays: 3 },
  });
  await voyagerApi(`/v1/room-invitations/${encodeURIComponent(transferInvitation.invitation.roomInvitationId)}/accept`, {
    method: "POST",
    token: transferTarget.token,
  });

  const declineInvitation = await voyagerApi(`/v1/rooms/${encodedRoomId}/invitations`, {
    method: "POST",
    token: ownerToken,
    json: { principalId: declineTarget.principal.principalId, role: "member", expiresInDays: 3 },
  });
  const declined = await voyagerApi(`/v1/room-invitations/${encodeURIComponent(declineInvitation.invitation.roomInvitationId)}/decline`, {
    method: "POST",
    token: declineTarget.token,
  });
  assertEqual(declined.invitation?.status, "declined", "normal Voyager invitation decline cutover status");

  const promoted = await voyagerApi(`/v1/rooms/${encodedRoomId}/members/${encodeURIComponent(invitee.principal.principalId)}/role`, {
    method: "PATCH",
    token: ownerToken,
    json: { role: "admin" },
  });
  assertEqual(promoted.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/members/${encodeURIComponent(invitee.principal.principalId)}/role`, "normal Voyager member role cutover route");
  assertEqual(promoted.member?.role, "admin", "normal Voyager member role cutover role");

  await expectFailure(`/v1/rooms/${encodedRoomId}/members/${encodeURIComponent(invitee.principal.principalId)}/role`, {
    method: "PATCH",
    token: ownerToken,
    json: { role: "agent" },
  }, 400, "invalid_room_role");

  await expectFailure(`/v1/rooms/${encodedRoomId}/ownership-transfers`, {
    method: "POST",
    token: ownerToken,
    json: { toPrincipalId: agent.principalId },
  }, 400, "invalid_owner_target");

  const transfer = await voyagerApi(`/v1/rooms/${encodedRoomId}/ownership-transfers`, {
    method: "POST",
    token: ownerToken,
    json: { toPrincipalId: transferTarget.principal.principalId },
  });
  assertEqual(transfer.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/ownership-transfers`, "normal Voyager ownership transfer cutover route");
  assertEqual(transfer.messagingCoreCutover?.upstreamStatus, 201, "normal Voyager ownership transfer cutover upstream status");
  assertEqual(transfer.transfer?.status, "proposed", "normal Voyager ownership transfer proposed status");

  const acceptedTransfer = await voyagerApi(`/v1/rooms/${encodedRoomId}/ownership-transfers/${encodeURIComponent(transfer.transfer.transferId)}/accept`, {
    method: "POST",
    token: transferTarget.token,
  });
  assertEqual(acceptedTransfer.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/ownership-transfers/${encodeURIComponent(transfer.transfer.transferId)}/accept`, "normal Voyager ownership transfer accept cutover route");
  assertEqual(acceptedTransfer.transfer?.status, "completed", "normal Voyager ownership transfer completed status");

  const removed = await voyagerApi(`/v1/rooms/${encodedRoomId}/members/${encodeURIComponent(invitee.principal.principalId)}`, {
    method: "DELETE",
    token: transferTarget.token,
  });
  assertEqual(removed.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/members/${encodeURIComponent(invitee.principal.principalId)}`, "normal Voyager member remove cutover route");
  assertEqual(removed.ok, true, "normal Voyager member remove cutover ok");

  const ownerLeft = await voyagerApi(`/v1/rooms/${encodedRoomId}/leave`, {
    method: "POST",
    token: ownerToken,
  });
  assertEqual(ownerLeft.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/leave`, "normal Voyager member leave cutover route");
  assertEqual(ownerLeft.ok, true, "normal Voyager member leave cutover ok");

  const afterLeave = await voyagerApi(`/v1/rooms/${encodedRoomId}`, { token: transferTarget.token });
  const ownerMembership = afterLeave.room.members.find((member) => member.principalId === ownerPrincipalId);
  if (!ownerMembership || ownerMembership.status !== "leaving") {
    throw new Error(`normal Voyager member leave cutover did not expose leaving status: ${JSON.stringify(ownerMembership)}`);
  }
  const removedMembership = afterLeave.room.members.find((member) => member.principalId === invitee.principal.principalId);
  if (!removedMembership || removedMembership.status !== "removed") {
    throw new Error(`normal Voyager member remove cutover did not expose removed status: ${JSON.stringify(removedMembership)}`);
  }

  const archived = await voyagerApi(`/v1/rooms/${encodedRoomId}/archive`, {
    method: "POST",
    token: transferTarget.token,
  });
  assertEqual(archived.messagingCoreCutover?.route, `/rooms/${encodedRoomId}/archive`, "normal Voyager archive cutover route");
  assertEqual(archived.room?.status, "archived", "normal Voyager archive cutover status");
  return true;
}

async function loginSmokeAccount(email, label) {
  const result = await voyagerApi("/v1/auth/password/login", {
    method: "POST",
    auth: false,
    json: {
      email,
      password: roomWritePassword,
      device: {
        platform: "smoke",
        label,
      },
    },
  });
  if (!result.sessionToken || !result.principal?.principalId) {
    throw new Error(`Room write cutover smoke login failed for ${email}: ${JSON.stringify(result)}`);
  }
  return {
    token: result.sessionToken,
    account: result.account,
    principal: result.principal,
    device: result.device,
  };
}

async function voyagerApi(path, options = {}) {
  return requestJson(`${voyagerBaseUrl}${path}`, options);
}

async function coreApi(baseUrl, path, token) {
  return requestJson(`${baseUrl}${path}`, { token });
}

async function requestJson(url, options = {}) {
  const { response, payload, text } = await requestRaw(url, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed ${response.status}: ${text}`);
  }
  return payload;
}

async function expectFailure(path, options, expectedStatus, expectedError) {
  const { response, payload, text } = await requestRaw(`${voyagerBaseUrl}${path}`, options);
  if (response.status !== expectedStatus) {
    throw new Error(`${options.method ?? "GET"} ${path} expected ${expectedStatus} but got ${response.status}: ${text}`);
  }
  if (expectedError && payload?.error !== expectedError) {
    throw new Error(`${options.method ?? "GET"} ${path} expected error ${expectedError} but got ${payload?.error}: ${text}`);
  }
  return payload;
}

async function requestRaw(url, options = {}) {
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
  return { response, payload, text };
}

async function requestBinary(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const fetchOptions = { ...options };
  delete fetchOptions.auth;
  delete fetchOptions.token;
  if (options.auth !== false) {
    headers.set("authorization", `Bearer ${options.token ?? ""}`);
  }
  const response = await fetch(url, {
    ...fetchOptions,
    headers,
    signal: fetchOptions.signal ?? AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed ${response.status}: ${await response.text()}`);
  }
  return { response, buffer: Buffer.from(await response.arrayBuffer()) };
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

function assertArray(value, context) {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }
}

function assertCoreCutoverDiagnostics(value, expectedRoute, context) {
  assertObject(value, context);
  assertEqual(value.source, "core", `${context} source`);
  assertEqual(value.fallbackReason ?? null, null, `${context} fallbackReason`);
  assertEqual(value.route, expectedRoute, `${context} route`);
  assertEqual(typeof value.upstreamStatus, "number", `${context} upstreamStatus type`);
  assertObject(value.flags, `${context} flags`);
  assertEqual(typeof value.flags.mode, "string", `${context} mode flag type`);
  assertEqual(value.flags.allCoreMessaging || value.flags.roomRoutes || value.flags.messageRoutes || value.flags.syncRoute, true, `${context} enabled flag`);
}

function assertEqual(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context} expected ${expected} but got ${actual}`);
  }
}
