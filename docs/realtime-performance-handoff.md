# Realtime Performance Handoff

Status: focused realtime performance pass
Date: 2026-06-19
Related docs:

- `docs/realtime-messaging-handoff.md`
- `docs/backend-contract-handoff.md`
- `docs/frontend-web-desktop-handoff.md`

## 1. What This PR Optimizes

This pass keeps the current architecture: D1 remains the authoritative message store, Durable Objects remain foreground WebSocket event mailboxes, and HTTP sync remains the recovery path.

The goal is to reduce perceived web-to-web message latency without introducing Conversation Durable Object sequencing yet.

## 2. Backend Send Path Changes

The message send path now does less sequential D1 work before emitting realtime:

- Combines room membership, room status, and message-retention policy lookup into one query.
- Inserts a non-duplicate message with one `INSERT ... RETURNING *` statement.
- Computes `server_sequence` inside the insert rather than doing a separate max-sequence query first.
- Avoids refetching the inserted message after the insert.
- Creates all delivery receipts with one set-based `INSERT ... SELECT` statement rather than one insert per recipient device.
- Batches delivery receipt creation, attachment reference updates, and room bump after the message insert.
- Keeps idempotent duplicate sends safe by fetching the existing envelope only when the insert returns no row.
- Re-emits a same-room realtime hint for idempotent duplicate sends, so a retry can recover if the first realtime hint failed after the durable write.

## 3. Instrumentation

Message send responses now include a `Server-Timing` header with:

```text
message;dur=...
context;dur=...
insert;dur=...
postwrite;dur=...
realtime;dur=...
```

The Worker also logs structured `message.send.performance` entries with request id, room id, envelope id, server sequence, duplicate flag, and timing fields.

The `message;dur` value measures the message write and realtime notification work inside the send handler. The full browser-visible POST duration can still be higher because route-level audit logging and request overhead happen outside that metric.

The detailed room and envelope IDs in `message.send.performance` are useful during development. Before production privacy hardening, reduce those logs to request id plus timings or gate detailed identifiers behind a debug flag.

The backend smoke test now asserts that message send responses include timing metrics.

## 4. Client Realtime Changes

The previous client behavior called `sync.pokeNow()` on realtime events. If a full sync was already in flight, that poke returned early and the event could effectively wait for the next polling tick.

The client now:

- Queues a full sync if a poke happens during an in-flight sync.
- Queues room-specific realtime work if a `room.message` event arrives during an in-flight sync.
- Continues draining queued room syncs if one room refresh fails; polling remains the retry path for the failed room.
- Fetches the event room directly with `GET /v1/rooms/{roomId}`.
- Fetches new messages for that room directly with `GET /v1/rooms/{roomId}/messages?after=...`.
- Keeps the existing full `/v1/sync` polling path for recovery, cold starts, hidden tabs, and non-room-specific events.

## 5. What This Does Not Do

This PR does **not** implement Conversation Durable Object sequencing, idempotency ownership, membership mutation serialization, or D1/DO reconciliation.

That remains a separate architecture follow-up. The current measurements showed that the existing D1 path had obvious sequential work to remove first, so adding Conversation Durable Objects here would have been premature.

## 6. Verification

Run:

```bash
npm run check
npm --prefix apps/client run check
node --check scripts/backend-first-smoke.mjs
npm run smoke:backend:local
npm --prefix apps/client run build
npx wrangler deploy --dry-run
```

After deployment, use browser Network tools to inspect:

- `POST /v1/rooms/{roomId}/messages` includes `Server-Timing`.
- `wss://.../v1/realtime` receives `room.message`.
- The receiver immediately follows with room-specific `GET /v1/rooms/{roomId}` and `GET /v1/rooms/{roomId}/messages?...` calls.
