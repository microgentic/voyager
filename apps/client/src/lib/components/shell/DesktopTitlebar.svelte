<script lang="ts">
	import { onMount } from 'svelte';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { platformKind } from '$lib/platform';

	let show = $state(false);

	onMount(() => {
		show = platformKind() === 'desktop';
	});

	function startWindowDrag(event: MouseEvent): void {
		if (!show || event.button !== 0 || event.buttons !== 1) return;

		void getCurrentWindow().startDragging().catch((error) => {
			console.warn('Tauri window drag failed', error);
		});
	}
</script>

{#if show}
	<!-- svelte-ignore a11y_no_static_element_interactions: native desktop window drag surface -->
	<header
		data-tauri-drag-region
		onmousedown={startWindowDrag}
		class="flex h-10 shrink-0 cursor-default select-none items-center border-b border-border bg-surface/95 text-xs font-medium text-muted"
	>
		<div data-tauri-drag-region class="flex min-w-0 items-center gap-2 pl-[86px]">
			<img
				data-tauri-drag-region
				draggable="false"
				src="/favicon.svg"
				alt=""
				class="h-4 w-4 rounded-[4px]"
			/>
			<span data-tauri-drag-region class="select-none">Voyager</span>
		</div>
	</header>
{/if}
