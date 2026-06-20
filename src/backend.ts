import { audit, requireAdmin } from "./db";
import { randomId } from "./crypto";
import { errorResponse, HttpError, json, optionalObject, publicAccount, readJsonObject, requireMethod, routeParams, serverTimingHeader, stringField } from "./http";
import { notifyRoomRealtime } from "./realtime";
import type { AccountRow, AuthContext, DeviceRow, Env, PrincipalRow, PolicyRow } from "./types";

const MAX_MESSAGE_BYTES = 262_144;
const MAX_KEY_PACKAGE_BYTES = 16_384;
const DEFAULT_KEY_PACKAGE_DAYS = 30;
const OWNERSHIP_TRANSFER_DAYS = 7;
const DEFAULT_ATTACHMENT_DAYS = 30;
const ROOM_INVITATION_DAYS = 7;

type RouteResult = Response | null;
type JsonObject = Record<string, unknown>;

interface SendMessageMetrics {
  duplicate: boolean;
  totalMs: number;
  conversationDoMs?: number;
  contextMs: number;
  insertMs: number;
  postWriteMs: number;
  realtimeMs: number;
}

interface SendMessageResult {
  message: JsonObject;
  metrics: SendMessageMetrics;
}

interface ConversationSendRequest {
  auth: AuthContext;
  roomId: string;
  body: Record<string, unknown>;
  requestId: string;
}

interface ConversationMutationRequest {
  auth: AuthContext;
  roomId: string;
  operation: string;
  requestId: string;
  body?: Record<string, unknown>;
  principalId?: string;
  roomInvitationId?: string;
  transferId?: string;
}

type ConversationSendResponse =
  | { ok: true; message: JsonObject; metrics: SendMessageMetrics }
  | { ok: false; error: string; message: string; details?: unknown };

type ConversationMutationResponse =
  | { ok: true; result?: JsonObject }
  | { ok: false; error: string; message: string; details?: unknown };

interface AppBootstrapResult {
  bootstrap: JsonObject;
  metrics: {
    roomsMs: number;
    messagesMs: number;
  };
}

interface PageParams {
  limit: number;
  offset: number;
}

interface PrincipalRecord extends PrincipalRow {
  account_status: AccountRow["status"];
}

interface RoomRow {
  room_id: string;
  type: "direct" | "group" | "channel";
  name: string | null;
  description: string | null;
  created_by_account_id: string;
  created_by_principal_id: string;
  status: "active" | "archived" | "deleted";
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface MembershipRow {
  membership_id: string;
  room_id: string;
  account_id: string;
  principal_id: string;
  role: "owner" | "admin" | "member" | "agent";
  status: "invited" | "active" | "leaving" | "removed" | "banned";
  invited_by_principal_id: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  principal_type?: PrincipalRow["principal_type"];
  display_name?: string;
}

interface SendRoomContext extends MembershipRow {
  room_status: RoomRow["status"];
  message_retention_days: number;
}

interface AttachmentRow {
  attachment_id: string;
  room_id: string;
  uploader_account_id: string;
  uploader_principal_id: string;
  uploader_device_id: string;
  object_key: string;
  state: "allocated" | "uploaded" | "referenced" | "expired" | "deleted" | "quarantined_metadata";
  expected_bytes: number;
  ciphertext_bytes: number | null;
  ciphertext_sha256: string | null;
  content_category: string | null;
  retention_class: string;
  expires_at: string;
  created_at: string;
  uploaded_at: string | null;
  referenced_at: string | null;
  deleted_at: string | null;
}

interface RoomInvitationRow {
  room_invitation_id: string;
  room_id: string;
  invited_account_id: string;
  invited_principal_id: string;
  invited_by_account_id: string;
  invited_by_principal_id: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  room_name?: string | null;
  room_type?: RoomRow["type"];
  invited_by_display_name?: string;
}

export class ConversationCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(_state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    let requestId = randomId("req");

    try {
      const url = new URL(request.url);
      const sendMatch = routeParams(/^\/rooms\/([^/]+)\/messages$/, url.pathname);
      const mutationMatch = routeParams(/^\/rooms\/([^/]+)\/mutations$/, url.pathname);
      if (request.method !== "POST" || (!sendMatch && !mutationMatch)) {
        throw new HttpError(404, "not_found", "Conversation coordinator route not found");
      }

      const roomId = decodeURIComponent((sendMatch ?? mutationMatch)![1]);
      if (roomId.length === 0 || roomId.length > 160) {
        throw new HttpError(400, "invalid_field", "Field is invalid: roomId");
      }

      const body = await readJsonObject(request);
      if (sendMatch) {
        const payload = parseConversationSendRequest(body, roomId);
        requestId = payload.requestId;
        return this.enqueue(() => this.sendMessage(payload));
      }

      const payload = parseConversationMutationRequest(body, roomId);
      requestId = payload.requestId;
      return this.enqueue(() => this.runMutation(payload));
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  private enqueue(operation: () => Promise<Response>): Promise<Response> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async sendMessage(payload: ConversationSendRequest): Promise<Response> {
    try {
      const { message, metrics } = await sendMessageEnvelope(this.env, payload.auth, payload.roomId, payload.body, payload.requestId);
      return json({ ok: true, message, metrics });
    } catch (error) {
      return errorResponse(error, payload.requestId);
    }
  }

  private async runMutation(payload: ConversationMutationRequest): Promise<Response> {
    try {
      const result = await runConversationMutation(this.env, payload);
      return json(result === undefined ? { ok: true } : { ok: true, result });
    } catch (error) {
      return errorResponse(error, payload.requestId);
    }
  }
}

export async function handleBackendFirstRoutes(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  auth: AuthContext,
  authTimingMs = 0
): Promise<RouteResult> {
  if (url.pathname === "/v1/principals") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json({ ok: true, principals: await listPrincipals(env) }, { headers: readTimingHeaders("principals", authTimingMs, startedAt) });
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
          ["messages", result.metrics.messagesMs]
        ])
      }
    );
  }

  const principalDevicesMatch = routeParams(/^\/v1\/principals\/([^/]+)\/devices$/, url.pathname);
  if (principalDevicesMatch) {
    requireMethod(request, "GET");
    return json({ ok: true, devices: await listPrincipalDevices(env, principalDevicesMatch[1]) });
  }

  const publishKeyPackageMatch = routeParams(/^\/v1\/devices\/([^/]+)\/key-packages$/, url.pathname);
  if (publishKeyPackageMatch) {
    if (request.method === "GET") {
      return json({ ok: true, ...(await listOwnDeviceKeyPackages(env, auth, publishKeyPackageMatch[1], url)) });
    }
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const keyPackage = await publishKeyPackage(env, auth, publishKeyPackageMatch[1], body);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.publish",
      targetType: "device",
      targetId: publishKeyPackageMatch[1],
      requestId,
      result: "success",
      metadata: { keyPackageId: keyPackage.keyPackageId }
    });
    return json({ ok: true, keyPackage }, { status: 201 });
  }

  const listKeyPackagesMatch = routeParams(/^\/v1\/principals\/([^/]+)\/key-packages$/, url.pathname);
  if (listKeyPackagesMatch) {
    requireMethod(request, "GET");
    return json({ ok: true, keyPackages: await listAvailableKeyPackages(env, listKeyPackagesMatch[1]) });
  }

  const claimKeyPackageMatch = routeParams(/^\/v1\/key-packages\/([^/]+)\/claim$/, url.pathname);
  if (claimKeyPackageMatch) {
    requireMethod(request, "POST");
    const keyPackage = await claimKeyPackage(env, auth, claimKeyPackageMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.claim",
      targetType: "key_package",
      targetId: claimKeyPackageMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true, keyPackage });
  }

  const revokeKeyPackageMatch = routeParams(/^\/v1\/key-packages\/([^/]+)\/revoke$/, url.pathname);
  if (revokeKeyPackageMatch) {
    requireMethod(request, "POST");
    await revokeKeyPackage(env, auth, revokeKeyPackageMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.revoke",
      targetType: "key_package",
      targetId: revokeKeyPackageMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/rooms") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json({ ok: true, ...(await listRooms(env, auth, url)) }, { headers: readTimingHeaders("rooms", authTimingMs, startedAt) });
  }

  if (url.pathname === "/v1/rooms/direct") {
    requireMethod(request, "POST");
    const room = await createDirectRoom(env, auth, await readJsonObject(request));
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.direct.create",
      targetType: "room",
      targetId: String(room.roomId),
      requestId,
      result: "success"
    });
    return json({ ok: true, room }, { status: 201 });
  }

  if (url.pathname === "/v1/rooms/groups") {
    requireMethod(request, "POST");
    const room = await createGroupRoom(env, auth, await readJsonObject(request));
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.group.create",
      targetType: "room",
      targetId: String(room.roomId),
      requestId,
      result: "success"
    });
    return json({ ok: true, room }, { status: 201 });
  }

  const roomMatch = routeParams(/^\/v1\/rooms\/([^/]+)$/, url.pathname);
  if (roomMatch) {
    if (request.method === "GET") {
      return json({ ok: true, room: await getRoomForMember(env, auth, roomMatch[1]) });
    }
    if (request.method === "PATCH") {
      const room = requireCoordinatorResult(
        await runMutationThroughConversationCoordinator(env, auth, roomMatch[1], requestId, {
          operation: "room.update",
          body: await readJsonObject(request)
        })
      );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "room.update",
        targetType: "room",
        targetId: roomMatch[1],
        requestId,
        result: "success"
      });
      return json({ ok: true, room });
    }
  }

  const roomArchiveMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/archive$/, url.pathname);
  if (roomArchiveMatch) {
    requireMethod(request, "POST");
    const room = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, roomArchiveMatch[1], requestId, {
        operation: "room.archive"
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.archive",
      targetType: "room",
      targetId: roomArchiveMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true, room });
  }

  const roomMembersMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members$/, url.pathname);
  if (roomMembersMatch) {
    requireMethod(request, "POST");
    const member = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, roomMembersMatch[1], requestId, {
        operation: "room.member.add",
        body: await readJsonObject(request)
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.add",
      targetType: "room",
      targetId: roomMembersMatch[1],
      requestId,
      result: "success",
      metadata: { principalId: member.principalId, role: member.role }
    });
    return json({ ok: true, member }, { status: 201 });
  }

  const roomInvitationsMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/invitations$/, url.pathname);
  if (roomInvitationsMatch) {
    requireMethod(request, "POST");
    const invitation = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, roomInvitationsMatch[1], requestId, {
        operation: "room.invitation.create",
        body: await readJsonObject(request)
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.invitation.create",
      targetType: "room",
      targetId: roomInvitationsMatch[1],
      requestId,
      result: "success",
      metadata: { roomInvitationId: invitation.roomInvitationId, invitedPrincipalId: invitation.invitedPrincipalId }
    });
    return json({ ok: true, invitation }, { status: 201 });
  }

  if (url.pathname === "/v1/room-invitations") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json({ ok: true, ...(await listRoomInvitations(env, auth, url)) }, { headers: readTimingHeaders("roomInvitations", authTimingMs, startedAt) });
  }

  const roomInvitationActionMatch = routeParams(/^\/v1\/room-invitations\/([^/]+)\/(accept|decline)$/, url.pathname);
  if (roomInvitationActionMatch) {
    requireMethod(request, "POST");
    const [, roomInvitationId, action] = roomInvitationActionMatch;
    const roomId = await getRoomIdForPendingRoomInvitation(env, auth, roomInvitationId);
    const invitation = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, roomId, requestId, {
        operation: `room.invitation.${action}`,
        roomInvitationId
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: `room.invitation.${action}`,
      targetType: "room_invitation",
      targetId: roomInvitationId,
      requestId,
      result: "success"
    });
    return json({ ok: true, invitation });
  }

  const roomMemberRoleMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members\/([^/]+)\/role$/, url.pathname);
  if (roomMemberRoleMatch) {
    requireMethod(request, "PATCH");
    const body = await readJsonObject(request);
    const member = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, roomMemberRoleMatch[1], requestId, {
        operation: "room.member.role.update",
        principalId: roomMemberRoleMatch[2],
        body
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.role.update",
      targetType: "room",
      targetId: roomMemberRoleMatch[1],
      requestId,
      result: "success",
      metadata: { principalId: roomMemberRoleMatch[2], role: member.role }
    });
    return json({ ok: true, member });
  }

  const roomMemberRemoveMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members\/([^/]+)$/, url.pathname);
  if (roomMemberRemoveMatch) {
    requireMethod(request, "DELETE");
    await runMutationThroughConversationCoordinator(env, auth, roomMemberRemoveMatch[1], requestId, {
      operation: "room.member.remove",
      principalId: roomMemberRemoveMatch[2]
    });
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.remove",
      targetType: "room",
      targetId: roomMemberRemoveMatch[1],
      requestId,
      result: "success",
      metadata: { principalId: roomMemberRemoveMatch[2] }
    });
    return json({ ok: true });
  }

  const leaveRoomMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/leave$/, url.pathname);
  if (leaveRoomMatch) {
    requireMethod(request, "POST");
    await runMutationThroughConversationCoordinator(env, auth, leaveRoomMatch[1], requestId, {
      operation: "room.member.leave"
    });
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.member.leave",
      targetType: "room",
      targetId: leaveRoomMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  const proposeTransferMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/ownership-transfers$/, url.pathname);
  if (proposeTransferMatch) {
    requireMethod(request, "POST");
    const transfer = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, proposeTransferMatch[1], requestId, {
        operation: "room.ownership_transfer.propose",
        body: await readJsonObject(request)
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.ownership_transfer.propose",
      targetType: "room",
      targetId: proposeTransferMatch[1],
      requestId,
      result: "success",
      metadata: { transferId: transfer.transferId }
    });
    return json({ ok: true, transfer }, { status: 201 });
  }

  const acceptTransferMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/ownership-transfers\/([^/]+)\/accept$/, url.pathname);
  if (acceptTransferMatch) {
    requireMethod(request, "POST");
    const transfer = requireCoordinatorResult(
      await runMutationThroughConversationCoordinator(env, auth, acceptTransferMatch[1], requestId, {
        operation: "room.ownership_transfer.accept",
        transferId: acceptTransferMatch[2]
      })
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "room.ownership_transfer.accept",
      targetType: "room",
      targetId: acceptTransferMatch[1],
      requestId,
      result: "success",
      metadata: { transferId: acceptTransferMatch[2] }
    });
    return json({ ok: true, transfer });
  }

  const messagesMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages$/, url.pathname);
  if (messagesMatch) {
    if (request.method === "GET") {
      return json({ ok: true, messages: await listRoomMessages(env, auth, messagesMatch[1], url) });
    }
    if (request.method === "POST") {
      const { message, metrics } = await sendMessageThroughConversationCoordinator(env, auth, messagesMatch[1], await readJsonObject(request), requestId);
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "message.send",
        targetType: "room",
        targetId: messagesMatch[1],
        requestId,
        result: "success",
        metadata: { envelopeId: message.envelopeId, sequence: message.serverSequence }
      });
      return json({ ok: true, message }, { status: 201, headers: sendMessageTimingHeaders(metrics) });
    }
  }

  const ackMessageMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/ack$/, url.pathname);
  if (ackMessageMatch) {
    requireMethod(request, "POST");
    const receipt = await acknowledgeMessage(env, auth, ackMessageMatch[1], ackMessageMatch[2], await readJsonObject(request));
    return json({ ok: true, receipt });
  }

  if (url.pathname === "/v1/sync") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json({ ok: true, sync: await syncAccount(env, auth, url) }, { headers: readTimingHeaders("sync", authTimingMs, startedAt) });
  }

  const allocateAttachmentMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/attachments$/, url.pathname);
  if (allocateAttachmentMatch) {
    requireMethod(request, "POST");
    const attachment = await allocateAttachment(env, auth, allocateAttachmentMatch[1], await readJsonObject(request));
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "attachment.allocate",
      targetType: "attachment",
      targetId: String(attachment.attachmentId),
      requestId,
      result: "success"
    });
    return json({ ok: true, attachment }, { status: 201 });
  }

  const attachmentBlobMatch = routeParams(/^\/v1\/attachments\/([^/]+)\/blob$/, url.pathname);
  if (attachmentBlobMatch) {
    if (request.method === "PUT") {
      const attachment = await uploadAttachmentBlob(env, auth, attachmentBlobMatch[1], request);
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "attachment.upload",
        targetType: "attachment",
        targetId: attachmentBlobMatch[1],
        requestId,
        result: "success"
      });
      return json({ ok: true, attachment });
    }
    if (request.method === "GET") {
      return downloadAttachmentBlob(env, auth, attachmentBlobMatch[1]);
    }
  }

  const completeAttachmentMatch = routeParams(/^\/v1\/attachments\/([^/]+)\/complete$/, url.pathname);
  if (completeAttachmentMatch) {
    requireMethod(request, "POST");
    const attachment = await completeAttachment(env, auth, completeAttachmentMatch[1], await readJsonObject(request));
    return json({ ok: true, attachment });
  }

  const attachmentMatch = routeParams(/^\/v1\/attachments\/([^/]+)$/, url.pathname);
  if (attachmentMatch) {
    requireMethod(request, "DELETE");
    await deleteAttachment(env, auth, attachmentMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "attachment.delete",
      targetType: "attachment",
      targetId: attachmentMatch[1],
      requestId,
      result: "success"
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/sidebar-collections") {
    if (request.method === "GET") {
      const startedAt = performance.now();
      return json({ ok: true, collections: await listSidebarCollections(env, auth) }, { headers: readTimingHeaders("sidebarCollections", authTimingMs, startedAt) });
    }
    if (request.method === "POST") {
      return json({ ok: true, collection: await createSidebarCollection(env, auth, await readJsonObject(request)) }, { status: 201 });
    }
  }

  const sidebarMatch = routeParams(/^\/v1\/sidebar-collections\/([^/]+)$/, url.pathname);
  if (sidebarMatch) {
    if (request.method === "PATCH") {
      return json({ ok: true, collection: await updateSidebarCollection(env, auth, sidebarMatch[1], await readJsonObject(request)) });
    }
    if (request.method === "DELETE") {
      await deleteSidebarCollection(env, auth, sidebarMatch[1]);
      return json({ ok: true });
    }
  }

  const sidebarItemMatch = routeParams(/^\/v1\/sidebar-collections\/([^/]+)\/items$/, url.pathname);
  if (sidebarItemMatch) {
    requireMethod(request, "POST");
    return json({ ok: true, item: await addSidebarCollectionItem(env, auth, sidebarItemMatch[1], await readJsonObject(request)) }, { status: 201 });
  }

  const sidebarItemDeleteMatch = routeParams(/^\/v1\/sidebar-collections\/([^/]+)\/items\/([^/]+)$/, url.pathname);
  if (sidebarItemDeleteMatch) {
    requireMethod(request, "DELETE");
    await deleteSidebarCollectionItem(env, auth, sidebarItemDeleteMatch[1], sidebarItemDeleteMatch[2]);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/agent-requests") {
    if (request.method === "GET") {
      return json({ ok: true, ...(await listOwnAgentRequests(env, auth, url)) });
    }
    if (request.method === "POST") {
      const agentRequest = await createAgentRequest(env, auth, await readJsonObject(request));
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "agent_request.submit",
        targetType: "agent_request",
        targetId: String(agentRequest.requestId),
        requestId,
        result: "success"
      });
      return json({ ok: true, request: agentRequest }, { status: 201 });
    }
  }

  if (url.pathname === "/v1/admin/agent-requests") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["agent_provisioner", "user_admin", "auditor"]);
    return json({ ok: true, ...(await listAdminAgentRequests(env, url)) });
  }

  const adminAgentRequestMatch = routeParams(/^\/v1\/admin\/agent-requests\/([^/]+)$/, url.pathname);
  if (adminAgentRequestMatch) {
    requireMethod(request, "PATCH");
    const adminRole = requireAdmin(auth, ["agent_provisioner"]);
    const agentRequest = await reviewAgentRequest(env, auth, adminAgentRequestMatch[1], await readJsonObject(request));
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.agent_request.review",
      targetType: "agent_request",
      targetId: adminAgentRequestMatch[1],
      requestId,
      result: "success",
      metadata: { status: agentRequest.status }
    });
    return json({ ok: true, request: agentRequest });
  }

  if (url.pathname === "/v1/admin/agents") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["agent_provisioner"]);
    const agent = await createAgentPrincipal(env, auth, await readJsonObject(request));
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.agent.create",
      targetType: "principal",
      targetId: String(agent.principalId),
      requestId,
      result: "success"
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
      metadata: result
    });
    return json({ ok: true, cleanup: result }, { status: 201 });
  }

  return null;
}

async function listPrincipals(env: Env): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT principal_id, account_id, principal_type, display_name, avatar_ref, status, owner_principal_id, created_at, revoked_at
     FROM principals
     WHERE status = 'active'
     ORDER BY display_name
     LIMIT 200`
  ).all<PrincipalRow>();
  return (result.results ?? []).map(publicPrincipal);
}

async function listPrincipalDevices(env: Env, principalId: string): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT device_id, account_id, principal_id, platform, device_label, credential_fingerprint,
      credential_version, public_key_package, notification_capability, client_version,
      protocol_version, created_at, last_seen_at, revoked_at, revocation_reason
     FROM devices
     WHERE principal_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`
  )
    .bind(principalId)
    .all<DeviceRow>();
  return (result.results ?? []).map(publicDevice);
}

async function publishKeyPackage(env: Env, auth: AuthContext, deviceId: string, body: Record<string, unknown>): Promise<JsonObject> {
  if (deviceId !== auth.device.device_id) {
    throw new HttpError(403, "device_mismatch", "Key packages can only be published for the current authenticated device");
  }
  const packageJson = requiredJsonText(body, "package", MAX_KEY_PACKAGE_BYTES);
  const keyPackageId = randomId("kpk");
  const expiresAt = sqliteTimestamp(Date.now() + numberField(body, "expiresInDays", 1, 90, DEFAULT_KEY_PACKAGE_DAYS) * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    `INSERT INTO device_key_packages (
      key_package_id, account_id, principal_id, device_id, protocol,
      public_identity_key, signed_prekey, one_time_prekey, package_json, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`
  )
    .bind(
      keyPackageId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      stringField(body, "protocol", { max: 40 }) ?? "opaque-test",
      stringField(body, "publicIdentityKey", { max: 4096 }) ?? null,
      stringField(body, "signedPrekey", { max: 4096 }) ?? null,
      stringField(body, "oneTimePrekey", { max: 4096 }) ?? null,
      packageJson,
      expiresAt
    )
    .run();
  return getKeyPackage(env, keyPackageId, true);
}

async function listAvailableKeyPackages(env: Env, principalId: string): Promise<unknown[]> {
  await getActivePrincipal(env, principalId);
  const result = await env.CONTROL_DB.prepare(
    `SELECT key_package_id, account_id, principal_id, device_id, protocol, public_identity_key,
      signed_prekey, one_time_prekey, package_json, status, claimed_by_device_id,
      claimed_at, expires_at, created_at
     FROM device_key_packages
     WHERE principal_id = ? AND status = 'available' AND expires_at > CURRENT_TIMESTAMP
     ORDER BY created_at ASC
     LIMIT 50`
  )
    .bind(principalId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicKeyPackage);
}

async function listOwnDeviceKeyPackages(env: Env, auth: AuthContext, deviceId: string, url: URL): Promise<JsonObject> {
  const device = await env.CONTROL_DB.prepare("SELECT device_id FROM devices WHERE device_id = ? AND account_id = ?")
    .bind(deviceId, auth.account.account_id)
    .first<{ device_id: string }>();
  if (!device) {
    throw new HttpError(404, "device_not_found", "Device not found");
  }
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT key_package_id, account_id, principal_id, device_id, protocol, public_identity_key,
      signed_prekey, one_time_prekey, package_json, status, claimed_by_device_id,
      claimed_at, expires_at, created_at
     FROM device_key_packages
     WHERE device_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(deviceId, page.limit, page.offset)
    .all<Record<string, unknown>>();
  const keyPackages = (result.results ?? []).map(publicKeyPackage);
  return { keyPackages, nextCursor: nextCursor(keyPackages.length, page) };
}

async function claimKeyPackage(env: Env, auth: AuthContext, keyPackageId: string): Promise<JsonObject> {
  const existing = await getRawKeyPackage(env, keyPackageId);
  if (!existing || existing.status !== "available" || String(existing.expires_at) <= sqliteTimestamp(Date.now())) {
    throw new HttpError(404, "key_package_not_available", "Key package is not available");
  }
  if (existing.device_id === auth.device.device_id) {
    throw new HttpError(400, "cannot_claim_own_key_package", "A device cannot claim its own key package");
  }
  const claimed = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE device_key_packages SET status = 'claimed', claimed_by_device_id = ?, claimed_at = CURRENT_TIMESTAMP WHERE key_package_id = ? AND status = 'available' AND expires_at > CURRENT_TIMESTAMP"
    ).bind(auth.device.device_id, keyPackageId)
  );
  if (claimed !== 1) {
    throw new HttpError(409, "key_package_claim_failed", "Key package was already claimed or expired");
  }
  return getKeyPackage(env, keyPackageId, true);
}

async function revokeKeyPackage(env: Env, auth: AuthContext, keyPackageId: string): Promise<void> {
  const existing = await getRawKeyPackage(env, keyPackageId);
  if (!existing) {
    throw new HttpError(404, "key_package_not_found", "Key package not found");
  }
  if (existing.account_id !== auth.account.account_id) {
    throw new HttpError(403, "forbidden", "Key package belongs to another account");
  }
  await env.CONTROL_DB.prepare("UPDATE device_key_packages SET status = 'revoked' WHERE key_package_id = ? AND status != 'revoked'")
    .bind(keyPackageId)
    .run();
}

async function listRooms(env: Env, auth: AuthContext, url?: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    `SELECT r.*
     FROM rooms r
     JOIN room_memberships rm ON rm.room_id = r.room_id
     WHERE rm.principal_id = ? AND rm.status = 'active' AND r.status != 'deleted'
     ORDER BY r.updated_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(auth.principal.principal_id, page.limit, page.offset)
    .all<RoomRow>();
  const rooms = await publicRoomsWithMembers(env, result.results ?? []);
  return { rooms, nextCursor: nextCursor(rooms.length, page) };
}

async function createDirectRoom(env: Env, auth: AuthContext, body: Record<string, unknown>): Promise<JsonObject> {
  const targetPrincipalIds = stringArrayField(body, "principalIds", { required: true, maxItems: 1 });
  const uniquePrincipalIds = uniqueStrings([auth.principal.principal_id, ...targetPrincipalIds]);
  if (uniquePrincipalIds.length !== 2) {
    throw new HttpError(400, "invalid_direct_room", "Direct rooms require exactly two principals");
  }
  const principals = await getActivePrincipals(env, uniquePrincipalIds);
  const room = await createRoom(env, auth, {
    type: "direct",
    name: stringField(body, "name", { max: 120 }),
    description: stringField(body, "description", { max: 1000 }),
    principals
  });
  return publicRoomWithMembers(env, room);
}

async function createGroupRoom(env: Env, auth: AuthContext, body: Record<string, unknown>): Promise<JsonObject> {
  const policy = await getPolicy(env, auth.account.policy_id);
  const ownedGroups = await countOwnedGroups(env, auth.principal.principal_id);
  if (ownedGroups >= policy.maximum_owned_groups) {
    throw new HttpError(409, "group_quota_reached", "Maximum owned group count reached");
  }
  const memberPrincipalIds = stringArrayField(body, "memberPrincipalIds", { maxItems: policy.maximum_group_memberships - 1 });
  if (memberPrincipalIds.length > 0) {
    throw new HttpError(400, "initial_group_members_not_supported", "Create the group first, then invite humans or add agents");
  }
  const principals = await getActivePrincipals(env, [auth.principal.principal_id]);
  const room = await createRoom(env, auth, {
    type: "group",
    name: stringField(body, "name", { required: true, min: 1, max: 120 }),
    description: stringField(body, "description", { max: 1000 }),
    principals
  });
  return publicRoomWithMembers(env, room);
}

async function createRoom(
  env: Env,
  auth: AuthContext,
  input: { type: RoomRow["type"]; name?: string; description?: string; principals: PrincipalRecord[] }
): Promise<RoomRow> {
  const roomId = randomId("room");
  await env.CONTROL_DB.prepare(
    `INSERT INTO rooms (room_id, type, name, description, created_by_account_id, created_by_principal_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(roomId, input.type, input.name ?? null, input.description ?? null, auth.account.account_id, auth.principal.principal_id)
    .run();

  for (const principal of input.principals) {
    const role = principal.principal_id === auth.principal.principal_id ? "owner" : principal.principal_type === "agent" ? "agent" : "member";
    await insertMembership(env, roomId, principal, role, auth.principal.principal_id);
  }
  return getRoom(env, roomId);
}

async function getRoomForMember(env: Env, auth: AuthContext, roomId: string): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

async function updateRoom(env: Env, auth: AuthContext, roomId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomManager(env, auth, roomId);
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET name = COALESCE(?, name), description = COALESCE(?, description), version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND status = 'active'"
  )
    .bind(stringField(body, "name", { max: 120 }) ?? null, stringField(body, "description", { max: 1000 }) ?? null, roomId)
    .run();
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

async function archiveRoom(env: Env, auth: AuthContext, roomId: string): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  await env.CONTROL_DB.prepare(
    "UPDATE rooms SET status = 'archived', archived_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND status = 'active'"
  )
    .bind(roomId)
    .run();
  return publicRoomWithMembers(env, await getRoom(env, roomId));
}

async function addRoomMember(env: Env, auth: AuthContext, roomId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomManager(env, auth, roomId);
  const room = await getRoom(env, roomId);
  if (room.type === "direct") {
    throw new HttpError(409, "direct_room_members_locked", "Direct room members cannot be changed");
  }
  const principal = await getActivePrincipal(env, stringField(body, "principalId", { required: true, max: 80 })!);
  if (principal.principal_type !== "agent") {
    throw new HttpError(400, "human_invitation_required", "Human principals must accept a room invitation");
  }
  const role = normalizedRole(stringField(body, "role", { max: 20 }), principal.principal_type);
  await enforceMemberQuota(env, roomId);
  await upsertMembership(env, roomId, principal, role, auth.principal.principal_id);
  await bumpRoom(env, roomId);
  return publicMembership(await getMembership(env, roomId, principal.principal_id));
}

async function createRoomInvitation(env: Env, auth: AuthContext, roomId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomManager(env, auth, roomId);
  const room = await getRoom(env, roomId);
  if (room.type === "direct") {
    throw new HttpError(409, "direct_room_members_locked", "Direct room members cannot be changed");
  }
  const principal = await getActivePrincipal(env, stringField(body, "principalId", { required: true, max: 80 })!);
  if (principal.principal_type !== "human") {
    throw new HttpError(400, "agent_invitation_not_supported", "Agent principals should be added directly by a room admin");
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_invitations SET status = 'expired' WHERE room_id = ? AND invited_principal_id = ? AND status = 'pending' AND expires_at <= CURRENT_TIMESTAMP"
  )
    .bind(roomId, principal.principal_id)
    .run();
  const activeMembership = await env.CONTROL_DB.prepare(
    "SELECT membership_id FROM room_memberships WHERE room_id = ? AND principal_id = ? AND status = 'active'"
  )
    .bind(roomId, principal.principal_id)
    .first<{ membership_id: string }>();
  if (activeMembership) {
    throw new HttpError(409, "room_member_already_active", "Principal is already an active room member");
  }
  const existingInvitation = await env.CONTROL_DB.prepare(
    "SELECT room_invitation_id FROM room_invitations WHERE room_id = ? AND invited_principal_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP"
  )
    .bind(roomId, principal.principal_id)
    .first<{ room_invitation_id: string }>();
  if (existingInvitation) {
    throw new HttpError(409, "room_invitation_exists", "A pending room invitation already exists");
  }
  await enforceMemberQuota(env, roomId);

  const roomInvitationId = randomId("rinv");
  const expiresAt = sqliteTimestamp(Date.now() + numberField(body, "expiresInDays", 1, 30, ROOM_INVITATION_DAYS) * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_invitations (
      room_invitation_id, room_id, invited_account_id, invited_principal_id,
      invited_by_account_id, invited_by_principal_id, role, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      roomInvitationId,
      roomId,
      principal.account_id,
      principal.principal_id,
      auth.account.account_id,
      auth.principal.principal_id,
      normalizedInvitationRole(stringField(body, "role", { max: 20 })),
      expiresAt
    )
    .run();
  return publicRoomInvitation(await getRoomInvitation(env, roomInvitationId));
}

async function listRoomInvitations(env: Env, auth: AuthContext, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status") ?? "pending";
  if (!["pending", "accepted", "declined", "revoked", "expired"].includes(status)) {
    throw new HttpError(400, "invalid_invitation_status", "Room invitation status is invalid");
  }
  const pendingFilter = status === "pending" ? "AND ri.expires_at > CURRENT_TIMESTAMP" : "";
  const result = await env.CONTROL_DB.prepare(
    `SELECT ri.*, r.name AS room_name, r.type AS room_type, p.display_name AS invited_by_display_name
     FROM room_invitations ri
     JOIN rooms r ON r.room_id = ri.room_id
     JOIN principals p ON p.principal_id = ri.invited_by_principal_id
     WHERE ri.invited_principal_id = ?
       AND ri.status = ?
       ${pendingFilter}
     ORDER BY ri.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(auth.principal.principal_id, status, page.limit, page.offset)
    .all<RoomInvitationRow>();
  const invitations = (result.results ?? []).map(publicRoomInvitation);
  return { invitations, nextCursor: nextCursor(invitations.length, page) };
}

async function acceptRoomInvitation(env: Env, auth: AuthContext, roomInvitationId: string): Promise<JsonObject> {
  const invitation = await getPendingRoomInvitationForPrincipal(env, roomInvitationId, auth.principal.principal_id);
  const existingMembership = await env.CONTROL_DB.prepare(
    "SELECT membership_id FROM room_memberships WHERE room_id = ? AND principal_id = ? AND status = 'active'"
  )
    .bind(invitation.room_id, auth.principal.principal_id)
    .first<{ membership_id: string }>();
  if (!existingMembership) {
    await enforceMemberQuota(env, invitation.room_id);
    const principal = await getActivePrincipal(env, auth.principal.principal_id);
    await upsertMembership(env, invitation.room_id, principal, invitation.role, invitation.invited_by_principal_id);
    await bumpRoom(env, invitation.room_id);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_invitations SET status = 'accepted', responded_at = CURRENT_TIMESTAMP WHERE room_invitation_id = ? AND status = 'pending'"
  )
    .bind(roomInvitationId)
    .run();
  return publicRoomInvitation(await getRoomInvitation(env, roomInvitationId));
}

async function declineRoomInvitation(env: Env, auth: AuthContext, roomInvitationId: string): Promise<JsonObject> {
  const invitation = await getPendingRoomInvitationForPrincipal(env, roomInvitationId, auth.principal.principal_id);
  await env.CONTROL_DB.prepare(
    "UPDATE room_invitations SET status = 'declined', responded_at = CURRENT_TIMESTAMP WHERE room_invitation_id = ? AND status = 'pending'"
  )
    .bind(invitation.room_invitation_id)
    .run();
  return publicRoomInvitation(await getRoomInvitation(env, roomInvitationId));
}

async function getRoomIdForPendingRoomInvitation(env: Env, auth: AuthContext, roomInvitationId: string): Promise<string> {
  const invitation = await getPendingRoomInvitationForPrincipal(env, roomInvitationId, auth.principal.principal_id);
  return invitation.room_id;
}

async function updateRoomMemberRole(env: Env, auth: AuthContext, roomId: string, principalId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  const principal = await getActivePrincipal(env, principalId);
  const role = normalizedRole(stringField(body, "role", { required: true, max: 20 }), principal.principal_type);
  if (role !== "owner") {
    await ensureAnotherHumanOwner(env, roomId, principalId);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_memberships SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ? AND status = 'active'"
  )
    .bind(role, roomId, principalId)
    .run();
  await bumpRoom(env, roomId);
  return publicMembership(await getMembership(env, roomId, principalId));
}

async function removeRoomMember(env: Env, auth: AuthContext, roomId: string, principalId: string): Promise<void> {
  await requireRoomManager(env, auth, roomId);
  const membership = await getMembership(env, roomId, principalId);
  if (membership.role === "owner") {
    await ensureAnotherHumanOwner(env, roomId, principalId);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_memberships SET status = 'removed', removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?"
  )
    .bind(roomId, principalId)
    .run();
  await bumpRoom(env, roomId);
}

async function leaveRoom(env: Env, auth: AuthContext, roomId: string): Promise<void> {
  const membership = await requireRoomMembership(env, auth, roomId);
  if (membership.role === "owner") {
    await ensureAnotherHumanOwner(env, roomId, auth.principal.principal_id);
  }
  await env.CONTROL_DB.prepare(
    "UPDATE room_memberships SET status = 'leaving', removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?"
  )
    .bind(roomId, auth.principal.principal_id)
    .run();
  await bumpRoom(env, roomId);
}

async function proposeOwnershipTransfer(env: Env, auth: AuthContext, roomId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomOwner(env, auth, roomId);
  const toPrincipalId = stringField(body, "toPrincipalId", { required: true, max: 80 })!;
  const targetMembership = await getMembership(env, roomId, toPrincipalId);
  const target = await getActivePrincipal(env, toPrincipalId);
  if (target.principal_type !== "human" || targetMembership.status !== "active") {
    throw new HttpError(400, "invalid_owner_target", "Ownership can only transfer to an active human room member");
  }
  const transferId = randomId("xfer");
  const expiresAt = sqliteTimestamp(Date.now() + OWNERSHIP_TRANSFER_DAYS * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    `INSERT INTO ownership_transfers (transfer_id, room_id, from_principal_id, to_principal_id, status, expires_at)
     VALUES (?, ?, ?, ?, 'proposed', ?)`
  )
    .bind(transferId, roomId, auth.principal.principal_id, toPrincipalId, expiresAt)
    .run();
  return getOwnershipTransfer(env, transferId);
}

async function acceptOwnershipTransfer(env: Env, auth: AuthContext, roomId: string, transferId: string): Promise<JsonObject> {
  const transfer = await env.CONTROL_DB.prepare(
    "SELECT * FROM ownership_transfers WHERE transfer_id = ? AND room_id = ? AND status = 'proposed' AND expires_at > CURRENT_TIMESTAMP"
  )
    .bind(transferId, roomId)
    .first<Record<string, string>>();
  if (!transfer || transfer.to_principal_id !== auth.principal.principal_id) {
    throw new HttpError(404, "ownership_transfer_not_found", "Ownership transfer not found");
  }
  await requireRoomMembership(env, auth, roomId);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE room_memberships SET role = 'owner', updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?").bind(roomId, auth.principal.principal_id),
    env.CONTROL_DB.prepare("UPDATE room_memberships SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE room_id = ? AND principal_id = ?").bind(roomId, transfer.from_principal_id),
    env.CONTROL_DB.prepare("UPDATE ownership_transfers SET status = 'completed', responded_at = CURRENT_TIMESTAMP WHERE transfer_id = ?").bind(transferId)
  ]);
  await bumpRoom(env, roomId);
  return getOwnershipTransfer(env, transferId);
}

function parseConversationSendRequest(body: Record<string, unknown>, roomId: string): ConversationSendRequest {
  const requestId = stringField(body, "requestId", { required: true, min: 4, max: 160 })!;
  const auth = body.auth;
  const messageBody = body.body;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new HttpError(400, "invalid_field", "Field must be an object: auth");
  }
  if (!messageBody || typeof messageBody !== "object" || Array.isArray(messageBody)) {
    throw new HttpError(400, "invalid_field", "Field must be an object: body");
  }
  return {
    auth: auth as AuthContext,
    roomId,
    body: messageBody as Record<string, unknown>,
    requestId
  };
}

function parseConversationMutationRequest(body: Record<string, unknown>, roomId: string): ConversationMutationRequest {
  const requestId = stringField(body, "requestId", { required: true, min: 4, max: 160 })!;
  const operation = stringField(body, "operation", { required: true, min: 3, max: 120 })!;
  const auth = body.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new HttpError(400, "invalid_field", "Field must be an object: auth");
  }
  return {
    auth: auth as AuthContext,
    roomId,
    operation,
    requestId,
    body: optionalObject(body, "body"),
    principalId: stringField(body, "principalId", { max: 80 }),
    roomInvitationId: stringField(body, "roomInvitationId", { max: 80 }),
    transferId: stringField(body, "transferId", { max: 80 })
  };
}

function requiredMutationBody(payload: ConversationMutationRequest): Record<string, unknown> {
  if (!payload.body) {
    throw new HttpError(400, "missing_field", "Missing required field: body");
  }
  return payload.body;
}

function requiredMutationField(payload: ConversationMutationRequest, key: "principalId" | "roomInvitationId" | "transferId"): string {
  const value = payload[key];
  if (!value) {
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  }
  return value;
}

function requireCoordinatorResult(result: JsonObject | undefined): JsonObject {
  if (!result) {
    throw new HttpError(500, "conversation_do_error", "Conversation coordinator did not return a result");
  }
  return result;
}

async function runConversationMutation(env: Env, payload: ConversationMutationRequest): Promise<JsonObject | undefined> {
  switch (payload.operation) {
    case "room.update":
      await requireActiveRoom(env, payload.roomId);
      return updateRoom(env, payload.auth, payload.roomId, requiredMutationBody(payload));
    case "room.archive":
      return archiveRoom(env, payload.auth, payload.roomId);
    case "room.member.add":
      await requireActiveRoom(env, payload.roomId);
      return addRoomMember(env, payload.auth, payload.roomId, requiredMutationBody(payload));
    case "room.invitation.create":
      await requireActiveRoom(env, payload.roomId);
      return createRoomInvitation(env, payload.auth, payload.roomId, requiredMutationBody(payload));
    case "room.invitation.accept":
      await requireActiveRoom(env, payload.roomId);
      return acceptRoomInvitation(env, payload.auth, await requireRoomInvitationInRoom(env, payload.roomId, requiredMutationField(payload, "roomInvitationId")));
    case "room.invitation.decline":
      return declineRoomInvitation(env, payload.auth, await requireRoomInvitationInRoom(env, payload.roomId, requiredMutationField(payload, "roomInvitationId")));
    case "room.member.role.update":
      await requireActiveRoom(env, payload.roomId);
      return updateRoomMemberRole(env, payload.auth, payload.roomId, requiredMutationField(payload, "principalId"), requiredMutationBody(payload));
    case "room.member.remove":
      await removeRoomMember(env, payload.auth, payload.roomId, requiredMutationField(payload, "principalId"));
      return undefined;
    case "room.member.leave":
      await leaveRoom(env, payload.auth, payload.roomId);
      return undefined;
    case "room.ownership_transfer.propose":
      await requireActiveRoom(env, payload.roomId);
      return proposeOwnershipTransfer(env, payload.auth, payload.roomId, requiredMutationBody(payload));
    case "room.ownership_transfer.accept":
      await requireActiveRoom(env, payload.roomId);
      return acceptOwnershipTransfer(env, payload.auth, payload.roomId, requiredMutationField(payload, "transferId"));
    default:
      throw new HttpError(400, "invalid_conversation_operation", "Conversation operation is invalid");
  }
}

async function sendMessageThroughConversationCoordinator(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string
): Promise<SendMessageResult> {
  const startedAt = performance.now();
  const coordinatorId = env.CONVERSATION_COORDINATOR.idFromName(roomId);
  const coordinator = env.CONVERSATION_COORDINATOR.get(coordinatorId);
  const response = await coordinator.fetch(`https://voyager-conversation.local/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, body, requestId })
  });
  const conversationDoMs = durationSince(startedAt);
  const payload = (await response.json().catch(() => null)) as ConversationSendResponse | null;

  if (!payload || payload.ok !== true) {
    const errorPayload = payload && payload.ok === false ? payload : null;
    throw new HttpError(
      response.status || 500,
      errorPayload?.error ?? "conversation_do_error",
      errorPayload?.message ?? "Conversation coordinator failed",
      errorPayload?.details
    );
  }

  return {
    message: payload.message,
    metrics: {
      ...payload.metrics,
      conversationDoMs,
      totalMs: conversationDoMs
    }
  };
}

async function runMutationThroughConversationCoordinator(
  env: Env,
  auth: AuthContext,
  roomId: string,
  requestId: string,
  input: Omit<ConversationMutationRequest, "auth" | "roomId" | "requestId">
): Promise<JsonObject | undefined> {
  const coordinatorId = env.CONVERSATION_COORDINATOR.idFromName(roomId);
  const coordinator = env.CONVERSATION_COORDINATOR.get(coordinatorId);
  const response = await coordinator.fetch(`https://voyager-conversation.local/rooms/${encodeURIComponent(roomId)}/mutations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth, requestId, ...input })
  });
  const payload = (await response.json().catch(() => null)) as ConversationMutationResponse | null;

  if (!payload || payload.ok !== true) {
    const errorPayload = payload && payload.ok === false ? payload : null;
    throw new HttpError(
      response.status || 500,
      errorPayload?.error ?? "conversation_do_error",
      errorPayload?.message ?? "Conversation coordinator failed",
      errorPayload?.details
    );
  }

  return payload.result;
}

async function sendMessageEnvelope(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
  requestId: string
): Promise<SendMessageResult> {
  const startedAt = performance.now();
  const context = await getSendRoomContext(env, auth, roomId);
  if (context.room_status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const contextMs = durationSince(startedAt);
  const idempotencyKey = stringField(body, "idempotencyKey", { required: true, min: 8, max: 160 })!;
  const ciphertext = stringField(body, "ciphertext", { required: true, min: 1, max: MAX_MESSAGE_BYTES })!;
  const ciphertextBytes = byteLength(ciphertext);
  if (ciphertextBytes > MAX_MESSAGE_BYTES) {
    throw new HttpError(413, "message_too_large", "Encrypted envelope is too large");
  }
  const protocolType = stringField(body, "protocolType", { required: true, max: 60 })!;
  if (!["opaque-test", "mls_application", "mls_commit", "mls_proposal", "mls_welcome"].includes(protocolType)) {
    throw new HttpError(400, "invalid_protocol_type", "Protocol type is not allowed");
  }
  const envelopeId = randomId("msg");
  const expiresAt = sqliteTimestamp(Date.now() + Number(context.message_retention_days) * 24 * 60 * 60 * 1000);
  const clientCreatedAt = stringField(body, "clientCreatedAt", { max: 80 }) ?? null;
  const attachmentIds = stringArrayField(body, "attachmentIds", { maxItems: 20 });
  const insertStartedAt = performance.now();
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT INTO message_envelopes (
      envelope_id, room_id, sender_account_id, sender_principal_id, sender_device_id,
      idempotency_key, protocol_type, ciphertext, ciphertext_bytes, client_created_at,
      server_sequence, expires_at, state
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(server_sequence), 0) + 1 FROM message_envelopes WHERE room_id = ?),
      ?, 'available'
    )
    ON CONFLICT(sender_device_id, idempotency_key) DO NOTHING
    RETURNING *`
  )
    .bind(
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      idempotencyKey,
      protocolType,
      ciphertext,
      ciphertextBytes,
      clientCreatedAt,
      roomId,
      expiresAt
    )
    .first<Record<string, unknown>>();
  const insertMs = durationSince(insertStartedAt);

  if (!inserted) {
    const existing = await env.CONTROL_DB.prepare("SELECT * FROM message_envelopes WHERE sender_device_id = ? AND idempotency_key = ?")
      .bind(auth.device.device_id, idempotencyKey)
      .first<Record<string, unknown>>();
    if (!existing) throw new HttpError(409, "message_idempotency_conflict", "Message idempotency key could not be resolved");
    let realtimeMs = 0;
    if (String(existing.room_id) === roomId) {
      const realtimeStartedAt = performance.now();
      await notifyRoomRealtime(env, roomId, {
        type: "room.message",
        envelopeId: String(existing.envelope_id),
        serverSequence: Number(existing.server_sequence),
        senderDeviceId: auth.device.device_id
      }).catch((error) => console.warn("realtime notification failed", error));
      realtimeMs = durationSince(realtimeStartedAt);
    }
    const metrics = finalizeSendMetrics({ duplicate: true, startedAt, contextMs, insertMs, postWriteMs: 0, realtimeMs });
    logSendMessagePerformance(requestId, roomId, existing, metrics);
    return { message: publicMessage(existing), metrics };
  }

  const postWriteStartedAt = performance.now();
  await env.CONTROL_DB.batch([
    createDeliveryReceiptStatement(env, roomId, envelopeId, auth.device.device_id),
    ...markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds),
    env.CONTROL_DB.prepare("UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?").bind(roomId)
  ]);
  const postWriteMs = durationSince(postWriteStartedAt);

  const message = publicMessage(inserted);
  const realtimeStartedAt = performance.now();
  await notifyRoomRealtime(env, roomId, {
    type: "room.message",
    envelopeId,
    serverSequence: Number(inserted.server_sequence),
    senderDeviceId: auth.device.device_id
  }).catch((error) => console.warn("realtime notification failed", error));
  const realtimeMs = durationSince(realtimeStartedAt);
  const metrics = finalizeSendMetrics({ duplicate: false, startedAt, contextMs, insertMs, postWriteMs, realtimeMs });
  logSendMessagePerformance(requestId, roomId, inserted, metrics);
  return { message, metrics };
}

async function listRoomMessages(env: Env, auth: AuthContext, roomId: string, url: URL): Promise<unknown[]> {
  await requireRoomMembership(env, auth, roomId);
  const after = numberParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = numberParam(url, "limit", 1, 200, 50);
  const result = await env.CONTROL_DB.prepare(
    `SELECT *
     FROM message_envelopes
     WHERE room_id = ? AND server_sequence > ? AND state != 'purged' AND expires_at > CURRENT_TIMESTAMP
     ORDER BY server_sequence ASC
     LIMIT ?`
  )
    .bind(roomId, after, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}

async function acknowledgeMessage(env: Env, auth: AuthContext, roomId: string, envelopeId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const status = stringField(body, "status", { max: 20 }) === "read" ? "read" : "stored";
  const message = await getMessage(env, envelopeId);
  if (!message || message.room_id !== roomId) {
    throw new HttpError(404, "message_not_found", "Message not found");
  }
  const receiptId = randomId("rcp");
  await env.CONTROL_DB.prepare(
    `INSERT INTO delivery_receipts (
      receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id,
      recipient_device_id, status, stored_at, read_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ${status === "read" ? "CURRENT_TIMESTAMP" : "NULL"})
    ON CONFLICT(envelope_id, recipient_device_id) DO UPDATE SET
      status = excluded.status,
      stored_at = COALESCE(delivery_receipts.stored_at, CURRENT_TIMESTAMP),
      read_at = CASE WHEN excluded.status = 'read' THEN CURRENT_TIMESTAMP ELSE delivery_receipts.read_at END`
  )
    .bind(receiptId, envelopeId, roomId, auth.account.account_id, auth.principal.principal_id, auth.device.device_id, status)
    .run();
  await updateMessageReceiptState(env, envelopeId);
  return getReceipt(env, envelopeId, auth.device.device_id);
}

async function syncAccount(env: Env, auth: AuthContext, url: URL): Promise<JsonObject> {
  const limit = numberParam(url, "limit", 1, 200, 50);
  const roomPage = await listRooms(env, auth, url);
  const pendingMessages = await listPendingMessages(env, auth, limit);
  return { rooms: roomPage.rooms, roomsNextCursor: roomPage.nextCursor, pendingMessages };
}

async function appBootstrap(env: Env, auth: AuthContext, url: URL, requestId: string): Promise<AppBootstrapResult> {
  const limit = numberParam(url, "limit", 1, 200, 100);
  const roomsStartedAt = performance.now();
  const roomPage = await listRooms(env, auth, url);
  const roomsMs = durationSince(roomsStartedAt);
  const messagesStartedAt = performance.now();
  const pendingMessages = await listPendingMessages(env, auth, limit);
  const messagesMs = durationSince(messagesStartedAt);
  return {
    bootstrap: {
      account: publicAccount(auth.account),
      principal: publicPrincipal(auth.principal),
      device: publicDevice(auth.device),
      roles: auth.roles,
      rooms: roomPage.rooms,
      roomsNextCursor: roomPage.nextCursor,
      pendingMessages,
      serverTime: new Date().toISOString(),
      requestId
    },
    metrics: { roomsMs, messagesMs }
  };
}

async function listPendingMessages(env: Env, auth: AuthContext, limit: number): Promise<JsonObject[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT me.*
     FROM delivery_receipts dr
     JOIN message_envelopes me ON me.envelope_id = dr.envelope_id
     WHERE dr.recipient_device_id = ?
       AND dr.status = 'pending'
       AND me.expires_at > CURRENT_TIMESTAMP
       AND me.state != 'purged'
     ORDER BY me.server_received_at ASC
     LIMIT ?`
  )
    .bind(auth.device.device_id, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicMessage);
}

async function allocateAttachment(env: Env, auth: AuthContext, roomId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const policy = await getPolicy(env, auth.account.policy_id);
  const expectedBytes = numberField(body, "expectedBytes", 1, policy.maximum_attachment_bytes);
  const attachmentId = randomId("att");
  const objectKey = `attachments/${roomId}/${attachmentId}`;
  const expiresAt = sqliteTimestamp(Date.now() + DEFAULT_ATTACHMENT_DAYS * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    `INSERT INTO attachments (
      attachment_id, room_id, uploader_account_id, uploader_principal_id, uploader_device_id,
      object_key, state, expected_bytes, content_category, retention_class, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?, ?)`
  )
    .bind(
      attachmentId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      objectKey,
      expectedBytes,
      stringField(body, "contentCategory", { max: 80 }) ?? "opaque",
      stringField(body, "retentionClass", { max: 40 }) ?? "default",
      expiresAt
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

async function uploadAttachmentBlob(env: Env, auth: AuthContext, attachmentId: string, request: Request): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state !== "allocated" && attachment.state !== "uploaded") {
    throw new HttpError(409, "attachment_not_uploadable", "Attachment is not uploadable");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > attachment.expected_bytes) {
    throw new HttpError(413, "attachment_too_large", "Attachment body exceeds allocation");
  }
  await env.ATTACHMENTS_BUCKET.put(attachment.object_key, body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { attachmentId, roomId: attachment.room_id }
  });
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET state = 'uploaded', ciphertext_bytes = ?, uploaded_at = CURRENT_TIMESTAMP WHERE attachment_id = ?"
  )
    .bind(body.byteLength, attachmentId)
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

async function completeAttachment(env: Env, auth: AuthContext, attachmentId: string, body: Record<string, unknown>): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state !== "uploaded" && attachment.state !== "referenced") {
    throw new HttpError(409, "attachment_not_uploaded", "Attachment has not been uploaded");
  }
  await env.CONTROL_DB.prepare(
    "UPDATE attachments SET ciphertext_sha256 = COALESCE(?, ciphertext_sha256), ciphertext_bytes = COALESCE(?, ciphertext_bytes) WHERE attachment_id = ?"
  )
    .bind(stringField(body, "ciphertextSha256", { max: 128 }) ?? null, optionalNumberField(body, "ciphertextBytes", 1, attachment.expected_bytes) ?? null, attachmentId)
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}

async function downloadAttachmentBlob(env: Env, auth: AuthContext, attachmentId: string): Promise<Response> {
  const attachment = await getAttachment(env, attachmentId);
  await requireRoomMembership(env, auth, attachment.room_id);
  if (!["uploaded", "referenced"].includes(attachment.state)) {
    throw new HttpError(404, "attachment_not_available", "Attachment is not available");
  }
  const object = await env.ATTACHMENTS_BUCKET.get(attachment.object_key);
  if (!object) {
    throw new HttpError(404, "attachment_blob_missing", "Attachment blob is missing");
  }
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-attachment-id": attachment.attachment_id
    }
  });
}

async function deleteAttachment(env: Env, auth: AuthContext, attachmentId: string): Promise<void> {
  const attachment = await getAttachment(env, attachmentId);
  const membership = await requireRoomMembership(env, auth, attachment.room_id);
  if (attachment.uploader_account_id !== auth.account.account_id && !["owner", "admin"].includes(membership.role)) {
    throw new HttpError(403, "forbidden", "Attachment deletion requires uploader or room admin");
  }
  await env.ATTACHMENTS_BUCKET.delete(attachment.object_key);
  await env.CONTROL_DB.prepare("UPDATE attachments SET state = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE attachment_id = ?")
    .bind(attachmentId)
    .run();
}

async function listSidebarCollections(env: Env, auth: AuthContext): Promise<unknown[]> {
  const collections = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collections WHERE account_id = ? ORDER BY sort_order ASC, created_at ASC"
  )
    .bind(auth.account.account_id)
    .all<Record<string, unknown>>();
  return publicSidebarCollections(env, collections.results ?? []);
}

async function createSidebarCollection(env: Env, auth: AuthContext, body: Record<string, unknown>): Promise<JsonObject> {
  const collectionId = randomId("col");
  await env.CONTROL_DB.prepare(
    "INSERT INTO sidebar_collections (collection_id, account_id, name, sort_order, collapsed) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(
      collectionId,
      auth.account.account_id,
      stringField(body, "name", { required: true, min: 1, max: 80 })!,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
      booleanField(body, "collapsed") ? 1 : 0
    )
    .run();
  return publicSidebarCollection(env, await getSidebarCollection(env, auth, collectionId));
}

async function updateSidebarCollection(env: Env, auth: AuthContext, collectionId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "UPDATE sidebar_collections SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order), collapsed = COALESCE(?, collapsed), updated_at = CURRENT_TIMESTAMP WHERE collection_id = ? AND account_id = ?"
  )
    .bind(
      stringField(body, "name", { max: 80 }) ?? null,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? null,
      body.collapsed === undefined ? null : booleanField(body, "collapsed") ? 1 : 0,
      collectionId,
      auth.account.account_id
    )
    .run();
  return publicSidebarCollection(env, await getSidebarCollection(env, auth, collectionId));
}

async function deleteSidebarCollection(env: Env, auth: AuthContext, collectionId: string): Promise<void> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare("DELETE FROM sidebar_collections WHERE collection_id = ? AND account_id = ?")
    .bind(collectionId, auth.account.account_id)
    .run();
}

async function addSidebarCollectionItem(env: Env, auth: AuthContext, collectionId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await getSidebarCollection(env, auth, collectionId);
  const roomId = stringField(body, "roomId", { required: true, max: 80 })!;
  await requireRoomMembership(env, auth, roomId);
  const itemId = randomId("cit");
  await env.CONTROL_DB.prepare(
    `INSERT INTO sidebar_collection_items (item_id, collection_id, room_id, sort_order)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(collection_id, room_id) DO UPDATE SET sort_order = excluded.sort_order`
  )
    .bind(itemId, collectionId, roomId, optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0)
    .run();
  return { collectionId, roomId, sortOrder: optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0 };
}

async function deleteSidebarCollectionItem(env: Env, auth: AuthContext, collectionId: string, roomId: string): Promise<void> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare("DELETE FROM sidebar_collection_items WHERE collection_id = ? AND room_id = ?")
    .bind(collectionId, roomId)
    .run();
}

async function createAgentRequest(env: Env, auth: AuthContext, body: Record<string, unknown>): Promise<JsonObject> {
  const requestId = randomId("agr");
  await env.CONTROL_DB.prepare(
    `INSERT INTO agent_requests (
      request_id, requester_account_id, requester_principal_id, desired_agent_name,
      summary, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'submitted', ?)`
  )
    .bind(
      requestId,
      auth.account.account_id,
      auth.principal.principal_id,
      stringField(body, "desiredAgentName", { required: true, min: 1, max: 120 })!,
      stringField(body, "summary", { required: true, min: 1, max: 2000 })!,
      optionalJsonText(body, "metadata", 4096)
    )
    .run();
  return getAgentRequest(env, requestId);
}

async function listOwnAgentRequests(env: Env, auth: AuthContext, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare("SELECT * FROM agent_requests WHERE requester_account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(auth.account.account_id, page.limit, page.offset)
    .all<Record<string, unknown>>();
  const requests = (result.results ?? []).map(publicAgentRequest);
  return { requests, nextCursor: nextCursor(requests.length, page) };
}

async function listAdminAgentRequests(env: Env, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status");
  if (status && !["submitted", "under_review", "approved", "rejected", "provisioning", "active", "closed"].includes(status)) {
    throw new HttpError(400, "invalid_agent_request_status", "Unsupported agent request status");
  }
  const where = status ? "WHERE status = ?" : "";
  const stmt = env.CONTROL_DB.prepare(`SELECT * FROM agent_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`);
  const result = status
    ? await stmt.bind(status, page.limit, page.offset).all<Record<string, unknown>>()
    : await stmt.bind(page.limit, page.offset).all<Record<string, unknown>>();
  const requests = (result.results ?? []).map(publicAgentRequest);
  return { requests, nextCursor: nextCursor(requests.length, page) };
}

async function reviewAgentRequest(env: Env, auth: AuthContext, requestId: string, body: Record<string, unknown>): Promise<JsonObject> {
  const status = stringField(body, "status", { required: true, max: 40 })!;
  if (!["under_review", "approved", "rejected", "closed"].includes(status)) {
    throw new HttpError(400, "invalid_agent_request_status", "Unsupported agent request status");
  }
  await env.CONTROL_DB.prepare(
    "UPDATE agent_requests SET status = ?, reviewed_by_account_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?"
  )
    .bind(status, auth.account.account_id, requestId)
    .run();
  return getAgentRequest(env, requestId);
}

async function createAgentPrincipal(env: Env, auth: AuthContext, body: Record<string, unknown>): Promise<JsonObject> {
  const ownerPrincipalId = stringField(body, "ownerPrincipalId", { max: 80 }) ?? auth.principal.principal_id;
  const owner = await getActivePrincipal(env, ownerPrincipalId);
  if (owner.principal_type !== "human") {
    throw new HttpError(400, "invalid_agent_owner", "Agent owner must be a human principal");
  }
  const principalId = randomId("prn");
  await env.CONTROL_DB.prepare(
    `INSERT INTO principals (
      principal_id, account_id, principal_type, display_name, status, owner_principal_id
    ) VALUES (?, ?, 'agent', ?, 'active', ?)`
  )
    .bind(principalId, owner.account_id, stringField(body, "displayName", { required: true, min: 1, max: 120 })!, ownerPrincipalId)
    .run();
  const requestId = stringField(body, "requestId", { max: 80 });
  if (requestId) {
    await env.CONTROL_DB.prepare(
      "UPDATE agent_requests SET status = 'active', created_agent_principal_id = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?"
    )
      .bind(principalId, requestId)
      .run();
  }
  return publicPrincipal(await getActivePrincipal(env, principalId));
}

async function listAdminRooms(env: Env, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status");
  if (status && !["active", "archived", "deleted"].includes(status)) {
    throw new HttpError(400, "invalid_room_status", "Room status is invalid");
  }
  const type = url.searchParams.get("type");
  if (type && !["direct", "group", "channel"].includes(type)) {
    throw new HttpError(400, "invalid_room_type", "Room type is invalid");
  }
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    filters.push("status = ?");
    binds.push(status);
  }
  if (type) {
    filters.push("type = ?");
    binds.push(type);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await env.CONTROL_DB.prepare(`SELECT * FROM rooms ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, page.limit, page.offset)
    .all<RoomRow>();
  const rooms = await Promise.all((result.results ?? []).map((room) => publicRoomWithMembers(env, room)));
  return { rooms, nextCursor: nextCursor(rooms.length, page) };
}

async function listMaintenanceRuns(env: Env, url: URL): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare("SELECT * FROM maintenance_runs ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(page.limit, page.offset)
    .all<Record<string, unknown>>();
  const runs = (result.results ?? []).map(publicMaintenanceRun);
  return { runs, nextCursor: nextCursor(runs.length, page) };
}

async function runCleanup(env: Env, auth: AuthContext): Promise<JsonObject> {
  const expiredMessages = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE message_envelopes SET state = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND state NOT IN ('expired', 'purged')"
    )
  );
  const expiredAttachments = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE attachments SET state = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND state IN ('allocated', 'uploaded', 'referenced')"
    )
  );
  const expiredKeyPackages = await runCounted(
    env.CONTROL_DB.prepare("UPDATE device_key_packages SET status = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'available'")
  );
  const expiredRoomInvitations = await runCounted(
    env.CONTROL_DB.prepare("UPDATE room_invitations SET status = 'expired' WHERE expires_at <= CURRENT_TIMESTAMP AND status = 'pending'")
  );
  const revokedCredentialResets = await runCounted(
    env.CONTROL_DB.prepare(
      "UPDATE credential_reset_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE expires_at <= CURRENT_TIMESTAMP AND used_at IS NULL AND revoked_at IS NULL"
    )
  );
  const revokedExpiredSessions = await runCounted(
    env.CONTROL_DB.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE expires_at <= CURRENT_TIMESTAMP AND revoked_at IS NULL")
  );
  const deletedRealtimeTokens = await runCounted(
    env.CONTROL_DB.prepare("DELETE FROM realtime_socket_tokens WHERE expires_at <= CURRENT_TIMESTAMP OR used_at IS NOT NULL OR revoked_at IS NOT NULL")
  );
  const deletedRateLimits = await runCounted(env.CONTROL_DB.prepare("DELETE FROM rate_limits WHERE expires_at <= CURRENT_TIMESTAMP"));
  const cleanup = {
    maintenanceRunId: randomId("mrun"),
    action: "cleanup",
    expiredMessages,
    expiredAttachments,
    expiredKeyPackages,
    expiredRoomInvitations,
    revokedCredentialResets,
    revokedExpiredSessions,
    deletedRealtimeTokens,
    deletedRateLimits
  };
  await env.CONTROL_DB.prepare(
    "INSERT INTO maintenance_runs (maintenance_run_id, action, actor_account_id, result, metadata_json) VALUES (?, 'cleanup', ?, 'success', ?)"
  )
    .bind(cleanup.maintenanceRunId, auth.account.account_id, JSON.stringify(cleanup))
    .run();
  return cleanup;
}

async function requireRoomMembership(env: Env, auth: AuthContext, roomId: string): Promise<MembershipRow> {
  const membership = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN rooms r ON r.room_id = rm.room_id
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.principal_id = ?
       AND rm.status = 'active'
       AND r.status != 'deleted'`
  )
    .bind(roomId, auth.principal.principal_id)
    .first<MembershipRow>();
  if (!membership) {
    throw new HttpError(403, "room_membership_required", "Active room membership required");
  }
  return membership;
}

async function getSendRoomContext(env: Env, auth: AuthContext, roomId: string): Promise<SendRoomContext> {
  const context = await env.CONTROL_DB.prepare(
    `SELECT
       rm.*,
       p.principal_type,
       p.display_name,
       r.status AS room_status,
       policy.message_retention_days
     FROM room_memberships rm
     JOIN rooms r ON r.room_id = rm.room_id
     JOIN principals p ON p.principal_id = rm.principal_id
     JOIN policies policy ON policy.policy_id = ?
     WHERE rm.room_id = ?
       AND rm.principal_id = ?
       AND rm.status = 'active'
       AND r.status != 'deleted'`
  )
    .bind(auth.account.policy_id, roomId, auth.principal.principal_id)
    .first<SendRoomContext>();
  if (!context) {
    throw new HttpError(403, "room_membership_required", "Active room membership required");
  }
  return context;
}

async function requireRoomManager(env: Env, auth: AuthContext, roomId: string): Promise<MembershipRow> {
  const membership = await requireRoomMembership(env, auth, roomId);
  if (!["owner", "admin"].includes(membership.role)) {
    throw new HttpError(403, "room_admin_required", "Room admin role required");
  }
  return membership;
}

async function requireRoomOwner(env: Env, auth: AuthContext, roomId: string): Promise<MembershipRow> {
  const membership = await requireRoomMembership(env, auth, roomId);
  if (membership.role !== "owner") {
    throw new HttpError(403, "room_owner_required", "Room owner role required");
  }
  return membership;
}

async function getActivePrincipal(env: Env, principalId: string): Promise<PrincipalRecord> {
  const principal = await env.CONTROL_DB.prepare(
    `SELECT p.*, a.status AS account_status
     FROM principals p
     JOIN accounts a ON a.account_id = p.account_id
     WHERE p.principal_id = ? AND p.status = 'active'`
  )
    .bind(principalId)
    .first<PrincipalRecord>();
  if (!principal || principal.account_status !== "active") {
    throw new HttpError(404, "principal_not_found", "Active principal not found");
  }
  return principal;
}

async function getActivePrincipals(env: Env, principalIds: string[]): Promise<PrincipalRecord[]> {
  const principals = [];
  for (const principalId of principalIds) {
    principals.push(await getActivePrincipal(env, principalId));
  }
  return principals;
}

async function getRoom(env: Env, roomId: string): Promise<RoomRow> {
  const room = await env.CONTROL_DB.prepare("SELECT * FROM rooms WHERE room_id = ?").bind(roomId).first<RoomRow>();
  if (!room) throw new HttpError(404, "room_not_found", "Room not found");
  return room;
}

async function requireActiveRoom(env: Env, roomId: string): Promise<RoomRow> {
  const room = await getRoom(env, roomId);
  if (room.status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  return room;
}

async function requireRoomInvitationInRoom(env: Env, roomId: string, roomInvitationId: string): Promise<string> {
  const invitation = await getRoomInvitation(env, roomInvitationId);
  if (invitation.room_id !== roomId) {
    throw new HttpError(404, "room_invitation_not_found", "Room invitation not found");
  }
  return roomInvitationId;
}

async function insertMembership(
  env: Env,
  roomId: string,
  principal: PrincipalRecord,
  role: MembershipRow["role"],
  invitedByPrincipalId: string
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_memberships (
      membership_id, room_id, account_id, principal_id, role, status, invited_by_principal_id
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)`
  )
    .bind(randomId("mem"), roomId, principal.account_id, principal.principal_id, role, invitedByPrincipalId)
    .run();
}

async function upsertMembership(
  env: Env,
  roomId: string,
  principal: PrincipalRecord,
  role: MembershipRow["role"],
  invitedByPrincipalId: string
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO room_memberships (
      membership_id, room_id, account_id, principal_id, role, status, invited_by_principal_id
    ) VALUES (?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(room_id, principal_id) DO UPDATE SET
      role = excluded.role,
      status = 'active',
      removed_at = NULL,
      updated_at = CURRENT_TIMESTAMP`
  )
    .bind(randomId("mem"), roomId, principal.account_id, principal.principal_id, role, invitedByPrincipalId)
    .run();
}

async function getMembership(env: Env, roomId: string, principalId: string): Promise<MembershipRow> {
  const membership = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ? AND rm.principal_id = ?`
  )
    .bind(roomId, principalId)
    .first<MembershipRow>();
  if (!membership) throw new HttpError(404, "membership_not_found", "Room membership not found");
  return membership;
}

async function getRoomInvitation(env: Env, roomInvitationId: string): Promise<RoomInvitationRow> {
  const invitation = await env.CONTROL_DB.prepare(
    `SELECT ri.*, r.name AS room_name, r.type AS room_type, p.display_name AS invited_by_display_name
     FROM room_invitations ri
     JOIN rooms r ON r.room_id = ri.room_id
     JOIN principals p ON p.principal_id = ri.invited_by_principal_id
     WHERE ri.room_invitation_id = ?`
  )
    .bind(roomInvitationId)
    .first<RoomInvitationRow>();
  if (!invitation) throw new HttpError(404, "room_invitation_not_found", "Room invitation not found");
  return invitation;
}

async function getPendingRoomInvitationForPrincipal(env: Env, roomInvitationId: string, principalId: string): Promise<RoomInvitationRow> {
  const invitation = await env.CONTROL_DB.prepare(
    `SELECT ri.*, r.name AS room_name, r.type AS room_type, p.display_name AS invited_by_display_name
     FROM room_invitations ri
     JOIN rooms r ON r.room_id = ri.room_id
     JOIN principals p ON p.principal_id = ri.invited_by_principal_id
     WHERE ri.room_invitation_id = ?
       AND ri.invited_principal_id = ?
       AND ri.status = 'pending'
       AND ri.expires_at > CURRENT_TIMESTAMP`
  )
    .bind(roomInvitationId, principalId)
    .first<RoomInvitationRow>();
  if (!invitation) throw new HttpError(404, "room_invitation_not_found", "Pending room invitation not found");
  return invitation;
}

async function publicRoomWithMembers(env: Env, room: RoomRow): Promise<JsonObject> {
  const members = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ?
     ORDER BY rm.created_at ASC`
  )
    .bind(room.room_id)
    .all<MembershipRow>();
  return publicRoomFromMembers(room, members.results ?? []);
}

async function publicRoomsWithMembers(env: Env, rooms: RoomRow[]): Promise<JsonObject[]> {
  if (!rooms.length) return [];
  const placeholders = rooms.map(() => "?").join(", ");
  const members = await env.CONTROL_DB.prepare(
    `SELECT rm.*, p.principal_type, p.display_name
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id IN (${placeholders})
     ORDER BY rm.room_id ASC, rm.created_at ASC`
  )
    .bind(...rooms.map((room) => room.room_id))
    .all<MembershipRow>();
  const grouped = new Map<string, MembershipRow[]>();
  for (const member of members.results ?? []) {
    const group = grouped.get(member.room_id) ?? [];
    group.push(member);
    grouped.set(member.room_id, group);
  }
  return rooms.map((room) => publicRoomFromMembers(room, grouped.get(room.room_id) ?? []));
}

function publicRoomFromMembers(room: RoomRow, members: MembershipRow[]): JsonObject {
  return { ...publicRoom(room), members: members.map(publicMembership) };
}

async function bumpRoom(env: Env, roomId: string): Promise<void> {
  await env.CONTROL_DB.prepare("UPDATE rooms SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?").bind(roomId).run();
}

async function ensureAnotherHumanOwner(env: Env, roomId: string, excludedPrincipalId: string): Promise<void> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM room_memberships rm
     JOIN principals p ON p.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND rm.role = 'owner'
       AND p.principal_type = 'human'
       AND rm.principal_id != ?`
  )
    .bind(roomId, excludedPrincipalId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) < 1) {
    throw new HttpError(409, "last_owner_required", "Room must keep at least one active human owner");
  }
}

async function enforceMemberQuota(env: Env, roomId: string): Promise<void> {
  const room = await getRoom(env, roomId);
  const owner = await env.CONTROL_DB.prepare("SELECT policy_id FROM accounts WHERE account_id = ?")
    .bind(room.created_by_account_id)
    .first<{ policy_id: string }>();
  const policy = await getPolicy(env, owner?.policy_id ?? "pol_default");
  const active = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND status = 'active'")
    .bind(roomId)
    .first<{ count: number }>();
  const pending = await env.CONTROL_DB.prepare(
    "SELECT COUNT(*) AS count FROM room_invitations WHERE room_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP"
  )
    .bind(roomId)
    .first<{ count: number }>();
  if ((active?.count ?? 0) + (pending?.count ?? 0) >= policy.maximum_group_memberships) {
    throw new HttpError(409, "room_member_quota_reached", "Maximum room member count reached");
  }
}

async function countOwnedGroups(env: Env, principalId: string): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM room_memberships rm
     JOIN rooms r ON r.room_id = rm.room_id
     WHERE rm.principal_id = ?
       AND rm.status = 'active'
       AND rm.role = 'owner'
       AND r.type = 'group'
       AND r.status = 'active'`
  )
    .bind(principalId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function getPolicy(env: Env, policyId: string): Promise<PolicyRow> {
  const policy = await env.CONTROL_DB.prepare("SELECT * FROM policies WHERE policy_id = ?").bind(policyId).first<PolicyRow>();
  if (!policy) throw new HttpError(404, "policy_not_found", "Policy not found");
  return policy;
}

async function getOwnershipTransfer(env: Env, transferId: string): Promise<JsonObject> {
  const transfer = await env.CONTROL_DB.prepare("SELECT * FROM ownership_transfers WHERE transfer_id = ?")
    .bind(transferId)
    .first<Record<string, unknown>>();
  if (!transfer) throw new HttpError(404, "ownership_transfer_not_found", "Ownership transfer not found");
  return {
    transferId: transfer.transfer_id,
    roomId: transfer.room_id,
    fromPrincipalId: transfer.from_principal_id,
    toPrincipalId: transfer.to_principal_id,
    status: transfer.status,
    expiresAt: transfer.expires_at,
    createdAt: transfer.created_at,
    respondedAt: transfer.responded_at
  };
}

async function createDeliveryReceipts(env: Env, roomId: string, envelopeId: string, senderDeviceId: string): Promise<void> {
  await createDeliveryReceiptStatement(env, roomId, envelopeId, senderDeviceId).run();
}

function createDeliveryReceiptStatement(env: Env, roomId: string, envelopeId: string, senderDeviceId: string): D1PreparedStatement {
  return env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO delivery_receipts (
       receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id, recipient_device_id, status
     )
     SELECT
       'rcp_' || lower(hex(randomblob(18))),
       ?,
       ?,
       rm.account_id,
       rm.principal_id,
       d.device_id,
       'pending'
     FROM room_memberships rm
     JOIN accounts a ON a.account_id = rm.account_id
     JOIN devices d ON d.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND a.status = 'active'
       AND d.revoked_at IS NULL
       AND d.device_id != ?`
  ).bind(envelopeId, roomId, roomId, senderDeviceId);
}

async function markAttachmentsReferenced(env: Env, auth: AuthContext, roomId: string, attachmentIds: string[]): Promise<void> {
  await Promise.all(markAttachmentsReferencedStatements(env, auth, roomId, attachmentIds).map((statement) => statement.run()));
}

function markAttachmentsReferencedStatements(env: Env, auth: AuthContext, roomId: string, attachmentIds: string[]): D1PreparedStatement[] {
  const ids = uniqueStrings(attachmentIds);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return [
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'referenced', referenced_at = CURRENT_TIMESTAMP
       WHERE attachment_id IN (${placeholders})
         AND room_id = ?
         AND uploader_account_id = ?
         AND state = 'uploaded'`
    ).bind(...ids, roomId, auth.account.account_id)
  ];
}

async function getMessage(env: Env, envelopeId: string): Promise<Record<string, unknown> | null> {
  return env.CONTROL_DB.prepare("SELECT * FROM message_envelopes WHERE envelope_id = ?").bind(envelopeId).first<Record<string, unknown>>();
}

async function updateMessageReceiptState(env: Env, envelopeId: string): Promise<void> {
  const pending = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM delivery_receipts WHERE envelope_id = ? AND status = 'pending'")
    .bind(envelopeId)
    .first<{ count: number }>();
  const total = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM delivery_receipts WHERE envelope_id = ?")
    .bind(envelopeId)
    .first<{ count: number }>();
  const state = (total?.count ?? 0) === 0 || (pending?.count ?? 0) === 0 ? "fully_acknowledged" : "partially_acknowledged";
  await env.CONTROL_DB.prepare("UPDATE message_envelopes SET state = ? WHERE envelope_id = ?").bind(state, envelopeId).run();
}

async function getReceipt(env: Env, envelopeId: string, deviceId: string): Promise<JsonObject> {
  const receipt = await env.CONTROL_DB.prepare("SELECT * FROM delivery_receipts WHERE envelope_id = ? AND recipient_device_id = ?")
    .bind(envelopeId, deviceId)
    .first<Record<string, unknown>>();
  if (!receipt) throw new HttpError(404, "receipt_not_found", "Delivery receipt not found");
  return {
    receiptId: receipt.receipt_id,
    envelopeId: receipt.envelope_id,
    roomId: receipt.room_id,
    recipientDeviceId: receipt.recipient_device_id,
    status: receipt.status,
    storedAt: receipt.stored_at,
    readAt: receipt.read_at
  };
}

async function getAttachment(env: Env, attachmentId: string): Promise<AttachmentRow> {
  const attachment = await env.CONTROL_DB.prepare("SELECT * FROM attachments WHERE attachment_id = ?").bind(attachmentId).first<AttachmentRow>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found");
  return attachment;
}

function ensureAttachmentUploader(auth: AuthContext, attachment: AttachmentRow): void {
  if (attachment.uploader_account_id !== auth.account.account_id || attachment.uploader_device_id !== auth.device.device_id) {
    throw new HttpError(403, "attachment_uploader_required", "Only the allocating device can upload or complete this attachment");
  }
}

async function getSidebarCollection(env: Env, auth: AuthContext, collectionId: string): Promise<Record<string, unknown>> {
  const collection = await env.CONTROL_DB.prepare("SELECT * FROM sidebar_collections WHERE collection_id = ? AND account_id = ?")
    .bind(collectionId, auth.account.account_id)
    .first<Record<string, unknown>>();
  if (!collection) throw new HttpError(404, "collection_not_found", "Sidebar collection not found");
  return collection;
}

async function publicSidebarCollection(env: Env, collection: Record<string, unknown>): Promise<JsonObject> {
  const items = await env.CONTROL_DB.prepare("SELECT * FROM sidebar_collection_items WHERE collection_id = ? ORDER BY sort_order ASC, created_at ASC")
    .bind(collection.collection_id)
    .all<Record<string, unknown>>();
  return publicSidebarCollectionFromItems(collection, items.results ?? []);
}

async function publicSidebarCollections(env: Env, collections: Record<string, unknown>[]): Promise<JsonObject[]> {
  if (!collections.length) return [];
  const placeholders = collections.map(() => "?").join(", ");
  const items = await env.CONTROL_DB.prepare(
    `SELECT * FROM sidebar_collection_items
     WHERE collection_id IN (${placeholders})
     ORDER BY collection_id ASC, sort_order ASC, created_at ASC`
  )
    .bind(...collections.map((collection) => collection.collection_id))
    .all<Record<string, unknown>>();
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of items.results ?? []) {
    const collectionId = String(item.collection_id);
    const group = grouped.get(collectionId) ?? [];
    group.push(item);
    grouped.set(collectionId, group);
  }
  return collections.map((collection) => publicSidebarCollectionFromItems(collection, grouped.get(String(collection.collection_id)) ?? []));
}

function publicSidebarCollectionFromItems(collection: Record<string, unknown>, items: Record<string, unknown>[]): JsonObject {
  return {
    collectionId: collection.collection_id,
    accountId: collection.account_id,
    name: collection.name,
    sortOrder: collection.sort_order,
    collapsed: Boolean(collection.collapsed),
    createdAt: collection.created_at,
    updatedAt: collection.updated_at,
    items: items.map((item) => ({
      itemId: item.item_id,
      roomId: item.room_id,
      sortOrder: item.sort_order,
      createdAt: item.created_at
    }))
  };
}

async function getAgentRequest(env: Env, requestId: string): Promise<JsonObject> {
  const request = await env.CONTROL_DB.prepare("SELECT * FROM agent_requests WHERE request_id = ?").bind(requestId).first<Record<string, unknown>>();
  if (!request) throw new HttpError(404, "agent_request_not_found", "Agent request not found");
  return publicAgentRequest(request);
}

function normalizedRole(role: string | undefined, principalType: PrincipalRow["principal_type"]): MembershipRow["role"] {
  if (principalType === "agent") return "agent";
  if (!role) return "member";
  if (["owner", "admin", "member"].includes(role)) return role as MembershipRow["role"];
  throw new HttpError(400, "invalid_room_role", "Room role is invalid");
}

function normalizedInvitationRole(role: string | undefined): RoomInvitationRow["role"] {
  if (!role) return "member";
  if (role === "admin" || role === "member") return role;
  throw new HttpError(400, "invalid_room_invitation_role", "Room invitation role must be admin or member");
}

function publicRoom(room: RoomRow): JsonObject {
  return {
    roomId: room.room_id,
    type: room.type,
    name: room.name,
    description: room.description,
    status: room.status,
    version: room.version,
    createdByAccountId: room.created_by_account_id,
    createdByPrincipalId: room.created_by_principal_id,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
    archivedAt: room.archived_at
  };
}

function publicMembership(membership: MembershipRow): JsonObject {
  return {
    membershipId: membership.membership_id,
    roomId: membership.room_id,
    accountId: membership.account_id,
    principalId: membership.principal_id,
    principalType: membership.principal_type,
    displayName: membership.display_name,
    role: membership.role,
    status: membership.status,
    createdAt: membership.created_at,
    updatedAt: membership.updated_at,
    removedAt: membership.removed_at
  };
}

function publicRoomInvitation(invitation: RoomInvitationRow): JsonObject {
  return {
    roomInvitationId: invitation.room_invitation_id,
    roomId: invitation.room_id,
    roomName: invitation.room_name,
    roomType: invitation.room_type,
    invitedAccountId: invitation.invited_account_id,
    invitedPrincipalId: invitation.invited_principal_id,
    invitedByAccountId: invitation.invited_by_account_id,
    invitedByPrincipalId: invitation.invited_by_principal_id,
    invitedByDisplayName: invitation.invited_by_display_name,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    respondedAt: invitation.responded_at,
    createdAt: invitation.created_at
  };
}

function publicPrincipal(principal: PrincipalRow): JsonObject {
  return {
    principalId: principal.principal_id,
    accountId: principal.account_id,
    principalType: principal.principal_type,
    displayName: principal.display_name,
    avatarRef: principal.avatar_ref,
    status: principal.status,
    ownerPrincipalId: principal.owner_principal_id,
    createdAt: principal.created_at,
    revokedAt: principal.revoked_at
  };
}

function publicDevice(device: DeviceRow): JsonObject {
  return {
    deviceId: device.device_id,
    accountId: device.account_id,
    principalId: device.principal_id,
    platform: device.platform,
    label: device.device_label,
    credentialFingerprint: device.credential_fingerprint,
    credentialVersion: device.credential_version,
    publicKeyPackage: device.public_key_package,
    notificationCapability: device.notification_capability,
    clientVersion: device.client_version,
    protocolVersion: device.protocol_version,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
    revocationReason: device.revocation_reason
  };
}

function publicKeyPackage(row: Record<string, unknown>): JsonObject {
  return {
    keyPackageId: row.key_package_id,
    accountId: row.account_id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    protocol: row.protocol,
    publicIdentityKey: row.public_identity_key,
    signedPrekey: row.signed_prekey,
    oneTimePrekey: row.one_time_prekey,
    package: parseJson(row.package_json),
    status: row.status,
    claimedByDeviceId: row.claimed_by_device_id,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

async function getRawKeyPackage(env: Env, keyPackageId: string): Promise<Record<string, unknown> | null> {
  return env.CONTROL_DB.prepare("SELECT * FROM device_key_packages WHERE key_package_id = ?")
    .bind(keyPackageId)
    .first<Record<string, unknown>>();
}

async function getKeyPackage(env: Env, keyPackageId: string, includePackage: boolean): Promise<JsonObject> {
  const keyPackage = await getRawKeyPackage(env, keyPackageId);
  if (!keyPackage) throw new HttpError(404, "key_package_not_found", "Key package not found");
  return includePackage ? publicKeyPackage(keyPackage) : { keyPackageId };
}

function publicMessage(row: Record<string, unknown>): JsonObject {
  return {
    envelopeId: row.envelope_id,
    roomId: row.room_id,
    senderAccountId: row.sender_account_id,
    senderPrincipalId: row.sender_principal_id,
    senderDeviceId: row.sender_device_id,
    idempotencyKey: row.idempotency_key,
    protocolType: row.protocol_type,
    ciphertext: row.ciphertext,
    ciphertextBytes: row.ciphertext_bytes,
    clientCreatedAt: row.client_created_at,
    serverSequence: row.server_sequence,
    serverReceivedAt: row.server_received_at,
    expiresAt: row.expires_at,
    state: row.state
  };
}

function publicAttachment(attachment: AttachmentRow): JsonObject {
  return {
    attachmentId: attachment.attachment_id,
    roomId: attachment.room_id,
    uploaderAccountId: attachment.uploader_account_id,
    uploaderPrincipalId: attachment.uploader_principal_id,
    uploaderDeviceId: attachment.uploader_device_id,
    state: attachment.state,
    expectedBytes: attachment.expected_bytes,
    ciphertextBytes: attachment.ciphertext_bytes,
    ciphertextSha256: attachment.ciphertext_sha256,
    contentCategory: attachment.content_category,
    retentionClass: attachment.retention_class,
    expiresAt: attachment.expires_at,
    createdAt: attachment.created_at,
    uploadedAt: attachment.uploaded_at,
    referencedAt: attachment.referenced_at,
    deletedAt: attachment.deleted_at
  };
}

function publicAgentRequest(row: Record<string, unknown>): JsonObject {
  return {
    requestId: row.request_id,
    requesterAccountId: row.requester_account_id,
    requesterPrincipalId: row.requester_principal_id,
    desiredAgentName: row.desired_agent_name,
    summary: row.summary,
    status: row.status,
    metadata: parseJson(row.metadata_json),
    reviewedByAccountId: row.reviewed_by_account_id,
    reviewedAt: row.reviewed_at,
    createdAgentPrincipalId: row.created_agent_principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicMaintenanceRun(row: Record<string, unknown>): JsonObject {
  return {
    maintenanceRunId: row.maintenance_run_id,
    action: row.action,
    actorAccountId: row.actor_account_id,
    result: row.result,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at
  };
}

function stringArrayField(body: Record<string, unknown>, key: string, options: { required?: boolean; maxItems?: number } = {}): string[] {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    throw new HttpError(400, "invalid_field", `Field must be an array of strings: ${key}`);
  }
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new HttpError(400, "invalid_field", `Too many items for field: ${key}`);
  }
  return value.map((entry) => entry.trim());
}

function requiredJsonText(body: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = body[key];
  if (value === undefined || value === null) throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) > maxBytes) throw new HttpError(413, "json_too_large", `Field is too large: ${key}`);
  return text;
}

function optionalJsonText(body: Record<string, unknown>, key: string, maxBytes: number): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) > maxBytes) throw new HttpError(413, "json_too_large", `Field is too large: ${key}`);
  return text;
}

function numberField(body: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number {
  const value = body[key];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, "invalid_field", `Field must be an integer between ${min} and ${max}: ${key}`);
  }
  return value;
}

function optionalNumberField(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, "invalid_field", `Field must be an integer between ${min} and ${max}: ${key}`);
  }
  return value;
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_field", `Field must be a boolean: ${key}`);
  return value;
}

function numberParam(url: URL, key: string, min: number, max: number, fallback: number): number {
  const value = url.searchParams.get(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "invalid_query", `Query parameter must be an integer between ${min} and ${max}: ${key}`);
  }
  return parsed;
}

function pageParams(url: URL | undefined, options: { defaultLimit: number; maxLimit: number }): PageParams {
  const limit = url ? numberParam(url, "limit", 1, options.maxLimit, options.defaultLimit) : options.defaultLimit;
  const cursor = url?.searchParams.get("cursor");
  if (!cursor) return { limit, offset: 0 };
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, "invalid_cursor", "Cursor is invalid");
  }
  return { limit, offset };
}

function nextCursor(resultCount: number, page: PageParams): string | null {
  return resultCount === page.limit ? String(page.offset + page.limit) : null;
}

function sendMessageTimingHeaders(metrics: SendMessageMetrics): Record<string, string> {
  return {
    "server-timing": serverTimingHeader([
      ["message", metrics.totalMs],
      ["conversationDo", metrics.conversationDoMs],
      ["context", metrics.contextMs],
      ["insert", metrics.insertMs],
      ["postwrite", metrics.postWriteMs],
      ["realtime", metrics.realtimeMs]
    ])
  };
}

function readTimingHeaders(routeName: string, authMs: number, startedAt: number, extra: Array<[string, number]> = []): Record<string, string> {
  const readMs = durationSince(startedAt);
  return {
    "server-timing": serverTimingHeader([
      [routeName, authMs + readMs],
      ["auth", authMs],
      ["read", readMs],
      ...extra
    ])
  };
}

function finalizeSendMetrics(input: {
  duplicate: boolean;
  startedAt: number;
  contextMs: number;
  insertMs: number;
  postWriteMs: number;
  realtimeMs: number;
}): SendMessageMetrics {
  return {
    duplicate: input.duplicate,
    totalMs: durationSince(input.startedAt),
    contextMs: input.contextMs,
    insertMs: input.insertMs,
    postWriteMs: input.postWriteMs,
    realtimeMs: input.realtimeMs
  };
}

function logSendMessagePerformance(
  requestId: string,
  roomId: string,
  message: Record<string, unknown>,
  metrics: SendMessageMetrics
): void {
  console.info("message.send.performance", {
    requestId,
    roomId,
    envelopeId: message.envelope_id,
    serverSequence: message.server_sequence,
    ...metrics
  });
}

function durationSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

async function runCounted(statement: D1PreparedStatement): Promise<number> {
  const result = await statement.run();
  const meta = result.meta as { changes?: number } | undefined;
  return meta?.changes ?? 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sqliteTimestamp(value: number | Date): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
