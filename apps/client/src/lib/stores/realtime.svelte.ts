import { api } from '$lib/api';
import type { RealtimeEvent } from '$lib/api/types';
import { auth } from './auth.svelte';
import { sync } from './sync.svelte';

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

	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private attempts = 0;

	constructor() {
		auth.onSignOut(() => this.stop());
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.connect();
	}

	stop(): void {
		this.active = false;
		this.state = 'idle';
		this.connected = false;
		this.clearReconnect();
		this.clearHeartbeat();
		if (this.socket) {
			this.socket.onopen = null;
			this.socket.onmessage = null;
			this.socket.onerror = null;
			this.socket.onclose = null;
			this.socket.close(1000, 'client_stop');
			this.socket = null;
		}
	}

	private connect(): void {
		if (!this.active || auth.status !== 'authed' || this.socket) return;
		const socket = api.openRealtimeSocket();
		if (!socket) {
			this.scheduleReconnect();
			return;
		}

		this.state = 'connecting';
		this.lastError = null;
		this.socket = socket;

		socket.onopen = () => {
			this.connected = true;
			this.state = 'connected';
			this.attempts = 0;
			this.lastConnectedAt = new Date();
			this.startHeartbeat();
		};

		socket.onmessage = (event) => {
			this.handleMessage(event.data);
		};

		socket.onerror = () => {
			this.lastError = 'Realtime connection failed';
		};

		socket.onclose = () => {
			this.clearHeartbeat();
			this.socket = null;
			this.connected = false;
			this.lastClosedAt = new Date();
			if (!this.active) return;
			this.scheduleReconnect();
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
		if (event.type === 'room.sync') {
			this.lastEventAt = new Date();
			this.lastRoomId = event.roomId ?? null;
			this.lastServerSequence = event.serverSequence ?? null;
			if (event.roomId) sync.pokeRoomNow(event.roomId, event.serverSequence);
			else sync.pokeNow();
		}
	}

	private scheduleReconnect(): void {
		this.clearReconnect();
		this.state = 'retrying';
		this.reconnectCount += 1;
		const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6)) + Math.floor(Math.random() * 250);
		this.attempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private startHeartbeat(): void {
		this.clearHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (this.socket?.readyState === WebSocket.OPEN) {
				this.socket.send(JSON.stringify({ type: 'ping', id: crypto.randomUUID() }));
			}
		}, 25_000);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}
}

export const realtime = new RealtimeStore();
