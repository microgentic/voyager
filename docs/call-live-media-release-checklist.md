# Call Live Media Release Checklist

Status: production readiness checklist
Date: 2026-06-22

Use this checklist before enabling live Cloudflare Realtime calls outside local
mock testing.

## Cloudflare Realtime Configuration

- Set `CLOUDFLARE_REALTIME_APP_ID` as an environment variable or secret for the target Worker.
- Set `CLOUDFLARE_REALTIME_APP_SECRET` as a secret. Do not commit it.
- Leave `CLOUDFLARE_REALTIME_API_BASE` unset unless Cloudflare directs a different stable endpoint.
- Configure `CLOUDFLARE_REALTIME_TURN_USERNAME` and `CLOUDFLARE_REALTIME_TURN_CREDENTIAL` only when TURN credentials are available for the environment.
- Confirm `GET /v1/admin/calls/realtime-status` returns `configured: true` and the expected feature flags.

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
npx wrangler deploy --dry-run
git diff --check
```

After deployment and remote migrations, run:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

After credentials are confirmed for live media, opt in to provider media checks:

```bash
REALTIME_SMOKE_MEDIA=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

## Manual QA

- Start audio and video calls between two real browser clients.
- Confirm microphone, camera, and screen indicators stop after call teardown.
- Confirm Settings -> About -> Advanced shows call diagnostics while a call is active.
- Confirm usage reports appear in `GET /v1/admin/usage` under `callMedia`.
- Confirm `GET /v1/admin/calls/realtime-status` does not expose secrets.
- Toggle each feature flag in a non-production environment and confirm disabled
  controls fail cleanly with `feature_disabled`.
