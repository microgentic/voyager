import { api } from '$lib/api';
import type { Room, RoomInvitation } from '$lib/api/types';
import { auth } from './auth.svelte';
import { rooms } from './rooms.svelte';

class InvitationsStore {
	list = $state<RoomInvitation[]>([]);
	loading = $state(false);
	loaded = $state(false);

	readonly count = $derived(this.list.length);

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			const page = await api.listRoomInvitations({ status: 'pending', limit: 100 });
			this.list = page.items;
			this.loaded = true;
		} finally {
			this.loading = false;
		}
	}

	async accept(id: string): Promise<Room | undefined> {
		await api.respondToInvitation(id, 'accept');
		this.list = this.list.filter((i) => i.roomInvitationId !== id);
		await rooms.load(true);
		// Return the freshly joined room if we can resolve it.
		const invitation = this.list.find((i) => i.roomInvitationId === id);
		return invitation ? rooms.get(invitation.roomId) : undefined;
	}

	async decline(id: string): Promise<void> {
		await api.respondToInvitation(id, 'decline');
		this.list = this.list.filter((i) => i.roomInvitationId !== id);
	}

	reset(): void {
		this.list = [];
		this.loaded = false;
	}
}

export const invitations = new InvitationsStore();
