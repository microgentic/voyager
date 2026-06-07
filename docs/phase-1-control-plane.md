# Phase 1 Control Plane

Status: pull request implementation notes

See `docs/backend-first-deviation.md` for the accepted backend-first deviation that removes active external blockers from this pass.

## Scope

This PR implements the Phase 1 backend control plane:

- D1 schema and migrations.
- Admin bootstrap endpoint.
- Account shell and invitation creation.
- Invitation acceptance with user-established password.
- Password login/logout.
- Password change and admin-issued credential reset.
- Session listing and revocation.
- Device listing, registration, login reuse, and own-device revocation.
- Admin account suspend/restore/auth-reset actions.
- Admin role grant/revoke.
- Admin-account hierarchy protection for privileged account and role actions.
- Policy listing and account policy assignment.
- Audit event recording and listing.
- Usage summary endpoint.
- Principal directory and manually created agent principals.
- Device key-package metadata APIs.
- Direct rooms and owner-only group room creation.
- Room membership, human room invitations, agent direct-add, roles, archiving, leaving, and ownership transfer.
- Opaque encrypted message envelopes with idempotency, sequencing, sync, and acknowledgements.
- Worker-mediated encrypted attachment allocation, upload, completion, download, and deletion.
- Sidebar collections.
- Agent request submission and admin review.
- CI type check, D1 migration, and Worker deployment workflow.

Password/passphrase authentication is active. Clients should persist `device.deviceId` and send it on password login to reuse an enrolled device; omitting it enrolls a new device. Passkeys/WebAuthn, push providers, app-store packaging, code signing, live agent runtimes, Durable Object realtime coordination, Queues, external identity providers, and provider webhooks are intentionally deferred for the backend-first path.

## Bootstrap

The first platform owner can be created only when `BOOTSTRAP_TOKEN` is configured as a Worker secret and no active `platform_owner` exists.

```bash
curl -X POST https://voyager-api-dev.microgentic-voyager.workers.dev/v1/admin/bootstrap \
  -H "content-type: application/json" \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -d '{
    "displayName": "Platform Owner",
    "email": "owner@example.com",
    "password": "use-a-long-unique-passphrase",
    "device": {
      "platform": "desktop",
      "label": "Bootstrap device"
    }
  }'
```

The response returns a bearer `sessionToken`. Use it for admin API calls:

```bash
Authorization: Bearer <sessionToken>
```

## Main Endpoints

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
- `POST /v1/devices/{device_id}/revoke` for an owned device
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
- `POST /v1/rooms/{room_id}/attachments`
- `PUT /v1/attachments/{attachment_id}/blob`
- `POST /v1/attachments/{attachment_id}/complete`
- `GET /v1/attachments/{attachment_id}/blob`
- `DELETE /v1/attachments/{attachment_id}`
- `GET /v1/sidebar-collections`
- `POST /v1/sidebar-collections`
- `PATCH /v1/sidebar-collections/{collection_id}`
- `DELETE /v1/sidebar-collections/{collection_id}`
- `POST /v1/sidebar-collections/{collection_id}/items`
- `DELETE /v1/sidebar-collections/{collection_id}/items/{room_id}`
- `GET /v1/agent-requests`
- `POST /v1/agent-requests`

Admin:

- `POST /v1/admin/invitations`
- `GET /v1/admin/accounts`
- `POST /v1/admin/accounts/{account_id}/suspend`
- `POST /v1/admin/accounts/{account_id}/restore`
- `POST /v1/admin/accounts/{account_id}/require-auth-reset`
- `POST /v1/admin/accounts/{account_id}/credential-reset`
- `PATCH /v1/admin/accounts/{account_id}/policy`
- `POST /v1/admin/accounts/{account_id}/roles`
- `DELETE /v1/admin/accounts/{account_id}/roles/{role_name}`
- `GET /v1/admin/policies`
- `GET /v1/admin/usage`
- `GET /v1/admin/audit-events`
- `GET /v1/admin/rooms`
- `GET /v1/admin/agent-requests`
- `PATCH /v1/admin/agent-requests/{request_id}`
- `POST /v1/admin/agents`
- `GET /v1/admin/maintenance/runs`
- `POST /v1/admin/maintenance/cleanup`

## Backend-First Test Path

The API can be exercised with curl or a plain fetch-based script:

1. Bootstrap the platform owner.
2. Create and accept user invitations.
3. Login with password/passphrase and collect bearer tokens.
4. Change passwords or complete admin credential reset tokens.
5. Publish, list, claim, and revoke device key-package metadata.
6. Create direct rooms or owner-only group rooms.
7. Send human room invitations or add manually created agent principals through the explicit member endpoint.
8. Send opaque encrypted envelopes with idempotency keys.
9. Sync pending messages and acknowledge them.
10. Allocate, upload, complete, download, and delete opaque attachment blobs.
11. Submit and review agent requests without contacting a live agent runtime.
12. Run admin cleanup and inspect maintenance history.

Pull requests must pass `npm run check` and `npm run smoke:backend:local`. The local smoke runner applies D1 migrations to a fresh Wrangler state directory, starts the Worker locally, and exercises the backend authorization and lifecycle paths end to end.
