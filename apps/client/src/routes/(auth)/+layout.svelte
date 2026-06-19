<script lang="ts">
	import DesktopTitlebar from '$lib/components/shell/DesktopTitlebar.svelte';

	let { children } = $props();
</script>

<div class="flex min-h-dvh flex-col bg-background">
	<DesktopTitlebar />
	<div
		class="relative grid min-h-0 flex-1 place-items-center overflow-hidden px-5 py-10 pt-[calc(var(--sat)+2.5rem)] pb-[calc(var(--sab)+2.5rem)]"
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

		<div class="w-full max-w-sm">
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
