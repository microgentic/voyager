<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	let {
		label,
		hint,
		error,
		for: htmlFor,
		required = false,
		class: className,
		children
	}: {
		label?: string;
		hint?: string;
		error?: string | null;
		for?: string;
		required?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
	{#if label}
		<label for={htmlFor} class="text-sm font-medium text-foreground">
			{label}{#if required}<span class="text-danger"> *</span>{/if}
		</label>
	{/if}
	{@render children?.()}
	{#if error}
		<p class="text-xs text-danger">{error}</p>
	{:else if hint}
		<p class="text-xs text-faint">{hint}</p>
	{/if}
</div>
