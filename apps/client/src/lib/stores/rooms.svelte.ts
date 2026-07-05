import { api } from '$lib/api';
import type { Membership, Room } from '$lib/api/types';
import { clientCacheScope, loadCachedRooms, removeCachedRoom, saveCachedRooms } from '$lib/local-cache';
import { parseServerDate } from '$lib/utils/time';
import { auth } from './auth.svelte';

class RoomsStore {
	list = $state<Room[]>([]);
	loaded = $state(false);
	loading = $state(false);

	readonly byId = $derived(new Map(this.list.map((r) => [r.roomId, r])));
	readonly sorted = $derived(
		[...this.list]
			.filter((r) => r.status !== 'deleted')
			.sort(
				(a, b) =>
					(parseServerDate(b.updatedAt)?.getTime() ?? 0) -
					(parseServerDate(a.updatedAt)?.getTime() ?? 0)
			)
	);

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	private cacheScope(): string | null {
		return clientCacheScope(auth.account?.accountId, auth.principal?.principalId);
	}

	async hydrateFromCache(): Promise<boolean> {
		if (this.loaded) return this.list.length > 0;
		const cached = await loadCachedRooms(this.cacheScope());
		if (!cached.length) return false;
		this.list = cached;
		this.loaded = true;
		return true;
	}

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			if (!force && !this.loaded) await this.hydrateFromCache();
			const page = await api.listRooms({ limit: 200 });
			this.list = page.items;
			this.loaded = true;
			void saveCachedRooms(this.cacheScope(), page.items);
		} finally {
			this.loading = false;
		}
	}

	merge(rooms: Room[]): void {
		if (!rooms.length) return;
		const map = new Map(this.list.map((r) => [r.roomId, r]));
		for (const r of rooms) map.set(r.roomId, r);
		this.list = [...map.values()];
		void saveCachedRooms(this.cacheScope(), rooms);
	}

	hydrate(nextRooms: Room[]): void {
		this.list = nextRooms;
		this.loaded = true;
		this.loading = false;
		void saveCachedRooms(this.cacheScope(), nextRooms);
	}

	upsert(room: Room): void {
		this.merge([room]);
	}

	get(roomId: string | null | undefined): Room | undefined {
		if (!roomId) return undefined;
		return this.byId.get(roomId);
	}

	remove(roomId: string): void {
		this.list = this.list.filter((r) => r.roomId !== roomId);
		void removeCachedRoom(this.cacheScope(), roomId);
	}

	async refresh(roomId: string): Promise<Room | undefined> {
		try {
			const room = await api.getRoom(roomId);
			this.upsert(room);
			return room;
		} catch {
			return undefined;
		}
	}

	reset(): void {
		this.list = [];
		this.loaded = false;
		this.loading = false;
	}

	// --- display helpers ----------------------------------------------------

	activeMembers(room: Room): Membership[] {
		return room.members.filter((m) => m.status === 'active');
	}

	otherMembers(room: Room): Membership[] {
		const me = auth.principal?.principalId;
		return this.activeMembers(room).filter((m) => m.principalId !== me);
	}

	myMembership(room: Room): Membership | undefined {
		const me = auth.principal?.principalId;
		return room.members.find((m) => m.principalId === me);
	}

	myRole(room: Room): Membership['role'] | undefined {
		return this.myMembership(room)?.role;
	}

	canManage(room: Room): boolean {
		const role = this.myRole(room);
		return role === 'owner' || role === 'admin';
	}

	counterpart(room: Room): Membership | undefined {
		return this.otherMembers(room)[0];
	}

	hasAgent(room: Room): boolean {
		return this.activeMembers(room).some((m) => m.principalType === 'agent');
	}

	isAgentDirect(room: Room): boolean {
		return room.type === 'direct' && (this.counterpart(room)?.principalType === 'agent');
	}

	displayName(room: Room): string {
		if (room.type === 'group') return room.name || 'Untitled group';
		const others = this.otherMembers(room);
		if (others.length) return others.map((m) => m.displayName).join(', ');
		return room.name || 'Direct message';
	}
}

export const rooms = new RoomsStore();
