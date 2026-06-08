<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	type Tone = 'neutral' | 'primary' | 'agent' | 'success' | 'warning' | 'danger';

	let {
		tone = 'neutral',
		class: className,
		children
	}: { tone?: Tone; class?: string; children?: Snippet } = $props();

	const tones: Record<Tone, string> = {
		neutral: 'bg-surface-3 text-muted',
		primary: 'bg-primary-soft text-primary',
		agent: 'bg-agent-soft text-agent',
		success: 'bg-success/15 text-success',
		warning: 'bg-warning/15 text-warning',
		danger: 'bg-danger-soft text-danger'
	};
</script>

<span
	class={cn(
		'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none',
		tones[tone],
		className
	)}
>
	{@render children?.()}
</span>
