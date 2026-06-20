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
- A remote post-deploy smoke script for the deployed dev Worker.

It does not freeze the API contract. Conversation Durable Objects now coordinate message sends; membership mutation serialization remains future work.

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

## 5. Remote Post-Deploy Smoke

After the Worker deploys on `main`, GitHub Actions runs:

```bash
npm run smoke:backend:remote
```

against:

```text
https://voyager-api-dev.microgentic-voyager.workers.dev
```

The smoke logs in with the disposable seeded accounts, verifies
`/v1/app/bootstrap`, proves session tokens cannot directly open `/v1/realtime`,
mints a short-lived realtime token, sends a direct message in an existing
Ada/Grace room when available, waits for the exact matching `room.message`, then
verifies HTTP recovery reads. It acknowledges the smoke message, archives only a
fallback room it had to create, and revokes the temporary smoke devices when
possible.

Manual run:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```

See `docs/remote-post-deploy-smoke.md` for full details and troubleshooting.

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

Desktop realtime also needs the Worker WebSocket origin in the Tauri CSP
`connect-src`; allowing only the HTTPS API origin is not enough for
`wss://.../v1/realtime`.

The macOS app uses a desktop-only Tauri drag strip above the web shell. Keep it
out of web and mobile layouts so mobile safe-area behavior and browser spacing
do not regress. Active-window dragging depends on the Tauri v2
`core:window:allow-start-dragging` capability plus the explicit
`startDragging()` handler; `data-tauri-drag-region` alone may only behave
reliably for inactive-window activation drags.

## 8. Recommended Next Sequence

1. Keep the remote post-deploy smoke green on `main`.
2. Run the manual cross-client checklist above for each rebuilt client family.
3. Continue Conversation Durable Object work with membership mutation serialization only after the current deployed smoke and foreground client behavior are stable.
