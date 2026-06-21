# Backend Source Layout

Status: active backend implementation guide
Date: 2026-06-21

## Summary

The backend Worker code is split into a small module tree under `src/backend/`.
This keeps the public API behavior unchanged while giving future backend work a
clearer home than the former single large `src/backend.ts` file.

## Module Map

- `src/backend.ts` is a compatibility barrel. It exports the backend route
  handler and Durable Object class for existing imports.
- `src/backend/routes.ts` contains authenticated `/v1` route orchestration. It
  should stay focused on HTTP method checks, path matching, auditing, response
  wrapping, and calling backend operations.
- `src/backend/conversation-coordinator.ts` contains the
  `ConversationCoordinator` Durable Object plus the internal Worker-to-DO send
  and mutation dispatch helpers.
- `src/backend/internal-types.ts` contains backend-private constants and row,
  response, metric, pagination, and coordinator payload types shared by the
  backend modules.
- `src/backend/operations.ts` is a compatibility barrel that re-exports the
  domain operation modules for route and coordinator imports.
- `src/backend/identity.ts` contains principal, device-key-package, and
  identity-adjacent read/write operations.
- `src/backend/rooms.ts` contains room CRUD, room authorization helpers,
  membership, human room invitations, ownership transfers, room quota checks,
  and room member serialization helpers.
- `src/backend/messages.ts` contains message send/list/acknowledgement,
  delivery receipt, message idempotency, attachment-reference, and message
  realtime hint operations.
- `src/backend/sync.ts` contains account sync, startup bootstrap, and pending
  message reads.
- `src/backend/attachments.ts` contains R2-backed opaque attachment allocation,
  upload, completion, download, deletion, and attachment ownership helpers.
- `src/backend/sidebar.ts` contains sidebar collection and collection-item
  operations.
- `src/backend/agents.ts` contains agent request review and agent principal
  creation operations.
- `src/backend/maintenance.ts` contains admin room listing, maintenance run
  history, and cleanup execution.
- `src/backend/serializers.ts` contains public API response serializers shared
  across domain modules.
- `src/backend/utils.ts` contains validation, pagination, timing, counted-write,
  JSON, timestamp, and string helper utilities.

## Refactor Rules

- Keep this as a behavior-preserving organization layer. Do not change API
  routes, response shapes, database schema, auth behavior, or Durable Object
  semantics only because a file moves.
- New route handlers should generally live in `routes.ts`; reusable domain
  behavior should live outside the route handler.
- Any new, removed, or changed Worker route must update
  `endpointStabilityCatalog` in `scripts/api-contract-assertions.mjs` in the
  same PR. The route inventory guard depends on that catalog to catch dropped
  handlers and undocumented `/v1` routes.
- `conversation-coordinator.ts` should remain the only module that knows the
  internal Conversation DO request format.
- Add new backend behavior to the smallest matching domain module. If no
  matching module exists, create one around a product concept rather than around
  a single helper function.
- Keep `operations.ts` as a barrel only. Do not add implementation logic there.
- Avoid tiny one-function files. Prefer modules that group behavior a future
  reviewer would naturally read together.

## Verification

For backend source-layout refactors, run:

```bash
npm run check
node --check scripts/backend-first-smoke.mjs
node --check scripts/remote-post-deploy-smoke.mjs
node scripts/route-inventory-check.mjs
npm run smoke:backend:local
npx wrangler deploy --dry-run
git diff --check
```

After merge and deploy, the remote deployed guard remains:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```
