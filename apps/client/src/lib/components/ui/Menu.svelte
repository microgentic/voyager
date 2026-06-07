<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	let {
		trigger,
		children,
		align = 'end',
		side = 'bottom',
		class: triggerClass,
		contentClass,
		label = 'Menu'
	}: {
		trigger?: Snippet;
		children?: Snippet;
		align?: 'start' | 'center' | 'end';
		side?: 'top' | 'bottom' | 'left' | 'right';
		class?: string;
		contentClass?: string;
		label?: string;
	} = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class={triggerClass} aria-label={label}>
		{@render trigger?.()}
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content
			{side}
			{align}
			sideOffset={6}
			class={cn(
				'z-50 min-w-[208px] origin-(--bits-dropdown-menu-content-transform-origin) overflow-hidden rounded-xl border border-border bg-elevated p-1.5 shadow-pop animate-menu-in',
				contentClass
			)}
		>
			{@render children?.()}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
