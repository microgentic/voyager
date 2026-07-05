# Startup Performance Optimization

## Summary

This pass optimizes Voyager's first authenticated load and read-heavy startup path without changing the security model. The web app restores from cached identity, rooms, and recent messages first; refreshes product identity through a lightweight session endpoint; and lets background sync/realtime reconcile newer data. Messaging Core sync now exposes batched `roomViews`, so the Voyager facade no longer needs one Core room-detail request per room when Core is up to date.

The goal is faster first paint after sign-in/session restore, fewer duplicate API calls, and clearer diagnostics through `Server-Timing`.

## Startup Path

The preferred client restore path is:

1. load the bearer token and cached identity;
2. paint the authenticated shell immediately when cached identity exists;
3. hydrate account/principal-scoped cached rooms and recent messages from IndexedDB;
4. refresh product identity through `GET /v1/app/session`;
5. run `GET /v1/sync` in the background;
6. connect Messaging Core realtime for foreground hints.

`GET /v1/app/bootstrap?limit=100` remains a compatibility and empty-cache fallback endpoint. The response includes:

- current account, principal, device, and roles;
- the first page of rooms with members;
- pending messages for the current device;
- `serverTime` and `requestId` diagnostics.

The app layout still consumes a bootstrap payload when one is available, but normal reopen starts from local cache and then runs sync. Non-critical lists, such as principals, invitations, and sidebar collections, load after first paint.

The canonical API shape for this startup path is documented in `docs/api-contract.md`.

Existing endpoints remain available for compatibility:

- `GET /v1/me`
- `GET /v1/rooms`
- `GET /v1/sync`

## Read-Path Changes

Room listing no longer loads members with one Core request per room on the Core-cutover path. Messaging Core returns `roomViews` by fetching rooms first, then fetching all room memberships for those room IDs in one set-based query and grouping them in the Worker. Voyager consumes those views directly; if an older Core deployment does not provide `roomViews`, Voyager falls back to the old room-detail fanout and reports `roomDetailFanoutCount` in `messagingCoreCutover` diagnostics.

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
- `GET /v1/app/session`
- `GET /v1/app/bootstrap`
- `GET /v1/me`
- `GET /v1/rooms`
- `GET /v1/sync`
- `GET /v1/principals`
- `GET /v1/room-invitations`
- `GET /v1/sidebar-collections`

Login timing reports password verification, device/session creation, audit, and route total. Read endpoints report auth/context time, read time, and route total; bootstrap also reports room and pending-message reads. Web client reopen performance should also be inspected with the IndexedDB `voyager-client-cache` stores for rooms, messages, and sync state; cache rows are keyed by the authenticated account/principal scope and cleared on local sign-out.

## Future Work

Do not treat this as the final global performance architecture. Remaining candidates are deliberately separate:

- Cursor-based account/device delta sync, so periodic repair can fetch ordered changes since the last applied cursor instead of a broad sync page.
- D1 read replication after duplicate reads and unnecessary auth writes stay reduced.
- Future durable outbox/reconciliation work if Conversation DOs gain separate durable state or side-effect queues, not startup speed.
- Password-hash/passkey strategy review only after login timing data is collected; do not lower PBKDF2 cost as a quick speed fix.
