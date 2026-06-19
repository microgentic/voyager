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
	activeRoomId = $state<string | null>(null);

	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = false;
	private visibilityBound = false;

	constructor() {
		auth.onSignOut(() => this.stop());
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.bindVisibility();
		void this.tick();
		this.schedule();
	}

	stop(): void {
		this.active = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.activeRoomId = null;
	}

	setActiveRoom(roomId: string | null): void {
		this.activeRoomId = roomId;
	}

	/** Force an immediate sync (e.g. right after sending or a membership change). */
	pokeNow(): void {
		void this.tick();
	}

	private delay(): number {
		if (typeof document !== 'undefined' && document.hidden) return 20000;
		return this.activeRoomId ? 2500 : 5000;
	}

	private schedule(): void {
		if (!this.active) return;
		this.timer = setTimeout(async () => {
			await this.tick();
			this.schedule();
		}, this.delay());
	}

	private async tick(): Promise<void> {
		if (this.inFlight || auth.status !== 'authed') return;
		this.inFlight = true;
		try {
			const result = await api.sync({ limit: 100 });
			rooms.merge(result.rooms);
			await messages.ingest(result.pendingMessages);
			if (this.activeRoomId) {
				await messages.fetchNew(this.activeRoomId).catch(() => undefined);
			}
			this.lastSyncedAt = new Date();
		} catch {
			/* transient; next tick retries */
		} finally {
			this.inFlight = false;
		}
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
