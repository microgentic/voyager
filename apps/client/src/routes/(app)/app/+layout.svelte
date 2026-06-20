<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { ui } from '$lib/stores';
	import { cn } from '$lib/utils/cn';
	import ConversationListPane from '$lib/components/nav/ConversationListPane.svelte';

	let { children } = $props();

	const PANE_WIDTH_KEY = 'voyager.conversationListWidth';
	const DEFAULT_PANE_WIDTH = 380;
	const MIN_PANE_WIDTH = 240;
	const MAX_PANE_WIDTH = 560;

	let splitShell: HTMLDivElement | null = $state(null);
	let listPaneWidth = $state(DEFAULT_PANE_WIDTH);
	let isResizing = $state(false);

	const roomId = $derived(page.params.roomId ?? null);
	const showList = $derived(ui.isWide || !roomId);
	const showDetail = $derived(ui.isWide || !!roomId);
	const clampedPaneWidth = $derived(clampPaneWidth(listPaneWidth));
	const paneWidthStyle = $derived(ui.isWide ? `width: ${clampedPaneWidth}px` : undefined);

	onMount(() => {
		const stored = Number(localStorage.getItem(PANE_WIDTH_KEY));
		if (Number.isFinite(stored)) {
			listPaneWidth = clampPaneWidth(stored);
		}
	});

	function clampPaneWidth(width: number): number {
		const availableWidth = splitShell?.clientWidth ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
		const viewportMax = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, availableWidth - 480));
		return Math.min(viewportMax, Math.max(MIN_PANE_WIDTH, width));
	}

	function persistPaneWidth(width: number): void {
		try {
			localStorage.setItem(PANE_WIDTH_KEY, String(width));
		} catch {
			/* ignore */
		}
	}

	function setPaneWidth(width: number): void {
		listPaneWidth = clampPaneWidth(width);
		persistPaneWidth(listPaneWidth);
	}

	function pointerPaneWidth(event: PointerEvent): number {
		return event.clientX - (splitShell?.getBoundingClientRect().left ?? 0);
	}

	function startPaneResize(event: PointerEvent): void {
		if (!ui.isWide || event.button !== 0) return;
		isResizing = true;
		event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		setPaneWidth(pointerPaneWidth(event));
	}

	function resizePane(event: PointerEvent): void {
		if (!isResizing) return;
		setPaneWidth(pointerPaneWidth(event));
	}

	function stopPaneResize(event: PointerEvent): void {
		if (!isResizing) return;
		isResizing = false;
		event.currentTarget instanceof HTMLElement && event.currentTarget.releasePointerCapture(event.pointerId);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}

	function resizePaneWithKeyboard(event: KeyboardEvent): void {
		if (!ui.isWide) return;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			setPaneWidth(listPaneWidth - (event.shiftKey ? 40 : 16));
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			setPaneWidth(listPaneWidth + (event.shiftKey ? 40 : 16));
		}
	}

	function resetPaneWidth(): void {
		setPaneWidth(DEFAULT_PANE_WIDTH);
	}
</script>

<div bind:this={splitShell} class="flex h-full min-h-0 w-full">
	{#if showList}
		<aside
			class={cn(
				'flex h-full min-h-0 flex-col border-r border-border bg-surface',
				ui.isWide ? 'shrink-0' : 'w-full'
			)}
			style={paneWidthStyle}
		>
			<ConversationListPane />
		</aside>
	{/if}
	{#if ui.isWide && showList && showDetail}
		<!-- svelte-ignore a11y_no_static_element_interactions: splitter follows separator semantics and supports keyboard resizing -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex: separator needs focus for keyboard resizing -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions: separator is an interactive splitter control -->
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize conversation list"
			aria-valuemin={MIN_PANE_WIDTH}
			aria-valuemax={MAX_PANE_WIDTH}
			aria-valuenow={clampedPaneWidth}
			tabindex="0"
			onpointerdown={startPaneResize}
			onpointermove={resizePane}
			onpointerup={stopPaneResize}
			onpointercancel={stopPaneResize}
			onkeydown={resizePaneWithKeyboard}
			ondblclick={resetPaneWidth}
			class={cn(
				'group relative -ml-[3px] w-1.5 shrink-0 cursor-col-resize touch-none outline-none',
				isResizing && 'bg-primary/10'
			)}
		>
			<span class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition group-hover:bg-primary group-focus-visible:bg-primary"></span>
		</div>
	{/if}
	{#if showDetail}
		<section class="relative flex min-w-0 flex-1 flex-col bg-background">
			{@render children()}
		</section>
	{/if}
</div>
