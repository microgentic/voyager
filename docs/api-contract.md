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
| `POST` | `/v1/auth/password/login` | `{ account, principal, device, sessionToken, messagingCore? }` |
| `POST` | `/v1/auth/logout` | `{ ok: true }` |
| `POST` | `/v1/auth/password/change` | `{ ok: true }` |
| `POST` | `/v1/auth/password/reset/complete` | `{ account, principal, device, sessionToken, messagingCore? }` |
| `GET` | `/v1/me` | `{ account, principal, device, roles, messagingCore? }` |
| `POST` | `/v1/realtime/token` | `{ realtimeToken, expiresAt }` |
| `POST` | `/v1/messaging-core/session` | `{ messagingCore }` |
| `GET` | `/v1/messaging-core/bootstrap` | `{ messagingCore, bootstrap, proxied }` |
| `GET` | `/v1/messaging-core/rooms` | `{ messagingCore, rooms, proxied }` |
| `GET` | `/v1/messaging-core/rooms/{roomId}` | `{ messagingCore, room, members, proxied }` |
| `GET` | `/v1/messaging-core/rooms/{roomId}/messages` | `{ messagingCore, messages, proxied }` |
| `POST` | `/v1/admin/messaging-core/backfill-readonly` | `{ tenantId, limits, snapshot, core }` |
| `GET` | `/v1/sessions` | `{ sessions }` |
| `DELETE` | `/v1/sessions/{sessionId}` | `{ ok: true }` |
| `GET` | `/v1/devices` | `{ devices }` |
| `POST` | `/v1/devices` | `{ device }` |
| `POST` | `/v1/devices/{deviceId}/revoke` | `{ ok: true }` |

Login accepts `email`, `password`, and an optional `device` object. Existing-device login may send `device.deviceId`. Today that is a development contract; future device private-key proof can extend this without changing the route.

`messagingCore` is an additive cutover-prep payload. It is disabled unless `VOYAGER_MESSAGING_CORE_MODE` is set to `shadow` or `proxy` and the Messaging Core base URL plus token secret are configured. When enabled, Voyager can mint a scoped Messaging Core bearer token for the compatibility tenant `tenant_voyager_default`; if internal service credentials are configured, Voyager also attempts to bootstrap the Core tenant/policy and then upsert the account, principal, and device through Messaging Core internal routes. Voyager prefers the optional `MESSAGING_CORE_SERVICE` service binding for internal sync and public Core proxy calls, and falls back to the public base URL when that binding is not present. Sync status includes `tenantSynced`, `accountSynced`, `principalSynced`, `deviceSynced`, and a sanitized `failedStep`/`reason` pair when a step fails.

The `GET /v1/messaging-core/*` proxy routes are read-only cutover validation routes. They authenticate the caller with the Voyager session, mint/sync a Messaging Core session, call the matching product-neutral Core route, and return Core's payload plus proxy metadata. Current proxy coverage includes Core `/bootstrap`, `/rooms`, `/rooms/{roomId}`, and `/rooms/{roomId}/messages`. These routes do not switch normal Voyager room, attachment, realtime, or call traffic to Core.

When `VOYAGER_MESSAGING_CORE_ROOM_CUTOVER=1` is set and the bridge can mint/sync a Messaging Core identity, normal Voyager room routes proxy to the matching Core public room routes and return Voyager-compatible response envelopes. The facade adapts Core-neutral room, member, invitation, and ownership-transfer shapes back to existing Voyager client fields, including account/principal display enrichment from Voyager identity rows and `messagingCoreCutover` metadata with the Core route and upstream status. This guarded slice covers room list/detail/create/update/archive, membership add/role/remove/leave, pending invitation list/create/respond, and ownership transfer propose/accept. Non-pending room-invitation list filters remain on the Voyager path until Core exposes historical invitation pagination.

When `VOYAGER_MESSAGING_CORE_MESSAGE_CUTOVER=1` is set and the bridge can mint/sync a Messaging Core identity, normal Voyager message and thread routes proxy to the matching Core public routes and include `messagingCoreCutover` metadata with the Core route and upstream status. This guarded slice covers message list/send, edit, delete, ack, reactions, pins, forwarding, thread reads, and thread subscription. Thread inbox reads stay on Voyager until Core supports Voyager-compatible cursor pagination. Thread reply writes stay on Voyager until Core supports Voyager's `alsoSendToRoom` semantics. Attachment-backed sends/edits are intentionally rejected with `messaging_core_attachment_cutover_pending` while attachment object/reference cutover remains separate. Existing Voyager-only visibility state from delete-for-me is not imported by the current Core backfill, so this flag should only be used for Core-owned plain-message write-cutover smoke or environments where attachment and existing hidden-message history are not being routed through the Core message path yet.

`POST /v1/admin/messaging-core/backfill-readonly` is a platform-owner-only cutover utility. It reads current Voyager policies, accounts, principals, devices, rooms, memberships, and top-level room messages, then calls Messaging Core's internal Voyager readonly import route with the configured internal service token. It is idempotent and exists to populate Core dev/shadow deployments for parity smoke coverage; it is not the normal post-cutover write path and does not import attachments, reactions, pins, or thread replies in this focused slice. Optional JSON fields are `roomLimit`, `messageLimit`, and `dryRun`.

For a configured Voyager API and Messaging Core service, the optional parity smoke verifies that Voyager can mint a Messaging Core token, that Core accepts it for `/me`, `/bootstrap`, `/rooms`, and related read paths, and that the Voyager read-only proxies match direct Core identity and room/message reads. Set `SMOKE_MESSAGING_CORE_WRITE_CUTOVER=1` only when the deployed Voyager Worker has `VOYAGER_MESSAGING_CORE_MESSAGE_CUTOVER=1`; the smoke then sends a plain message through the normal `/v1/rooms/{roomId}/messages` route and verifies that the normal route was proxied to Core.

```bash
VOYAGER_BASE_URL="https://voyager-api.example" \
VOYAGER_SESSION_TOKEN="vgr_..." \
npm run smoke:messaging-core-parity
```

Alternatively set `VOYAGER_LOGIN_EMAIL` and `VOYAGER_LOGIN_PASSWORD` instead of `VOYAGER_SESSION_TOKEN`.

Populate a configured Core dev/shadow deployment before parity smoke with:

```bash
BASE_URL="https://voyager-api.example" \
ADMIN_EMAIL="ada@example.com" \
ADMIN_PASSWORD="voyager-demo-pass" \
npm run messaging-core:backfill-readonly
```

After this backfill, `npm run smoke:messaging-core-parity` requires Core `/rooms` to return at least one room and exercises `/rooms/{roomId}` plus `/rooms/{roomId}/messages`.

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
| `GET` | `/v1/threads` | `{ items, nextCursor }` |
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
| `GET` | `/v1/rooms/{roomId}/calls` | `{ calls, nextCursor }` |
| `POST` | `/v1/rooms/{roomId}/calls` | `{ call }` |
| `GET` | `/v1/calls/{callId}` | `{ call }` |
| `POST` | `/v1/calls/{callId}/join` | `{ call }` |
| `POST` | `/v1/calls/{callId}/leave` | `{ call }` |
| `POST` | `/v1/calls/{callId}/decline` | `{ call }` |
| `POST` | `/v1/calls/{callId}/mute` | `{ call }` |
| `POST` | `/v1/calls/{callId}/unmute` | `{ call }` |
| `PATCH` | `/v1/calls/{callId}/participants/me` | `{ call }` |
| `POST` | `/v1/calls/{callId}/realtime/session` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/realtime/tracks` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/realtime/renegotiate` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/realtime/tracks/close` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/usage-report` | `{ usageReport }` |
| `GET` | `/v1/rooms/{roomId}/messages` | `{ messages }` |
| `POST` | `/v1/rooms/{roomId}/messages` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/delete` | `{ deleted: { scope, envelopeIds } }` |
| `PATCH` | `/v1/rooms/{roomId}/messages/{envelopeId}` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/{envelopeId}/forward` | `{ message }` |
| `GET` | `/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread` | `{ thread: { root, replies, olderCursor } }` |
| `POST` | `/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread` | `{ message }` |
| `POST` | `/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/read` | `{ threadState }` |
| `PATCH` | `/v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread/subscription` | `{ threadState }` |
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
  },
  "forwardedFrom": {
    "forwardedByPrincipalId": "prn_..."
  },
  "deletedForEveryone": {
    "deleted": false,
    "deletedAt": null,
    "deletedByPrincipalId": null,
    "reason": null
  },
  "threadRootEnvelopeId": null,
  "alsoSentToRoom": false,
  "threadSummary": {
    "replyCount": 3,
    "lastReplyEnvelopeId": "msg_...",
    "lastReplySenderPrincipalId": "prn_...",
    "lastReplyAt": "2026-06-21 12:00:00"
  }
}
```

`receiptSummary.status` is the client-facing mirror signal: `sent`, `delivered`, or `read`. Receipt rows remain per-device internally, and the compact status advances when at least one recipient device reaches the delivered/read state; use the numeric counts for detailed delivery diagnostics. `PATCH /v1/rooms/{roomId}/messages/{envelopeId}` lets the original sender replace the current opaque payload for an active, non-expired message. The previous opaque payload is preserved in `message_edits`; the active message keeps the same `envelopeId` and `serverSequence`.

`POST /v1/rooms/{roomId}/messages/{envelopeId}/forward` is a client-mediated forward: the client re-encodes the displayable content for `targetRoomId`, and the backend validates that the source message is visible to the caller and not deleted-for-everyone. Forward provenance is server-asserted and can only be set through this route — a normal `POST /v1/rooms/{roomId}/messages` cannot mark a message as forwarded. The new target-room envelope's public `forwardedFrom` exposes only `forwardedByPrincipalId`; the source room, envelope, and original sender are retained in D1 and the audit log for traceability but are not exposed to target-room members. D1 remains authoritative and the source ciphertext is never interpreted by the backend.

Threads are a same-room sub-timeline anchored on a root message. A thread reply is an ordinary message envelope whose server-asserted `threadRootEnvelopeId` points at the root; `alsoSentToRoom` marks replies that are also broadcast into the main room timeline. `GET /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread` returns `{ root, replies, olderCursor }` (the root may be a tombstone yet still anchor existing replies). By default it returns the newest visible replies in ascending display order. Clients can request older pages with `before={olderCursor}`; `olderCursor` is `null` when there are no older visible replies. `POST /v1/rooms/{roomId}/messages/{rootEnvelopeId}/thread` accepts a normal send body plus an optional `"alsoSendToRoom": true` and creates the reply through the `ConversationCoordinator`. Thread metadata is server-asserted and can only be set through the thread route — a normal `POST /v1/rooms/{roomId}/messages` ignores `threadRootEnvelopeId`/`alsoSentToRoom`. The main timeline (`GET /messages`, `/v1/sync`, `/v1/app/bootstrap`) returns normal messages plus only the thread replies that were also sent to the room. `threadSummary` is computed on read for the current viewer (so replies hidden with delete-for-me are excluded) and is `null` until the first visible reply. New replies are rejected once the root is deleted-for-everyone, but existing replies remain readable. Thread roots are top-level messages only — threads do not nest. New thread replies and later mutations to existing thread replies emit `room.thread` realtime hints; clients recover authoritative state by refetching the thread endpoint.

`GET /v1/threads` returns an account-scoped thread inbox. Each item includes `{ room, root, following, muted, unreadCount, lastReadSequence, updatedAt }`; `updatedAt` is the latest visible reply activity, not the caller's read-state update time. Threads appear when the caller participates in the thread or has explicitly followed it; `PATCH /thread/subscription` can set `following` or `muted`, and `POST /thread/read` advances the caller's `lastReadSequence` to the newest visible reply without implicitly following an otherwise unparticipated thread. Thread notification preferences, mention routing, unloaded encrypted-message search, and deeper attachment QA remain future thread polish rather than required backend contract for the current thread inbox.

Reactions are room message metadata. `POST /reactions` accepts `{ "reaction": "👍" }` and is idempotent per `(message, principal)`: a caller has one active reaction per message, and posting a different reaction replaces the previous one. `DELETE /reactions/{reaction}` removes only the caller's matching active reaction. Message `reactions[].reactedByMe` is viewer-specific; counts are room-wide.

Pins are room message metadata. Direct-room participants may pin or unpin messages; group/channel pins require an owner or admin role. Pin/unpin responses return the updated message envelope. Room responses also include `pinnedMessageCount` and `latestPinnedMessageId`.

Message deletion supports two explicit scopes:

```json
{
  "scope": "for_me",
  "envelopeIds": ["msg_..."]
}
```

Delete-for-me records per-account visibility, hides those envelopes from room history, `/v1/sync`, and `/v1/app/bootstrap` for that account, and does not remove the durable message row or hide it from other members.

```json
{
  "scope": "everyone",
  "envelopeIds": ["msg_..."]
}
```

Delete-for-everyone is a room-coordinated tombstone mutation. The original sender may delete their own message for everyone within 48 hours. Group/channel owners and admins may delete any active message for everyone. Direct-room participants cannot delete the other participant's message for everyone. The envelope stays in the room timeline with the same `serverSequence`, `deletedForEveryone.deleted: true`, cleared reactions, and inactive pin metadata.

### Room Invitations

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/rooms/{roomId}/invitations` | `{ invitation }` |
| `GET` | `/v1/room-invitations` | `{ invitations, nextCursor }` |
| `POST` | `/v1/room-invitations/{roomInvitationId}/accept` | `{ invitation }` |
| `POST` | `/v1/room-invitations/{roomInvitationId}/decline` | `{ invitation }` |

Room invitations are the human membership path. Reused, expired, declined, or revoked invitations must fail instead of creating duplicate active membership.

### Calls

Call endpoints are a shared foundation for audio and video. The current call surface combines durable call lifecycle, participants, events, room authorization, `CallCoordinator` serialization, and Cloudflare Realtime session/track negotiation for microphone, camera, and screen tracks. Media still flows through WebRTC, not D1 or WebSockets, and the backend stores only provider session/track metadata.

Provider HTTP negotiation can happen outside the Durable Object, but durable D1 media commits are coordinator-owned. Session upsert, track upsert, track close, provider-unavailable/failure records, and renegotiation records are serialized through `CallCoordinator` after provider calls return. This keeps slow provider requests out of the DO queue while preserving serialized authoritative state mutation.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/rooms/{roomId}/calls` | `{ calls, nextCursor }` |
| `POST` | `/v1/rooms/{roomId}/calls` | `{ call }` |
| `GET` | `/v1/calls/{callId}` | `{ call }` |
| `POST` | `/v1/calls/{callId}/join` | `{ call }` |
| `POST` | `/v1/calls/{callId}/leave` | `{ call }` |
| `POST` | `/v1/calls/{callId}/decline` | `{ call }` |
| `POST` | `/v1/calls/{callId}/mute` | `{ call }` |
| `POST` | `/v1/calls/{callId}/unmute` | `{ call }` |
| `PATCH` | `/v1/calls/{callId}/participants/me` | `{ call }` |
| `POST` | `/v1/calls/{callId}/realtime/session` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/realtime/tracks` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/realtime/renegotiate` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/realtime/tracks/close` | `{ realtime }` |
| `POST` | `/v1/calls/{callId}/usage-report` | `{ usageReport }` |

`POST /v1/rooms/{roomId}/calls` accepts:

```json
{
  "callType": "audio"
}
```

`callType` may be `audio` or `video`. Audio calls may only publish `audio` tracks; video calls may publish and subscribe to `audio`, `video`, `screen`, or future `data` track metadata through the same Realtime endpoints.

Call responses expose durable metadata only:

```json
{
  "callId": "call_...",
  "roomId": "room_...",
  "callType": "audio",
  "status": "ringing",
  "createdByPrincipalId": "prn_...",
  "createdByDeviceId": "dev_...",
  "startedAt": null,
  "endedAt": null,
  "endedReason": null,
  "participants": [
    {
      "callParticipantId": "cpart_...",
      "principalId": "prn_...",
      "deviceId": "dev_...",
      "status": "connected",
      "mutedAt": null,
      "audioEnabled": true,
      "videoEnabled": false,
      "screenEnabled": false,
      "lastSeenAt": "2026-06-21 12:00:00"
    }
  ]
}
```

Only active room members may create, read, or join calls. Archived rooms reject new calls. A room may have one live call (`ringing` or `active`) at a time. Environment feature flags can disable all calls, audio calls, video calls, screen sharing, or realtime media and return `feature_disabled` without falling through to provider work. Realtime media endpoints require a connected call participant. If Cloudflare Realtime credentials are absent, they return the same additive shape with `configured: false`, `session: null`, empty track arrays, feature flags, and STUN/TURN capability data suitable for local/dev handling.

`PATCH /v1/calls/{callId}/participants/me` accepts any non-empty combination of:

```json
{
  "muted": false,
  "audioEnabled": true,
  "videoEnabled": false,
  "screenEnabled": false,
  "heartbeat": true
}
```

`muted` remains the compatibility control for microphone mute/unmute. The media-enabled booleans expose server-visible participant state for call recovery; they do not contain or store media. `heartbeat` refreshes participant liveness and may be sent without changing media state.

Realtime session responses may include:

```json
{
  "provider": "cloudflare_realtime",
  "configured": true,
  "callId": "call_...",
  "callType": "audio",
  "status": "ringing",
  "iceServers": [{ "urls": "stun:stun.cloudflare.com:3478" }],
  "session": {
    "sessionId": "provider-session-id",
    "status": "active",
    "createdAt": "2026-06-21 12:00:00",
    "updatedAt": "2026-06-21 12:00:00"
  },
  "sessionDescription": { "type": "answer", "sdp": "..." },
  "tracks": [],
  "availableTracks": [],
  "requiresImmediateRenegotiation": false,
  "message": "Realtime session ready"
}
```

`POST /v1/calls/{callId}/realtime/session` accepts an optional `sessionDescription` and creates or returns the caller's active Cloudflare Realtime session. Duplicate active session requests from the same connected participant return the existing active session when no new offer is supplied; when a new `sessionDescription` is supplied for an existing active session, the backend renegotiates with the provider and returns a fresh answer. `POST /v1/calls/{callId}/realtime/tracks` accepts `sessionId`, optional `sessionDescription`, and a `tracks` array with `location`, `trackName`, `kind`, optional `mid`, optional `simulcast`, and remote `sessionId` when subscribing to another participant's track. The optional `simulcast` object is passed through for remote video/screen subscriptions and may include `preferredRid`, `priorityOrdering`, and `ridNotAvailable`. Stored track metadata includes the requested quality layer when present; duplicate local track publication upserts the existing session/track row. Media content is never stored. `POST /v1/calls/{callId}/realtime/renegotiate` forwards a required `sessionDescription` and records metadata-only renegotiation state. `POST /v1/calls/{callId}/realtime/tracks/close` closes active track mids for the caller's session; duplicate close is safe from the D1 perspective.

### Attachments

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/rooms/{roomId}/attachments` | `{ attachment }` |
| `PUT` | `/v1/attachments/{attachmentId}/blob` | `{ attachment }` |
| `PUT` | `/v1/attachments/{attachmentId}/blob?variant=preview\|thumbnail\|original` | `{ attachment }` |
| `GET` | `/v1/attachments/{attachmentId}/blob` | binary payload |
| `GET` | `/v1/attachments/{attachmentId}/blob?variant=preview\|thumbnail\|original` | binary payload |
| `POST` | `/v1/attachments/{attachmentId}/complete` | `{ attachment }` for uploaded, unreferenced attachments; `409 attachment_already_referenced` once referenced |
| `DELETE` | `/v1/attachments/{attachmentId}` | `{ ok: true }` for pre-reference cleanup, `409 attachment_already_referenced` once referenced, `409 attachment_not_deletable` for deleted/expired/quarantined rows |

Attachment bytes are opaque private blobs from the backend perspective. R2 stores the objects; D1 stores lifecycle state, media metadata, and variant references. `GET /blob` and `PUT /blob` without a query parameter default to the `original` variant for backward compatibility. `expectedBytes` is the total byte budget for all uploaded variants combined, not a per-variant limit.

For Messaging Core extraction compatibility, Voyager backfills existing rows into the single tenant `tenant_voyager_default`. Existing stored attachment R2 object keys are preserved as-is, while newly allocated attachment objects use tenant-prefixed private keys such as `tenants/tenant_voyager_default/rooms/{roomId}/attachments/{attachmentId}/original`.

Attachment metadata is additive and client-supplied:

```json
{
  "attachmentId": "att_...",
  "mediaKind": "image",
  "originalFilename": "photo.webp",
  "declaredMimeType": "image/webp",
  "width": 1600,
  "height": 1200,
  "durationMs": null,
  "variants": {
    "original": {
      "variant": "original",
      "bytes": 734003,
      "width": 1600,
      "height": 1200,
      "downloadPath": "/v1/attachments/att_.../blob?variant=original"
    },
    "preview": {
      "variant": "preview",
      "bytes": 142211,
      "width": 1600,
      "height": 1200,
      "downloadPath": "/v1/attachments/att_.../blob?variant=preview"
    },
    "thumbnail": {
      "variant": "thumbnail",
      "bytes": 24190,
      "width": null,
      "height": null,
      "downloadPath": "/v1/attachments/att_.../blob?variant=thumbnail"
    }
  },
  "variantManifest": {}
}
```

The backend does not generate thumbnails or inspect image plaintext in `/v1`; optimized variants are produced by the client and uploaded as separate authenticated R2 objects. Buckets remain private, downloads remain bearer-authenticated, and `Cache-Control` is `no-store`. Worker-mediated upload streams request bodies to R2 when `Content-Length` is available; direct-to-R2 multipart upload and signed media URLs remain deferred until the leakage, revocation, and CORS contract is explicitly designed.

Voice notes use the existing attachment contract. The client records microphone input with browser media APIs, uploads the resulting audio blob as `mediaKind: "audio"`, and supplies duration metadata when available. The backend stores only attachment metadata and private R2 bytes; voice-note capture, permission handling, and playback UI remain client responsibilities.

An attachment is not complete or referenceable from a message until its `original` variant has been uploaded. The `original` variant is the primary blob for that attachment; it may be an optimized client-generated primary image rather than the source camera file. Preview and thumbnail uploads alone do not make an attachment sendable. Once an attachment has been referenced by a message, `/complete` cannot be used to mutate its filename, MIME, media dimensions, duration, hash, byte count, or variant manifest.

Generic attachment delete is a pre-reference cleanup path only. It may delete allocated attachments or uploaded attachments that have not been referenced by a message. Once an attachment has been referenced, its private R2 objects and presentation metadata are immutable from the generic attachment API perspective: `DELETE /v1/attachments/{attachmentId}` and post-reference `/complete` both return `409 attachment_already_referenced`. Message send/edit strictly verifies that all requested attachments are referenced before returning success. Deleted, expired, quarantined, or otherwise invalid lifecycle states return `409 attachment_not_deletable` or `409 attachment_not_referenceable` depending on the attempted operation. Delete-for-everyone remains a message tombstone operation: it hides/tombstones the message presentation, but it does not physically delete shared referenced blobs.

Attachment allocation is limited by account policy bytes per attachment, max attachments per message, max image dimensions, daily expected bytes per account and room, total uploaded variant bytes, and by a per-device pending allocation cap. Maintenance cleanup expires old attachment rows, abandoned allocated rows, and uploaded-but-unreferenced rows while deleting known private R2 variant objects.

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

Call invite/update events:

```json
{
  "type": "call.invite",
  "eventId": "uuid",
  "createdAt": "2026-06-20T00:00:00.000Z",
  "roomId": "room_...",
  "callId": "call_...",
  "callType": "audio",
  "createdByPrincipalId": "prn_..."
}
```

```json
{
  "type": "call.updated",
  "eventId": "uuid",
  "createdAt": "2026-06-20T00:00:00.000Z",
  "roomId": "room_...",
  "callId": "call_...",
  "callType": "audio",
  "status": "active"
}
```

Call realtime events are hints only. Clients recover authoritative state through `GET /v1/calls/{callId}` or `GET /v1/rooms/{roomId}/calls`.

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
| `GET` | `/v1/admin/calls/realtime-status` | Cloudflare Realtime configuration and feature-flag status |
| `GET` | `/v1/admin/audit-events` | audit event list |
| `GET` | `/v1/admin/rooms` | admin room list |
| `POST` | `/v1/admin/devices/test-cleanup` | stale test-device cleanup |
| `POST` | `/v1/admin/messaging-core/backfill-readonly` | Messaging Core readonly parity backfill |
| `GET` | `/v1/admin/maintenance/runs` | maintenance history |
| `POST` | `/v1/admin/maintenance/cleanup` | explicit cleanup run |

Admin hierarchy is part of the security contract: only platform owners may administer accounts with active administrative roles.

`GET /v1/admin/usage` includes legacy top-level counts plus additive operational summaries:

```json
{
  "usage": {
    "attachments": 12,
    "attachmentBytes": {
      "activeExpectedBytes": 1048576,
      "allocatedExpectedBytesLast24h": 2097152,
      "uploadedStoredBytes": 524288
    },
    "callMedia": {
      "totalCalls": 4,
      "activeCalls": 1,
      "totalDurationMs": 32000,
      "averageDurationMs": 16000,
      "participantRows": 8,
      "maxParticipants": 2,
      "realtimeTracks": 3,
      "failedMediaEvents": 1,
      "failedProviderRequests": 0,
      "tracksByKind": { "audio": 2, "video": 1 },
      "tracksByQualityLayer": { "h": 1 },
      "usageReports": 1,
      "reportedDurationMs": 15000,
      "reportedAudioDurationMs": 15000,
      "reportedVideoDurationMs": 0,
      "reportedScreenDurationMs": 0,
      "bytesSentEstimate": 2048,
      "bytesReceivedEstimate": 4096,
      "relayLikelyReports": 0,
      "turnConfigured": false,
      "estimatedSfuTurnEgressBytes": null,
      "estimatedSfuTurnEgressStatus": "unavailable_provider_metric"
    }
  }
}
```

`callMedia` is an operations surface derived from durable call/session/track metadata, failure events, and metadata-only client usage reports. Client reports provide aggregate byte and duration estimates; provider egress/TURN bytes remain marked unavailable unless a trustworthy provider-specific byte source is supplied. Local configured-success smoke may use `CLOUDFLARE_REALTIME_MOCK=1`; production configuration still depends on Cloudflare Realtime secrets.

`GET /v1/admin/calls/realtime-status` requires `quota_operator`, `security_admin`, or `auditor` and never returns secrets. It reports local configuration and feature-flag state. It does not perform a live Cloudflare Realtime health check, so provider health fields remain `not_checked`/`null` unless a future explicit provider check is added.

```json
{
  "realtime": {
    "provider": "cloudflare_realtime",
    "configured": true,
    "status": "configured",
    "configurationStatus": "configured",
    "configurationCheckedAt": "2026-06-22T13:00:00.000Z",
    "providerHealthStatus": "not_checked",
    "providerHealthCheckedAt": null,
    "mock": false,
    "apiBase": "https://rtc.live.cloudflare.com/v1",
    "turnConfigured": false,
    "features": {
      "callsEnabled": true,
      "audioCallsEnabled": true,
      "videoCallsEnabled": true,
      "screenShareEnabled": true,
      "realtimeMediaEnabled": true
    },
    "credentialState": {
      "appIdConfigured": true,
      "appSecretConfigured": true,
      "turnCredentialsConfigured": false
    },
    "lastProviderCheckAt": null,
    "lastProviderCheckStatus": "not_checked",
    "estimatedSfuTurnEgressStatus": "unavailable_provider_metric"
  }
}
```

`POST /v1/calls/{callId}/usage-report` records only aggregate WebRTC metadata for the authenticated participant's current device. The request may include `sessionId`, `durationMs`, aggregate byte estimates, track kind/direction durations, candidate type, relay hint, RTT, and packet loss. If `sessionId` is supplied, it must belong to the authenticated account/principal/device for that call. Duplicate reports for the same call, device, and provider session return the original report. Client-submitted reports are stored with `source: "client_estimate"` and cannot submit provider egress/billing fields; provider-authoritative byte fields remain reserved for a trusted provider integration. It does not accept or store media payloads or SDP.

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

`scripts/route-inventory-check.mjs` statically compares implemented Worker route/method pairs in `src/index.ts`, `src/backend/routes.ts`, and dynamically discovered `src/backend/routing/*-routes.ts` modules against `endpointStabilityCatalog`. It fails when a documented endpoint has no matching handler or an implemented `/v1` route is not categorized.

Any PR that adds, removes, or changes a Worker route must update `endpointStabilityCatalog` in the same change. That catalog is the source used by the route inventory guard, so route changes and stability classification must move together.

## Future-Sensitive Work

The following are deliberately outside this freeze:

- Durable outbox/reconciliation internals beyond the current stateless Conversation DO write-coordination path.
- MLS/E2EE wire payload semantics beyond opaque transport fields.
- Push notification provider contracts.
- Production hosted AI agent runtime APIs.
- Billing, paid plans, app store distribution, and production updater contracts.
