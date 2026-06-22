# Call Video Completion QA

Status: implementation checklist for screen sharing, fullscreen video, quality policy, and media teardown.
Date: 2026-06-22

## Capability Review

- Screen sharing uses the browser/WebView `navigator.mediaDevices.getDisplayMedia()` API only when the platform exposes it.
- Screen share is published as a separate `screen` Realtime track and is stopped independently from the camera track.
- Call media remains WebRTC-only. The backend stores session and track metadata but never stores camera, microphone, or screen media.
- Call teardown reports aggregate WebRTC usage metadata for operations and cost diagnostics; it does not submit media content or SDP.
- Environment flags can disable calls, audio calls, video calls, screen sharing, or realtime media before provider work is attempted.
- Browser fullscreen may be blocked by browser policy or user gesture rules. The in-app expanded video surface remains the fallback.
- Mobile browsers and WebViews may omit screen capture support. Mobile QA should focus on rotation, camera switch, background behavior, and teardown indicators.

## Manual QA Checklist

- Start a web-to-web video call with camera off, then turn the camera on and confirm the featured video tile appears.
- Switch between front and back cameras on a mobile device or laptop with multiple cameras. Confirm the local preview stays live and the call continues.
- Start screen sharing on desktop Chrome. Confirm the screen tile is featured, remote participants see it as a screen share, and the camera remains independently controllable.
- Stop screen sharing from the Voyager button, then start again and stop from the browser's sharing indicator. Confirm both paths clear the screen tile and server-visible screen state.
- Toggle fullscreen/expanded video mode. Confirm browser fullscreen works where allowed and the in-app expanded surface is usable when browser fullscreen is blocked.
- Change video quality between Auto, Low, Medium, and High before a remote participant joins. Confirm the call remains connected and remote video still subscribes.
- Background the app or tab during a video call. Confirm local camera and screen sharing stop while audio can remain connected.
- Rotate a phone between portrait and landscape during an active video call. Confirm the focused tile and controls stay visible and usable.
- Simulate a poor network or briefly disable connectivity. Confirm the connection status changes and recovers when media reconnects.
- End the call while camera and screen share are active. Confirm OS camera/microphone/screen indicators turn off and no local preview remains.
- Rejoin or start a new call after teardown. Confirm microphone, camera, and screen prompts still work and no stale previous stream is shown.
- Open Settings -> About -> Advanced during and after a call. Confirm call diagnostics show peer/ICE state, byte estimates, candidate/relay status, and last usage report state.

## Automated Backend Coverage

- Normal local backend smoke keeps validating the configured-false Cloudflare Realtime path.
- `CLOUDFLARE_REALTIME_MOCK=1 npm run smoke:backend:local` validates configured-success session, duplicate session, local track upsert, duplicate track upsert, renegotiation, close, duplicate close, audio-call rejection of video tracks, video-call audio/video/screen metadata, realtime status, usage-report metadata, and admin usage rollups.
- `REALTIME_SMOKE_MEDIA=1 npm run smoke:backend:remote` opts in to live provider session/track/close checks after Cloudflare Realtime credentials are configured.
- The mock smoke is not a substitute for real browser/device QA with Cloudflare Realtime credentials; it proves backend coordination and contract behavior only.
