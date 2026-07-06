import { getApiBase } from '$lib/config';
import { ApiError } from './errors';
import type {
	Account,
	AgentRequest,
	Attachment,
	AttachmentMediaKind,
	AttachmentVariantName,
	AuthResult,
	BootstrapResult,
	BootstrapStatus,
	Call,
	CallRealtimeCloseTracksInput,
	CallRealtimeConfig,
	CallRealtimeRenegotiateInput,
	CallRealtimeSessionInput,
	CallRealtimeTracksInput,
	CallSignalInput,
	CallSignalResponse,
	CallUsageReport,
	CallUsageReportInput,
	CreateCallInput,
	DeleteMessagesResult,
	DeliveryReceipt,
	Device,
	DeviceInput,
	EditMessageInput,
	ForwardMessageInput,
	KeyPackage,
	MeResult,
	MessagingCoreRealtimeTokenProxyResult,
	Membership,
	MessageEnvelope,
	OwnershipTransfer,
	Paginated,
	Principal,
	RealtimeTokenResult,
	Room,
	RoomInvitation,
	RoomInvitationRole,
	RoomInvitationStatus,
	SendMessageInput,
	Session,
	SidebarCollection,
	SyncResult,
	ThreadReplyInput,
	ThreadInboxItem,
	ThreadState,
	ThreadView
} from './types';

type Json = Record<string, unknown>;
export const MESSAGING_CORE_REALTIME_PROTOCOL = 'messaging.realtime.v1';

export type RealtimeTransport = RealtimeTokenResult['transport'];

export interface RealtimeSocketConnection {
	socket: WebSocket;
	transport: RealtimeTransport;
}

interface RequestOptions {
	json?: Json;
	auth?: boolean;
	query?: Record<string, string | number | undefined>;
	signal?: AbortSignal;
}

/**
 * Thin, typed wrapper over the Voyager Worker HTTP API. One instance is shared
 * app-wide (see $lib/api). The session token is injected by the auth store via
 * `setToken`; a 401 fires `onUnauthorized` so the store can sign out cleanly.
 */
export class VoyagerClient {
	private token: string | null = null;
	onUnauthorized: (() => void) | null = null;

	setToken(token: string | null): void {
		this.token = token;
	}

	async openRealtimeSocket(options: { transport?: 'auto' | RealtimeTransport } = {}): Promise<RealtimeSocketConnection | null> {
		if (!this.token || typeof WebSocket === 'undefined') return null;
		const transport = options.transport ?? 'auto';
		if (transport !== 'auto' && transport !== 'messaging-core') {
			throw new ApiError(400, 'realtime_transport_retired', 'Messaging Core is the only realtime transport.');
		}
		const token = await this.createMessagingCoreRealtimeToken();
		const url = realtimeSocketUrl(token.baseUrl, token.connectPath, token.transport, token.realtimeToken);
		return {
			socket: new WebSocket(url, realtimeSocketProtocols(token)),
			transport: token.transport
		};
	}

	private async createMessagingCoreRealtimeToken(): Promise<RealtimeTokenResult> {
		const res = await this.messagingCoreRealtimeToken();
		if (!res.messagingCore.baseUrl || !res.realtime.realtimeToken || !res.realtime.protocol || !res.realtime.connectPath) {
			throw new ApiError(
				502,
				'messaging_core_realtime_invalid_response',
				'Messaging Core realtime token response is incomplete.'
			);
		}
		return {
			realtimeToken: res.realtime.realtimeToken,
			expiresAt: res.realtime.expiresAt,
			protocol: res.realtime.protocol,
			connectPath: res.realtime.connectPath,
			baseUrl: res.messagingCore.baseUrl,
			transport: 'messaging-core'
		};
	}

	private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const { json, auth = true, query, signal } = options;
		// An empty base means same-origin (relative) — used with a dev proxy or
		// when the client is hosted on the same domain as the Worker.
		const origin = getApiBase() || (typeof location !== 'undefined' ? location.origin : 'http://localhost');
		const url = new URL(path, origin);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== '') {
					url.searchParams.set(key, String(value));
				}
			}
		}

		const headers: Record<string, string> = {};
		if (json !== undefined) headers['content-type'] = 'application/json';
		if (auth && this.token) headers.authorization = `Bearer ${this.token}`;

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body: json !== undefined ? JSON.stringify(json) : undefined,
				signal
			});
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') throw error;
			throw new ApiError(0, 'network_error', (error as Error)?.message ?? 'Network request failed');
		}

		const payload = (await response.json().catch(() => null)) as
			| (Json & { ok?: boolean; error?: string; message?: string; requestId?: string })
			| null;

		if (!response.ok || !payload || payload.ok === false) {
			const code = payload?.error ?? `http_${response.status}`;
			const message = payload?.message ?? response.statusText ?? 'Request failed';
			if (response.status === 401) this.onUnauthorized?.();
			throw new ApiError(response.status, code, message, payload?.requestId, payload?.details);
		}

		return payload as T;
	}

	private async requestBinary(
		method: string,
		path: string,
		body: BodyInit | undefined,
		contentType?: string,
		signal?: AbortSignal
	): Promise<Response> {
		const url = getApiBase() + path;
		const headers: Record<string, string> = {};
		if (contentType) headers['content-type'] = contentType;
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		let response: Response;
		try {
			response = await fetch(url, { method, headers, body, signal });
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') throw error;
			throw new ApiError(0, 'network_error', (error as Error)?.message ?? 'Network request failed');
		}
		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as Json | null;
			if (response.status === 401) this.onUnauthorized?.();
			throw new ApiError(
				response.status,
				(payload?.error as string) ?? `http_${response.status}`,
				(payload?.message as string) ?? 'Request failed',
				payload?.requestId as string | undefined
			);
		}
		return response;
	}

	// --- Public / auth -------------------------------------------------------

	bootstrapStatus(): Promise<BootstrapStatus & { ok: true }> {
		return this.request('GET', '/v1/admin/bootstrap/status', { auth: false });
	}

	login(email: string, password: string, device?: DeviceInput): Promise<AuthResult> {
		return this.request('POST', '/v1/auth/password/login', {
			auth: false,
			json: { email, password, device: device ?? {} }
		});
	}

	acceptInvitation(token: string, password: string, device?: DeviceInput): Promise<AuthResult> {
		return this.request('POST', '/v1/invitations/accept', {
			auth: false,
			json: { token, password, device: device ?? {} }
		});
	}

	completeReset(token: string, password: string, device?: DeviceInput): Promise<AuthResult> {
		return this.request('POST', '/v1/auth/password/reset/complete', {
			auth: false,
			json: { token, password, device: device ?? {} }
		});
	}

	me(): Promise<MeResult> {
		return this.request('GET', '/v1/me');
	}

	session(): Promise<MeResult> {
		return this.request('GET', '/v1/app/session');
	}

	async bootstrap(opts: { limit?: number } = {}): Promise<BootstrapResult> {
		const res = await this.request<{ bootstrap: BootstrapResult }>('GET', '/v1/app/bootstrap', {
			query: { limit: opts.limit }
		});
		return res.bootstrap;
	}

	logout(): Promise<{ ok: true }> {
		return this.request('POST', '/v1/auth/logout');
	}

	async messagingCoreRealtimeToken(): Promise<MessagingCoreRealtimeTokenProxyResult> {
		const res = await this.request<MessagingCoreRealtimeTokenProxyResult & { ok: true }>(
			'POST',
			'/v1/messaging-core/realtime/token'
		);
		return {
			messagingCore: res.messagingCore,
			realtime: res.realtime,
			proxied: res.proxied
		};
	}

	changePassword(currentPassword: string, newPassword: string): Promise<{ ok: true }> {
		return this.request('POST', '/v1/auth/password/change', {
			json: { currentPassword, newPassword }
		});
	}

	// --- Sessions & devices --------------------------------------------------

	async listSessions(): Promise<Session[]> {
		const res = await this.request<{ sessions: Session[] }>('GET', '/v1/sessions');
		return res.sessions;
	}

	revokeSession(sessionId: string): Promise<{ ok: true }> {
		return this.request('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`);
	}

	async listDevices(): Promise<Device[]> {
		const res = await this.request<{ devices: Device[] }>('GET', '/v1/devices');
		return res.devices;
	}

	async createDevice(input: DeviceInput): Promise<Device> {
		const res = await this.request<{ device: Device }>('POST', '/v1/devices', {
			json: input as unknown as Json
		});
		return res.device;
	}

	revokeDevice(deviceId: string, reason?: string): Promise<{ ok: true }> {
		return this.request('POST', `/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {
			json: reason ? { reason } : {}
		});
	}

	// --- Principals & key packages ------------------------------------------

	async listPrincipals(): Promise<Principal[]> {
		const res = await this.request<{ principals: Principal[] }>('GET', '/v1/principals');
		return res.principals;
	}

	async listPrincipalDevices(principalId: string): Promise<Device[]> {
		const res = await this.request<{ devices: Device[] }>(
			'GET',
			`/v1/principals/${encodeURIComponent(principalId)}/devices`
		);
		return res.devices;
	}

	async listPrincipalKeyPackages(principalId: string): Promise<KeyPackage[]> {
		const res = await this.request<{ keyPackages: KeyPackage[] }>(
			'GET',
			`/v1/principals/${encodeURIComponent(principalId)}/key-packages`
		);
		return res.keyPackages;
	}

	async publishKeyPackage(deviceId: string, body: Json): Promise<KeyPackage> {
		const res = await this.request<{ keyPackage: KeyPackage }>(
			'POST',
			`/v1/devices/${encodeURIComponent(deviceId)}/key-packages`,
			{ json: body }
		);
		return res.keyPackage;
	}

	async claimKeyPackage(keyPackageId: string): Promise<KeyPackage> {
		const res = await this.request<{ keyPackage: KeyPackage }>(
			'POST',
			`/v1/key-packages/${encodeURIComponent(keyPackageId)}/claim`
		);
		return res.keyPackage;
	}

	// --- Rooms ---------------------------------------------------------------

	async listRooms(opts: { limit?: number; cursor?: string } = {}): Promise<Paginated<Room>> {
		const res = await this.request<{ rooms: Room[]; nextCursor: string | null }>('GET', '/v1/rooms', {
			query: { limit: opts.limit, cursor: opts.cursor }
		});
		return { items: res.rooms, nextCursor: res.nextCursor };
	}

	async createDirectRoom(principalId: string, name?: string): Promise<Room> {
		const res = await this.request<{ room: Room }>('POST', '/v1/rooms/direct', {
			json: { principalIds: [principalId], name }
		});
		return res.room;
	}

	async createGroupRoom(name: string, description?: string): Promise<Room> {
		const res = await this.request<{ room: Room }>('POST', '/v1/rooms/groups', {
			json: { name, description }
		});
		return res.room;
	}

	async getRoom(roomId: string): Promise<Room> {
		const res = await this.request<{ room: Room }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}`);
		return res.room;
	}

	async updateRoom(
		roomId: string,
		patch: { name?: string; description?: string }
	): Promise<Room> {
		const res = await this.request<{ room: Room }>(
			'PATCH',
			`/v1/rooms/${encodeURIComponent(roomId)}`,
			{ json: patch }
		);
		return res.room;
	}

	async archiveRoom(roomId: string): Promise<Room> {
		const res = await this.request<{ room: Room }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/archive`
		);
		return res.room;
	}

	async addRoomMember(roomId: string, principalId: string, role?: string): Promise<Membership> {
		const res = await this.request<{ member: Membership }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/members`,
			{ json: { principalId, role } }
		);
		return res.member;
	}

	async inviteToRoom(
		roomId: string,
		principalId: string,
		role: RoomInvitationRole = 'member',
		expiresInDays?: number
	): Promise<RoomInvitation> {
		const res = await this.request<{ invitation: RoomInvitation }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/invitations`,
			{ json: { principalId, role, expiresInDays } }
		);
		return res.invitation;
	}

	async listRoomInvitations(
		opts: { status?: RoomInvitationStatus; limit?: number; cursor?: string } = {}
	): Promise<Paginated<RoomInvitation>> {
		const res = await this.request<{ invitations: RoomInvitation[]; nextCursor: string | null }>(
			'GET',
			'/v1/room-invitations',
			{ query: { status: opts.status, limit: opts.limit, cursor: opts.cursor } }
		);
		return { items: res.invitations, nextCursor: res.nextCursor };
	}

	async respondToInvitation(
		roomInvitationId: string,
		action: 'accept' | 'decline'
	): Promise<RoomInvitation> {
		const res = await this.request<{ invitation: RoomInvitation }>(
			'POST',
			`/v1/room-invitations/${encodeURIComponent(roomInvitationId)}/${action}`
		);
		return res.invitation;
	}

	async updateMemberRole(roomId: string, principalId: string, role: string): Promise<Membership> {
		const res = await this.request<{ member: Membership }>(
			'PATCH',
			`/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(principalId)}/role`,
			{ json: { role } }
		);
		return res.member;
	}

	removeMember(roomId: string, principalId: string): Promise<{ ok: true }> {
		return this.request(
			'DELETE',
			`/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(principalId)}`
		);
	}

	leaveRoom(roomId: string): Promise<{ ok: true }> {
		return this.request('POST', `/v1/rooms/${encodeURIComponent(roomId)}/leave`);
	}

	async proposeOwnershipTransfer(roomId: string, toPrincipalId: string): Promise<OwnershipTransfer> {
		const res = await this.request<{ transfer: OwnershipTransfer }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/ownership-transfers`,
			{ json: { toPrincipalId } }
		);
		return res.transfer;
	}

	async acceptOwnershipTransfer(roomId: string, transferId: string): Promise<OwnershipTransfer> {
		const res = await this.request<{ transfer: OwnershipTransfer }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/ownership-transfers/${encodeURIComponent(transferId)}/accept`
		);
		return res.transfer;
	}

	// --- Calls ---------------------------------------------------------------

	async listRoomCalls(
		roomId: string,
		opts: { limit?: number; cursor?: string } = {}
	): Promise<Paginated<Call>> {
		const res = await this.request<{ calls: Call[]; nextCursor: string | null }>(
			'GET',
			`/v1/rooms/${encodeURIComponent(roomId)}/calls`,
			{ query: { limit: opts.limit, cursor: opts.cursor } }
		);
		return { items: res.calls, nextCursor: res.nextCursor };
	}

	async createCall(roomId: string, input: CreateCallInput): Promise<Call> {
		const res = await this.request<{ call: Call }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/calls`,
			{ json: input as unknown as Json }
		);
		return res.call;
	}

	async getCall(callId: string): Promise<Call> {
		const res = await this.request<{ call: Call }>('GET', `/v1/calls/${encodeURIComponent(callId)}`);
		return res.call;
	}

	async joinCall(callId: string): Promise<Call> {
		const res = await this.request<{ call: Call }>('POST', `/v1/calls/${encodeURIComponent(callId)}/join`);
		return res.call;
	}

	async leaveCall(callId: string): Promise<Call> {
		const res = await this.request<{ call: Call }>('POST', `/v1/calls/${encodeURIComponent(callId)}/leave`);
		return res.call;
	}

	async declineCall(callId: string): Promise<Call> {
		const res = await this.request<{ call: Call }>('POST', `/v1/calls/${encodeURIComponent(callId)}/decline`);
		return res.call;
	}

	async muteCall(callId: string): Promise<Call> {
		const res = await this.request<{ call: Call }>('POST', `/v1/calls/${encodeURIComponent(callId)}/mute`);
		return res.call;
	}

	async unmuteCall(callId: string): Promise<Call> {
		const res = await this.request<{ call: Call }>('POST', `/v1/calls/${encodeURIComponent(callId)}/unmute`);
		return res.call;
	}

	async updateCallParticipant(
		callId: string,
		input: {
			muted?: boolean;
			audioEnabled?: boolean;
			videoEnabled?: boolean;
			screenEnabled?: boolean;
			heartbeat?: boolean;
		}
	): Promise<Call> {
		const res = await this.request<{ call: Call }>(
			'PATCH',
			`/v1/calls/${encodeURIComponent(callId)}/participants/me`,
			{ json: input }
		);
		return res.call;
	}

	async getCallRealtimeSessionConfig(
		callId: string,
		input: CallRealtimeSessionInput = {}
	): Promise<CallRealtimeConfig> {
		const res = await this.request<{ realtime: CallRealtimeConfig }>(
			'POST',
			`/v1/calls/${encodeURIComponent(callId)}/realtime/session`,
			{ json: input as unknown as Json }
		);
		return res.realtime;
	}

	async getCallRealtimeTrackConfig(
		callId: string,
		input: CallRealtimeTracksInput = {}
	): Promise<CallRealtimeConfig> {
		const res = await this.request<{ realtime: CallRealtimeConfig }>(
			'POST',
			`/v1/calls/${encodeURIComponent(callId)}/realtime/tracks`,
			{ json: input as unknown as Json }
		);
		return res.realtime;
	}

	async renegotiateCallRealtimeSession(
		callId: string,
		input: CallRealtimeRenegotiateInput
	): Promise<CallRealtimeConfig> {
		const res = await this.request<{ realtime: CallRealtimeConfig }>(
			'POST',
			`/v1/calls/${encodeURIComponent(callId)}/realtime/renegotiate`,
			{ json: input as unknown as Json }
		);
		return res.realtime;
	}

	async closeCallRealtimeTracks(
		callId: string,
		input: CallRealtimeCloseTracksInput
	): Promise<CallRealtimeConfig> {
		const res = await this.request<{ realtime: CallRealtimeConfig }>(
			'POST',
			`/v1/calls/${encodeURIComponent(callId)}/realtime/tracks/close`,
			{ json: input as unknown as Json }
		);
		return res.realtime;
	}

	async sendCallSignal(callId: string, input: CallSignalInput): Promise<CallSignalResponse> {
		const res = await this.request<CallSignalResponse>(
			'POST',
			`/v1/calls/${encodeURIComponent(callId)}/media/signals`,
			{ json: input as unknown as Json }
		);
		return {
			delivered: res.delivered,
			signal: res.signal
		};
	}

	async reportCallUsage(callId: string, input: CallUsageReportInput): Promise<CallUsageReport> {
		const res = await this.request<{ usageReport: CallUsageReport }>(
			'POST',
			`/v1/calls/${encodeURIComponent(callId)}/usage-report`,
			{ json: input as unknown as Json }
		);
		return res.usageReport;
	}

	// --- Messages & sync -----------------------------------------------------

	async listMessages(
		roomId: string,
		opts: { after?: number; limit?: number } = {}
	): Promise<MessageEnvelope[]> {
		const res = await this.request<{ messages: MessageEnvelope[] }>(
			'GET',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages`,
			{ query: { after: opts.after, limit: opts.limit } }
		);
		return res.messages;
	}

	async sendMessage(roomId: string, input: SendMessageInput): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages`,
			{ json: { ...input } }
		);
		return res.message;
	}

	async deleteMessagesForMe(roomId: string, envelopeIds: string[]): Promise<DeleteMessagesResult> {
		const res = await this.request<{ deleted: DeleteMessagesResult }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/delete`,
			{ json: { scope: 'for_me', envelopeIds } }
		);
		return res.deleted;
	}

	async deleteMessagesForEveryone(roomId: string, envelopeIds: string[]): Promise<DeleteMessagesResult> {
		const res = await this.request<{ deleted: DeleteMessagesResult }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/delete`,
			{ json: { scope: 'everyone', envelopeIds } }
		);
		return res.deleted;
	}

	async forwardMessage(
		sourceRoomId: string,
		envelopeId: string,
		input: ForwardMessageInput
	): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(sourceRoomId)}/messages/${encodeURIComponent(envelopeId)}/forward`,
			{ json: { ...input } }
		);
		return res.message;
	}

	async listThreads(params: { limit?: number; cursor?: string | null } = {}): Promise<Paginated<ThreadInboxItem>> {
		const res = await this.request<{ items: ThreadInboxItem[]; nextCursor: string | null }>('GET', '/v1/threads', {
			query: { limit: params.limit, cursor: params.cursor ?? undefined }
		});
		return { items: res.items, nextCursor: res.nextCursor };
	}

	async getThread(
		roomId: string,
		rootEnvelopeId: string,
		params: { limit?: number; after?: number; before?: string | number | null } = {}
	): Promise<ThreadView> {
		const res = await this.request<{ thread: ThreadView }>(
			'GET',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(rootEnvelopeId)}/thread`,
			{ query: { limit: params.limit, after: params.after, before: params.before ?? undefined } }
		);
		return res.thread;
	}

	async markThreadRead(roomId: string, rootEnvelopeId: string): Promise<ThreadState> {
		const res = await this.request<{ threadState: ThreadState }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(rootEnvelopeId)}/thread/read`
		);
		return res.threadState;
	}

	async updateThreadSubscription(
		roomId: string,
		rootEnvelopeId: string,
		input: { following?: boolean; muted?: boolean }
	): Promise<ThreadState> {
		const res = await this.request<{ threadState: ThreadState }>(
			'PATCH',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(rootEnvelopeId)}/thread/subscription`,
			{ json: { ...input } }
		);
		return res.threadState;
	}

	async replyInThread(
		roomId: string,
		rootEnvelopeId: string,
		input: ThreadReplyInput
	): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(rootEnvelopeId)}/thread`,
			{ json: { ...input } }
		);
		return res.message;
	}

	async editMessage(roomId: string, envelopeId: string, input: EditMessageInput): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'PATCH',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(envelopeId)}`,
			{ json: { ...input } }
		);
		return res.message;
	}

	async addReaction(roomId: string, envelopeId: string, reaction: string): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(envelopeId)}/reactions`,
			{ json: { reaction } }
		);
		return res.message;
	}

	async removeReaction(roomId: string, envelopeId: string, reaction: string): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'DELETE',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(envelopeId)}/reactions/${encodeURIComponent(reaction)}`
		);
		return res.message;
	}

	async pinMessage(roomId: string, envelopeId: string): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(envelopeId)}/pin`
		);
		return res.message;
	}

	async unpinMessage(roomId: string, envelopeId: string): Promise<MessageEnvelope> {
		const res = await this.request<{ message: MessageEnvelope }>(
			'DELETE',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(envelopeId)}/pin`
		);
		return res.message;
	}

	async ackMessage(
		roomId: string,
		envelopeId: string,
		status: 'stored' | 'read'
	): Promise<DeliveryReceipt> {
		const res = await this.request<{ receipt: DeliveryReceipt }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(envelopeId)}/ack`,
			{ json: { status } }
		);
		return res.receipt;
	}

	async sync(opts: { limit?: number; since?: string | null } = {}, signal?: AbortSignal): Promise<SyncResult> {
		const res = await this.request<{ sync: SyncResult }>('GET', '/v1/sync', {
			query: { limit: opts.limit, since: opts.since ?? undefined },
			signal
		});
		return res.sync;
	}

	// --- Attachments ---------------------------------------------------------

	async allocateAttachment(
		roomId: string,
		input: {
			expectedBytes: number;
			contentCategory?: string;
			retentionClass?: string;
			originalFilename?: string;
			declaredMimeType?: string;
			mediaKind?: AttachmentMediaKind;
			width?: number;
			height?: number;
			durationMs?: number;
			variantManifest?: unknown;
		}
	): Promise<Attachment> {
		const res = await this.request<{ attachment: Attachment }>(
			'POST',
			`/v1/rooms/${encodeURIComponent(roomId)}/attachments`,
			{ json: input }
		);
		return res.attachment;
	}

	async uploadAttachmentBlob(
		attachmentId: string,
		bytes: ArrayBuffer | Uint8Array | Blob,
		options: { variant?: AttachmentVariantName; contentType?: string; signal?: AbortSignal } = {}
	): Promise<Attachment> {
		const query = options.variant ? `?variant=${encodeURIComponent(options.variant)}` : '';
		const res = await this.requestBinary(
			'PUT',
			`/v1/attachments/${encodeURIComponent(attachmentId)}/blob${query}`,
			bytes as BodyInit,
			options.contentType ?? 'application/octet-stream',
			options.signal
		);
		return (await res.json()).attachment as Attachment;
	}

	async completeAttachment(
		attachmentId: string,
		input: {
			ciphertextSha256?: string;
			ciphertextBytes?: number;
			originalFilename?: string;
			declaredMimeType?: string;
			mediaKind?: AttachmentMediaKind;
			width?: number;
			height?: number;
			durationMs?: number;
			variantManifest?: unknown;
		} = {}
	): Promise<Attachment> {
		const res = await this.request<{ attachment: Attachment }>(
			'POST',
			`/v1/attachments/${encodeURIComponent(attachmentId)}/complete`,
			{ json: input }
		);
		return res.attachment;
	}

	async downloadAttachmentBlob(
		attachmentId: string,
		options: { variant?: AttachmentVariantName; signal?: AbortSignal } = {}
	): Promise<ArrayBuffer> {
		const query = options.variant ? `?variant=${encodeURIComponent(options.variant)}` : '';
		const res = await this.requestBinary(
			'GET',
			`/v1/attachments/${encodeURIComponent(attachmentId)}/blob${query}`,
			undefined,
			undefined,
			options.signal
		);
		return res.arrayBuffer();
	}

	deleteAttachment(attachmentId: string): Promise<{ ok: true }> {
		return this.request('DELETE', `/v1/attachments/${encodeURIComponent(attachmentId)}`);
	}

	// --- Sidebar collections -------------------------------------------------

	async listCollections(): Promise<SidebarCollection[]> {
		const res = await this.request<{ collections: SidebarCollection[] }>(
			'GET',
			'/v1/sidebar-collections'
		);
		return res.collections;
	}

	async createCollection(input: {
		name: string;
		sortOrder?: number;
		collapsed?: boolean;
	}): Promise<SidebarCollection> {
		const res = await this.request<{ collection: SidebarCollection }>(
			'POST',
			'/v1/sidebar-collections',
			{ json: input }
		);
		return res.collection;
	}

	async updateCollection(
		collectionId: string,
		patch: { name?: string; sortOrder?: number; collapsed?: boolean }
	): Promise<SidebarCollection> {
		const res = await this.request<{ collection: SidebarCollection }>(
			'PATCH',
			`/v1/sidebar-collections/${encodeURIComponent(collectionId)}`,
			{ json: patch }
		);
		return res.collection;
	}

	deleteCollection(collectionId: string): Promise<{ ok: true }> {
		return this.request('DELETE', `/v1/sidebar-collections/${encodeURIComponent(collectionId)}`);
	}

	addCollectionItem(
		collectionId: string,
		roomId: string,
		sortOrder?: number
	): Promise<{ ok: true }> {
		return this.request('POST', `/v1/sidebar-collections/${encodeURIComponent(collectionId)}/items`, {
			json: { roomId, sortOrder }
		});
	}

	removeCollectionItem(collectionId: string, roomId: string): Promise<{ ok: true }> {
		return this.request(
			'DELETE',
			`/v1/sidebar-collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(roomId)}`
		);
	}

	// --- Agent requests ------------------------------------------------------

	async listAgentRequests(
		opts: { limit?: number; cursor?: string } = {}
	): Promise<Paginated<AgentRequest>> {
		const res = await this.request<{ requests: AgentRequest[]; nextCursor: string | null }>(
			'GET',
			'/v1/agent-requests',
			{ query: { limit: opts.limit, cursor: opts.cursor } }
		);
		return { items: res.requests, nextCursor: res.nextCursor };
	}

	async createAgentRequest(input: {
		desiredAgentName: string;
		summary: string;
		metadata?: unknown;
	}): Promise<AgentRequest> {
		const res = await this.request<{ request: AgentRequest }>('POST', '/v1/agent-requests', {
			json: input as Json
		});
		return res.request;
	}
}

function realtimeSocketUrl(
	baseUrl: string,
	connectPath: string,
	transport: RealtimeTransport,
	realtimeToken: string
): URL {
	const url = new URL(connectPath, baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	if (transport === 'messaging-core') {
		url.searchParams.set('token', realtimeToken);
	}
	return url;
}

function realtimeSocketProtocols(token: RealtimeTokenResult): string[] {
	if (token.transport === 'messaging-core') return [token.protocol];
	return [token.protocol, token.realtimeToken];
}
