# Conversation Durable Object Implementation Plan

Status: historical Voyager plan, superseded by Messaging Core

## Current Boundary

Voyager no longer owns a local messaging `ConversationCoordinator`. Normal
rooms, messages, threads, attachments, sync/bootstrap, and message sequencing
are handled by Messaging Core. Voyager keeps product auth, sessions, admin,
sidebar, agent provisioning, calls, and the Messaging Core token/session bridge.

Messaging Core owns the active conversation Durable Object design:

- D1 remains authoritative for Core rooms, memberships, messages, receipts,
  attachments, and sync recovery.
- Core `ConversationCoordinator` Durable Objects serialize room writes using
  tenant-scoped IDs such as `${tenantId}:${roomId}`.
- Core realtime events are hints only. Clients recover authoritative messaging
  state through HTTP reads and sync.
- Voyager must not reintroduce a local messaging coordinator, local message
  runtime, local attachment runtime, or messaging fallback path.

## Historical Context

This document originally tracked the pre-abstraction Voyager plan to introduce a
per-room `ConversationCoordinator` inside the Voyager Worker. That plan was
useful while Voyager owned the messaging backend, but the backend abstraction
has moved the reusable conversation coordination boundary into Messaging Core.

For current implementation details, use:

- `docs/backend-source-layout.md`
- `docs/backend-contract-handoff.md`
- `docs/api-contract.md`
- Messaging Core repo `docs/contract.md`

## Deployment Note

Voyager's Worker config may retain append-only historical Durable Object
migration entries for deployments that previously created the local
`ConversationCoordinator`; the current Voyager Worker no longer binds or exports
that class, and its config includes a deletion migration for it.
