import { api } from '$lib/api';
import type { ThreadInboxItem } from '$lib/api/types';
import { auth } from './auth.svelte';
import { messages } from './messages.svelte';
import { rooms } from './rooms.svelte';

class ThreadsStore {
	items = $state<ThreadInboxItem[]>([]);
	loading = $state(false);
	loaded = $state(false);
	nextCursor = $state<string | null>(null);

	readonly unreadCount = $derived(this.items.reduce((sum, item) => sum + item.unreadCount, 0));

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			const page = await api.listThreads({ limit: 50 });
			this.items = page.items;
			this.nextCursor = page.nextCursor;
			this.loaded = true;
			rooms.merge(page.items.map((item) => item.room).filter(Boolean));
			await messages.ingest(page.items.map((item) => item.root));
		} finally {
			this.loading = false;
		}
	}

	async loadMore(): Promise<void> {
		if (this.loading || !this.nextCursor) return;
		this.loading = true;
		try {
			const page = await api.listThreads({ limit: 50, cursor: this.nextCursor });
			const seen = new Set(this.items.map((item) => item.root.envelopeId));
			this.items = [...this.items, ...page.items.filter((item) => !seen.has(item.root.envelopeId))];
			this.nextCursor = page.nextCursor;
			rooms.merge(page.items.map((item) => item.room).filter(Boolean));
			await messages.ingest(page.items.map((item) => item.root));
		} finally {
			this.loading = false;
		}
	}

	async markRead(roomId: string, rootEnvelopeId: string): Promise<void> {
		const state = await api.markThreadRead(roomId, rootEnvelopeId);
		this.items = this.items.map((item) =>
			item.root.envelopeId === rootEnvelopeId
				? {
						...item,
						unreadCount: 0,
						lastReadSequence: state.lastReadSequence,
						following: state.following,
						muted: state.muted,
						updatedAt: state.updatedAt
					}
				: item
		);
	}

	async setFollowing(roomId: string, rootEnvelopeId: string, following: boolean): Promise<void> {
		const state = await api.updateThreadSubscription(roomId, rootEnvelopeId, { following });
		this.items = this.items
			.map((item) =>
				item.root.envelopeId === rootEnvelopeId
					? { ...item, following: state.following, muted: state.muted, updatedAt: state.updatedAt }
					: item
			)
			.filter((item) => item.following);
	}

	reset(): void {
		this.items = [];
		this.loaded = false;
		this.loading = false;
		this.nextCursor = null;
	}
}

export const threads = new ThreadsStore();
