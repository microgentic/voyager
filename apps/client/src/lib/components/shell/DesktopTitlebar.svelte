<script lang="ts">
	import { onMount } from 'svelte';
	import { platformKind } from '$lib/platform';

	let show = $state(false);

	onMount(() => {
		show = platformKind() === 'desktop';
	});
</script>

{#if show}
	<header
		data-tauri-drag-region
		class="flex h-10 shrink-0 items-center border-b border-border bg-surface/95 text-xs font-medium text-muted"
	>
		<div data-tauri-drag-region class="flex min-w-0 items-center gap-2 pl-[86px]">
			<img data-tauri-drag-region src="/favicon.svg" alt="" class="h-4 w-4 rounded-[4px]" />
			<span data-tauri-drag-region class="select-none">Voyager</span>
		</div>
	</header>
{/if}
