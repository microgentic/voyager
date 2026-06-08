import { api } from '$lib/api';
import type { SidebarCollection } from '$lib/api/types';
import { auth } from './auth.svelte';

class CollectionsStore {
	list = $state<SidebarCollection[]>([]);
	loading = $state(false);
	loaded = $state(false);

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			this.list = sortCollections(await api.listCollections());
			this.loaded = true;
		} finally {
			this.loading = false;
		}
	}

	async create(name: string): Promise<SidebarCollection> {
		const collection = await api.createCollection({ name, sortOrder: this.list.length });
		this.list = sortCollections([...this.list, collection]);
		return collection;
	}

	async rename(collectionId: string, name: string): Promise<void> {
		const updated = await api.updateCollection(collectionId, { name });
		this.replace(updated);
	}

	async toggleCollapsed(collectionId: string): Promise<void> {
		const current = this.list.find((c) => c.collectionId === collectionId);
		if (!current) return;
		// optimistic
		this.replace({ ...current, collapsed: !current.collapsed });
		try {
			const updated = await api.updateCollection(collectionId, { collapsed: !current.collapsed });
			this.replace(updated);
		} catch {
			this.replace(current);
		}
	}

	async remove(collectionId: string): Promise<void> {
		await api.deleteCollection(collectionId);
		this.list = this.list.filter((c) => c.collectionId !== collectionId);
	}

	async addRoom(collectionId: string, roomId: string): Promise<void> {
		await api.addCollectionItem(collectionId, roomId, this.list.length);
		await this.load(true);
	}

	async removeRoom(collectionId: string, roomId: string): Promise<void> {
		await api.removeCollectionItem(collectionId, roomId);
		await this.load(true);
	}

	collectionsForRoom(roomId: string): SidebarCollection[] {
		return this.list.filter((c) => c.items.some((item) => item.roomId === roomId));
	}

	roomIdsInCollections(): Set<string> {
		const ids = new Set<string>();
		for (const c of this.list) for (const item of c.items) ids.add(item.roomId);
		return ids;
	}

	private replace(collection: SidebarCollection): void {
		this.list = sortCollections(
			this.list.map((c) => (c.collectionId === collection.collectionId ? collection : c))
		);
	}

	reset(): void {
		this.list = [];
		this.loaded = false;
	}
}

function sortCollections(list: SidebarCollection[]): SidebarCollection[] {
	return [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export const collections = new CollectionsStore();
