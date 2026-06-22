import type { JsonObject } from "../shared/types";
import type { MembershipRow, RoomInvitationRow, RoomRow } from "./types";

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
