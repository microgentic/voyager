// Tiny UI store controlling the global "New conversation" flow, so any surface
// (nav rail, list header, empty state, tab bar) can open it.

class ComposeStore {
	isOpen = $state(false);

	open(): void {
		this.isOpen = true;
	}

	close(): void {
		this.isOpen = false;
	}
}

export const compose = new ComposeStore();
