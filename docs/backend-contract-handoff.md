# Backend Contract Handoff

Status: backend-first implementation handoff, currentized for active backend contract
Date: 2026-06-22
Related docs:

- `docs/project-architecture-plan.md`
- `docs/backend-first-deviation.md`
- `docs/phase-1-control-plane.md`
- `docs/pr4-final-hardening.md`
- `docs/realtime-messaging-handoff.md`
- `docs/backend-source-layout.md`

## 1. Project Backend Report

Voyager is currently implemented as a Cloudflare-hosted, backend-first secure communications API. The Worker is the primary contract surface for future desktop, web, mobile, admin, and agent clients. D1 stores authoritative metadata, R2 stores opaque private attachment blobs, and the Worker routes all HTTP requests through explicit versioned endpoints.

The active backend does not interpret message bodies. Messages are stored as opaque envelopes over HTTPS with routing metadata, retention timestamps, room sequence numbers, and delivery receipts. Attachments are uploaded as opaque private blobs, tracked by metadata, and only become message-referenced after the sender explicitly references them in an envelope. MLS end-to-end encryption and client-side attachment encryption remain future client-security work, not active backend guarantees.

The backend is designed to let development proceed without app stores, push providers, paid services, live agent runtimes, billing systems, custom domains, or signing infrastructure. That means clients can be developed against HTTP contracts, curl, and smoke scripts first. Realtime, push, mobile packaging, and production assurance work can be layered in later without replacing the core account, room, message, attachment, and admin models.

Source organization is documented in `docs/backend-source-layout.md`. The active backend route handler and Durable Object classes are exported through compatibility barrels, with route orchestration, Conversation DO coordination, backend-private domain types, domain serializers, shared utilities, and domain operations separated under `src/backend/`.

## 2. Current Backend Capability

- Health and metadata endpoints for Worker readiness checks.
- Platform-owner bootstrap guarded by `BOOTSTRAP_TOKEN`.
- Admin-created account invitations with activation tokens.
- Password/passphrase login, logout, password change, sessions, device enrollment/reuse, and own-device revocation.
- Admin credential reset tokens that lock an account, revoke sessions, optionally revoke devices, and let the user set a new password.
- Admin role grants/revocations and role-gated account, policy, audit, usage, room, agent, and maintenance endpoints.
- Admin-account hierarchy protections for credential reset, account lifecycle, policy changes, and role grants/revocations.
- Human and agent principals, with agents created manually by admins after an agent request review.
- Device key-package publication, listing, claiming, and revocation for later cryptographic clients.
- Direct one-to-one rooms and group rooms with owners, admins, members, agents, leaving, removal, archiving, and ownership transfer.
- Human room invitations for group membership acceptance/decline.
- Opaque message envelopes with idempotency keys, per-room Conversation Durable Object write coordination, server-side room sequencing, pending delivery receipts, sync, acknowledgements, edits, forwards, reactions, pins, and threads.
- Durable Object WebSocket event hints for near-immediate foreground message awareness, with HTTP sync still serving as the source of truth.
- R2-backed opaque attachment allocation, variant-aware original/preview/thumbnail upload, completion, authenticated variant download, pre-reference deletion, quota checks, and cleanup through the Worker. Generic delete and post-reference completion are blocked once an attachment is message-referenced.
- Durable call lifecycle with participants, call events, `CallCoordinator` serialization, Cloudflare Realtime session/track metadata, feature-flagged audio/video/screen media support, usage reports, diagnostics, and metadata-only cleanup. Call media flows through WebRTC/provider infrastructure and is never stored in D1 or R2.
- Sidebar collections for user-owned room organization metadata.
- Maintenance cleanup endpoint and maintenance run history.
- Fetch-based local, mock-Realtime, and remote backend smoke scripts that exercise the main API path end to end.

## 3. Decisions And Deviations

- External blockers remain deferred: iOS/Android builds, app stores, APNs/FCM, mobile background execution, production signing, notarization, billing, paid plans, production updater, hosted AI runtimes, encrypted cloud backups, public custom domain, and production assurance claims.
- Cloudflare Worker, D1, R2, Durable Objects, and Cloudflare Realtime are active dependencies because they are the chosen backend substrate, not deferred third-party blockers. Realtime credentials may be absent in local/dev environments; the API returns typed unconfigured responses instead of pretending media is active.
- Durable Objects are active for foreground realtime message event hints, per-room message-send coordination, room/membership mutation serialization, and call lifecycle/media mutation coordination. Queues, KV, Cron triggers, and push provider integrations are still deferred from the active code path. Cleanup is exposed as an admin HTTP endpoint for now so it can be tested with curl before a scheduler is introduced.
- Password/passphrase auth is active. Passkey/WebAuthn schema support remains future-ready, but live ceremonies are deferred with the external runtime dependency work.
- Room invitations are human-only for now. Agent principals are added directly by room admins because agents do not have an interactive acceptance UX while live agent runtimes are deferred.
- Group creation starts with the creator as owner only. Supplying `memberPrincipalIds` is rejected so human membership flows through invitations and agents are added through the explicit member endpoint.
- Realtime delivery uses Durable Object WebSockets for lightweight event hints. Conversation Durable Objects coordinate message writes, but HTTP sync and pending delivery receipts remain authoritative read/recovery paths. Push can consume the same message/receipt tables later as wake-up infrastructure.
- Attachments flow through the Worker for now. Direct-to-R2 signed upload URLs can be added later when browser/mobile CORS, upload progress, leakage, revocation, and client constraints are clearer.
- The server stores opaque envelopes and opaque private blobs only. Credential reset cannot recover future local or end-to-end encrypted content once client-side MLS/attachment encryption is active.

## 4. Backend Contracts For UI Handoff

- All protected routes use `Authorization: Bearer <sessionToken>`.
- Public bootstrap and activation routes return a `sessionToken` immediately after successful account creation or activation.
- Clients should persist the returned `device.deviceId`. Password login reuses that enrolled device when `device.deviceId` is supplied; omitting it intentionally enrolls a new device and consumes device quota.
- List endpoints that can grow return an array plus `nextCursor`. Current cursors are opaque to clients even though they are implemented as offsets internally.
- Clients should treat `nextCursor: null` as the end of a list.
- Password change requires the current password and does not log out the current session.
- Admin credential reset returns a one-time `resetToken`; the user completes it through `POST /v1/auth/password/reset/complete`. Issuing a new reset revokes older unused reset tokens for that account.
- Non-platform-owner administrators cannot reset, suspend, restore, policy-change, role-manage, or otherwise administer accounts with any active admin role.
- Only platform owners can grant or revoke `platform_owner`.
- The last active platform owner cannot be revoked.
- Device key packages are opaque JSON payloads to the backend. Clients own the cryptographic meaning.
- Message `ciphertext`, attachment blobs, key-package `package`, and cryptographic key fields are opaque to the Worker.
- Room membership authorization is enforced server-side for room reads, messages, attachments, and membership actions.
- Admin endpoints are role-gated; `platform_owner` satisfies all admin role checks.
- The UI may open `GET /v1/realtime` for foreground near-realtime events, but must still use `GET /v1/sync` and room/message list endpoints as the source of truth and recovery path.
- Realtime WebSockets use `POST /v1/realtime/token` to mint a short-lived one-use socket token; clients pass that token as the WebSocket subprotocol instead of the long-lived session token.
- Conversation-level Durable Objects now coordinate message-send sequencing, idempotency, and room/membership mutations per room. The coordinator stores no second durable room state; D1 remains the recovery and reconciliation source.
- Conversation-routed writes expose `Server-Timing` metrics for the Durable Object hop, queue wait, and operation time. The Worker also logs `conversation.do.message` and `conversation.do.mutation` entries with request id, room id, operation/result, and timings.
- Call endpoints expose durable lifecycle and participant state over HTTP. Realtime events are hints only; clients recover authoritative call state through call read endpoints. Realtime media endpoints keep provider secrets server-side, store provider metadata only, and return `configured: false` when Cloudflare Realtime is unavailable in the current environment.

## 5. Important Endpoint Groups

Public:

- `GET /health`
- `GET /v1/meta`
- `GET /v1/admin/bootstrap/status`
- `POST /v1/admin/bootstrap`
- `POST /v1/invitations/accept`
- `POST /v1/auth/password/login`
- `POST /v1/auth/password/reset/complete`

Authenticated user:

- `GET /v1/me`
- `POST /v1/auth/logout`
- `POST /v1/auth/password/change`
- `GET /v1/sessions`
- `DELETE /v1/sessions/{session_id}`
- `GET /v1/devices`
- `POST /v1/devices`
- `POST /v1/devices/{device_id}/revoke` for devices owned by the authenticated account.
- `POST /v1/admin/devices/test-cleanup` for platform-owner dry-run/apply cleanup of stale test devices.
- `GET /v1/principals`
- `GET /v1/principals/{principal_id}/devices`
- `GET /v1/devices/{device_id}/key-packages`
- `POST /v1/devices/{device_id}/key-packages`
- `GET /v1/principals/{principal_id}/key-packages`
- `POST /v1/key-packages/{key_package_id}/claim`
- `POST /v1/key-packages/{key_package_id}/revoke`
- `GET /v1/rooms`
- `POST /v1/rooms/direct`
- `POST /v1/rooms/groups`
- `GET /v1/rooms/{room_id}`
- `PATCH /v1/rooms/{room_id}`
- `POST /v1/rooms/{room_id}/archive`
- `POST /v1/rooms/{room_id}/members`
- `POST /v1/rooms/{room_id}/invitations`
- `GET /v1/room-invitations`
- `POST /v1/room-invitations/{room_invitation_id}/accept`
- `POST /v1/room-invitations/{room_invitation_id}/decline`
- `PATCH /v1/rooms/{room_id}/members/{principal_id}/role`
- `DELETE /v1/rooms/{room_id}/members/{principal_id}`
- `POST /v1/rooms/{room_id}/leave`
- `POST /v1/rooms/{room_id}/ownership-transfers`
- `POST /v1/rooms/{room_id}/ownership-transfers/{transfer_id}/accept`
- `GET /v1/rooms/{room_id}/messages`
- `POST /v1/rooms/{room_id}/messages`
- `POST /v1/rooms/{room_id}/messages/{envelope_id}/ack`
- `GET /v1/sync`
- `POST /v1/realtime/token`
- `GET /v1/realtime` WebSocket upgrade for lightweight `room.message` event hints.
- Attachment, call, sidebar collection, thread, and agent request endpoints are documented in `docs/api-contract.md`.

Admin:

- Account invitation, listing, suspend/restore, auth reset, credential reset, policy, and role endpoints.
- Policy, usage, audit, room inventory, agent request, agent creation, maintenance cleanup, and maintenance run endpoints.

## 6. Backend Work Still Worth Doing Before UI

- Add formal request/response schema validation and shared TypeScript contract exports.
- Promote the smoke coverage into narrower shared contract tests once request/response schemas are exported.
- Add filtered pagination to more list endpoints, especially accounts, audit events, sessions, devices, and messages.
- Add room invitation revocation for room owners/admins.
- Add direct-room reuse or duplicate detection so repeated direct-room creation can be idempotent.
- Add message retention purge behavior after an additional grace window.
- Broaden attachment cleanup QA as retention and client encryption semantics mature.
- Add local development seed helpers for repeatable UI testing fixtures.

## 7. Verification Path

Use the local backend smoke runner to apply migrations, start the Worker against a fresh local Wrangler state directory, and exercise the API end to end. For structure changes, run the full backend/frontend verification set:

```bash
npm run check
npm --prefix apps/client run check
npm --prefix apps/client run build
node scripts/route-inventory-check.mjs
node --check scripts/backend-first-smoke.mjs
node --check scripts/remote-post-deploy-smoke.mjs
npm run smoke:backend:local
CLOUDFLARE_REALTIME_MOCK=1 npm run smoke:backend:local
npx wrangler deploy --dry-run
git diff --check
```

The smoke path runs in GitHub PR checks and covers bootstrap, invitation one-time use, login with device reuse, password change, credential reset token revocation/reuse failure, suspended reset protection, key packages, direct-room cardinality, group initial-member rejection, human invitation enforcement, room invitations, messages, Conversation Durable Object message sequencing and mutation serialization, Conversation DO timing headers, Durable Object realtime event hints, sync, acknowledgements, attachment allocation/upload/variant download/delete cleanup, sidebar collections, agent requests, call lifecycle, Realtime unconfigured and mock-provider paths, call usage reports, lower-admin versus admin-account failures, lower-admin normal-account administration, cross-account device revoke failure, admin listing, permission failure, cleanup, and maintenance history.

On `main` deploys, the Worker workflow also runs `npm run smoke:backend:remote` after remote D1 migrations and Worker deployment. That smoke verifies the deployed dev Worker with seeded disposable accounts, including `/v1/app/bootstrap`, attachment upload/download/delete against the deployed R2 binding, basic audio call lifecycle, short-lived realtime socket tokens, WebSocket `room.message` delivery, idempotent retry, Conversation DO timing headers, and HTTP recovery reads.
