<script lang="ts" generics="T extends string">
	import { cn } from '$lib/utils/cn';

	let {
		value = $bindable(),
		options,
		size = 'md',
		class: className
	}: {
		value: T;
		options: Array<{ value: T; label: string }>;
		size?: 'sm' | 'md';
		class?: string;
	} = $props();
</script>

<div
	class={cn('inline-flex items-center gap-1 rounded-xl bg-surface-2 p-1', className)}
	role="tablist"
>
	{#each options as opt (opt.value)}
		<button
			type="button"
			role="tab"
			aria-selected={value === opt.value}
			onclick={() => (value = opt.value)}
			class={cn(
				'rounded-lg font-medium transition',
				size === 'sm' ? 'px-2.5 py-1 text-[13px]' : 'px-3 py-1.5 text-sm',
				value === opt.value
					? 'bg-surface text-foreground shadow-sm'
					: 'text-muted hover:text-foreground'
			)}
		>
			{opt.label}
		</button>
	{/each}
</div>
