<script lang="ts">
	import { onMount } from 'svelte';
	import DesktopTitlebar from '$lib/components/shell/DesktopTitlebar.svelte';

	let { children } = $props();

	onMount(() => {
		const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
		let timers: number[] = [];

		function settleFocusedField(event: FocusEvent): void {
			if (!isCoarsePointer) return;
			const target = event.target;
			if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;

			for (const delay of [80, 200, 360, 560]) {
				timers.push(
					window.setTimeout(() => {
						if (target.isConnected) target.scrollIntoView({ block: 'center', inline: 'nearest' });
					}, delay)
				);
			}
		}

		document.addEventListener('focusin', settleFocusedField);
		return () => {
			document.removeEventListener('focusin', settleFocusedField);
			for (const timer of timers) window.clearTimeout(timer);
			timers = [];
		};
	});
</script>

<div class="flex h-[var(--vv-height)] min-h-0 flex-col overflow-hidden bg-background">
	<DesktopTitlebar />
	<div
		class="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 py-6 pt-[calc(var(--sat)+1.5rem)] pb-[calc(var(--sab)+1.5rem)] sm:py-10 sm:pt-[calc(var(--sat)+2.5rem)] sm:pb-[calc(var(--sab)+2.5rem)]"
	>
		<!-- Aurora backdrop -->
		<div class="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
			<div class="absolute -left-24 -top-24 h-[28rem] w-[28rem] rounded-full bg-primary/25 blur-[100px]"></div>
			<div
				class="absolute -bottom-32 -right-20 h-[26rem] w-[26rem] rounded-full bg-agent/20 blur-[100px]"
			></div>
			<div
				class="absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-[90px]"
			></div>
		</div>

		<div class="my-auto w-full max-w-sm">
			<div class="mb-7 flex flex-col items-center text-center">
				<img src="/favicon.svg" alt="Voyager" class="h-14 w-14 rounded-[18px] shadow-lg" />
				<h1 class="mt-3 text-xl font-semibold tracking-tight text-foreground">Voyager</h1>
				<p class="text-sm text-muted">Secure client · agent messaging</p>
			</div>
			<div
				class="rounded-2xl border border-border bg-surface/85 p-6 shadow-lg backdrop-blur-xl"
			>
				{@render children()}
			</div>
			<p class="mt-5 text-center text-xs text-faint">Private · invitation only</p>
		</div>
	</div>
</div>
