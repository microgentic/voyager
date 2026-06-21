import type { DeviceRow, PrincipalRow } from "../types";
import type {
  AttachmentRow,
  CallEventRow,
  CallParticipantRow,
  CallRow,
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
    // Source room/envelope/sender are retained in D1 and the audit log for
    // server-side traceability, but not exposed to target-room members. The
    // public envelope only reveals that the message was forwarded and by whom.
    forwardedFrom: row.forwarded_from_envelope_id
      ? {
          forwardedByPrincipalId: row.forwarded_by_principal_id,
        }
      : null,
    deletedForEveryone: {
      deleted: Boolean(row.deleted_for_everyone_at),
      deletedAt: row.deleted_for_everyone_at ?? null,
      deletedByPrincipalId: row.deleted_by_principal_id ?? null,
      reason: row.deletion_reason ?? null,
    },
    threadRootEnvelopeId: row.thread_root_envelope_id ?? null,
    alsoSentToRoom: Boolean(row.also_sent_to_room),
    // Summary is computed on read from thread replies, so it stays accurate as
    // replies are added, edited, or tombstoned. Null until the first reply.
    threadSummary: Number(row.thread_reply_count ?? 0)
      ? {
          replyCount: Number(row.thread_reply_count ?? 0),
          lastReplyEnvelopeId: row.thread_last_reply_envelope_id ?? null,
          lastReplySenderPrincipalId:
            row.thread_last_reply_sender_principal_id ?? null,
          lastReplyAt: row.thread_last_reply_at ?? null,
        }
      : null,
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
  const variants: JsonObject = {
    original: attachmentVariant(attachment, "original"),
  };
  const preview = attachmentVariant(attachment, "preview");
  if (preview) variants.preview = preview;
  const thumbnail = attachmentVariant(attachment, "thumbnail");
  if (thumbnail) variants.thumbnail = thumbnail;
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
    originalFilename: attachment.original_filename ?? null,
    declaredMimeType: attachment.declared_mime_type ?? null,
    mediaKind: attachment.media_kind ?? "unknown",
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    durationMs: attachment.duration_ms ?? null,
    variants,
    variantManifest: parseJson(attachment.variant_manifest_json),
    expiresAt: attachment.expires_at,
    createdAt: attachment.created_at,
    uploadedAt: attachment.uploaded_at,
    referencedAt: attachment.referenced_at,
    deletedAt: attachment.deleted_at,
  };
}

export function publicCall(
  call: CallRow,
  participants: CallParticipantRow[] = [],
): JsonObject {
  return {
    callId: call.call_id,
    roomId: call.room_id,
    callType: call.call_type,
    status: call.status,
    createdByAccountId: call.created_by_account_id,
    createdByPrincipalId: call.created_by_principal_id,
    createdByDeviceId: call.created_by_device_id,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    endedReason: call.ended_reason,
    createdAt: call.created_at,
    updatedAt: call.updated_at,
    participants: participants.map(publicCallParticipant),
  };
}

export function publicCallParticipant(
  participant: CallParticipantRow,
): JsonObject {
  return {
    callParticipantId: participant.call_participant_id,
    callId: participant.call_id,
    accountId: participant.account_id,
    principalId: participant.principal_id,
    principalType: participant.principal_type,
    displayName: participant.display_name,
    deviceId: participant.device_id,
    role: participant.role,
    status: participant.status,
    joinedAt: participant.joined_at,
    leftAt: participant.left_at,
    mutedAt: participant.muted_at,
    createdAt: participant.created_at,
    updatedAt: participant.updated_at,
  };
}

export function publicCallEvent(event: CallEventRow): JsonObject {
  return {
    callEventId: event.call_event_id,
    callId: event.call_id,
    actorAccountId: event.actor_account_id,
    actorPrincipalId: event.actor_principal_id,
    actorDeviceId: event.actor_device_id,
    eventType: event.event_type,
    payload: parseJson(event.payload_json),
    createdAt: event.created_at,
  };
}

function attachmentVariant(
  attachment: AttachmentRow,
  variant: "original" | "preview" | "thumbnail",
): JsonObject | null {
  const objectKey =
    variant === "original"
      ? (attachment.original_object_key ?? attachment.object_key)
      : variant === "preview"
        ? attachment.preview_object_key
        : attachment.thumbnail_object_key;
  if (!objectKey) return null;
  const bytes =
    variant === "original"
      ? (attachment.original_bytes ?? attachment.ciphertext_bytes)
      : variant === "preview"
        ? attachment.preview_bytes
        : attachment.thumbnail_bytes;
  return {
    variant,
    bytes: bytes ?? null,
    width: variant === "original" || variant === "preview" ? (attachment.width ?? null) : null,
    height: variant === "original" || variant === "preview" ? (attachment.height ?? null) : null,
    downloadPath: `/v1/attachments/${attachment.attachment_id}/blob?variant=${variant}`,
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
