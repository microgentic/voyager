# Voyager API Contract

Status: current `/v1` contract after the startup/read-path optimization pass

## Purpose

This document is the canonical contract reference for Voyager clients and future agents. It describes the API that is implemented today. It does not redesign routes, rename fields, change authentication, or introduce MLS, push, billing, or production agent-runtime architecture.

The current contract is intentionally additive-first:

- New response fields may be added without a breaking version bump.
- Existing fields and routes should not be renamed or removed without a migration note.
- Experimental or dev-only endpoints must stay labeled.
- A future `/v2` can be documented later if the contract needs a breaking redesign.

## Stability Labels

`stable/current` means frontend, desktop, iOS, Android, and future client agents can build against the endpoint as the current `/v1` surface.

`admin/dev-only` means the endpoint is for operators, setup, smoke tests, or development utilities. It is not product UI surface for ordinary users.

`future-sensitive` means the endpoint exists or the payload shape exists today, but future security or architecture work may change its semantics.

## Common Conventions

All JSON endpoints return `content-type: application/json; charset=utf-8`, `cache-control: no-store`, and a top-level `ok` flag.

Successful responses use:

```json
{
  "ok": true
}
```

Most successful responses include one named payload field, for example:

```json
{
  "ok": true,
  "room": {}
}
```

Error responses use:

```json
{
  "ok": false,
  "error": "forbidden",
  "message": "Forbidden",
  "requestId": "req_...",
  "details": {}
}
```

`details` is optional. Clients should display `message` where helpful, branch on `error` only for expected flows, and log `requestId` for diagnostics.

Authenticated endpoints use:

```http
Authorization: Bearer <sessionToken>
```

The API does not use browser cookies for authentication. Revoked, expired, or device-invalid sessions fail immediately.

Paginated list endpoints use `limit` and sometimes `cursor`. Responses use:

```json
{
  "ok": true,
  "itemsOrNamedList": [],
  "nextCursor": null
}
```

Current cursors are opaque string offsets. Clients must not parse them.

Read and startup endpoints expose timing diagnostics through the `Server-Timing` response header. CORS exposes that header to browser clients.

## Official Startup Flow

`GET /v1/app/bootstrap?limit=100` is the official first authenticated data request after a client has a session token.

The startup sequence is:

1. `POST /v1/auth/password/login`
2. Store the returned `sessionToken`
3. `GET /v1/app/bootstrap?limit=100`
4. Hydrate identity, roles, rooms, and pending messages from the bootstrap payload
5. `POST /v1/realtime/token`
6. Open `GET /v1/realtime` with the returned short-lived token for foreground event hints
7. Defer supporting reads such as principals, room invitations, and sidebar collections until after first paint

`GET /v1/me`, `GET /v1/rooms`, and `GET /v1/sync` remain supported for compatibility and recovery.

Bootstrap response:

```json
{
  "ok": true,
  "bootstrap": {
    "account": {},
    "principal": {},
    "device": {},
    "roles": [],
    "rooms": [],
    "roomsNextCursor": null,
    "pendingMessages": [],
    "serverTime": "2026-06-20T00:00:00.000Z",
    "requestId": "req_..."
  }
}
```

## Stable Current Endpoints

### Meta And Health

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | service health and binding status |
| `GET` | `/v1/meta` | API version metadata |

### Auth, Sessions, And Devices

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/auth/password/login` | `{ account, principal, device, sessionToken }` |
| `POST` | `/v1/auth/logout` | `{ ok: true }` |
| `POST` | `/v1/auth/password/change` | `{ ok: true }` |
| `POST` | `/v1/auth/password/reset/complete` | `{ account, principal, device, sessionToken }` |
| `GET` | `/v1/me` | `{ account, principal, device, roles }` |
| `POST` | `/v1/realtime/token` | `{ realtimeToken, expiresAt }` |
| `GET` | `/v1/sessions` | `{ sessions }` |
| `DELETE` | `/v1/sessions/{sessionId}` | `{ ok: true }` |
| `GET` | `/v1/devices` | `{ devices }` |
| `POST` | `/v1/devices` | `{ device }` |
| `POST` | `/v1/devices/{deviceId}/revoke` | `{ ok: true }` |

Login accepts `email`, `password`, and an optional `device` object. Existing-device login may send `device.deviceId`. Today that is a development contract; future device private-key proof can extend this without changing the route.

### Principals And Key Packages

| Method | Path | Response | Stability |
| --- | --- | --- | --- |
| `GET` | `/v1/principals` | `{ principals }` | stable/current |
| `GET` | `/v1/principals/{principalId}/devices` | `{ devices }` | stable/current |
| `GET` | `/v1/devices/{deviceId}/key-packages` | `{ keyPackages, nextCursor }` | future-sensitive |
| `POST` | `/v1/devices/{deviceId}/key-packages` | `{ keyPackage }` | future-sensitive |
| `GET` | `/v1/principals/{principalId}/key-packages` | `{ keyPackages }` | future-sensitive |
| `POST` | `/v1/key-packages/{keyPackageId}/claim` | `{ keyPackage }` | future-sensitive |
| `POST` | `/v1/key-packages/{keyPackageId}/revoke` | `{ ok: true }` | future-sensitive |

Key package payloads are opaque to the backend. MLS/E2EE semantics are future-sensitive.

### Rooms, Memberships, Messages, And Sync

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/rooms` | `{ rooms, nextCursor }` |
| `POST` | `/v1/rooms/direct` | `{ room }` |
| `POST` | `/v1/rooms/groups` | `{ room }` |
| `GET` | `/v1/rooms/{roomId}` | `{ room }` |
| `PATCH` | `/v1/rooms/{roomId}` | `{ room }` |
| `POST` | `/v1/rooms/{roomId}/archive` | `{ room }` |
| `POST` | `/v1/rooms/{roomId}/members` | `{ member }` |
| `PATCH` | `/v1/rooms/{roomId}/members/{principalId}/role` | `{ member }` |
| `DELETE` | `/v1/rooms/{roomId}/members/{principalId}` | `{ ok: true }` |
| `POST` | `/v1/rooms/{roomId}/leave` | `{ ok: true }` |
| `POST` | `/v1/rooms/{roomId}/ownership-transfers` | `{ transfer }` |
| `POST` | `/v1/rooms/{roomId}/ownership-transfers/{transferId}/accept` | `{ transfer }` |
| `GET` | `/v1/rooms/{roomId}/messages` | `{ messages }` |
| `POST` | `/v1/rooms/{roomId}/messages` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/delete` | `{ deleted: { scope, envelopeIds } }` |
| `PATCH` | `/v1/rooms/{roomId}/messages/{envelopeId}` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/{envelopeId}/reactions` | `{ message }` |
| `DELETE` | `/v1/rooms/{roomId}/messages/{envelopeId}/reactions/{reaction}` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/{envelopeId}/pin` | `{ message }` |
| `DELETE` | `/v1/rooms/{roomId}/messages/{envelopeId}/pin` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/{envelopeId}/ack` | `{ receipt }` |
| `GET` | `/v1/sync` | `{ sync: { rooms, roomsNextCursor, pendingMessages } }` |

Group creation rejects initial `memberPrincipalIds`. Human members join through room invitations. Agent principals may be added through the explicit member endpoint.

Message sends require an `idempotencyKey`, `protocolType`, and opaque `ciphertext`. `serverSequence` is assigned by the backend. `GET /v1/rooms/{roomId}/messages` supports forward reads with `after` and `limit`.

Message responses include additive edit and delivery metadata:

```json
{
  "editedAt": null,
  "editCount": 0,
  "receiptSummary": {
    "total": 1,
    "pending": 0,
    "delivered": 1,
    "read": 0,
    "status": "delivered"
  },
  "reactions": [
    {
      "reaction": "👍",
      "count": 2,
      "reactedByMe": true
    }
  ],
  "pin": {
    "pinned": true,
    "pinnedAt": "2026-06-21 12:00:00",
    "pinnedByPrincipalId": "prn_..."
  }
}
```

`receiptSummary.status` is the client-facing mirror signal: `sent`, `delivered`, or `read`. Receipt rows remain per-device internally, and the compact status advances when at least one recipient device reaches the delivered/read state; use the numeric counts for detailed delivery diagnostics. `PATCH /v1/rooms/{roomId}/messages/{envelopeId}` lets the original sender replace the current opaque payload for an active, non-expired message. The previous opaque payload is preserved in `message_edits`; the active message keeps the same `envelopeId` and `serverSequence`.

Reactions are room message metadata. `POST /reactions` accepts `{ "reaction": "👍" }` and is idempotent per `(message, principal)`: a caller has one active reaction per message, and posting a different reaction replaces the previous one. `DELETE /reactions/{reaction}` removes only the caller's matching active reaction. Message `reactions[].reactedByMe` is viewer-specific; counts are room-wide.

Pins are room message metadata. Direct-room participants may pin or unpin messages; group/channel pins require an owner or admin role. Pin/unpin responses return the updated message envelope. Room responses also include `pinnedMessageCount` and `latestPinnedMessageId`.

Message deletion currently supports delete-for-me only:

```json
{
  "scope": "for_me",
  "envelopeIds": ["msg_..."]
}
```

Delete-for-me records per-account visibility, hides those envelopes from room history, `/v1/sync`, and `/v1/app/bootstrap` for that account, and does not remove the durable message row or hide it from other members.

### Room Invitations

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/rooms/{roomId}/invitations` | `{ invitation }` |
| `GET` | `/v1/room-invitations` | `{ invitations, nextCursor }` |
| `POST` | `/v1/room-invitations/{roomInvitationId}/accept` | `{ invitation }` |
| `POST` | `/v1/room-invitations/{roomInvitationId}/decline` | `{ invitation }` |

Room invitations are the human membership path. Reused, expired, declined, or revoked invitations must fail instead of creating duplicate active membership.

### Attachments

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/rooms/{roomId}/attachments` | `{ attachment }` |
| `PUT` | `/v1/attachments/{attachmentId}/blob` | binary upload response |
| `GET` | `/v1/attachments/{attachmentId}/blob` | binary payload |
| `POST` | `/v1/attachments/{attachmentId}/complete` | `{ attachment }` |
| `DELETE` | `/v1/attachments/{attachmentId}` | `{ ok: true }` |

Attachment bytes are opaque encrypted blobs from the backend perspective. R2 stores the blob; D1 stores metadata and state.

### Sidebar Collections

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/sidebar-collections` | `{ collections }` |
| `POST` | `/v1/sidebar-collections` | `{ collection }` |
| `PATCH` | `/v1/sidebar-collections/{collectionId}` | `{ collection }` |
| `DELETE` | `/v1/sidebar-collections/{collectionId}` | `{ ok: true }` |
| `POST` | `/v1/sidebar-collections/{collectionId}/items` | `{ ok: true }` |
| `DELETE` | `/v1/sidebar-collections/{collectionId}/items/{roomId}` | `{ ok: true }` |

### Agent Requests

| Method | Path | Response | Stability |
| --- | --- | --- | --- |
| `GET` | `/v1/agent-requests` | `{ requests, nextCursor }` | stable/current request workflow |
| `POST` | `/v1/agent-requests` | `{ request }` | stable/current request workflow |
| `GET` | `/v1/admin/agent-requests` | `{ requests, nextCursor }` | admin/dev-only |
| `PATCH` | `/v1/admin/agent-requests/{requestId}` | `{ request }` | admin/dev-only |
| `POST` | `/v1/admin/agents` | `{ agent }` | future-sensitive runtime provisioning |

The request/review workflow is current. Real hosted AI runtimes remain deferred.

## Realtime Contract

Clients mint a short-lived socket token before opening the WebSocket:

```http
POST /v1/realtime/token
Authorization: Bearer <sessionToken>
```

Response:

```json
{
  "ok": true,
  "realtimeToken": "vgr_...",
  "expiresAt": "2026-06-20 00:00:00"
}
```

`GET /v1/realtime` upgrades to a WebSocket. Browser and WebView clients authenticate with subprotocols:

```ts
new WebSocket(url, ["voyager.realtime.v1", realtimeToken]);
```

The server responds with the selected protocol:

```text
voyager.realtime.v1
```

Realtime events are hints only. Clients must recover authoritative state through `GET /v1/rooms/{roomId}`, `GET /v1/rooms/{roomId}/messages`, or `GET /v1/sync`. When a room hint carries `serverSequence`, foreground clients should fetch the exact message window with `GET /v1/rooms/{roomId}/messages?after={serverSequence - 1}&limit=1`; broader overlap/sync remains the fallback for sequence-less hints and missed events.

Realtime tokens are one-use, short-lived socket credentials bound to the issuing account, session, device, and principal. Revoked sessions, expired sessions, revoked devices, inactive accounts, expired tokens, and reused tokens cannot open the socket. Clients should request a fresh realtime token for every reconnect attempt.

Realtime token minting is rate-limited per account/device. Token expiration is checked when opening the socket; an already-open socket may remain connected after the token's `expiresAt`.

Ready event:

```json
{
  "type": "ready",
  "accountId": "acc_...",
  "principalId": "prn_...",
  "deviceId": "dev_...",
  "createdAt": "2026-06-20T00:00:00.000Z"
}
```

Heartbeat response:

```json
{
  "type": "pong",
  "id": "client-ping-id",
  "createdAt": "2026-06-20T00:00:00.000Z"
}
```

Room message event:

```json
{
  "type": "room.message",
  "eventId": "uuid",
  "createdAt": "2026-06-20T00:00:00.000Z",
  "roomId": "room_...",
  "envelopeId": "msg_...",
  "serverSequence": 42,
  "senderDeviceId": "dev_..."
}
```

Room sync event:

```json
{
  "type": "room.sync",
  "eventId": "uuid",
  "createdAt": "2026-06-20T00:00:00.000Z",
  "roomId": "room_...",
  "envelopeId": "msg_...",
  "serverSequence": 42
}
```

## Admin And Dev-Only Endpoints

These routes are intentionally not ordinary product UI surface:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/admin/bootstrap/status` | setup status |
| `POST` | `/v1/admin/bootstrap` | first platform owner setup |
| `POST` | `/v1/admin/invitations` | account invitation |
| `POST` | `/v1/invitations/accept` | account activation by token |
| `GET` | `/v1/admin/accounts` | account administration |
| `POST` | `/v1/admin/accounts/{accountId}/suspend` | suspend account |
| `POST` | `/v1/admin/accounts/{accountId}/restore` | restore account |
| `POST` | `/v1/admin/accounts/{accountId}/require-auth-reset` | lock account pending reset |
| `POST` | `/v1/admin/accounts/{accountId}/credential-reset` | issue reset token |
| `PATCH` | `/v1/admin/accounts/{accountId}/policy` | update account policy |
| `POST` | `/v1/admin/accounts/{accountId}/roles` | grant admin role |
| `DELETE` | `/v1/admin/accounts/{accountId}/roles/{roleName}` | revoke admin role |
| `GET` | `/v1/admin/policies` | list policies |
| `GET` | `/v1/admin/usage` | usage summary |
| `GET` | `/v1/admin/audit-events` | audit event list |
| `GET` | `/v1/admin/rooms` | admin room list |
| `POST` | `/v1/admin/devices/test-cleanup` | stale test-device cleanup |
| `GET` | `/v1/admin/maintenance/runs` | maintenance history |
| `POST` | `/v1/admin/maintenance/cleanup` | explicit cleanup run |

Admin hierarchy is part of the security contract: only platform owners may administer accounts with active administrative roles.

## Examples

### Login And Bootstrap

```bash
curl -sS "$BASE_URL/v1/auth/password/login" \
  -H 'content-type: application/json' \
  --data '{
    "email": "ada@example.com",
    "password": "voyager-demo-pass",
    "device": {
      "platform": "web",
      "label": "Browser",
      "clientVersion": "dev",
      "protocolVersion": "opaque-test"
    }
  }'
```

Use the returned `sessionToken`:

```bash
curl -sS "$BASE_URL/v1/app/bootstrap?limit=100" \
  -H "authorization: Bearer $SESSION_TOKEN"
```

### Send A Message With Idempotency

```bash
curl -sS "$BASE_URL/v1/rooms/$ROOM_ID/messages" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "idempotencyKey": "client-generated-unique-id",
    "protocolType": "opaque-test",
    "ciphertext": "opaque-client-payload"
  }'
```

If the same idempotency key is retried for the same room and sender device, the API returns the existing message instead of creating a duplicate.

### Edit A Message

```bash
curl -sS "$BASE_URL/v1/rooms/$ROOM_ID/messages/$ENVELOPE_ID" \
  -X PATCH \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "protocolType": "opaque-test",
    "ciphertext": "opaque-client-payload-edited",
    "clientEditedAt": "2026-06-21T12:00:00.000Z"
  }'
```

Only the sending principal may edit the message. The response returns the updated envelope with the same `envelopeId` and `serverSequence`.

### Delete Messages For Me

```bash
curl -sS "$BASE_URL/v1/rooms/$ROOM_ID/messages/delete" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "scope": "for_me",
    "envelopeIds": ["msg_..."]
  }'
```

The response returns the hidden envelope IDs. Other members continue to recover the same messages through normal room reads and sync.

### Realtime Recovery

When a receiver gets:

```json
{
  "type": "room.message",
  "roomId": "room_...",
  "envelopeId": "msg_...",
  "serverSequence": 42
}
```

the client should immediately refresh the specific room:

```bash
curl -sS "$BASE_URL/v1/rooms/$ROOM_ID" \
  -H "authorization: Bearer $SESSION_TOKEN"

curl -sS "$BASE_URL/v1/rooms/$ROOM_ID/messages?after=41" \
  -H "authorization: Bearer $SESSION_TOKEN"
```

If the socket is unavailable or an event is missed, recover through:

```bash
curl -sS "$BASE_URL/v1/sync?limit=100" \
  -H "authorization: Bearer $SESSION_TOKEN"
```

### Dev-Only Device Cleanup

```bash
curl -sS "$BASE_URL/v1/admin/devices/test-cleanup" \
  -H "authorization: Bearer $PLATFORM_OWNER_SESSION_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "dryRun": true,
    "accountEmails": ["ada@example.com"],
    "labelMatchers": ["smoke", "simulator", "emulator", "cleanup cli"],
    "platformMatchers": ["smoke", "test", "probe"],
    "includeKnownAppDevices": false,
    "includeCurrentDevice": false,
    "keepNewestPerAccount": 1,
    "reason": "manual_dev_cleanup_review"
  }'
```

This endpoint is for disposable test accounts and development device cleanup only.

## TypeScript Contract Source

The current shared TypeScript mirror lives in:

```text
apps/client/src/lib/api/types.ts
```

It mirrors the Worker public serializers and exports common API envelopes, paginated response aliases, entity types, request payloads, bootstrap/sync types, and realtime event unions. A separate package can be introduced later if the repo adopts workspaces, but this PR keeps the contract in the existing client code path.

## Executable Contract Checks

The local backend smoke test validates the most important stable response shapes with `scripts/api-contract-assertions.mjs`:

```bash
npm run smoke:backend:local
```

Those assertions cover common error payloads, auth results, bootstrap, sync, rooms, room invitations, messages, realtime token minting, realtime `room.message` events, key packages, attachments, sidebar collections, and agent request surfaces. They are intentionally additive-friendly: new fields are allowed, but missing or renamed contract fields fail the smoke run.

`scripts/route-inventory-check.mjs` statically compares implemented Worker route/method pairs in `src/index.ts` and `src/backend/routes.ts` against `endpointStabilityCatalog`. It fails when a documented endpoint has no matching handler or an implemented `/v1` route is not categorized.

Any PR that adds, removes, or changes a Worker route must update `endpointStabilityCatalog` in the same change. That catalog is the source used by the route inventory guard, so route changes and stability classification must move together.

## Future-Sensitive Work

The following are deliberately outside this freeze:

- Durable outbox/reconciliation internals beyond the current stateless Conversation DO write-coordination path.
- MLS/E2EE wire payload semantics beyond opaque transport fields.
- Push notification provider contracts.
- Production hosted AI agent runtime APIs.
- Billing, paid plans, app store distribution, and production updater contracts.
