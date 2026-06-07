<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		content,
		side = 'top',
		children
	}: {
		content: string;
		side?: 'top' | 'bottom' | 'left' | 'right';
		children?: Snippet;
	} = $props();
</script>

<Tooltip.Provider delayDuration={250}>
	<Tooltip.Root>
		<Tooltip.Trigger>{@render children?.()}</Tooltip.Trigger>
		<Tooltip.Portal>
			<Tooltip.Content
				{side}
				sideOffset={6}
				class="z-50 max-w-xs rounded-lg bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md animate-fade-in"
			>
				{content}
			</Tooltip.Content>
		</Tooltip.Portal>
	</Tooltip.Root>
</Tooltip.Provider>
