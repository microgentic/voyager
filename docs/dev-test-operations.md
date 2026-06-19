# Dev/Test Operations and Realtime Diagnostics

Status: development operations support
Date: 2026-06-19
Related docs:

- `docs/realtime-performance-handoff.md`
- `docs/realtime-messaging-handoff.md`
- `docs/frontend-web-desktop-handoff.md`
- `docs/mobile-ios-handoff.md`
- `docs/mobile-android-handoff.md`

## 1. Purpose

This pass adds two small operational tools for the current multi-client testing phase:

- A platform-owner-only cleanup endpoint and CLI script for stale test devices.
- A compact realtime diagnostics view in Settings -> Advanced.

It does not freeze the API contract and does not implement Conversation Durable Object sequencing.

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

## 5. Manual Cross-Client Checklist

After this PR is deployed, manually verify:

- Web -> web messaging.
- Android -> web messaging.
- iOS -> web messaging.
- Desktop -> web messaging.
- Web -> Android/iOS/desktop receiving while the target app is foregrounded.
- Settings diagnostics show `connected` and recent room events after messages arrive.
- Device cleanup dry-run lists only expected stale test devices.

## 6. Recommended Next Sequence

1. Merge this dev/test operations PR.
2. Run the manual cross-client checklist above.
3. Create the shared API contract/schema freeze PR.
4. Consider Conversation Durable Object sequencing only after the current client behavior and API contract are stable.
