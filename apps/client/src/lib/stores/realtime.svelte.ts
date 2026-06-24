import { api } from '$lib/api';
import type { RealtimeTransport } from '$lib/api/client';
import type { RealtimeCallEvent, RealtimeEvent } from '$lib/api/types';
import { auth } from './auth.svelte';
import { calls } from './calls.svelte';
import { messages } from './messages.svelte';
import { sync } from './sync.svelte';
import { threads } from './threads.svelte';

type RealtimeState = 'idle' | 'connecting' | 'connected' | 'retrying';

class RealtimeStore {
	active = $state(false);
	state = $state<RealtimeState>('idle');
	connected = $state(false);
	lastEventAt = $state<Date | null>(null);
	lastReadyAt = $state<Date | null>(null);
	lastPongAt = $state<Date | null>(null);
	lastConnectedAt = $state<Date | null>(null);
	lastClosedAt = $state<Date | null>(null);
	lastRoomMessageAt = $state<Date | null>(null);
	lastRoomId = $state<string | null>(null);
	lastEnvelopeId = $state<string | null>(null);
	lastServerSequence = $state<number | null>(null);
	lastError = $state<string | null>(null);
	reconnectCount = $state(0);
	transport = $state<RealtimeTransport | null>(null);

	private messagingSocket: WebSocket | null = null;
	private messagingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private messagingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private messagingAttempts = 0;

	constructor() {
		auth.onSignOut(() => this.stop());
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		void this.connectMessaging();
	}

	stop(): void {
		this.active = false;
		this.state = 'idle';
		this.connected = false;
		this.transport = null;
		this.clearMessagingReconnect();
		this.closeMessagingSocket();
	}

	private async connectMessaging(): Promise<void> {
		if (!this.active || auth.status !== 'authed' || this.messagingSocket) return;
		this.state = 'connecting';
		this.lastError = null;

		let connection: Awaited<ReturnType<typeof api.openRealtimeSocket>>;
		try {
			connection = await api.openRealtimeSocket({ transport: 'messaging-core' });
		} catch (error) {
			this.lastError = (error as Error)?.message ?? 'Realtime token request failed';
			if (!this.active || auth.status !== 'authed') return;
			this.scheduleMessagingReconnect();
			return;
		}

		if (!this.active || auth.status !== 'authed') {
			connection?.socket.close(1000, 'client_stop');
			return;
		}
		if (!connection) {
			this.scheduleMessagingReconnect();
			return;
		}

		const { socket, transport } = connection;
		let ready = false;
		this.messagingSocket = socket;
		this.transport = transport;

		socket.onopen = () => {
			this.connected = true;
			this.state = 'connected';
			this.transport = transport;
			this.messagingAttempts = 0;
			this.lastConnectedAt = new Date();
			this.startMessagingHeartbeat();
		};

		socket.onmessage = (event) => {
			if (typeof event.data === 'string') {
				try {
					ready = (JSON.parse(event.data) as { type?: string }).type === 'ready' || ready;
				} catch {
					// The shared message handler ignores malformed frames.
				}
			}
				this.handleMessage(event.data);
		};

		socket.onerror = () => {
			this.lastError = 'Messaging Core realtime connection failed';
		};

		socket.onclose = () => {
			this.clearMessagingHeartbeat();
			this.messagingSocket = null;
			this.connected = false;
			this.transport = null;
			this.lastClosedAt = new Date();
			if (!this.active) return;
			if (!ready) this.lastError = 'Messaging Core realtime connection failed';
			this.scheduleMessagingReconnect();
		};
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== 'string') return;
		let event: RealtimeEvent;
		try {
			event = JSON.parse(data) as RealtimeEvent;
		} catch {
			return;
		}
		if (event.type === 'ready') {
			this.lastReadyAt = new Date();
			return;
		}
		if (event.type === 'pong') {
			this.lastPongAt = new Date();
			return;
		}
		if (event.type === 'room.message' && event.roomId) {
			this.lastEventAt = new Date();
			this.lastRoomMessageAt = this.lastEventAt;
			this.lastRoomId = event.roomId;
			this.lastEnvelopeId = event.envelopeId ?? null;
			this.lastServerSequence = event.serverSequence ?? null;
			sync.pokeRoomNow(event.roomId, event.serverSequence);
			return;
		}
		if (event.type === 'room.thread' && event.roomId && event.rootEnvelopeId) {
			this.lastEventAt = new Date();
			this.lastRoomMessageAt = this.lastEventAt;
			this.lastRoomId = event.roomId;
			this.lastEnvelopeId = event.envelopeId ?? null;
			this.lastServerSequence = event.serverSequence ?? null;
			// Refresh the thread (and its root summary) in place; the root's own
			// sequence never moves, so a plain after-cursor pull would miss it.
			void messages.syncThread(event.roomId, event.rootEnvelopeId, event.serverSequence);
			void threads.load(true);
			// Also-sent replies belong in the main timeline too.
			if (event.alsoSentToRoom) sync.pokeRoomNow(event.roomId, event.serverSequence);
			return;
		}
		if (event.type === 'room.sync') {
			this.lastEventAt = new Date();
			this.lastRoomId = event.roomId ?? null;
			this.lastServerSequence = event.serverSequence ?? null;
			if (event.roomId) sync.pokeRoomNow(event.roomId, event.serverSequence);
			else sync.pokeNow();
			return;
		}
		if (event.type.startsWith('call.')) {
			this.lastEventAt = new Date();
			this.lastRoomId = event.roomId;
			void calls.handleRealtimeEvent(event as RealtimeCallEvent);
		}
	}

	private scheduleMessagingReconnect(): void {
		this.clearMessagingReconnect();
		this.state = 'retrying';
		this.reconnectCount += 1;
		const delay = Math.min(30_000, 500 * 2 ** Math.min(this.messagingAttempts, 6)) + Math.floor(Math.random() * 250);
		this.messagingAttempts += 1;
		this.messagingReconnectTimer = setTimeout(() => {
			this.messagingReconnectTimer = null;
			void this.connectMessaging();
		}, delay);
	}

	private startMessagingHeartbeat(): void {
		this.clearMessagingHeartbeat();
		this.messagingHeartbeatTimer = setInterval(() => {
			if (this.messagingSocket?.readyState === WebSocket.OPEN) {
				this.messagingSocket.send(JSON.stringify({ type: 'ping', id: crypto.randomUUID() }));
			}
		}, 25_000);
	}

	private clearMessagingReconnect(): void {
		if (this.messagingReconnectTimer) clearTimeout(this.messagingReconnectTimer);
		this.messagingReconnectTimer = null;
	}

	private clearMessagingHeartbeat(): void {
		if (this.messagingHeartbeatTimer) clearInterval(this.messagingHeartbeatTimer);
		this.messagingHeartbeatTimer = null;
	}

	private closeMessagingSocket(): void {
		this.clearMessagingHeartbeat();
		if (!this.messagingSocket) return;
		this.messagingSocket.onopen = null;
		this.messagingSocket.onmessage = null;
		this.messagingSocket.onerror = null;
		this.messagingSocket.onclose = null;
		this.messagingSocket.close(1000, 'client_stop');
		this.messagingSocket = null;
	}
}

export const realtime = new RealtimeStore();
