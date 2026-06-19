import { api } from '$lib/api';
import { auth } from './auth.svelte';
import { messages } from './messages.svelte';
import { rooms } from './rooms.svelte';

/*
 * Sync engine.
 *
 * Durable Object realtime wakes this path with lightweight room events, while
 * polling remains the recovery path for missed socket events, cold starts and
 * hidden tabs. The source of truth stays GET /v1/sync plus room message pulls.
 */
class SyncStore {
	active = $state(false);
	lastSyncedAt = $state<Date | null>(null);
	lastRoomSyncedAt = $state<Date | null>(null);
	lastSyncDurationMs = $state<number | null>(null);
	lastRoomSyncDurationMs = $state<number | null>(null);
	activeRoomId = $state<string | null>(null);

	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = false;
	private fullQueued = false;
	private queuedRoomIds = new Set<string>();
	private visibilityBound = false;

	constructor() {
		auth.onSignOut(() => this.stop());
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.bindVisibility();
		this.pokeNow();
		this.schedule();
	}

	stop(): void {
		this.active = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.activeRoomId = null;
		this.fullQueued = false;
		this.queuedRoomIds.clear();
	}

	setActiveRoom(roomId: string | null): void {
		this.activeRoomId = roomId;
	}

	/** Force an immediate sync (e.g. right after sending or a membership change). */
	pokeNow(): void {
		this.fullQueued = true;
		void this.drain();
	}

	/** Fetch one room immediately after a realtime event without waiting for the polling cadence. */
	pokeRoomNow(roomId: string, serverSequence?: number): void {
		if (serverSequence !== undefined && messages.maxSeq(roomId) >= serverSequence) return;
		this.queuedRoomIds.add(roomId);
		void this.drain();
	}

	private delay(): number {
		if (typeof document !== 'undefined' && document.hidden) return 20000;
		return this.activeRoomId ? 2500 : 5000;
	}

	private schedule(): void {
		if (!this.active) return;
		this.timer = setTimeout(async () => {
			this.fullQueued = true;
			await this.drain();
			this.schedule();
		}, this.delay());
	}

	private async drain(): Promise<void> {
		if (this.inFlight || auth.status !== 'authed') return;
		this.inFlight = true;
		try {
			while (this.fullQueued || this.queuedRoomIds.size > 0) {
				const runFull = this.fullQueued;
				const roomIds = [...this.queuedRoomIds];
				this.fullQueued = false;
				this.queuedRoomIds.clear();
				if (runFull) await this.runFullSync().catch(() => undefined);
				for (const roomId of roomIds) {
					await this.runRoomSync(roomId).catch(() => undefined);
				}
			}
		} catch {
			/* transient; next queued run or poll retries */
		} finally {
			this.inFlight = false;
		}
	}

	private async runFullSync(): Promise<void> {
		const startedAt = performance.now();
		const result = await api.sync({ limit: 100 });
		rooms.merge(result.rooms);
		await messages.ingest(result.pendingMessages);
		if (this.activeRoomId) {
			await this.runRoomSync(this.activeRoomId).catch(() => undefined);
		}
		this.lastSyncedAt = new Date();
		this.lastSyncDurationMs = Math.round(performance.now() - startedAt);
	}

	private async runRoomSync(roomId: string): Promise<void> {
		const startedAt = performance.now();
		await Promise.all([rooms.refresh(roomId), messages.fetchNew(roomId)]);
		this.lastRoomSyncedAt = new Date();
		this.lastRoomSyncDurationMs = Math.round(performance.now() - startedAt);
	}

	private bindVisibility(): void {
		if (this.visibilityBound || typeof document === 'undefined') return;
		this.visibilityBound = true;
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden && this.active) this.pokeNow();
		});
	}
}

export const sync = new SyncStore();
