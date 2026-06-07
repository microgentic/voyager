<script lang="ts">
	import { CheckCircle2, AlertTriangle, Info, X } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { toasts, type ToastTone } from '$lib/stores/toast.svelte';

	const icons = { success: CheckCircle2, error: AlertTriangle, info: Info };
	const tones: Record<ToastTone, string> = {
		success: 'text-success',
		error: 'text-danger',
		info: 'text-primary'
	};
</script>

<div
	class="pointer-events-none fixed inset-x-0 top-0 z-100 flex flex-col items-center gap-2 px-4 pt-[calc(var(--sat)+0.75rem)]"
>
	{#each toasts.toasts as toast (toast.id)}
		{@const Icon = icons[toast.tone]}
		<div
			animate:flip={{ duration: 200 }}
			in:fly={{ y: -20, duration: 220 }}
			out:fly={{ y: -12, duration: 160 }}
			class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-elevated p-3 shadow-pop"
			role="status"
		>
			<Icon class="mt-0.5 h-5 w-5 shrink-0 {tones[toast.tone]}" />
			<div class="min-w-0 flex-1">
				{#if toast.title}
					<p class="text-sm font-semibold text-foreground">{toast.title}</p>
				{/if}
				<p class="text-sm text-muted">{toast.message}</p>
			</div>
			<button
				onclick={() => toasts.dismiss(toast.id)}
				class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-surface-2 hover:text-foreground"
				aria-label="Dismiss"
			>
				<X class="h-4 w-4" />
			</button>
		</div>
	{/each}
</div>
