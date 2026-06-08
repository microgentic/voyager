<script lang="ts">
	import { slide } from 'svelte/transition';
	import { Search, SquarePen, ChevronRight, Inbox, MessagesSquare, X } from '@lucide/svelte';
	import { rooms, messages, collections, invitations } from '$lib/stores';
	import { compose } from '$lib/stores/compose.svelte';
	import ConversationListItem from './ConversationListItem.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { cn } from '$lib/utils/cn';

	let query = $state('');

	const normalizedQuery = $derived(query.trim().toLowerCase());
	const filtered = $derived(
		normalizedQuery
			? rooms.sorted.filter((r) => rooms.displayName(r).toLowerCase().includes(normalizedQuery))
			: rooms.sorted
	);

	function collectionUnread(roomIds: string[]): number {
		return roomIds.reduce((sum, id) => sum + messages.unread(id), 0);
	}
</script>

<header
	class="flex flex-col gap-3 border-b border-border px-3 pb-3 pt-[calc(var(--sat)+0.75rem)]"
>
	<div class="flex items-center justify-between gap-2 px-1">
		<h1 class="text-xl font-bold tracking-tight text-foreground">Chats</h1>
		<button
			onclick={() => compose.open()}
			class="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm transition hover:bg-primary-hover active:scale-95"
			aria-label="New conversation"
		>
			<SquarePen class="h-[18px] w-[18px]" />
		</button>
	</div>
	<div class="relative flex items-center">
		<Search class="pointer-events-none absolute left-3 h-4 w-4 text-faint" />
		<input
			bind:value={query}
			type="search"
			placeholder="Search conversations"
			class="h-10 w-full rounded-xl border border-transparent bg-surface-2 pl-9 pr-9 text-sm text-foreground outline-none transition placeholder:text-faint focus:border-primary/40 focus:bg-surface"
		/>
		{#if query}
			<button
				onclick={() => (query = '')}
				class="absolute right-2.5 grid h-6 w-6 place-items-center rounded-md text-faint hover:text-foreground"
				aria-label="Clear search"
			>
				<X class="h-4 w-4" />
			</button>
		{/if}
	</div>
</header>

<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
	{#if !rooms.loaded && rooms.loading}
		<div class="grid place-items-center py-16"><Spinner class="text-primary" /></div>
	{:else if normalizedQuery}
		{#if filtered.length === 0}
			<p class="px-3 py-8 text-center text-sm text-muted">No conversations match “{query}”.</p>
		{:else}
			{#each filtered as room (room.roomId)}
				<ConversationListItem {room} />
			{/each}
		{/if}
	{:else if rooms.sorted.length === 0}
		<EmptyState
			title="No conversations yet"
			description="Start a direct message, talk to an agent, or create a group."
		>
			{#snippet icon()}<MessagesSquare class="h-7 w-7" />{/snippet}
			<button
				onclick={() => compose.open()}
				class="mt-1 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
			>
				<SquarePen class="h-4 w-4" /> New conversation
			</button>
		</EmptyState>
	{:else}
		{#if invitations.count > 0}
			<a
				href="/invites"
				class="mb-1 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary-soft px-3 py-2.5 transition hover:brightness-105"
			>
				<span class="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-primary">
					<Inbox class="h-5 w-5" />
				</span>
				<span class="min-w-0 flex-1">
					<span class="block text-sm font-semibold text-foreground">
						{invitations.count} room {invitations.count === 1 ? 'invitation' : 'invitations'}
					</span>
					<span class="block truncate text-xs text-muted">Tap to review and respond</span>
				</span>
				<ChevronRight class="h-4 w-4 text-primary" />
			</a>
		{/if}

		{#each collections.list as collection (collection.collectionId)}
			{@const collectionRooms = collection.items
				.map((item) => rooms.get(item.roomId))
				.filter((r) => r !== undefined)}
			{#if collectionRooms.length > 0}
				{@const unread = collectionUnread(collectionRooms.map((r) => r.roomId))}
				<div class="mb-1 mt-2">
					<button
						onclick={() => collections.toggleCollapsed(collection.collectionId)}
						class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
					>
						<ChevronRight
							class={cn('h-3.5 w-3.5 text-faint transition-transform', !collection.collapsed && 'rotate-90')}
						/>
						<span class="text-xs font-semibold uppercase tracking-wide text-muted">
							{collection.name}
						</span>
						<span class="text-xs text-faint">{collectionRooms.length}</span>
						{#if unread > 0}
							<span class="ml-auto grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
								{unread}
							</span>
						{/if}
					</button>
					{#if !collection.collapsed}
						<div transition:slide={{ duration: 180 }}>
							{#each collectionRooms as room (room.roomId)}
								<ConversationListItem {room} />
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/each}

		{#if collections.list.length > 0}
			<p class="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-faint">All chats</p>
		{/if}
		{#each rooms.sorted as room (room.roomId)}
			<ConversationListItem {room} />
		{/each}
	{/if}
</div>
