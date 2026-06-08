<script lang="ts">
	import { page } from '$app/state';
	import { ui } from '$lib/stores';
	import { cn } from '$lib/utils/cn';
	import ConversationListPane from '$lib/components/nav/ConversationListPane.svelte';

	let { children } = $props();

	const roomId = $derived(page.params.roomId ?? null);
	const showList = $derived(ui.isWide || !roomId);
	const showDetail = $derived(ui.isWide || !!roomId);
</script>

<div class="flex h-full min-h-0 w-full">
	{#if showList}
		<aside
			class={cn(
				'flex h-full min-h-0 flex-col border-r border-border bg-surface',
				ui.isWide ? 'w-[clamp(300px,30vw,380px)] shrink-0' : 'w-full'
			)}
		>
			<ConversationListPane />
		</aside>
	{/if}
	{#if showDetail}
		<section class="relative flex min-w-0 flex-1 flex-col bg-background">
			{@render children()}
		</section>
	{/if}
</div>
