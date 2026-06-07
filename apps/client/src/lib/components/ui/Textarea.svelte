<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils/cn';

	interface Props extends Omit<HTMLTextareaAttributes, 'class' | 'value'> {
		value?: string;
		class?: string;
		maxRows?: number;
		autosize?: boolean;
		el?: HTMLTextAreaElement;
	}

	let {
		value = $bindable(''),
		class: className,
		maxRows = 8,
		autosize = true,
		el = $bindable(),
		...rest
	}: Props = $props();

	function resize(): void {
		if (!autosize || !el) return;
		el.style.height = 'auto';
		const cs = getComputedStyle(el);
		const lineHeight = parseFloat(cs.lineHeight) || 20;
		const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
		const max = lineHeight * maxRows + pad;
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
	}

	// Re-measure on value change (covers programmatic clears/sets).
	$effect(() => {
		value;
		resize();
	});
</script>

<textarea
	bind:this={el}
	bind:value
	oninput={resize}
	rows="1"
	class={cn(
		'w-full resize-none rounded-xl border border-border bg-surface px-3.5 py-2.5 text-[15px] text-foreground outline-none transition placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/15',
		className
	)}
	{...rest}
></textarea>
