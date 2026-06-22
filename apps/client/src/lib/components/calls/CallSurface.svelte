<script lang="ts">
	import {
		Activity,
		Camera,
		CameraOff,
		Loader2,
		Maximize2,
		Mic,
		MicOff,
		Minimize2,
		Monitor,
		MonitorOff,
		Phone,
		PhoneCall,
		PhoneOff,
		Settings,
		SwitchCamera,
		Video,
		Volume2
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { Call } from '$lib/api/types';
	import CallPrejoinDialog from '$lib/components/calls/CallPrejoinDialog.svelte';
	import { calls, rooms } from '$lib/stores';
	import { cn } from '$lib/utils/cn';

	type VideoTile = {
		id: string;
		label: string;
		detail: string;
		kind: 'video' | 'screen' | 'placeholder';
		stream: MediaStream | null;
		local?: boolean;
	};

	let videoSurfaceElement = $state<HTMLDivElement | null>(null);

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

	function attachRemoteAudio(node: HTMLMediaElement) {
		return calls.attachRemoteAudio(node);
	}

	function selectedValue(event: Event): string {
		return (event.currentTarget as HTMLSelectElement).value;
	}

	async function toggleVideoExpanded() {
		const next = !calls.videoSurfaceExpanded;
		calls.setVideoSurfaceExpanded(next);
		if (typeof document === 'undefined') return;
		try {
			if (next && videoSurfaceElement?.requestFullscreen && !document.fullscreenElement) {
				await videoSurfaceElement.requestFullscreen();
			} else if (!next && document.fullscreenElement === videoSurfaceElement) {
				await document.exitFullscreen();
			}
		} catch {
			/* expanded in-app layout is still available when browser fullscreen is blocked */
		}
	}

	function selectVideoTile(tile: VideoTile) {
		calls.setFeaturedVideo(tile.id);
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
	const videoTiles = $derived.by((): VideoTile[] => {
		const remoteScreens = calls.remoteVideoStreams.filter((remote) => remote.kind === 'screen');
		const remoteCameras = calls.remoteVideoStreams.filter((remote) => remote.kind === 'video');
		const cameraStreamCount = remoteCameras.length + (calls.localVideoStream ? 1 : 0);
		const placeholderCount = Math.max(0, calls.connectedParticipants.length - cameraStreamCount);
		const tiles: VideoTile[] = [];
		if (calls.localScreenStream) {
			tiles.push({
				id: 'local-screen',
				label: 'Your screen',
				detail: 'Screen share',
				kind: 'screen',
				stream: calls.localScreenStream,
				local: true
			});
		}
		for (const remote of remoteScreens) {
			tiles.push({
				id: remote.id,
				label: remote.displayName ?? 'Screen share',
				detail: 'Screen share',
				kind: 'screen',
				stream: remote.stream
			});
		}
		for (const remote of remoteCameras) {
			tiles.push({
				id: remote.id,
				label: remote.displayName ?? 'Participant',
				detail: 'Camera',
				kind: 'video',
				stream: remote.stream
			});
		}
		if (calls.localVideoStream) {
			tiles.push({
				id: 'local-camera',
				label: 'You',
				detail: calls.cameraFacingLabel,
				kind: 'video',
				stream: calls.localVideoStream,
				local: true
			});
		}
		for (let index = 0; index < placeholderCount; index += 1) {
			tiles.push({
				id: `placeholder-${index}`,
				label: 'Participant',
				detail: 'Camera off',
				kind: 'placeholder',
				stream: null
			});
		}
		return tiles.length
			? tiles
			: [
					{
						id: 'waiting',
						label: 'Waiting',
						detail: 'No video yet',
						kind: 'placeholder',
						stream: null
					}
				];
	});
	const featuredVideo = $derived.by(() => {
		const selected = calls.featuredVideoId ? videoTiles.find((tile) => tile.id === calls.featuredVideoId) : null;
		return selected ?? videoTiles.find((tile) => tile.kind === 'screen') ?? videoTiles.find((tile) => tile.stream) ?? videoTiles[0];
	});
	const secondaryVideoTiles = $derived(videoTiles.filter((tile) => tile.id !== featuredVideo?.id));

	onMount(() => {
		const handleFullscreenChange = () => {
			if (!document.fullscreenElement) calls.setVideoSurfaceExpanded(false);
		};
		document.addEventListener('fullscreenchange', handleFullscreenChange);
		return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
	});
</script>

<CallPrejoinDialog />

{#each calls.remoteStreams as remote (remote.id)}
	<audio autoplay playsinline class="sr-only" use:attachStream={remote.stream} use:attachRemoteAudio></audio>
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
						onclick={() => calls.openAcceptPrejoin(call)}
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
			<div
				class={cn(
					'pointer-events-none fixed inset-x-0 z-40 px-3',
					calls.videoSurfaceExpanded
						? 'inset-y-0 bg-background/95 pb-[calc(var(--sab)+5.25rem)] pt-[calc(var(--sat)+0.75rem)] backdrop-blur-xl'
						: 'bottom-[calc(var(--sab)+5.75rem)]'
				)}
			>
				<div
					bind:this={videoSurfaceElement}
					class={cn(
						'pointer-events-auto mx-auto flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl',
						calls.videoSurfaceExpanded ? 'h-full max-w-7xl' : 'max-w-5xl'
					)}
				>
					<div class="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-semibold text-foreground">{activeTitle}</p>
							<p class="truncate text-xs text-muted">
								{calls.connectionStatus.label} / {calls.videoOrientation} / {activeDetail}
							</p>
						</div>
						<div
							class={cn(
								'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
								calls.connectionStatus.quality === 'good'
									? 'bg-success/15 text-success'
									: calls.connectionStatus.quality === 'unstable' || calls.connectionStatus.quality === 'connecting'
										? 'bg-warning/15 text-warning'
										: calls.connectionStatus.quality === 'failed'
											? 'bg-danger/15 text-danger'
											: 'bg-surface-3 text-muted'
							)}
						>
							<Activity class="h-3.5 w-3.5" />
							{calls.connectionStatus.label}
						</div>
						<select
							value={calls.videoQualityPreference}
							onchange={(event) => calls.setVideoQualityPreference(selectedValue(event))}
							disabled={isBusy || calls.mediaState !== 'active'}
							aria-label="Video quality"
							class="h-8 rounded-lg border border-border bg-surface px-2 text-xs font-medium text-foreground outline-none focus:border-primary disabled:opacity-60"
						>
							{#each calls.videoQualityOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
						<button
							type="button"
							onclick={toggleVideoExpanded}
							title={calls.videoSurfaceExpanded ? 'Exit full screen' : 'Full screen'}
							aria-label={calls.videoSurfaceExpanded ? 'Exit full screen' : 'Full screen'}
							class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-foreground"
						>
							{#if calls.videoSurfaceExpanded}
								<Minimize2 class="h-4 w-4" />
							{:else}
								<Maximize2 class="h-4 w-4" />
							{/if}
						</button>
					</div>

					<div class={cn('grid gap-2 p-2', calls.videoSurfaceExpanded ? 'min-h-0 flex-1' : '')}>
						<button
							type="button"
							onclick={() => featuredVideo && selectVideoTile(featuredVideo)}
							class={cn(
								'relative overflow-hidden rounded-lg bg-black text-left outline-none ring-primary transition focus-visible:ring-2',
								calls.videoSurfaceExpanded ? 'min-h-0 flex-1' : 'aspect-video'
							)}
						>
							{#if featuredVideo?.stream}
								<video
									autoplay
									playsinline
									muted={featuredVideo.local}
									class={cn('h-full w-full bg-black', featuredVideo.kind === 'screen' ? 'object-contain' : 'object-cover')}
									use:attachStream={featuredVideo.stream}
								></video>
							{:else}
								<div class="grid h-full min-h-52 place-items-center bg-surface-2 text-muted">
									{#if featuredVideo?.kind === 'screen'}
										<MonitorOff class="h-9 w-9" />
									{:else}
										<Video class="h-9 w-9" />
									{/if}
								</div>
							{/if}
							<div class="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
								<span class="min-w-0 truncate rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">
									{featuredVideo?.label}
								</span>
								<span class="shrink-0 rounded-md bg-black/65 px-2 py-1 text-xs font-medium text-white">
									{featuredVideo?.detail}
								</span>
							</div>
						</button>

						{#if secondaryVideoTiles.length}
							<div class="grid max-h-36 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4">
								{#each secondaryVideoTiles as tile (tile.id)}
									<button
										type="button"
										onclick={() => selectVideoTile(tile)}
										title={tile.label}
										aria-label={`Feature ${tile.label}`}
										class="relative aspect-video overflow-hidden rounded-lg bg-black text-left outline-none ring-primary transition hover:brightness-110 focus-visible:ring-2"
									>
										{#if tile.stream}
											<video
												autoplay
												playsinline
												muted={tile.local}
												class={cn('h-full w-full bg-black', tile.kind === 'screen' ? 'object-contain' : 'object-cover')}
												use:attachStream={tile.stream}
											></video>
										{:else}
											<div class="grid h-full place-items-center bg-surface-2 text-muted">
												{#if tile.kind === 'screen'}
													<MonitorOff class="h-5 w-5" />
												{:else}
													<Video class="h-5 w-5" />
												{/if}
											</div>
										{/if}
										<span class="absolute inset-x-1 bottom-1 truncate rounded bg-black/65 px-1.5 py-0.5 text-xs font-medium text-white">
											{tile.label}
										</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>

					{#if calls.localScreenStream}
						<div class="border-t border-border bg-surface-2 px-3 py-2 text-xs font-medium text-muted">
							Screen sharing active
						</div>
					{:else if calls.screenShareSupported}
						<div class="border-t border-border bg-surface-2 px-3 py-2 text-xs font-medium text-muted">
							Screen sharing available
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="pointer-events-none fixed inset-x-0 bottom-[calc(var(--sab)+0.75rem)] z-50 px-3">
			<div
				class="pointer-events-auto mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
			>
				{#if calls.callDevicePanelOpen}
					<div class="grid gap-3 border-b border-border bg-surface-2 px-3 py-3 sm:grid-cols-2">
						<label class="flex flex-col gap-1.5 text-xs font-medium text-muted">
							Microphone
							<select
								value={calls.activeAudioInputId || calls.devicePreferences.audioInputId || ''}
								disabled={isBusy || calls.mediaState !== 'active'}
								onfocus={() => calls.refreshCallDevices({ quiet: true })}
								onchange={(event) => calls.setActiveAudioInput(selectedValue(event))}
								class="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
							>
								<option value="">Default microphone</option>
								{#each calls.microphones as device (device.deviceId)}
									<option value={device.deviceId}>{device.label}</option>
								{/each}
							</select>
						</label>

						{#if calls.audioOutputSupported}
							<label class="flex flex-col gap-1.5 text-xs font-medium text-muted">
								Speaker
								<select
									value={calls.devicePreferences.audioOutputId ?? ''}
									disabled={isBusy || calls.mediaState !== 'active'}
									onfocus={() => calls.refreshCallDevices({ quiet: true })}
									onchange={(event) => calls.setAudioOutputDevice(selectedValue(event))}
									class="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
								>
									<option value="">Default speaker</option>
									{#each calls.speakers as device (device.deviceId)}
										<option value={device.deviceId}>{device.label}</option>
									{/each}
								</select>
							</label>
						{/if}

						{#if isVideoCall}
							<label class="flex flex-col gap-1.5 text-xs font-medium text-muted {calls.audioOutputSupported ? 'sm:col-span-2' : ''}">
								Camera
								<select
									value={calls.activeVideoInputId || calls.devicePreferences.videoInputId || ''}
									disabled={isBusy || calls.mediaState !== 'active'}
									onfocus={() => calls.refreshCallDevices({ quiet: true })}
									onchange={(event) => calls.setActiveVideoInput(selectedValue(event))}
									class="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
								>
									<option value="">Default camera</option>
									{#each calls.cameras as device (device.deviceId)}
										<option value={device.deviceId}>{device.label}</option>
									{/each}
								</select>
							</label>
						{/if}
						{#if calls.deviceError}
							<p class="rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger sm:col-span-2">
								{calls.deviceError}
							</p>
						{/if}
					</div>
				{/if}

				<div class="flex items-center gap-3 px-3 py-2">
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
					<button
						type="button"
						onclick={() => calls.toggleCallDevicePanel()}
						disabled={isBusy || calls.mediaState !== 'active'}
						title="Call devices"
						aria-label="Call devices"
						class={cn(
							'grid h-10 w-10 place-items-center rounded-lg border border-border transition disabled:cursor-not-allowed disabled:opacity-50',
							calls.callDevicePanelOpen
								? 'bg-primary-soft text-primary hover:brightness-105'
								: 'bg-surface-2 text-foreground hover:bg-surface-3'
						)}
					>
						{#if calls.audioOutputSupported}
							<Volume2 class="h-4.5 w-4.5" />
						{:else}
							<Settings class="h-4.5 w-4.5" />
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
								title={`Switch camera · ${calls.cameraFacingLabel}`}
								aria-label={`Switch camera · ${calls.cameraFacingLabel}`}
								class="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface-2 text-foreground transition hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{#if calls.switchingCamera}
								<Loader2 class="h-4.5 w-4.5 animate-spin" />
							{:else}
									<SwitchCamera class="h-4.5 w-4.5" />
								{/if}
							</button>
							{#if calls.screenShareSupported}
								<button
									type="button"
									onclick={() => calls.toggleScreenShare()}
									disabled={isBusy || calls.mediaState !== 'active' || calls.startingScreenShare}
									title={calls.screenShareEnabled ? 'Stop screen sharing' : 'Share screen'}
									aria-label={calls.screenShareEnabled ? 'Stop screen sharing' : 'Share screen'}
									class={cn(
										'grid h-10 w-10 place-items-center rounded-lg border border-border transition disabled:cursor-not-allowed disabled:opacity-50',
										calls.screenShareEnabled
											? 'bg-primary-soft text-primary hover:brightness-105'
											: 'bg-surface-2 text-foreground hover:bg-surface-3'
									)}
								>
									{#if calls.startingScreenShare}
										<Loader2 class="h-4.5 w-4.5 animate-spin" />
									{:else if calls.screenShareEnabled}
										<MonitorOff class="h-4.5 w-4.5" />
									{:else}
										<Monitor class="h-4.5 w-4.5" />
									{/if}
								</button>
							{/if}
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
	</div>
{/if}
