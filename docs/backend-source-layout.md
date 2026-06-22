# Backend Source Layout

Status: active backend implementation guide
Date: 2026-06-22

## Summary

The backend Worker code is split into a small module tree under `src/backend/`.
This keeps the public API behavior unchanged while giving future backend work a
clearer home than the former single large `src/backend.ts` file.

## Module Map

- `src/backend.ts` is a compatibility barrel. It exports the backend route
  handler and Durable Object classes for existing imports.
- `src/backend/routes.ts` is a compatibility route entry. The authenticated
  `/v1` route dispatcher now lives in `src/backend/routing/index.ts`.
- `src/backend/routing/*.ts` contains route-group orchestration. Route modules
  should stay focused on HTTP method checks, path matching, body parsing,
  auditing, response wrapping, Server-Timing headers, and calling backend
  operations. They should not contain D1 query logic, R2 object logic,
  Cloudflare Realtime provider logic, or domain business rules. Thread and
  maintenance endpoints have their own route modules instead of living inside
  the broader message, room, or admin route groups.
- `src/backend/conversation-coordinator.ts` contains the
  `ConversationCoordinator` Durable Object plus the internal Worker-to-DO send
  and mutation dispatch helpers.
- `src/backend/call-coordinator.ts` is a compatibility barrel for
  `src/backend/calls/coordinator.ts`, which contains the `CallCoordinator`
  Durable Object.
- `src/backend/internal-types.ts` is a compatibility type barrel. Backend
  modules should import from the owning domain type modules instead:
  `src/backend/shared/types.ts`, `src/backend/identity/types.ts`,
  `src/backend/messaging/types.ts`, `src/backend/conversation/types.ts`,
  `src/backend/rooms/types.ts`, `src/backend/attachments/types.ts`, and
  `src/backend/calls/types.ts`.
- `src/backend/operations.ts` is a compatibility barrel that re-exports the
  domain operation modules for older imports. New route-group modules should
  import from the owning domain modules instead of this all-domain barrel.
- `src/backend/identity.ts` contains principal, device-key-package, and
  identity-adjacent read/write operations.
- `src/backend/rooms/` contains room reads, creation, authorization,
  membership, human room invitations, ownership transfers, quota checks, and
  room member serialization helpers. `src/backend/rooms.ts` remains a
  compatibility barrel.
- `src/backend/messaging/` contains message send/list/acknowledgement,
  delivery receipt, message idempotency, attachment-reference, thread, and
  message realtime hint implementations. `src/backend/messages.ts` and
  `src/backend/threads.ts` remain compatibility barrels.
- `src/backend/sync.ts` contains account sync, startup bootstrap, and pending
  message reads.
- `src/backend/attachments/` contains R2-backed opaque attachment allocation,
  upload, completion, download, deletion, variant, quota, object-key cleanup,
  attachment serialization, and attachment ownership implementations.
  `src/backend/attachments.ts` remains a compatibility barrel.
- `src/backend/calls/` contains call lifecycle, read, Realtime config/session/
  track, Realtime provider client/mock helpers, media mutation, usage,
  participant-state, event, serialization, and Durable Object coordinator
  modules. `src/backend/calls/core.ts` remains the internal lifecycle/media
  orchestration module for coupled call flows; stable helper layers live in the
  smaller sibling modules. `src/backend/calls.ts` remains a compatibility
  barrel.
- `src/backend/sidebar.ts` contains sidebar collection and collection-item
  operations.
- `src/backend/agents.ts` contains agent request review and agent principal
  creation operations.
- `src/backend/maintenance.ts` contains admin room listing, maintenance run
  history, and cleanup execution.
- `src/backend/serializers.ts` is a compatibility serializer barrel. Public
  API response serializers live with their owning domains:
  `src/backend/shared/serializers.ts`, `src/backend/rooms/serializers.ts`,
  `src/backend/messaging/serializers.ts`,
  `src/backend/attachments/serializers.ts`, and
  `src/backend/calls/serializers.ts`.
- `src/backend/utils.ts` contains validation, pagination, timing, counted-write,
  JSON, timestamp, and string helper utilities.

## Refactor Rules

- Keep this as a behavior-preserving organization layer. Do not change API
  routes, response shapes, database schema, auth behavior, or Durable Object
  semantics only because a file moves.
- New route handlers should live in the matching
  `src/backend/routing/*-routes.ts` module; reusable domain behavior should live
  outside route handlers.
- Any new, removed, or changed Worker route must update
  `endpointStabilityCatalog` in `scripts/api-contract-assertions.mjs` in the
  same PR. The route inventory guard scans `src/index.ts`,
  `src/backend/routes.ts`, and dynamically discovered
  `src/backend/routing/*-routes.ts` modules; it depends on the catalog to catch
  dropped handlers and undocumented `/v1` routes.
- `conversation-coordinator.ts` should remain the only module that knows the
  internal Conversation DO request format. It may use `operations.ts` as the
  transitional mutation dispatch surface; route and domain modules should not.
- Add new backend behavior to the smallest matching domain module. If no
  matching module exists, create one around a product concept rather than around
  a single helper function.
- Keep `operations.ts` as a barrel only. Do not add implementation logic there,
  and do not import it from domain modules.
- Avoid tiny one-function files. Prefer modules that group behavior a future
  reviewer would naturally read together.

## Verification

For backend source-layout refactors, run:

```bash
npm run check
npm --prefix apps/client run check
npm --prefix apps/client run build
node scripts/route-inventory-check.mjs
node --check scripts/backend-first-smoke.mjs
node --check scripts/remote-post-deploy-smoke.mjs
npm run smoke:backend:local
CLOUDFLARE_REALTIME_MOCK=1 npm run smoke:backend:local
npx wrangler deploy --dry-run
git diff --check
```

After merge and deploy, the remote deployed guard remains:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```
