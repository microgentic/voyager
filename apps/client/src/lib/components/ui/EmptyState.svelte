<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	let {
		icon,
		title,
		description,
		class: className,
		children
	}: {
		icon?: Snippet;
		title: string;
		description?: string;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center',
		className
	)}
>
	{#if icon}
		<div
			class="grid h-16 w-16 place-items-center rounded-2xl bg-surface-2 text-faint ring-1 ring-border"
		>
			{@render icon()}
		</div>
	{/if}
	<div class="space-y-1">
		<h3 class="text-base font-semibold text-foreground">{title}</h3>
		{#if description}
			<p class="mx-auto max-w-xs text-pretty text-sm text-muted">{description}</p>
		{/if}
	</div>
	{@render children?.()}
</div>
