<script lang="ts">
	import { Bot } from '@lucide/svelte';
	import { avatarGradient, initials } from '$lib/utils/avatar';
	import { cn } from '$lib/utils/cn';

	type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

	let {
		name,
		seed,
		isAgent = false,
		size = 'md',
		badge = true,
		class: className
	}: {
		name?: string | null;
		seed?: string;
		isAgent?: boolean;
		size?: Size;
		badge?: boolean;
		class?: string;
	} = $props();

	const sizes: Record<Size, string> = {
		xs: 'h-7 w-7 text-[10px]',
		sm: 'h-9 w-9 text-xs',
		md: 'h-11 w-11 text-sm',
		lg: 'h-14 w-14 text-lg',
		xl: 'h-20 w-20 text-2xl'
	};
	const badgeSizes: Record<Size, string> = {
		xs: 'h-3 w-3 -bottom-px -right-px',
		sm: 'h-3.5 w-3.5 -bottom-0.5 -right-0.5',
		md: 'h-4 w-4 -bottom-0.5 -right-0.5',
		lg: 'h-5 w-5 bottom-0 right-0',
		xl: 'h-7 w-7 bottom-0.5 right-0.5'
	};

	const resolvedSeed = $derived(seed ?? name ?? '?');
</script>

<span
	class={cn(
		'relative inline-grid shrink-0 place-items-center rounded-full font-semibold text-white',
		sizes[size],
		className
	)}
	style="background-image:{avatarGradient(resolvedSeed, isAgent)}"
	aria-hidden="true"
>
	<span class="drop-shadow-sm">{initials(name)}</span>
	{#if isAgent && badge}
		<span
			class={cn(
				'absolute grid place-items-center rounded-full bg-agent text-agent-foreground ring-2 ring-surface',
				badgeSizes[size]
			)}
		>
			<Bot class="h-[60%] w-[60%]" strokeWidth={2.5} />
		</span>
	{/if}
</span>
