import type { AccountRow, PrincipalRow } from "../../types";

export const OWNERSHIP_TRANSFER_DAYS = 7;
export const ROOM_INVITATION_DAYS = 7;

export interface PrincipalRecord extends PrincipalRow {
  account_status: AccountRow["status"];
}

export interface RoomRow {
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
  pinned_message_count?: number;
  latest_pinned_message_id?: string | null;
}

export interface MembershipRow {
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

export interface SendRoomContext extends MembershipRow {
  room_status: RoomRow["status"];
  message_retention_days: number;
}

export interface RoomInvitationRow {
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
