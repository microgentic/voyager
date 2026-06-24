# Call Media Coordination

Status: Messaging Core implementation contract for audio/video call media coordination.
Date: 2026-06-24

## Coordination Model

Messaging Core uses one shared call model for audio and video. Core serializes authoritative call lifecycle and durable media metadata writes. Cloudflare Realtime remains the media provider, and media bytes never enter D1, R2, or Voyager WebSocket messages.

The split is intentional:

- Cloudflare Realtime HTTP calls may run outside the serialized mutation path so a slow provider request does not block unrelated Core work.
- Durable D1 session, track, media-state, provider-failure, unavailable, and renegotiation records are committed in Messaging Core.
- Clients treat realtime events as hints and recover authoritative call state through call HTTP reads.

## Realtime Endpoint Flow

`POST /v1/calls/{callId}/realtime/session` validates the caller and participant, calls the provider when configured, then commits the Core session metadata. Repeated session requests for the same active participant return the existing active session when no new offer is supplied. If a repeated request includes a new `sessionDescription`, the endpoint renegotiates against the existing provider session and returns a fresh answer instead of silently returning a ready session with no SDP.

`POST /v1/calls/{callId}/realtime/tracks` validates session ownership and track shape, calls the provider for requested track changes, then commits the Core track metadata. Track rows are unique by session, provider track name, and location, so duplicate local publication updates the existing row.

`POST /v1/calls/{callId}/realtime/tracks/close` calls the provider close path when configured, then closes the Core track metadata. Closing an already closed track is safe; participant audio/video/screen flags are recalculated from remaining active local tracks.

`POST /v1/calls/{callId}/realtime/renegotiate` keeps provider negotiation outside the Durable Object, then commits `call.media.renegotiate.record` to refresh liveness and record the metadata-only event.

When provider credentials are absent or a provider request fails, Core commits a metadata-only failure/unavailable event and returns the documented configured-false or provider-error response.

## Race And Idempotency Rules

- Publishing after leave, end, or device/session revocation fails because the coordinator re-checks live call status and connected participant state at commit time.
- Audio calls reject video and screen track publication.
- Duplicate active session requests return the existing participant session.
- Duplicate active session requests with a new SDP offer renegotiate the existing provider session.
- Duplicate local track publication upserts the existing active track metadata.
- Duplicate track close is a stable no-op from the D1 perspective.
- Leaving a call closes the participant's realtime sessions and tracks.
- Ending a call closes all active realtime sessions and tracks.

## Local Mock Provider

Local smoke tests can set `CLOUDFLARE_REALTIME_MOCK=1` to exercise configured-success session, track, renegotiation, and close paths without real Cloudflare Realtime credentials. The mock is deterministic and only enabled when the Worker receives that explicit local variable. Production remains configured by Cloudflare Realtime secrets.

## Provider Commit Failure Handling

Provider HTTP calls happen before D1/Coordinator commits so slow network work does not block the Durable Object queue. If a provider track-publish call succeeds but the subsequent D1/Coordinator commit fails, Voyager attempts a best-effort provider track close for returned track mids and records a metadata-only `call.media.provider_orphan_risk` event when possible. If provider session creation succeeds but the session commit fails, the current Cloudflare Realtime integration does not expose a proven non-media session cleanup call in this code path; Voyager records the same orphan-risk event when D1 is reachable so operators can reconcile or expire the provider-side session. Media bytes are still never stored in D1/R2.

## Diagnostics Boundary

Operator-facing Realtime status, advanced call diagnostics, feature flags, and client-estimate usage reporting are implemented as production-readiness surfaces. They are metadata-only diagnostics and do not store media bytes. Provider-authoritative egress remains unavailable until a trusted provider metrics source is integrated.

## Non-Goals

- No call media is stored in D1 or R2.
- No public media URLs are created.
- No raw WebSocket media transport is introduced.
- SFU/WebRTC transport encryption is not documented as end-to-end encrypted calling.
