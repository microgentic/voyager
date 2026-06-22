<script lang="ts">
	import { Camera, CameraOff, Loader2, Mic, Phone, RefreshCw, Video, Volume2 } from '@lucide/svelte';
	import { calls, rooms } from '$lib/stores';
	import Button from '$lib/components/ui/Button.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';

	let modalOpen = $state(false);

	$effect(() => {
		modalOpen = !!calls.prejoin;
	});

	const callKind = $derived(calls.prejoin?.callType === 'video' ? 'video' : 'audio');
	const title = $derived(
		calls.prejoin?.mode === 'accept' ? `Join ${callKind} call` : `Start ${callKind} call`
	);
	const roomName = $derived.by(() => {
		const prejoin = calls.prejoin;
		if (!prejoin) return '';
		if (prejoin.room) return rooms.displayName(prejoin.room);
		if (prejoin.call) {
			const room = rooms.get(prejoin.call.roomId);
			return room ? rooms.displayName(room) : 'Call';
		}
		return 'Call';
	});
	const confirmLabel = $derived(calls.prejoin?.mode === 'accept' ? 'Join' : 'Start');

	function attachStream(node: HTMLMediaElement, stream: MediaStream) {
		node.srcObject = stream;
		void node.play().catch(() => undefined);
		return {
			update(next: MediaStream) {
				if (node.srcObject === next) return;
				node.srcObject = next;
				void node.play().catch(() => undefined);
			},
			destroy() {
				node.srcObject = null;
			}
		};
	}

	function selectedValue(event: Event): string {
		return (event.currentTarget as HTMLSelectElement).value;
	}

	function handleClose() {
		if (calls.prejoinBusy) {
			modalOpen = true;
			return;
		}
		calls.cancelPrejoin();
	}
</script>

<Modal
	bind:open={modalOpen}
	{title}
	description={roomName}
	size="lg"
	hideClose={calls.prejoinBusy}
	onClose={handleClose}
>
	<div class="space-y-4">
		{#if calls.prejoin?.callType === 'video'}
			<div class="overflow-hidden rounded-lg border border-border bg-surface-2">
				<div class="relative aspect-video bg-black">
					{#if calls.prejoinPreviewStream}
						<video
							autoplay
							playsinline
							muted
							class="h-full w-full object-cover"
							use:attachStream={calls.prejoinPreviewStream}
						></video>
					{:else}
						<div class="grid h-full place-items-center text-muted">
							<CameraOff class="h-8 w-8" />
						</div>
					{/if}
					<div class="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
						<span class="truncate rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">You</span>
						<label
							class="inline-flex shrink-0 items-center gap-2 rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white"
						>
							<input
								type="checkbox"
								checked={calls.prejoinCameraEnabled}
								disabled={calls.prejoinBusy}
								onchange={(event) => calls.setPrejoinCameraEnabled((event.currentTarget as HTMLInputElement).checked)}
								class="h-3.5 w-3.5 rounded border-white/60 bg-transparent accent-primary"
							/>
							Camera
						</label>
					</div>
				</div>
			</div>
		{/if}

		<div class="grid gap-3 sm:grid-cols-2">
			<Field label="Microphone" for="call-prejoin-microphone">
				<div class="relative">
					<Mic class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
					<select
						id="call-prejoin-microphone"
						value={calls.prejoinAudioInputId}
						disabled={calls.prejoinBusy}
						onfocus={() => calls.refreshCallDevices({ quiet: true })}
						onchange={(event) => calls.setPrejoinAudioInput(selectedValue(event))}
						class="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-8 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
					>
						<option value="">Default microphone</option>
						{#each calls.microphones as device (device.deviceId)}
							<option value={device.deviceId}>{device.label}</option>
						{/each}
					</select>
				</div>
			</Field>

			{#if calls.prejoin?.callType === 'video'}
				<Field label="Camera" for="call-prejoin-camera">
					<div class="relative">
						<Video class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
						<select
							id="call-prejoin-camera"
							value={calls.prejoinVideoInputId}
							disabled={calls.prejoinBusy}
							onfocus={() => calls.refreshCallDevices({ quiet: true })}
							onchange={(event) => calls.setPrejoinVideoInput(selectedValue(event))}
							class="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-8 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
						>
							<option value="">Default camera</option>
							{#each calls.cameras as device (device.deviceId)}
								<option value={device.deviceId}>{device.label}</option>
							{/each}
						</select>
					</div>
				</Field>
			{/if}

			{#if calls.audioOutputSupported}
				<Field label="Speaker" for="call-prejoin-speaker" class={calls.prejoin?.callType === 'video' ? 'sm:col-span-2' : ''}>
					<div class="relative">
						<Volume2 class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
						<select
							id="call-prejoin-speaker"
							value={calls.prejoinAudioOutputId}
							disabled={calls.prejoinBusy}
							onfocus={() => calls.refreshCallDevices({ quiet: true })}
							onchange={(event) => calls.setPrejoinAudioOutput(selectedValue(event))}
							class="h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-8 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
						>
							<option value="">Default speaker</option>
							{#each calls.speakers as device (device.deviceId)}
								<option value={device.deviceId}>{device.label}</option>
							{/each}
						</select>
					</div>
				</Field>
			{/if}
		</div>

		<div class="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
			<div class="flex min-w-0 items-center gap-2 text-sm text-muted">
				{#if calls.prejoin?.callType === 'video'}
					<Camera class="h-4 w-4 shrink-0" />
				{:else}
					<Phone class="h-4 w-4 shrink-0" />
				{/if}
				<span class="truncate">
					{calls.prejoin?.callType === 'video' && !calls.prejoinCameraEnabled
						? 'Camera off until enabled'
						: 'Ready to request microphone access'}
				</span>
			</div>
			<button
				type="button"
				onclick={() => calls.refreshCallDevices()}
				disabled={calls.deviceLoading || calls.prejoinBusy}
				title="Refresh devices"
				aria-label="Refresh devices"
				class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
			>
				{#if calls.deviceLoading}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<RefreshCw class="h-4 w-4" />
				{/if}
			</button>
		</div>

		{#if calls.prejoinError || calls.deviceError}
			<p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
				{calls.prejoinError ?? calls.deviceError}
			</p>
		{/if}
	</div>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => calls.cancelPrejoin()} disabled={calls.prejoinBusy}>Cancel</Button>
		<Button onclick={() => calls.confirmPrejoin()} loading={calls.prejoinBusy}>{confirmLabel}</Button>
	{/snippet}
</Modal>
