import { audit } from "../../db";
import { json, readJsonObject, requireMethod, routeParams } from "../../http";
import {
  requireCoordinatorResult,
  runMutationThroughConversationCoordinator,
} from "../conversation-coordinator";
import {
  createDirectRoom,
  createGroupRoom,
  getRoomForMember,
  getRoomIdForPendingRoomInvitation,
  listRoomInvitations,
  listRooms,
} from "../rooms";
import { capitalize, mutationTimingHeaders, readTimingHeaders } from "../utils";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext } from "./types";

export async function handleRoomRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/rooms") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, ...(await listRooms(env, auth, url)) },
      { headers: readTimingHeaders("rooms", authTimingMs, startedAt) },
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

  return null;
}
