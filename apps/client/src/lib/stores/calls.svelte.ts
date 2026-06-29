import { api, isApiError } from '$lib/api';
import type {
	Call,
	CallIceCandidate,
	CallMediaProvider,
	CallParticipant,
	CallFeatureFlags,
	CallRealtimeConfig,
	CallRealtimeSessionDescription,
	CallRealtimeTrack,
	CallRealtimeTrackInput,
	CallRealtimeTrackKind,
	CallType,
	CallSignalEvent,
	CallSignalType,
	CallUsageReportTrackInput,
	RealtimeCallEvent,
	Room
} from '$lib/api/types';
import { auth } from './auth.svelte';
import { rooms } from './rooms.svelte';
import { toasts } from './toast.svelte';

type CallMediaState = 'idle' | 'connecting' | 'active' | 'ending' | 'unavailable' | 'error';
type CallPrejoinMode = 'start' | 'accept';
type CallDeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';
type CallVideoQualityPreference = 'auto' | 'low' | 'medium' | 'high';
type CallConnectionQuality = 'idle' | 'connecting' | 'good' | 'unstable' | 'failed';

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

export interface CallConnectionStatus {
	quality: CallConnectionQuality;
	label: string;
	detail: string;
}

export interface CallDiagnosticsSnapshot {
	callId: string | null;
	sessionId: string | null;
	active: boolean;
	sampledAt: string | null;
	durationMs: number;
	bytesSentEstimate: number;
	bytesReceivedEstimate: number;
	packetsLost: number;
	roundTripTimeMs: number | null;
	candidateType: string | null;
	relayLikely: boolean;
	peerConnectionState: RTCPeerConnectionState;
	iceConnectionState: RTCIceConnectionState;
	iceGatheringState: RTCIceGatheringState;
	signalingState: RTCSignalingState;
	lastUsageReportAt: string | null;
	lastUsageReportError: string | null;
}

export interface CallVideoQualityOption {
	value: CallVideoQualityPreference;
	label: string;
	preferredRid: 'q' | 'h' | 'f' | null;
}

export interface CallDeviceOption {
	deviceId: string;
	groupId: string;
	kind: CallDeviceKind;
	label: string;
}

export interface CallPrejoinState {
	mode: CallPrejoinMode;
	callType: CallType;
	room?: Room;
	call?: Call;
}

type CameraFacingMode = 'user' | 'environment';
type SinkIdMediaElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

interface CallDevicePreferences {
	audioInputId?: string;
	audioOutputId?: string;
	videoInputId?: string;
}

interface ConnectMediaOptions {
	audioInputId?: string;
	audioOutputId?: string;
	videoInputId?: string;
	startWithCamera?: boolean;
}

interface P2pSignalTarget {
	principalId: string;
	deviceId: string;
}

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
const SCREEN_SEND_ENCODINGS: RTCRtpEncodingParameters[] = [
	{ rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 2_500_000 },
	{ rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 1_200_000 },
	{ rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 450_000 }
];
const VIDEO_SIMULCAST_POLICY = {
	desktopPreferredRid: 'h',
	mobilePreferredRid: 'q',
	priorityOrdering: 'asciibetical',
	ridNotAvailable: 'asciibetical'
} as const;
const VIDEO_QUALITY_OPTIONS: CallVideoQualityOption[] = [
	{ value: 'auto', label: 'Auto', preferredRid: null },
	{ value: 'high', label: 'High', preferredRid: 'f' },
	{ value: 'medium', label: 'Medium', preferredRid: 'h' },
	{ value: 'low', label: 'Low', preferredRid: 'q' }
];
const CALL_HISTORY_LIMIT = 50;
const MEDIA_HEARTBEAT_MS = 25_000;
const CALL_STATS_POLL_MS = 5_000;
const P2P_ICE_RESTART_MAX_ATTEMPTS = 2;
const P2P_ICE_RESTART_DELAY_MS = 1_500;
const P2P_ICE_RESTART_SETTLE_MS = 6_000;
const P2P_DISCONNECTED_GRACE_MS = 4_000;
const CALL_DEVICE_PREFERENCES_KEY = 'voyager.callDevicePreferences.v1';
const CALL_VIDEO_QUALITY_KEY = 'voyager.callVideoQuality.v1';
const DEFAULT_CALL_FEATURES: CallFeatureFlags = {
	callsEnabled: true,
	audioCallsEnabled: true,
	videoCallsEnabled: true,
	screenShareEnabled: true,
	realtimeMediaEnabled: true
};
const EMPTY_CALL_DIAGNOSTICS: CallDiagnosticsSnapshot = {
	callId: null,
	sessionId: null,
	active: false,
	sampledAt: null,
	durationMs: 0,
	bytesSentEstimate: 0,
	bytesReceivedEstimate: 0,
	packetsLost: 0,
	roundTripTimeMs: null,
	candidateType: null,
	relayLikely: false,
	peerConnectionState: 'new',
	iceConnectionState: 'new',
	iceGatheringState: 'new',
	signalingState: 'stable',
	lastUsageReportAt: null,
	lastUsageReportError: null
};

class CallsStore {
	activeCall = $state<Call | null>(null);
	activeRoom = $state<Room | null>(null);
	incoming = $state<Call[]>([]);
	roomHistory = $state<Record<string, Call[]>>({});
	loadingHistoryRoomId = $state<string | null>(null);
	mediaState = $state<CallMediaState>('idle');
	muted = $state(false);
	startingRoomId = $state<string | null>(null);
	startingCallType = $state<CallType | null>(null);
	busyCallId = $state<string | null>(null);
	lastError = $state<string | null>(null);
	remoteStreams = $state<RemoteAudioStream[]>([]);
	remoteVideoStreams = $state<RemoteVideoStream[]>([]);
	localVideoStream = $state<MediaStream | null>(null);
	localScreenStream = $state<MediaStream | null>(null);
	cameraEnabled = $state(false);
	screenShareEnabled = $state(false);
	screenShareSupported = $state(false);
	startingScreenShare = $state(false);
	switchingCamera = $state(false);
	cameraFacingMode = $state<CameraFacingMode>('user');
	videoQualityPolicy = VIDEO_SIMULCAST_POLICY;
	videoQualityOptions = VIDEO_QUALITY_OPTIONS;
	videoQualityPreference = $state<CallVideoQualityPreference>('auto');
	videoSurfaceExpanded = $state(false);
	featuredVideoId = $state<string | null>(null);
	videoOrientation = $state<'portrait' | 'landscape'>('portrait');
	peerConnectionState = $state<RTCPeerConnectionState>('new');
	iceConnectionState = $state<RTCIceConnectionState>('new');
	iceGatheringState = $state<RTCIceGatheringState>('new');
	signalingState = $state<RTCSignalingState>('stable');
	callFeatures = $state<CallFeatureFlags>({ ...DEFAULT_CALL_FEATURES });
	diagnostics = $state<CallDiagnosticsSnapshot>({ ...EMPTY_CALL_DIAGNOSTICS });
	devicePreferences = $state<CallDevicePreferences>({});
	deviceOptions = $state<CallDeviceOption[]>([]);
	deviceLoading = $state(false);
	deviceError = $state<string | null>(null);
	prejoin = $state<CallPrejoinState | null>(null);
	prejoinAudioInputId = $state('');
	prejoinAudioOutputId = $state('');
	prejoinVideoInputId = $state('');
	prejoinCameraEnabled = $state(false);
	prejoinPreviewStream = $state<MediaStream | null>(null);
	prejoinBusy = $state(false);
	prejoinError = $state<string | null>(null);
	audioOutputSupported = $state(false);
	callDevicePanelOpen = $state(false);
	activeAudioInputId = $state('');
	activeVideoInputId = $state('');

	readonly connectedParticipants = $derived(
		this.activeCall?.participants.filter((participant) => participant.status === 'connected') ?? []
	);
	readonly ringingParticipants = $derived(
		this.activeCall?.participants.filter((participant) => participant.status === 'ringing') ?? []
	);
	readonly microphones = $derived(this.deviceOptions.filter((device) => device.kind === 'audioinput'));
	readonly speakers = $derived(this.deviceOptions.filter((device) => device.kind === 'audiooutput'));
	readonly cameras = $derived(this.deviceOptions.filter((device) => device.kind === 'videoinput'));
	readonly connectionStatus = $derived(
		connectionStatus(this.mediaState, this.peerConnectionState, this.iceConnectionState)
	);
	readonly cameraFacingLabel = $derived(this.cameraFacingMode === 'environment' ? 'Back camera' : 'Front camera');
	readonly screenShareAvailable = $derived(this.screenShareSupported && this.callFeatures.screenShareEnabled);

	private peer: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;
	private sessionId: string | null = null;
	private mediaCallId: string | null = null;
	private mediaProvider: CallMediaProvider | null = null;
	private publishedMids = new Set<string>();
	private subscribedTracks = new Set<string>();
	private pendingRemoteVideoTracks: CallRealtimeTrack[] = [];
	private audioSender: RTCRtpSender | null = null;
	private videoSender: RTCRtpSender | null = null;
	private videoTransceiver: RTCRtpTransceiver | null = null;
	private screenSender: RTCRtpSender | null = null;
	private screenTrackMid: string | null = null;
	private subscribing = false;
	private mediaHeartbeat: ReturnType<typeof setInterval> | null = null;
	private statsHeartbeat: ReturnType<typeof setInterval> | null = null;
	private remoteAudioElements = new Set<HTMLMediaElement>();
	private prejoinPreviewRequestId = 0;
	private mediaAttemptId = 0;
	private mediaStartedAt: number | null = null;
	private usageReportSent = false;
	private p2pTarget: P2pSignalTarget | null = null;
	private p2pPolite = true;
	private p2pMakingOffer = false;
	private p2pSettingRemoteAnswerPending = false;
	private p2pIgnoreOffer = false;
	private p2pInitialOfferSent = false;
	private p2pInitialNegotiationComplete = false;
	private p2pReadyTargetKey: string | null = null;
	private p2pSignalSequence = 0;
	private p2pPendingCandidates: CallIceCandidate[] = [];
	private pendingP2pSignals: CallSignalEvent[] = [];
	private p2pIceRestartTimer: ReturnType<typeof setTimeout> | null = null;
	private p2pIceRestartAttempts = 0;
	private p2pRecoveryNotified = false;

	constructor() {
		this.loadDevicePreferences();
		this.loadVideoQualityPreference();
		this.screenShareSupported = hasDisplayMediaSupport();
		if (typeof HTMLMediaElement !== 'undefined') {
			this.audioOutputSupported = 'setSinkId' in HTMLMediaElement.prototype;
		}
		if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
			navigator.mediaDevices.addEventListener('devicechange', () => {
				void this.refreshCallDevices({ quiet: true });
			});
		}
		auth.onSignOut(() => this.reset());
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.hidden && this.activeCall?.callType === 'video') {
					if (this.cameraEnabled) void this.setCameraEnabled(false, { notifyOnError: false });
					if (this.screenShareEnabled) void this.stopScreenShare({ notifyOnError: false });
				}
			});
		}
		if (typeof window !== 'undefined') {
			this.updateVideoOrientation();
			window.addEventListener('resize', () => this.updateVideoOrientation());
			window.addEventListener('orientationchange', () => this.updateVideoOrientation());
		}
	}

	canStart(room: Room): boolean {
		return (
			room.status === 'active' &&
			!rooms.isAgentDirect(room) &&
			rooms.activeMembers(room).length > 1 &&
			!this.activeCall &&
			!this.startingRoomId &&
			!this.prejoin
		);
	}

	async startAudioCall(room: Room): Promise<void> {
		this.openStartPrejoin(room, 'audio');
	}

	async startVideoCall(room: Room): Promise<void> {
		this.openStartPrejoin(room, 'video');
	}

	openStartPrejoin(room: Room, callType: CallType): void {
		if (!this.canStart(room)) return;
		this.openPrejoin({ mode: 'start', callType, room });
	}

	openAcceptPrejoin(call: Call): void {
		if (this.activeCall && this.activeCall.callId !== call.callId) {
			toasts.info('Leave the current call before joining another.');
			return;
		}
		this.openPrejoin({ mode: 'accept', callType: call.callType, call });
	}

	cancelPrejoin(): void {
		this.stopPrejoinPreview();
		this.prejoin = null;
		this.prejoinBusy = false;
		this.prejoinError = null;
		this.deviceError = null;
	}

	async confirmPrejoin(): Promise<void> {
		const prejoin = this.prejoin;
		if (!prejoin || this.prejoinBusy) return;
		this.prejoinBusy = true;
		this.prejoinError = null;
		this.lastError = null;
		const options: ConnectMediaOptions = {
			audioInputId: this.prejoinAudioInputId || undefined,
			audioOutputId: this.prejoinAudioOutputId || undefined,
			videoInputId: this.prejoinVideoInputId || undefined,
			startWithCamera: prejoin.callType === 'video' && this.prejoinCameraEnabled
		};
		try {
			this.saveDevicePreferences({
				audioInputId: options.audioInputId,
				audioOutputId: options.audioOutputId,
				videoInputId: options.videoInputId
			});
			await this.ensureMicrophonePermission(options.audioInputId);
			this.cancelPendingPrejoinPreview();
			this.releasePrejoinPreview();
			const connected =
				prejoin.mode === 'start' && prejoin.room
					? await this.startCall(prejoin.room, prejoin.callType, options)
					: prejoin.call
						? await this.joinCall(prejoin.call, options)
						: false;
			if (connected) {
				this.prejoin = null;
				this.prejoinError = null;
			} else {
				this.prejoinCameraEnabled = false;
				this.prejoinError = this.lastError ?? 'Could not connect call media.';
			}
		} catch (error) {
			this.prejoinCameraEnabled = false;
			this.mediaState = this.activeCall ? this.mediaState : 'idle';
			this.prejoinError = displayError(error, 'Microphone permission is required to join the call.');
			toasts.error(this.prejoinError);
		} finally {
			this.prejoinBusy = false;
		}
	}

	async refreshCallDevices(options: { quiet?: boolean } = {}): Promise<void> {
		if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
		if (!options.quiet) this.deviceLoading = true;
		this.deviceError = null;
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			this.deviceOptions = mapMediaDeviceOptions(devices);
			this.prejoinAudioInputId = availableDeviceId(this.prejoinAudioInputId || this.devicePreferences.audioInputId, this.microphones);
			this.prejoinAudioOutputId = availableDeviceId(
				this.prejoinAudioOutputId || this.devicePreferences.audioOutputId,
				this.speakers
			);
			this.prejoinVideoInputId = availableDeviceId(this.prejoinVideoInputId || this.devicePreferences.videoInputId, this.cameras);
			if (!this.activeAudioInputId) this.activeAudioInputId = availableDeviceId(this.devicePreferences.audioInputId, this.microphones);
			if (!this.activeVideoInputId) this.activeVideoInputId = availableDeviceId(this.devicePreferences.videoInputId, this.cameras);
		} catch (error) {
			this.deviceError = displayError(error, 'Could not load media devices.');
		} finally {
			this.deviceLoading = false;
		}
	}

	setPrejoinAudioInput(deviceId: string): void {
		this.prejoinAudioInputId = deviceId;
		this.saveDevicePreferences({ audioInputId: deviceId || undefined });
	}

	async setPrejoinVideoInput(deviceId: string): Promise<void> {
		this.prejoinVideoInputId = deviceId;
		this.saveDevicePreferences({ videoInputId: deviceId || undefined });
		if (this.prejoinCameraEnabled) await this.startPrejoinPreview();
	}

	async setPrejoinAudioOutput(deviceId: string): Promise<void> {
		this.prejoinAudioOutputId = deviceId;
		this.saveDevicePreferences({ audioOutputId: deviceId || undefined });
		await this.applyAudioOutputToAll();
	}

	async setPrejoinCameraEnabled(enabled: boolean): Promise<void> {
		if (!this.prejoin || this.prejoin.callType !== 'video' || this.prejoinBusy) return;
		if (!enabled) {
			this.stopPrejoinPreview();
			return;
		}
		await this.startPrejoinPreview();
	}

	async setActiveAudioInput(deviceId: string): Promise<void> {
		if (!this.localStream || !this.audioSender || this.mediaState !== 'active') return;
		const previousId = this.activeAudioInputId;
		let nextTrack: MediaStreamTrack | null = null;
		try {
			const nextStream = await navigator.mediaDevices.getUserMedia({
				audio: audioConstraints(deviceId || undefined),
				video: false
			});
			nextTrack = nextStream.getAudioTracks()[0] ?? null;
			if (!nextTrack) {
				for (const track of nextStream.getTracks()) track.stop();
				throw new Error('Selected microphone did not provide an audio track.');
			}
			const previousTrack = this.localStream.getAudioTracks()[0];
			nextTrack.enabled = !this.muted;
			await this.audioSender.replaceTrack(nextTrack);
			if (previousTrack) {
				previousTrack.stop();
				this.localStream.removeTrack(previousTrack);
			}
			this.localStream.addTrack(nextTrack);
			this.activeAudioInputId = deviceId;
			this.saveDevicePreferences({ audioInputId: deviceId || undefined });
		} catch (error) {
			nextTrack?.stop();
			this.activeAudioInputId = previousId;
			toasts.error(displayError(error, 'Could not switch microphone.'));
		}
	}

	async setActiveVideoInput(deviceId: string): Promise<void> {
		const previousId = this.activeVideoInputId;
		this.activeVideoInputId = deviceId;
		this.saveDevicePreferences({ videoInputId: deviceId || undefined });
		if (!this.cameraEnabled) return;
		try {
			await this.replaceCameraTrack(this.cameraFacingMode, deviceId || undefined);
			await this.syncParticipantMediaState({ videoEnabled: true });
		} catch (error) {
			this.activeVideoInputId = previousId;
			this.saveDevicePreferences({ videoInputId: previousId || undefined });
			toasts.error(displayError(error, 'Could not switch camera.'));
		}
	}

	async setAudioOutputDevice(deviceId: string): Promise<void> {
		this.saveDevicePreferences({ audioOutputId: deviceId || undefined });
		this.prejoinAudioOutputId = deviceId;
		await this.applyAudioOutputToAll();
	}

	toggleCallDevicePanel(): void {
		this.callDevicePanelOpen = !this.callDevicePanelOpen;
		if (this.callDevicePanelOpen) void this.refreshCallDevices({ quiet: true });
	}

	attachRemoteAudio = (node: HTMLMediaElement) => {
		this.remoteAudioElements.add(node);
		void this.applyAudioOutput(node);
		return {
			destroy: () => {
				this.remoteAudioElements.delete(node);
			}
		};
	};

	private openPrejoin(prejoin: CallPrejoinState): void {
		if (!hasMediaSupport()) {
			this.mediaState = 'unavailable';
			this.lastError = 'Calls are not available in this browser.';
			toasts.error(this.lastError);
			return;
		}
		this.stopPrejoinPreview();
		this.prejoin = prejoin;
		this.prejoinAudioInputId = this.devicePreferences.audioInputId ?? '';
		this.prejoinAudioOutputId = this.devicePreferences.audioOutputId ?? '';
		this.prejoinVideoInputId = this.devicePreferences.videoInputId ?? '';
		this.prejoinBusy = false;
		this.prejoinError = null;
		this.deviceError = null;
		void this.refreshCallDevices({ quiet: true });
	}

	private async ensureMicrophonePermission(deviceId?: string): Promise<void> {
		if (!hasMediaSupport()) throw new Error('Calls are not available in this browser.');
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: audioConstraints(deviceId),
			video: false
		});
		try {
			if (!stream.getAudioTracks()[0]) throw new Error('Microphone did not provide an audio track.');
		} finally {
			for (const track of stream.getTracks()) track.stop();
		}
		await this.refreshCallDevices({ quiet: true });
	}

	private async startPrejoinPreview(): Promise<void> {
		const prejoin = this.prejoin;
		if (!prejoin || prejoin.callType !== 'video') return;
		const requestId = ++this.prejoinPreviewRequestId;
		this.releasePrejoinPreview();
		this.prejoinError = null;
		let stream: MediaStream | null = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: videoConstraints(this.cameraFacingMode, this.prejoinVideoInputId || undefined)
			});
			if (!stream.getVideoTracks()[0]) throw new Error('Camera did not provide a video track.');
			if (requestId !== this.prejoinPreviewRequestId || this.prejoin !== prejoin) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			this.prejoinPreviewStream = stream;
			this.prejoinCameraEnabled = true;
			await this.refreshCallDevices({ quiet: true });
		} catch (error) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			if (requestId !== this.prejoinPreviewRequestId || this.prejoin !== prejoin) return;
			this.releasePrejoinPreview();
			this.prejoinCameraEnabled = false;
			this.prejoinError = displayError(error, 'Could not start camera preview.');
			toasts.error(this.prejoinError);
		}
	}

	private releasePrejoinPreview(): void {
		for (const track of this.prejoinPreviewStream?.getTracks() ?? []) track.stop();
		this.prejoinPreviewStream = null;
	}

	private stopPrejoinPreview(): void {
		this.cancelPendingPrejoinPreview();
		this.releasePrejoinPreview();
		this.prejoinCameraEnabled = false;
	}

	private cancelPendingPrejoinPreview(): void {
		this.prejoinPreviewRequestId += 1;
	}

	private loadDevicePreferences(): void {
		if (typeof localStorage === 'undefined') return;
		try {
			const parsed = JSON.parse(localStorage.getItem(CALL_DEVICE_PREFERENCES_KEY) ?? '{}') as CallDevicePreferences;
			this.devicePreferences = cleanDevicePreferences(parsed);
		} catch {
			this.devicePreferences = {};
		}
	}

	private saveDevicePreferences(next: Partial<CallDevicePreferences>): void {
		const preferences = cleanDevicePreferences({ ...this.devicePreferences, ...next });
		this.devicePreferences = preferences;
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(CALL_DEVICE_PREFERENCES_KEY, JSON.stringify(preferences));
		} catch {
			/* local preferences are best effort */
		}
	}

	private loadVideoQualityPreference(): void {
		if (typeof localStorage === 'undefined') return;
		const value = localStorage.getItem(CALL_VIDEO_QUALITY_KEY);
		if (isVideoQualityPreference(value)) this.videoQualityPreference = value;
	}

	private saveVideoQualityPreference(preference: CallVideoQualityPreference): void {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(CALL_VIDEO_QUALITY_KEY, preference);
		} catch {
			/* local preferences are best effort */
		}
	}

	private async applyAudioOutputToAll(): Promise<void> {
		await Promise.all([...this.remoteAudioElements].map((element) => this.applyAudioOutput(element)));
	}

	private async applyAudioOutput(node: HTMLMediaElement): Promise<void> {
		if (!this.audioOutputSupported) return;
		const setSinkId = (node as SinkIdMediaElement).setSinkId;
		if (!setSinkId) return;
		try {
			await setSinkId.call(node, this.devicePreferences.audioOutputId ?? '');
		} catch (error) {
			this.deviceError = displayError(error, 'Could not switch speaker output.');
		}
	}

	private updateVideoOrientation(): void {
		if (typeof window === 'undefined') return;
		this.videoOrientation = window.matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait';
	}

	private async closePublishedTrack(mid: string): Promise<void> {
		const callId = this.mediaCallId;
		const sessionId = this.sessionId;
		if (!callId || !sessionId) return;
		try {
			await api.closeCallRealtimeTracks(callId, {
				sessionId,
				tracks: [{ mid }],
				force: true
			});
			this.publishedMids.delete(mid);
		} catch {
			/* the full call teardown will retry closing any remaining published mids */
		}
	}

	private async startCall(room: Room, callType: CallType, options: ConnectMediaOptions = {}): Promise<boolean> {
		if (!this.canStart(room) && this.prejoin?.room?.roomId !== room.roomId) return false;
		this.startingRoomId = room.roomId;
		this.startingCallType = callType;
		this.lastError = null;
		this.mediaState = 'connecting';
		try {
			const call = await api.createCall(room.roomId, { callType });
			this.activeCall = call;
			this.activeRoom = room;
			this.upsertRoomHistory(call);
			this.muted = false;
			this.cameraEnabled = false;
			const connected = await this.connectMedia(call, options);
			if (!connected) {
				await this.leaveCallQuietly(call.callId);
				this.clearActiveCall();
				return false;
			}
			return true;
		} catch (error) {
			this.mediaState = 'error';
			this.lastError = displayError(error, `Could not start the ${callType} call.`);
			toasts.error(this.lastError);
			return false;
		} finally {
			this.startingRoomId = null;
			this.startingCallType = null;
		}
	}

	async acceptCall(call: Call): Promise<void> {
		this.openAcceptPrejoin(call);
	}

	private async joinCall(call: Call, options: ConnectMediaOptions = {}): Promise<boolean> {
		if (this.activeCall && this.activeCall.callId !== call.callId) {
			toasts.info('Leave the current call before joining another.');
			return false;
		}
		this.busyCallId = call.callId;
		this.lastError = null;
		this.mediaState = 'connecting';
		try {
			const joined = await api.joinCall(call.callId);
			this.removeIncoming(call.callId);
			this.activeCall = joined;
			this.activeRoom = rooms.get(joined.roomId) ?? this.activeRoom;
			this.upsertRoomHistory(joined);
			this.muted = false;
			this.cameraEnabled = false;
			const connected = await this.connectMedia(joined, options);
			if (!connected) {
				await this.leaveCallQuietly(joined.callId);
				this.clearActiveCall();
				return false;
			}
			return true;
		} catch (error) {
			this.mediaState = 'error';
			this.lastError = displayError(error, 'Could not join the call.');
			toasts.error(this.lastError);
			return false;
		} finally {
			this.busyCallId = null;
		}
	}

	async declineCall(callId: string): Promise<void> {
		this.busyCallId = callId;
		try {
			const call = await api.declineCall(callId);
			this.upsertRoomHistory(call);
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
			const left = await api.leaveCall(call.callId);
			this.upsertRoomHistory(left);
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
			this.upsertRoomHistory(updated);
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
		const previousDeviceId = this.activeVideoInputId;
		const next: CameraFacingMode = previous === 'user' ? 'environment' : 'user';
		this.cameraFacingMode = next;
		this.activeVideoInputId = '';
		if (!this.cameraEnabled) return;
		this.switchingCamera = true;
		try {
			await this.replaceCameraTrack(next);
		} catch (error) {
			this.cameraFacingMode = previous;
			this.activeVideoInputId = previousDeviceId;
			toasts.error(displayError(error, 'Could not switch camera.'));
		} finally {
			this.switchingCamera = false;
		}
	}

	async toggleScreenShare(): Promise<void> {
		if (this.activeCall?.callType !== 'video' || this.mediaState !== 'active' || this.startingScreenShare) return;
		if (!this.screenShareAvailable) {
			toasts.error('Screen sharing is not available for this environment.');
			return;
		}
		if (this.screenShareEnabled || this.localScreenStream) {
			await this.stopScreenShare();
			return;
		}
		await this.startScreenShare();
	}

	async stopScreenShare(options: { notifyOnError?: boolean } = {}): Promise<void> {
		const notifyOnError = options.notifyOnError ?? true;
		const mid = this.screenTrackMid;
		const stream = this.localScreenStream;
		this.screenShareEnabled = false;
		this.localScreenStream = null;
		this.screenTrackMid = null;
		for (const track of stream?.getTracks() ?? []) {
			track.onended = null;
			track.stop();
		}
		try {
			await this.screenSender?.replaceTrack(null);
		} catch (error) {
			if (notifyOnError) toasts.error(displayError(error, 'Could not stop screen sharing.'));
		}
		this.screenSender = null;
		if (mid) await this.closePublishedTrack(mid);
		void this.syncParticipantMediaState({ screenEnabled: false });
	}

	setVideoQualityPreference(preference: string): void {
		if (!isVideoQualityPreference(preference)) return;
		this.videoQualityPreference = preference;
		this.saveVideoQualityPreference(preference);
		if (this.mediaState === 'active') void this.refreshAvailableTracks();
	}

	setFeaturedVideo(videoId: string | null): void {
		this.featuredVideoId = videoId;
	}

	setVideoSurfaceExpanded(expanded: boolean): void {
		this.videoSurfaceExpanded = expanded;
	}

	toggleVideoSurfaceExpanded(): void {
		this.videoSurfaceExpanded = !this.videoSurfaceExpanded;
	}

	async handleRealtimeEvent(event: RealtimeCallEvent): Promise<void> {
		void this.loadRoomHistory(event.roomId, { quiet: true });
		if (event.type === 'call.signal') {
			await this.handleP2pSignal(event);
			return;
		}
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
				if (this.mediaProvider === 'p2p_webrtc') await this.maybeStartP2pNegotiation();
				else await this.refreshAvailableTracks();
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
						const connected = await this.connectMedia(call);
						if (!connected && this.activeCall?.callId === call.callId) {
							await this.leaveCallQuietly(call.callId);
							this.clearActiveCall();
						}
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

	roomCalls(roomId: string): Call[] {
		return this.roomHistory[roomId] ?? [];
	}

	async loadRoomHistory(roomId: string, options: { quiet?: boolean } = {}): Promise<void> {
		if (!roomId) return;
		if (!options.quiet) this.loadingHistoryRoomId = roomId;
		try {
			const page = await api.listRoomCalls(roomId, { limit: CALL_HISTORY_LIMIT });
			this.roomHistory = { ...this.roomHistory, [roomId]: page.items };
		} catch {
			/* call history is opportunistic in the chat timeline */
		} finally {
			if (!options.quiet && this.loadingHistoryRoomId === roomId) {
				this.loadingHistoryRoomId = null;
			}
		}
	}

	private upsertRoomHistory(call: Call): void {
		const current = this.roomHistory[call.roomId] ?? [];
		const next = [call, ...current.filter((candidate) => candidate.callId !== call.callId)]
			.sort((a, b) => callTimeMs(b) - callTimeMs(a))
			.slice(0, CALL_HISTORY_LIMIT);
		this.roomHistory = { ...this.roomHistory, [call.roomId]: next };
	}

	private async refreshIncomingCall(callId: string): Promise<void> {
		try {
			const call = await api.getCall(callId);
			this.upsertRoomHistory(call);
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
				this.upsertRoomHistory(call);
				this.clearActiveCall();
				return;
			}
			this.activeCall = call;
			this.upsertRoomHistory(call);
			this.syncP2pRemoteMediaState();
		} catch {
			/* keep the current call until an explicit terminal event arrives */
		}
	}

	private async connectMedia(call: Call, options: ConnectMediaOptions = {}): Promise<boolean> {
		if (!hasMediaSupport()) {
			this.mediaState = 'unavailable';
			this.lastError = 'Calls are not available in this browser.';
			toasts.error(this.lastError);
			return false;
		}
		const attemptId = ++this.mediaAttemptId;
		try {
			const sessionConfig = await api.getCallRealtimeSessionConfig(call.callId);
			if (!this.isCurrentMediaAttempt(attemptId, call.callId)) return false;
			this.callFeatures = sessionConfig.features ?? { ...DEFAULT_CALL_FEATURES };
			if (!sessionConfig.configured || !sessionConfig.session?.sessionId) {
				this.mediaState = 'unavailable';
				this.lastError = sessionConfig.message;
				toasts.error(sessionConfig.message);
				return false;
			}
			if (sessionConfig.provider === 'p2p_webrtc') {
				return await this.connectP2pMedia(call, sessionConfig, options, attemptId);
			}

			const peer = new RTCPeerConnection({
				iceServers: sessionConfig.iceServers as RTCIceServer[]
			});
			this.peer = peer;
			this.sessionId = sessionConfig.session.sessionId;
			this.mediaCallId = call.callId;
			this.mediaProvider = sessionConfig.provider;
			this.resetP2pState();
			this.publishedMids = new Set();
			this.subscribedTracks = new Set();
			this.pendingRemoteVideoTracks = [];
			this.remoteStreams = [];
			this.remoteVideoStreams = [];
			this.localVideoStream = null;
			this.localScreenStream = null;
			this.audioSender = null;
			this.videoSender = null;
			this.videoTransceiver = null;
			this.cameraEnabled = false;
			this.screenShareEnabled = false;
			this.screenSender = null;
			this.screenTrackMid = null;
			this.peerConnectionState = peer.connectionState;
			this.iceConnectionState = peer.iceConnectionState;
			this.iceGatheringState = peer.iceGatheringState;
			this.signalingState = peer.signalingState;
			this.mediaStartedAt = null;
			this.usageReportSent = false;
			this.diagnostics = {
				...EMPTY_CALL_DIAGNOSTICS,
				callId: call.callId,
				sessionId: sessionConfig.session.sessionId,
				peerConnectionState: peer.connectionState,
				iceConnectionState: peer.iceConnectionState,
				iceGatheringState: peer.iceGatheringState,
				signalingState: peer.signalingState
			};
			this.activeAudioInputId = options.audioInputId ?? this.devicePreferences.audioInputId ?? '';
			this.activeVideoInputId = options.videoInputId ?? this.devicePreferences.videoInputId ?? '';
			this.wirePeer(peer);

			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: audioConstraints(this.activeAudioInputId || undefined),
				video:
					call.callType === 'video' && options.startWithCamera
						? videoConstraints(this.cameraFacingMode, this.activeVideoInputId || undefined)
						: false
			});
			if (!this.isCurrentMediaAttempt(attemptId, call.callId)) {
				await this.closeMedia({ notifyProvider: false });
				return false;
			}
			const audioTrack = this.localStream.getAudioTracks()[0];
			if (!audioTrack) throw new Error('Microphone did not provide an audio track.');
			const publishTracks: CallRealtimeTrackInput[] = [];
			const publishMids: Array<string | null> = [];
			const audioTransceiver = peer.addTransceiver(audioTrack, {
				direction: 'sendonly',
				streams: [this.localStream]
			});
			this.audioSender = audioTransceiver.sender;
			publishMids.push(audioTransceiver.mid);
			publishTracks.push({
				location: 'local',
				trackName: localTrackName(call, 'audio'),
				kind: 'audio',
				mid: audioTransceiver.mid
			});

			if (call.callType === 'video' && options.startWithCamera) {
				const videoTrack = this.localStream.getVideoTracks()[0];
				if (!videoTrack) throw new Error('Camera did not provide a video track.');
				const videoTransceiver = addCameraTransceiver(peer, videoTrack, this.localStream);
				this.videoTransceiver = videoTransceiver;
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
			if (!this.isCurrentMediaAttempt(attemptId, call.callId)) {
				await this.closeMedia({ notifyProvider: false });
				return false;
			}
			const trackConfig = await api.getCallRealtimeTrackConfig(call.callId, {
				sessionId: this.sessionId,
				sessionDescription: offer,
				tracks: publishTracks
			});
			if (!this.isCurrentMediaAttempt(attemptId, call.callId)) {
				await this.closeMedia({ notifyProvider: false });
				return false;
			}
			this.publishedMids = publishedTrackMids(trackConfig, publishMids);
			await this.applyProviderDescription(trackConfig);
			this.mediaState = 'active';
			this.mediaStartedAt = Date.now();
			await this.syncParticipantMediaState();
			this.startMediaHeartbeat();
			this.startStatsHeartbeat();
			await this.refreshCallStats();
			await this.applyAudioOutputToAll();
			await this.subscribeAvailableTracks([
				...(sessionConfig.availableTracks ?? sessionConfig.tracks ?? []),
				...(trackConfig.availableTracks ?? [])
			]);
			return true;
		} catch (error) {
			await this.closeMedia();
			this.mediaState = 'error';
			this.lastError = displayError(error, 'Could not connect call media.');
			toasts.error(this.lastError);
			return false;
		}
	}

	private async connectP2pMedia(
		call: Call,
		sessionConfig: CallRealtimeConfig,
		options: ConnectMediaOptions,
		attemptId: number
	): Promise<boolean> {
		const sessionId = sessionConfig.session?.sessionId;
		if (!sessionId) return false;
		const peer = new RTCPeerConnection({
			iceServers: sessionConfig.iceServers as RTCIceServer[]
		});
		this.peer = peer;
		this.sessionId = sessionId;
		this.mediaCallId = call.callId;
		this.mediaProvider = 'p2p_webrtc';
		this.resetP2pState({ keepPendingSignals: true });
		this.p2pPolite = this.isP2pPolite(call);
		this.publishedMids = new Set();
		this.subscribedTracks = new Set();
		this.pendingRemoteVideoTracks = [];
		this.remoteStreams = [];
		this.remoteVideoStreams = [];
		this.localVideoStream = null;
		this.localScreenStream = null;
		this.audioSender = null;
		this.videoSender = null;
		this.videoTransceiver = null;
		this.cameraEnabled = false;
		this.screenShareEnabled = false;
		this.screenSender = null;
		this.screenTrackMid = null;
		this.peerConnectionState = peer.connectionState;
		this.iceConnectionState = peer.iceConnectionState;
		this.iceGatheringState = peer.iceGatheringState;
		this.signalingState = peer.signalingState;
		this.mediaStartedAt = null;
		this.usageReportSent = false;
		this.diagnostics = {
			...EMPTY_CALL_DIAGNOSTICS,
			callId: call.callId,
			sessionId,
			peerConnectionState: peer.connectionState,
			iceConnectionState: peer.iceConnectionState,
			iceGatheringState: peer.iceGatheringState,
			signalingState: peer.signalingState
		};
		this.activeAudioInputId = options.audioInputId ?? this.devicePreferences.audioInputId ?? '';
		this.activeVideoInputId = options.videoInputId ?? this.devicePreferences.videoInputId ?? '';
		this.wirePeer(peer);

		this.localStream = await navigator.mediaDevices.getUserMedia({
			audio: audioConstraints(this.activeAudioInputId || undefined),
			video:
				call.callType === 'video' && options.startWithCamera
					? videoConstraints(this.cameraFacingMode, this.activeVideoInputId || undefined)
					: false
		});
		if (!this.isCurrentMediaAttempt(attemptId, call.callId)) {
			await this.closeMedia({ notifyProvider: false });
			return false;
		}
		const audioTrack = this.localStream.getAudioTracks()[0];
		if (!audioTrack) throw new Error('Microphone did not provide an audio track.');
		const publishTracks: CallRealtimeTrackInput[] = [];
		const publishMids: Array<string | null> = [];
		const audioTransceiver = peer.addTransceiver(audioTrack, {
			direction: 'sendrecv',
			streams: [this.localStream]
		});
		this.audioSender = audioTransceiver.sender;
		publishMids.push(audioTransceiver.mid ?? 'audio');
		publishTracks.push({
			location: 'local',
			trackName: localTrackName(call, 'audio'),
			kind: 'audio',
			mid: audioTransceiver.mid ?? 'audio'
		});

		if (call.callType === 'video' && options.startWithCamera) {
			const videoTrack = this.localStream.getVideoTracks()[0];
			if (!videoTrack) throw new Error('Camera did not provide a video track.');
			const videoTransceiver = addCameraTransceiver(peer, videoTrack, this.localStream);
			this.videoTransceiver = videoTransceiver;
			this.videoSender = videoTransceiver.sender;
			publishMids.push(videoTransceiver.mid ?? 'video');
			publishTracks.push({
				location: 'local',
				trackName: localTrackName(call, 'video'),
				kind: 'video',
				mid: videoTransceiver.mid ?? 'video'
			});
			this.cameraEnabled = true;
			this.updateLocalVideoStream();
		}

		const trackConfig = await api.getCallRealtimeTrackConfig(call.callId, {
			sessionId,
			tracks: publishTracks
		});
		if (!this.isCurrentMediaAttempt(attemptId, call.callId)) {
			await this.closeMedia({ notifyProvider: false });
			return false;
		}
		this.publishedMids = publishedTrackMids(trackConfig, publishMids);
		this.mediaState = 'active';
		this.mediaStartedAt = Date.now();
		await this.syncParticipantMediaState();
		this.startMediaHeartbeat();
		this.startStatsHeartbeat();
		await this.refreshCallStats();
		await this.applyAudioOutputToAll();
		await this.maybeStartP2pNegotiation();
		await this.drainPendingP2pSignals();
		return true;
	}

	private wirePeer(peer: RTCPeerConnection): void {
		const updateConnectionState = () => {
			this.peerConnectionState = peer.connectionState;
			this.iceConnectionState = peer.iceConnectionState;
			this.iceGatheringState = peer.iceGatheringState;
			this.signalingState = peer.signalingState;
			this.diagnostics = {
				...this.diagnostics,
				peerConnectionState: peer.connectionState,
				iceConnectionState: peer.iceConnectionState,
				iceGatheringState: peer.iceGatheringState,
				signalingState: peer.signalingState
			};
		};
		updateConnectionState();
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
			updateConnectionState();
			if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
				this.lastError = 'Call media connection was interrupted.';
			}
			this.handleP2pConnectionStateChange(peer);
		};
		peer.onicecandidate = (event) => {
			if (this.mediaProvider !== 'p2p_webrtc' || !event.candidate) return;
			void this.sendP2pSignal('ice-candidate', {
				candidate: iceCandidate(event.candidate)
			}).catch(() => undefined);
		};
		peer.onnegotiationneeded = () => {
			if (this.mediaProvider !== 'p2p_webrtc') return;
			if (this.p2pPolite && !this.p2pInitialNegotiationComplete) return;
			void this.createAndSendP2pOffer();
		};
		peer.oniceconnectionstatechange = () => {
			updateConnectionState();
			this.handleP2pConnectionStateChange(peer);
		};
		peer.onicegatheringstatechange = updateConnectionState;
		peer.onsignalingstatechange = updateConnectionState;
	}

	private async refreshAvailableTracks(): Promise<void> {
		if (!this.activeCall || !this.sessionId || this.mediaState !== 'active') return;
		if (this.mediaProvider === 'p2p_webrtc') {
			await this.maybeStartP2pNegotiation();
			return;
		}
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
		if (this.mediaProvider === 'p2p_webrtc') return;
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
					simulcast: isVideoTrackKind(track.kind) ? remoteVideoSimulcastPolicy(this.videoQualityPreference) : undefined
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
		if (this.mediaProvider === 'p2p_webrtc') return;
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

	private handleP2pConnectionStateChange(peer: RTCPeerConnection): void {
		if (peer !== this.peer || this.mediaProvider !== 'p2p_webrtc') return;
		if (
			peer.connectionState === 'connected' ||
			peer.iceConnectionState === 'connected' ||
			peer.iceConnectionState === 'completed'
		) {
			this.clearP2pIceRestartTimer();
			this.p2pIceRestartAttempts = 0;
			this.p2pRecoveryNotified = false;
			if (this.mediaState === 'error') this.mediaState = 'active';
			if (this.lastError === 'Call media connection was interrupted.' || this.lastError === 'Reconnecting call media.') {
				this.lastError = null;
			}
			return;
		}
		if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') {
			this.scheduleP2pIceRestart('failed', 0);
			return;
		}
		if (peer.connectionState === 'disconnected' || peer.iceConnectionState === 'disconnected') {
			this.scheduleP2pIceRestart('disconnected', P2P_DISCONNECTED_GRACE_MS);
		}
	}

	private scheduleP2pIceRestart(reason: 'failed' | 'disconnected', delayMs: number): void {
		if (!this.peer || !this.activeCall || !this.sessionId || this.mediaProvider !== 'p2p_webrtc') return;
		if (this.mediaState === 'ending' || this.mediaState === 'error' || this.peer.connectionState === 'closed') return;
		if (this.p2pIceRestartTimer) return;
		this.lastError = reason === 'failed' ? 'Reconnecting call media.' : 'Call media connection was interrupted.';
		this.p2pIceRestartTimer = setTimeout(() => {
			this.p2pIceRestartTimer = null;
			void this.attemptP2pIceRestart();
		}, delayMs);
	}

	private async attemptP2pIceRestart(): Promise<void> {
		const peer = this.peer;
		if (!peer || !this.activeCall || !this.sessionId || this.mediaProvider !== 'p2p_webrtc') return;
		if (
			peer.connectionState === 'connected' ||
			peer.iceConnectionState === 'connected' ||
			peer.iceConnectionState === 'completed'
		) {
			this.p2pIceRestartAttempts = 0;
			this.p2pRecoveryNotified = false;
			return;
		}
		if (this.p2pIceRestartAttempts >= P2P_ICE_RESTART_MAX_ATTEMPTS) {
			this.mediaState = 'error';
			this.lastError = 'Could not reconnect call media. Leave and rejoin the call to try again.';
			if (!this.p2pRecoveryNotified) {
				this.p2pRecoveryNotified = true;
				toasts.error(this.lastError);
			}
			return;
		}
		this.p2pIceRestartAttempts += 1;
		this.lastError = 'Reconnecting call media.';
		const sent = await this.createAndSendP2pOffer({ iceRestart: true });
		if (!sent && this.peer === peer && this.mediaProvider === 'p2p_webrtc') {
			this.scheduleP2pIceRestart('failed', P2P_ICE_RESTART_DELAY_MS);
		} else if (this.peer === peer && this.mediaProvider === 'p2p_webrtc') {
			this.scheduleP2pIceRestart('failed', P2P_ICE_RESTART_SETTLE_MS);
		}
	}

	private clearP2pIceRestartTimer(): void {
		if (this.p2pIceRestartTimer) clearTimeout(this.p2pIceRestartTimer);
		this.p2pIceRestartTimer = null;
	}

	private syncP2pRemoteMediaState(): void {
		if (this.mediaProvider !== 'p2p_webrtc' || !this.activeCall) return;
		const principalId = auth.principal?.principalId;
		const remoteParticipant = this.activeCall.participants.find(
			(participant) => participant.status === 'connected' && participant.principalId !== principalId
		);
		if (!remoteParticipant) return;
		if (!remoteParticipant.videoEnabled) {
			const removedIds = new Set(this.remoteVideoStreams.filter((stream) => stream.kind === 'video').map((stream) => stream.id));
			this.remoteVideoStreams = this.remoteVideoStreams.filter((stream) => stream.kind !== 'video');
			if (this.featuredVideoId && removedIds.has(this.featuredVideoId)) {
				this.featuredVideoId = null;
			}
		}
		if (!remoteParticipant.screenEnabled) {
			const removedIds = new Set(this.remoteVideoStreams.filter((stream) => stream.kind === 'screen').map((stream) => stream.id));
			this.remoteVideoStreams = this.remoteVideoStreams.filter((stream) => stream.kind !== 'screen');
			if (this.featuredVideoId && removedIds.has(this.featuredVideoId)) {
				this.featuredVideoId = null;
			}
		}
	}

	private async handleP2pSignal(event: CallSignalEvent): Promise<void> {
		if (event.callId !== this.activeCall?.callId) return;
		if (event.fromPrincipalId === auth.principal?.principalId) return;
		if (event.toPrincipalId !== auth.principal?.principalId) return;
		if (event.toDeviceId && event.toDeviceId !== auth.device?.deviceId) return;
		if (event.callId !== this.mediaCallId || this.mediaProvider !== 'p2p_webrtc' || !this.peer) {
			this.pendingP2pSignals = [...this.pendingP2pSignals, event].slice(-50);
			return;
		}
		if (event.fromDeviceId) {
			this.p2pTarget = {
				principalId: event.fromPrincipalId,
				deviceId: event.fromDeviceId
			};
		}
		if (event.signalType === 'ready') {
			await this.maybeStartP2pNegotiation();
			return;
		}
		if (event.signalType === 'hangup') return;
		if (event.signalType === 'ice-candidate') {
			await this.handleP2pCandidate(event.candidate);
			return;
		}
		if (event.signalType === 'renegotiate' || event.signalType === 'ice-restart') {
			await this.createAndSendP2pOffer({ iceRestart: event.signalType === 'ice-restart' });
			return;
		}
		if (!event.description) return;
		await this.handleP2pDescription(event.description);
	}

	private async handleP2pDescription(description: CallRealtimeSessionDescription): Promise<void> {
		const peer = this.peer;
		if (!peer || this.mediaProvider !== 'p2p_webrtc') return;
		try {
			const readyForOffer =
				!this.p2pMakingOffer && (peer.signalingState === 'stable' || this.p2pSettingRemoteAnswerPending);
			const offerCollision = description.type === 'offer' && !readyForOffer;
			this.p2pIgnoreOffer = !this.p2pPolite && offerCollision;
			if (this.p2pIgnoreOffer) return;
			this.p2pSettingRemoteAnswerPending = description.type === 'answer';
			await peer.setRemoteDescription(description);
			this.p2pSettingRemoteAnswerPending = false;
			await this.flushP2pCandidates();
			if (description.type === 'offer') {
				const answer = await createP2pAnswer(peer);
				await this.sendP2pSignal('answer', { description: answer });
				this.p2pInitialNegotiationComplete = true;
			} else {
				this.p2pInitialNegotiationComplete = true;
			}
		} catch (error) {
			this.p2pSettingRemoteAnswerPending = false;
			if (!this.p2pIgnoreOffer) {
				this.lastError = displayError(error, 'Could not apply call signal.');
			}
		}
	}

	private async handleP2pCandidate(candidate: CallIceCandidate | undefined): Promise<void> {
		if (!candidate || !this.peer) return;
		if (!this.peer.remoteDescription) {
			this.p2pPendingCandidates = [...this.p2pPendingCandidates, candidate].slice(-100);
			return;
		}
		try {
			await this.peer.addIceCandidate(candidate);
		} catch (error) {
			if (!this.p2pIgnoreOffer) this.lastError = displayError(error, 'Could not apply call network candidate.');
		}
	}

	private async flushP2pCandidates(): Promise<void> {
		const peer = this.peer;
		if (!peer || !peer.remoteDescription || !this.p2pPendingCandidates.length) return;
		const candidates = this.p2pPendingCandidates;
		this.p2pPendingCandidates = [];
		for (const candidate of candidates) {
			await peer.addIceCandidate(candidate).catch((error) => {
				if (!this.p2pIgnoreOffer) this.lastError = displayError(error, 'Could not apply call network candidate.');
			});
		}
	}

	private async maybeStartP2pNegotiation(): Promise<void> {
		if (!this.peer || !this.activeCall || !this.sessionId || this.mediaProvider !== 'p2p_webrtc') return;
		const target = this.p2pTargetParticipant() ?? this.p2pTarget;
		if (!target) return;
		this.p2pTarget = target;
		const targetKey = p2pTargetKey(target);
		if (this.p2pReadyTargetKey !== targetKey) {
			this.p2pReadyTargetKey = targetKey;
			await this.sendP2pSignal('ready').catch(() => {
				this.p2pReadyTargetKey = null;
			});
		}
		if (!this.p2pPolite && !this.p2pInitialOfferSent) {
			await this.createAndSendP2pOffer();
		}
	}

	private async drainPendingP2pSignals(): Promise<void> {
		if (!this.pendingP2pSignals.length) return;
		const signals = this.pendingP2pSignals;
		this.pendingP2pSignals = [];
		for (const signal of signals) await this.handleP2pSignal(signal);
	}

	private async createAndSendP2pOffer(options: { iceRestart?: boolean } = {}): Promise<boolean> {
		const peer = this.peer;
		if (!peer || this.mediaProvider !== 'p2p_webrtc' || !this.activeCall || !this.sessionId) return false;
		if (!this.p2pTarget && !this.p2pTargetParticipant()) return false;
		if (this.p2pMakingOffer || peer.signalingState !== 'stable') return false;
		try {
			this.p2pMakingOffer = true;
			const offer = await createP2pOffer(peer, options);
			await this.sendP2pSignal('offer', { description: offer });
			this.p2pInitialOfferSent = true;
			return true;
		} catch (error) {
			await peer.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
			this.lastError = displayError(error, 'Could not negotiate call media.');
			return false;
		} finally {
			this.p2pMakingOffer = false;
		}
	}

	private async sendP2pSignal(
		type: CallSignalType,
		payload: {
			description?: CallRealtimeSessionDescription;
			candidate?: CallIceCandidate;
		} = {}
	): Promise<boolean> {
		const call = this.activeCall;
		const target = this.p2pTarget ?? this.p2pTargetParticipant();
		if (!call || !target) return false;
		this.p2pTarget = target;
		await api.sendCallSignal(call.callId, {
			signalId: cryptoId('sig'),
			targetPrincipalId: target.principalId,
			targetDeviceId: target.deviceId,
			sessionId: this.sessionId ?? undefined,
			type,
			...payload,
			sequence: ++this.p2pSignalSequence
		});
		return true;
	}

	private p2pTargetParticipant(): P2pSignalTarget | null {
		const principalId = auth.principal?.principalId;
		const call = this.activeCall;
		if (!call || !principalId) return null;
		const participant = call.participants.find(
			(candidate) =>
				candidate.status === 'connected' &&
				candidate.principalId !== principalId &&
				!!candidate.deviceId
		);
		return participant?.deviceId
			? {
					principalId: participant.principalId,
					deviceId: participant.deviceId
				}
			: null;
	}

	private isP2pPolite(call: Call): boolean {
		const principalId = auth.principal?.principalId;
		const deviceId = auth.device?.deviceId;
		if (!principalId) return true;
		return !(
			call.createdByPrincipalId === principalId &&
			(!call.createdByDeviceId || call.createdByDeviceId === deviceId)
		);
	}

	private resetP2pState(options: { keepPendingSignals?: boolean } = {}): void {
		this.clearP2pIceRestartTimer();
		this.p2pTarget = null;
		this.p2pPolite = true;
		this.p2pMakingOffer = false;
		this.p2pSettingRemoteAnswerPending = false;
		this.p2pIgnoreOffer = false;
		this.p2pInitialOfferSent = false;
		this.p2pInitialNegotiationComplete = false;
		this.p2pReadyTargetKey = null;
		this.p2pSignalSequence = 0;
		this.p2pPendingCandidates = [];
		this.p2pIceRestartAttempts = 0;
		this.p2pRecoveryNotified = false;
		if (!options.keepPendingSignals) this.pendingP2pSignals = [];
	}

	private setLocalMuted(muted: boolean): void {
		this.muted = muted;
		for (const track of this.localStream?.getAudioTracks() ?? []) {
			track.enabled = !muted;
		}
	}

	private async setCameraEnabled(enabled: boolean, options: { notifyOnError?: boolean } = {}): Promise<void> {
		if (!this.peer || !this.localStream || !this.activeCall || !this.sessionId) return;
		const notifyOnError = options.notifyOnError ?? true;
		if (this.mediaProvider === 'p2p_webrtc') {
			await this.setP2pCameraEnabled(enabled, { notifyOnError });
			return;
		}
		if (!enabled) {
			const currentTrack = this.localStream.getVideoTracks()[0];
			try {
				await this.videoSender?.replaceTrack(null);
			} catch (error) {
				if (notifyOnError) toasts.error(displayError(error, 'Could not turn camera off.'));
			} finally {
				if (currentTrack) {
					currentTrack.stop();
					this.localStream.removeTrack(currentTrack);
				}
				this.cameraEnabled = false;
				this.updateLocalVideoStream();
				void this.syncParticipantMediaState({ videoEnabled: false });
			}
			return;
		}
		try {
			if (this.videoSender) {
				await this.replaceCameraTrack(this.cameraFacingMode, this.activeVideoInputId || undefined);
			} else {
				await this.publishCameraTrack();
			}
			this.cameraEnabled = true;
			await this.syncParticipantMediaState({ videoEnabled: true });
		} catch (error) {
			this.cameraEnabled = false;
			this.updateLocalVideoStream();
			void this.syncParticipantMediaState({ videoEnabled: false });
			if (notifyOnError) toasts.error(displayError(error, 'Could not turn camera on.'));
		}
	}

	private async setP2pCameraEnabled(enabled: boolean, options: { notifyOnError?: boolean } = {}): Promise<void> {
		if (!this.peer || !this.localStream || !this.activeCall || !this.sessionId) return;
		const notifyOnError = options.notifyOnError ?? true;
		if (!enabled) {
			const currentTrack = this.localStream.getVideoTracks()[0];
			try {
				await this.videoSender?.replaceTrack(null);
				if (this.videoTransceiver && this.videoTransceiver.direction !== 'inactive') {
					this.videoTransceiver.direction = 'inactive';
					await this.createAndSendP2pOffer();
				}
			} catch (error) {
				if (notifyOnError) toasts.error(displayError(error, 'Could not turn camera off.'));
			} finally {
				if (currentTrack) {
					currentTrack.stop();
					this.localStream.removeTrack(currentTrack);
				}
				this.cameraEnabled = false;
				this.updateLocalVideoStream();
				void this.syncParticipantMediaState({ videoEnabled: false });
			}
			return;
		}
		try {
			if (this.videoSender) {
				const needsRenegotiation = this.videoTransceiver?.direction !== 'sendonly';
				await this.replaceCameraTrack(this.cameraFacingMode, this.activeVideoInputId || undefined);
				if (this.videoTransceiver && needsRenegotiation) {
					this.videoTransceiver.direction = 'sendonly';
					const negotiated = await this.createAndSendP2pOffer();
					if (!negotiated) throw new Error('Could not negotiate camera media.');
				}
			} else {
				await this.publishP2pCameraTrack();
			}
			this.cameraEnabled = true;
			await this.syncParticipantMediaState({ videoEnabled: true });
		} catch (error) {
			await this.videoSender?.replaceTrack(null).catch(() => undefined);
			if (this.videoTransceiver) this.videoTransceiver.direction = 'inactive';
			this.stopLocalCameraTrack();
			this.cameraEnabled = false;
			void this.syncParticipantMediaState({ videoEnabled: false });
			if (notifyOnError) toasts.error(displayError(error, 'Could not turn camera on.'));
		}
	}

	private async startScreenShare(): Promise<void> {
		const call = this.activeCall;
		const sessionId = this.sessionId;
		const peer = this.peer;
		if (!peer || !call || !sessionId || !this.mediaCallId || this.startingScreenShare) return;
		if (!this.screenShareAvailable) {
			toasts.error('Screen sharing is not available on this device.');
			return;
		}
		if (this.mediaProvider === 'p2p_webrtc') {
			toasts.error('Screen sharing is not available for this call yet.');
			return;
		}
		this.startingScreenShare = true;
		let screenStream: MediaStream | null = null;
		let screenTrack: MediaStreamTrack | null = null;
		let transceiver: RTCRtpTransceiver | null = null;
		try {
			screenStream = await navigator.mediaDevices.getDisplayMedia({
				audio: false,
				video: screenShareConstraints()
			});
			screenTrack = screenStream.getVideoTracks()[0] ?? null;
			if (!screenTrack) {
				for (const track of screenStream.getTracks()) track.stop();
				throw new Error('Screen sharing did not provide a video track.');
			}
			if (this.peer !== peer || this.activeCall?.callId !== call.callId || this.sessionId !== sessionId || this.mediaState !== 'active') {
				throw new Error('The call ended before screen sharing started.');
			}
			const publishStream = new MediaStream([screenTrack]);
			transceiver = addScreenTransceiver(peer, screenTrack, publishStream);
			this.screenSender = transceiver.sender;
			this.localScreenStream = publishStream;
			this.screenShareEnabled = true;
			screenTrack.onended = () => {
				if (this.localScreenStream || this.screenShareEnabled) void this.stopScreenShare({ notifyOnError: false });
			};
			const offer = await createOffer(peer);
			const trackConfig = await api.getCallRealtimeTrackConfig(call.callId, {
				sessionId,
				sessionDescription: offer,
				tracks: [
					{
						location: 'local',
						trackName: localTrackName(call, 'screen'),
						kind: 'screen',
						mid: transceiver.mid
					}
				]
			});
			const mids = publishedTrackMids(trackConfig, [transceiver.mid]);
			this.publishedMids = new Set([...this.publishedMids, ...mids]);
			this.screenTrackMid = transceiver.mid ?? [...mids][0] ?? null;
			await this.applyProviderDescription(trackConfig);
			await this.syncParticipantMediaState({ screenEnabled: true });
		} catch (error) {
			if (transceiver) await transceiver.sender.replaceTrack(null).catch(() => undefined);
			for (const track of screenStream?.getTracks() ?? []) {
				track.onended = null;
				track.stop();
			}
			this.screenSender = null;
			this.localScreenStream = null;
			this.screenTrackMid = null;
			this.screenShareEnabled = false;
			toasts.error(displayError(error, 'Could not start screen sharing.'));
			void this.syncParticipantMediaState({ screenEnabled: false });
		} finally {
			this.startingScreenShare = false;
		}
	}

	private async publishCameraTrack(): Promise<void> {
		if (this.mediaProvider === 'p2p_webrtc') {
			await this.publishP2pCameraTrack();
			return;
		}
		if (!this.peer || !this.localStream || !this.activeCall || !this.sessionId) return;
		let nextTrack: MediaStreamTrack | null = null;
		let addedToStream = false;
		let transceiver: RTCRtpTransceiver | null = null;
		try {
			const cameraStream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: videoConstraints(this.cameraFacingMode, this.activeVideoInputId || undefined)
			});
			nextTrack = cameraStream.getVideoTracks()[0] ?? null;
			if (!nextTrack) {
				for (const track of cameraStream.getTracks()) track.stop();
				throw new Error('Camera did not provide a video track.');
			}
			this.localStream.addTrack(nextTrack);
			addedToStream = true;
			transceiver = addCameraTransceiver(this.peer, nextTrack, this.localStream);
			this.videoTransceiver = transceiver;
			this.videoSender = transceiver.sender;
			const offer = await createOffer(this.peer);
			const trackConfig = await api.getCallRealtimeTrackConfig(this.activeCall.callId, {
				sessionId: this.sessionId,
				sessionDescription: offer,
				tracks: [
					{
						location: 'local',
						trackName: localTrackName(this.activeCall, 'video'),
						kind: 'video',
						mid: transceiver.mid
					}
				]
			});
			this.publishedMids = new Set([...this.publishedMids, ...publishedTrackMids(trackConfig, [transceiver.mid])]);
			await this.applyProviderDescription(trackConfig);
			this.cameraEnabled = true;
			this.updateLocalVideoStream();
		} catch (error) {
			if (transceiver) await transceiver.sender.replaceTrack(null).catch(() => undefined);
			if (nextTrack) {
				if (addedToStream) this.localStream.removeTrack(nextTrack);
				nextTrack.stop();
			}
			this.videoSender = null;
			this.videoTransceiver = null;
			throw error;
		}
	}

	private async publishP2pCameraTrack(): Promise<void> {
		if (!this.peer || !this.localStream || !this.activeCall || !this.sessionId) return;
		let nextTrack: MediaStreamTrack | null = null;
		let addedToStream = false;
		let transceiver: RTCRtpTransceiver | null = null;
		try {
			const cameraStream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: videoConstraints(this.cameraFacingMode, this.activeVideoInputId || undefined)
			});
			nextTrack = cameraStream.getVideoTracks()[0] ?? null;
			if (!nextTrack) {
				for (const track of cameraStream.getTracks()) track.stop();
				throw new Error('Camera did not provide a video track.');
			}
			this.localStream.addTrack(nextTrack);
			addedToStream = true;
			transceiver = addCameraTransceiver(this.peer, nextTrack, this.localStream);
			this.videoTransceiver = transceiver;
			this.videoSender = transceiver.sender;
			this.cameraEnabled = true;
			this.updateLocalVideoStream();
			const negotiated = await this.createAndSendP2pOffer();
			if (!negotiated) throw new Error('Could not negotiate camera media.');
			const trackConfig = await api.getCallRealtimeTrackConfig(this.activeCall.callId, {
				sessionId: this.sessionId,
				tracks: [
					{
						location: 'local',
						trackName: localTrackName(this.activeCall, 'video'),
						kind: 'video',
						mid: transceiver.mid ?? 'video'
					}
				]
			});
			this.publishedMids = new Set([...this.publishedMids, ...publishedTrackMids(trackConfig, [transceiver.mid ?? 'video'])]);
		} catch (error) {
			if (transceiver) {
				await transceiver.sender.replaceTrack(null).catch(() => undefined);
				transceiver.stop();
			}
			if (nextTrack) {
				if (addedToStream) this.localStream.removeTrack(nextTrack);
				nextTrack.stop();
			}
			this.videoSender = null;
			this.videoTransceiver = null;
			this.cameraEnabled = false;
			this.updateLocalVideoStream();
			throw error;
		}
	}

	private async replaceCameraTrack(facingMode: CameraFacingMode, deviceId?: string): Promise<void> {
		if (!this.localStream || !this.videoSender) return;
		const cameraStream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: videoConstraints(facingMode, deviceId)
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

	private stopLocalCameraTrack(): void {
		const currentTrack = this.localStream?.getVideoTracks()[0];
		if (!currentTrack) {
			this.updateLocalVideoStream();
			return;
		}
		currentTrack.stop();
		this.localStream?.removeTrack(currentTrack);
		this.updateLocalVideoStream();
	}

	private startMediaHeartbeat(): void {
		this.stopMediaHeartbeat();
		this.mediaHeartbeat = setInterval(() => {
			void this.syncParticipantMediaState({ heartbeatOnly: true });
		}, MEDIA_HEARTBEAT_MS);
	}

	private stopMediaHeartbeat(): void {
		if (this.mediaHeartbeat) clearInterval(this.mediaHeartbeat);
		this.mediaHeartbeat = null;
	}

	private startStatsHeartbeat(): void {
		this.stopStatsHeartbeat();
		this.statsHeartbeat = setInterval(() => {
			void this.refreshCallStats();
		}, CALL_STATS_POLL_MS);
	}

	private stopStatsHeartbeat(): void {
		if (this.statsHeartbeat) clearInterval(this.statsHeartbeat);
		this.statsHeartbeat = null;
	}

	private async refreshCallStats(): Promise<CallDiagnosticsSnapshot> {
		const peer = this.peer;
		if (!peer || !this.mediaCallId || !this.sessionId) return this.diagnostics;
		const stats = await collectPeerStats(peer);
		const next: CallDiagnosticsSnapshot = {
			...this.diagnostics,
			callId: this.mediaCallId,
			sessionId: this.sessionId,
			active: this.mediaState === 'active',
			sampledAt: new Date().toISOString(),
			durationMs: this.mediaStartedAt ? Math.max(0, Date.now() - this.mediaStartedAt) : 0,
			bytesSentEstimate: stats.bytesSentEstimate,
			bytesReceivedEstimate: stats.bytesReceivedEstimate,
			packetsLost: stats.packetsLost,
			roundTripTimeMs: stats.roundTripTimeMs,
			candidateType: stats.candidateType,
			relayLikely: stats.relayLikely,
			peerConnectionState: peer.connectionState,
			iceConnectionState: peer.iceConnectionState,
			iceGatheringState: peer.iceGatheringState,
			signalingState: peer.signalingState
		};
		this.diagnostics = next;
		return next;
	}

	private async reportCallUsageBeforeClose(callId: string, sessionId: string): Promise<void> {
		if (this.usageReportSent) return;
		this.usageReportSent = true;
		const snapshot = await this.refreshCallStats().catch(() => this.diagnostics);
		const tracks = buildUsageReportTracks(snapshot.durationMs, {
			audio: Boolean(this.audioSender),
			video: Boolean(this.videoSender),
			screen: Boolean(this.screenSender),
			remoteAudio: this.remoteStreams.length > 0,
			remoteVideo: this.remoteVideoStreams.some((stream) => stream.kind === 'video'),
			remoteScreen: this.remoteVideoStreams.some((stream) => stream.kind === 'screen')
		});
		try {
			await api.reportCallUsage(callId, {
				sessionId,
				durationMs: snapshot.durationMs,
				bytesSentEstimate: snapshot.bytesSentEstimate,
				bytesReceivedEstimate: snapshot.bytesReceivedEstimate,
				tracks,
				network: {
					candidateType: snapshot.candidateType,
					relayLikely: snapshot.relayLikely,
					roundTripTimeMs: snapshot.roundTripTimeMs,
					packetsLost: snapshot.packetsLost
				}
			});
			this.diagnostics = {
				...this.diagnostics,
				lastUsageReportAt: new Date().toISOString(),
				lastUsageReportError: null
			};
		} catch (error) {
			this.diagnostics = {
				...this.diagnostics,
				lastUsageReportError: displayError(error, 'Could not report call usage.')
			};
		}
	}

	private async syncParticipantMediaState(
		options: { videoEnabled?: boolean; screenEnabled?: boolean; heartbeatOnly?: boolean } = {}
	): Promise<void> {
		const call = this.activeCall;
		if (!call) return;
		try {
			const updated = await api.updateCallParticipant(call.callId, {
				heartbeat: true,
				...(options.heartbeatOnly
					? {}
					: {
							audioEnabled: !this.muted,
							videoEnabled: options.videoEnabled ?? this.cameraEnabled,
							screenEnabled: options.screenEnabled ?? this.screenShareEnabled
						})
			});
			this.activeCall = updated;
			this.upsertRoomHistory(updated);
		} catch {
			/* heartbeat/media-state sync recovers on the next successful patch */
		}
	}

	private async closeMedia(options: { notifyProvider?: boolean } = {}): Promise<void> {
		this.mediaAttemptId += 1;
		this.stopMediaHeartbeat();
		this.stopStatsHeartbeat();
		const notifyProvider = options.notifyProvider ?? true;
		const callId = this.mediaCallId;
		const sessionId = this.sessionId;
		const mids = [...this.publishedMids];
		if (notifyProvider && callId && sessionId) {
			await this.reportCallUsageBeforeClose(callId, sessionId);
		}
		for (const track of this.localScreenStream?.getTracks() ?? []) {
			track.onended = null;
			track.stop();
		}
		for (const track of this.localStream?.getTracks() ?? []) track.stop();
		this.localScreenStream = null;
		this.localStream = null;
		this.localVideoStream = null;
		this.screenShareEnabled = false;
		this.cameraEnabled = false;
		if (notifyProvider && callId && sessionId && mids.length) {
			await api
				.closeCallRealtimeTracks(callId, {
					sessionId,
					tracks: mids.map((mid) => ({ mid })),
					force: true
				})
				.catch(() => undefined);
		}
		this.peer?.close();
		this.peer = null;
		this.sessionId = null;
		this.mediaCallId = null;
		this.mediaProvider = null;
		this.publishedMids = new Set();
		this.subscribedTracks = new Set();
		this.pendingRemoteVideoTracks = [];
		this.resetP2pState();
		this.audioSender = null;
		this.videoSender = null;
		this.videoTransceiver = null;
		this.screenSender = null;
		this.screenTrackMid = null;
		this.remoteStreams = [];
		this.remoteVideoStreams = [];
		this.callDevicePanelOpen = false;
		this.peerConnectionState = 'closed';
		this.iceConnectionState = 'closed';
		this.iceGatheringState = 'complete';
		this.signalingState = 'closed';
		this.mediaStartedAt = null;
		this.diagnostics = {
			...this.diagnostics,
			active: false,
			peerConnectionState: 'closed',
			iceConnectionState: 'closed',
			iceGatheringState: 'complete',
			signalingState: 'closed'
		};
	}

	private isCurrentMediaAttempt(attemptId: number, callId: string): boolean {
		return this.mediaAttemptId === attemptId && this.activeCall?.callId === callId;
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
		this.screenShareEnabled = false;
		this.startingScreenShare = false;
		this.switchingCamera = false;
		this.callDevicePanelOpen = false;
		this.videoSurfaceExpanded = false;
		this.featuredVideoId = null;
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
		this.stopMediaHeartbeat();
		this.stopStatsHeartbeat();
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
		this.localScreenStream = null;
		this.cameraEnabled = false;
		this.screenShareEnabled = false;
		this.startingScreenShare = false;
		this.switchingCamera = false;
		this.callDevicePanelOpen = false;
		this.callFeatures = { ...DEFAULT_CALL_FEATURES };
		this.diagnostics = { ...EMPTY_CALL_DIAGNOSTICS };
		this.cancelPrejoin();
	}
}

function hasMediaSupport(): boolean {
	return (
		typeof RTCPeerConnection !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		!!navigator.mediaDevices?.getUserMedia
	);
}

function hasDisplayMediaSupport(): boolean {
	return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

interface PeerStatsSummary {
	bytesSentEstimate: number;
	bytesReceivedEstimate: number;
	packetsLost: number;
	roundTripTimeMs: number | null;
	candidateType: string | null;
	relayLikely: boolean;
}

async function collectPeerStats(peer: RTCPeerConnection): Promise<PeerStatsSummary> {
	const report = await peer.getStats();
	const byId = new Map<string, RTCStats & Record<string, unknown>>();
	report.forEach((stat) => {
		byId.set(stat.id, stat as RTCStats & Record<string, unknown>);
	});
	let bytesSentEstimate = 0;
	let bytesReceivedEstimate = 0;
	let packetsLost = 0;
	let roundTripTimeMs: number | null = null;
	let candidateType: string | null = null;
	for (const stat of byId.values()) {
		if (stat.type === 'outbound-rtp') {
			bytesSentEstimate += statNumber(stat, 'bytesSent');
		} else if (stat.type === 'inbound-rtp') {
			bytesReceivedEstimate += statNumber(stat, 'bytesReceived');
			packetsLost += statNumber(stat, 'packetsLost');
		} else if (stat.type === 'candidate-pair' && (stat.selected === true || stat.nominated === true)) {
			const currentRoundTripTime = statNumber(stat, 'currentRoundTripTime');
			if (currentRoundTripTime > 0) roundTripTimeMs = Math.round(currentRoundTripTime * 1000);
			const localCandidateId = statString(stat, 'localCandidateId');
			if (localCandidateId) {
				const localCandidate = byId.get(localCandidateId);
				candidateType = localCandidate ? statString(localCandidate, 'candidateType') : null;
			}
		}
	}
	return {
		bytesSentEstimate,
		bytesReceivedEstimate,
		packetsLost,
		roundTripTimeMs,
		candidateType,
		relayLikely: candidateType === 'relay'
	};
}

function statNumber(stat: Record<string, unknown>, key: string): number {
	const value = stat[key];
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function statString(stat: Record<string, unknown>, key: string): string | null {
	const value = stat[key];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildUsageReportTracks(
	durationMs: number,
	active: {
		audio: boolean;
		video: boolean;
		screen: boolean;
		remoteAudio: boolean;
		remoteVideo: boolean;
		remoteScreen: boolean;
	}
): CallUsageReportTrackInput[] {
	const tracks: CallUsageReportTrackInput[] = [];
	if (active.audio) tracks.push({ kind: 'audio', direction: 'send', durationMs });
	if (active.remoteAudio) tracks.push({ kind: 'audio', direction: 'receive', durationMs });
	if (active.video) tracks.push({ kind: 'video', direction: 'send', durationMs });
	if (active.remoteVideo) tracks.push({ kind: 'video', direction: 'receive', durationMs });
	if (active.screen) tracks.push({ kind: 'screen', direction: 'send', durationMs });
	if (active.remoteScreen) tracks.push({ kind: 'screen', direction: 'receive', durationMs });
	return tracks;
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

async function createP2pOffer(
	peer: RTCPeerConnection,
	options: { iceRestart?: boolean } = {}
): Promise<CallRealtimeSessionDescription> {
	const offer = await peer.createOffer(options.iceRestart ? { iceRestart: true } : undefined);
	await peer.setLocalDescription(offer);
	return sessionDescription(peer.localDescription);
}

async function createP2pAnswer(peer: RTCPeerConnection): Promise<CallRealtimeSessionDescription> {
	const answer = await peer.createAnswer();
	await peer.setLocalDescription(answer);
	return sessionDescription(peer.localDescription);
}

function sessionDescription(description: RTCSessionDescription | null): CallRealtimeSessionDescription {
	if (!description) throw new Error('Missing WebRTC session description.');
	return { type: description.type, sdp: description.sdp };
}

function iceCandidate(candidate: RTCIceCandidate): CallIceCandidate {
	const json = candidate.toJSON();
	return {
		candidate: json.candidate ?? candidate.candidate,
		sdpMid: json.sdpMid ?? null,
		sdpMLineIndex: json.sdpMLineIndex ?? null,
		usernameFragment: json.usernameFragment ?? null
	};
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

function addScreenTransceiver(
	peer: RTCPeerConnection,
	track: MediaStreamTrack,
	stream: MediaStream
): RTCRtpTransceiver {
	try {
		return peer.addTransceiver(track, {
			direction: 'sendonly',
			streams: [stream],
			sendEncodings: SCREEN_SEND_ENCODINGS
		});
	} catch {
		return peer.addTransceiver(track, {
			direction: 'sendonly',
			streams: [stream]
		});
	}
}

function audioConstraints(deviceId?: string): MediaTrackConstraints {
	return {
		...AUDIO_CONSTRAINTS,
		...(deviceId ? { deviceId: { exact: deviceId } } : {})
	};
}

function videoConstraints(facingMode: CameraFacingMode, deviceId?: string): MediaTrackConstraints {
	return {
		width: { ideal: 1280 },
		height: { ideal: 720 },
		frameRate: { ideal: 24, max: 30 },
		...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facingMode } })
	};
}

function screenShareConstraints(): MediaTrackConstraints {
	return {
		width: { ideal: 1920 },
		height: { ideal: 1080 },
		frameRate: { ideal: 15, max: 30 }
	};
}

function mapMediaDeviceOptions(devices: MediaDeviceInfo[]): CallDeviceOption[] {
	const counts: Record<CallDeviceKind, number> = {
		audioinput: 0,
		audiooutput: 0,
		videoinput: 0
	};
	return devices
		.filter((device): device is MediaDeviceInfo & { kind: CallDeviceKind } =>
			device.kind === 'audioinput' || device.kind === 'audiooutput' || device.kind === 'videoinput'
		)
		.map((device) => {
			counts[device.kind] += 1;
			return {
				deviceId: device.deviceId,
				groupId: device.groupId,
				kind: device.kind,
				label: device.label || fallbackDeviceLabel(device.kind, counts[device.kind], device.deviceId)
			};
		});
}

function fallbackDeviceLabel(kind: CallDeviceKind, index: number, deviceId: string): string {
	if (deviceId === 'default') {
		if (kind === 'audioinput') return 'Default microphone';
		if (kind === 'audiooutput') return 'Default speaker';
		return 'Default camera';
	}
	if (kind === 'audioinput') return `Microphone ${index}`;
	if (kind === 'audiooutput') return `Speaker ${index}`;
	return `Camera ${index}`;
}

function availableDeviceId(preferred: string | undefined, devices: CallDeviceOption[]): string {
	if (!preferred) return '';
	return devices.some((device) => device.deviceId === preferred) ? preferred : '';
}

function cleanDevicePreferences(preferences: Partial<CallDevicePreferences>): CallDevicePreferences {
	return {
		...(preferences.audioInputId ? { audioInputId: preferences.audioInputId } : {}),
		...(preferences.audioOutputId ? { audioOutputId: preferences.audioOutputId } : {}),
		...(preferences.videoInputId ? { videoInputId: preferences.videoInputId } : {})
	};
}

function localTrackName(call: Call, kind: 'audio' | 'video' | 'screen'): string {
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

function p2pTargetKey(target: P2pSignalTarget): string {
	return `${target.principalId}:${target.deviceId}`;
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

function remoteVideoSimulcastPolicy(preference: CallVideoQualityPreference): NonNullable<CallRealtimeTrackInput['simulcast']> {
	const selected = VIDEO_QUALITY_OPTIONS.find((option) => option.value === preference);
	const preferredRid =
		selected?.preferredRid ??
		(typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
			? VIDEO_SIMULCAST_POLICY.mobilePreferredRid
			: VIDEO_SIMULCAST_POLICY.desktopPreferredRid);
	return {
		preferredRid,
		priorityOrdering: VIDEO_SIMULCAST_POLICY.priorityOrdering,
		ridNotAvailable: VIDEO_SIMULCAST_POLICY.ridNotAvailable
	};
}

function isVideoQualityPreference(value: unknown): value is CallVideoQualityPreference {
	return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

function connectionStatus(
	mediaState: CallMediaState,
	peerState: RTCPeerConnectionState,
	iceState: RTCIceConnectionState
): CallConnectionStatus {
	if (mediaState === 'connecting' || peerState === 'new' || peerState === 'connecting' || iceState === 'checking') {
		return { quality: 'connecting', label: 'Connecting', detail: 'Negotiating media' };
	}
	if (mediaState === 'error' || peerState === 'failed' || iceState === 'failed') {
		return { quality: 'failed', label: 'Failed', detail: 'Media connection failed' };
	}
	if (peerState === 'disconnected' || iceState === 'disconnected') {
		return { quality: 'unstable', label: 'Unstable', detail: 'Media connection interrupted' };
	}
	if (mediaState === 'active' && (peerState === 'connected' || iceState === 'connected' || iceState === 'completed')) {
		return { quality: 'good', label: 'Good', detail: 'Media connection active' };
	}
	return { quality: 'idle', label: 'Idle', detail: 'Media inactive' };
}

function cryptoId(prefix: string): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}_${crypto.randomUUID()}`;
	return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function displayError(error: unknown, fallback: string): string {
	return isApiError(error) ? error.display : (error as Error)?.message || fallback;
}

function callTimeMs(call: Call): number {
	const value = call.endedAt ?? call.startedAt ?? call.createdAt;
	const date = value ? new Date(value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value) : null;
	return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

export const calls = new CallsStore();
