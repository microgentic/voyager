# Backend Contract Handoff

Status: backend-first implementation handoff
Date: 2026-06-07
Related docs:

- `docs/project-architecture-plan.md`
- `docs/backend-first-deviation.md`
- `docs/phase-1-control-plane.md`
- `docs/pr4-final-hardening.md`
- `docs/realtime-messaging-handoff.md`

## 1. Project Backend Report

Voyager is currently implemented as a Cloudflare-hosted, backend-first secure communications API. The Worker is the primary contract surface for future desktop, web, mobile, admin, and agent clients. D1 stores authoritative metadata, R2 stores opaque encrypted attachment blobs, and the Worker routes all HTTP requests through explicit versioned endpoints.

The active backend does not try to decrypt user content. Messages are stored as opaque encrypted envelopes with routing metadata, retention timestamps, room sequence numbers, and delivery receipts. Attachments are uploaded as opaque blobs, tracked by metadata, and only become message-referenced after the sender explicitly references them in an encrypted envelope.

The backend is designed to let development proceed without app stores, push providers, paid services, live agent runtimes, billing systems, custom domains, or signing infrastructure. That means clients can be developed against HTTP contracts, curl, and smoke scripts first. Realtime, push, mobile packaging, and production assurance work can be layered in later without replacing the core account, room, message, attachment, and admin models.

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
- Opaque message envelopes with idempotency keys, server-side room sequencing, pending delivery receipts, sync, and acknowledgements.
- Durable Object WebSocket event hints for near-immediate foreground message awareness, with HTTP sync still serving as the source of truth.
- R2-backed opaque attachment allocation, upload, completion, download, and deletion through the Worker.
- Sidebar collections for user-owned room organization metadata.
- Maintenance cleanup endpoint and maintenance run history.
- Fetch-based backend smoke script that exercises the main API path end to end.

## 3. Decisions And Deviations

- External blockers remain deferred: iOS/Android builds, app stores, APNs/FCM, mobile background execution, production signing, notarization, billing, paid plans, production updater, hosted AI runtimes, encrypted cloud backups, public custom domain, and production assurance claims.
- Cloudflare Worker, D1, and R2 are active dependencies because they are the chosen backend substrate, not deferred third-party blockers.
- Durable Objects are active for foreground realtime message event hints. Queues, KV, Cron triggers, and push provider integrations are still deferred from the active code path. Cleanup is exposed as an admin HTTP endpoint for now so it can be tested with curl before a scheduler is introduced.
- Password/passphrase auth is active. Passkey/WebAuthn schema support remains future-ready, but live ceremonies are deferred with the external runtime dependency work.
- Room invitations are human-only for now. Agent principals are added directly by room admins because agents do not have an interactive acceptance UX while live agent runtimes are deferred.
- Group creation starts with the creator as owner only. Supplying `memberPrincipalIds` is rejected so human membership flows through invitations and agents are added through the explicit member endpoint.
- Realtime delivery uses Durable Object WebSockets for lightweight event hints. HTTP sync and pending delivery receipts remain authoritative, and push can consume the same message/receipt tables later as wake-up infrastructure.
- Attachments flow through the Worker for now. Direct-to-R2 signed upload URLs can be added later when browser/mobile CORS, upload progress, and client constraints are clearer.
- The server stores encrypted envelopes and opaque blobs only. Credential reset cannot recover local or end-to-end encrypted content.

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
- `GET /v1/realtime` currently authenticates browser/WebView clients with the session token as a WebSocket subprotocol. A short-lived realtime token endpoint remains future production hardening.
- Conversation-level Durable Objects for sequencing, idempotency, membership mutation serialization, and D1/DO reconciliation are not implemented yet. The current Durable Object layer is foreground mailbox/session fanout.

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
- `GET /v1/realtime` WebSocket upgrade for lightweight `room.message` event hints.
- Attachment, sidebar collection, and agent request endpoints documented in `docs/phase-1-control-plane.md`.

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
- Add attachment orphan cleanup that also deletes expired unreferenced R2 objects.
- Add local development seed helpers for repeatable UI testing fixtures.

## 7. Verification Path

Use the local backend smoke runner to apply migrations, start the Worker against a fresh local Wrangler state directory, and exercise the API end to end:

```bash
npm run check
npm run smoke:backend:local
```

The smoke path runs in GitHub PR checks and covers bootstrap, invitation one-time use, login with device reuse, password change, credential reset token revocation/reuse failure, suspended reset protection, key packages, direct-room cardinality, group initial-member rejection, human invitation enforcement, room invitations, messages, Durable Object realtime event hints, sync, acknowledgements, attachments, sidebar collections, agent requests, lower-admin versus admin-account failures, lower-admin normal-account administration, cross-account device revoke failure, admin listing, permission failure, cleanup, and maintenance history.
