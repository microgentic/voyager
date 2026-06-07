import { audit, requireAdmin } from "./db";
import { randomId } from "./crypto";
import { HttpError, json, readJsonObject, requireMethod, routeParams, stringField } from "./http";
import type { AccountRow, AuthContext, DeviceRow, Env, PrincipalRow, PolicyRow } from "./types";

const MAX_MESSAGE_BYTES = 262_144;
const MAX_KEY_PACKAGE_BYTES = 16_384;
const DEFAULT_KEY_PACKAGE_DAYS = 30;
const OWNERSHIP_TRANSFER_DAYS = 7;
const DEFAULT_ATTACHMENT_DAYS = 30;

type RouteResult = Response | null;
type JsonObject = Record<string, unknown>;

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

export async function handleBackendFirstRoutes(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  auth: AuthContext
): Promise<RouteResult> {
  if (url.pathname === "/v1/principals") {
    requireMethod(request, "GET");
    return json({ ok: true, principals: await listPrincipals(env) });
  }

  const principalDevicesMatch = routeParams(/^\/v1\/principals\/([^/]+)\/devices$/, url.pathname);
  if (principalDevicesMatch) {
    requireMethod(request, "GET");
    return json({ ok: true, devices: await listPrincipalDevices(env, principalDevicesMatch[1]) });
  }

  const publishKeyPackageMatch = routeParams(/^\/v1\/devices\/([^/]+)\/key-packages$/, url.pathname);
  if (publishKeyPackageMatch) {
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

  if (url.pathname === "/v1/rooms") {
    requireMethod(request, "GET");
    return json({ ok: true, rooms: await listRooms(env, auth) });
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
      const room = await updateRoom(env, auth, roomMatch[1], await readJsonObject(request));
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
    const room = await archiveRoom(env, auth, roomArchiveMatch[1]);
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
    const member = await addRoomMember(env, auth, roomMembersMatch[1], await readJsonObject(request));
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

  const roomMemberRoleMatch = routeParams(/^\/v1\/rooms\/([^/]+)\/members\/([^/]+)\/role$/, url.pathname);
  if (roomMemberRoleMatch) {
    requireMethod(request, "PATCH");
    const body = await readJsonObject(request);
    const member = await updateRoomMemberRole(env, auth, roomMemberRoleMatch[1], roomMemberRoleMatch[2], body);
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
    await removeRoomMember(env, auth, roomMemberRemoveMatch[1], roomMemberRemoveMatch[2]);
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
    await leaveRoom(env, auth, leaveRoomMatch[1]);
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
    const transfer = await proposeOwnershipTransfer(env, auth, proposeTransferMatch[1], await readJsonObject(request));
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
    const transfer = await acceptOwnershipTransfer(env, auth, acceptTransferMatch[1], acceptTransferMatch[2]);
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
      const message = await sendMessageEnvelope(env, auth, messagesMatch[1], await readJsonObject(request));
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "message.send",
        targetType: "room",
        targetId: messagesMatch[1],
        requestId,
        result: "success",
        metadata: { envelopeId: message.envelopeId, sequence: message.serverSequence }
      });
      return json({ ok: true, message }, { status: 201 });
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
    return json({ ok: true, sync: await syncAccount(env, auth, url) });
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
      return json({ ok: true, collections: await listSidebarCollections(env, auth) });
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
      return json({ ok: true, requests: await listOwnAgentRequests(env, auth) });
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
    return json({ ok: true, requests: await listAdminAgentRequests(env) });
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
    return json({ ok: true, rooms: await listAdminRooms(env) });
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

async function claimKeyPackage(env: Env, auth: AuthContext, keyPackageId: string): Promise<JsonObject> {
  const existing = await getRawKeyPackage(env, keyPackageId);
  if (!existing || existing.status !== "available" || String(existing.expires_at) <= sqliteTimestamp(Date.now())) {
    throw new HttpError(404, "key_package_not_available", "Key package is not available");
  }
  if (existing.device_id === auth.device.device_id) {
    throw new HttpError(400, "cannot_claim_own_key_package", "A device cannot claim its own key package");
  }
  await env.CONTROL_DB.prepare(
    "UPDATE device_key_packages SET status = 'claimed', claimed_by_device_id = ?, claimed_at = CURRENT_TIMESTAMP WHERE key_package_id = ? AND status = 'available'"
  )
    .bind(auth.device.device_id, keyPackageId)
    .run();
  return getKeyPackage(env, keyPackageId, true);
}

async function listRooms(env: Env, auth: AuthContext): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare(
    `SELECT r.*
     FROM rooms r
     JOIN room_memberships rm ON rm.room_id = r.room_id
     WHERE rm.principal_id = ? AND rm.status = 'active' AND r.status != 'deleted'
     ORDER BY r.updated_at DESC`
  )
    .bind(auth.principal.principal_id)
    .all<RoomRow>();
  return Promise.all((result.results ?? []).map((room) => publicRoomWithMembers(env, room)));
}

async function createDirectRoom(env: Env, auth: AuthContext, body: Record<string, unknown>): Promise<JsonObject> {
  const targetPrincipalIds = stringArrayField(body, "principalIds", { required: true, maxItems: 7 });
  const uniquePrincipalIds = uniqueStrings([auth.principal.principal_id, ...targetPrincipalIds]);
  if (uniquePrincipalIds.length < 2) {
    throw new HttpError(400, "invalid_direct_room", "Direct rooms need at least two principals");
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
  const uniquePrincipalIds = uniqueStrings([auth.principal.principal_id, ...memberPrincipalIds]);
  const principals = await getActivePrincipals(env, uniquePrincipalIds);
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
  const role = normalizedRole(stringField(body, "role", { max: 20 }), principal.principal_type);
  await enforceMemberQuota(env, auth, roomId);
  await upsertMembership(env, roomId, principal, role, auth.principal.principal_id);
  await bumpRoom(env, roomId);
  return publicMembership(await getMembership(env, roomId, principal.principal_id));
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

async function sendMessageEnvelope(env: Env, auth: AuthContext, roomId: string, body: Record<string, unknown>): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const room = await getRoom(env, roomId);
  if (room.status !== "active") {
    throw new HttpError(409, "room_not_active", "Room is not active");
  }
  const idempotencyKey = stringField(body, "idempotencyKey", { required: true, min: 8, max: 160 })!;
  const existing = await env.CONTROL_DB.prepare("SELECT * FROM message_envelopes WHERE sender_device_id = ? AND idempotency_key = ?")
    .bind(auth.device.device_id, idempotencyKey)
    .first<Record<string, unknown>>();
  if (existing) return publicMessage(existing);

  const ciphertext = stringField(body, "ciphertext", { required: true, min: 1, max: MAX_MESSAGE_BYTES })!;
  const ciphertextBytes = byteLength(ciphertext);
  if (ciphertextBytes > MAX_MESSAGE_BYTES) {
    throw new HttpError(413, "message_too_large", "Encrypted envelope is too large");
  }
  const protocolType = stringField(body, "protocolType", { required: true, max: 60 })!;
  if (!["opaque-test", "mls_application", "mls_commit", "mls_proposal", "mls_welcome"].includes(protocolType)) {
    throw new HttpError(400, "invalid_protocol_type", "Protocol type is not allowed");
  }
  const next = await env.CONTROL_DB.prepare("SELECT COALESCE(MAX(server_sequence), 0) + 1 AS sequence FROM message_envelopes WHERE room_id = ?")
    .bind(roomId)
    .first<{ sequence: number }>();
  const envelopeId = randomId("msg");
  const policy = await getPolicy(env, auth.account.policy_id);
  const expiresAt = sqliteTimestamp(Date.now() + policy.message_retention_days * 24 * 60 * 60 * 1000);
  await env.CONTROL_DB.prepare(
    `INSERT INTO message_envelopes (
      envelope_id, room_id, sender_account_id, sender_principal_id, sender_device_id,
      idempotency_key, protocol_type, ciphertext, ciphertext_bytes, client_created_at,
      server_sequence, expires_at, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')`
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
      stringField(body, "clientCreatedAt", { max: 80 }) ?? null,
      next?.sequence ?? 1,
      expiresAt
    )
    .run();
  await createDeliveryReceipts(env, roomId, envelopeId, auth.device.device_id);
  await markAttachmentsReferenced(env, auth, roomId, stringArrayField(body, "attachmentIds", { maxItems: 20 }));
  await bumpRoom(env, roomId);
  return publicMessage((await getMessage(env, envelopeId)) as Record<string, unknown>);
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
  const rooms = await listRooms(env, auth);
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
  return { rooms, pendingMessages: (result.results ?? []).map(publicMessage) };
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
  return Promise.all((collections.results ?? []).map((collection) => publicSidebarCollection(env, collection)));
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

async function listOwnAgentRequests(env: Env, auth: AuthContext): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM agent_requests WHERE requester_account_id = ? ORDER BY created_at DESC")
    .bind(auth.account.account_id)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(publicAgentRequest);
}

async function listAdminAgentRequests(env: Env): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM agent_requests ORDER BY created_at DESC LIMIT 200").all<Record<string, unknown>>();
  return (result.results ?? []).map(publicAgentRequest);
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

async function listAdminRooms(env: Env): Promise<unknown[]> {
  const result = await env.CONTROL_DB.prepare("SELECT * FROM rooms ORDER BY updated_at DESC LIMIT 200").all<RoomRow>();
  return Promise.all((result.results ?? []).map((room) => publicRoomWithMembers(env, room)));
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
  return { ...publicRoom(room), members: (members.results ?? []).map(publicMembership) };
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

async function enforceMemberQuota(env: Env, auth: AuthContext, roomId: string): Promise<void> {
  const policy = await getPolicy(env, auth.account.policy_id);
  const row = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND status = 'active'")
    .bind(roomId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= policy.maximum_group_memberships) {
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
  const result = await env.CONTROL_DB.prepare(
    `SELECT rm.account_id, rm.principal_id, d.device_id
     FROM room_memberships rm
     JOIN accounts a ON a.account_id = rm.account_id
     JOIN devices d ON d.principal_id = rm.principal_id
     WHERE rm.room_id = ?
       AND rm.status = 'active'
       AND a.status = 'active'
       AND d.revoked_at IS NULL
       AND d.device_id != ?`
  )
    .bind(roomId, senderDeviceId)
    .all<{ account_id: string; principal_id: string; device_id: string }>();
  for (const recipient of result.results ?? []) {
    await env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO delivery_receipts (
        receipt_id, envelope_id, room_id, recipient_account_id, recipient_principal_id, recipient_device_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind(randomId("rcp"), envelopeId, roomId, recipient.account_id, recipient.principal_id, recipient.device_id)
      .run();
  }
}

async function markAttachmentsReferenced(env: Env, auth: AuthContext, roomId: string, attachmentIds: string[]): Promise<void> {
  for (const attachmentId of attachmentIds) {
    await env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'referenced', referenced_at = CURRENT_TIMESTAMP
       WHERE attachment_id = ?
         AND room_id = ?
         AND uploader_account_id = ?
         AND state = 'uploaded'`
    )
      .bind(attachmentId, roomId, auth.account.account_id)
      .run();
  }
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
  return {
    collectionId: collection.collection_id,
    accountId: collection.account_id,
    name: collection.name,
    sortOrder: collection.sort_order,
    collapsed: Boolean(collection.collapsed),
    createdAt: collection.created_at,
    updatedAt: collection.updated_at,
    items: (items.results ?? []).map((item) => ({
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
