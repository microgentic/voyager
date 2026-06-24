# Realtime Messaging Handoff

Status: Messaging Core owns messaging realtime; Voyager owns call-only lifecycle hints
Date: 2026-06-19
Related docs:

- `docs/secure-client-agent-communications-master-plan.md`
- `docs/backend-contract-handoff.md`
- `docs/frontend-web-desktop-handoff.md`
- `docs/realtime-performance-handoff.md`

## 1. What Changed

Messaging Core now owns the Cloudflare Durable Object realtime lane for near-immediate message awareness across web, desktop, iOS, and Android clients.

The important boundary is that realtime is **not** a second message store and does not carry user content. Messaging Core persists authoritative room state, message envelopes, delivery receipts, and attachment references in its D1/R2 resources. Durable Objects only keep hibernating WebSocket connections for active accounts and broadcast small event hints after durable writes succeed.

This follows the master-plan direction: WebSockets provide the foreground realtime experience, while HTTP sync remains the recovery and source-of-truth path. Push notifications remain future wake-up infrastructure only.

This is intentionally the **foreground mailbox/session layer**, not the read source or message store. Messaging Core owns conversation-level message ordering, room/membership mutations, and messaging realtime hints. Voyager's remaining realtime Durable Object is a call lifecycle boundary only; it must not emit room/message/thread events or act as a messaging fallback.

## 2. Backend Implementation

- Messaging Core binds its own realtime mailbox Durable Object and exposes `/realtime/token` plus `/realtime/connect`.
- Voyager `wrangler.jsonc` still binds `REALTIME_MAILBOX` to `RealtimeMailbox` for call lifecycle hints and declares the Durable Object migration `v1-realtime-mailbox`.
- `src/realtime.ts` owns the Voyager call realtime layer:
  - `RealtimeMailbox` accepts hibernating WebSockets per account.
  - `handleCallRealtimeConnect()` routes an authenticated account to its mailbox.
  - `notifyRoomCallRealtime()` resolves active room account memberships and fan-outs `call.*` events to each non-null account mailbox.
- `src/index.ts` exposes `GET /v1/calls/realtime` as the WebSocket upgrade endpoint for the Voyager call realtime boundary. Messaging realtime traffic uses Messaging Core via `/v1/messaging-core/realtime/token`.
- Normal message writes are proxied to Messaging Core. Core emits messaging realtime hints after durable writes; Voyager no longer owns a local message ConversationCoordinator.
- Idempotent duplicate message sends return the existing message. Same-room duplicates also re-emit a lightweight realtime hint so a sender retry can recover if the first hint failed after the durable write.
- Conversation-routed writes include `Server-Timing` metrics for the coordinator hop, queue wait, and operation time. The Worker logs `conversation.do.message` and `conversation.do.mutation` for development observability.

## 3. Realtime Contract

Messaging endpoint:

```text
POST /v1/messaging-core/realtime/token
```

Authentication:

- Clients first mint a short-lived one-use Core socket token through Voyager's Core facade using the normal Bearer session.
- Browser/WebView clients open the returned Messaging Core `connectPath`, send the returned `mrt_...` token as the `token` query parameter, and use the Core protocol:

```ts
new WebSocket(url, ["messaging.realtime.v1"])
```

Core realtime tokens are stored hashed in Messaging Core, expire quickly, and are consumed when the socket is opened. Reconnects must request a fresh token. Revoked sessions, expired sessions, inactive accounts, and revoked devices cannot mint or consume realtime tokens. Token minting is rate-limited per account/device, and token expiration is checked at socket open; an already-open socket may remain connected after the token's `expiresAt`.

Server-selected protocol:

```text
messaging.realtime.v1
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

Call lifecycle hints use a separate Voyager call runtime socket:

```text
POST /v1/calls/realtime/token
GET /v1/calls/realtime
```

Call clients open the socket with `["voyager.call-realtime.v1", realtimeToken]`. That socket emits `call.invite`, `call.ringing`, `call.joined`, `call.left`, `call.ended`, and `call.updated` only.

Client keepalive:

```json
{ "type": "ping", "id": "client-generated-id" }
```

Server response:

```json
{ "type": "pong", "id": "client-generated-id", "createdAt": "..." }
```

## 4. Client Implementation

- `apps/client/src/lib/api/client.ts` opens Messaging Core realtime sockets against the Core base URL returned by `/v1/messaging-core/realtime/token`, and opens call sockets against the Voyager API base returned by `/v1/calls/realtime/token`.
- `apps/client/src/lib/stores/realtime.svelte.ts` manages separate messaging and call socket lifecycles, reconnection backoff, heartbeat pings, and event handling.
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
- Add a durable outbox/reconciliation protocol only if a future architecture introduces separate durable Conversation DO state or additional side-effect queues.
- Keep APNs/FCM push deferred. When implemented, push should wake sleeping devices to run sync; it should not become the source of truth.
- Keep local encrypted history, MLS state, and device private-key proof as future security-layer work.
