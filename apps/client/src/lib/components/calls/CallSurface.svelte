<script lang="ts">
	import { Loader2, Mic, MicOff, Phone, PhoneCall, PhoneOff } from '@lucide/svelte';
	import type { Call } from '$lib/api/types';
	import { calls, rooms } from '$lib/stores';
	import { cn } from '$lib/utils/cn';

	function attachStream(node: HTMLAudioElement, stream: MediaStream) {
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
		return room ? rooms.displayName(room) : 'Audio call';
	}

	const activeTitle = $derived(calls.activeCall ? callRoomName(calls.activeCall) : 'Audio call');
	const activeDetail = $derived(
		calls.activeCall
			? `${calls.connectedParticipants.length || 1} connected${
					calls.ringingParticipants.length ? `, ${calls.ringingParticipants.length} ringing` : ''
				}`
			: ''
	);
	const isBusy = $derived(!!calls.busyCallId || calls.mediaState === 'connecting' || calls.mediaState === 'ending');
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
					<p class="truncate text-sm font-semibold text-foreground">Incoming audio call</p>
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
						Audio unavailable
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
						calls.muted
							? 'bg-warning/15 text-warning hover:bg-warning/20'
							: 'bg-surface-2 text-foreground hover:bg-surface-3'
					)}
				>
					{#if calls.muted}
						<MicOff class="h-4.5 w-4.5" />
					{:else}
						<Mic class="h-4.5 w-4.5" />
					{/if}
				</button>
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
