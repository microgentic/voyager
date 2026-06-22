<script lang="ts">
	import {
		Camera,
		CameraOff,
		Loader2,
		Mic,
		MicOff,
		Phone,
		PhoneCall,
		PhoneOff,
		SwitchCamera,
		Video
	} from '@lucide/svelte';
	import type { Call } from '$lib/api/types';
	import { calls, rooms } from '$lib/stores';
	import { cn } from '$lib/utils/cn';

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

	function callRoomName(call: Call): string {
		const room = rooms.get(call.roomId);
		return room ? rooms.displayName(room) : 'Call';
	}

	function callKind(call: Call): string {
		return call.callType === 'video' ? 'video' : 'audio';
	}

	const activeTitle = $derived(calls.activeCall ? callRoomName(calls.activeCall) : 'Call');
	const activeDetail = $derived(
		calls.activeCall
			? `${calls.connectedParticipants.length || 1} connected${
					calls.ringingParticipants.length ? `, ${calls.ringingParticipants.length} ringing` : ''
				}`
			: ''
	);
	const isBusy = $derived(!!calls.busyCallId || calls.mediaState === 'connecting' || calls.mediaState === 'ending');
	const isVideoCall = $derived(calls.activeCall?.callType === 'video');
	const videoPlaceholders = $derived(
		Array.from(
			{ length: Math.max(0, calls.connectedParticipants.length - calls.remoteVideoStreams.length - 1) },
			(_, index) => index
		)
	);
</script>

{#each calls.remoteStreams as remote (remote.id)}
	<audio autoplay playsinline class="sr-only" use:attachStream={remote.stream}></audio>
{/each}

{#if calls.incoming.length}
	<div class="pointer-events-none fixed inset-x-0 top-[calc(var(--sat)+0.75rem)] z-50 flex flex-col items-center gap-2 px-3">
		{#each calls.incoming as call (call.callId)}
			<div
				class="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 shadow-xl"
			>
				<div class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
					<PhoneCall class="h-4.5 w-4.5" />
				</div>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold text-foreground">Incoming {callKind(call)} call</p>
					<p class="truncate text-xs text-muted">{callRoomName(call)}</p>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<button
						type="button"
						onclick={() => calls.acceptCall(call)}
						disabled={calls.busyCallId === call.callId}
						title="Accept call"
						aria-label="Accept call"
						class="grid h-10 w-10 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{#if calls.busyCallId === call.callId}
							<Loader2 class="h-4.5 w-4.5 animate-spin" />
						{:else}
							<Phone class="h-4.5 w-4.5" />
						{/if}
					</button>
					<button
						type="button"
						onclick={() => calls.declineCall(call.callId)}
						disabled={calls.busyCallId === call.callId}
						title="Decline call"
						aria-label="Decline call"
						class="grid h-10 w-10 place-items-center rounded-lg bg-danger text-white transition hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<PhoneOff class="h-4.5 w-4.5" />
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

{#if calls.activeCall}
	{#if isVideoCall}
		<div class="pointer-events-none fixed inset-x-0 bottom-[calc(var(--sab)+5.75rem)] z-40 px-3">
			<div
				class="pointer-events-auto mx-auto grid w-full max-w-5xl gap-2 rounded-lg border border-border bg-surface p-2 shadow-xl sm:grid-cols-[1fr_13rem]"
			>
				<div class="grid min-h-48 grid-cols-1 gap-2 sm:grid-cols-2">
					{#each calls.remoteVideoStreams as remote (remote.id)}
						<div class="relative aspect-video overflow-hidden rounded-lg bg-surface-2">
							<video autoplay playsinline class="h-full w-full bg-black object-cover" use:attachStream={remote.stream}></video>
							<div class="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
								<span class="truncate rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">
									{remote.displayName ?? (remote.kind === 'screen' ? 'Screen share' : 'Participant')}
								</span>
							</div>
						</div>
					{/each}
					{#each videoPlaceholders as placeholder (placeholder)}
						<div class="grid aspect-video place-items-center rounded-lg border border-dashed border-border bg-surface-2 text-muted">
							<Video class="h-7 w-7" />
						</div>
					{/each}
					{#if !calls.remoteVideoStreams.length && !videoPlaceholders.length}
						<div class="grid aspect-video place-items-center rounded-lg border border-dashed border-border bg-surface-2 text-muted">
							<Video class="h-7 w-7" />
						</div>
					{/if}
				</div>
				<div class="relative aspect-video overflow-hidden rounded-lg bg-surface-2 sm:aspect-auto sm:min-h-48">
					{#if calls.localVideoStream}
						<video
							autoplay
							playsinline
							muted
							class="h-full w-full bg-black object-cover"
							use:attachStream={calls.localVideoStream}
						></video>
					{:else}
						<div class="grid h-full min-h-28 place-items-center text-muted">
							<CameraOff class="h-6 w-6" />
						</div>
					{/if}
					<div class="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
						<span class="truncate rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">You</span>
						<span class="rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">
							{calls.cameraEnabled ? 'Camera on' : 'Camera off'}
						</span>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<div class="pointer-events-none fixed inset-x-0 bottom-[calc(var(--sab)+0.75rem)] z-50 px-3">
		<div
			class="pointer-events-auto mx-auto flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 shadow-xl"
		>
			<div
				class={cn(
					'grid h-9 w-9 shrink-0 place-items-center rounded-full',
					calls.mediaState === 'active' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
				)}
			>
				{#if calls.mediaState === 'connecting' || calls.mediaState === 'ending'}
					<Loader2 class="h-4.5 w-4.5 animate-spin" />
				{:else if isVideoCall}
					<Video class="h-4.5 w-4.5" />
				{:else}
					<PhoneCall class="h-4.5 w-4.5" />
				{/if}
			</div>
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-semibold text-foreground">{activeTitle}</p>
				<p class="truncate text-xs text-muted">
					{#if calls.mediaState === 'connecting'}
						Connecting
					{:else if calls.mediaState === 'unavailable'}
						Call media unavailable
					{:else if calls.lastError}
						{calls.lastError}
					{:else}
						{activeDetail}
					{/if}
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onclick={() => calls.toggleMute()}
					disabled={isBusy || calls.mediaState !== 'active'}
					title={calls.muted ? 'Unmute microphone' : 'Mute microphone'}
					aria-label={calls.muted ? 'Unmute microphone' : 'Mute microphone'}
					class={cn(
						'grid h-10 w-10 place-items-center rounded-lg border border-border transition disabled:cursor-not-allowed disabled:opacity-50',
						calls.muted ? 'bg-warning/15 text-warning hover:bg-warning/20' : 'bg-surface-2 text-foreground hover:bg-surface-3'
					)}
				>
					{#if calls.muted}
						<MicOff class="h-4.5 w-4.5" />
					{:else}
						<Mic class="h-4.5 w-4.5" />
					{/if}
				</button>
				{#if isVideoCall}
					<button
						type="button"
						onclick={() => calls.toggleCamera()}
						disabled={isBusy || calls.mediaState !== 'active'}
						title={calls.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
						aria-label={calls.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
						class={cn(
							'grid h-10 w-10 place-items-center rounded-lg border border-border transition disabled:cursor-not-allowed disabled:opacity-50',
							calls.cameraEnabled
								? 'bg-surface-2 text-foreground hover:bg-surface-3'
								: 'bg-warning/15 text-warning hover:bg-warning/20'
						)}
					>
						{#if calls.cameraEnabled}
							<Camera class="h-4.5 w-4.5" />
						{:else}
							<CameraOff class="h-4.5 w-4.5" />
						{/if}
					</button>
					<button
						type="button"
						onclick={() => calls.switchCamera()}
						disabled={isBusy || calls.mediaState !== 'active' || calls.switchingCamera}
						title="Switch camera"
						aria-label="Switch camera"
						class="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface-2 text-foreground transition hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{#if calls.switchingCamera}
							<Loader2 class="h-4.5 w-4.5 animate-spin" />
						{:else}
							<SwitchCamera class="h-4.5 w-4.5" />
						{/if}
					</button>
				{/if}
				<button
					type="button"
					onclick={() => calls.endActiveCall()}
					disabled={isBusy}
					title="Leave call"
					aria-label="Leave call"
					class="grid h-10 w-10 place-items-center rounded-lg bg-danger text-white transition hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<PhoneOff class="h-4.5 w-4.5" />
				</button>
			</div>
		</div>
	</div>
{/if}
