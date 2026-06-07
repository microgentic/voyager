<script lang="ts">
	import { Plus, Check } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { collections, toasts } from '$lib/stores';
	import { isApiError } from '$lib/api';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import TextInput from '$lib/components/ui/TextInput.svelte';
	import { cn } from '$lib/utils/cn';

	let { room, open = $bindable(false) }: { room: Room; open?: boolean } = $props();

	let newName = $state('');
	let creating = $state(false);
	let busy = $state(false);

	$effect(() => {
		if (open) void collections.load();
	});

	function isIn(collectionId: string): boolean {
		return collections.list
			.find((c) => c.collectionId === collectionId)
			?.items.some((i) => i.roomId === room.roomId) ?? false;
	}

	async function toggle(collectionId: string): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			if (isIn(collectionId)) await collections.removeRoom(collectionId, room.roomId);
			else await collections.addRoom(collectionId, room.roomId);
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not update collection.');
		} finally {
			busy = false;
		}
	}

	async function create(): Promise<void> {
		if (!newName.trim() || creating) return;
		creating = true;
		try {
			const collection = await collections.create(newName.trim());
			await collections.addRoom(collection.collectionId, room.roomId);
			newName = '';
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not create collection.');
		} finally {
			creating = false;
		}
	}
</script>

<Modal bind:open title="Add to collection" size="sm">
	<p class="text-sm text-muted">
		Collections are your private way to organize conversations — only you can see them.
	</p>

	<div class="my-3 space-y-0.5">
		{#each collections.list as collection (collection.collectionId)}
			{@const checked = isIn(collection.collectionId)}
			<button
				onclick={() => toggle(collection.collectionId)}
				disabled={busy}
				class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2 disabled:opacity-60"
			>
				<span class="truncate font-medium text-foreground">{collection.name}</span>
				<span
					class={cn(
						'grid h-5 w-5 shrink-0 place-items-center rounded-md border transition',
						checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong'
					)}
				>
					{#if checked}<Check class="h-3.5 w-3.5" />{/if}
				</span>
			</button>
		{:else}
			<p class="py-3 text-center text-sm text-muted">No collections yet — create one below.</p>
		{/each}
	</div>

	<div class="flex items-center gap-2">
		<TextInput bind:value={newName} placeholder="New collection name" maxlength={80} class="flex-1" />
		<Button size="icon" onclick={create} loading={creating} disabled={!newName.trim()} aria-label="Create collection">
			<Plus class="h-5 w-5" />
		</Button>
	</div>
</Modal>
