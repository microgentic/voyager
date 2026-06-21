import { api, isApiError } from '$lib/api';
import type {
	Call,
	CallParticipant,
	CallRealtimeConfig,
	CallRealtimeSessionDescription,
	CallRealtimeTrack,
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

const LIVE_CALL_STATUSES = new Set(['ringing', 'active']);
const INCOMING_PARTICIPANT_STATUSES = new Set(['invited', 'ringing', 'joining']);

class CallsStore {
	activeCall = $state<Call | null>(null);
	activeRoom = $state<Room | null>(null);
	incoming = $state<Call[]>([]);
	mediaState = $state<CallMediaState>('idle');
	muted = $state(false);
	startingRoomId = $state<string | null>(null);
	busyCallId = $state<string | null>(null);
	lastError = $state<string | null>(null);
	remoteStreams = $state<RemoteAudioStream[]>([]);

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
	private publishedMid: string | null = null;
	private subscribedTracks = new Set<string>();
	private subscribing = false;

	constructor() {
		auth.onSignOut(() => this.reset());
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
		if (!this.canStart(room)) return;
		this.startingRoomId = room.roomId;
		this.lastError = null;
		this.mediaState = 'connecting';
		try {
			const call = await api.createCall(room.roomId, { callType: 'audio' });
			this.activeCall = call;
			this.activeRoom = room;
			this.muted = false;
			const connected = await this.connectMedia(call);
			if (!connected) {
				await this.leaveCallQuietly(call.callId);
				this.clearActiveCall();
			}
		} catch (error) {
			this.mediaState = 'error';
			this.lastError = displayError(error, 'Could not start the call.');
			toasts.error(this.lastError);
		} finally {
			this.startingRoomId = null;
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
			this.lastError = 'Audio calls are not available in this browser.';
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

			const peer = new RTCPeerConnection({ iceServers: sessionConfig.iceServers as RTCIceServer[] });
			this.peer = peer;
			this.sessionId = sessionConfig.session.sessionId;
			this.mediaCallId = call.callId;
			this.subscribedTracks = new Set();
			this.remoteStreams = [];
			this.wirePeer(peer);

			this.localStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true
				},
				video: false
			});
			const audioTrack = this.localStream.getAudioTracks()[0];
			if (!audioTrack) throw new Error('Microphone did not provide an audio track.');
			const transceiver = peer.addTransceiver(audioTrack, {
				direction: 'sendonly',
				streams: [this.localStream]
			});
			const offer = await createOffer(peer);
			const trackConfig = await api.getCallRealtimeTrackConfig(call.callId, {
				sessionId: this.sessionId,
				sessionDescription: offer,
				tracks: [
					{
						location: 'local',
						trackName: localTrackName(call),
						kind: 'audio',
						mid: transceiver.mid
					}
				]
			});
			await this.applyProviderDescription(trackConfig);
			this.publishedMid = trackConfig.tracks?.find((track) => track.location === 'local')?.mid ?? transceiver.mid;
			this.mediaState = 'active';
			await this.subscribeAvailableTracks([
				...(sessionConfig.availableTracks ?? sessionConfig.tracks ?? []),
				...(trackConfig.availableTracks ?? [])
			]);
			return true;
		} catch (error) {
			await this.closeMedia({ notifyProvider: false });
			this.mediaState = 'error';
			this.lastError = displayError(error, 'Could not connect microphone audio.');
			toasts.error(this.lastError);
			return false;
		}
	}

	private wirePeer(peer: RTCPeerConnection): void {
		peer.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			const id = event.track.id || event.transceiver.mid || cryptoId('remote');
			if (!this.remoteStreams.some((candidate) => candidate.id === id)) {
				this.remoteStreams = [...this.remoteStreams, { id, stream }];
			}
			event.track.onended = () => {
				this.remoteStreams = this.remoteStreams.filter((candidate) => candidate.id !== id);
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
				track.kind === 'audio' &&
				track.location === 'remote' &&
				!!track.sessionId &&
				!!track.trackName &&
				!this.subscribedTracks.has(remoteTrackKey(track))
		);
		if (!remoteTracks.length) return;
		this.subscribing = true;
		try {
			for (const track of remoteTracks) {
				this.peer.addTransceiver('audio', { direction: 'recvonly' });
				this.subscribedTracks.add(remoteTrackKey(track));
			}
			const offer = await createOffer(this.peer);
			const config = await api.getCallRealtimeTrackConfig(this.activeCall.callId, {
				sessionId: this.sessionId,
				sessionDescription: offer,
				tracks: remoteTracks.map((track) => ({
					location: 'remote',
					sessionId: track.sessionId,
					trackName: track.trackName,
					kind: 'audio'
				}))
			});
			await this.applyProviderDescription(config);
		} catch {
			for (const track of remoteTracks) this.subscribedTracks.delete(remoteTrackKey(track));
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

	private async closeMedia(options: { notifyProvider?: boolean } = {}): Promise<void> {
		const notifyProvider = options.notifyProvider ?? true;
		const callId = this.mediaCallId;
		const sessionId = this.sessionId;
		const mid = this.publishedMid;
		if (notifyProvider && callId && sessionId && mid) {
			await api.closeCallRealtimeTracks(callId, {
				sessionId,
				tracks: [{ mid }],
				force: true
			}).catch(() => undefined);
		}
		for (const track of this.localStream?.getTracks() ?? []) track.stop();
		this.localStream = null;
		this.peer?.close();
		this.peer = null;
		this.sessionId = null;
		this.mediaCallId = null;
		this.publishedMid = null;
		this.subscribedTracks = new Set();
		this.remoteStreams = [];
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
				participant.principalId === principalId &&
				(participant.deviceId === null || participant.deviceId === deviceId)
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
		this.busyCallId = null;
		this.lastError = null;
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

function localTrackName(call: Call): string {
	return `${auth.device?.deviceId ?? 'device'}-${call.callId}-audio`;
}

function remoteTrackKey(track: CallRealtimeTrack): string {
	return `${track.sessionId}:${track.trackName}`;
}

function cryptoId(prefix: string): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}_${crypto.randomUUID()}`;
	return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

function displayError(error: unknown, fallback: string): string {
	return isApiError(error) ? error.display : (error as Error)?.message || fallback;
}

export const calls = new CallsStore();
