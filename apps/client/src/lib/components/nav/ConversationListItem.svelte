<script lang="ts">
	import { page } from '$app/state';
	import { Users } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { rooms, messages } from '$lib/stores';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { cn } from '$lib/utils/cn';
	import { avatarGradient } from '$lib/utils/avatar';
	import { formatRelativeShort } from '$lib/utils/time';
	import { toPreview } from '$lib/utils/markdown';

	let { room }: { room: Room } = $props();

	const active = $derived(page.params.roomId === room.roomId);
	const isGroup = $derived(room.type === 'group');
	const counterpart = $derived(rooms.counterpart(room));
	const agentDirect = $derived(rooms.isAgentDirect(room));
	const name = $derived(rooms.displayName(room));
	const latest = $derived(messages.latest(room.roomId));
	const unread = $derived(messages.unread(room.roomId));

	const timestamp = $derived(
		latest ? formatRelativeShort(latest.serverReceivedAt ?? latest.clientCreatedAt) : ''
	);

	const preview = $derived.by(() => {
		if (!latest) {
			return isGroup && room.description ? room.description : 'No messages yet';
		}
		const body = latest.content.undecodable
			? 'Encrypted message'
			: latest.content.body.trim()
				? toPreview(latest.content.body)
				: latest.content.attachments?.length
					? '📎 Attachment'
					: '';
		if (latest.mine) return `You: ${body}`;
		if (isGroup) {
			const member = room.members.find((m) => m.principalId === latest.senderPrincipalId);
			const first = (member?.displayName ?? '').split(' ')[0];
			return first ? `${first}: ${body}` : body;
		}
		return body;
	});
</script>

<a
	href={`/app/${room.roomId}`}
	aria-current={active ? 'page' : undefined}
	class={cn(
		'flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition',
		active ? 'bg-primary-soft' : 'hover:bg-surface-2'
	)}
>
	{#if isGroup}
		<span
			class="grid h-12 w-12 shrink-0 place-items-center rounded-full text-white"
			style="background-image:{avatarGradient(room.roomId)}"
		>
			<Users class="h-5 w-5" />
		</span>
	{:else}
		<Avatar name={counterpart?.displayName ?? name} seed={counterpart?.principalId ?? room.roomId} isAgent={agentDirect} size="md" />
	{/if}

	<div class="min-w-0 flex-1">
		<div class="flex items-baseline justify-between gap-2">
			<span class="flex min-w-0 items-center gap-1.5">
				<span class={cn('truncate font-semibold', active ? 'text-foreground' : 'text-foreground')}>
					{name}
				</span>
				{#if agentDirect}
					<Badge tone="agent">Agent</Badge>
				{/if}
			</span>
			{#if timestamp}
				<span class={cn('shrink-0 text-xs', unread > 0 ? 'font-semibold text-primary' : 'text-faint')}>
					{timestamp}
				</span>
			{/if}
		</div>
		<div class="mt-0.5 flex items-center justify-between gap-2">
			<span class="line-clamp-1 min-w-0 flex-1 text-sm text-muted">{preview}</span>
			{#if unread > 0}
				<span
					class="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground"
				>
					{unread > 99 ? '99+' : unread}
				</span>
			{/if}
		</div>
	</div>
</a>
