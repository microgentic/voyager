# Startup Performance Optimization

## Summary

This pass optimizes Voyager's first authenticated load and read-heavy startup path without changing the security model. The app now has a single authenticated bootstrap endpoint for first-load identity, rooms, and pending messages; the Worker batches room/member and sidebar collection/item reads; and static SvelteKit immutable assets can be cached aggressively by Cloudflare Pages.

The goal is faster first paint after sign-in/session restore, fewer duplicate API calls, and clearer diagnostics through `Server-Timing`.

## Startup Path

The client uses `GET /v1/app/bootstrap?limit=100` as the first authenticated data request after a session token is available. The response includes:

- current account, principal, device, and roles;
- the first page of rooms with members;
- pending messages for the current device;
- `serverTime` and `requestId` diagnostics.

The app layout consumes the bootstrap payload, hydrates the room list, ingests pending messages, starts realtime, and starts polling without immediately repeating `/v1/sync`. Non-critical lists, such as principals, invitations, and sidebar collections, load after first paint.

The canonical API shape for this startup path is documented in `docs/api-contract.md`.

Existing endpoints remain available for compatibility:

- `GET /v1/me`
- `GET /v1/rooms`
- `GET /v1/sync`

## Read-Path Changes

Room listing no longer loads members with one query per room. Multi-room reads now fetch rooms first, then fetch all room memberships for those room IDs in one set-based query and group them in the Worker.

Sidebar collections follow the same pattern: collections are fetched once, then all collection items are fetched in one query and grouped by collection ID.

Authenticated request touch writes are throttled. `sessions.last_used_at` and `devices.last_seen_at` are updated only when missing or older than five minutes, while revoked and expired session/device checks remain immediate.

## Cache And Timing Diagnostics

Cloudflare Pages should serve SvelteKit hashed assets under `/_app/immutable/*` with:

```text
Cache-Control: public, max-age=31536000, immutable
```

Root HTML and fallback documents remain revalidated:

```text
Cache-Control: public, max-age=0, must-revalidate
```

Inspect startup performance in browser DevTools or curl by checking the `Server-Timing` response header on:

- `POST /v1/auth/password/login`
- `GET /v1/app/bootstrap`
- `GET /v1/me`
- `GET /v1/rooms`
- `GET /v1/sync`
- `GET /v1/principals`
- `GET /v1/room-invitations`
- `GET /v1/sidebar-collections`

Login timing reports password verification, device/session creation, audit, and route total. Read endpoints report auth/context time, read time, and route total; bootstrap also reports room and pending-message reads.

## Future Work

Do not treat this as the final global performance architecture. Remaining candidates are deliberately separate:

- D1 read replication after duplicate reads and unnecessary auth writes stay reduced.
- Future durable outbox/reconciliation work if Conversation DOs gain separate durable state or side-effect queues, not startup speed.
- Password-hash/passkey strategy review only after login timing data is collected; do not lower PBKDF2 cost as a quick speed fix.
