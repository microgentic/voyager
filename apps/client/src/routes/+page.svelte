<script lang="ts">
	// The root layout guard redirects to /app or /login based on auth status;
	// this is just the brief splash shown before that resolves.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores';
	import Spinner from '$lib/components/ui/Spinner.svelte';

	onMount(() => {
		if (auth.status === 'authed') {
			void goto('/app', { replaceState: true });
		} else if (auth.status === 'anon') {
			void goto('/login', { replaceState: true });
		}
	});
</script>

<div class="grid min-h-dvh place-items-center bg-background">
	<Spinner class="text-primary" size="lg" />
</div>
