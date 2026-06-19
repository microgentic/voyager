# Realtime Messaging Handoff

Status: foreground Durable Object realtime event hints implemented
Date: 2026-06-19
Related docs:

- `docs/secure-client-agent-communications-master-plan.md`
- `docs/backend-contract-handoff.md`
- `docs/frontend-web-desktop-handoff.md`
- `docs/realtime-performance-handoff.md`

## 1. What Changed

Voyager now has a Cloudflare Durable Object realtime lane for near-immediate message awareness across web, desktop, iOS, and Android clients.

The important boundary is that realtime is **not** a second message store and does not carry user content. The Worker still persists authoritative room state, message envelopes, delivery receipts, and attachment references in D1/R2. Durable Objects only keep hibernating WebSocket connections for active accounts and broadcast small event hints after durable writes succeed.

This follows the master-plan direction: WebSockets provide the foreground realtime experience, while HTTP sync remains the recovery and source-of-truth path. Push notifications remain future wake-up infrastructure only.

This is intentionally the **foreground mailbox/session layer**, not the full master-plan Conversation Durable Object architecture. Conversation-level Durable Objects for message sequencing, idempotency, membership mutation serialization, and D1/DO reconciliation remain future architecture work. Current sequencing and idempotency still happen through the existing D1-backed message path.

## 2. Backend Implementation

- `wrangler.jsonc` binds `REALTIME_MAILBOX` to `RealtimeMailbox` and declares the Durable Object migration `v1-realtime-mailbox`.
- `src/realtime.ts` owns the realtime layer:
  - `RealtimeMailbox` accepts hibernating WebSockets per account.
  - `handleRealtimeConnect()` routes an authenticated account to its mailbox.
  - `notifyRoomRealtime()` resolves active room account memberships and fan-outs an event to each non-null account mailbox.
- `src/index.ts` exposes `GET /v1/realtime` as a WebSocket upgrade endpoint.
- `src/backend.ts` emits a `room.message` realtime event only after message insert, delivery receipt creation, attachment reference updates, and room bump succeed.
- Idempotent duplicate message sends return the existing message. Same-room duplicates also re-emit a lightweight realtime hint so a sender retry can recover if the first hint failed after the durable write.

## 3. Realtime Contract

Endpoint:

```text
GET /v1/realtime
```

Authentication:

- Non-browser clients may use `Authorization: Bearer <sessionToken>`.
- Browser/WebView clients authenticate through WebSocket subprotocols because the browser WebSocket API cannot set custom headers:

```ts
new WebSocket(url, ["voyager.realtime.v1", sessionToken])
```

This is acceptable for the current development contract, but production hardening should replace long-lived session-token socket auth with a short-lived realtime token, for example `POST /v1/realtime/token` followed by a one-use or renewable WebSocket token.

Server-selected protocol:

```text
voyager.realtime.v1
```

Current server events:

```json
{
  "type": "room.message",
  "eventId": "uuid",
  "createdAt": "2026-06-19T00:00:00.000Z",
  "roomId": "room_...",
  "envelopeId": "msg_...",
  "serverSequence": 42,
  "senderDeviceId": "dev_..."
}
```

The event is a pointer, not the payload. Clients should treat it as "sync this room/account now" and fetch authoritative data through `/v1/sync` and `/v1/rooms/{roomId}/messages`.

Client keepalive:

```json
{ "type": "ping", "id": "client-generated-id" }
```

Server response:

```json
{ "type": "pong", "id": "client-generated-id", "createdAt": "..." }
```

## 4. Client Implementation

- `apps/client/src/lib/api/client.ts` opens realtime sockets against the same configured API base as HTTP.
- `apps/client/src/lib/stores/realtime.svelte.ts` manages socket lifecycle, reconnection backoff, heartbeat pings, and event handling.
- `apps/client/src/routes/(app)/+layout.svelte` starts realtime beside the existing sync engine after the authenticated app shell mounts.
- `sync.svelte.ts` remains active as both fallback polling and the durable recovery path. Realtime room events queue an immediate room fetch rather than mutating message state directly.

This means a foreground client should see new messages quickly, while clients that miss a WebSocket event because of sleep, navigation, reload, or network changes still recover on the next sync.

## 5. Security And Data Boundaries

- WebSocket auth reuses the existing session/device/account checks from `getAuthContext()`.
- Suspended accounts, revoked sessions, and revoked devices cannot open realtime sockets.
- Browser origins are checked against the same CORS allowlist before the WebSocket upgrade is routed to the Durable Object.
- Durable Objects do not store message content, ciphertext, attachment metadata, or long-lived room state.
- Events only reveal room/message identifiers already available to active room members through normal sync authorization.
- `room_memberships.account_id` is currently non-null for both human and agent principals, and realtime fanout also filters null account IDs defensively for future system-principal changes.

## 6. Verification

Commands run:

```bash
npm run check
npm --prefix apps/client run check
node --check scripts/backend-first-smoke.mjs
npm --prefix apps/client run build
npx wrangler deploy --dry-run
npm run smoke:backend:local
```

The local backend smoke now opens authenticated WebSockets, waits for the `ready` frame, sends a direct-room message from another account, verifies the `room.message` event references the same `envelopeId` and `serverSequence`, then verifies `/v1/sync` still returns the pending message. It also sends a message in a group containing an agent member and verifies a human member receives the matching realtime event.

## 7. Remaining Work

- Add more event types as backend workflows need them, for example `room.membership`, `room.invitation`, `delivery.receipt`, or `typing` if those features become product requirements.
- Add Conversation Durable Objects when the project is ready to move message sequencing, idempotency, membership mutation serialization, and D1/DO reconciliation into the full master-plan architecture.
- Add short-lived realtime socket tokens so long-lived session tokens do not need to travel in WebSocket subprotocol headers.
- Keep APNs/FCM push deferred. When implemented, push should wake sleeping devices to run sync; it should not become the source of truth.
- Keep local encrypted history, MLS state, and device private-key proof as future security-layer work.
