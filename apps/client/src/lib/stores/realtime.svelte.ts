import { api } from '$lib/api';
import { auth } from './auth.svelte';
import { sync } from './sync.svelte';

type RealtimeState = 'idle' | 'connecting' | 'connected' | 'retrying';

interface RealtimeEvent {
	type?: string;
	eventId?: string;
	roomId?: string;
	envelopeId?: string;
	serverSequence?: number;
	createdAt?: string;
}

class RealtimeStore {
	active = $state(false);
	state = $state<RealtimeState>('idle');
	connected = $state(false);
	lastEventAt = $state<Date | null>(null);
	lastError = $state<string | null>(null);

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
		if (event.type === 'ready' || event.type === 'pong') {
			return;
		}
		if (event.type === 'room.message' || event.type === 'room.sync') {
			this.lastEventAt = new Date();
			sync.pokeNow();
		}
	}

	private scheduleReconnect(): void {
		this.clearReconnect();
		this.state = 'retrying';
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
