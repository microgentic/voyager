<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	type Size = 'sm' | 'md' | 'lg';

	let {
		open = $bindable(false),
		title = '',
		description = '',
		size = 'md',
		hideClose = false,
		class: className,
		children,
		footer,
		onClose
	}: {
		open?: boolean;
		title?: string;
		description?: string;
		size?: Size;
		hideClose?: boolean;
		class?: string;
		children?: Snippet;
		footer?: Snippet;
		onClose?: () => void;
	} = $props();

	const sizes: Record<Size, string> = {
		sm: 'sm:max-w-sm',
		md: 'sm:max-w-md',
		lg: 'sm:max-w-lg'
	};
</script>

<Dialog.Root
	bind:open
	onOpenChange={(v) => {
		if (!v) onClose?.();
	}}
>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] animate-overlay-in" />
		<Dialog.Content
			class={cn(
				'fixed z-50 flex max-h-[92dvh] flex-col overflow-hidden border border-border bg-elevated shadow-lg outline-none',
				'inset-x-0 bottom-0 rounded-t-2xl pb-safe animate-sheet-in',
				'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:rounded-2xl sm:pb-0 sm:animate-dialog-in',
				sizes[size],
				className
			)}
		>
			<div class="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-border-strong sm:hidden"></div>
			<div class="flex items-start justify-between gap-3 px-5 pb-1 pt-3 sm:pt-5">
				<div class="min-w-0 flex-1">
					<Dialog.Title class={cn('text-base font-semibold text-foreground', !title && 'sr-only')}>
						{title || 'Dialog'}
					</Dialog.Title>
					{#if description}
						<Dialog.Description class="mt-0.5 text-sm text-muted">{description}</Dialog.Description>
					{/if}
				</div>
				{#if !hideClose}
					<Dialog.Close
						class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-foreground"
						aria-label="Close"
					>
						<X class="h-5 w-5" />
					</Dialog.Close>
				{/if}
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
				{@render children?.()}
			</div>
			{#if footer}
				<div class="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
					{@render footer()}
				</div>
			{/if}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
