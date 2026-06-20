<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils/cn';

	interface Props extends Omit<HTMLInputAttributes, 'class' | 'value'> {
		value?: string;
		class?: string;
		invalid?: boolean;
		el?: HTMLInputElement;
		leading?: Snippet;
		trailing?: Snippet;
	}

	let {
		value = $bindable(''),
		class: className,
		invalid = false,
		el = $bindable(),
		leading,
		trailing,
		...rest
	}: Props = $props();
</script>

<div class={cn('relative flex items-center', className)}>
	{#if leading}
		<span class="pointer-events-none absolute left-3 grid place-items-center text-faint">
			{@render leading()}
		</span>
	{/if}
	<input
		bind:this={el}
		bind:value
		class={cn(
			'h-11 w-full rounded-xl border bg-surface px-3.5 text-[15px] text-foreground outline-none transition placeholder:text-faint focus:ring-4',
			leading && 'pl-10',
			trailing && 'pr-10',
			invalid
				? 'border-danger focus:border-danger focus:ring-danger/15'
				: 'border-border focus:border-primary focus:ring-primary/15'
		)}
		{...rest}
	/>
	{#if trailing}
		<span class="absolute right-2.5 grid place-items-center text-faint">
			{@render trailing()}
		</span>
	{/if}
</div>
