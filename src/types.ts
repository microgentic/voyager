export interface Env {
  CONTROL_DB: D1Database;
  ATTACHMENTS_BUCKET: R2Bucket;
  REALTIME_MAILBOX: DurableObjectNamespace;
  CONVERSATION_COORDINATOR: DurableObjectNamespace;
  CALL_COORDINATOR: DurableObjectNamespace;
  MESSAGING_CORE_SERVICE?: Fetcher;
  BOOTSTRAP_TOKEN?: string;
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_APP_SECRET?: string;
  CLOUDFLARE_REALTIME_API_BASE?: string;
  CLOUDFLARE_REALTIME_TURN_USERNAME?: string;
  CLOUDFLARE_REALTIME_TURN_CREDENTIAL?: string;
  CLOUDFLARE_REALTIME_MOCK?: string;
  CALLS_ENABLED?: string;
  AUDIO_CALLS_ENABLED?: string;
  VIDEO_CALLS_ENABLED?: string;
  SCREEN_SHARE_ENABLED?: string;
  CALLS_REALTIME_MEDIA_ENABLED?: string;
  CALL_RING_TIMEOUT_MS?: string;
  CALL_PARTICIPANT_LIVENESS_TIMEOUT_MS?: string;
  VOYAGER_MESSAGING_CORE_MODE?: string;
  VOYAGER_MESSAGING_CORE_ROOM_CUTOVER?: string;
  VOYAGER_MESSAGING_CORE_MESSAGE_CUTOVER?: string;
  VOYAGER_MESSAGING_CORE_TIMEOUT_MS?: string;
  MESSAGING_CORE_BASE_URL?: string;
  MESSAGING_CORE_TENANT_ID?: string;
  MESSAGING_CORE_TENANT_EXTERNAL_REF?: string;
  MESSAGING_CORE_TENANT_DISPLAY_NAME?: string;
  MESSAGING_CORE_APP_ID?: string;
  MESSAGING_CORE_TOKEN_SECRET?: string;
  MESSAGING_CORE_TOKEN_ISSUER?: string;
  MESSAGING_CORE_TOKEN_AUDIENCE?: string;
  MESSAGING_CORE_TOKEN_TTL_SECONDS?: string;
  MESSAGING_CORE_INTERNAL_SERVICE_SECRET?: string;
  MESSAGING_CORE_INTERNAL_SERVICE_ISSUER?: string;
  MESSAGING_CORE_INTERNAL_SERVICE_AUDIENCE?: string;
  MESSAGING_CORE_INTERNAL_SERVICE_TTL_SECONDS?: string;
  // Comma-separated extra origins allowed by CORS (e.g. the production web host).
  // Dev/localhost and Tauri app origins are always allowed.
  CORS_ALLOWED_ORIGINS?: string;
}

export interface AccountRow {
  account_id: string;
  status: AccountStatus;
  display_name: string;
  email: string | null;
  phone: string | null;
  policy_id: string;
  default_principal_id: string | null;
  activated_at: string | null;
  suspended_at: string | null;
  deletion_state: string | null;
  created_at: string;
  updated_at: string;
}

export type AccountStatus = "invited" | "active" | "locked" | "suspended" | "pending_deletion" | "deleted";

export interface PrincipalRow {
  principal_id: string;
  account_id: string;
  principal_type: "human" | "agent";
  display_name: string;
  avatar_ref: string | null;
  status: "active" | "suspended" | "revoked";
  owner_principal_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface PolicyRow {
  policy_id: string;
  name: string;
  require_passkey_or_mfa: number;
  require_local_lock: number;
  require_email: number;
  require_phone: number;
  maximum_devices: number;
  maximum_owned_groups: number;
  maximum_group_memberships: number;
  maximum_attachment_bytes: number;
  maximum_attachments_per_message: number;
  maximum_image_dimension: number;
  daily_attachment_bytes_per_account: number;
  daily_attachment_bytes_per_room: number;
  message_retention_days: number;
  attachment_retention_class: string;
  agent_allowed: number;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  device_id: string;
  account_id: string;
  principal_id: string;
  platform: string;
  device_label: string;
  credential_fingerprint: string | null;
  credential_version: number;
  public_key_package: string | null;
  notification_capability: string | null;
  client_version: string | null;
  protocol_version: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export interface SessionRow {
  session_id: string;
  account_id: string;
  device_id: string;
  refresh_token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  risk_state: string;
}

export interface AuthContext {
  account: AccountRow;
  principal: PrincipalRow;
  device: DeviceRow;
  session: SessionRow;
  roles: string[];
}

export interface DeviceInput {
  deviceId?: unknown;
  platform?: unknown;
  label?: unknown;
  credentialFingerprint?: unknown;
  publicKeyPackage?: unknown;
  notificationCapability?: unknown;
  clientVersion?: unknown;
  protocolVersion?: unknown;
}
