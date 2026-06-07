<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArrowLeft, MoreVertical, Users } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { rooms, ui } from '$lib/stores';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { avatarGradient } from '$lib/utils/avatar';

	let { room, onShowDetails }: { room: Room; onShowDetails: () => void } = $props();

	const isGroup = $derived(room.type === 'group');
	const counterpart = $derived(rooms.counterpart(room));
	const agentDirect = $derived(rooms.isAgentDirect(room));
	const name = $derived(rooms.displayName(room));
	const activeCount = $derived(rooms.activeMembers(room).length);
	const subtitle = $derived(
		room.status === 'archived'
			? 'Archived'
			: isGroup
				? `${activeCount} ${activeCount === 1 ? 'member' : 'members'}`
				: agentDirect
					? 'AI agent'
					: 'Direct message'
	);
</script>

<header
	class="z-10 flex shrink-0 items-center border-b border-border bg-surface/80 px-2 pt-[var(--sat)] backdrop-blur-xl sm:px-3"
>
	<div class="flex h-14 w-full items-center gap-1.5">
		{#if !ui.isWide}
			<button
				onclick={() => goto('/app')}
				class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-foreground transition hover:bg-surface-2"
				aria-label="Back to chats"
			>
				<ArrowLeft class="h-5.5 w-5.5" />
			</button>
		{/if}

		<button
			onclick={onShowDetails}
			class="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 py-1 text-left transition hover:bg-surface-2"
		>
			{#if isGroup}
				<span
					class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white"
					style="background-image:{avatarGradient(room.roomId)}"
				>
					<Users class="h-4.5 w-4.5" />
				</span>
			{:else}
				<Avatar
					name={counterpart?.displayName ?? name}
					seed={counterpart?.principalId ?? room.roomId}
					isAgent={agentDirect}
					size="sm"
				/>
			{/if}
			<span class="min-w-0">
				<span class="flex items-center gap-1.5">
					<span class="truncate font-semibold text-foreground">{name}</span>
					{#if agentDirect}<Badge tone="agent">Agent</Badge>{/if}
				</span>
				<span class="block truncate text-xs text-muted">{subtitle}</span>
			</span>
		</button>

		<button
			onclick={onShowDetails}
			class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-foreground"
			aria-label="Conversation details"
		>
			<MoreVertical class="h-5 w-5" />
		</button>
	</div>
</header>
