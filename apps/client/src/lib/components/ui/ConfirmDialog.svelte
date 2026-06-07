<script lang="ts">
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';

	let {
		open = $bindable(false),
		title,
		message,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		danger = false,
		loading = false,
		onConfirm
	}: {
		open?: boolean;
		title: string;
		message?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		loading?: boolean;
		onConfirm: () => void | Promise<void>;
	} = $props();
</script>

<Modal bind:open {title} size="sm">
	{#if message}
		<p class="text-sm leading-relaxed text-muted">{message}</p>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)} disabled={loading}>{cancelLabel}</Button>
		<Button variant={danger ? 'danger' : 'primary'} {loading} onclick={() => onConfirm()}>
			{confirmLabel}
		</Button>
	{/snippet}
</Modal>
