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
- `src/backend/operations.ts` contains the current backend domain operations:
  principals, key packages, rooms, room invitations, messages, attachments,
  sidebar collections, agent requests, admin room/maintenance reads, serializers,
  and local helper utilities.

## Refactor Rules

- Keep this as a behavior-preserving organization layer. Do not change API
  routes, response shapes, database schema, auth behavior, or Durable Object
  semantics only because a file moves.
- New route handlers should generally live in `routes.ts`; reusable domain
  behavior should live outside the route handler.
- `conversation-coordinator.ts` should remain the only module that knows the
  internal Conversation DO request format.
- `operations.ts` is intentionally a transitional domain module. Split it
  further by cohesive product area only when a feature PR naturally touches that
  area, for example `rooms`, `messages`, `attachments`, or `sidebar`.
- Avoid tiny one-function files. Prefer modules that group behavior a future
  reviewer would naturally read together.

## Verification

For backend source-layout refactors, run:

```bash
npm run check
node --check scripts/backend-first-smoke.mjs
node --check scripts/remote-post-deploy-smoke.mjs
npm run smoke:backend:local
npx wrangler deploy --dry-run
git diff --check
```

After merge and deploy, the remote deployed guard remains:

```bash
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
npm run smoke:backend:remote
```
