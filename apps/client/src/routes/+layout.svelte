<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores';
	import Toaster from '$lib/components/ui/Toaster.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { bindVisualViewportVars } from '$lib/visual-viewport';

	let { children } = $props();

	const AUTH_ROUTES = ['/login', '/activate', '/reset'];
	function isRootRoute(path: string): boolean {
		const normalized = path.replace(/\/+$/, '') || '/';
		return normalized === '/' || normalized.endsWith('/index.html');
	}

	onMount(() => {
		void auth.init();
		return bindVisualViewportVars();
	});

	$effect(() => {
		if (auth.status === 'loading') return;
		const path = page.url.pathname;
		const onAuthRoute = AUTH_ROUTES.includes(path);
		const onRootRoute = isRootRoute(path);
		if (auth.status === 'anon' && !onAuthRoute) {
			void goto('/login', { replaceState: true });
		} else if (auth.status === 'authed' && (onAuthRoute || onRootRoute)) {
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
