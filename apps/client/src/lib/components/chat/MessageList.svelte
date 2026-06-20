<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { ArrowDown, Hand } from '@lucide/svelte';
	import type { Room } from '$lib/api/types';
	import { messages, rooms, type ChatMessage } from '$lib/stores';
	import MessageBubble from './MessageBubble.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { parseServerDate, sameDay, formatDayDivider } from '$lib/utils/time';

	let { room }: { room: Room } = $props();

	const GROUP_GAP_MS = 5 * 60 * 1000;

	type Row =
		| { type: 'divider'; key: string; label: string }
		| { type: 'msg'; key: string; message: ChatMessage; first: boolean; last: boolean };

	const list = $derived(messages.list(room.roomId));
	const loading = $derived(messages.loadingRoom === room.roomId && list.length === 0);

	const rows = $derived.by<Row[]>(() => {
		const out: Row[] = [];
		for (let i = 0; i < list.length; i += 1) {
			const m = list[i];
			const prev = list[i - 1];
			const next = list[i + 1];
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

	function onScroll(): void {
		const el = scrollEl;
		if (!el) return;
		atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
	}

	async function toBottom(behavior: ScrollBehavior = 'auto'): Promise<void> {
		await tick();
		const el = scrollEl;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior });
		atBottom = true;
	}

	function inputHasFocus(): boolean {
		const active = document.activeElement;
		return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
	}

	onMount(() => {
		const viewport = window.visualViewport;
		if (!viewport) return undefined;

		let previousHeight = viewport.height;
		const keepLatestVisible = () => {
			const height = viewport.height;
			const keyboardOpened = height < previousHeight - 24;
			previousHeight = height;
			if (keyboardOpened && inputHasFocus()) void toBottom('auto');
		};

		viewport.addEventListener('resize', keepLatestVisible);
		viewport.addEventListener('scroll', keepLatestVisible);
		return () => {
			viewport.removeEventListener('resize', keepLatestVisible);
			viewport.removeEventListener('scroll', keepLatestVisible);
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
</script>

<div class="relative min-h-0 flex-1 select-none">
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
					/>
				{/if}
			{/each}
		{/if}
	</div>

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
</div>
