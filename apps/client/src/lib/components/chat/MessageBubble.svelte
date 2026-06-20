<script lang="ts">
	import { Check, CheckCheck, Clock, CircleAlert, Bot, Lock } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { messages, type ChatMessage } from '$lib/stores';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import AttachmentView from './AttachmentView.svelte';
	import { cn } from '$lib/utils/cn';
	import { nameColor } from '$lib/utils/avatar';
	import { formatClock } from '$lib/utils/time';
	import { renderMarkdown, renderPlainText } from '$lib/utils/markdown';

	let {
		message,
		room,
		isFirstOfGroup,
		isLastOfGroup
	}: {
		message: ChatMessage;
		room: Room;
		isFirstOfGroup: boolean;
		isLastOfGroup: boolean;
	} = $props();

	const mine = $derived(message.mine);
	const isGroup = $derived(room.type === 'group');
	const sender = $derived(room.members.find((m) => m.principalId === message.senderPrincipalId));
	const isAgentSender = $derived(sender?.principalType === 'agent');
	const senderName = $derived(sender?.displayName ?? 'Unknown');
	const showName = $derived(isGroup && !mine && isFirstOfGroup);
	const showAvatar = $derived(!mine && isLastOfGroup);

	const hasBody = $derived(message.content.body.trim().length > 0);
	const html = $derived(
		message.content.undecodable
			? ''
			: message.content.contentType === 'text/markdown'
				? renderMarkdown(message.content.body)
				: renderPlainText(message.content.body)
	);
	const time = $derived(formatClock(message.serverReceivedAt ?? message.clientCreatedAt));
</script>

<div
	class={cn('flex w-full min-w-0 select-none gap-2 px-3 sm:px-4', mine ? 'justify-end' : 'justify-start', isLastOfGroup ? 'mb-2' : 'mb-0.5')}
>
	{#if !mine}
		<div class="w-8 shrink-0 self-end">
			{#if showAvatar}
				<Avatar name={senderName} seed={message.senderPrincipalId} isAgent={isAgentSender} size="xs" />
			{/if}
		</div>
	{/if}

	<div class={cn('flex min-w-0 max-w-[78%] flex-col sm:max-w-[68%]', mine ? 'items-end' : 'items-start')}>
		<div
			class={cn(
				'relative max-w-full select-none overflow-hidden px-3 py-2 text-[15px] leading-relaxed shadow-xs',
				mine
					? 'rounded-2xl bg-bubble-out text-bubble-out-foreground'
					: isAgentSender
						? 'rounded-2xl bg-agent-soft text-foreground ring-1 ring-agent/25'
						: 'rounded-2xl bg-bubble-in text-bubble-in-foreground',
				// flatten the tail corner on the last bubble of a group
				isLastOfGroup && (mine ? 'rounded-br-md' : 'rounded-bl-md')
			)}
		>
			{#if showName}
				<div class="mb-0.5 flex items-center gap-1 text-[13px] font-semibold" style="color:{nameColor(message.senderPrincipalId)}">
					{senderName}
					{#if isAgentSender}<Bot class="h-3.5 w-3.5 text-agent" />{/if}
				</div>
			{/if}

			{#if message.content.undecodable}
				<p class="flex items-center gap-1.5 italic opacity-80">
					<Lock class="h-4 w-4" /> Message can’t be displayed
				</p>
			{:else}
				{#if message.content.attachments?.length}
					<div class="mb-1.5 flex flex-col gap-1.5">
						{#each message.content.attachments as att (att.attachmentId)}
							<AttachmentView attachment={att} {mine} />
						{/each}
					</div>
				{/if}
				{#if hasBody}
					<div class="msg-prose select-text break-words">{@html html}</div>
				{/if}
			{/if}

			<div
				class={cn(
					'mt-0.5 flex items-center justify-end gap-1 text-[11px]',
					mine ? 'text-white/70' : 'text-faint'
				)}
			>
				<span>{time}</span>
				{#if mine}
					{#if message.delivery === 'sending'}
						<Clock class="h-3.5 w-3.5" />
					{:else if message.delivery === 'failed'}
						<button
							onclick={() => messages.retry(message)}
							class="inline-flex items-center gap-0.5 text-danger"
							aria-label="Failed — tap to retry"
						>
							<CircleAlert class="h-3.5 w-3.5" />
						</button>
					{:else if message.state === 'fully_acknowledged'}
						<CheckCheck class="h-4 w-4" />
					{:else}
						<Check class="h-4 w-4" />
					{/if}
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.msg-prose :global(p) {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.msg-prose,
	.msg-prose :global(*) {
		-webkit-user-select: text;
		user-select: text;
	}
	.msg-prose :global(p + p) {
		margin-top: 0.5rem;
	}
	.msg-prose :global(a) {
		text-decoration: underline;
		text-underline-offset: 2px;
		font-weight: 500;
	}
	.msg-prose :global(ul),
	.msg-prose :global(ol) {
		margin: 0.25rem 0;
		padding-left: 1.25rem;
	}
	.msg-prose :global(ul) {
		list-style: disc;
	}
	.msg-prose :global(ol) {
		list-style: decimal;
	}
	.msg-prose :global(code) {
		font-family: var(--font-mono);
		font-size: 0.85em;
		background: color-mix(in oklab, currentColor 12%, transparent);
		padding: 0.1em 0.35em;
		border-radius: 0.35rem;
	}
	.msg-prose :global(pre) {
		margin: 0.4rem 0;
		padding: 0.65rem 0.75rem;
		border-radius: 0.6rem;
		overflow-x: auto;
		background: color-mix(in oklab, currentColor 10%, transparent);
	}
	.msg-prose :global(pre code) {
		background: none;
		padding: 0;
	}
	.msg-prose :global(blockquote) {
		margin: 0.35rem 0;
		padding-left: 0.7rem;
		border-left: 3px solid color-mix(in oklab, currentColor 30%, transparent);
		opacity: 0.9;
	}
	.msg-prose :global(h1),
	.msg-prose :global(h2),
	.msg-prose :global(h3) {
		margin: 0.4rem 0 0.2rem;
		font-weight: 600;
		line-height: 1.25;
	}
	.msg-prose :global(h1) {
		font-size: 1.15em;
	}
	.msg-prose :global(h2) {
		font-size: 1.08em;
	}
	.msg-prose :global(table) {
		border-collapse: collapse;
		margin: 0.4rem 0;
		font-size: 0.92em;
	}
	.msg-prose :global(th),
	.msg-prose :global(td) {
		border: 1px solid color-mix(in oklab, currentColor 22%, transparent);
		padding: 0.25rem 0.5rem;
	}
</style>
