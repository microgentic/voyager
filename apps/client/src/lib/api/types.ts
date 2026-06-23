// Typed mirror of the Voyager backend contract (the Worker `public*` serializers
// in src/backend.ts and src/index.ts). The backend treats message `ciphertext`,
// attachment blobs and key-package `package` fields as opaque; those meanings
// live on the client (see $lib/protocol/codec).

export type ApiSuccess<T extends Record<string, unknown> = Record<string, unknown>> = { ok: true } & T;

export interface ApiErrorBody {
	ok: false;
	error: string;
	message: string;
	requestId: string;
	details?: unknown;
}

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

export type MessagingCoreMode = 'off' | 'shadow' | 'proxy';

export interface MessagingCoreSession {
	enabled: boolean;
	mode: MessagingCoreMode;
	configured: boolean;
	tenantId: string;
	app: string;
	baseUrl: string | null;
	tokenConfig: {
		audience: string;
		issuer: string;
		hmacConfigured: boolean;
		ttlSeconds: number;
	};
	internalService: {
		audience: string;
		issuer: string;
		configured: boolean;
		ttlSeconds: number;
	};
	identitySync:
		| {
				available: boolean;
				required: boolean;
		  }
		| {
				attempted: boolean;
				ok: boolean;
				reason: string | null;
				failedStep: 'tenant' | 'account' | 'principal' | 'device' | null;
				tenantSynced: boolean;
				accountSynced: boolean;
				principalSynced: boolean;
				deviceSynced: boolean;
		  };
	reason: string | null;
	token?: string;
	tokenType?: 'Bearer';
	expiresAt?: string;
	scopes?: string[];
}

export interface MessagingCoreProxyMetadata {
	route: string;
	upstreamStatus: number;
}

export interface MessagingCoreProxyResult {
	messagingCore: MessagingCoreSession;
	proxied: MessagingCoreProxyMetadata;
}

export interface MessagingCoreBootstrapProxyResult extends MessagingCoreProxyResult {
	bootstrap: Record<string, unknown>;
}

export interface MessagingCoreRoomsProxyResult extends MessagingCoreProxyResult {
	rooms: Record<string, unknown>[];
}

export interface MessagingCoreRoomProxyResult extends MessagingCoreProxyResult {
	room: Record<string, unknown>;
	members: Record<string, unknown>[];
}

export interface MessagingCoreMessagesProxyResult extends MessagingCoreProxyResult {
	messages: Record<string, unknown>[];
}

export interface MessagingCoreRealtimeToken {
	realtimeTokenId?: string;
	realtimeToken: string;
	expiresAt: string;
	protocol: string;
	connectPath: string;
}

export interface MessagingCoreRealtimeTokenProxyResult extends MessagingCoreProxyResult {
	realtime: MessagingCoreRealtimeToken;
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
	pinnedMessageCount: number;
	latestPinnedMessageId: string | null;
	members: Membership[];
}

export type CallType = 'audio' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'failed';
export type CallParticipantRole = 'participant' | 'moderator';
export type CallParticipantStatus =
	| 'invited'
	| 'ringing'
	| 'joining'
	| 'connected'
	| 'left'
	| 'declined'
	| 'missed'
	| 'failed';

export interface CallParticipant {
	callParticipantId: string;
	callId: string;
	accountId: string;
	principalId: string;
	principalType: PrincipalType;
	displayName: string;
	deviceId: string | null;
	role: CallParticipantRole;
	status: CallParticipantStatus;
	joinedAt: string | null;
	leftAt: string | null;
	mutedAt: string | null;
	audioEnabled: boolean;
	videoEnabled: boolean;
	screenEnabled: boolean;
	lastSeenAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Call {
	callId: string;
	roomId: string;
	callType: CallType;
	status: CallStatus;
	createdByAccountId: string;
	createdByPrincipalId: string;
	createdByDeviceId: string;
	startedAt: string | null;
	endedAt: string | null;
	endedReason: string | null;
	createdAt: string;
	updatedAt: string;
	participants: CallParticipant[];
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
	editedAt: string | null;
	editCount: number;
	forwardedFrom: MessageForwardedFrom | null;
	deletedForEveryone: MessageDeletedForEveryone;
	threadRootEnvelopeId: string | null;
	alsoSentToRoom: boolean;
	threadSummary: MessageThreadSummary | null;
	receiptSummary: MessageReceiptSummary;
	reactions: MessageReactionSummary[];
	pin: MessagePinSummary;
}

export interface MessageForwardedFrom {
	forwardedByPrincipalId: string;
}

export interface MessageThreadSummary {
	replyCount: number;
	lastReplyEnvelopeId: string | null;
	lastReplySenderPrincipalId: string | null;
	lastReplyAt: string | null;
}

export interface MessageDeletedForEveryone {
	deleted: boolean;
	deletedAt: string | null;
	deletedByPrincipalId: string | null;
	reason: string | null;
}

export interface MessageReceiptSummary {
	total: number;
	pending: number;
	delivered: number;
	read: number;
	status: 'sent' | 'delivered' | 'read';
}

export interface MessageReactionSummary {
	reaction: string;
	count: number;
	reactedByMe: boolean;
}

export interface MessagePinSummary {
	pinned: boolean;
	pinnedAt: string | null;
	pinnedByPrincipalId: string | null;
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

export type AttachmentMediaKind = 'image' | 'video' | 'audio' | 'file' | 'unknown';
export type AttachmentVariantName = 'original' | 'preview' | 'thumbnail';

export interface AttachmentVariant {
	variant: AttachmentVariantName;
	bytes: number | null;
	width: number | null;
	height: number | null;
	downloadPath: string;
}

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
	originalFilename: string | null;
	declaredMimeType: string | null;
	mediaKind: AttachmentMediaKind;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	variants: {
		original: AttachmentVariant;
		preview?: AttachmentVariant;
		thumbnail?: AttachmentVariant;
	};
	variantManifest: unknown;
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
	messagingCore?: MessagingCoreSession;
}

export interface MeResult {
	account: Account;
	principal: Principal;
	device: Device;
	roles: string[];
	messagingCore?: MessagingCoreSession;
}

export interface BootstrapResult extends MeResult {
	rooms: Room[];
	roomsNextCursor: string | null;
	pendingMessages: MessageEnvelope[];
	serverTime: string;
	requestId: string;
}

export interface SyncResult {
	rooms: Room[];
	roomsNextCursor: string | null;
	pendingMessages: MessageEnvelope[];
}

export interface CreateCallInput {
	callType: CallType;
}

export interface CallIceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

export interface CallRealtimeSessionDescription {
	type: 'offer' | 'answer' | 'pranswer' | 'rollback';
	sdp: string;
}

export type CallRealtimeTrackLocation = 'local' | 'remote';
export type CallRealtimeTrackKind = 'audio' | 'video' | 'screen' | 'data';
export interface CallRealtimeSimulcastPolicy {
	preferredRid?: string;
	priorityOrdering?: 'none' | 'asciibetical';
	ridNotAvailable?: 'none' | 'asciibetical';
}

export interface CallRealtimeSession {
	sessionId: string;
	status?: 'active' | 'closed' | 'failed';
	createdAt?: string;
	updatedAt?: string;
	sessionDescription?: CallRealtimeSessionDescription | null;
}

export interface CallRealtimeTrack {
	location: CallRealtimeTrackLocation;
	sessionId?: string;
	trackName: string;
	kind: CallRealtimeTrackKind;
	mid?: string | null;
	qualityLayer?: string | null;
	simulcast?: CallRealtimeSimulcastPolicy;
	principalId?: string;
	deviceId?: string;
	displayName?: string | null;
	principalType?: PrincipalType;
	bidirectionalMediaStream?: boolean;
}

export interface CallRealtimeSessionInput {
	sessionDescription?: CallRealtimeSessionDescription;
}

export interface CallRealtimeTrackInput {
	location: CallRealtimeTrackLocation;
	sessionId?: string;
	trackName?: string;
	kind?: CallRealtimeTrackKind;
	mid?: string | null;
	bidirectionalMediaStream?: boolean;
	simulcast?: CallRealtimeSimulcastPolicy;
}

export interface CallRealtimeTracksInput {
	sessionId?: string;
	sessionDescription?: CallRealtimeSessionDescription;
	tracks?: CallRealtimeTrackInput[];
	autoDiscover?: boolean;
}

export interface CallRealtimeRenegotiateInput {
	sessionId: string;
	sessionDescription: CallRealtimeSessionDescription;
}

export interface CallRealtimeCloseTracksInput {
	sessionId: string;
	sessionDescription?: CallRealtimeSessionDescription;
	tracks: Array<{ mid: string }>;
	force?: boolean;
}

export interface CallFeatureFlags {
	callsEnabled: boolean;
	audioCallsEnabled: boolean;
	videoCallsEnabled: boolean;
	screenShareEnabled: boolean;
	realtimeMediaEnabled: boolean;
}

export interface CallRealtimeConfig {
	provider: 'cloudflare_realtime';
	configured: boolean;
	features?: CallFeatureFlags;
	callId: string;
	callType: CallType;
	status: CallStatus;
	iceServers?: CallIceServer[];
	session?: CallRealtimeSession | null;
	sessionDescription?: CallRealtimeSessionDescription | null;
	tracks?: CallRealtimeTrack[];
	availableTracks?: CallRealtimeTrack[];
	requiresImmediateRenegotiation?: boolean;
	message: string;
}

export interface CallUsageReportTrackInput {
	kind: CallRealtimeTrackKind;
	direction: 'send' | 'receive';
	durationMs?: number;
	bytes?: number;
	qualityLayer?: string | null;
}

export interface CallUsageReportInput {
	sessionId?: string | null;
	durationMs?: number;
	bytesSentEstimate?: number;
	bytesReceivedEstimate?: number;
	tracks?: CallUsageReportTrackInput[];
	network?: {
		candidateType?: string | null;
		relayLikely?: boolean;
		roundTripTimeMs?: number | null;
		packetsLost?: number | null;
	};
}

export interface CallUsageReport {
	usageReportId: string;
	callId: string;
	provider: 'cloudflare_realtime';
	providerSessionId: string | null;
	source: 'client_estimate' | 'provider_authoritative';
	durationMs: number;
	audioDurationMs: number;
	videoDurationMs: number;
	screenDurationMs: number;
	bytesSentEstimate: number;
	bytesReceivedEstimate: number;
	relayLikely: boolean;
	candidateType: string | null;
	createdAt: string;
}

export interface SendMessageInput {
	idempotencyKey: string;
	ciphertext: string;
	protocolType: ProtocolType;
	clientCreatedAt?: string;
	attachmentIds?: string[];
}

export interface ForwardMessageInput extends SendMessageInput {
	targetRoomId: string;
}

export interface ThreadReplyInput extends SendMessageInput {
	alsoSendToRoom?: boolean;
}

export interface ThreadView {
	root: MessageEnvelope;
	replies: MessageEnvelope[];
	olderCursor: string | null;
}

export interface ThreadState {
	rootEnvelopeId: string;
	roomId: string;
	following: boolean;
	muted: boolean;
	lastReadSequence: number;
	updatedAt: string;
}

export interface ThreadInboxItem {
	room: Room;
	root: MessageEnvelope;
	following: boolean;
	muted: boolean;
	unreadCount: number;
	lastReadSequence: number;
	updatedAt: string;
}

export interface EditMessageInput {
	ciphertext: string;
	protocolType: ProtocolType;
	clientEditedAt?: string;
	attachmentIds?: string[];
}

export interface DeleteMessagesResult {
	scope: 'for_me' | 'everyone';
	envelopeIds: string[];
}

export interface Paginated<T> {
	items: T[];
	nextCursor: string | null;
}

export type CursorPage<T> = Paginated<T>;

export interface BootstrapStatus {
	bootstrapped: boolean;
	bootstrapConfigured: boolean;
}

export interface RealtimeTokenResult {
	realtimeToken: string;
	expiresAt: string;
	protocol: string;
	connectPath: string;
	baseUrl: string;
	transport: 'voyager' | 'messaging-core';
}

export interface RealtimeReadyEvent {
	type: 'ready';
	eventId?: string;
	tenantId?: string;
	app?: string;
	accountId: string;
	principalId: string;
	deviceId: string | null;
	protocol?: string;
	createdAt: string;
}

export interface RealtimePongEvent {
	type: 'pong';
	id: string | null;
	createdAt: string;
}

export interface RealtimeRoomMessageEvent {
	type: 'room.message';
	eventId: string;
	createdAt: string;
	roomId: string;
	envelopeId: string;
	serverSequence: number;
	senderDeviceId: string;
}

export interface RealtimeRoomSyncEvent {
	type: 'room.sync';
	eventId: string;
	createdAt: string;
	roomId?: string;
	envelopeId?: string;
	serverSequence?: number;
}

export interface RealtimeRoomThreadEvent {
	type: 'room.thread';
	eventId: string;
	createdAt: string;
	roomId: string;
	envelopeId: string;
	serverSequence: number;
	senderDeviceId: string;
	rootEnvelopeId: string;
	alsoSentToRoom: boolean;
}

export interface RealtimeCallEvent {
	type: 'call.invite' | 'call.ringing' | 'call.joined' | 'call.left' | 'call.ended' | 'call.updated';
	eventId: string;
	createdAt: string;
	roomId: string;
	callId: string;
	callType: CallType;
	status?: CallStatus;
	createdByPrincipalId?: string;
	principalId?: string;
	deviceId?: string;
	reason?: string;
	endedReason?: string;
}

export type RealtimeEvent =
	| RealtimeReadyEvent
	| RealtimePongEvent
	| RealtimeRoomMessageEvent
	| RealtimeRoomSyncEvent
	| RealtimeRoomThreadEvent
	| RealtimeCallEvent;
