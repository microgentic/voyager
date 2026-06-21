<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';
	import { MessageSquareX } from '@lucide/svelte';
	import { rooms, messages, sync } from '$lib/stores';
	import type { ChatMessage } from '$lib/stores';
	import RoomHeader from '$lib/components/chat/RoomHeader.svelte';
	import MessageList from '$lib/components/chat/MessageList.svelte';
	import Composer from '$lib/components/chat/Composer.svelte';
	import RoomDetails from '$lib/components/rooms/RoomDetails.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';

	const roomId = $derived(page.params.roomId ?? '');
	const room = $derived(rooms.get(roomId));
	let notFound = $state(false);
	let showDetails = $state(false);
	let searchOpen = $state(false);
	let replyTo = $state<ChatMessage | null>(null);
	let editingMessage = $state<ChatMessage | null>(null);

	function startReply(message: ChatMessage): void {
		editingMessage = null;
		replyTo = message;
	}

	function startEdit(message: ChatMessage): void {
		replyTo = null;
		editingMessage = message;
	}

	function clearComposerContext(): void {
		replyTo = null;
		editingMessage = null;
	}

	// Only react to the roomId changing. Reads of rooms/messages stores are
	// untracked so frequent sync updates don't re-run this (which would reset
	// `showDetails` and close the details panel mid-view).
	$effect(() => {
		const id = roomId;
		untrack(() => {
				notFound = false;
				showDetails = false;
				searchOpen = false;
				clearComposerContext();
				if (!id) return;
			sync.setActiveRoom(id);
			if (!rooms.get(id)) {
				void rooms.refresh(id).then((r) => {
					if (!r) notFound = true;
				});
			}
			void messages.ensureLoaded(id).then(() => messages.markRead(id));
		});
	});

	// Keep marking read as new messages arrive while the thread is on screen.
	$effect(() => {
		const id = roomId;
		const count = messages.list(id).length;
		if (id && count >= 0) messages.markRead(id);
	});

	onDestroy(() => sync.setActiveRoom(null));
</script>

{#if room}
	<div class="flex h-full min-h-0 flex-col">
		<RoomHeader {room} onShowDetails={() => (showDetails = true)} onToggleSearch={() => (searchOpen = !searchOpen)} />
		<MessageList {room} bind:searchOpen onReply={startReply} onEdit={startEdit} />
		<Composer {room} {replyTo} {editingMessage} onCancelContext={clearComposerContext} onSent={clearComposerContext} />
	</div>
	<RoomDetails {room} bind:open={showDetails} />
{:else if notFound}
	<EmptyState
		title="Conversation unavailable"
		description="It may have been deleted, or you’re no longer a member."
	>
		{#snippet icon()}<MessageSquareX class="h-7 w-7" />{/snippet}
	</EmptyState>
{:else}
	<div class="grid h-full place-items-center"><Spinner class="text-primary" /></div>
{/if}
