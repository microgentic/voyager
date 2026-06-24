# Dev/Test Operations and Realtime Diagnostics

Status: development operations support
Date: 2026-06-19
Related docs:

- `docs/realtime-performance-handoff.md`
- `docs/realtime-messaging-handoff.md`
- `docs/remote-post-deploy-smoke.md`
- `docs/frontend-web-desktop-handoff.md`
- `docs/mobile-ios-handoff.md`
- `docs/mobile-android-handoff.md`

## 1. Purpose

This pass adds operational tools for the current multi-client testing phase:

- A platform-owner-only cleanup endpoint and CLI script for stale test devices.
- A compact realtime diagnostics view in Settings -> Advanced.
- A compact call diagnostics view in Settings -> Advanced.
- A remote post-deploy smoke script for the deployed dev Worker.

It does not freeze the API contract. Conversation Durable Objects now coordinate message sends and room/membership mutations; D1 remains the recovery and reconciliation source for the current stateless coordinator.

## 2. Test Device Cleanup

Repeated web, desktop, iOS, Android, simulator, and CLI testing can fill the active-device quota for seeded accounts. When that happens, new password logins can fail with:

```text
device_limit_reached
```

The cleanup path is intentionally conservative. It only revokes devices that look like development or test devices, and it defaults to dry-run.

Backend endpoint:

```text
POST /v1/admin/devices/test-cleanup
```

Access:

- Requires an authenticated `platform_owner`.
- Writes an audit event for dry-run and apply calls.
- Revokes matching devices and their sessions only when `dryRun` is `false`.
- Does not revoke the current admin device unless `includeCurrentDevice` is explicitly `true`.

Default matching:

- Labels containing `codex`, `probe`, `smoke`, `simulator`, `emulator`, `seed check`, `cleanup cli`, or `dev test`.
- Platforms equal to `probe`, `smoke`, or `test`.
- Keeps the newest active device per account by default.

Optional behavior:

- `includeKnownAppDevices: true` can prune normal app-platform devices (`web`, `desktop`, `ios`, `android`, `mobile`) for explicitly listed demo account emails. Use this only after reviewing a dry-run.

## 3. Cleanup Script

Run a dry-run locally:

```bash
npm run dev:cleanup-devices
```

Run a dry-run against the deployed Worker:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
ADMIN_EMAIL=ada@example.com \
ADMIN_PASSWORD=voyager-demo-pass \
npm run dev:cleanup-devices
```

Apply after reviewing the dry-run:

```bash
APPLY=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
ADMIN_EMAIL=ada@example.com \
ADMIN_PASSWORD=voyager-demo-pass \
npm run dev:cleanup-devices
```

If the admin account itself is already at the device limit, use an existing session or enrolled device:

```bash
ADMIN_SESSION_TOKEN=<existing-platform-owner-session-token> \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run dev:cleanup-devices
```

or:

```bash
ADMIN_DEVICE_ID=<existing-platform-owner-device-id> \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
ADMIN_EMAIL=ada@example.com \
ADMIN_PASSWORD=voyager-demo-pass \
npm run dev:cleanup-devices
```

To include stale normal app devices for the seeded demo accounts:

```bash
INCLUDE_APP_DEVICES=1 \
APPLY=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
ADMIN_EMAIL=ada@example.com \
ADMIN_PASSWORD=voyager-demo-pass \
npm run dev:cleanup-devices
```

Review the dry-run first before using `INCLUDE_APP_DEVICES=1`.

## 4. Realtime Diagnostics

In the app:

```text
Settings -> About -> Advanced -> Realtime diagnostics
```

The panel shows:

- Socket state and connected flag.
- Reconnect count.
- Last `ready` timestamp.
- Last realtime event timestamp.
- Last event room id and server sequence.
- Last full sync duration.
- Last room sync duration.
- Last socket error, if any.

This is a development/testing surface. It is intentionally tucked under Advanced settings rather than exposed as product UX.

The adjacent call diagnostics panel shows the current call media state, peer/ICE
state, sampled aggregate byte estimates, candidate type, relay-likely hint, RTT,
and last usage-report status. It is powered by browser `getStats()` while media
is active and submits a metadata-only usage report during call media teardown.

## 5. Remote Post-Deploy Smoke

After the Worker deploys on `main`, GitHub Actions runs the all-Core parity
smoke because the dev deployment path uses `npm run deploy:dev`:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
VOYAGER_LOGIN_EMAIL=ada@example.com \
VOYAGER_LOGIN_PASSWORD=voyager-demo-pass \
SMOKE_MESSAGING_CORE_ALL_CUTOVER=1 \
npm run smoke:messaging-core-parity
```

The deployed Worker smoke remains available manually when validating a release
or a rollback deployment. It runs:

```bash
npm run smoke:backend:remote
```

against:

```text
https://voyager-api-dev.microgentic-voyager.workers.dev
```

That smoke logs in with the disposable seeded accounts, verifies
`/v1/app/bootstrap`, proves legacy `/v1/realtime` routes are gone, mints a
short-lived Messaging Core realtime token, exercises attachment upload/download/delete
and a basic audio call lifecycle plus aggregate call usage reporting in an
existing Ada/Grace room when available,
sends a direct message, waits for the exact matching Core `room.message`, then verifies
idempotent retry, Conversation DO timing headers, and HTTP recovery reads. It
acknowledges the smoke message, archives only a fallback room it had to create,
leaves any smoke call, deletes any unreferenced smoke attachment, and revokes the
temporary smoke devices when possible.

Manual run:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

See `docs/remote-post-deploy-smoke.md` for full details and troubleshooting.

After Cloudflare Realtime credentials and feature flags are configured, run the
opt-in provider media smoke:

```bash
REALTIME_SMOKE_MEDIA=1 \
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

For Messaging Core realtime validation, the web client uses the Core WebSocket
contract by default through `/v1/messaging-core/realtime/token`. To prove the
deployed Core WebSocket path through the active Voyager realtime token facade,
run:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
VOYAGER_LOGIN_EMAIL=ada@example.com \
VOYAGER_LOGIN_PASSWORD=voyager-demo-pass \
  npm run smoke:messaging-core-parity
```

The dev Worker and Pages deployment now use Messaging Core as the only
messaging runtime. There are no room/message/sync cutover flags to enable or
disable; keep `MESSAGING_CORE_BASE_URL`, `MESSAGING_CORE_TOKEN_SECRET`, and the
internal service secret configured, then run:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
VOYAGER_LOGIN_EMAIL=ada@example.com \
VOYAGER_LOGIN_PASSWORD=voyager-demo-pass \
  npm run smoke:messaging-core-parity
```

That smoke exercises normal Voyager login, Core session minting, bootstrap,
room list/detail, room writes, message send/list, sync, attachment
upload/download, thread inbox, Core realtime `ready`/`pong`, and Core
`room.message` delivery for a message sent through the normal Voyager route.
It fails if any JSON response contains `source: "voyager_legacy"`.
The old read-only `/v1/messaging-core/*` validation proxies and the
`/v1/admin/messaging-core/backfill-readonly` parity backfill utility have been
removed; the parity smoke now uses `/v1/me` for the Core session, direct Core
reads for Core health, `/v1/app/bootstrap` for normal app-bootstrap proof, and
normal Voyager cutover routes for app behavior proof.

Rollback means redeploying a rollback tag/branch or restoring the exported
D1/R2 backup from the pre-removal proof step. The normal Worker config no
longer carries a messaging fallback flag or live Voyager-owned messaging
runtime.

`node scripts/route-inventory-check.mjs` validates the boundary catalog:
room/message/attachment/thread/sync and app-bootstrap routes are Core runtime,
messaging identity/key-package routes are product token bridge routes, call
lifecycle/media routes are call runtime, and `/v1/messaging-core/realtime/token`
is the active Core realtime facade.

## 6. Manual Cross-Client Checklist

After this PR is deployed, manually verify:

- Web -> web messaging.
- Android -> web messaging.
- iOS -> web messaging.
- Desktop -> web messaging.
- Web -> Android/iOS/desktop receiving while the target app is foregrounded.
- Settings diagnostics show `connected` and recent room events after messages arrive.
- Remote post-deploy smoke passes against the deployed Worker.
- Device cleanup dry-run lists only expected stale test devices.

## 7. Desktop Packaged Startup Note

The packaged Tauri desktop app can start from `tauri://localhost/index.html`
instead of `/`. The auth route guard must treat both paths as the root splash.
If it only redirects authenticated users from `/`, a signed-in desktop launch can
resolve auth successfully but remain on the root spinner forever.

Desktop realtime also needs the Messaging Core WebSocket origin in the Tauri
CSP `connect-src`; allowing only the HTTPS API origin is not enough for the Core
WebSocket path returned by `/v1/messaging-core/realtime/token`.

The macOS app uses a desktop-only Tauri drag strip above the web shell. Keep it
out of web and mobile layouts so mobile safe-area behavior and browser spacing
do not regress. Active-window dragging depends on the Tauri v2
`core:window:allow-start-dragging` capability plus the explicit
`startDragging()` handler; `data-tauri-drag-region` alone may only behave
reliably for inactive-window activation drags.

## 8. Recommended Next Sequence

1. Keep the remote post-deploy smoke green on `main`.
2. Run the manual cross-client checklist above for each rebuilt client family.
3. Add a durable outbox/reconciler only if future work introduces separate durable Conversation DO state, push jobs, or other side-effect queues.
