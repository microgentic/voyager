# Call Live Media Release Checklist

Status: production readiness checklist
Date: 2026-06-22

Use this checklist before enabling live call media outside local mock testing.
For one-on-one P2P WebRTC, do not broadly release without owned TURN.

## Provider Selection

Messaging Core owns the call media provider selection.

- Use `CALL_MEDIA_PROVIDER=p2p_webrtc` for direct one-on-one WebRTC P2P media.
- Keep `CALL_MEDIA_PROVIDER=cloudflare_realtime` only for the Cloudflare Realtime provider path.
- Confirm `GET /v1/admin/calls/realtime-status` returns the expected `provider`.

## P2P WebRTC Owned TURN Configuration

Cloudflare still runs Voyager and Messaging Core, but P2P audio/video media flows browser-to-browser when possible or through TURN when direct NAT traversal fails. Cloudflare Workers cannot act as the TURN relay.

Required production shape:

- Run owned TURN infrastructure such as coturn on project-controlled infrastructure.
- Configure UDP `3478`, TCP `3478`, and TLS-over-TCP `5349` where available.
- Set `CALL_MEDIA_PROVIDER=p2p_webrtc`.
- Set `CALLS_P2P_ENABLED=1`.
- Set `CALL_P2P_STUN_URLS` to owned STUN URLs.
- Set `CALL_P2P_TURN_URLS` to owned TURN URLs.
- Prefer short-lived TURN credentials with `CALL_P2P_TURN_REST_SECRET`.
- Optionally set `CALL_P2P_TURN_USERNAME` as the username suffix for generated coturn REST credentials.
- Optionally set `CALL_P2P_TURN_CREDENTIAL_TTL_SECONDS`; default is one hour.

Static TURN credentials are supported with `CALL_P2P_TURN_USERNAME` and `CALL_P2P_TURN_CREDENTIAL`, but short-lived credentials are preferred.

Before release, confirm `GET /v1/admin/calls/realtime-status` returns:

- `provider: "p2p_webrtc"`
- `configured: true`
- `stunConfigured: true`
- `turnConfigured: true`
- `turnCredentialMode: "ephemeral"` or `"static"`
- `releaseReadiness: "production_ready"`
- `releaseBlockers: []`

If `releaseReadiness` is `"dev_only"` with `owned_turn_not_configured`, the environment is suitable for local/friendly-network testing only.

## Cloudflare Realtime Configuration

- Set `CLOUDFLARE_REALTIME_APP_ID` as an environment variable or secret for the target Worker.
- Set `CLOUDFLARE_REALTIME_APP_SECRET` as a secret. Do not commit it.
- Leave `CLOUDFLARE_REALTIME_API_BASE` unset unless Cloudflare directs a different stable endpoint.
- Configure `CLOUDFLARE_REALTIME_TURN_USERNAME` and `CLOUDFLARE_REALTIME_TURN_CREDENTIAL` only when TURN credentials are available for the environment.
- Confirm `GET /v1/admin/calls/realtime-status` returns `configured: true`, `configurationStatus: "configured"`, `providerHealthStatus: "not_checked"`, and the expected feature flags. This endpoint confirms configuration state, not live provider reachability.

## Feature Flags

Default enabled flags:

- `CALLS_ENABLED=1`
- `AUDIO_CALLS_ENABLED=1`
- `VIDEO_CALLS_ENABLED=1`
- `SCREEN_SHARE_ENABLED=1`
- `CALLS_REALTIME_MEDIA_ENABLED=1`

Set a flag to `0`, `false`, `off`, `disabled`, or `no` to disable that surface.
Disabled call or media features return `feature_disabled` before provider work.

## Verification

Run the normal local checks first:

```bash
npm run check
npm --prefix apps/client run check
npm --prefix apps/client run build
node scripts/route-inventory-check.mjs
node --check scripts/backend-first-smoke.mjs
CLOUDFLARE_REALTIME_MOCK=1 npm run smoke:backend:local
SMOKE_CALL_MEDIA_PROVIDER=p2p_webrtc npm run smoke:backend:local
npx wrangler deploy --dry-run
git diff --check
```

After deployment and remote migrations, run:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

## Manual QA

- Start audio and video calls between two real browser clients on normal networks.
- Start audio and video calls between browser clients on networks expected to force TURN relay, such as a hotspot plus office/VPN network.
- Confirm call diagnostics show relay-likely state when the forced-relay test uses TURN.
- Test camera on/off, camera switching, mute/unmute, leave/rejoin, and failed-network recovery.
- On mobile/Tauri, verify microphone and camera permissions, background/foreground transitions, audio route behavior, and camera switching on real devices or simulators.
- Confirm screen sharing is unavailable on the P2P call path until deliberately implemented.
- Confirm microphone, camera, and screen indicators stop after call teardown.
- Confirm Settings -> Advanced shows call diagnostics while a call is active.
- Confirm usage reports appear in `GET /v1/admin/usage` under `callMedia`.
- Confirm `GET /v1/admin/calls/realtime-status` does not expose secrets.
- Toggle each feature flag in a non-production environment and confirm disabled
  controls fail cleanly with `feature_disabled`.
