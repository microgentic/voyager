<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { Copy, Forward, MessagesSquare, Pencil, Search, Trash2, X } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { messages, rooms, toasts, type ChatMessage } from '$lib/stores';
	import MessageBubble from './MessageBubble.svelte';
	import Composer from './Composer.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { parseServerDate } from '$lib/utils/time';

	let {
		room,
		rootEnvelopeId,
		onClose
	}: {
		room: Room;
		rootEnvelopeId: string;
		onClose: () => void;
	} = $props();

	const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;
	const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

	const root = $derived(messages.findByEnvelopeId(room.roomId, rootEnvelopeId));
	const replies = $derived(messages.threadList(rootEnvelopeId));
	const rootDeleted = $derived(Boolean(root?.deletedForEveryone.deleted));

	let loading = $state(true);
	let scrollEl = $state<HTMLDivElement>();
	let editingReply = $state<ChatMessage | null>(null);
	let actionMenu = $state<{ message: ChatMessage; x: number; y: number } | null>(null);
	let deleteConfirmOpen = $state(false);
	let deleteScope = $state<'for_me' | 'everyone'>('for_me');
	let deleteTarget = $state<ChatMessage | null>(null);
	let deleting = $state(false);
	let forwardOpen = $state(false);
	let forwarding = $state(false);
	let forwardTarget = $state<ChatMessage | null>(null);
	let forwardQuery = $state('');

	const forwardCandidates = $derived(
		rooms.sorted.filter(
			(candidate) =>
				candidate.roomId !== room.roomId &&
				candidate.status === 'active' &&
				rooms.displayName(candidate).toLowerCase().includes(forwardQuery.trim().toLowerCase())
		)
	);

	// Load the thread when the pane opens or switches roots; realtime hints keep
	// it fresh afterwards by writing into the same thread store.
	$effect(() => {
		const id = rootEnvelopeId;
		const roomId = room.roomId;
		untrack(() => {
			loading = true;
			editingReply = null;
			actionMenu = null;
			void messages
				.openThread(roomId, id)
				.catch(() => undefined)
				.finally(() => {
					loading = false;
					void scrollToBottom();
				});
		});
	});

	// Mark replies read while the thread is on screen.
	$effect(() => {
		const count = replies.length;
		if (rootEnvelopeId && count >= 0) messages.markThreadRead(room.roomId, rootEnvelopeId);
	});

	// Keep the newest reply in view as the thread grows.
	$effect(() => {
		if (replies.length) void scrollToBottom();
	});

	onMount(() => void scrollToBottom());

	async function scrollToBottom(): Promise<void> {
		await tick();
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	}

	function clampMenuPosition(x: number, y: number): { x: number; y: number } {
		const width = 224;
		const height = 320;
		const margin = 10;
		return {
			x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
			y: Math.max(margin, Math.min(y, window.innerHeight - height - margin))
		};
	}

	function openActionMenu(message: ChatMessage, x: number, y: number): void {
		actionMenu = { message, ...clampMenuPosition(x, y) };
	}

	function closeActionMenu(): void {
		actionMenu = null;
	}

	function canForward(message: ChatMessage): boolean {
		return (
			Boolean(message.envelopeId) &&
			message.delivery === 'sent' &&
			!message.content.undecodable &&
			!message.deletedForEveryone.deleted
		);
	}

	function withinDeleteWindow(message: ChatMessage): boolean {
		const sentAt = parseServerDate(message.serverReceivedAt ?? message.clientCreatedAt);
		if (!sentAt) return true;
		return Date.now() - sentAt.getTime() <= DELETE_FOR_EVERYONE_WINDOW_MS;
	}

	function canDeleteForEveryone(message: ChatMessage): boolean {
		if (!message.envelopeId || message.delivery !== 'sent' || message.deletedForEveryone.deleted) return false;
		if (room.type !== 'direct' && rooms.canManage(room)) return true;
		return message.mine && withinDeleteWindow(message);
	}

	function canEdit(message: ChatMessage): boolean {
		return (
			message.mine &&
			message.delivery === 'sent' &&
			!message.content.undecodable &&
			!message.deletedForEveryone.deleted
		);
	}

	async function reactTo(message: ChatMessage, reaction: string): Promise<void> {
		closeActionMenu();
		try {
			await messages.toggleReaction(message, reaction);
		} catch {
			toasts.error('Could not update reaction.');
		}
	}

	function startEdit(message: ChatMessage): void {
		closeActionMenu();
		editingReply = message;
	}

	function openForward(message: ChatMessage): void {
		if (!canForward(message)) return;
		closeActionMenu();
		forwardTarget = message;
		forwardQuery = '';
		forwardOpen = true;
	}

	async function forwardTo(targetRoomId: string): Promise<void> {
		if (!forwardTarget || forwarding) return;
		forwarding = true;
		try {
			await messages.forwardToRoom(forwardTarget, targetRoomId);
			const target = rooms.get(targetRoomId);
			toasts.success(`Forwarded to ${target ? rooms.displayName(target) : 'conversation'}.`);
			forwardOpen = false;
			forwardTarget = null;
		} catch {
			toasts.error('Could not forward message.');
		} finally {
			forwarding = false;
		}
	}

	async function copyOne(message: ChatMessage): Promise<void> {
		closeActionMenu();
		const text = message.deletedForEveryone.deleted || message.content.undecodable ? '' : message.content.body.trim();
		if (!text) {
			toasts.error('Nothing to copy.');
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			toasts.success('Copied.');
		} catch {
			toasts.error('Could not copy message.');
		}
	}

	function requestDelete(message: ChatMessage, scope: 'for_me' | 'everyone'): void {
		closeActionMenu();
		deleteTarget = message;
		deleteScope = scope;
		deleteConfirmOpen = true;
	}

	async function deleteConfirmed(): Promise<void> {
		const target = deleteTarget;
		if (!target?.envelopeId || deleting) return;
		deleting = true;
		try {
			if (deleteScope === 'everyone') await messages.deleteForEveryone(room.roomId, [target.envelopeId]);
			else await messages.deleteForMe(room.roomId, [target.envelopeId]);
			toasts.success(deleteScope === 'everyone' ? 'Message deleted for everyone.' : 'Message deleted for you.');
			deleteConfirmOpen = false;
			deleteTarget = null;
		} catch {
			toasts.error('Could not delete message.');
		} finally {
			deleting = false;
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-surface">
	<div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
		<div class="flex items-center gap-2 font-semibold text-foreground">
			<MessagesSquare class="h-4 w-4 text-primary" />
			<span>Thread</span>
			{#if root?.threadSummary}
				<span class="text-sm font-normal text-muted">
					· {root.threadSummary.replyCount}
					{root.threadSummary.replyCount === 1 ? 'reply' : 'replies'}
				</span>
			{/if}
		</div>
		<button
			type="button"
			class="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-foreground"
			aria-label="Close thread"
			onclick={onClose}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if loading && !root}
		<div class="grid flex-1 place-items-center"><Spinner class="text-primary" /></div>
	{:else if !root}
		<div class="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
			<div class="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2 text-muted">
				<MessagesSquare class="h-6 w-6" />
			</div>
			<p class="text-sm text-muted">This thread is no longer available.</p>
		</div>
	{:else}
		<div bind:this={scrollEl} class="min-h-0 flex-1 overflow-y-auto py-2">
			<MessageBubble message={root} {room} isFirstOfGroup isLastOfGroup inThread onActionRequest={openActionMenu} />
			<div class="my-2 flex items-center gap-3 px-4">
				<span class="text-xs font-medium text-muted">
					{replies.length}
					{replies.length === 1 ? 'reply' : 'replies'}
				</span>
				<div class="h-px flex-1 bg-border"></div>
			</div>
			{#each replies as reply (reply.key)}
				<MessageBubble message={reply} {room} isFirstOfGroup isLastOfGroup inThread onActionRequest={openActionMenu} />
			{/each}
		</div>

		{#if rootDeleted}
			<div class="shrink-0 border-t border-border bg-surface px-4 py-4 text-center text-sm text-muted">
				This message was deleted. You can’t add new replies.
			</div>
		{:else}
			<Composer
				{room}
				threadRoot={root}
				editingMessage={editingReply}
				onCancelContext={() => (editingReply = null)}
				onSent={() => (editingReply = null)}
			/>
		{/if}
	{/if}
</div>

{#if actionMenu}
	<button
		type="button"
		class="fixed inset-0 z-40 cursor-default bg-transparent"
		aria-label="Close message actions"
		onclick={closeActionMenu}
	></button>
	<div
		class="fixed z-50 w-56 overflow-hidden rounded-xl border border-border bg-elevated p-1.5 text-sm shadow-pop"
		style={`left: ${actionMenu.x}px; top: ${actionMenu.y}px;`}
	>
		{#if actionMenu.message.envelopeId && actionMenu.message.delivery === 'sent' && !actionMenu.message.deletedForEveryone.deleted}
			<div class="grid grid-cols-6 gap-1 p-1">
				{#each QUICK_REACTIONS as reaction}
					<button
						type="button"
						class="grid h-8 w-8 place-items-center rounded-lg text-base transition hover:bg-surface-2"
						aria-label={`React with ${reaction}`}
						onclick={() => void reactTo(actionMenu!.message, reaction)}
					>
						{reaction}
					</button>
				{/each}
			</div>
			<div class="my-1 h-px bg-border"></div>
		{/if}
		{#if canEdit(actionMenu.message)}
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
				onclick={() => startEdit(actionMenu!.message)}
			>
				<Pencil class="h-4 w-4 opacity-80" />
				<span>Edit</span>
			</button>
		{/if}
		{#if canForward(actionMenu.message)}
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
				onclick={() => openForward(actionMenu!.message)}
			>
				<Forward class="h-4 w-4 opacity-80" />
				<span>Forward</span>
			</button>
		{/if}
		<button
			type="button"
			class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
			onclick={() => void copyOne(actionMenu!.message)}
		>
			<Copy class="h-4 w-4 opacity-80" />
			<span>Copy</span>
		</button>
		<div class="my-1 h-px bg-border"></div>
		{#if canDeleteForEveryone(actionMenu.message)}
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-danger transition hover:bg-danger-soft"
				onclick={() => requestDelete(actionMenu!.message, 'everyone')}
			>
				<Trash2 class="h-4 w-4 opacity-80" />
				<span>Delete for everyone</span>
			</button>
		{/if}
		<button
			type="button"
			class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-danger transition hover:bg-danger-soft"
			onclick={() => requestDelete(actionMenu!.message, 'for_me')}
		>
			<Trash2 class="h-4 w-4 opacity-80" />
			<span>Delete for me</span>
		</button>
	</div>
{/if}

<ConfirmDialog
	bind:open={deleteConfirmOpen}
	title={deleteScope === 'everyone' ? 'Delete for everyone?' : 'Delete for you?'}
	message={deleteScope === 'everyone'
		? 'This reply will be replaced with a tombstone for all room members.'
		: 'This reply will stay visible to other room members.'}
	confirmLabel="Delete"
	danger
	loading={deleting}
	onConfirm={deleteConfirmed}
/>

<Modal bind:open={forwardOpen} title="Forward message" size="sm" onClose={() => (forwardTarget = null)}>
	<div class="space-y-3">
		<div class="relative flex items-center">
			<Search class="pointer-events-none absolute left-3 h-4 w-4 text-faint" />
			<input
				bind:value={forwardQuery}
				type="search"
				placeholder="Search conversations"
				class="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary"
			/>
		</div>
		<div class="max-h-80 space-y-1 overflow-y-auto">
			{#if forwardCandidates.length === 0}
				<p class="py-6 text-center text-sm text-muted">No available conversations.</p>
			{:else}
				{#each forwardCandidates as candidate (candidate.roomId)}
					<button
						type="button"
						disabled={forwarding}
						class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-surface-2 disabled:opacity-60"
						onclick={() => void forwardTo(candidate.roomId)}
					>
						<span class="min-w-0 truncate font-medium text-foreground">{rooms.displayName(candidate)}</span>
						<span class="shrink-0 text-xs capitalize text-muted">{candidate.type}</span>
					</button>
				{/each}
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (forwardOpen = false)} disabled={forwarding}>Cancel</Button>
	{/snippet}
</Modal>
