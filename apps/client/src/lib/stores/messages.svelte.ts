import { SvelteSet } from 'svelte/reactivity';
import { api } from '$lib/api';
import type { MessageEnvelope, MessageState, ProtocolType } from '$lib/api/types';
import { messageCodec, type DecodedMessage, type MessageContent } from '$lib/protocol/codec';
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
	state: MessageState | 'local';
	protocolType: ProtocolType;
	content: DecodedMessage;
	mine: boolean;
	delivery: Delivery;
}

const READ_KEY = 'voyager.read';
const PAGE = 200;

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

class MessagesStore {
	byRoom = $state<Record<string, ChatMessage[]>>({});
	lastReadSeq = $state<Record<string, number>>(loadReadState());
	loadedRooms = new SvelteSet<string>();
	loadingRoom = $state<string | null>(null);

	private cursor: Record<string, number> = {};
	private acked = new Set<string>();

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	reset(): void {
		this.byRoom = {};
		this.lastReadSeq = {};
		this.cursor = {};
		this.acked.clear();
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
			state: env.state,
			protocolType: env.protocolType,
			content,
			mine: env.senderPrincipalId === auth.principal?.principalId,
			delivery: 'sent'
		};
	}

	async ingest(envelopes: MessageEnvelope[]): Promise<void> {
		if (!envelopes.length) return;
		const decoded = await Promise.all(
			envelopes.map(async (env) => this.toChatMessage(env, await messageCodec.decode(env.ciphertext, env.protocolType)))
		);
		const next = { ...this.byRoom };
		const grouped = new Map<string, ChatMessage[]>();
		for (const m of decoded) {
			const arr = grouped.get(m.roomId) ?? [];
			arr.push(m);
			grouped.set(m.roomId, arr);
		}
		for (const [roomId, incoming] of grouped) {
			const existing = next[roomId] ? [...next[roomId]] : [];
			for (const m of incoming) {
				const idx = existing.findIndex(
					(e) =>
						(e.envelopeId && e.envelopeId === m.envelopeId) ||
						(e.idempotencyKey && e.idempotencyKey === m.idempotencyKey)
				);
				if (idx >= 0) existing[idx] = m;
				else existing.push(m);
				this.cursor[roomId] = Math.max(this.cursor[roomId] ?? 0, m.serverSequence);
			}
			next[roomId] = sortMessages(existing);
		}
		this.byRoom = next;
	}

	/** Pull everything after our cursor (forward-only; the backend has no before-cursor yet). */
	async fetchNew(roomId: string): Promise<void> {
		const after = this.cursor[roomId] ?? 0;
		const envelopes = await api.listMessages(roomId, { after, limit: PAGE });
		await this.ingest(envelopes);
		if (envelopes.length === PAGE) await this.fetchNew(roomId);
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

	async sendText(roomId: string, content: MessageContent): Promise<void> {
		const principalId = auth.principal?.principalId;
		if (!principalId) throw new Error('Not authenticated');
		const key = idempotencyKey();
		const createdAt = new Date().toISOString();
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

	async retry(message: ChatMessage): Promise<void> {
		if (message.delivery !== 'failed') return;
		// Drop the failed placeholder and resend its content.
		this.byRoom = {
			...this.byRoom,
			[message.roomId]: this.list(message.roomId).filter((m) => m.key !== message.key)
		};
		await this.sendText(message.roomId, {
			contentType: message.content.contentType,
			body: message.content.body,
			replyToMessageId: message.content.replyToMessageId,
			attachments: message.content.attachments
		});
	}

	private setDelivery(roomId: string, idemKey: string, delivery: Delivery): void {
		const list = this.list(roomId);
		const idx = list.findIndex((m) => m.idempotencyKey === idemKey);
		if (idx < 0) return;
		const copy = [...list];
		copy[idx] = { ...copy[idx], delivery };
		this.byRoom = { ...this.byRoom, [roomId]: copy };
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
			const envelopeId = m.envelopeId;
			api.ackMessage(roomId, envelopeId, 'read').catch(() => this.acked.delete(envelopeId));
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
