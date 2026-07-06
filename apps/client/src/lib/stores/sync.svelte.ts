import { api, isApiError } from '$lib/api';
import type { MessageEnvelope, SyncChange, SyncResult } from '$lib/api/types';
import {
	clearCachedSyncCursor,
	clientCacheScope,
	loadCachedSyncCursor,
	saveCachedSyncCursor
} from '$lib/local-cache';
import { auth } from './auth.svelte';
import { messages } from './messages.svelte';
import { rooms } from './rooms.svelte';
import { threads } from './threads.svelte';

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
	private queuedRooms = new Map<string, Set<number>>();
	private visibilityBound = false;
	private rememberedSyncCursor: string | null = null;

	constructor() {
		auth.onSignOut(() => this.stop());
	}

	private cacheScope(): string | null {
		return clientCacheScope(auth.account?.accountId, auth.principal?.principalId);
	}

	start(options: { immediate?: boolean } = {}): void {
		if (this.active) return;
		this.active = true;
		this.bindVisibility();
		if (options.immediate !== false) this.pokeNow();
		this.schedule();
	}

	stop(): void {
		this.active = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.activeRoomId = null;
		this.fullQueued = false;
		this.queuedRooms.clear();
		this.rememberedSyncCursor = null;
	}

	setActiveRoom(roomId: string | null): void {
		this.activeRoomId = roomId;
	}

	rememberCursor(cursor: string | null | undefined): void {
		this.rememberedSyncCursor = cursor ?? null;
		void saveCachedSyncCursor(this.cacheScope(), cursor);
	}

	/** Force an immediate sync (e.g. right after sending or a membership change). */
	pokeNow(): void {
		this.fullQueued = true;
		void this.drain();
	}

	/** Fetch one room immediately after a realtime event without waiting for the polling cadence. */
	pokeRoomNow(roomId: string, serverSequence?: number): void {
		const targets = this.queuedRooms.get(roomId) ?? new Set<number>();
		if (serverSequence !== undefined && Number.isFinite(serverSequence) && serverSequence > 0) {
			targets.add(serverSequence);
		}
		this.queuedRooms.set(roomId, targets);
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
			while (this.fullQueued || this.queuedRooms.size > 0) {
				const runFull = this.fullQueued;
				const roomTargets = [...this.queuedRooms.entries()].map(([roomId, targets]) => ({
					roomId,
					targets: [...targets]
				}));
				this.fullQueued = false;
				this.queuedRooms.clear();
				if (runFull) await this.runFullSync().catch(() => undefined);
				for (const { roomId, targets } of roomTargets) {
					await this.runRoomSync(roomId, targets).catch(() => undefined);
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
		const scope = this.cacheScope();
		const cachedCursor = this.rememberedSyncCursor ?? (await loadCachedSyncCursor(scope));
		let result = await this.fetchAccountSync(cachedCursor, scope);
		if (cachedCursor && this.isDeltaSync(result)) {
			const seenCursors = new Set<string>();
			while (true) {
				await this.applyDeltaChanges(result.changes ?? []);
				await this.saveSyncCursor(scope, result);
				const nextCursor = result.nextSyncCursor;
				if (!result.hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
				seenCursors.add(nextCursor);
				result = await this.fetchAccountSync(nextCursor, scope);
			}
		} else {
			rooms.hydrate(result.rooms);
			await messages.ingest(result.pendingMessages);
			await this.saveSyncCursor(scope, result);
		}
		if (this.activeRoomId) {
			await this.runRoomSync(this.activeRoomId).catch(() => undefined);
		}
		this.lastSyncedAt = new Date();
		this.lastSyncDurationMs = Math.round(performance.now() - startedAt);
	}

	private isDeltaSync(result: SyncResult): boolean {
		return (
			Array.isArray(result.changes) &&
			result.rooms.length === 0 &&
			result.pendingMessages.length === 0 &&
			Boolean(result.nextSyncCursor ?? result.syncCursor)
		);
	}

	private async fetchAccountSync(cursor: string | null, scope: string | null): Promise<SyncResult> {
		try {
			return await api.sync({ limit: 100, since: cursor });
		} catch (error) {
			if (cursor && isApiError(error) && error.code === 'invalid_sync_cursor') {
				this.rememberedSyncCursor = null;
				await clearCachedSyncCursor(scope);
				return api.sync({ limit: 100 });
			}
			throw error;
		}
	}

	private async applyDeltaChanges(changes: SyncChange[]): Promise<void> {
		const messageUpserts: MessageEnvelope[] = [];
		const threadRefreshes = new Map<string, string>();
		for (const change of changes) {
			if (change.type === 'room.upsert' && change.room) {
				rooms.upsert(change.room);
				continue;
			}
			if (change.type === 'room.remove' && change.roomId) {
				rooms.remove(change.roomId);
				messages.dropRoom(change.roomId);
				continue;
			}
			if (change.type === 'message.upsert' && change.message) {
				messageUpserts.push(change.message);
				if (change.message.threadRootEnvelopeId) {
					threadRefreshes.set(change.message.threadRootEnvelopeId, change.message.roomId);
				}
				continue;
			}
			if (change.type === 'message.remove' && change.roomId && change.envelopeId) {
				messages.removeEnvelopeIds(change.roomId, [change.envelopeId]);
				if (change.rootEnvelopeId) threadRefreshes.set(change.rootEnvelopeId, change.roomId);
			}
		}
		await messages.ingest(messageUpserts);
		if (threadRefreshes.size) {
			await Promise.allSettled(
				[...threadRefreshes.entries()].map(([rootEnvelopeId, roomId]) =>
					messages.syncThread(roomId, rootEnvelopeId)
				)
			);
			void threads.load(true);
		}
	}

	private async saveSyncCursor(scope: string | null, result: SyncResult): Promise<void> {
		const cursor = result.nextSyncCursor ?? result.syncCursor ?? null;
		this.rememberedSyncCursor = cursor;
		if (cursor) await saveCachedSyncCursor(scope, cursor);
		else await clearCachedSyncCursor(scope);
	}

	private async runRoomSync(roomId: string, serverSequences: number[] = []): Promise<void> {
		const startedAt = performance.now();
		const targets = [...new Set(serverSequences)].sort((a, b) => a - b);
		await Promise.all([
			rooms.refresh(roomId),
			targets.length
				? Promise.all(targets.map((serverSequence) => messages.fetchSequence(roomId, serverSequence)))
				: messages.fetchNew(roomId, { overlap: 50 })
		]);
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
