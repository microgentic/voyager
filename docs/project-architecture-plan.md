# Secure Agent Communications Project Plan

Status: planning document
Date: 2026-06-06
Source notes: based on `docs/brainstorming.md`; the brainstorming file was not edited.

## 1. Detailed Project Report

### 1.1 Project Vision

This project is a private, end-to-end encrypted communication application for clients, internal human users, and AI agents. The product should let clients communicate with AI agents without relying on Telegram, Slack, Discord, or other third-party chat surfaces. Practically, it should behave like a normal secure messaging app: users can message other users, agents can message users, and mixed human/agent groups can function like secure workspaces.

The key product idea is that a communication room can become an operational AI interface. A billing group with billing staff plus specialized agents becomes a billing agent workspace. A support group with support staff plus a support agent becomes a support operations room. This means the app is not only a chat client; it is the secure interaction layer for agentic workflows.

### 1.2 Core Goals

- Provide secure direct messaging between users.
- Provide secure user-to-agent and agent-to-user messaging.
- Provide secure group conversations where users and agents can participate together.
- Preserve end-to-end encryption so the server cannot read message bodies or media.
- Keep the backend hosted on Cloudflare services.
- Keep initial rollout costs as close to zero as possible by staying inside Cloudflare free tiers where practical.
- Support web, desktop, iOS, and Android from a shared application architecture.
- Make mobile feel like a real native messaging app, not a resized desktop web app.
- Provide a superuser/admin management console for account provisioning, policy controls, resets, and operational oversight.
- Plan the backend carefully enough that the project can scale without requiring a full rewrite.

### 1.3 Product Shape

The application should have three major surfaces:

- Client chat app: used by customers and normal users on mobile, desktop, and web.
- Admin console: used by the superuser to manage users, credentials, rules, quotas, groups, agents, and operational settings.
- Agent integration surface: used by AI agents or their runtimes to receive encrypted messages, send encrypted replies, and participate as first-class room members without a normal human UI.
- Desktop management surface: likely the same admin/agent-management frontend packaged with Tauri later, so agent operations can be managed from a desktop app without creating a separate backend.

The chat experience should support:

- Direct messages.
- Group rooms.
- Future channel-style rooms.
- User-scoped sidebar organization.
- Text and safe Markdown rendering.
- Clear visual distinction between humans and agents.
- Local chat history.
- Encrypted media and attachments.
- Presence, delivery state, and offline delivery with retention limits.

### 1.4 Primary Actors

- Superuser: the platform owner, initially you. Can create and manage accounts, enforce policies, reset credentials, view metadata/audit activity, and administer the system. Cannot decrypt end-to-end encrypted messages.
- Human user: a client, staff member, or other person using the chat application.
- Group owner: the creator or assigned owner of a room. Can manage room membership and delegated admin permissions.
- Group admin: a room member with selected permissions granted by the owner.
- Agent owner: the human user who requested or owns an AI agent.
- AI agent: a service principal with its own cryptographic identity and device/session model. It sends and receives messages like a user, but has no normal chat UI.
- Backend service: Cloudflare-hosted API, realtime, storage, and management services. It routes encrypted payloads and stores metadata, but does not decrypt content.

### 1.5 Recommended Technical Direction

Use Tauri plus SvelteKit for the client and admin frontends, but keep the core backend as explicit Cloudflare Worker services rather than treating SvelteKit as the entire backend. SvelteKit is a strong fit for the UI and can deploy to Cloudflare with the Cloudflare adapter, but the messaging backend should be designed as a platform API that Tauri mobile, Tauri desktop, web, admin, and agents can all call consistently.

Recommended platform split:

- SvelteKit: chat UI, admin UI, routing, web build, shared frontend architecture.
- Tauri: desktop/mobile shell, secure local capabilities, app packaging, native notifications, local secure storage integrations.
- Cloudflare Workers: API gateway, authentication endpoints, management endpoints, prekey endpoints, upload/download signing, webhook/agent endpoints.
- Cloudflare Durable Objects: realtime WebSocket coordination, room fanout, presence, connection state, short-lived strongly consistent state, per-room sequencing.
- Cloudflare D1: relational metadata for users, devices, agents, rooms, memberships, permissions, policies, invitations, quotas, and audit logs.
- Cloudflare R2: encrypted media/blob storage only, not plaintext chat history.
- Cloudflare KV: non-critical cached configuration and feature flags.
- Cloudflare Queues: optional async jobs, cleanup, agent notifications, and later background processing where retention limits fit.
- libsignal: preferred protocol foundation for end-to-end encrypted user, device, and agent messaging.

Official references checked:

- Cloudflare Durable Objects are intended for stateful coordination, realtime chat, and WebSocket workloads: https://developers.cloudflare.com/durable-objects/
- Cloudflare Durable Objects support WebSocket hibernation to reduce idle connection cost: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare R2 has a free tier but reads/writes still matter at scale: https://developers.cloudflare.com/r2/pricing/
- Cloudflare D1 pricing is based on rows read/written and storage, with scale-to-zero compute: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare KV has free-plan daily operation limits and is better for non-critical global lookup/cache than strongly consistent app state: https://developers.cloudflare.com/kv/platform/pricing/
- Cloudflare Queues are available with a free tier, but free retention is limited: https://developers.cloudflare.com/queues/platform/pricing/
- SvelteKit can deploy to Cloudflare Pages with `@sveltejs/adapter-cloudflare`: https://developers.cloudflare.com/pages/framework-guides/deploy-a-svelte-kit-site/
- Tauri capabilities should be used to constrain frontend access to native/system APIs: https://v2.tauri.app/security/capabilities/
- libsignal provides platform-agnostic Signal Protocol APIs exposed through Java, Swift, and TypeScript libraries: https://github.com/signalapp/libsignal

### 1.6 Recommended MVP Scope

The MVP should be useful but deliberately narrow:

- Superuser-created accounts only.
- Temporary credentials with forced credential change on first login.
- Password-based account login plus local app passcode/biometric unlock.
- User/device registration.
- libsignal identity and prekey publication per device.
- Direct messages.
- Group rooms with owners, admins, members, and agents.
- Agent accounts/service principals that can be manually created by the superuser.
- Placeholder agent request form endpoint.
- End-to-end encrypted text messages.
- Safe Markdown rendering for agent-friendly messages.
- Offline encrypted message delivery with TTL and quotas.
- User-scoped sidebar collections for organizing rooms.
- Basic encrypted media architecture, with media upload possibly shipped shortly after text/group messaging if the MVP needs to stay smaller.
- Admin console for users, devices, policies, room metadata, quotas, and audits.
- CI/CD from GitHub to Cloudflare through Wrangler or Cloudflare deployment integrations.

### 1.7 Deliberately Later Scope

- Public signup.
- Self-serve agent creation.
- Full billing and paid tier automation.
- Slack-like channels with thread-first workflows.
- Message search across encrypted content.
- Multi-device encrypted history backup.
- Advanced agent communication rules.
- External identity providers and enterprise SSO.
- Full compliance claims such as HIPAA/SOC 2 without a separate legal/security review.

## 2. Decisions, Deviations, And Practical Constraints

This section lists ideas from the brainstorm that require a decision, a deviation, or a technical constraint.

- Tauri should not be treated as the backend. Tauri is valuable for desktop/mobile packaging and local native capabilities, but server authority, routing, realtime delivery, storage, and account administration should live on Cloudflare.

- SvelteKit should not be the only backend boundary. SvelteKit can host web UI and some UI-adjacent server routes, but the core messaging backend should be separate Worker APIs so mobile apps, desktop apps, web clients, and agents use the same stable API.

- A pure "send only when recipient is online" model is not recommended beyond a temporary prototype. It lowers early implementation complexity, but it makes the app feel unreliable and unlike Signal/Telegram/WhatsApp. The better MVP is short-retention encrypted offline delivery with strict quotas.

- R2 should not be used as the message queue or canonical group chat database. R2 is object storage and is a good fit for encrypted blobs/media. Realtime delivery, ordering, and short-lived connection coordination belong in Durable Objects and Worker APIs.

- Persistent plaintext group history on the server is rejected. It conflicts with the end-to-end encryption goal. The server can store encrypted envelopes and encrypted media blobs, but it must not store decryptable message bodies.

- Pure peer-to-peer media storage is not recommended for the main design. Relying on users' devices to serve media later creates availability, NAT, battery, bandwidth, privacy, and abuse problems. It can be explored later as an optimization, but it should not be the baseline.

- The best content/media decision is a hybrid Option X. Messages are encrypted per recipient/device and delivered as encrypted envelopes. Media is encrypted client-side, uploaded once to R2 as an encrypted blob, and referenced from encrypted message envelopes that carry the decryption material only to authorized recipients.

- The superuser can reset account credentials, but cannot recover end-to-end encrypted content. This is a necessary security boundary. Credential reset and message decryption must remain separate.

- A "passcode erase" feature must be destructive, not a recovery bypass. If the app passcode protects local keys and the passcode is forgotten, the device should be wiped/re-enrolled or local key material should be rotated. The server must not keep a copy of local decryption keys just so an admin can recover them.

- Password and passcode should both exist, but they should solve different problems. Password/passkey is for account authentication. Passcode/biometric is for unlocking local app data and private key material on a device.

- Email and phone verification should be optional in the MVP. Admin-created accounts can work without SMS/email verification. The schema should support email/phone fields and policy flags so verification can be enforced later.

- Channels and threads should be deferred behind a general room model. The MVP should implement direct rooms and group rooms. Later, channel rooms can add posting rules, topics, hierarchy, and threads without replacing the room/membership model.

- "Organizational groups" should be renamed to Sidebar Collections in the system model. They are user-scoped UI organization containers, not shared security groups and not inherited when someone joins a room.

- User sidebar collections should not be imposed by group owners. This matches the brainstorm decision that OGs are strictly individual user choice. A room owner manages room membership; each user manages their own sidebar organization.

- Group ownership transfer should be allowed, but controlled. The system should require at least one active human owner at all times, prevent accidental ownerless rooms, and avoid making an agent the sole owner by default.

- Agent creation is out of scope for the chat app MVP. The backend should include agent service principals and a placeholder request endpoint, but the full agent provisioning workflow should remain a later project.

- Agent communication rules inside groups are out of scope for the first backend. Store room membership and agent identity now; add advanced agent behavior rules once the agent runtime integration is designed.

- Web clients have weaker local key protection than Tauri desktop/mobile clients. The architecture can support web, but high-security users should prefer Tauri/mobile where OS secure storage and app-level controls are stronger.

- Markdown must be sanitized. Agent-friendly Markdown is useful, but raw HTML, scriptable links, unsafe embeds, and untrusted rendering behavior must be blocked.

- Cloudflare free tier goals require quotas and retention limits from day one. Free does not mean unlimited. Message TTLs, media size caps, group limits, one-time prekey replenishment limits, and rate limits should be part of the MVP.

## 3. Additions, Updates, And Decisions

- Use a room abstraction for all conversations. Room types should include `direct`, `group`, and later `channel`.

- Implement groups in the MVP. They are core to the agentic use case and should not be postponed behind direct messaging only.

- Defer channels as a specialized room type. Channels can later add topics, posting permissions, and thread support.

- Use Sidebar Collections for the former OG concept. They are user-owned, manually sorted, collapsible sidebar sections that contain references to rooms. They also aggregate unread counts and notification indicators.

- Treat agents as service principals with user-like messaging capabilities. Each agent has an identity, display profile, owner, room memberships, and cryptographic keys, but no standard human UI.

- Show agents clearly in the UI. Agent badges, icons, and profile labels should make it obvious that a participant is an AI agent.

- Use libsignal identities per device or agent runtime. Do not share one private identity across all devices unless the protocol design explicitly supports that case.

- Store only encrypted message envelopes for offline delivery. The backend can see sender, recipient/device routing, timestamps, room IDs, and delivery state, but not message content.

- Store media in R2 only after client-side encryption. The encrypted message envelope references the blob and contains encrypted key material for authorized recipients.

- Use Durable Objects for realtime room coordination and WebSocket connection management. Use WebSocket hibernation where possible to keep idle connection costs down.

- Use D1 for relational metadata and administration data. This includes users, devices, agents, rooms, memberships, permissions, settings, invitations, and audit logs.

- Use KV only for non-critical cache/config lookups. Do not use KV for authoritative permissions, delivery queues, or strongly consistent counters.

- Use Queues for async processing where useful, but do not depend on free-tier Queue retention for core chat history.

- Include offline delivery in the MVP, but with conservative TTLs and quotas. A private messaging app without offline delivery will feel broken quickly.

- Keep the admin console metadata-only for encrypted content. Admins can manage accounts and rooms but cannot read encrypted messages.

- Add room ownership transfer with safeguards. Require confirmation and preserve at least one human owner.

- Add a placeholder agent request endpoint and admin review state. Normal users can request an agent; only the superuser/admin flow can approve or provision it.

- Design account policy flags now: force password change, require email, require phone, require local passcode, require MFA/passkey later, account disabled, device revoked.

- Make account recovery honest. Password recovery can restore server access; forgotten local passcode recovery may wipe local data or require re-enrollment.

- Add safe Markdown as a first-class message content type. Use a sanitized renderer and store the content type in message metadata.

- Add quotas from the beginning: max groups per user, max room members, max media size, max storage per account, max offline envelopes, and prekey replenishment limits.

- Use GitHub CI/CD plus Wrangler/Cloudflare deploys. Every backend environment should be reproducible from configuration and migrations.

## 4. Backend Requirements

### 4.1 Backend Architecture Requirements

- The backend must be hosted on Cloudflare services.
- The backend must be API-first so web, desktop, mobile, admin, and agent clients can share the same backend contracts.
- The backend must never require access to plaintext message bodies or plaintext media.
- The backend must route encrypted envelopes between devices and agents.
- The backend must expose stable versioned APIs.
- The backend must support environment separation: local, preview/staging, and production.
- The backend must be deployable through GitHub CI/CD and Wrangler or Cloudflare-native deployment flows.
- The backend must have explicit database migrations.
- The backend must include typed request/response contracts shared with clients.
- The backend must be modular enough to keep authentication, messaging, room management, media, admin, and agent integration separate.

Recommended backend service layout:

```text
services/
  api-worker/          Public API gateway, auth, management, prekeys, uploads.
  realtime-worker/     WebSocket entrypoint and Durable Object bindings.
  admin-worker/        Optional separate admin API boundary if desired.
  agent-worker/        Agent webhook/polling endpoints and future integrations.
packages/
  contracts/           Shared API schemas and event types.
  domain/              User, room, membership, policy, and permission logic.
  crypto-client/       Client-side protocol adapter interfaces and test vectors.
  backend-db/          D1 schema, migrations, query helpers.
  config/              Shared environment and feature flag typing.
infra/
  cloudflare/          Wrangler configs, D1/R2/KV/DO bindings, CI deploy scripts.
docs/
  architecture, threat model, protocol notes, runbooks.
```

### 4.2 Cloudflare Service Requirements

- Workers must handle HTTP APIs, authentication, upload/download signing, prekey publication, device registration, room management, and admin actions.
- Durable Objects must coordinate realtime WebSocket sessions, presence, per-room fanout, room sequence numbers, and strongly consistent room actions where needed.
- D1 must store relational metadata and administrative state.
- R2 must store encrypted media and attachment blobs.
- KV may store non-authoritative public config, app version flags, feature flags, or cached lookup values.
- Queues may support async cleanup, audit processing, agent notification fanout, and delayed jobs when retention requirements fit.
- Scheduled Workers/Cron Triggers should run cleanup tasks for expired envelopes, stale media, orphaned uploads, old audit partitions, and depleted prekey alerts.
- Cloudflare secrets must store deployment secrets, signing secrets, and service credentials. Message decryption keys must not be stored server-side.

### 4.3 Data Model Requirements

Core tables/entities:

| Entity | Purpose |
| --- | --- |
| `users` | Human account records, status, display profile, admin-created metadata. |
| `devices` | Registered user devices, platform, public identity material, revocation state. |
| `agents` | Agent service principals with owner, profile, status, and integration settings. |
| `agent_devices` | Agent runtime/device identities and delivery endpoints. |
| `rooms` | Conversation containers for direct, group, and future channel rooms. |
| `room_memberships` | User/agent membership, role, join state, invite state, notification settings. |
| `room_permissions` | Role and per-member permissions for owners/admins/members/agents. |
| `sidebar_collections` | User-owned sidebar sections with manual sort order and collapsed state. |
| `sidebar_collection_items` | User-owned references from collections to rooms. |
| `prekeys` | Device prekey bundles needed for asynchronous Signal session setup. |
| `encrypted_envelopes` | Short-retention encrypted messages awaiting delivery or acknowledgement. |
| `delivery_receipts` | Delivery state by recipient device, with minimal metadata. |
| `media_objects` | Encrypted R2 blob metadata, owner/uploader, size, hash, TTL, retention state. |
| `invitations` | Room invites, account invites, and join tokens. |
| `account_policies` | Per-user or per-organization enforcement settings. |
| `agent_requests` | Placeholder records for users requesting new AI agents. |
| `audit_events` | Security/admin metadata logs, never plaintext message content. |
| `quota_usage` | Counters for rooms, envelopes, media, storage, API usage, and agent requests. |

Data model constraints:

- IDs must be opaque, non-sequential public identifiers.
- Internal database IDs should not leak where a random public ID is safer.
- Membership changes must create auditable events.
- Room state changes must be idempotent.
- Device revocation must block new delivery to the revoked device.
- Last-owner constraints must prevent ownerless group rooms.
- Agent ownership must be explicit.
- User-owned Sidebar Collections must not affect room permissions.

### 4.4 Authentication And Account Lifecycle Requirements

- The superuser must be bootstrapped through a secure one-time setup path or controlled seed command.
- The superuser must be able to create users manually.
- User creation must support temporary credentials.
- User accounts must support `force_credential_change_on_next_login`.
- User accounts must support disabled, locked, pending, active, and archived states.
- Login must produce scoped sessions or tokens with server-side revocation support.
- Refresh tokens, if used, must be revocable per device.
- Device registration must be tied to account login and cryptographic identity setup.
- Admins must be able to revoke a specific device without deleting the user.
- Admins must be able to require re-enrollment after suspected compromise.
- The system must track last login, last device registration, failed login count, and lockout state.
- Public signup should not exist in the MVP.
- Email and phone fields should exist but verification should be optional by policy.
- The backend should support future MFA/passkey requirements without data model redesign.

### 4.5 Password And Passcode Requirements

Decision: support both password/passkey and passcode/biometric, with different security roles.

Password/passkey requirements:

- Used for account authentication against the backend.
- Admin-resettable through a credential reset flow.
- Can be temporary on first account creation.
- Can be forced to change on next login.
- Must never be stored in plaintext.
- Must use a modern password hashing or password-authentication strategy appropriate for the Cloudflare runtime.
- Should support future passkeys/WebAuthn as a stronger account login method.
- Password reset must not grant access to old local encrypted data unless the device still has valid local keys.

Passcode/biometric requirements:

- Used to unlock the local app and local encrypted key material.
- Should be device-local and never known to the backend.
- Can be paired with OS secure storage where available.
- May be required by account policy.
- Forgotten passcode recovery should wipe local key material or require device re-enrollment.
- Admin "erase passcode" must mean revoking/wiping local unlock state, not decrypting or recovering messages.
- Biometric unlock should be convenience on top of the local secret, not the only recovery mechanism.

Recovery flow requirements:

- Forgot password: admin or future self-service flow resets account credentials and may revoke sessions.
- Forgot local passcode: device local state is wiped/re-enrolled; old messages may be lost unless another authorized device or future encrypted backup exists.
- Lost device: admin revokes device, rotates relevant membership/device state, and prevents future delivery.
- Compromised account: admin disables account, revokes sessions/devices, and triggers key rotation guidance.

### 4.6 End-To-End Encryption Requirements

- The system must use a proven protocol library rather than a hand-rolled cryptographic protocol.
- libsignal should be the preferred baseline, subject to an early proof-of-concept for browser/Tauri/mobile builds.
- Each user device must have its own cryptographic identity and prekey material.
- Each agent runtime/device must have its own cryptographic identity and prekey material.
- The backend must store public identity keys, signed prekeys, and one-time prekeys as needed.
- The backend must never store plaintext private keys, plaintext message bodies, plaintext media keys, or decryptable recovery material.
- Direct messaging must establish encrypted sessions between sender device and recipient device(s).
- Group messaging must support encrypted delivery to all authorized recipient devices.
- For small groups and MVP simplicity, per-recipient/device encrypted fanout is acceptable.
- For larger groups, evaluate Signal Sender Keys or another established group-messaging pattern supported by the chosen library.
- Membership changes must trigger key/session updates so removed members do not receive future messages.
- New room members should not automatically receive old encrypted history unless a future explicit history-sharing feature is designed.
- Device addition must not silently receive old local history from other devices without a user-approved encrypted transfer/backup mechanism.
- The client should support trust verification later, such as safety numbers or identity change warnings.
- Identity key changes must be surfaced as security events.
- The protocol layer must include replay protection, message IDs, timestamps, and idempotency.
- The system must include cross-client crypto test vectors before production use.

### 4.7 Messaging And Delivery Requirements

- Messaging APIs must accept encrypted envelopes only.
- Each envelope must have an idempotency key.
- Each envelope must identify sender device, room, recipient device or fanout target, timestamp, and content type metadata.
- The server must validate authorization to send to the room before accepting an envelope.
- The server must fan out or coordinate fanout to authorized recipient devices.
- Online recipients should receive messages through WebSockets coordinated by Durable Objects.
- Offline recipients should receive messages from an encrypted mailbox with TTL and quota limits.
- Delivery acknowledgement must remove or mark delivered envelopes.
- Message resend/retry must be idempotent.
- The backend must support ordered room event metadata without seeing plaintext content.
- The client must maintain local transcript state and reconcile delivery events.
- The system should support delivery receipts in the MVP.
- Read receipts should be optional and likely disabled by default or privacy-controlled.
- Typing indicators should be optional and can be sent as ephemeral encrypted or metadata-minimized events.
- Presence must be privacy-conscious and configurable.
- Push notifications should contain minimal plaintext, such as "New message", unless the user opts into previews generated locally where possible.
- Offline delivery retention must be explicit, such as 7 to 30 days for early production depending on storage cost and privacy policy.
- The MVP should enforce low default limits and make larger limits a policy/quota upgrade.

### 4.8 Rooms, Groups, Channels, And Permissions Requirements

- All conversations must be modeled as rooms.
- `direct` rooms contain one-to-one or small direct participant sets.
- `group` rooms are MVP shared conversations with multiple users and agents.
- `channel` rooms are future specialized group rooms with stricter posting, topics, hierarchy, and possible threads.
- Room creation must validate user quota.
- Default group quota should start small, such as 5 groups per user, with a request-more flow.
- Room owners can invite users and agents.
- Room owners can assign admins.
- Role permissions should be explicit rather than hardcoded everywhere.
- Owners should be able to transfer ownership.
- Ownership transfer should require confirmation and must preserve at least one active human owner.
- Agents should not be the sole room owner by default.
- Admin permissions should be granular:
  - invite members
  - remove members
  - manage room name/avatar/description
  - manage agents
  - manage roles
  - archive room
  - request quota increase
  - manage notification defaults
- Room deletion should be carefully defined. In an E2EE system, server-side deletion can remove metadata and future access, but cannot reliably erase already-delivered local copies.
- Room archiving should be supported before destructive deletion.
- Membership changes must be auditable.
- Invites should expire.
- Invite acceptance should trigger cryptographic setup for future messages only.
- Removed users must stop receiving future envelopes.
- Blocked/disabled users must not receive new delivery.

### 4.9 Sidebar Collections Requirements

- Sidebar Collections are the decided replacement name for OG/organizational groups.
- Sidebar Collections are owned by an individual user.
- Sidebar Collections are not inherited from room owners.
- Sidebar Collections do not grant permissions.
- Sidebar Collections do not affect membership.
- A room can appear in one collection, multiple collections, or no collection depending on the user's preferences.
- Collections must have manual sort order.
- Collections must support expand/collapse.
- Collections must show aggregate unread counts and attention indicators from contained rooms.
- Collections should sync across a user's devices.
- Local-only collection state can be allowed temporarily, but server sync is better for multi-device consistency.
- A default collection may be created automatically for new users, but the user can reorganize it.
- Individual room lists can sort by recent activity, but collection order itself should stay manually controlled by the user.

### 4.10 Agent Requirements

- Agents must be represented as service principals, not fake human users.
- Agents must have distinct display metadata and UI badges.
- Agents must have cryptographic identities and device/runtime records.
- Agents can send and receive direct messages.
- Agents can be added to group rooms.
- Agents are owned by a human user or system owner.
- Normal users cannot create agents directly in the MVP.
- Users can submit an agent request form.
- The request form should create an `agent_requests` record or hit a placeholder endpoint.
- Agent provisioning approval remains an admin/superuser function.
- Agent runtime delivery may support WebSocket, polling, webhook, or queue-based integration.
- Agent delivery configuration should support a future "message sink" setting, such as local runtime storage, external agent service storage, or server-side encrypted mailbox delivery.
- Agent endpoints must authenticate strongly.
- Agent messages must use the same encryption rules as user messages.
- Agent logs must avoid plaintext content unless the agent runtime itself is intentionally configured to store its own decrypted working context outside this app's backend.
- The chat backend should not become the agent memory store. It routes encrypted messages and stores agent metadata; the agent runtime decides what decrypted context it keeps.
- Agent communication rules within groups should be a future capability tied to the agent runtime, not the initial chat backend.

### 4.11 Content, Markdown, And Media Requirements

Text and Markdown:

- Messages must support plain text.
- Messages must support safe Markdown because humans write text and agents often produce Markdown.
- Markdown rendering must sanitize output.
- Raw HTML should be disabled by default.
- Unsafe links, script URLs, remote embeds, and untrusted iframe/content injection must be blocked.
- Code blocks, lists, headings, links, blockquotes, and tables can be supported if sanitized.
- Message metadata should identify content type, such as `text/plain` or `text/markdown`.

Media:

- Media must be encrypted client-side before upload.
- R2 should store only encrypted blobs.
- The encrypted message envelope should include the blob reference and encrypted content key material for authorized recipients.
- Uploads should use signed URLs or Worker-mediated upload sessions.
- Downloads should use signed, short-lived URLs or Worker-mediated authorization.
- The backend must store media metadata: blob ID, encrypted size, MIME hint, uploader, room ID, creation time, expiration time, and retention state.
- The backend should not trust client MIME type alone.
- Thumbnails/previews should be generated client-side and encrypted if stored.
- Media should have size caps in the MVP.
- Media should have retention/garbage collection rules.
- Orphaned media uploads must expire automatically.
- If a room is deleted or archived, media retention behavior must be explicit.

Chosen content/media model:

- Message text lives in local client databases after decryption.
- Offline message envelopes live temporarily on the server in encrypted form.
- Group rooms do not have plaintext server-side history.
- Media blobs live in R2 encrypted at rest by the client.
- The server stores media pointers and encrypted envelope references, not decryption keys.
- Clients are the source of readable transcript history.
- Future encrypted backup/history sync can be added explicitly, but it is not assumed.

### 4.12 Storage And Retention Requirements

- D1 stores durable metadata, not plaintext messages.
- Durable Objects store or coordinate short-lived state, connection state, sequencing, and possibly short-retention mailbox state where appropriate.
- R2 stores encrypted media/blob objects.
- KV stores non-authoritative cache/config only.
- Expiration rules must exist for:
  - undelivered envelopes
  - orphaned media uploads
  - old signed upload/download sessions
  - stale invites
  - revoked device prekeys
  - stale presence records
- Retention defaults must balance privacy, usability, and cost.
- Admin audit logs should be retained longer than message envelopes, but must avoid content.
- Deleted users should move through disabled/archived/deleted states to avoid accidental irreversible loss.
- Export/delete behavior should be defined before onboarding external clients at scale.

### 4.13 Admin Console Backend Requirements

- Superuser login must be protected more strongly than normal user login.
- Admin routes must be separate by permission checks and ideally by route namespace or Worker boundary.
- Admin APIs must support:
  - create user
  - edit user profile metadata
  - disable/enable user
  - force credential change
  - reset account password
  - revoke sessions
  - revoke devices
  - set email/phone requirement policies
  - set local passcode requirement policy
  - view user devices
  - view room metadata
  - view group ownership/admins
  - manage quotas
  - approve/deny group quota requests
  - review agent requests
  - provision or link agents
  - view audit events
  - trigger cleanup/retry jobs where safe
- Admin APIs must not expose plaintext messages or media.
- Admin actions must be audited.
- Admin action audit records must include actor, target, action, timestamp, IP/device metadata where available, and result.
- Dangerous admin actions should require confirmation and possibly re-authentication.

### 4.14 Security Requirements

- Threat model must be written before production.
- Server must assume message content is opaque ciphertext.
- Backend validation must enforce room membership and permissions before accepting any envelope.
- All APIs must validate input with shared schemas.
- All state-changing APIs must be idempotent or transactionally safe.
- Rate limiting must exist for login, message send, prekey upload, media upload, room creation, invite creation, and agent requests.
- Strict CORS and origin policies must be used for web/admin.
- Tauri capabilities must be least-privilege by platform and window.
- Content Security Policy must be strict.
- No raw Markdown HTML should be allowed.
- Secrets must not be committed to git.
- Wrangler secrets or Cloudflare Secrets Store should hold deployment secrets.
- Dependency scanning should run in CI.
- Crypto code must be covered by interop tests and test vectors.
- Session tokens must be scoped, expiring, and revocable.
- Device revocation must take effect quickly.
- Audit logs must be tamper-resistant enough for MVP operations, with stronger append-only guarantees later.
- Error messages must not leak account existence or sensitive routing data where avoidable.
- Abuse controls must exist even though content cannot be inspected.

### 4.15 Privacy And Metadata Requirements

- The backend cannot avoid all metadata, but should minimize it.
- Store only routing metadata needed for delivery and administration.
- Avoid logging message ciphertext bodies unless necessary for debugging, and disable any such logging in production.
- Avoid storing media filenames in plaintext unless there is a user-facing reason.
- Use generic push notification text by default.
- Provide configurable read receipts.
- Provide configurable presence.
- Make it clear in documentation that admins can manage accounts and metadata but cannot decrypt content.
- Future privacy work should evaluate sealed sender-like designs, but this is not required for MVP.

### 4.16 Cost, Quota, And Scaling Requirements

- The MVP must include quotas to protect Cloudflare free-tier usage.
- Default user group limit should be small, such as 5.
- Group limit increases should use a request workflow.
- Media size limits should be conservative at first.
- Per-user and per-room offline envelope limits must exist.
- Prekey upload limits must exist to prevent abuse.
- Rate limits must protect account creation, invites, messaging, and uploads.
- R2 object lifecycle cleanup must be configured.
- D1 queries must be indexed for common lookups to reduce rows read.
- Durable Object usage must be partitioned sensibly by room, user, or connection domain to avoid hot objects.
- WebSocket hibernation should be used for cost-sensitive realtime workloads.
- Feature flags should allow disabling expensive features quickly.
- Billing/usage dashboards should be available in the admin console or internal ops view later.

### 4.17 CI/CD And Operations Requirements

- Every commit should run linting, type checking, tests, and build validation.
- Backend deploys should be automated through GitHub push/merge.
- Wrangler configuration should define environment-specific bindings.
- D1 migrations must be versioned and applied through CI or a controlled release command.
- Preview environments should not share production secrets or production databases.
- Production deploys should support rollback.
- Compatibility dates for Workers should be pinned and updated intentionally.
- Release notes should include migration and operational changes.
- Local development should use Miniflare/Wrangler-compatible workflows.
- Seed scripts should exist for local superuser/dev data only.

### 4.18 Observability Requirements

- Log API errors without plaintext message content.
- Track metrics for:
  - API request count and latency
  - WebSocket connections
  - envelope accepted/delivered/expired
  - offline mailbox depth
  - media upload/download count
  - D1 read/write usage
  - R2 storage and operation usage
  - Durable Object errors/restarts
  - failed logins and lockouts
  - prekey exhaustion
  - queue failures/dead letters if Queues are used
- Alert on:
  - login attack patterns
  - elevated send failures
  - prekey depletion
  - storage quota pressure
  - cleanup job failure
  - Durable Object hot spots
  - unexpected cost growth

### 4.19 Testing Requirements

- Unit tests for domain permissions, room roles, quotas, and policy evaluation.
- API integration tests for authentication, user lifecycle, room lifecycle, device registration, prekeys, send/receive, and media upload sessions.
- Durable Object tests for WebSocket coordination, fanout, ordering, hibernation recovery assumptions, and presence.
- D1 migration tests.
- Crypto protocol proof-of-concept before broad app implementation.
- Cross-platform tests for libsignal bindings in web, Tauri desktop, iOS, and Android.
- End-to-end tests for direct messaging and group messaging.
- Security tests for unauthorized room send/read attempts.
- Markdown sanitizer tests with malicious payloads.
- Rate-limit and quota tests.
- Load tests for small groups, agent-heavy rooms, and offline backlog delivery.
- Recovery tests for password reset, passcode wipe, device revocation, and account disable.

### 4.20 Backend Milestone Plan

Milestone 1: foundation

- Define domain model and D1 schema.
- Set up Cloudflare Workers, Durable Objects, D1, R2, KV, and environment bindings.
- Set up CI/CD with Wrangler.
- Bootstrap superuser.
- Implement typed API contracts.

Milestone 2: identity and auth

- Implement admin-created users.
- Implement login, forced credential change, sessions, and device registration.
- Implement password/passcode policy records.
- Implement basic admin console APIs.

Milestone 3: cryptographic proof-of-concept

- Validate libsignal in target environments.
- Register device identities and prekeys.
- Send encrypted direct messages between two devices.
- Confirm server cannot decrypt content.

Milestone 4: realtime delivery

- Implement WebSocket connection handling with Durable Objects.
- Implement encrypted envelope acceptance, authorization, fanout, ack, retry, and TTL.
- Implement offline encrypted mailbox.

Milestone 5: groups and agents

- Implement group rooms, memberships, roles, owner/admin permissions, and ownership transfer.
- Implement agent service principals and agent runtime/device records.
- Implement agent participation in direct and group rooms.
- Implement placeholder agent request endpoint.

Milestone 6: media and polish

- Implement encrypted R2 media upload/download flow.
- Implement cleanup lifecycle.
- Implement quotas and request-more flow.
- Implement audit logs and operational dashboards.

## 5. Frontend High-Level And General Ideas

### 5.1 Frontend Architecture

- Use SvelteKit for the shared UI application.
- Use Tauri for desktop and mobile packaging.
- Keep shared client logic in packages that are independent of platform-specific shell code.
- Keep crypto, local database, API client, and UI components separated.
- Use the same typed backend contracts in the frontend.
- Prefer mobile-first interaction patterns for the chat client.
- Build the admin console as a more desktop-friendly operational interface.

Suggested frontend structure:

```text
apps/
  chat-web/            SvelteKit web chat client.
  chat-tauri/          Tauri shell for desktop/mobile chat, sharing chat UI.
  admin-web/           SvelteKit admin console.
packages/
  api-client/          Typed backend client.
  crypto-client/       libsignal adapter and local key management boundary.
  local-store/         Local encrypted DB abstractions.
  ui/                  Shared UI primitives.
  chat-features/       Rooms, messages, sidebar, presence, media features.
```

### 5.2 Chat UI Direction

- Mobile should feel closer to Signal, Telegram, or WhatsApp than Slack mobile.
- Desktop can feel more like Telegram, Discord, or Slack where sidebar density helps.
- The first screen should be the actual inbox/chat interface, not a marketing screen.
- Direct messages and group rooms should appear in the main conversation list.
- Normal conversation lists should sort by latest delivered activity.
- Sidebar Collections should be collapsible sections with manual ordering.
- Rooms inside collections can still surface unread/attention states.
- Agents should have a distinct badge or icon everywhere they appear.
- Group participant lists should clearly separate humans and agents where useful.
- Message composer should support plain text and Markdown-aware composition.
- Rendered Markdown should feel natural for agent responses without exposing unsafe HTML.
- Media attachments should show local previews after decryption.
- Offline, sending, sent, delivered, failed, and expired states should be visible but unobtrusive.

### 5.3 Admin UI Direction

- The admin console should be quiet, dense, and operational rather than marketing-like.
- Priority screens:
  - users
  - devices
  - rooms
  - agents
  - agent requests
  - quotas
  - policies
  - audit logs
- Dangerous actions should require confirmation.
- Admin views should repeatedly reinforce that message content is unavailable because of end-to-end encryption.

### 5.4 Local Data And Device Security

- Tauri desktop/mobile should use OS secure storage where available for key wrapping or unlock secrets.
- Local messages should be stored in an encrypted local database.
- The local app passcode/biometric should unlock local state.
- Web should use browser storage carefully and may need a reduced-trust warning or stricter session behavior.
- Device revocation should lock the local app out from future server sync.
- Local deletion should be distinct from server metadata deletion.

### 5.5 Frontend Alignment With Backend

- Frontend room types must map directly to backend room types.
- Sidebar Collections must remain user-scoped in the UI and API.
- Group role controls must mirror backend permissions.
- Agent badges must come from backend agent identity, not name heuristics.
- Message rendering must respect backend content type metadata.
- Media views must assume encrypted R2 blobs and local decryption.
- Login flows must distinguish account password from local passcode.
- Recovery flows must clearly explain when data may be wiped or unrecoverable.

## 6. Immediate Next Planning Documents

These documents should be created before implementation starts:

- Threat model.
- E2EE protocol integration note and libsignal proof-of-concept plan.
- Cloudflare service architecture diagram.
- D1 schema draft.
- API contract draft.
- Room and permissions specification.
- Account recovery and device revocation specification.
- Media encryption and retention specification.
- MVP milestone checklist.
