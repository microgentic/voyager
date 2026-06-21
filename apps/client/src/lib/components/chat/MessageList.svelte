<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { ArrowDown, CheckSquare, Copy, Forward, Hand, Info, Pencil, Pin, PinOff, Reply, RotateCcw, Search, Trash2, X } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { messages, rooms, toasts, type ChatMessage } from '$lib/stores';
	import MessageBubble from './MessageBubble.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import { parseServerDate, sameDay, formatDayDivider } from '$lib/utils/time';

	let {
		room,
		searchOpen = $bindable(false),
		onReply,
		onEdit
	}: {
		room: Room;
		searchOpen?: boolean;
		onReply?: (message: ChatMessage) => void;
		onEdit?: (message: ChatMessage) => void;
	} = $props();

	const GROUP_GAP_MS = 5 * 60 * 1000;
	const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

	type Row =
		| { type: 'divider'; key: string; label: string }
		| { type: 'msg'; key: string; message: ChatMessage; first: boolean; last: boolean };

	const list = $derived(messages.list(room.roomId));
	let searchQuery = $state('');
	const normalizedSearchQuery = $derived(searchQuery.trim().toLowerCase());
	const visibleList = $derived.by<ChatMessage[]>(() => {
		if (!normalizedSearchQuery) return list;
		return list.filter((message) => messageMatchesSearch(message, normalizedSearchQuery));
	});
	const loading = $derived(messages.loadingRoom === room.roomId && list.length === 0);

	const rows = $derived.by<Row[]>(() => {
		const out: Row[] = [];
		for (let i = 0; i < visibleList.length; i += 1) {
			const m = visibleList[i];
			const prev = visibleList[i - 1];
			const next = visibleList[i + 1];
			const date = parseServerDate(m.serverReceivedAt ?? m.clientCreatedAt);
			const prevDate = prev ? parseServerDate(prev.serverReceivedAt ?? prev.clientCreatedAt) : null;
			const nextDate = next ? parseServerDate(next.serverReceivedAt ?? next.clientCreatedAt) : null;

			const newDay = !prev || !sameDay(date, prevDate);
			if (newDay) {
				out.push({ type: 'divider', key: `d-${m.key}`, label: formatDayDivider(date) });
			}

			const gapBefore =
				newDay ||
				prev?.senderPrincipalId !== m.senderPrincipalId ||
				(date && prevDate ? date.getTime() - prevDate.getTime() > GROUP_GAP_MS : true);
			const gapAfter =
				!next ||
				!sameDay(date, nextDate) ||
				next.senderPrincipalId !== m.senderPrincipalId ||
				(date && nextDate ? nextDate.getTime() - date.getTime() > GROUP_GAP_MS : true);

			out.push({ type: 'msg', key: m.key, message: m, first: gapBefore, last: gapAfter });
		}
		return out;
	});

	let scrollEl = $state<HTMLDivElement>();
	let atBottom = $state(true);
	let prevCount = 0;
	let prevRoom = '';
	let selectionRoom = '';
	let selectedKeys = $state<string[]>([]);
	let actionMenu = $state<{ message: ChatMessage; x: number; y: number } | null>(null);
	let deleteConfirmOpen = $state(false);
	let deleteScope = $state<'for_me' | 'everyone'>('for_me');
	let deleting = $state(false);
	let forwardOpen = $state(false);
	let forwarding = $state(false);
	let forwardMessage = $state<ChatMessage | null>(null);
	let forwardQuery = $state('');
	let bottomSettleTimers: number[] = [];

	const selectedMessages = $derived(list.filter((message) => selectedKeys.includes(message.key)));
	const selectionMode = $derived(selectedKeys.length > 0);
	const forwardCandidates = $derived(
		rooms.sorted.filter(
			(candidate) =>
				candidate.roomId !== room.roomId &&
				candidate.status === 'active' &&
				rooms.displayName(candidate).toLowerCase().includes(forwardQuery.trim().toLowerCase())
		)
	);

	function onScroll(): void {
		const el = scrollEl;
		if (!el) return;
		atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
	}

	async function toBottom(behavior: ScrollBehavior = 'auto'): Promise<void> {
		await tick();
		const el = scrollEl;
		if (!el) return;
		if (behavior === 'auto') {
			el.scrollTop = el.scrollHeight;
		} else {
			el.scrollTo({ top: el.scrollHeight, behavior });
		}
		atBottom = true;
	}

	function clearBottomSettleTimers(): void {
		for (const timer of bottomSettleTimers) window.clearTimeout(timer);
		bottomSettleTimers = [];
	}

	function settleToBottom(): void {
		clearBottomSettleTimers();
		for (const delay of [0, 50, 120, 220, 360, 520, 760]) {
			bottomSettleTimers.push(window.setTimeout(() => void toBottom('auto'), delay));
		}
	}

	function inputHasFocus(): boolean {
		const active = document.activeElement;
		return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
	}

	function clampMenuPosition(x: number, y: number): { x: number; y: number } {
		const width = 224;
		const height = 380;
		const margin = 10;
		return {
			x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
			y: Math.max(margin, Math.min(y, window.innerHeight - height - margin))
		};
	}

	function openActionMenu(message: ChatMessage, x: number, y: number): void {
		if (selectionMode) {
			toggleSelected(message);
			return;
		}
		actionMenu = { message, ...clampMenuPosition(x, y) };
	}

	function closeActionMenu(): void {
		actionMenu = null;
	}

	function toggleSelected(message: ChatMessage): void {
		closeActionMenu();
		selectedKeys = selectedKeys.includes(message.key)
			? selectedKeys.filter((key) => key !== message.key)
			: [...selectedKeys, message.key];
	}

	function selectOnly(message: ChatMessage): void {
		closeActionMenu();
		selectedKeys = [message.key];
	}

	function replyTo(message: ChatMessage): void {
		closeActionMenu();
		selectedKeys = [];
		onReply?.(message);
	}

	function editMessage(message: ChatMessage): void {
		closeActionMenu();
		selectedKeys = [];
		onEdit?.(message);
	}

	async function reactTo(message: ChatMessage, reaction: string): Promise<void> {
		closeActionMenu();
		try {
			await messages.toggleReaction(message, reaction);
		} catch {
			toasts.error('Could not update reaction.');
		}
	}

	async function togglePinned(message: ChatMessage): Promise<void> {
		closeActionMenu();
		try {
			await messages.setPinned(message, !message.pin.pinned);
			toasts.success(message.pin.pinned ? 'Message unpinned.' : 'Message pinned.');
		} catch {
			toasts.error('Could not update pinned message.');
		}
	}

	function canPin(message: ChatMessage): boolean {
		if (!message.envelopeId || message.delivery !== 'sent' || message.deletedForEveryone.deleted) return false;
		return room.type === 'direct' || rooms.canManage(room);
	}

	function canForward(message: ChatMessage): boolean {
		return Boolean(message.envelopeId) && message.delivery === 'sent' && !message.content.undecodable && !message.deletedForEveryone.deleted;
	}

	function canDeleteForEveryone(message: ChatMessage): boolean {
		if (!message.envelopeId || message.delivery !== 'sent' || message.deletedForEveryone.deleted) return false;
		return message.mine || (room.type !== 'direct' && rooms.canManage(room));
	}

	function selectAll(): void {
		selectedKeys = list.map((message) => message.key);
	}

	function cancelSelection(): void {
		selectedKeys = [];
		closeActionMenu();
	}

	function messageText(message: ChatMessage): string {
		if (message.deletedForEveryone.deleted || message.content.undecodable) return '';
		return message.content.body.trim();
	}

	function messageMatchesSearch(message: ChatMessage, query: string): boolean {
		const body = messageText(message).toLowerCase();
		if (body.includes(query)) return true;
		const sender = room.members.find((member) => member.principalId === message.senderPrincipalId);
		return Boolean(sender?.displayName.toLowerCase().includes(query));
	}

	async function copyMessages(items: ChatMessage[]): Promise<void> {
		const text = items.map(messageText).filter(Boolean).join('\n\n');
		if (!text) {
			toasts.info('No displayable text to copy.');
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			toasts.success(items.length === 1 ? 'Message copied.' : `${items.length} messages copied.`);
		} catch {
			toasts.error('Could not copy messages.');
		}
	}

	function showMessageInfo(message: ChatMessage): void {
		const sequence = message.serverSequence > 0 ? `Sequence ${message.serverSequence}` : 'Not sent yet';
		const status = message.delivery === 'failed' ? 'failed' : message.delivery === 'sending' ? 'sending' : message.state;
		toasts.info(`${sequence} · ${status}`, 'Message info');
		closeActionMenu();
	}

	function openForward(message: ChatMessage): void {
		if (!canForward(message)) return;
		closeActionMenu();
		forwardMessage = message;
		forwardQuery = '';
		forwardOpen = true;
	}

	async function forwardTo(targetRoomId: string): Promise<void> {
		if (!forwardMessage || forwarding) return;
		forwarding = true;
		try {
			const result = await messages.forwardToRoom(forwardMessage, targetRoomId);
			const target = rooms.get(targetRoomId);
			toasts.success(`Forwarded to ${target ? rooms.displayName(target) : 'conversation'}.`);
			if (result) void messages.fetchSequence(targetRoomId, result.serverSequence).catch(() => undefined);
			forwardOpen = false;
			forwardMessage = null;
		} catch {
			toasts.error('Could not forward message.');
		} finally {
			forwarding = false;
		}
	}

	function requestDelete(items: ChatMessage[], scope: 'for_me' | 'everyone' = 'for_me'): void {
		if (!items.length) return;
		closeActionMenu();
		selectedKeys = items.map((message) => message.key);
		deleteScope = scope;
		deleteConfirmOpen = true;
	}

	async function deleteSelected(): Promise<void> {
		const items = selectedMessages;
		if (!items.length) {
			deleteConfirmOpen = false;
			return;
		}
		const envelopeIds = items.map((message) => message.envelopeId).filter((id): id is string => Boolean(id));
		const localKeys = items.filter((message) => !message.envelopeId).map((message) => message.key);
		deleting = true;
		try {
			if (envelopeIds.length) {
				if (deleteScope === 'everyone') await messages.deleteForEveryone(room.roomId, envelopeIds);
				else await messages.deleteForMe(room.roomId, envelopeIds);
			}
			if (localKeys.length) messages.removeKeys(room.roomId, localKeys);
			toasts.success(
				deleteScope === 'everyone'
					? items.length === 1
						? 'Message deleted for everyone.'
						: `${items.length} messages deleted for everyone.`
					: items.length === 1
						? 'Message deleted for you.'
						: `${items.length} messages deleted for you.`
			);
			selectedKeys = [];
			deleteConfirmOpen = false;
		} catch {
			toasts.error('Could not delete messages.');
		} finally {
			deleting = false;
		}
	}

	onMount(() => {
		const viewport = window.visualViewport;
		const viewportHeight = () => Math.min(viewport?.height ?? window.innerHeight, window.innerHeight);

		let previousHeight = viewportHeight();
		const keepLatestVisible = () => {
			const height = viewportHeight();
			const heightChanged = Math.abs(height - previousHeight) > 1;
			previousHeight = height;
			if (heightChanged && inputHasFocus()) settleToBottom();
		};
		const keepLatestVisibleAfterFocus = (event: FocusEvent | Event) => {
			if (event.type === 'voyager:composer-focus') {
				settleToBottom();
				return;
			}
			const target = event.target;
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) settleToBottom();
		};

		viewport?.addEventListener('resize', keepLatestVisible);
		viewport?.addEventListener('scroll', keepLatestVisible);
		window.addEventListener('resize', keepLatestVisible);
		document.addEventListener('focusin', keepLatestVisibleAfterFocus);
		document.addEventListener('voyager:composer-focus', keepLatestVisibleAfterFocus);
		return () => {
			clearBottomSettleTimers();
			viewport?.removeEventListener('resize', keepLatestVisible);
			viewport?.removeEventListener('scroll', keepLatestVisible);
			window.removeEventListener('resize', keepLatestVisible);
			document.removeEventListener('focusin', keepLatestVisibleAfterFocus);
			document.removeEventListener('voyager:composer-focus', keepLatestVisibleAfterFocus);
		};
	});

	$effect(() => {
		const id = room.roomId;
		const count = list.length;
		untrack(() => {
			if (id !== prevRoom) {
				prevRoom = id;
				prevCount = count;
				void toBottom('auto');
				return;
			}
			if (count > prevCount) {
				const added = list.slice(prevCount);
				const lastMine = added.length > 0 && added[added.length - 1].mine;
				prevCount = count;
				if (lastMine || atBottom) void toBottom(lastMine ? 'smooth' : 'auto');
			} else {
				prevCount = count;
			}
		});
	});

	$effect(() => {
		const id = room.roomId;
		untrack(() => {
			if (id !== selectionRoom) {
				selectionRoom = id;
				selectedKeys = [];
				actionMenu = null;
				searchQuery = '';
				searchOpen = false;
			}
		});
	});
</script>

<div class="relative min-h-0 flex-1 select-none">
	{#if searchOpen}
		<div class="absolute inset-x-2 top-2 z-30 flex items-center gap-2 rounded-xl border border-border bg-elevated/95 p-2 shadow-pop backdrop-blur sm:inset-x-4">
			<Search class="h-4 w-4 shrink-0 text-faint" />
			<input
				bind:value={searchQuery}
				type="search"
				placeholder="Search this chat"
				class="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
			/>
			{#if normalizedSearchQuery}
				<span class="shrink-0 text-xs text-muted">{visibleList.length}</span>
			{/if}
			<button
				type="button"
				class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-foreground"
				aria-label="Close search"
				onclick={() => {
					searchQuery = '';
					searchOpen = false;
				}}
			>
				<X class="h-4 w-4" />
			</button>
		</div>
	{/if}

	{#if selectionMode}
		<div
			class="absolute inset-x-2 top-2 z-30 flex items-center gap-2 rounded-xl border border-border bg-elevated/95 p-2 text-sm shadow-pop backdrop-blur sm:inset-x-4"
		>
			<div class="min-w-0 flex-1 font-semibold text-foreground">
				{selectedKeys.length} selected
			</div>
			<Button variant="ghost" size="sm" onclick={() => void copyMessages(selectedMessages)}>
				<Copy class="h-4 w-4" />
				Copy
			</Button>
			{#if selectedMessages.length === 1 && canForward(selectedMessages[0])}
				<Button variant="ghost" size="sm" onclick={() => openForward(selectedMessages[0])}>
					<Forward class="h-4 w-4" />
					Forward
				</Button>
			{/if}
			<Button variant="ghost" size="sm" onclick={selectAll} disabled={selectedKeys.length === list.length}>
				<CheckSquare class="h-4 w-4" />
				All
			</Button>
			{#if selectedMessages.length > 0 && selectedMessages.every(canDeleteForEveryone)}
				<Button variant="ghost" size="sm" class="text-danger" onclick={() => requestDelete(selectedMessages, 'everyone')}>
					<Trash2 class="h-4 w-4" />
					Everyone
				</Button>
			{/if}
			<Button variant="ghost" size="sm" class="text-danger" onclick={() => requestDelete(selectedMessages)}>
				<Trash2 class="h-4 w-4" />
				Delete
			</Button>
			<Button variant="ghost" size="icon-sm" onclick={cancelSelection} aria-label="Cancel selection">
				<X class="h-4 w-4" />
			</Button>
		</div>
	{/if}

	<div
		bind:this={scrollEl}
		onscroll={onScroll}
		class="h-full overflow-y-auto overscroll-contain py-3 select-none"
	>
		{#if loading}
			<div class="grid h-full place-items-center"><Spinner class="text-primary" /></div>
		{:else if list.length === 0}
			<div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
				<div class="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2 text-primary">
					<Hand class="h-6 w-6" />
				</div>
				<p class="text-sm text-muted">
					{rooms.isAgentDirect(room)
						? 'Send a message to start working with this agent.'
						: 'No messages yet — say hello.'}
				</p>
			</div>
		{:else if visibleList.length === 0}
			<div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
				<div class="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2 text-primary">
					<Search class="h-6 w-6" />
				</div>
				<p class="text-sm text-muted">No messages match “{searchQuery}”.</p>
			</div>
		{:else}
			{#each rows as row (row.key)}
				{#if row.type === 'divider'}
					<div class="my-3 flex items-center justify-center">
						<span class="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted shadow-xs">
							{row.label}
						</span>
					</div>
				{:else}
					<MessageBubble
						message={row.message}
						{room}
						isFirstOfGroup={row.first}
						isLastOfGroup={row.last}
						selected={selectedKeys.includes(row.message.key)}
						{selectionMode}
						onActionRequest={openActionMenu}
						onToggleSelect={toggleSelected}
					/>
				{/if}
			{/each}
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
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
				onclick={() => replyTo(actionMenu!.message)}
			>
				<Reply class="h-4 w-4 opacity-80" />
				<span>Reply</span>
			</button>
			{#if actionMenu.message.mine && actionMenu.message.delivery === 'sent' && !actionMenu.message.content.undecodable && !actionMenu.message.deletedForEveryone.deleted}
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
					onclick={() => editMessage(actionMenu!.message)}
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
			{#if canPin(actionMenu.message)}
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
					onclick={() => void togglePinned(actionMenu!.message)}
				>
					{#if actionMenu.message.pin.pinned}
						<PinOff class="h-4 w-4 opacity-80" />
						<span>Unpin</span>
					{:else}
						<Pin class="h-4 w-4 opacity-80" />
						<span>Pin</span>
					{/if}
				</button>
			{/if}
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
				onclick={() => void copyMessages([actionMenu!.message]).then(closeActionMenu)}
			>
				<Copy class="h-4 w-4 opacity-80" />
				<span>Copy</span>
			</button>
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
				onclick={() => selectOnly(actionMenu!.message)}
			>
				<CheckSquare class="h-4 w-4 opacity-80" />
				<span>Select</span>
			</button>
			{#if actionMenu.message.delivery === 'failed'}
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
					onclick={() => {
						const message = actionMenu!.message;
						closeActionMenu();
						void messages.retry(message);
					}}
				>
					<RotateCcw class="h-4 w-4 opacity-80" />
					<span>Retry send</span>
				</button>
			{/if}
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-foreground transition hover:bg-surface-2"
				onclick={() => showMessageInfo(actionMenu!.message)}
			>
				<Info class="h-4 w-4 opacity-80" />
				<span>Message info</span>
			</button>
			<div class="my-1 h-px bg-border"></div>
			{#if canDeleteForEveryone(actionMenu.message)}
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-danger transition hover:bg-danger-soft"
					onclick={() => requestDelete([actionMenu!.message], 'everyone')}
				>
					<Trash2 class="h-4 w-4 opacity-80" />
					<span>Delete for everyone</span>
				</button>
			{/if}
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-danger transition hover:bg-danger-soft"
				onclick={() => requestDelete([actionMenu!.message])}
			>
				<Trash2 class="h-4 w-4 opacity-80" />
				<span>Delete for me</span>
			</button>
		</div>
	{/if}

	{#if !atBottom && list.length > 0}
		<button
			onclick={() => toBottom('smooth')}
			class="absolute bottom-3 right-4 grid h-10 w-10 place-items-center rounded-full border border-border bg-elevated text-foreground shadow-pop transition hover:bg-surface-2"
			aria-label="Jump to latest"
		>
			<ArrowDown class="h-5 w-5" />
			{#if messages.unread(room.roomId) > 0}
				<span
					class="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
				>
					{messages.unread(room.roomId)}
				</span>
			{/if}
		</button>
	{/if}

	<ConfirmDialog
		bind:open={deleteConfirmOpen}
		title={deleteScope === 'everyone' ? 'Delete for everyone?' : 'Delete for you?'}
		message={deleteScope === 'everyone'
			? 'The selected messages will be replaced with tombstones for all room members.'
			: 'The selected messages will stay visible to other room members.'}
		confirmLabel="Delete"
		danger
		loading={deleting}
		onConfirm={deleteSelected}
	/>

	<Modal bind:open={forwardOpen} title="Forward message" size="sm" onClose={() => (forwardMessage = null)}>
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
</div>
