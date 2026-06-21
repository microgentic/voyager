import type { DeviceRow, PrincipalRow } from "../types";
import type {
  AttachmentRow,
  JsonObject,
  MembershipRow,
  RoomInvitationRow,
  RoomRow,
} from "./internal-types";
import { parseJson } from "./utils";

export function publicRoom(room: RoomRow): JsonObject {
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
    archivedAt: room.archived_at,
    pinnedMessageCount: Number(room.pinned_message_count ?? 0),
    latestPinnedMessageId: room.latest_pinned_message_id ?? null,
  };
}

export function publicMembership(membership: MembershipRow): JsonObject {
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
    removedAt: membership.removed_at,
  };
}

export function publicRoomInvitation(
  invitation: RoomInvitationRow,
): JsonObject {
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
    createdAt: invitation.created_at,
  };
}

export function publicPrincipal(principal: PrincipalRow): JsonObject {
  return {
    principalId: principal.principal_id,
    accountId: principal.account_id,
    principalType: principal.principal_type,
    displayName: principal.display_name,
    avatarRef: principal.avatar_ref,
    status: principal.status,
    ownerPrincipalId: principal.owner_principal_id,
    createdAt: principal.created_at,
    revokedAt: principal.revoked_at,
  };
}

export function publicDevice(device: DeviceRow): JsonObject {
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
    revocationReason: device.revocation_reason,
  };
}

export function publicKeyPackage(row: Record<string, unknown>): JsonObject {
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
    createdAt: row.created_at,
  };
}

export function publicMessage(row: Record<string, unknown>): JsonObject {
  const receiptTotal = Number(row.receipt_total ?? 0);
  const receiptPending = Number(row.receipt_pending ?? 0);
  const receiptDelivered = Number(row.receipt_delivered ?? 0);
  const receiptRead = Number(row.receipt_read ?? 0);
  const receiptStatus =
    receiptRead > 0
      ? "read"
      : receiptDelivered > 0
        ? "delivered"
        : "sent";
  const reactions = normalizeReactionSummary(row.reaction_summary);
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
    state: row.state,
    editedAt: row.edited_at ?? null,
    editCount: Number(row.edit_count ?? 0),
    receiptSummary: {
      total: receiptTotal,
      pending: receiptPending,
      delivered: receiptDelivered,
      read: receiptRead,
      status: receiptStatus,
    },
    reactions,
    pin: {
      pinned: Boolean(row.pinned_at),
      pinnedAt: row.pinned_at ?? null,
      pinnedByPrincipalId: row.pinned_by_principal_id ?? null,
    },
  };
}

function normalizeReactionSummary(value: unknown): JsonObject[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const summary: JsonObject[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const reaction = (entry as Record<string, unknown>).reaction;
    const count = (entry as Record<string, unknown>).count;
    const reactedByMe = (entry as Record<string, unknown>).reactedByMe;
    if (typeof reaction !== "string") continue;
    summary.push({
      reaction,
      count: Number(count ?? 0),
      reactedByMe: Boolean(reactedByMe),
    });
  }
  return summary;
}

export function publicAttachment(attachment: AttachmentRow): JsonObject {
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
    deletedAt: attachment.deleted_at,
  };
}

export function publicAgentRequest(row: Record<string, unknown>): JsonObject {
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
    updatedAt: row.updated_at,
  };
}

export function publicMaintenanceRun(row: Record<string, unknown>): JsonObject {
  return {
    maintenanceRunId: row.maintenance_run_id,
    action: row.action,
    actorAccountId: row.actor_account_id,
    result: row.result,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}
