<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	let {
		onSelect,
		danger = false,
		disabled = false,
		icon,
		children,
		class: className
	}: {
		onSelect?: () => void;
		danger?: boolean;
		disabled?: boolean;
		icon?: Snippet;
		children?: Snippet;
		class?: string;
	} = $props();
</script>

<DropdownMenu.Item
	{disabled}
	onSelect={() => onSelect?.()}
	class={cn(
		'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition data-disabled:pointer-events-none data-disabled:opacity-50',
		danger
			? 'text-danger data-highlighted:bg-danger-soft'
			: 'text-foreground data-highlighted:bg-surface-2',
		className
	)}
>
	{#if icon}
		<span class="grid h-4 w-4 shrink-0 place-items-center opacity-80">{@render icon()}</span>
	{/if}
	<span class="flex-1 truncate">{@render children?.()}</span>
</DropdownMenu.Item>
