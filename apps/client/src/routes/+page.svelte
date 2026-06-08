<script lang="ts">
	// The root layout guard redirects to /app or /login based on auth status;
	// this is just the brief splash shown before that resolves.
	import Spinner from '$lib/components/ui/Spinner.svelte';
</script>

<div class="grid min-h-dvh place-items-center bg-background">
	<Spinner class="text-primary" size="lg" />
</div>
