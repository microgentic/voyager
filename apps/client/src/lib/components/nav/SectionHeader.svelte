<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		subtitle,
		actions
	}: { title: string; subtitle?: string; actions?: Snippet } = $props();
</script>

<header class="shrink-0 border-b border-border bg-surface/80 pt-[var(--sat)] backdrop-blur-xl">
	<div class="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
		<div class="min-w-0">
			<h1 class="text-lg font-bold tracking-tight text-foreground">{title}</h1>
			{#if subtitle}<p class="truncate text-xs text-muted">{subtitle}</p>{/if}
		</div>
		{#if actions}<div class="ml-auto flex items-center gap-2">{@render actions()}</div>{/if}
	</div>
</header>
