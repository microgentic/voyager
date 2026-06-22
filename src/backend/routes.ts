import { audit, requireAdmin } from "../db";
import { randomId } from "../crypto";
import { HttpError, json, readJsonObject, readOptionalJsonObject, requireMethod, routeParams, stringField } from "../http";
import type { AuthContext, Env } from "../types";
import {
  callMutationTimingHeaders,
  requireCallCoordinatorResult,
  runCallMutationThroughCallCoordinator,
} from "./call-coordinator";
import {
  requireCoordinatorResult,
  runMutationThroughConversationCoordinator,
  sendMessageThroughConversationCoordinator,
} from "./conversation-coordinator";
import type { RouteResult } from "./internal-types";
import {
  acknowledgeMessage,
  allocateAttachment,
  appBootstrap,
  capitalize,
  completeAttachment,
  createAgentPrincipal,
  createAgentRequest,
  createDirectRoom,
  createGroupRoom,
  createSidebarCollection,
  deleteAttachment,
  deleteMessagesForMe,
  deleteSidebarCollection,
  deleteSidebarCollectionItem,
  downloadAttachmentBlob,
  getRoomForMember,
  getPublicCall,
  getRealtimeSessionConfig,
  getRealtimeTrackConfig,
  getRoomIdForPendingRoomInvitation,
  getThread,
  listAdminAgentRequests,
  listAdminRooms,
  listAvailableKeyPackages,
  listMaintenanceRuns,
  listOwnAgentRequests,
  listOwnDeviceKeyPackages,
  listPrincipalDevices,
  listRoomCalls,
  listPrincipals,
  listRoomInvitations,
  listRoomMessages,
  listRooms,
  listSidebarCollections,
  listThreads,
  mutationTimingHeaders,
  parseAttachmentVariant,
  publishKeyPackage,
  readTimingHeaders,
  resolveForwardSource,
  reviewAgentRequest,
  revokeKeyPackage,
  claimKeyPackage,
  sendMessageTimingHeaders,
  syncAccount,
  updateSidebarCollection,
  uploadAttachmentBlob,
  addSidebarCollectionItem,
  closeRealtimeTracks,
  recordCallUsageReport,
  runCleanup,
  markThreadRead,
  renegotiateRealtimeSession,
  updateThreadSubscription,
} from "./operations";

export async function handleBackendFirstRoutes(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  auth: AuthContext,
  authTimingMs = 0,
): Promise<RouteResult> {
  if (url.pathname === "/v1/principals") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, principals: await listPrincipals(env) },
      { headers: readTimingHeaders("principals", authTimingMs, startedAt) },
    );
  }

  if (url.pathname === "/v1/app/bootstrap") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    const result = await appBootstrap(env, auth, url, requestId);
    return json(
      { ok: true, bootstrap: result.bootstrap },
      {
        headers: readTimingHeaders("bootstrap", authTimingMs, startedAt, [
          ["rooms", result.metrics.roomsMs],
          ["messages", result.metrics.messagesMs],
        ]),
      },
    );
  }

  const principalDevicesMatch = routeParams(
    /^\/v1\/principals\/([^/]+)\/devices$/,
    url.pathname,
  );
  if (principalDevicesMatch) {
    requireMethod(request, "GET");
    return json({
      ok: true,
      devices: await listPrincipalDevices(env, principalDevicesMatch[1]),
    });
  }

  const publishKeyPackageMatch = routeParams(
    /^\/v1\/devices\/([^/]+)\/key-packages$/,
    url.pathname,
  );
  if (publishKeyPackageMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        ...(await listOwnDeviceKeyPackages(
          env,
          auth,
          publishKeyPackageMatch[1],
          url,
        )),
      });
    }
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const keyPackage = await publishKeyPackage(
      env,
      auth,
      publishKeyPackageMatch[1],
      body,
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.publish",
      targetType: "device",
      targetId: publishKeyPackageMatch[1],
      requestId,
      result: "success",
      metadata: { keyPackageId: keyPackage.keyPackageId },
    });
    return json({ ok: true, keyPackage }, { status: 201 });
  }

  const listKeyPackagesMatch = routeParams(
    /^\/v1\/principals\/([^/]+)\/key-packages$/,
    url.pathname,
  );
  if (listKeyPackagesMatch) {
    requireMethod(request, "GET");
    return json({
      ok: true,
      keyPackages: await listAvailableKeyPackages(env, listKeyPackagesMatch[1]),
    });
  }

  const claimKeyPackageMatch = routeParams(
    /^\/v1\/key-packages\/([^/]+)\/claim$/,
    url.pathname,
  );
  if (claimKeyPackageMatch) {
    requireMethod(request, "POST");
    const keyPackage = await claimKeyPackage(
      env,
      auth,
      claimKeyPackageMatch[1],
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.claim",
      targetType: "key_package",
      targetId: claimKeyPackageMatch[1],
      requestId,
      result: "success",
    });
    return json({ ok: true, keyPackage });
  }

  const revokeKeyPackageMatch = routeParams(
    /^\/v1\/key-packages\/([^/]+)\/revoke$/,
    url.pathname,
  );
  if (revokeKeyPackageMatch) {
    requireMethod(request, "POST");
    await revokeKeyPackage(env, auth, revokeKeyPackageMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.revoke",
      targetType: "key_package",
      targetId: revokeKeyPackageMatch[1],
      requestId,
      result: "success",
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/rooms") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, ...(await listRooms(env, auth, url)) },
      { headers: readTimingHeaders("rooms", authTimingMs, startedAt) },
    );
  }

  if (url.pathname === "/v1/threads") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, ...(await listThreads(env, auth, url)) },
      { headers: readTimingHeaders("threads", authTimingMs, startedAt) },
    );
  }

  if (url.pathname === "/v1/rooms/direct") {
    requireMethod(request, "POST");
    const room = await createDirectRoom(
      env,
      auth,
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.direct.create",
      targetType: "room",
      targetId: String(room.roomId),
      requestId,
      result: "success",
    });
    return json({ ok: true, room }, { status: 201 });
  }

  if (url.pathname === "/v1/rooms/groups") {
    requireMethod(request, "POST");
    const room = await createGroupRoom(
      env,
      auth,
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.group.create",
      targetType: "room",
      targetId: String(room.roomId),
      requestId,
      result: "success",
    });
    return json({ ok: true, room }, { status: 201 });
  }

  const roomMatch = routeParams(/^\/v1\/rooms\/([^/]+)$/, url.pathname);
  if (roomMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        room: await getRoomForMember(env, auth, roomMatch[1]),
      });
    }
    if (request.method === "PATCH") {
      const mutation = await runMutationThroughConversationCoordinator(
        env,
        auth,
        roomMatch[1],
        requestId,
        {
          operation: "room.update",
          body: await readJsonObject(request),
        },
      );
      const room = requireCoordinatorResult(mutation.result);
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "room.update",
        targetType: "room",
        targetId: roomMatch[1],
        requestId,
        result: "success",
      });
      return json(
        { ok: true, room },
        { headers: mutationTimingHeaders("roomUpdate", mutation.metrics) },
      );
    }
  }

  const roomArchiveMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/archive$/,
    url.pathname,
  );
  if (roomArchiveMatch) {
    requireMethod(request, "POST");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      roomArchiveMatch[1],
      requestId,
      {
        operation: "room.archive",
      },
    );
    const room = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.archive",
      targetType: "room",
      targetId: roomArchiveMatch[1],
      requestId,
      result: "success",
    });
    return json(
      { ok: true, room },
      { headers: mutationTimingHeaders("roomArchive", mutation.metrics) },
    );
  }

  const roomMembersMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/members$/,
    url.pathname,
  );
  if (roomMembersMatch) {
    requireMethod(request, "POST");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      roomMembersMatch[1],
      requestId,
      {
        operation: "room.member.add",
        body: await readJsonObject(request),
      },
    );
    const member = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.add",
      targetType: "room",
      targetId: roomMembersMatch[1],
      requestId,
      result: "success",
      metadata: { principalId: member.principalId, role: member.role },
    });
    return json(
      { ok: true, member },
      {
        status: 201,
        headers: mutationTimingHeaders("roomMemberAdd", mutation.metrics),
      },
    );
  }

  const roomInvitationsMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/invitations$/,
    url.pathname,
  );
  if (roomInvitationsMatch) {
    requireMethod(request, "POST");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      roomInvitationsMatch[1],
      requestId,
      {
        operation: "room.invitation.create",
        body: await readJsonObject(request),
      },
    );
    const invitation = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.invitation.create",
      targetType: "room",
      targetId: roomInvitationsMatch[1],
      requestId,
      result: "success",
      metadata: {
        roomInvitationId: invitation.roomInvitationId,
        invitedPrincipalId: invitation.invitedPrincipalId,
      },
    });
    return json(
      { ok: true, invitation },
      {
        status: 201,
        headers: mutationTimingHeaders(
          "roomInvitationCreate",
          mutation.metrics,
        ),
      },
    );
  }

  if (url.pathname === "/v1/room-invitations") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, ...(await listRoomInvitations(env, auth, url)) },
      {
        headers: readTimingHeaders("roomInvitations", authTimingMs, startedAt),
      },
    );
  }

  const roomInvitationActionMatch = routeParams(
    /^\/v1\/room-invitations\/([^/]+)\/(accept|decline)$/,
    url.pathname,
  );
  if (roomInvitationActionMatch) {
    requireMethod(request, "POST");
    const [, roomInvitationId, action] = roomInvitationActionMatch;
    const roomId = await getRoomIdForPendingRoomInvitation(
      env,
      auth,
      roomInvitationId,
    );
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      roomId,
      requestId,
      {
        operation: `room.invitation.${action}`,
        roomInvitationId,
      },
    );
    const invitation = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: `room.invitation.${action}`,
      targetType: "room_invitation",
      targetId: roomInvitationId,
      requestId,
      result: "success",
    });
    return json(
      { ok: true, invitation },
      {
        headers: mutationTimingHeaders(
          `roomInvitation${capitalize(action)}`,
          mutation.metrics,
        ),
      },
    );
  }

  const roomMemberRoleMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/members\/([^/]+)\/role$/,
    url.pathname,
  );
  if (roomMemberRoleMatch) {
    requireMethod(request, "PATCH");
    const body = await readJsonObject(request);
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      roomMemberRoleMatch[1],
      requestId,
      {
        operation: "room.member.role.update",
        principalId: roomMemberRoleMatch[2],
        body,
      },
    );
    const member = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.role.update",
      targetType: "room",
      targetId: roomMemberRoleMatch[1],
      requestId,
      result: "success",
      metadata: { principalId: roomMemberRoleMatch[2], role: member.role },
    });
    return json(
      { ok: true, member },
      {
        headers: mutationTimingHeaders(
          "roomMemberRoleUpdate",
          mutation.metrics,
        ),
      },
    );
  }

  const roomMemberRemoveMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/members\/([^/]+)$/,
    url.pathname,
  );
  if (roomMemberRemoveMatch) {
    requireMethod(request, "DELETE");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      roomMemberRemoveMatch[1],
      requestId,
      {
        operation: "room.member.remove",
        principalId: roomMemberRemoveMatch[2],
      },
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.remove",
      targetType: "room",
      targetId: roomMemberRemoveMatch[1],
      requestId,
      result: "success",
      metadata: { principalId: roomMemberRemoveMatch[2] },
    });
    return json(
      { ok: true },
      { headers: mutationTimingHeaders("roomMemberRemove", mutation.metrics) },
    );
  }

  const leaveRoomMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/leave$/,
    url.pathname,
  );
  if (leaveRoomMatch) {
    requireMethod(request, "POST");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      leaveRoomMatch[1],
      requestId,
      {
        operation: "room.member.leave",
      },
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.leave",
      targetType: "room",
      targetId: leaveRoomMatch[1],
      requestId,
      result: "success",
    });
    return json(
      { ok: true },
      { headers: mutationTimingHeaders("roomMemberLeave", mutation.metrics) },
    );
  }

  const proposeTransferMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/ownership-transfers$/,
    url.pathname,
  );
  if (proposeTransferMatch) {
    requireMethod(request, "POST");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      proposeTransferMatch[1],
      requestId,
      {
        operation: "room.ownership_transfer.propose",
        body: await readJsonObject(request),
      },
    );
    const transfer = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.ownership_transfer.propose",
      targetType: "room",
      targetId: proposeTransferMatch[1],
      requestId,
      result: "success",
      metadata: { transferId: transfer.transferId },
    });
    return json(
      { ok: true, transfer },
      {
        status: 201,
        headers: mutationTimingHeaders(
          "roomOwnershipTransferPropose",
          mutation.metrics,
        ),
      },
    );
  }

  const acceptTransferMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/ownership-transfers\/([^/]+)\/accept$/,
    url.pathname,
  );
  if (acceptTransferMatch) {
    requireMethod(request, "POST");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      acceptTransferMatch[1],
      requestId,
      {
        operation: "room.ownership_transfer.accept",
        transferId: acceptTransferMatch[2],
      },
    );
    const transfer = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.ownership_transfer.accept",
      targetType: "room",
      targetId: acceptTransferMatch[1],
      requestId,
      result: "success",
      metadata: { transferId: acceptTransferMatch[2] },
    });
    return json(
      { ok: true, transfer },
      {
        headers: mutationTimingHeaders(
          "roomOwnershipTransferAccept",
          mutation.metrics,
        ),
      },
    );
  }

  const roomCallsMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/calls$/,
    url.pathname,
  );
  if (roomCallsMatch) {
    if (request.method === "GET") {
      const startedAt = performance.now();
      return json(
        { ok: true, ...(await listRoomCalls(env, auth, roomCallsMatch[1], url)) },
        { headers: readTimingHeaders("calls", authTimingMs, startedAt) },
      );
    }
    if (request.method === "POST") {
      const callId = randomId("call");
      const mutation = await runCallMutationThroughCallCoordinator(
        env,
        auth,
        callId,
        requestId,
        {
          operation: "call.create",
          roomId: roomCallsMatch[1],
          body: await readJsonObject(request),
        },
      );
      const call = requireCallCoordinatorResult(mutation.result);
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "call.create",
        targetType: "call",
        targetId: callId,
        requestId,
        result: "success",
        metadata: {
          roomId: roomCallsMatch[1],
          callType: call.callType,
        },
      });
      return json(
        { ok: true, call },
        {
          status: 201,
          headers: callMutationTimingHeaders("callCreate", mutation.metrics),
        },
      );
    }
  }

  const callUsageReportMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/usage-report$/,
    url.pathname,
  );
  if (callUsageReportMatch) {
    requireMethod(request, "POST");
    return json({
      ok: true,
      ...(await recordCallUsageReport(env, auth, callUsageReportMatch[1], await readJsonObject(request))),
    });
  }

  const callMatch = routeParams(/^\/v1\/calls\/([^/]+)$/, url.pathname);
  if (callMatch) {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, call: await getPublicCall(env, auth, callMatch[1]) },
      { headers: readTimingHeaders("call", authTimingMs, startedAt) },
    );
  }

  const callActionMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/(join|leave|decline|mute|unmute)$/,
    url.pathname,
  );
  if (callActionMatch) {
    requireMethod(request, "POST");
    const [, callId, action] = callActionMatch;
    const mutation = await runCallMutationThroughCallCoordinator(
      env,
      auth,
      callId,
      requestId,
      {
        operation: `call.${action}`,
      },
    );
    const call = requireCallCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: `call.${action}`,
      targetType: "call",
      targetId: callId,
      requestId,
      result: "success",
    });
    return json(
      { ok: true, call },
      {
        headers: callMutationTimingHeaders(
          `call${capitalize(action)}`,
          mutation.metrics,
        ),
      },
    );
  }

  const callParticipantMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/participants\/me$/,
    url.pathname,
  );
  if (callParticipantMatch) {
    requireMethod(request, "PATCH");
    const mutation = await runCallMutationThroughCallCoordinator(
      env,
      auth,
      callParticipantMatch[1],
      requestId,
      {
        operation: "call.participant.update",
        body: await readJsonObject(request),
      },
    );
    const call = requireCallCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "call.participant.update",
      targetType: "call",
      targetId: callParticipantMatch[1],
      requestId,
      result: "success",
    });
    return json(
      { ok: true, call },
      { headers: callMutationTimingHeaders("callParticipantUpdate", mutation.metrics) },
    );
  }

  const callRealtimeRenegotiateMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/realtime\/renegotiate$/,
    url.pathname,
  );
  if (callRealtimeRenegotiateMatch) {
    requireMethod(request, "POST");
    const callId = callRealtimeRenegotiateMatch[1];
    return json({
      ok: true,
      realtime: await renegotiateRealtimeSession(
        env,
        auth,
        callId,
        await readOptionalJsonObject(request),
        (operation, body) =>
          runCallMutationThroughCallCoordinator(env, auth, callId, requestId, {
            operation,
            body,
          }).then((mutation) => mutation.result),
      ),
    });
  }

  const callRealtimeCloseTracksMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/realtime\/tracks\/close$/,
    url.pathname,
  );
  if (callRealtimeCloseTracksMatch) {
    requireMethod(request, "POST");
    const callId = callRealtimeCloseTracksMatch[1];
    return json({
      ok: true,
      realtime: await closeRealtimeTracks(
        env,
        auth,
        callId,
        await readOptionalJsonObject(request),
        (operation, body) =>
          runCallMutationThroughCallCoordinator(env, auth, callId, requestId, {
            operation,
            body,
          }).then((mutation) => mutation.result),
      ),
    });
  }

  const callRealtimeMatch = routeParams(
    /^\/v1\/calls\/([^/]+)\/realtime\/(session|tracks)$/,
    url.pathname,
  );
  if (callRealtimeMatch) {
    requireMethod(request, "POST");
    const callId = callRealtimeMatch[1];
    const body = await readOptionalJsonObject(request);
    const runMediaMutation = (operation: string, mutationBody?: Record<string, unknown>) =>
      runCallMutationThroughCallCoordinator(env, auth, callId, requestId, {
        operation,
        body: mutationBody,
      }).then((mutation) => mutation.result);
    const realtime =
      callRealtimeMatch[2] === "session"
        ? await getRealtimeSessionConfig(env, auth, callId, body, runMediaMutation)
        : await getRealtimeTrackConfig(env, auth, callId, body, runMediaMutation);
    return json({ ok: true, realtime });
  }

  const messagesMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages$/,
    url.pathname,
  );
  if (messagesMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        messages: await listRoomMessages(env, auth, messagesMatch[1], url),
      });
    }
    if (request.method === "POST") {
      const { message, metrics } =
        await sendMessageThroughConversationCoordinator(
          env,
          auth,
          messagesMatch[1],
          await readJsonObject(request),
          requestId,
        );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "message.send",
        targetType: "room",
        targetId: messagesMatch[1],
        requestId,
        result: "success",
        metadata: {
          envelopeId: message.envelopeId,
          sequence: message.serverSequence,
        },
      });
      return json(
        { ok: true, message },
        { status: 201, headers: sendMessageTimingHeaders(metrics) },
      );
    }
  }

  const deleteMessagesMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/delete$/,
    url.pathname,
  );
  if (deleteMessagesMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const scope = body.scope;
    let deleted: Record<string, unknown>;
    if (scope === "everyone") {
      const mutation = await runMutationThroughConversationCoordinator(
        env,
        auth,
        deleteMessagesMatch[1],
        requestId,
        {
          operation: "message.delete_everyone",
          body,
        },
      );
      deleted = requireCoordinatorResult(mutation.result);
    } else {
      deleted = await deleteMessagesForMe(
        env,
        auth,
        deleteMessagesMatch[1],
        body,
      );
    }
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: deleted.scope === "everyone" ? "message.delete_everyone" : "message.delete_for_me",
      targetType: "room",
      targetId: deleteMessagesMatch[1],
      requestId,
      result: "success",
      metadata: {
        envelopeIds: deleted.envelopeIds,
        count: Array.isArray(deleted.envelopeIds)
          ? deleted.envelopeIds.length
          : undefined,
      },
    });
    return json({ ok: true, deleted });
  }

  const messageForwardMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/forward$/,
    url.pathname,
  );
  if (messageForwardMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const targetRoomId = stringField(body, "targetRoomId", {
      required: true,
      max: 80,
    })!;
    if (targetRoomId === messageForwardMatch[1]) {
      throw new HttpError(
        400,
        "invalid_forward_target",
        "Forward target must be a different room",
      );
    }
    const forwardSource = await resolveForwardSource(
      env,
      auth,
      messageForwardMatch[1],
      messageForwardMatch[2],
    );
    const { message, metrics } =
      await sendMessageThroughConversationCoordinator(
        env,
        auth,
        targetRoomId,
        body,
        requestId,
        { forwardSource },
      );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.forward",
      targetType: "message",
      targetId: messageForwardMatch[2],
      requestId,
      result: "success",
      metadata: {
        sourceRoomId: messageForwardMatch[1],
        targetRoomId,
        forwardedEnvelopeId: message.envelopeId,
        sequence: message.serverSequence,
      },
    });
    return json(
      { ok: true, message },
      { status: 201, headers: sendMessageTimingHeaders(metrics) },
    );
  }

  const threadMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread$/,
    url.pathname,
  );
  if (threadMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        thread: await getThread(env, auth, threadMatch[1], threadMatch[2], url),
      });
    }
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const alsoSendToRoom = body.alsoSendToRoom === true;
    const { message, metrics } =
      await sendMessageThroughConversationCoordinator(
        env,
        auth,
        threadMatch[1],
        body,
        requestId,
        {
          threadReply: {
            rootEnvelopeId: threadMatch[2],
            alsoSendToRoom,
          },
        },
      );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.thread_reply",
      targetType: "message",
      targetId: threadMatch[2],
      requestId,
      result: "success",
      metadata: {
        roomId: threadMatch[1],
        replyEnvelopeId: message.envelopeId,
        sequence: message.serverSequence,
        alsoSentToRoom: alsoSendToRoom,
      },
    });
    return json(
      { ok: true, message },
      { status: 201, headers: sendMessageTimingHeaders(metrics) },
    );
  }

  const threadReadMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread\/read$/,
    url.pathname,
  );
  if (threadReadMatch) {
    requireMethod(request, "POST");
    const state = await markThreadRead(
      env,
      auth,
      threadReadMatch[1],
      threadReadMatch[2],
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.thread_read",
      targetType: "message",
      targetId: threadReadMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: threadReadMatch[1] },
    });
    return json({ ok: true, threadState: state });
  }

  const threadSubscriptionMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread\/subscription$/,
    url.pathname,
  );
  if (threadSubscriptionMatch) {
    requireMethod(request, "PATCH");
    const state = await updateThreadSubscription(
      env,
      auth,
      threadSubscriptionMatch[1],
      threadSubscriptionMatch[2],
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.thread_subscription.update",
      targetType: "message",
      targetId: threadSubscriptionMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: threadSubscriptionMatch[1] },
    });
    return json({ ok: true, threadState: state });
  }

  const messageReactionDeleteMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/,
    url.pathname,
  );
  if (messageReactionDeleteMatch) {
    requireMethod(request, "DELETE");
    const reaction = decodeURIComponent(messageReactionDeleteMatch[3]);
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      messageReactionDeleteMatch[1],
      requestId,
      {
        operation: "message.reaction.delete",
        envelopeId: messageReactionDeleteMatch[2],
        body: { reaction },
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.reaction.delete",
      targetType: "message",
      targetId: messageReactionDeleteMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: messageReactionDeleteMatch[1], reaction },
    });
    return json(
      { ok: true, message },
      { headers: mutationTimingHeaders("messageReactionDelete", mutation.metrics) },
    );
  }

  const messageReactionsMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions$/,
    url.pathname,
  );
  if (messageReactionsMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      messageReactionsMatch[1],
      requestId,
      {
        operation: "message.reaction.set",
        envelopeId: messageReactionsMatch[2],
        body,
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.reaction.set",
      targetType: "message",
      targetId: messageReactionsMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: messageReactionsMatch[1], reaction: body.reaction },
    });
    return json(
      { ok: true, message },
      { headers: mutationTimingHeaders("messageReactionSet", mutation.metrics) },
    );
  }

  const messagePinMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/pin$/,
    url.pathname,
  );
  if (messagePinMatch) {
    if (request.method !== "POST" && request.method !== "DELETE") requireMethod(request, "POST");
    const operation =
      request.method === "POST"
        ? "message.pin"
        : request.method === "DELETE"
          ? "message.unpin"
          : "message.pin";
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      messagePinMatch[1],
      requestId,
      {
        operation,
        envelopeId: messagePinMatch[2],
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: operation,
      targetType: "message",
      targetId: messagePinMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: messagePinMatch[1] },
    });
    return json(
      { ok: true, message },
      {
        headers: mutationTimingHeaders(
          request.method === "POST" ? "messagePin" : "messageUnpin",
          mutation.metrics,
        ),
      },
    );
  }

  const editMessageMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)$/,
    url.pathname,
  );
  if (editMessageMatch) {
    requireMethod(request, "PATCH");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      editMessageMatch[1],
      requestId,
      {
        operation: "message.edit",
        envelopeId: editMessageMatch[2],
        body: await readJsonObject(request),
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.edit",
      targetType: "message",
      targetId: editMessageMatch[2],
      requestId,
      result: "success",
      metadata: {
        roomId: editMessageMatch[1],
        sequence: message.serverSequence,
      },
    });
    return json(
      { ok: true, message },
      { headers: mutationTimingHeaders("messageEdit", mutation.metrics) },
    );
  }

  const ackMessageMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/ack$/,
    url.pathname,
  );
  if (ackMessageMatch) {
    requireMethod(request, "POST");
    const receipt = await acknowledgeMessage(
      env,
      auth,
      ackMessageMatch[1],
      ackMessageMatch[2],
      await readJsonObject(request),
    );
    return json({ ok: true, receipt });
  }

  if (url.pathname === "/v1/sync") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, sync: await syncAccount(env, auth, url) },
      { headers: readTimingHeaders("sync", authTimingMs, startedAt) },
    );
  }

  const allocateAttachmentMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/attachments$/,
    url.pathname,
  );
  if (allocateAttachmentMatch) {
    requireMethod(request, "POST");
    const attachment = await allocateAttachment(
      env,
      auth,
      allocateAttachmentMatch[1],
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "attachment.allocate",
      targetType: "attachment",
      targetId: String(attachment.attachmentId),
      requestId,
      result: "success",
    });
    return json({ ok: true, attachment }, { status: 201 });
  }

  const attachmentBlobMatch = routeParams(
    /^\/v1\/attachments\/([^/]+)\/blob$/,
    url.pathname,
  );
  if (attachmentBlobMatch) {
    if (request.method === "PUT") {
      const attachment = await uploadAttachmentBlob(
        env,
        auth,
        attachmentBlobMatch[1],
        request,
        parseAttachmentVariant(url.searchParams.get("variant")),
      );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "attachment.upload",
        targetType: "attachment",
        targetId: attachmentBlobMatch[1],
        requestId,
        result: "success",
      });
      return json({ ok: true, attachment });
    }
    if (request.method === "GET") {
      return downloadAttachmentBlob(
        env,
        auth,
        attachmentBlobMatch[1],
        parseAttachmentVariant(url.searchParams.get("variant")),
      );
    }
  }

  const completeAttachmentMatch = routeParams(
    /^\/v1\/attachments\/([^/]+)\/complete$/,
    url.pathname,
  );
  if (completeAttachmentMatch) {
    requireMethod(request, "POST");
    const attachment = await completeAttachment(
      env,
      auth,
      completeAttachmentMatch[1],
      await readJsonObject(request),
    );
    return json({ ok: true, attachment });
  }

  const attachmentMatch = routeParams(
    /^\/v1\/attachments\/([^/]+)$/,
    url.pathname,
  );
  if (attachmentMatch) {
    requireMethod(request, "DELETE");
    await deleteAttachment(env, auth, attachmentMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "attachment.delete",
      targetType: "attachment",
      targetId: attachmentMatch[1],
      requestId,
      result: "success",
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/sidebar-collections") {
    if (request.method === "GET") {
      const startedAt = performance.now();
      return json(
        { ok: true, collections: await listSidebarCollections(env, auth) },
        {
          headers: readTimingHeaders(
            "sidebarCollections",
            authTimingMs,
            startedAt,
          ),
        },
      );
    }
    if (request.method === "POST") {
      return json(
        {
          ok: true,
          collection: await createSidebarCollection(
            env,
            auth,
            await readJsonObject(request),
          ),
        },
        { status: 201 },
      );
    }
  }

  const sidebarMatch = routeParams(
    /^\/v1\/sidebar-collections\/([^/]+)$/,
    url.pathname,
  );
  if (sidebarMatch) {
    if (request.method === "PATCH") {
      return json({
        ok: true,
        collection: await updateSidebarCollection(
          env,
          auth,
          sidebarMatch[1],
          await readJsonObject(request),
        ),
      });
    }
    if (request.method === "DELETE") {
      await deleteSidebarCollection(env, auth, sidebarMatch[1]);
      return json({ ok: true });
    }
  }

  const sidebarItemMatch = routeParams(
    /^\/v1\/sidebar-collections\/([^/]+)\/items$/,
    url.pathname,
  );
  if (sidebarItemMatch) {
    requireMethod(request, "POST");
    return json(
      {
        ok: true,
        item: await addSidebarCollectionItem(
          env,
          auth,
          sidebarItemMatch[1],
          await readJsonObject(request),
        ),
      },
      { status: 201 },
    );
  }

  const sidebarItemDeleteMatch = routeParams(
    /^\/v1\/sidebar-collections\/([^/]+)\/items\/([^/]+)$/,
    url.pathname,
  );
  if (sidebarItemDeleteMatch) {
    requireMethod(request, "DELETE");
    await deleteSidebarCollectionItem(
      env,
      auth,
      sidebarItemDeleteMatch[1],
      sidebarItemDeleteMatch[2],
    );
    return json({ ok: true });
  }

  if (url.pathname === "/v1/agent-requests") {
    if (request.method === "GET") {
      return json({
        ok: true,
        ...(await listOwnAgentRequests(env, auth, url)),
      });
    }
    if (request.method === "POST") {
      const agentRequest = await createAgentRequest(
        env,
        auth,
        await readJsonObject(request),
      );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "agent_request.submit",
        targetType: "agent_request",
        targetId: String(agentRequest.requestId),
        requestId,
        result: "success",
      });
      return json({ ok: true, request: agentRequest }, { status: 201 });
    }
  }

  if (url.pathname === "/v1/admin/agent-requests") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["agent_provisioner", "user_admin", "auditor"]);
    return json({ ok: true, ...(await listAdminAgentRequests(env, url)) });
  }

  const adminAgentRequestMatch = routeParams(
    /^\/v1\/admin\/agent-requests\/([^/]+)$/,
    url.pathname,
  );
  if (adminAgentRequestMatch) {
    requireMethod(request, "PATCH");
    const adminRole = requireAdmin(auth, ["agent_provisioner"]);
    const agentRequest = await reviewAgentRequest(
      env,
      auth,
      adminAgentRequestMatch[1],
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.agent_request.review",
      targetType: "agent_request",
      targetId: adminAgentRequestMatch[1],
      requestId,
      result: "success",
      metadata: { status: agentRequest.status },
    });
    return json({ ok: true, request: agentRequest });
  }

  if (url.pathname === "/v1/admin/agents") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["agent_provisioner"]);
    const agent = await createAgentPrincipal(
      env,
      auth,
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.agent.create",
      targetType: "principal",
      targetId: String(agent.principalId),
      requestId,
      result: "success",
    });
    return json({ ok: true, agent }, { status: 201 });
  }

  if (url.pathname === "/v1/admin/rooms") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["user_admin", "security_admin", "auditor"]);
    return json({ ok: true, ...(await listAdminRooms(env, url)) });
  }

  if (url.pathname === "/v1/admin/maintenance/runs") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["security_admin", "auditor"]);
    return json({ ok: true, ...(await listMaintenanceRuns(env, url)) });
  }

  if (url.pathname === "/v1/admin/maintenance/cleanup") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["security_admin"]);
    const result = await runCleanup(env, auth);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.maintenance.cleanup",
      targetType: "maintenance",
      targetId: String(result.maintenanceRunId),
      requestId,
      result: "success",
      metadata: result,
    });
    return json({ ok: true, cleanup: result }, { status: 201 });
  }

  return null;
}
