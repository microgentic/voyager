<script lang="ts">
	import { Check, CheckCheck, Clock, CircleAlert, Bot, Lock, CornerUpLeft, Pin, Forward, Trash2, MessagesSquare, ChevronRight, CornerDownRight } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { messages, type ChatMessage } from '$lib/stores';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import AttachmentView from './AttachmentView.svelte';
	import type { AttachmentRef } from '$lib/protocol/codec';
	import { cn } from '$lib/utils/cn';
	import { nameColor } from '$lib/utils/avatar';
	import { formatClock } from '$lib/utils/time';
	import { renderMarkdown, renderPlainText } from '$lib/utils/markdown';

	let {
		message,
		room,
		isFirstOfGroup,
		isLastOfGroup,
		selected = false,
		selectionMode = false,
		inThread = false,
		onActionRequest,
		onToggleSelect,
		onOpenThread
	}: {
		message: ChatMessage;
		room: Room;
		isFirstOfGroup: boolean;
		isLastOfGroup: boolean;
		selected?: boolean;
		selectionMode?: boolean;
		inThread?: boolean;
		onActionRequest?: (message: ChatMessage, x: number, y: number) => void;
		onToggleSelect?: (message: ChatMessage) => void;
		onOpenThread?: (rootEnvelopeId: string) => void;
	} = $props();

	const roomLabel = $derived(room.type === 'direct' ? 'chat' : `#${room.name ?? 'room'}`);
	// In the main timeline, a root with replies shows a thread summary; a reply
	// that was also sent to the room shows a small "thread reply" affordance.
	const threadSummary = $derived(!inThread ? message.threadSummary : null);
	const threadReplyTime = $derived(formatClock(message.threadSummary?.lastReplyAt ?? null));
	const lastReplySender = $derived(
		message.threadSummary
			? room.members.find((m) => m.principalId === message.threadSummary?.lastReplySenderPrincipalId)
			: undefined
	);
	const showThreadReplyTag = $derived(!inThread && Boolean(message.threadRootEnvelopeId));

	const mine = $derived(message.mine);
	const isGroup = $derived(room.type === 'group');
	const sender = $derived(room.members.find((m) => m.principalId === message.senderPrincipalId));
	const isAgentSender = $derived(sender?.principalType === 'agent');
	const senderName = $derived(sender?.displayName ?? 'Unknown');
	const showName = $derived(isGroup && !mine && isFirstOfGroup);
	const showAvatar = $derived(!mine && isLastOfGroup);
	const replyMessage = $derived(messages.findByEnvelopeId(room.roomId, message.content.replyToMessageId));
	const replySender = $derived(
		replyMessage ? room.members.find((m) => m.principalId === replyMessage.senderPrincipalId) : undefined
	);
	const replyAuthor = $derived(replyMessage?.mine ? 'You' : (replySender?.displayName ?? 'Message'));
	const replyText = $derived(
		replyMessage?.deletedForEveryone.deleted
			? 'Message deleted'
			: replyMessage?.content.undecodable
				? 'Message can’t be displayed'
				: (replyMessage?.content.body.trim() ?? 'Original message')
	);
	const isDeletedForEveryone = $derived(message.deletedForEveryone.deleted);

	const attachments = $derived(message.content.attachments ?? []);
	const imageAttachments = $derived(attachments.filter(isImageAttachment));
	const allAttachmentsAreImages = $derived(attachments.length > 1 && imageAttachments.length === attachments.length);
	const hasBody = $derived(!isDeletedForEveryone && message.content.body.trim().length > 0);
	const html = $derived(
		isDeletedForEveryone || message.content.undecodable
			? ''
			: message.content.contentType === 'text/markdown'
				? renderMarkdown(message.content.body)
				: renderPlainText(message.content.body)
	);
	const time = $derived(formatClock(message.serverReceivedAt ?? message.clientCreatedAt));
	const receiptStatus = $derived(message.receiptSummary.status);

	let longPressTimer: number | undefined;
	let pointerStart: { x: number; y: number } | null = null;

	function clearLongPress(): void {
		if (longPressTimer !== undefined) {
			window.clearTimeout(longPressTimer);
			longPressTimer = undefined;
		}
		pointerStart = null;
	}

	function openActions(event: MouseEvent | PointerEvent): void {
		onActionRequest?.(message, event.clientX, event.clientY);
	}

	function handleContextMenu(event: MouseEvent): void {
		event.preventDefault();
		openActions(event);
	}

	function handleClick(event: MouseEvent): void {
		if (!selectionMode) return;
		event.preventDefault();
		onToggleSelect?.(message);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		if (selectionMode) {
			event.preventDefault();
			onToggleSelect?.(message);
			return;
		}
		const target = event.currentTarget;
		if (target instanceof HTMLElement) {
			const rect = target.getBoundingClientRect();
			onActionRequest?.(message, rect.left + rect.width / 2, rect.top + rect.height / 2);
		}
	}

	function handlePointerDown(event: PointerEvent): void {
		if (event.pointerType === 'mouse' || selectionMode) return;
		pointerStart = { x: event.clientX, y: event.clientY };
		longPressTimer = window.setTimeout(() => {
			openActions(event);
			clearLongPress();
		}, 520);
	}

	function handlePointerMove(event: PointerEvent): void {
		if (!pointerStart) return;
		const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
		if (moved > 10) clearLongPress();
	}

	async function toggleReaction(event: MouseEvent, reaction: string): Promise<void> {
		event.preventDefault();
		event.stopPropagation();
		if (selectionMode) return;
		await messages.toggleReaction(message, reaction).catch(() => undefined);
	}

	function isImageAttachment(attachment: AttachmentRef): boolean {
		return attachment.mediaKind === 'image' || attachment.mediaType.startsWith('image/');
	}

	function galleryIndexFor(attachment: AttachmentRef): number {
		return imageAttachments.findIndex((item) => item.attachmentId === attachment.attachmentId);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions: message rows use custom context-menu and long-press gestures. -->
<div
	role="button"
	tabindex="0"
	oncontextmenu={handleContextMenu}
	onclick={handleClick}
	onkeydown={handleKeydown}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={clearLongPress}
	onpointercancel={clearLongPress}
	onpointerleave={clearLongPress}
	class={cn(
		'flex w-full min-w-0 select-none gap-2 px-3 outline-none transition-colors sm:px-4',
		mine ? 'justify-end' : 'justify-start',
		isLastOfGroup ? 'mb-2' : 'mb-0.5',
		selectionMode && 'cursor-pointer',
		selected && 'bg-primary-soft/45'
	)}
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
				isLastOfGroup && (mine ? 'rounded-br-md' : 'rounded-bl-md'),
				selected && 'ring-2 ring-primary/70'
			)}
		>
			{#if message.pin.pinned}
				<div class={cn('mb-1 flex items-center gap-1 text-[11px] font-semibold', mine ? 'text-white/75' : 'text-primary')}>
					<Pin class="h-3 w-3 fill-current" />
					<span>Pinned</span>
				</div>
			{/if}

			{#if message.forwardedFrom}
				<div class={cn('mb-1 flex items-center gap-1 text-[11px] font-semibold', mine ? 'text-white/75' : 'text-muted')}>
					<Forward class="h-3 w-3" />
					<span>Forwarded</span>
				</div>
			{/if}

			{#if inThread && message.alsoSentToRoom}
				<div class={cn('mb-1 flex items-center gap-1 text-[11px] font-semibold', mine ? 'text-white/75' : 'text-muted')}>
					<CornerDownRight class="h-3 w-3" />
					<span>Also sent to {roomLabel}</span>
				</div>
			{/if}

			{#if showThreadReplyTag}
				<button
					type="button"
					onclick={(event) => {
						event.stopPropagation();
						if (message.threadRootEnvelopeId) onOpenThread?.(message.threadRootEnvelopeId);
					}}
					class={cn(
						'mb-1 flex items-center gap-1 text-[11px] font-semibold underline-offset-2 hover:underline',
						mine ? 'text-white/80' : 'text-primary'
					)}
				>
					<CornerDownRight class="h-3 w-3" />
					<span>Thread reply</span>
				</button>
			{/if}

			{#if showName}
				<div class="mb-0.5 flex items-center gap-1 text-[13px] font-semibold" style="color:{nameColor(message.senderPrincipalId)}">
					{senderName}
					{#if isAgentSender}<Bot class="h-3.5 w-3.5 text-agent" />{/if}
				</div>
			{/if}

			{#if message.content.replyToMessageId && !isDeletedForEveryone}
				<div
					class={cn(
						'mb-1.5 flex max-w-full gap-2 rounded-xl px-2.5 py-2 text-xs',
						mine ? 'bg-white/10 text-white/85' : 'bg-surface/70 text-muted'
					)}
				>
					<CornerUpLeft class="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<div class="min-w-0">
						<div class={cn('truncate font-semibold', mine ? 'text-white' : 'text-foreground')}>{replyAuthor}</div>
						<div class="truncate">{replyText}</div>
					</div>
				</div>
			{/if}

			{#if isDeletedForEveryone}
				<p class="flex items-center gap-1.5 italic opacity-80">
					<Trash2 class="h-4 w-4" /> Message deleted
				</p>
			{:else if message.content.undecodable}
				<p class="flex items-center gap-1.5 italic opacity-80">
					<Lock class="h-4 w-4" /> Message can’t be displayed
				</p>
			{:else}
				{#if attachments.length}
					<div
						class={cn(
							'mb-1.5 gap-1.5',
							allAttachmentsAreImages ? 'grid grid-cols-2' : 'flex flex-col'
						)}
					>
						{#each attachments as att (att.attachmentId)}
							<AttachmentView
								attachment={att}
								{mine}
								gallery={isImageAttachment(att) ? imageAttachments : []}
								galleryIndex={galleryIndexFor(att)}
								grid={allAttachmentsAreImages}
							/>
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
				{#if message.editCount > 0}
					<span>edited</span>
				{/if}
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
					{:else if receiptStatus === 'read'}
						<CheckCheck class="h-4 w-4 text-white" />
					{:else if receiptStatus === 'delivered'}
						<CheckCheck class="h-4 w-4 text-white/75" />
					{:else}
						<Check class="h-4 w-4" />
					{/if}
				{/if}
			</div>
		</div>
		{#if message.reactions.length && !isDeletedForEveryone}
			<div class={cn('mt-1 flex max-w-full flex-wrap gap-1', mine ? 'justify-end pr-1' : 'justify-start pl-1')}>
				{#each message.reactions as reaction (reaction.reaction)}
					<button
						type="button"
						class={cn(
							'flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-semibold shadow-xs transition',
							reaction.reactedByMe
								? 'border-primary/45 bg-primary-soft text-primary'
								: 'border-border bg-surface-2 text-muted hover:text-foreground'
						)}
						aria-label={`Toggle ${reaction.reaction} reaction`}
						onclick={(event) => void toggleReaction(event, reaction.reaction)}
					>
						<span>{reaction.reaction}</span>
						<span>{reaction.count}</span>
					</button>
				{/each}
			</div>
		{/if}
		{#if threadSummary && onOpenThread}
			<button
				type="button"
				onclick={() => message.envelopeId && onOpenThread?.(message.envelopeId)}
				class={cn(
					'mt-1 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-primary transition hover:bg-surface-3',
					mine ? 'self-end' : 'self-start'
				)}
			>
				{#if lastReplySender}
					<Avatar name={lastReplySender.displayName} seed={lastReplySender.principalId} size="xs" />
				{:else}
					<MessagesSquare class="h-4 w-4" />
				{/if}
				<span>{threadSummary.replyCount} {threadSummary.replyCount === 1 ? 'reply' : 'replies'}</span>
				{#if threadReplyTime}<span class="font-normal text-faint">· last reply {threadReplyTime}</span>{/if}
				<ChevronRight class="h-3.5 w-3.5 text-faint" />
			</button>
		{/if}
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
