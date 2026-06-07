# Phase 1 Control Plane

Status: pull request implementation notes

## Scope

This PR implements the Phase 1 backend control plane:

- D1 schema and migrations.
- Admin bootstrap endpoint.
- Account shell and invitation creation.
- Invitation acceptance with user-established password.
- Password login/logout.
- Session listing and revocation.
- Device listing, registration, and revocation.
- Admin account suspend/restore/auth-reset actions.
- Admin role grant/revoke.
- Policy listing and account policy assignment.
- Audit event recording and listing.
- Usage summary endpoint.
- Passkey/WebAuthn registration and login ceremonies.
- CI type check, D1 migration, and Worker deployment workflow.

Password/passphrase fallback and passkey login both exist. Passkeys are implemented with server-side WebAuthn challenge storage, credential verification, replay counter updates, and authenticator audit records.

WebAuthn defaults to the Worker request origin and hostname. When a separate frontend origin is introduced, configure `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID` on the Worker so browser-origin validation matches the frontend host.

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
- `POST /v1/auth/passkeys/login/options`
- `POST /v1/auth/passkeys/login/verify`

Authenticated user:

- `GET /v1/me`
- `POST /v1/auth/logout`
- `POST /v1/auth/passkeys/register/options`
- `POST /v1/auth/passkeys/register/verify`
- `GET /v1/sessions`
- `DELETE /v1/sessions/{session_id}`
- `GET /v1/devices`
- `POST /v1/devices`
- `POST /v1/devices/{device_id}/revoke`

Admin:

- `POST /v1/admin/invitations`
- `GET /v1/admin/accounts`
- `POST /v1/admin/accounts/{account_id}/suspend`
- `POST /v1/admin/accounts/{account_id}/restore`
- `POST /v1/admin/accounts/{account_id}/require-auth-reset`
- `PATCH /v1/admin/accounts/{account_id}/policy`
- `POST /v1/admin/accounts/{account_id}/roles`
- `DELETE /v1/admin/accounts/{account_id}/roles/{role_name}`
- `GET /v1/admin/policies`
- `GET /v1/admin/usage`
- `GET /v1/admin/audit-events`

## Passkey Flow

Registration requires an authenticated session:

1. `POST /v1/auth/passkeys/register/options` with bearer auth.
2. Frontend calls `navigator.credentials.create()` with the returned `options`.
3. `POST /v1/auth/passkeys/register/verify` with the browser credential response and bearer auth.

Login is public:

1. `POST /v1/auth/passkeys/login/options` with the account email.
2. Frontend calls `navigator.credentials.get()` with the returned `options`.
3. `POST /v1/auth/passkeys/login/verify` with the browser credential response and optional `device` metadata.

Successful passkey login creates a normal device/session pair and returns a bearer `sessionToken`, the same as password login.
