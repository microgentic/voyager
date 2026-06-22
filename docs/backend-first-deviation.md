# Backend-First Deviation

Status: accepted implementation deviation for the current build path
Date: 2026-06-07

## Decision

The project is moving to a backend-first implementation path. The backend should be usable through curl, smoke scripts, and API test clients before UI work, push notifications, app-store packaging, code signing, or live agent runtime integration.

## Deferred External Blockers

The following are intentionally deferred and are not implemented in this backend-first pass:

- Push notification providers such as APNs and FCM.
- App Store and Play Store packaging or release workflows.
- Mobile and desktop code signing.
- Live agent runtimes, runtime SDKs, daemon processes, and tool execution.
- WebAuthn/passkey ceremony implementation and related third-party runtime dependency.
- Durable Object realtime/WebSocket coordination was deferred for the original backend-first pass. Foreground WebSocket event hints are now implemented, and Conversation Durable Objects now coordinate message sends plus room/membership mutations. Push providers and durable outbox/reconciliation work for future side-effect queues remain deferred.
- Queue-based async jobs and provider-specific webhook dispatch.
- External identity providers, email/SMS verification, SSO, billing, or marketplace flows.

## Active Backend Scope

The active implementation focuses on curlable, provider-light backend contracts:

- Invitation-only accounts, passwords, sessions, devices, policies, admin roles, and audit.
- Principal directory, including human and manually created agent principals.
- Device key-package metadata for later cryptographic clients.
- Direct and group rooms.
- Room membership, roles, removal, leaving, archiving, and ownership transfer.
- Opaque message envelopes with idempotency, per-room sequencing, sync, and acknowledgements. MLS/E2EE payload semantics remain future work.
- Private opaque attachment allocation, Worker-mediated R2 upload/download, completion, deletion, and metadata.
- Sidebar collections as user-owned room organization metadata.
- Agent request submission, admin review, and manual agent principal creation.

## Practical Consequences

- Password/passphrase authentication is the only active login method for now. The schema remains future-ready for passkeys, but the active WebAuthn dependency and endpoints are removed.
- Realtime delivery now uses Durable Object WebSocket event hints to wake the HTTP sync path. The core room/message data model is unchanged, and Conversation Durable Objects coordinate message writes without becoming a read source.
- Agent support is metadata-first. Agents can exist as principals and room members, but no runtime is contacted or executed.
- Attachments are uploaded through the Worker for curlability. Direct-to-R2 upload authorization can be added later when frontend and CORS details matter.
- The backend continues to treat message and attachment content as opaque data. It stores routing metadata, envelope payload, payload size, attachment metadata, and lifecycle state only; MLS/E2EE and client-side attachment encryption remain future client-security work.
