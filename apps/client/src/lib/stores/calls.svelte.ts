import { api, isApiError } from '$lib/api';
import type {
	Call,
	CallParticipant,
	CallRealtimeConfig,
	CallRealtimeSessionDescription,
	CallRealtimeTrack,
	CallRealtimeTrackInput,
	CallRealtimeTrackKind,
	CallType,
	RealtimeCallEvent,
	Room
} from '$lib/api/types';
import { auth } from './auth.svelte';
import { rooms } from './rooms.svelte';
import { toasts } from './toast.svelte';

type CallMediaState = 'idle' | 'connecting' | 'active' | 'ending' | 'unavailable' | 'error';

export interface RemoteAudioStream {
	id: string;
	stream: MediaStream;
}

export interface RemoteVideoStream {
	id: string;
	stream: MediaStream;
	kind: 'video' | 'screen';
	displayName?: string | null;
}

type CameraFacingMode = 'user' | 'environment';

const LIVE_CALL_STATUSES = new Set(['ringing', 'active']);
const INCOMING_PARTICIPANT_STATUSES = new Set(['invited', 'ringing', 'joining']);
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true
};
const VIDEO_SEND_ENCODINGS: RTCRtpEncodingParameters[] = [
	{ rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
	{ rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 700_000 },
	{ rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 250_000 }
];
const VIDEO_SIMULCAST_POLICY = {
	desktopPreferredRid: 'h',
	mobilePreferredRid: 'q',
	priorityOrdering: 'asciibetical',
	ridNotAvailable: 'asciibetical'
} as const;

class CallsStore {
	activeCall = $state<Call | null>(null);
	activeRoom = $state<Room | null>(null);
	incoming = $state<Call[]>([]);
	mediaState = $state<CallMediaState>('idle');
	muted = $state(false);
	startingRoomId = $state<string | null>(null);
	startingCallType = $state<CallType | null>(null);
	busyCallId = $state<string | null>(null);
	lastError = $state<string | null>(null);
	remoteStreams = $state<RemoteAudioStream[]>([]);
	remoteVideoStreams = $state<RemoteVideoStream[]>([]);
	localVideoStream = $state<MediaStream | null>(null);
	cameraEnabled = $state(false);
	switchingCamera = $state(false);
	cameraFacingMode = $state<CameraFacingMode>('user');
	videoQualityPolicy = VIDEO_SIMULCAST_POLICY;

	readonly connectedParticipants = $derived(
		this.activeCall?.participants.filter((participant) => participant.status === 'connected') ?? []
	);
	readonly ringingParticipants = $derived(
		this.activeCall?.participants.filter((participant) => participant.status === 'ringing') ?? []
	);

	private peer: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;
	private sessionId: string | null = null;
	private mediaCallId: string | null = null;
	private publishedMids = new Set<string>();
	private subscribedTracks = new Set<string>();
	private pendingRemoteVideoTracks: CallRealtimeTrack[] = [];
	private videoSender: RTCRtpSender | null = null;
	private subscribing = false;

	constructor() {
		auth.onSignOut(() => this.reset());
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.hidden && this.activeCall?.callType === 'video' && this.cameraEnabled) {
					void this.setCameraEnabled(false, { notifyOnError: false });
				}
			});
		}
	}

	canStart(room: Room): boolean {
		return (
			room.status === 'active' &&
			!rooms.isAgentDirect(room) &&
			rooms.activeMembers(room).length > 1 &&
			!this.activeCall &&
			!this.startingRoomId
		);
	}

	async startAudioCall(room: Room): Promise<void> {
		await this.startCall(room, 'audio');
	}

	async startVideoCall(room: Room): Promise<void> {
		await this.startCall(room, 'video');
	}

	private async startCall(room: Room, callType: CallType): Promise<void> {
		if (!this.canStart(room)) return;
		this.startingRoomId = room.roomId;
		this.startingCallType = callType;
		this.lastError = null;
		this.mediaState = 'connecting';
		try {
			const call = await api.createCall(room.roomId, { callType });
			this.activeCall = call;
			this.activeRoom = room;
			this.muted = false;
			this.cameraEnabled = false;
			const connected = await this.connectMedia(call);
			if (!connected) {
				await this.leaveCallQuietly(call.callId);
				this.clearActiveCall();
			}
		} catch (error) {
			this.mediaState = 'error';
			this.lastError = displayError(error, `Could not start the ${callType} call.`);
			toasts.error(this.lastError);
		} finally {
			this.startingRoomId = null;
			this.startingCallType = null;
		}
	}

	async acceptCall(call: Call): Promise<void> {
		if (this.activeCall && this.activeCall.callId !== call.callId) {
			toasts.info('Leave the current call before joining another.');
			return;
		}
		this.busyCallId = call.callId;
		this.lastError = null;
		this.mediaState = 'connecting';
		try {
			const joined = await api.joinCall(call.callId);
			this.removeIncoming(call.callId);
			this.activeCall = joined;
			this.activeRoom = rooms.get(joined.roomId) ?? this.activeRoom;
			this.muted = false;
			this.cameraEnabled = false;
			const connected = await this.connectMedia(joined);
			if (!connected) {
				await this.leaveCallQuietly(joined.callId);
				this.clearActiveCall();
			}
		} catch (error) {
			this.mediaState = 'error';
			this.lastError = displayError(error, 'Could not join the call.');
			toasts.error(this.lastError);
		} finally {
			this.busyCallId = null;
		}
	}

	async declineCall(callId: string): Promise<void> {
		this.busyCallId = callId;
		try {
			await api.declineCall(callId);
			this.removeIncoming(callId);
		} catch (error) {
			toasts.error(displayError(error, 'Could not decline the call.'));
		} finally {
			this.busyCallId = null;
		}
	}

	async endActiveCall(): Promise<void> {
		const call = this.activeCall;
		if (!call) return;
		this.busyCallId = call.callId;
		this.mediaState = 'ending';
		try {
			await this.closeMedia();
			await api.leaveCall(call.callId);
		} catch (error) {
			toasts.error(displayError(error, 'Could not leave the call.'));
		} finally {
			this.busyCallId = null;
			this.clearActiveCall();
		}
	}

	async toggleMute(): Promise<void> {
		const call = this.activeCall;
		if (!call || !this.localStream) return;
		const nextMuted = !this.muted;
		this.setLocalMuted(nextMuted);
		try {
			const updated = nextMuted ? await api.muteCall(call.callId) : await api.unmuteCall(call.callId);
			this.activeCall = updated;
		} catch (error) {
			this.setLocalMuted(!nextMuted);
			toasts.error(displayError(error, 'Could not update mute.'));
		}
	}

	async toggleCamera(): Promise<void> {
		if (this.activeCall?.callType !== 'video' || this.mediaState !== 'active') return;
		await this.setCameraEnabled(!this.cameraEnabled);
	}

	async switchCamera(): Promise<void> {
		if (this.activeCall?.callType !== 'video' || this.mediaState !== 'active' || this.switchingCamera) return;
		const previous = this.cameraFacingMode;
		const next: CameraFacingMode = previous === 'user' ? 'environment' : 'user';
		this.cameraFacingMode = next;
		if (!this.cameraEnabled) return;
		this.switchingCamera = true;
		try {
			await this.replaceCameraTrack(next);
		} catch (error) {
			this.cameraFacingMode = previous;
			toasts.error(displayError(error, 'Could not switch camera.'));
		} finally {
			this.switchingCamera = false;
		}
	}

	async handleRealtimeEvent(event: RealtimeCallEvent): Promise<void> {
		if (event.type === 'call.invite' || event.type === 'call.ringing') {
			if (event.createdByPrincipalId !== auth.principal?.principalId) {
				await this.refreshIncomingCall(event.callId);
			}
			return;
		}
		if (event.type === 'call.ended') {
			this.removeIncoming(event.callId);
			if (this.activeCall?.callId === event.callId) {
				await this.closeMedia();
				this.clearActiveCall();
			}
			return;
		}
		if (this.activeCall?.callId === event.callId) {
			await this.refreshActiveCall();
			if (event.type === 'call.joined' || event.type === 'call.updated') {
				await this.refreshAvailableTracks();
			}
		}
	}

	async recoverLiveCalls(): Promise<void> {
		if (this.activeCall || this.incoming.length) return;
		for (const room of rooms.sorted.filter((candidate) => candidate.status === 'active')) {
			try {
				const page = await api.listRoomCalls(room.roomId, { limit: 5 });
				for (const call of page.items) {
					if (!LIVE_CALL_STATUSES.has(call.status)) continue;
					const participant = this.currentParticipant(call);
					if (participant?.status === 'connected') {
						this.activeCall = call;
						this.activeRoom = room;
						this.muted = !!participant.mutedAt;
						void this.connectMedia(call);
						return;
					}
					if (participant && INCOMING_PARTICIPANT_STATUSES.has(participant.status)) {
						this.incoming = [...this.incoming.filter((candidate) => candidate.callId !== call.callId), call];
					}
				}
			} catch {
				/* call recovery is opportunistic */
			}
		}
	}

	private async refreshIncomingCall(callId: string): Promise<void> {
		try {
			const call = await api.getCall(callId);
			if (!LIVE_CALL_STATUSES.has(call.status)) {
				this.removeIncoming(callId);
				return;
			}
			if (!this.isPendingForMe(call)) return;
			const next = this.incoming.filter((candidate) => candidate.callId !== callId);
			this.incoming = [...next, call];
		} catch {
			this.removeIncoming(callId);
		}
	}

	private async refreshActiveCall(): Promise<void> {
		const callId = this.activeCall?.callId;
		if (!callId) return;
		try {
			const call = await api.getCall(callId);
			if (!LIVE_CALL_STATUSES.has(call.status)) {
				await this.closeMedia();
				this.clearActiveCall();
				return;
			}
			this.activeCall = call;
		} catch {
			/* keep the current call until an explicit terminal event arrives */
		}
	}

	private async connectMedia(call: Call): Promise<boolean> {
		if (!hasMediaSupport()) {
			this.mediaState = 'unavailable';
			this.lastError = 'Calls are not available in this browser.';
			toasts.error(this.lastError);
			return false;
		}
		try {
			const sessionConfig = await api.getCallRealtimeSessionConfig(call.callId);
			if (!sessionConfig.configured || !sessionConfig.session?.sessionId) {
				this.mediaState = 'unavailable';
				this.lastError = sessionConfig.message;
				toasts.error(sessionConfig.message);
				return false;
			}

			const peer = new RTCPeerConnection({
				iceServers: sessionConfig.iceServers as RTCIceServer[]
			});
			this.peer = peer;
			this.sessionId = sessionConfig.session.sessionId;
			this.mediaCallId = call.callId;
			this.publishedMids = new Set();
			this.subscribedTracks = new Set();
			this.pendingRemoteVideoTracks = [];
			this.remoteStreams = [];
			this.remoteVideoStreams = [];
			this.localVideoStream = null;
			this.cameraEnabled = false;
			this.wirePeer(peer);

			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: AUDIO_CONSTRAINTS,
				video: call.callType === 'video' ? videoConstraints(this.cameraFacingMode) : false
			});
			const audioTrack = this.localStream.getAudioTracks()[0];
			if (!audioTrack) throw new Error('Microphone did not provide an audio track.');
			const publishTracks: CallRealtimeTrackInput[] = [];
			const publishMids: Array<string | null> = [];
			const audioTransceiver = peer.addTransceiver(audioTrack, {
				direction: 'sendonly',
				streams: [this.localStream]
			});
			publishMids.push(audioTransceiver.mid);
			publishTracks.push({
				location: 'local',
				trackName: localTrackName(call, 'audio'),
				kind: 'audio',
				mid: audioTransceiver.mid
			});

			if (call.callType === 'video') {
				const videoTrack = this.localStream.getVideoTracks()[0];
				if (!videoTrack) throw new Error('Camera did not provide a video track.');
				const videoTransceiver = addCameraTransceiver(peer, videoTrack, this.localStream);
				this.videoSender = videoTransceiver.sender;
				publishMids.push(videoTransceiver.mid);
				publishTracks.push({
					location: 'local',
					trackName: localTrackName(call, 'video'),
					kind: 'video',
					mid: videoTransceiver.mid
				});
				this.cameraEnabled = true;
				this.updateLocalVideoStream();
			}

			const offer = await createOffer(peer);
			const trackConfig = await api.getCallRealtimeTrackConfig(call.callId, {
				sessionId: this.sessionId,
				sessionDescription: offer,
				tracks: publishTracks
			});
			await this.applyProviderDescription(trackConfig);
			this.publishedMids = publishedTrackMids(trackConfig, publishMids);
			this.mediaState = 'active';
			await this.subscribeAvailableTracks([
				...(sessionConfig.availableTracks ?? sessionConfig.tracks ?? []),
				...(trackConfig.availableTracks ?? [])
			]);
			return true;
		} catch (error) {
			await this.closeMedia({ notifyProvider: false });
			this.mediaState = 'error';
			this.lastError = displayError(error, 'Could not connect call media.');
			toasts.error(this.lastError);
			return false;
		}
	}

	private wirePeer(peer: RTCPeerConnection): void {
		peer.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			const id = event.track.id || event.transceiver.mid || cryptoId('remote');
			if (event.track.kind === 'video') {
				const metadata = this.pendingRemoteVideoTracks.shift();
				if (!this.remoteVideoStreams.some((candidate) => candidate.id === id)) {
					this.remoteVideoStreams = [
						...this.remoteVideoStreams,
						{
							id,
							stream,
							kind: metadata?.kind === 'screen' ? 'screen' : 'video',
							displayName: metadata?.displayName
						}
					];
				}
			} else if (!this.remoteStreams.some((candidate) => candidate.id === id)) {
				this.remoteStreams = [...this.remoteStreams, { id, stream }];
			}
			event.track.onended = () => {
				if (event.track.kind === 'video') {
					this.remoteVideoStreams = this.remoteVideoStreams.filter((candidate) => candidate.id !== id);
				} else {
					this.remoteStreams = this.remoteStreams.filter((candidate) => candidate.id !== id);
				}
			};
		};
		peer.onconnectionstatechange = () => {
			if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
				this.lastError = 'Call media connection was interrupted.';
			}
		};
	}

	private async refreshAvailableTracks(): Promise<void> {
		if (!this.activeCall || !this.sessionId || this.mediaState !== 'active') return;
		try {
			const config = await api.getCallRealtimeTrackConfig(this.activeCall.callId, {
				sessionId: this.sessionId
			});
			await this.subscribeAvailableTracks(config.availableTracks ?? config.tracks ?? []);
		} catch {
			/* remote subscription can recover on the next call event */
		}
	}

	private async subscribeAvailableTracks(tracks: CallRealtimeTrack[]): Promise<void> {
		if (this.subscribing || !this.activeCall || !this.sessionId || !this.peer) return;
		const remoteTracks = tracks.filter(
			(track) =>
				canSubscribeTrackKind(track.kind, this.activeCall?.callType ?? 'audio') &&
				track.location === 'remote' &&
				!!track.sessionId &&
				!!track.trackName &&
				!this.subscribedTracks.has(remoteTrackKey(track))
		);
		if (!remoteTracks.length) return;
		this.subscribing = true;
		try {
			for (const track of remoteTracks) {
				this.peer.addTransceiver(receiverKind(track.kind), {
					direction: 'recvonly'
				});
				this.subscribedTracks.add(remoteTrackKey(track));
				if (isVideoTrackKind(track.kind)) this.pendingRemoteVideoTracks.push(track);
			}
			const offer = await createOffer(this.peer);
			const config = await api.getCallRealtimeTrackConfig(this.activeCall.callId, {
				sessionId: this.sessionId,
				sessionDescription: offer,
				tracks: remoteTracks.map((track) => ({
					location: 'remote',
					sessionId: track.sessionId,
					trackName: track.trackName,
					kind: track.kind,
					simulcast: isVideoTrackKind(track.kind) ? remoteVideoSimulcastPolicy() : undefined
				}))
			});
			await this.applyProviderDescription(config);
		} catch {
			for (const track of remoteTracks) this.subscribedTracks.delete(remoteTrackKey(track));
			this.pendingRemoteVideoTracks = this.pendingRemoteVideoTracks.filter(
				(candidate) => !remoteTracks.some((track) => remoteTrackKey(track) === remoteTrackKey(candidate))
			);
		} finally {
			this.subscribing = false;
		}
	}

	private async applyProviderDescription(config: CallRealtimeConfig): Promise<void> {
		if (!config.sessionDescription || !this.peer || !this.activeCall || !this.sessionId) return;
		await this.peer.setRemoteDescription(config.sessionDescription);
		if (config.sessionDescription.type === 'offer') {
			const answer = await createAnswer(this.peer);
			await api.renegotiateCallRealtimeSession(this.activeCall.callId, {
				sessionId: this.sessionId,
				sessionDescription: answer
			});
		}
	}

	private setLocalMuted(muted: boolean): void {
		this.muted = muted;
		for (const track of this.localStream?.getAudioTracks() ?? []) {
			track.enabled = !muted;
		}
	}

	private async setCameraEnabled(enabled: boolean, options: { notifyOnError?: boolean } = {}): Promise<void> {
		if (!this.peer || !this.localStream || !this.videoSender) return;
		const notifyOnError = options.notifyOnError ?? true;
		if (!enabled) {
			const currentTrack = this.localStream.getVideoTracks()[0];
			await this.videoSender.replaceTrack(null);
			if (currentTrack) {
				currentTrack.stop();
				this.localStream.removeTrack(currentTrack);
			}
			this.cameraEnabled = false;
			this.updateLocalVideoStream();
			return;
		}
		try {
			await this.replaceCameraTrack(this.cameraFacingMode);
			this.cameraEnabled = true;
		} catch (error) {
			this.cameraEnabled = false;
			this.updateLocalVideoStream();
			if (notifyOnError) toasts.error(displayError(error, 'Could not turn camera on.'));
		}
	}

	private async replaceCameraTrack(facingMode: CameraFacingMode): Promise<void> {
		if (!this.localStream || !this.videoSender) return;
		const cameraStream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: videoConstraints(facingMode)
		});
		const nextTrack = cameraStream.getVideoTracks()[0];
		if (!nextTrack) {
			for (const track of cameraStream.getTracks()) track.stop();
			throw new Error('Camera did not provide a video track.');
		}
		const previousTrack = this.localStream.getVideoTracks()[0];
		try {
			await this.videoSender.replaceTrack(nextTrack);
		} catch (error) {
			nextTrack.stop();
			throw error;
		}
		if (previousTrack) {
			previousTrack.stop();
			this.localStream.removeTrack(previousTrack);
		}
		this.localStream.addTrack(nextTrack);
		this.cameraEnabled = true;
		this.updateLocalVideoStream();
	}

	private updateLocalVideoStream(): void {
		const videoTracks = this.localStream?.getVideoTracks().filter((track) => track.readyState === 'live') ?? [];
		this.localVideoStream = videoTracks.length ? new MediaStream(videoTracks) : null;
		if (!videoTracks.length) this.cameraEnabled = false;
	}

	private async closeMedia(options: { notifyProvider?: boolean } = {}): Promise<void> {
		const notifyProvider = options.notifyProvider ?? true;
		const callId = this.mediaCallId;
		const sessionId = this.sessionId;
		const mids = [...this.publishedMids];
		if (notifyProvider && callId && sessionId && mids.length) {
			await api
				.closeCallRealtimeTracks(callId, {
					sessionId,
					tracks: mids.map((mid) => ({ mid })),
					force: true
				})
				.catch(() => undefined);
		}
		for (const track of this.localStream?.getTracks() ?? []) track.stop();
		this.localStream = null;
		this.peer?.close();
		this.peer = null;
		this.sessionId = null;
		this.mediaCallId = null;
		this.publishedMids = new Set();
		this.subscribedTracks = new Set();
		this.pendingRemoteVideoTracks = [];
		this.videoSender = null;
		this.remoteStreams = [];
		this.remoteVideoStreams = [];
		this.localVideoStream = null;
		this.cameraEnabled = false;
	}

	private async leaveCallQuietly(callId: string): Promise<void> {
		try {
			await this.closeMedia();
			await api.leaveCall(callId);
		} catch {
			/* best effort cleanup */
		}
	}

	private clearActiveCall(): void {
		this.activeCall = null;
		this.activeRoom = null;
		this.mediaState = 'idle';
		this.muted = false;
		this.cameraEnabled = false;
		this.switchingCamera = false;
	}

	private removeIncoming(callId: string): void {
		this.incoming = this.incoming.filter((call) => call.callId !== callId);
	}

	private isPendingForMe(call: Call): boolean {
		const participant = this.currentParticipant(call);
		return !!participant && INCOMING_PARTICIPANT_STATUSES.has(participant.status);
	}

	private currentParticipant(call: Call): CallParticipant | undefined {
		const principalId = auth.principal?.principalId;
		const deviceId = auth.device?.deviceId;
		return call.participants.find(
			(participant) =>
				participant.principalId === principalId && (participant.deviceId === null || participant.deviceId === deviceId)
		);
	}

	private reset(): void {
		void this.closeMedia({ notifyProvider: false });
		this.activeCall = null;
		this.activeRoom = null;
		this.incoming = [];
		this.mediaState = 'idle';
		this.muted = false;
		this.startingRoomId = null;
		this.startingCallType = null;
		this.busyCallId = null;
		this.lastError = null;
		this.remoteVideoStreams = [];
		this.localVideoStream = null;
		this.cameraEnabled = false;
		this.switchingCamera = false;
	}
}

function hasMediaSupport(): boolean {
	return (
		typeof RTCPeerConnection !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		!!navigator.mediaDevices?.getUserMedia
	);
}

async function createOffer(peer: RTCPeerConnection): Promise<CallRealtimeSessionDescription> {
	const offer = await peer.createOffer();
	await peer.setLocalDescription(offer);
	await waitForIceGathering(peer);
	return sessionDescription(peer.localDescription);
}

async function createAnswer(peer: RTCPeerConnection): Promise<CallRealtimeSessionDescription> {
	const answer = await peer.createAnswer();
	await peer.setLocalDescription(answer);
	await waitForIceGathering(peer);
	return sessionDescription(peer.localDescription);
}

function sessionDescription(description: RTCSessionDescription | null): CallRealtimeSessionDescription {
	if (!description) throw new Error('Missing WebRTC session description.');
	return { type: description.type, sdp: description.sdp };
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
	if (peer.iceGatheringState === 'complete') return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = window.setTimeout(done, 2000);
		function done(): void {
			window.clearTimeout(timeout);
			peer.removeEventListener('icegatheringstatechange', onChange);
			resolve();
		}
		function onChange(): void {
			if (peer.iceGatheringState === 'complete') done();
		}
		peer.addEventListener('icegatheringstatechange', onChange);
	});
}

function addCameraTransceiver(
	peer: RTCPeerConnection,
	track: MediaStreamTrack,
	stream: MediaStream
): RTCRtpTransceiver {
	try {
		return peer.addTransceiver(track, {
			direction: 'sendonly',
			streams: [stream],
			sendEncodings: VIDEO_SEND_ENCODINGS
		});
	} catch {
		return peer.addTransceiver(track, {
			direction: 'sendonly',
			streams: [stream]
		});
	}
}

function videoConstraints(facingMode: CameraFacingMode): MediaTrackConstraints {
	return {
		width: { ideal: 1280 },
		height: { ideal: 720 },
		frameRate: { ideal: 24, max: 30 },
		facingMode: { ideal: facingMode }
	};
}

function localTrackName(call: Call, kind: 'audio' | 'video'): string {
	const suffix = kind === 'video' ? 'camera' : kind;
	return `${auth.device?.deviceId ?? 'device'}-${call.callId}-${suffix}`;
}

function publishedTrackMids(config: CallRealtimeConfig, fallbackMids: Array<string | null>): Set<string> {
	const mids = new Set<string>();
	for (const track of config.tracks ?? []) {
		if (track.location === 'local' && track.mid) mids.add(track.mid);
	}
	for (const mid of fallbackMids) {
		if (mid) mids.add(mid);
	}
	return mids;
}

function remoteTrackKey(track: CallRealtimeTrack): string {
	return `${track.kind}:${track.sessionId}:${track.trackName}`;
}

function canSubscribeTrackKind(kind: CallRealtimeTrackKind, callType: CallType): boolean {
	if (kind === 'audio') return true;
	return callType === 'video' && isVideoTrackKind(kind);
}

function isVideoTrackKind(kind: CallRealtimeTrackKind): kind is 'video' | 'screen' {
	return kind === 'video' || kind === 'screen';
}

function receiverKind(kind: CallRealtimeTrackKind): 'audio' | 'video' {
	return isVideoTrackKind(kind) ? 'video' : 'audio';
}

function remoteVideoSimulcastPolicy(): NonNullable<CallRealtimeTrackInput['simulcast']> {
	const preferredRid =
		typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
			? VIDEO_SIMULCAST_POLICY.mobilePreferredRid
			: VIDEO_SIMULCAST_POLICY.desktopPreferredRid;
	return {
		preferredRid,
		priorityOrdering: VIDEO_SIMULCAST_POLICY.priorityOrdering,
		ridNotAvailable: VIDEO_SIMULCAST_POLICY.ridNotAvailable
	};
}

function cryptoId(prefix: string): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}_${crypto.randomUUID()}`;
	return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function displayError(error: unknown, fallback: string): string {
	return isApiError(error) ? error.display : (error as Error)?.message || fallback;
}

export const calls = new CallsStore();
