import { SvelteSet } from 'svelte/reactivity';
import { api } from '$lib/api';
import type {
	MessageEnvelope,
	MessageDeletedForEveryone,
	MessageForwardedFrom,
	MessagePinSummary,
	MessageReactionSummary,
	MessageReceiptSummary,
	MessageState,
	MessageThreadSummary,
	ProtocolType,
	AttachmentMediaKind,
	AttachmentVariant,
	AttachmentVariantName
} from '$lib/api/types';
import {
	messageCodec,
	type AttachmentRef,
	type AttachmentRefVariant,
	type DecodedMessage,
	type MessageContent
} from '$lib/protocol/codec';
import { idempotencyKey, localId } from '$lib/utils/id';
import { parseServerDate } from '$lib/utils/time';
import { auth } from './auth.svelte';

export type Delivery = 'sending' | 'sent' | 'failed';

export interface ChatMessage {
	key: string;
	envelopeId: string | null;
	idempotencyKey: string | null;
	roomId: string;
	senderPrincipalId: string;
	senderDeviceId: string | null;
	serverSequence: number;
	serverReceivedAt: string | null;
	clientCreatedAt: string | null;
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
	state: MessageState | 'local';
	protocolType: ProtocolType;
	content: DecodedMessage;
	mine: boolean;
	delivery: Delivery;
}

const READ_KEY = 'voyager.read';
const PAGE = 200;
const READ_ACK_CONCURRENCY = 4;
const READ_ACK_PAUSE_MS = 50;

interface DownloadedAttachmentVariant {
	variant: AttachmentVariantName;
	blob: Blob;
	mimeType: string;
	bytes: number;
	width: number | null;
	height: number | null;
}

interface SendRetryOptions {
	idempotencyKey?: string | null;
	clientCreatedAt?: string | null;
}

interface PendingReadAck {
	roomId: string;
	envelopeId: string;
}

function loadReadState(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(READ_KEY) ?? '{}');
	} catch {
		return {};
	}
}

function order(message: ChatMessage): number {
	return message.serverSequence > 0 ? message.serverSequence : Number.MAX_SAFE_INTEGER;
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
	return list.sort((a, b) => {
		const delta = order(a) - order(b);
		if (delta !== 0) return delta;
		const at = parseServerDate(a.clientCreatedAt ?? a.serverReceivedAt)?.getTime() ?? 0;
		const bt = parseServerDate(b.clientCreatedAt ?? b.serverReceivedAt)?.getTime() ?? 0;
		return at - bt;
	});
}

function mediaKindFromMime(mimeType: string): AttachmentMediaKind {
	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType) return 'file';
	return 'unknown';
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachmentVariantRef(variant: AttachmentVariant, mimeType?: string): AttachmentRefVariant {
	return {
		variant: variant.variant,
		bytes: variant.bytes,
		width: variant.width,
		height: variant.height,
		downloadPath: variant.downloadPath,
		mimeType
	};
}

function deletedContent(): DecodedMessage {
	return {
		schemaVersion: 1,
		contentType: 'text/plain',
		body: '',
		replyToMessageId: null,
		attachments: [],
		senderPrincipalId: null,
		createdAt: null,
		undecodable: false
	};
}

/** Upsert a message into a list, matching an existing entry by envelope or idempotency key. */
function upsertMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
	const next = [...list];
	const idx = next.findIndex(
		(e) =>
			(e.envelopeId && e.envelopeId === message.envelopeId) ||
			(e.idempotencyKey && e.idempotencyKey === message.idempotencyKey)
	);
	if (idx >= 0) next[idx] = message;
	else next.push(message);
	return next;
}

class MessagesStore {
	byRoom = $state<Record<string, ChatMessage[]>>({});
	// Thread replies live here, keyed by root envelope id, so thread-only replies
	// never enter the main timeline (byRoom) or its unread counts.
	threads = $state<Record<string, ChatMessage[]>>({});
	threadOlderCursors = $state<Record<string, string | null>>({});
	lastReadSeq = $state<Record<string, number>>(loadReadState());
	loadedRooms = new SvelteSet<string>();
	loadingRoom = $state<string | null>(null);

	private cursor: Record<string, number> = {};
	private acked = new Set<string>();
	private pendingReadAcks = new Map<string, PendingReadAck>();
	private readAckFlush: Promise<void> | null = null;

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	reset(): void {
		this.byRoom = {};
		this.threads = {};
		this.threadOlderCursors = {};
		this.lastReadSeq = {};
		this.cursor = {};
		this.acked.clear();
		this.pendingReadAcks.clear();
		this.readAckFlush = null;
		this.loadedRooms.clear();
		this.loadingRoom = null;
	}

	list(roomId: string): ChatMessage[] {
		return this.byRoom[roomId] ?? [];
	}

	latest(roomId: string): ChatMessage | undefined {
		const list = this.list(roomId);
		return list.length ? list[list.length - 1] : undefined;
	}

	maxSeq(roomId: string): number {
		let max = 0;
		for (const m of this.list(roomId)) if (m.serverSequence > max) max = m.serverSequence;
		return max;
	}

	unread(roomId: string): number {
		const read = this.lastReadSeq[roomId] ?? 0;
		let count = 0;
		for (const m of this.list(roomId)) if (!m.mine && m.serverSequence > read) count += 1;
		return count;
	}

	totalUnread(): number {
		let total = 0;
		for (const roomId of Object.keys(this.byRoom)) total += this.unread(roomId);
		return total;
	}

	private toChatMessage(env: MessageEnvelope, content: DecodedMessage): ChatMessage {
		return {
			key: env.envelopeId,
			envelopeId: env.envelopeId,
			idempotencyKey: env.idempotencyKey,
			roomId: env.roomId,
			senderPrincipalId: env.senderPrincipalId,
			senderDeviceId: env.senderDeviceId,
			serverSequence: env.serverSequence,
			serverReceivedAt: env.serverReceivedAt,
			clientCreatedAt: env.clientCreatedAt,
			editedAt: env.editedAt ?? null,
			editCount: env.editCount ?? 0,
			forwardedFrom: env.forwardedFrom ?? null,
			deletedForEveryone: env.deletedForEveryone ?? {
				deleted: false,
				deletedAt: null,
				deletedByPrincipalId: null,
				reason: null
			},
			threadRootEnvelopeId: env.threadRootEnvelopeId ?? null,
			alsoSentToRoom: env.alsoSentToRoom ?? false,
			threadSummary: env.threadSummary ?? null,
			receiptSummary: env.receiptSummary ?? { total: 0, pending: 0, delivered: 0, read: 0, status: 'sent' },
			reactions: env.reactions ?? [],
			pin: env.pin ?? { pinned: false, pinnedAt: null, pinnedByPrincipalId: null },
			state: env.state,
			protocolType: env.protocolType,
			content,
			mine: env.senderPrincipalId === auth.principal?.principalId,
			delivery: 'sent'
		};
	}

	private async decodeEnvelopes(envelopes: MessageEnvelope[]): Promise<ChatMessage[]> {
		if (!envelopes.length) return [];
		return Promise.all(
			envelopes.map(async (env) =>
				this.toChatMessage(
					env,
					env.deletedForEveryone?.deleted
						? deletedContent()
						: await messageCodec.decode(env.ciphertext, env.protocolType)
				)
			)
		);
	}

	async ingest(envelopes: MessageEnvelope[]): Promise<void> {
		const decoded = await this.decodeEnvelopes(envelopes);
		if (!decoded.length) return;
		this.applyMessages(decoded);
	}

	/**
	 * Fan a decoded batch into the right stores. Normal messages and thread roots
	 * land in the main timeline; thread replies land in their thread, and replies
	 * that were also sent to the room land in both. Only main-timeline messages
	 * advance the room cursor that drives forward pulls.
	 */
	private applyMessages(decoded: ChatMessage[]): void {
		const nextRooms = { ...this.byRoom };
		const nextThreads = { ...this.threads };
		const touchedRooms = new Set<string>();
		const touchedThreads = new Set<string>();
		for (const m of decoded) {
			const isReply = Boolean(m.threadRootEnvelopeId);
			if (!isReply || m.alsoSentToRoom) {
				nextRooms[m.roomId] = upsertMessage(nextRooms[m.roomId] ?? [], m);
				touchedRooms.add(m.roomId);
				this.cursor[m.roomId] = Math.max(this.cursor[m.roomId] ?? 0, m.serverSequence);
			}
			if (isReply && m.threadRootEnvelopeId) {
				const root = m.threadRootEnvelopeId;
				nextThreads[root] = upsertMessage(nextThreads[root] ?? [], m);
				touchedThreads.add(root);
			}
		}
		for (const roomId of touchedRooms) nextRooms[roomId] = sortMessages(nextRooms[roomId]);
		for (const root of touchedThreads) nextThreads[root] = sortMessages(nextThreads[root]);
		if (touchedRooms.size) this.byRoom = nextRooms;
		if (touchedThreads.size) this.threads = nextThreads;
	}

	threadList(rootEnvelopeId: string): ChatMessage[] {
		return this.threads[rootEnvelopeId] ?? [];
	}

	threadOlderCursor(rootEnvelopeId: string): string | null {
		return this.threadOlderCursors[rootEnvelopeId] ?? null;
	}

	/** Load (or refresh) a thread: its root summary into the main timeline and its replies into the thread store. */
	async openThread(roomId: string, rootEnvelopeId: string): Promise<void> {
		const view = await api.getThread(roomId, rootEnvelopeId);
		const [root, ...replies] = await this.decodeEnvelopes([view.root, ...view.replies]);
		if (root) this.applyMessages([root]);
		this.applyMessages(replies);
		this.threadOlderCursors = { ...this.threadOlderCursors, [rootEnvelopeId]: view.olderCursor };
		this.reconcileThread(rootEnvelopeId, replies, view.olderCursor);
	}

	async loadOlderThreadReplies(roomId: string, rootEnvelopeId: string): Promise<void> {
		const before = this.threadOlderCursor(rootEnvelopeId);
		if (!before) return;
		const view = await api.getThread(roomId, rootEnvelopeId, { before, limit: PAGE });
		const [root, ...replies] = await this.decodeEnvelopes([view.root, ...view.replies]);
		if (root) this.applyMessages([root]);
		this.applyMessages(replies);
		this.threadOlderCursors = { ...this.threadOlderCursors, [rootEnvelopeId]: view.olderCursor };
	}

	/** Refresh a thread after a realtime hint without disturbing optimistic state. */
	async syncThread(roomId: string, rootEnvelopeId: string, serverSequence?: number | null): Promise<void> {
		try {
			await this.openThread(roomId, rootEnvelopeId);
			if (serverSequence && serverSequence > 0) {
				await this.refreshThreadSequence(roomId, rootEnvelopeId, serverSequence);
			}
		} catch {
			/* transient; next hint or manual reopen retries */
		}
	}

	private async refreshThreadSequence(
		roomId: string,
		rootEnvelopeId: string,
		serverSequence: number
	): Promise<void> {
		const view = await api.getThread(roomId, rootEnvelopeId, {
			after: Math.max(0, serverSequence - 1),
			limit: 1
		});
		const [root, ...replies] = await this.decodeEnvelopes([view.root, ...view.replies]);
		if (root) this.applyMessages([root]);
		this.applyMessages(replies);
	}

	/** Pull everything after our cursor (forward-only; the backend has no before-cursor yet). */
	async fetchNew(roomId: string, opts: { overlap?: number } = {}): Promise<void> {
		const current = this.cursor[roomId] ?? 0;
		const after = Math.max(0, current - (opts.overlap ?? 0));
		const envelopes = await api.listMessages(roomId, { after, limit: PAGE });
		await this.ingest(envelopes);
		if (envelopes.length === PAGE) await this.fetchNew(roomId, opts);
	}

	async fetchSequence(roomId: string, serverSequence: number): Promise<void> {
		if (!Number.isFinite(serverSequence) || serverSequence <= 0) {
			await this.fetchNew(roomId, { overlap: 50 });
			return;
		}
		const envelopes = await api.listMessages(roomId, {
			after: Math.max(0, serverSequence - 1),
			limit: 1
		});
		await this.ingest(envelopes.filter((envelope) => envelope.serverSequence === serverSequence));
	}

	async ensureLoaded(roomId: string): Promise<void> {
		if (this.loadedRooms.has(roomId)) return;
		this.loadingRoom = roomId;
		try {
			await this.fetchNew(roomId);
			this.loadedRooms.add(roomId);
		} finally {
			if (this.loadingRoom === roomId) this.loadingRoom = null;
		}
	}

	async sendText(roomId: string, content: MessageContent, options: SendRetryOptions = {}): Promise<void> {
		const principalId = auth.principal?.principalId;
		if (!principalId) throw new Error('Not authenticated');
		const key = options.idempotencyKey ?? idempotencyKey();
		const createdAt = options.clientCreatedAt ?? new Date().toISOString();
		const optimistic: ChatMessage = {
			key: localId('msg'),
			envelopeId: null,
			idempotencyKey: key,
			roomId,
			senderPrincipalId: principalId,
			senderDeviceId: auth.device?.deviceId ?? null,
			serverSequence: 0,
			serverReceivedAt: null,
			clientCreatedAt: createdAt,
			state: 'local',
			editedAt: null,
			editCount: 0,
			forwardedFrom: null,
			deletedForEveryone: { deleted: false, deletedAt: null, deletedByPrincipalId: null, reason: null },
			threadRootEnvelopeId: null,
			alsoSentToRoom: false,
			threadSummary: null,
			receiptSummary: { total: 0, pending: 0, delivered: 0, read: 0, status: 'sent' },
			reactions: [],
			pin: { pinned: false, pinnedAt: null, pinnedByPrincipalId: null },
			protocolType: messageCodec.protocolType,
			content: {
				schemaVersion: 1,
				contentType: content.contentType,
				body: content.body,
				replyToMessageId: content.replyToMessageId ?? null,
				attachments: content.attachments ?? [],
				senderPrincipalId: principalId,
				createdAt,
				undecodable: false
			},
			mine: true,
			delivery: 'sending'
		};
		this.byRoom = {
			...this.byRoom,
			[roomId]: sortMessages([...(this.byRoom[roomId] ?? []), optimistic])
		};

		try {
			const encoded = await messageCodec.encode(content, { senderPrincipalId: principalId, createdAt });
			const envelope = await api.sendMessage(roomId, {
				idempotencyKey: key,
				ciphertext: encoded.ciphertext,
				protocolType: encoded.protocolType,
				clientCreatedAt: createdAt,
				attachmentIds: content.attachments?.map((a) => a.attachmentId)
			});
			await this.ingest([envelope]);
		} catch (error) {
			this.setDelivery(roomId, key, 'failed');
			throw error;
		}
	}

	async editText(message: ChatMessage, content: MessageContent): Promise<void> {
		if (!message.envelopeId || !message.mine || message.delivery !== 'sent') return;
		const createdAt = message.content.createdAt ?? message.clientCreatedAt ?? new Date().toISOString();
		const editedAt = new Date().toISOString();
		const previous = this.list(message.roomId);
		this.byRoom = {
			...this.byRoom,
			[message.roomId]: previous.map((item) =>
				item.key === message.key
					? {
							...item,
							content: {
								...item.content,
								contentType: content.contentType,
								body: content.body,
								replyToMessageId: content.replyToMessageId ?? null,
								attachments: content.attachments ?? item.content.attachments ?? []
							},
							editedAt,
							editCount: Math.max(1, item.editCount)
						}
					: item
			)
		};
		try {
			const encoded = await messageCodec.encode(content, {
				senderPrincipalId: message.senderPrincipalId,
				createdAt
			});
			const envelope = await api.editMessage(message.roomId, message.envelopeId, {
				ciphertext: encoded.ciphertext,
				protocolType: encoded.protocolType,
				clientEditedAt: editedAt,
				attachmentIds: content.attachments?.map((a) => a.attachmentId)
			});
			await this.ingest([envelope]);
		} catch (error) {
			this.byRoom = { ...this.byRoom, [message.roomId]: previous };
			throw error;
		}
	}

	async toggleReaction(message: ChatMessage, reaction: string): Promise<void> {
		if (!message.envelopeId || message.delivery !== 'sent') return;
		const existing = message.reactions.find((item) => item.reaction === reaction);
		const envelope = existing?.reactedByMe
			? await api.removeReaction(message.roomId, message.envelopeId, reaction)
			: await api.addReaction(message.roomId, message.envelopeId, reaction);
		await this.ingest([envelope]);
	}

	async setPinned(message: ChatMessage, pinned: boolean): Promise<void> {
		if (!message.envelopeId || message.delivery !== 'sent') return;
		const envelope = pinned
			? await api.pinMessage(message.roomId, message.envelopeId)
			: await api.unpinMessage(message.roomId, message.envelopeId);
		await this.ingest([envelope]);
	}

	async forwardToRoom(message: ChatMessage, targetRoomId: string): Promise<ChatMessage | null> {
		const principalId = auth.principal?.principalId;
		if (
			!principalId ||
			!message.envelopeId ||
			message.delivery !== 'sent' ||
			message.content.undecodable ||
			message.deletedForEveryone.deleted ||
			message.roomId === targetRoomId
		) {
			return null;
		}
		const createdAt = new Date().toISOString();
		const key = idempotencyKey();
		const clonedAttachments: AttachmentRef[] = [];
		let messageCreated = false;
		try {
			clonedAttachments.push(
				...(await this.cloneAttachmentsForRoom(message.content.attachments ?? [], targetRoomId))
			);
			const encoded = await messageCodec.encode(
				{
					contentType: message.content.contentType,
					body: message.content.body,
					attachments: clonedAttachments
				},
				{ senderPrincipalId: principalId, createdAt }
			);
			const envelope = await api.forwardMessage(message.roomId, message.envelopeId, {
				targetRoomId,
				idempotencyKey: key,
				ciphertext: encoded.ciphertext,
				protocolType: encoded.protocolType,
				clientCreatedAt: createdAt,
				attachmentIds: clonedAttachments.map((attachment) => attachment.attachmentId)
			});
			messageCreated = true;
			await this.ingest([envelope]);
			return this.findByEnvelopeId(targetRoomId, envelope.envelopeId) ?? null;
		} catch (error) {
			if (!messageCreated) {
				await Promise.allSettled(
					clonedAttachments.map((attachment) => api.deleteAttachment(attachment.attachmentId))
				);
			}
			throw error;
		}
	}

	private async cloneAttachmentsForRoom(
		attachments: AttachmentRef[],
		targetRoomId: string
	): Promise<AttachmentRef[]> {
		if (!attachments.length) return [];
		const cloned: AttachmentRef[] = [];
		try {
			for (const attachment of attachments) {
				cloned.push(await this.cloneAttachmentForRoom(attachment, targetRoomId));
			}
			return cloned;
		} catch (error) {
			await Promise.allSettled(
				cloned.map((attachment) => api.deleteAttachment(attachment.attachmentId))
			);
			throw error;
		}
	}

	private async cloneAttachmentForRoom(
		attachment: AttachmentRef,
		targetRoomId: string
	): Promise<AttachmentRef> {
		const variants = await this.downloadAttachmentVariants(attachment);
		const expectedBytes = variants.reduce((sum, item) => sum + item.bytes, 0);
		const original = variants.find((item) => item.variant === 'original') ?? variants[0];
		const mediaKind = attachment.mediaKind ?? mediaKindFromMime(attachment.mediaType);
		const allocated = await api.allocateAttachment(targetRoomId, {
			expectedBytes: Math.max(1, expectedBytes),
			contentCategory: mediaKind,
			originalFilename: attachment.name,
			declaredMimeType: attachment.mediaType || original.mimeType,
			mediaKind,
			width: attachment.width,
			height: attachment.height,
			durationMs: attachment.durationMs,
			variantManifest: {
				forwardedFromAttachmentId: attachment.attachmentId,
				variants: Object.fromEntries(
					variants.map((item) => [
						item.variant,
						{
							bytes: item.bytes,
							mimeType: item.mimeType,
							width: item.width,
							height: item.height
						}
					])
				)
			}
		});
		let latest = allocated;
		try {
			for (const variant of variants) {
				latest = await api.uploadAttachmentBlob(allocated.attachmentId, variant.blob, {
					variant: variant.variant,
					contentType: variant.mimeType
				});
			}
			latest = await api.completeAttachment(allocated.attachmentId, {
				ciphertextBytes: original.bytes,
				originalFilename: attachment.name,
				declaredMimeType: attachment.mediaType || original.mimeType,
				mediaKind,
				width: attachment.width,
				height: attachment.height,
				durationMs: attachment.durationMs,
				variantManifest: {
					forwardedFromAttachmentId: attachment.attachmentId
				}
			});
		} catch (error) {
			void api.deleteAttachment(allocated.attachmentId).catch(() => undefined);
			throw error;
		}
		const mimeTypes = new Map(variants.map((item) => [item.variant, item.mimeType]));
		const refVariants: AttachmentRef['variants'] = {
			original: attachmentVariantRef(latest.variants.original, mimeTypes.get('original'))
		};
		if (latest.variants.preview) {
			refVariants.preview = attachmentVariantRef(latest.variants.preview, mimeTypes.get('preview'));
		}
		if (latest.variants.thumbnail) {
			refVariants.thumbnail = attachmentVariantRef(latest.variants.thumbnail, mimeTypes.get('thumbnail'));
		}
		return {
			...attachment,
			attachmentId: latest.attachmentId,
			mediaKind,
			bytes: latest.variants.original.bytes ?? original.bytes,
			width: latest.width ?? attachment.width,
			height: latest.height ?? attachment.height,
			durationMs: latest.durationMs ?? attachment.durationMs,
			variants: refVariants
		};
	}

	private async downloadAttachmentVariants(attachment: AttachmentRef): Promise<DownloadedAttachmentVariant[]> {
		const names: AttachmentVariantName[] = ['original'];
		if (attachment.variants?.preview) names.push('preview');
		if (attachment.variants?.thumbnail) names.push('thumbnail');
		const variants: DownloadedAttachmentVariant[] = [];
		for (const variant of names) {
			const buffer = await api.downloadAttachmentBlob(attachment.attachmentId, { variant });
			const source = attachment.variants?.[variant];
			const mimeType = source?.mimeType ?? attachment.mediaType ?? 'application/octet-stream';
			variants.push({
				variant,
				blob: new Blob([buffer], { type: mimeType }),
				mimeType,
				bytes: buffer.byteLength,
				width: source?.width ?? (variant === 'original' ? (attachment.width ?? null) : null),
				height: source?.height ?? (variant === 'original' ? (attachment.height ?? null) : null)
			});
		}
		return variants;
	}

	async replyInThread(
		roomId: string,
		rootEnvelopeId: string,
		content: MessageContent,
		alsoSendToRoom: boolean,
		options: SendRetryOptions = {}
	): Promise<void> {
		const principalId = auth.principal?.principalId;
		if (!principalId) throw new Error('Not authenticated');
		const key = options.idempotencyKey ?? idempotencyKey();
		const createdAt = options.clientCreatedAt ?? new Date().toISOString();
		const optimistic: ChatMessage = {
			key: localId('msg'),
			envelopeId: null,
			idempotencyKey: key,
			roomId,
			senderPrincipalId: principalId,
			senderDeviceId: auth.device?.deviceId ?? null,
			serverSequence: 0,
			serverReceivedAt: null,
			clientCreatedAt: createdAt,
			editedAt: null,
			editCount: 0,
			forwardedFrom: null,
			deletedForEveryone: { deleted: false, deletedAt: null, deletedByPrincipalId: null, reason: null },
			threadRootEnvelopeId: rootEnvelopeId,
			alsoSentToRoom: alsoSendToRoom,
			threadSummary: null,
			receiptSummary: { total: 0, pending: 0, delivered: 0, read: 0, status: 'sent' },
			reactions: [],
			pin: { pinned: false, pinnedAt: null, pinnedByPrincipalId: null },
			state: 'local',
			protocolType: messageCodec.protocolType,
			content: {
				schemaVersion: 1,
				contentType: content.contentType,
				body: content.body,
				replyToMessageId: null,
				attachments: content.attachments ?? [],
				senderPrincipalId: principalId,
				createdAt,
				undecodable: false
			},
			mine: true,
			delivery: 'sending'
		};
		this.applyMessages([optimistic]);
		try {
			const encoded = await messageCodec.encode(content, { senderPrincipalId: principalId, createdAt });
			const envelope = await api.replyInThread(roomId, rootEnvelopeId, {
				idempotencyKey: key,
				ciphertext: encoded.ciphertext,
				protocolType: encoded.protocolType,
				clientCreatedAt: createdAt,
				attachmentIds: content.attachments?.map((a) => a.attachmentId),
				alsoSendToRoom
			});
			await this.ingest([envelope]);
			// Refresh the root summary so the main-timeline root reflects the new count.
			void this.syncThread(roomId, rootEnvelopeId);
		} catch (error) {
			this.setThreadDelivery(rootEnvelopeId, key, 'failed', alsoSendToRoom ? roomId : null);
			throw error;
		}
	}

	private setThreadDelivery(
		rootEnvelopeId: string,
		idemKey: string,
		delivery: Delivery,
		roomId: string | null
	): void {
		const patch = (list: ChatMessage[]): ChatMessage[] => {
			const idx = list.findIndex((m) => m.idempotencyKey === idemKey);
			if (idx < 0) return list;
			const copy = [...list];
			copy[idx] = { ...copy[idx], delivery };
			return copy;
		};
		if (this.threads[rootEnvelopeId]) {
			this.threads = { ...this.threads, [rootEnvelopeId]: patch(this.threads[rootEnvelopeId]) };
		}
		if (roomId && this.byRoom[roomId]) {
			this.byRoom = { ...this.byRoom, [roomId]: patch(this.byRoom[roomId]) };
		}
	}

	private reconcileThread(
		rootEnvelopeId: string,
		serverReplies: ChatMessage[],
		olderCursor: string | null
	): void {
		const serverEnvelopeIds = new Set(serverReplies.map((m) => m.envelopeId).filter(Boolean));
		const serverIdempotencyKeys = new Set(serverReplies.map((m) => m.idempotencyKey).filter(Boolean));
		const oldestReturned = olderCursor ? Number(olderCursor) : null;
		const optimistic = this.threadList(rootEnvelopeId).filter((m) => {
			if (
				oldestReturned !== null &&
				Number.isFinite(oldestReturned) &&
				m.delivery === 'sent' &&
				m.serverSequence > 0 &&
				m.serverSequence < oldestReturned
			) {
				return true;
			}
			if (m.delivery === 'sent' && m.envelopeId) return false;
			if (m.envelopeId && serverEnvelopeIds.has(m.envelopeId)) return false;
			if (m.idempotencyKey && serverIdempotencyKeys.has(m.idempotencyKey)) return false;
			return true;
		});
		this.threads = {
			...this.threads,
			[rootEnvelopeId]: sortMessages([...serverReplies, ...optimistic])
		};
	}

	private threadRootsForEnvelopeIds(roomId: string, envelopeIds: string[]): string[] {
		const ids = new Set(envelopeIds);
		const roots = new Set<string>();
		for (const message of this.list(roomId)) {
			if (!message.envelopeId || !ids.has(message.envelopeId)) continue;
			if (message.threadRootEnvelopeId) roots.add(message.threadRootEnvelopeId);
		}
		for (const [rootEnvelopeId, list] of Object.entries(this.threads)) {
			if (
				list.some(
					(message) =>
						message.roomId === roomId && message.envelopeId && ids.has(message.envelopeId)
				)
			) {
				roots.add(rootEnvelopeId);
			}
		}
		return Array.from(roots);
	}

	async retry(message: ChatMessage): Promise<void> {
		if (message.delivery !== 'failed') return;
		const retryOptions: SendRetryOptions = {
			idempotencyKey: message.idempotencyKey,
			clientCreatedAt: message.clientCreatedAt ?? message.content.createdAt
		};
		// Drop the failed placeholder and resend its content through the right path.
		if (message.threadRootEnvelopeId) {
			const root = message.threadRootEnvelopeId;
			this.threads = {
				...this.threads,
				[root]: this.threadList(root).filter((m) => m.key !== message.key)
			};
			if (message.alsoSentToRoom) {
				this.byRoom = {
					...this.byRoom,
					[message.roomId]: this.list(message.roomId).filter((m) => m.key !== message.key)
				};
			}
			await this.replyInThread(
				message.roomId,
				root,
				{
					contentType: message.content.contentType,
					body: message.content.body,
					attachments: message.content.attachments
				},
				message.alsoSentToRoom,
				retryOptions
			);
			return;
		}
		this.byRoom = {
			...this.byRoom,
			[message.roomId]: this.list(message.roomId).filter((m) => m.key !== message.key)
		};
		await this.sendText(message.roomId, {
			contentType: message.content.contentType,
			body: message.content.body,
			replyToMessageId: message.content.replyToMessageId,
			attachments: message.content.attachments
		}, retryOptions);
	}

	async deleteForMe(roomId: string, envelopeIds: string[]): Promise<string[]> {
		const ids = Array.from(new Set(envelopeIds.filter(Boolean)));
		if (!ids.length) return [];
		const result = await api.deleteMessagesForMe(roomId, ids);
		const threadRoots = this.threadRootsForEnvelopeIds(roomId, result.envelopeIds);
		this.removeEnvelopeIds(roomId, result.envelopeIds);
		for (const rootEnvelopeId of threadRoots) void this.syncThread(roomId, rootEnvelopeId);
		return result.envelopeIds;
	}

	async deleteForEveryone(roomId: string, envelopeIds: string[]): Promise<string[]> {
		const ids = Array.from(new Set(envelopeIds.filter(Boolean)));
		if (!ids.length) return [];
		const result = await api.deleteMessagesForEveryone(roomId, ids);
		this.markDeletedForEveryone(roomId, result.envelopeIds);
		return result.envelopeIds;
	}

	markDeletedForEveryone(roomId: string, envelopeIds: string[]): void {
		const ids = new Set(envelopeIds);
		if (!ids.size) return;
		const deletedAt = new Date().toISOString();
		const tombstone = (message: ChatMessage): ChatMessage =>
			message.envelopeId && ids.has(message.envelopeId)
				? {
						...message,
						content: deletedContent(),
						deletedForEveryone: {
							deleted: true,
							deletedAt,
							deletedByPrincipalId: auth.principal?.principalId ?? null,
							reason: null
						},
						reactions: [],
						pin: { pinned: false, pinnedAt: null, pinnedByPrincipalId: null }
					}
				: message;
		// A deleted message may be a main message, a thread root, or a thread reply
		// (and an also-sent reply lives in both stores), so patch wherever it appears.
		this.byRoom = { ...this.byRoom, [roomId]: this.list(roomId).map(tombstone) };
		const nextThreads = { ...this.threads };
		let changed = false;
		for (const [root, list] of Object.entries(this.threads)) {
			if (list.some((m) => m.envelopeId && ids.has(m.envelopeId))) {
				nextThreads[root] = list.map(tombstone);
				changed = true;
			}
		}
		if (changed) this.threads = nextThreads;
	}

	removeEnvelopeIds(roomId: string, envelopeIds: string[]): void {
		const ids = new Set(envelopeIds);
		if (!ids.size) return;
		this.byRoom = {
			...this.byRoom,
			[roomId]: this.list(roomId).filter((m) => !m.envelopeId || !ids.has(m.envelopeId))
		};
		const nextThreads = { ...this.threads };
		let changed = false;
		for (const [rootEnvelopeId, list] of Object.entries(this.threads)) {
			const filtered = list.filter((m) => !m.envelopeId || !ids.has(m.envelopeId));
			if (filtered.length !== list.length) {
				nextThreads[rootEnvelopeId] = filtered;
				changed = true;
			}
		}
		if (changed) this.threads = nextThreads;
	}

	removeKeys(roomId: string, keys: string[]): void {
		const keySet = new Set(keys);
		if (!keySet.size) return;
		this.byRoom = {
			...this.byRoom,
			[roomId]: this.list(roomId).filter((m) => !keySet.has(m.key))
		};
	}

	findByEnvelopeId(roomId: string, envelopeId: string | null | undefined): ChatMessage | undefined {
		if (!envelopeId) return undefined;
		return this.list(roomId).find((message) => message.envelopeId === envelopeId);
	}

	private setDelivery(roomId: string, idemKey: string, delivery: Delivery): void {
		const list = this.list(roomId);
		const idx = list.findIndex((m) => m.idempotencyKey === idemKey);
		if (idx < 0) return;
		const copy = [...list];
		copy[idx] = { ...copy[idx], delivery };
		this.byRoom = { ...this.byRoom, [roomId]: copy };
	}

	private queueReadAck(roomId: string, envelopeId: string): void {
		this.pendingReadAcks.set(envelopeId, { roomId, envelopeId });
		if (!this.readAckFlush) this.readAckFlush = this.flushReadAcks();
	}

	private async flushReadAcks(): Promise<void> {
		try {
			while (this.pendingReadAcks.size) {
				const batch = Array.from(this.pendingReadAcks.values()).slice(0, READ_ACK_CONCURRENCY);
				for (const item of batch) this.pendingReadAcks.delete(item.envelopeId);
				const results = await Promise.allSettled(
					batch.map((item) => api.ackMessage(item.roomId, item.envelopeId, 'read'))
				);
				results.forEach((result, index) => {
					if (result.status === 'rejected') this.acked.delete(batch[index].envelopeId);
				});
				if (this.pendingReadAcks.size) await wait(READ_ACK_PAUSE_MS);
			}
		} finally {
			this.readAckFlush = null;
			if (this.pendingReadAcks.size) this.readAckFlush = this.flushReadAcks();
		}
	}

	/** Mark a room as read locally and acknowledge others' messages to the server. */
	markRead(roomId: string): void {
		const max = this.maxSeq(roomId);
		if ((this.lastReadSeq[roomId] ?? 0) < max) {
			this.lastReadSeq = { ...this.lastReadSeq, [roomId]: max };
			try {
				localStorage.setItem(READ_KEY, JSON.stringify(this.lastReadSeq));
			} catch {
				/* ignore */
			}
		}
		for (const m of this.list(roomId)) {
			if (m.mine || !m.envelopeId || this.acked.has(m.envelopeId)) continue;
			this.acked.add(m.envelopeId);
			this.queueReadAck(roomId, m.envelopeId);
		}
	}

	/** Acknowledge thread replies as read while a thread is open. */
	markThreadRead(roomId: string, rootEnvelopeId: string): void {
		for (const m of this.threadList(rootEnvelopeId)) {
			if (m.mine || !m.envelopeId || this.acked.has(m.envelopeId)) continue;
			this.acked.add(m.envelopeId);
			this.queueReadAck(roomId, m.envelopeId);
		}
	}

	dropRoom(roomId: string): void {
		const next = { ...this.byRoom };
		delete next[roomId];
		this.byRoom = next;
		this.loadedRooms.delete(roomId);
		delete this.cursor[roomId];
	}
}

export const messages = new MessagesStore();
