// Typed mirror of the Voyager backend contract (the Worker `public*` serializers
// in src/backend.ts and src/index.ts). The backend treats message `ciphertext`,
// attachment blobs and key-package `package` fields as opaque; those meanings
// live on the client (see $lib/protocol/codec).

export type AccountStatus =
	| 'invited'
	| 'active'
	| 'locked'
	| 'suspended'
	| 'pending_deletion'
	| 'deleted';

export interface Account {
	accountId: string;
	status: AccountStatus;
	displayName: string;
	email: string | null;
	phone: string | null;
	policyId: string;
	defaultPrincipalId: string | null;
	createdAt: string;
	activatedAt: string | null;
}

export type PrincipalType = 'human' | 'agent';
export type PrincipalStatus = 'active' | 'suspended' | 'revoked';

export interface Principal {
	principalId: string;
	accountId: string;
	principalType: PrincipalType;
	displayName: string;
	avatarRef?: string | null;
	status: PrincipalStatus;
	ownerPrincipalId?: string | null;
	createdAt: string;
	revokedAt?: string | null;
}

export interface Device {
	deviceId: string;
	accountId: string;
	principalId: string;
	platform: string;
	label: string;
	credentialFingerprint: string | null;
	credentialVersion: number;
	publicKeyPackage?: string | null;
	notificationCapability: string | null;
	clientVersion: string | null;
	protocolVersion: string | null;
	createdAt: string;
	lastSeenAt: string | null;
	revokedAt: string | null;
	revocationReason: string | null;
}

export interface Session {
	sessionId: string;
	accountId: string;
	deviceId: string;
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	riskState: string;
}

export type RoomType = 'direct' | 'group' | 'channel';
export type RoomStatus = 'active' | 'archived' | 'deleted';
export type MemberRole = 'owner' | 'admin' | 'member' | 'agent';
export type MemberStatus = 'invited' | 'active' | 'leaving' | 'removed' | 'banned';

export interface Membership {
	membershipId: string;
	roomId: string;
	accountId: string;
	principalId: string;
	principalType: PrincipalType;
	displayName: string;
	role: MemberRole;
	status: MemberStatus;
	createdAt: string;
	updatedAt: string;
	removedAt: string | null;
}

export interface Room {
	roomId: string;
	type: RoomType;
	name: string | null;
	description: string | null;
	status: RoomStatus;
	version: number;
	createdByAccountId: string;
	createdByPrincipalId: string;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
	members: Membership[];
}

export type MessageState =
	| 'accepted'
	| 'available'
	| 'partially_acknowledged'
	| 'fully_acknowledged'
	| 'expired'
	| 'purged';

export type ProtocolType =
	| 'opaque-test'
	| 'mls_application'
	| 'mls_commit'
	| 'mls_proposal'
	| 'mls_welcome';

export interface MessageEnvelope {
	envelopeId: string;
	roomId: string;
	senderAccountId: string;
	senderPrincipalId: string;
	senderDeviceId: string;
	idempotencyKey: string;
	protocolType: ProtocolType;
	ciphertext: string;
	ciphertextBytes: number;
	clientCreatedAt: string | null;
	serverSequence: number;
	serverReceivedAt: string;
	expiresAt: string;
	state: MessageState;
}

export type ReceiptStatus = 'pending' | 'stored' | 'read';

export interface DeliveryReceipt {
	receiptId: string;
	envelopeId: string;
	roomId: string;
	recipientDeviceId: string;
	status: ReceiptStatus;
	storedAt: string | null;
	readAt: string | null;
}

export type RoomInvitationRole = 'admin' | 'member';
export type RoomInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

export interface RoomInvitation {
	roomInvitationId: string;
	roomId: string;
	roomName: string | null;
	roomType: RoomType;
	invitedAccountId: string;
	invitedPrincipalId: string;
	invitedByAccountId: string;
	invitedByPrincipalId: string;
	invitedByDisplayName: string;
	role: RoomInvitationRole;
	status: RoomInvitationStatus;
	expiresAt: string;
	respondedAt: string | null;
	createdAt: string;
}

export type OwnershipTransferStatus =
	| 'proposed'
	| 'accepted'
	| 'rejected'
	| 'expired'
	| 'cancelled'
	| 'completed';

export interface OwnershipTransfer {
	transferId: string;
	roomId: string;
	fromPrincipalId: string;
	toPrincipalId: string;
	status: OwnershipTransferStatus;
	expiresAt: string;
	createdAt: string;
	respondedAt: string | null;
}

export type AttachmentState =
	| 'allocated'
	| 'uploaded'
	| 'referenced'
	| 'expired'
	| 'deleted'
	| 'quarantined_metadata';

export interface Attachment {
	attachmentId: string;
	roomId: string;
	uploaderAccountId: string;
	uploaderPrincipalId: string;
	uploaderDeviceId: string;
	state: AttachmentState;
	expectedBytes: number;
	ciphertextBytes: number | null;
	ciphertextSha256: string | null;
	contentCategory: string | null;
	retentionClass: string;
	expiresAt: string;
	createdAt: string;
	uploadedAt: string | null;
	referencedAt: string | null;
	deletedAt: string | null;
}

export interface KeyPackage {
	keyPackageId: string;
	accountId: string;
	principalId: string;
	deviceId: string;
	protocol: string;
	publicIdentityKey: string | null;
	signedPrekey: string | null;
	oneTimePrekey: string | null;
	package: unknown;
	status: string;
	claimedByDeviceId: string | null;
	claimedAt: string | null;
	expiresAt: string;
	createdAt: string;
}

export interface SidebarCollectionItem {
	itemId: string;
	roomId: string;
	sortOrder: number;
	createdAt: string;
}

export interface SidebarCollection {
	collectionId: string;
	accountId: string;
	name: string;
	sortOrder: number;
	collapsed: boolean;
	createdAt: string;
	updatedAt: string;
	items: SidebarCollectionItem[];
}

export type AgentRequestStatus =
	| 'submitted'
	| 'under_review'
	| 'approved'
	| 'rejected'
	| 'provisioning'
	| 'active'
	| 'closed';

export interface AgentRequest {
	requestId: string;
	requesterAccountId: string;
	requesterPrincipalId: string;
	desiredAgentName: string;
	summary: string;
	status: AgentRequestStatus;
	metadata: unknown;
	reviewedByAccountId: string | null;
	reviewedAt: string | null;
	createdAgentPrincipalId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Policy {
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
	message_retention_days: number;
	attachment_retention_class: string;
	agent_allowed: number;
	created_at: string;
	updated_at: string;
}

// --- Request payloads ------------------------------------------------------

export interface DeviceInput {
	deviceId?: string;
	platform?: string;
	label?: string;
	credentialFingerprint?: string;
	publicKeyPackage?: string;
	notificationCapability?: string;
	clientVersion?: string;
	protocolVersion?: string;
}

export interface AuthResult {
	account: Account;
	principal: Principal;
	device: Device;
	sessionToken: string;
}

export interface MeResult {
	account: Account;
	principal: Principal;
	device: Device;
	roles: string[];
}

export interface SyncResult {
	rooms: Room[];
	roomsNextCursor: string | null;
	pendingMessages: MessageEnvelope[];
}

export interface SendMessageInput {
	idempotencyKey: string;
	ciphertext: string;
	protocolType: ProtocolType;
	clientCreatedAt?: string;
	attachmentIds?: string[];
}

export interface Paginated<T> {
	items: T[];
	nextCursor: string | null;
}

export interface BootstrapStatus {
	bootstrapped: boolean;
	bootstrapConfigured: boolean;
}
