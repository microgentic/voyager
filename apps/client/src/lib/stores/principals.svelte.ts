import { api } from '$lib/api';
import type { Principal } from '$lib/api/types';
import { auth } from './auth.svelte';

class PrincipalsStore {
	list = $state<Principal[]>([]);
	loaded = $state(false);
	loading = $state(false);

	readonly byId = $derived(new Map(this.list.map((p) => [p.principalId, p])));
	/** Active human principals other than me — candidates for direct messages/invites. */
	readonly humans = $derived(
		this.list.filter(
			(p) => p.principalType === 'human' && p.principalId !== auth.principal?.principalId
		)
	);
	readonly agents = $derived(this.list.filter((p) => p.principalType === 'agent'));

	constructor() {
		auth.onSignOut(() => this.reset());
	}

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			this.list = await api.listPrincipals();
			this.loaded = true;
		} finally {
			this.loading = false;
		}
	}

	get(principalId: string | null | undefined): Principal | undefined {
		if (!principalId) return undefined;
		return this.byId.get(principalId);
	}

	reset(): void {
		this.list = [];
		this.loaded = false;
	}
}

export const principals = new PrincipalsStore();
