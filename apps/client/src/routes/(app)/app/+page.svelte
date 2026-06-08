<script lang="ts">
	import { MessagesSquare, SquarePen, ShieldCheck } from '@lucide/svelte';
	import { compose } from '$lib/stores/compose.svelte';
	import Button from '$lib/components/ui/Button.svelte';
</script>

<svelte:head><title>Voyager</title></svelte:head>

<div class="flex h-full flex-col items-center justify-center gap-5 p-10 text-center">
	<div class="grid h-20 w-20 place-items-center rounded-3xl bg-surface-2 text-primary ring-1 ring-border">
		<MessagesSquare class="h-9 w-9" />
	</div>
	<div class="space-y-1.5">
		<h2 class="text-xl font-semibold text-foreground">Your conversations</h2>
		<p class="mx-auto max-w-sm text-sm text-muted">
			Pick a conversation on the left, or start a new direct message, agent chat, or group.
		</p>
	</div>
	<Button size="lg" onclick={() => compose.open()}>
		<SquarePen class="h-4 w-4" /> New conversation
	</Button>
	<p class="mt-2 inline-flex items-center gap-1.5 text-xs text-faint">
		<ShieldCheck class="h-3.5 w-3.5" /> Private, invitation-only messaging
	</p>
</div>
