# Remote Post-Deploy Smoke

Status: active dev release verification
Date: 2026-06-22
Related docs:

- `docs/api-contract.md`
- `docs/dev-test-operations.md`
- `docs/realtime-messaging-handoff.md`

## Purpose

The local backend smoke proves the Worker works against a fresh local Wrangler
D1/R2 state. The remote post-deploy smoke proves the deployed Worker, remote
D1 migrations, Durable Object realtime path, CORS-compatible HTTP surface, and
seeded test accounts are healthy after the production Worker deploy completes.

This is not a load test and not a replacement for manual real-device checks.
It is a release verification tripwire for the deployed development environment.

## CI Behavior

The Worker deployment workflow runs in this order on `main` pushes:

1. Type check.
2. Local backend smoke against fresh local Wrangler state.
3. Remote D1 migrations.
4. Worker deploy.
5. Remote post-deploy smoke.

Pull requests still run the local backend smoke only. The remote smoke runs only
after a non-PR Worker deploy because it intentionally exercises the live dev
Worker and seeded disposable test accounts.

## What It Verifies

`npm run smoke:backend:remote` checks:

- `GET /health` returns a healthy Worker with D1 and R2 bindings.
- Seeded `ada@example.com` and `grace@example.com` password login works.
- `GET /v1/app/bootstrap?limit=100` returns the stable startup contract.
- Long-lived session tokens cannot authenticate `GET /v1/realtime` directly.
- `POST /v1/realtime/token` returns a valid short-lived socket token.
- `GET /v1/realtime` opens with that socket token and emits `ready`.
- Attachment allocation, original/thumbnail upload, completion, authenticated
  downloads, and unreferenced cleanup work against the deployed R2 binding.
- Basic audio call lifecycle works at the deployed Worker level: create, optional
  configured-false Realtime session response, receiver join, mute/unmute, both
  participants leave, and final ended call fetch.
- The call usage-report endpoint accepts aggregate metadata during the smoke call.
- When `REALTIME_SMOKE_MEDIA=1` is set, the smoke requires Cloudflare Realtime to
  be configured and also exercises provider session, track publish, and track
  close endpoints.
- Sending a direct message includes Conversation DO timing diagnostics and emits
  a matching `room.message` event.
- Retrying that send with the same idempotency key returns the same
  `envelopeId` and `serverSequence` without creating a second durable message.
- Receiver recovery reads work through `GET /v1/rooms/{roomId}`,
  `GET /v1/rooms/{roomId}/messages`, and `GET /v1/sync`.

The smoke prefers an existing seeded Ada/Grace direct room so each run does not
create another room. If no active direct room exists, it creates a fallback room
and archives it during cleanup. The smoke also acknowledges the sent message,
deletes any unreferenced smoke attachment, leaves any smoke call, and revokes
temporary `probe` devices at the end of a successful or failed run when possible.

## Manual Run

Run against the deployed dev Worker:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

Optional overrides:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
REMOTE_SMOKE_OWNER_EMAIL=ada@example.com \
REMOTE_SMOKE_RECEIVER_EMAIL=grace@example.com \
REMOTE_SMOKE_PASSWORD=voyager-demo-pass \
npm run smoke:backend:remote
```

To keep the temporary smoke devices for debugging:

```bash
REMOTE_SMOKE_KEEP_DEVICES=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

To opt in to the live Cloudflare Realtime media path after credentials and release
flags are configured:

```bash
REALTIME_SMOKE_MEDIA=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

The opt-in media mode is expected to fail fast if the environment returns
`configured: false` or if the provider rejects session/track negotiation.

Default WebSocket wait timeout is 20 seconds. Override it only when diagnosing
slow CI or network behavior:

```bash
REMOTE_SMOKE_TIMEOUT_MS=30000 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

## Troubleshooting

If the smoke reports `device_limit_reached`, clean the disposable test devices
and retry:

```bash
APPLY=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
ADMIN_EMAIL=ada@example.com \
ADMIN_PASSWORD=voyager-demo-pass \
npm run dev:cleanup-devices
```

If migrations fail before Worker deploy, do not trust any later smoke result;
the Worker may be running code that expects tables or indexes that are not
present yet.

If the WebSocket checks fail while HTTP checks pass, inspect:

- `POST /v1/realtime/token` response status and `Server-Timing`.
- WebSocket connection to `/v1/realtime` with protocol
  `voyager.realtime.v1`.
- Durable Object deployment/binding health in the Worker deploy logs.

## Conversation Durable Object Sequencing

This smoke makes the deployed realtime and message path safer to operate.
Conversation Durable Objects now coordinate message sends and room/membership
mutations. The current coordinator does not store a second durable room state;
D1 remains the reconciliation source. This remote smoke is the first deployed
guard that the write path, realtime hint, idempotency retry, and HTTP recovery
reads all still agree after deploy.
