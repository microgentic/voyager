<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores';
	import Toaster from '$lib/components/ui/Toaster.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';

	let { children } = $props();

	const AUTH_ROUTES = ['/login', '/activate', '/reset'];

	onMount(() => {
		void auth.init();
	});

	$effect(() => {
		if (auth.status === 'loading') return;
		const path = page.url.pathname;
		const onAuthRoute = AUTH_ROUTES.includes(path);
		if (auth.status === 'anon' && !onAuthRoute) {
			void goto('/login', { replaceState: true });
		} else if (auth.status === 'authed' && (onAuthRoute || path === '/')) {
			void goto('/app', { replaceState: true });
		}
	});
</script>

<Toaster />

{#if auth.status === 'loading'}
	<div class="grid min-h-dvh place-items-center bg-background">
		<div class="flex flex-col items-center gap-4">
			<img src="/favicon.svg" alt="" class="h-12 w-12 animate-pulse" />
			<Spinner class="text-primary" />
		</div>
	</div>
{:else}
	{@render children()}
{/if}
