<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { auth, ui, rooms, messages, threads, principals, invitations, collections, sync, realtime, calls } from '$lib/stores';
	import DesktopTitlebar from '$lib/components/shell/DesktopTitlebar.svelte';
	import NavRail from '$lib/components/nav/NavRail.svelte';
	import TabBar from '$lib/components/nav/TabBar.svelte';
	import NewConversation from '$lib/components/rooms/NewConversation.svelte';

	let { children } = $props();

	onMount(() => {
		const bootstrap = auth.consumeBootstrap();
		if (bootstrap) {
			rooms.hydrate(bootstrap.rooms);
			void messages.ingest(bootstrap.pendingMessages);
		}
		sync.start({ immediate: !bootstrap });
		realtime.start();
		void recoverCalls(!!bootstrap);
		deferNonCriticalLoads();
		return () => {
			realtime.stop();
			sync.stop();
		};
	});

	async function recoverCalls(hasBootstrap: boolean): Promise<void> {
		if (!hasBootstrap) await rooms.load();
		await calls.recoverLiveCalls();
	}

	function deferNonCriticalLoads(): void {
		const load = () => {
			void principals.load();
			void threads.load();
			void invitations.load();
			void collections.load();
		};
		if (typeof requestIdleCallback === 'function') {
			requestIdleCallback(load, { timeout: 1000 });
		} else {
			setTimeout(load, 0);
		}
	}

	// On mobile, a conversation thread takes the full screen (no tab bar).
	const inThread = $derived(!!page.params.roomId);
	const showTabBar = $derived(!ui.isWide && !inThread);
</script>

<div class="app-viewport-shell flex flex-col overflow-hidden bg-background text-foreground">
	<DesktopTitlebar />
	<div class="flex min-h-0 flex-1 overflow-hidden">
		{#if ui.isWide}
			<NavRail />
		{/if}
		<div class="flex min-w-0 flex-1 flex-col">
			<main class="relative min-h-0 flex-1 overflow-hidden">
				{@render children()}
			</main>
			{#if showTabBar}
				<TabBar />
			{/if}
		</div>
	</div>
</div>

<NewConversation />
