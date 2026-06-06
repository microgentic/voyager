# Secure Client-Agent Communications Master Plan

Status: pre-implementation architecture baseline, approved for Phase 0 only
Date: 2026-06-06
Source notes: combines `docs/brainstorming.md`, `docs/project-architecture-plan.md`, `docs/new-report.md`, and the accepted portions of `docs/review.md`. The source files were not edited.

## 1. Detailed Project Report

### 1.1 Project Vision

This project is a private, end-to-end encrypted communication platform for clients, human team members, and AI agents. It should behave like a normal secure messenger while making AI agents first-class participants rather than bolted-on chatbot endpoints.

The goal is to replace insecure or unsuitable third-party operational channels such as Telegram, Slack, Discord, and similar tools for sensitive client-agent communication. A user should be able to chat with another user, chat directly with an agent, and participate in a group where humans and agents collaborate under the same security and permission model.

The important product insight from the brainstorming remains central: a conversation can become an operational AI interface. A billing group with billing staff and billing agents effectively becomes a billing operations agent. A support group with support staff and support agents becomes a secure support operations room. The product is therefore both a secure messenger and the communication layer for agentic workflows.

The core promise should be narrow and defensible:

- Authorized endpoints possess the keys needed to decrypt message and attachment content.
- The Cloudflare-hosted messaging backend routes, coordinates, and stores encrypted data, but does not read plaintext message bodies or plaintext attachments.
- Administration can manage accounts, devices, membership, quotas, and metadata, but does not become message-key escrow.

The product must not promise absolute privacy, anonymity, guaranteed deletion from recipient devices, or safety against compromised endpoints. It should explain those limits clearly.

Until trusted-device approval, manual verification, or key transparency is implemented, the MVP security claim should be framed primarily around passive backend compromise, stolen backend data, accidental plaintext exposure, and network interception. A sufficiently privileged malicious or compromised service may still attempt active identity or device-key substitution; that risk requires an explicit Phase 0 threat-model decision before any high-sensitivity pilot.

### 1.2 Product Definition

The platform should be built as a general private messaging product with AI agents as a native principal type.

This means:

- Human-to-human messaging is a real core feature, not a secondary compatibility mode.
- Human-to-agent messaging uses the same secure messaging foundation as human-to-human messaging.
- Agent-to-human and agent-to-group messaging are first-class.
- Groups can contain humans and agents.
- Agents have independent identities, devices/runtimes, permissions, revocation state, and visible UI distinction.
- The server cannot assume agent content is safe simply because the sender is an agent.
- The app remains useful even when a conversation has no agent.

The application should have four major surfaces:

- Client chat app: mobile, desktop, and later web experience for ordinary users.
- Admin console: privileged management surface for the superuser and future delegated administrators. It should be a separately built/deployed privileged bundle or distinct application, not merely a hidden route inside the consumer chat client.
- Agent integration surface: API/runtime path for agents to receive encrypted messages, process them, and send encrypted replies.
- Desktop management surface: likely a Tauri-packaged form of the admin/agent-management UI, not a separate backend.

### 1.3 Product Principles

The architecture should follow these principles, in priority order:

1. Use a reviewed, maintained cryptographic protocol implementation; do not invent one.
2. Treat the cloud backend as a delivery and control plane, not a plaintext archive.
3. Keep account administration separate from message-key recovery.
4. Give every physical device and every agent runtime its own cryptographic identity and revocation state.
5. Include offline delivery in the MVP because mobile messengers must work asynchronously.
6. Keep readable history local by default.
7. Store cloud-retained message data only as encrypted, time-bounded delivery material.
8. Encrypt attachments before upload.
9. Enforce authorization through service permissions and cryptographic membership state.
10. Minimize metadata, but do not pretend metadata is eliminated.
11. Design mobile as a real mobile messenger, not a compressed desktop app.
12. Target zero Cloudflare usage charges at small pilot scale, but do not depend on permanent free-tier guarantees.
13. Make administrative actions explicit, least-privileged, strongly authenticated, and audited.
14. Explain irreversible security behaviors before users experience data loss.
15. Version protocols, schemas, APIs, and local state so the system can evolve.

### 1.4 Core Goals

- Provide secure direct messaging between users.
- Provide secure user-to-agent, agent-to-user, and agent-to-agent-capable messaging paths where appropriate.
- Provide secure group rooms where humans and agents can participate together.
- Preserve end-to-end encryption for message bodies and media.
- Keep the application backend on Cloudflare services.
- Keep early pilot costs as close to zero as possible through quotas and retention limits.
- Support iOS, Android, desktop, and eventually web from a shared architecture.
- Make mobile feel like Signal, Telegram, or WhatsApp rather than Slack compressed onto a phone.
- Provide a superuser/admin console for account provisioning, policies, resets, quotas, agents, groups, and operational oversight.
- Maintain a clean separation of concerns so the project can scale without a rewrite.

### 1.5 Primary Actors

- Superuser: the initial platform owner. Can create accounts, manage policies, approve agents, reset account authentication, revoke devices, review metadata/audit logs, and operate the system. Cannot decrypt E2EE content.
- Platform administrator: future delegated admin role with limited privileges such as user administration, agent provisioning, support, quota management, security administration, or audit review.
- Human user: a client, staff member, or other person using the chat app.
- Group owner: a room participant with ultimate group management rights, subject to transfer and succession rules.
- Group administrator: a delegated group role with explicit permissions.
- Member: ordinary human room participant.
- Agent owner: human principal or account responsible for a specific AI agent.
- AI agent: service principal with its own cryptographic identity and one or more runtime devices. It sends and receives messages like a participant but does not use the standard human UI.
- Agent runtime: the actual environment/process where an agent stores protocol state, decrypts messages, performs work, and encrypts replies.
- Backend service: Cloudflare-hosted APIs, realtime coordination, metadata storage, encrypted blob storage, queues, and operational services.
- Push providers: APNs and FCM or equivalent platform services used for mobile notifications. They are external dependencies, not sources of message truth.

### 1.6 Recommended Technical Direction

Use Tauri 2 plus SvelteKit for desktop/mobile client delivery, with a Rust native security core for sensitive local operations. Use Cloudflare Workers, Durable Objects, D1, R2, Queues, and supporting Cloudflare services for the backend.

Recommended platform split:

- SvelteKit: shared UI, routing, state presentation, static SPA build for Tauri, web/admin frontend foundation.
- Tauri 2: desktop, iOS, and Android shells; native commands; OS integration; secure storage access; notifications; app packaging.
- Rust client security core: cryptographic protocol operations, local encrypted database, attachment encryption/decryption, secure-storage integration, and local sync state.
- Cloudflare Workers: versioned HTTP APIs, auth, account lifecycle, room management, device registration, attachment authorization, admin APIs, agent request intake, rate limiting.
- Cloudflare Durable Objects: realtime WebSocket coordination, conversation sequencing, membership mutation serialization, idempotency, short-lived encrypted message retention, mailboxes, key-package coordination.
- Cloudflare D1: relational control-plane metadata such as accounts, principals, devices, rooms, memberships, policies, quotas, invitations, attachments, agent requests, and audits.
- Cloudflare R2: client-encrypted attachment blobs, encrypted thumbnails, and other opaque encrypted objects.
- Cloudflare Queues: reconstructible async work such as push dispatch, cleanup, webhook retries, audit export, and metrics aggregation.
- Cloudflare KV: non-authoritative cache/config only, if useful.

SvelteKit should not be the cloud backend for the messenger. It can host UI and UI-adjacent routes where appropriate, but mobile, desktop, web, admin, and agents need a stable API-first backend.

Tauri should not be treated as the server backend. Its Rust process runs on a user device. It is the right place for local cryptography and device integration, not global account authority or routing.

### 1.7 Recommended MVP Scope

The MVP should be a credible asynchronous secure messenger, not a shallow demo.

Included in the MVP:

- Invitation-only onboarding.
- Superuser/admin-created accounts.
- One-time activation credentials.
- Forced credential replacement on first activation.
- Passkey support where available.
- Password/passphrase fallback.
- Optional or policy-enforced local app passcode/biometric unlock.
- Human accounts and human messaging principals.
- Agent principals provisioned by an administrator.
- Agent request form and placeholder backend endpoint.
- Per-device cryptographic identities.
- Device listing and device revocation.
- Direct conversations.
- Group conversations.
- Group owner, delegated admin, member, and agent participant roles.
- Controlled ownership transfer.
- Temporary encrypted offline delivery.
- Delivery acknowledgements and synchronization cursors.
- Client-encrypted attachments stored in R2.
- Plain text and constrained Markdown message content.
- Personal Sidebar Collections.
- Separate privileged management console.
- Push notification integration with generic or encrypted-safe payload behavior.
- Rate limits, quotas, audit logs, observability, and automated deployment.
- Local encrypted message history.
- Explicit retention and deletion behavior.

Deliberately deferred:

- Public self-registration.
- Mandatory email or phone verification for invited users.
- User-created or automatically provisioned agents.
- Full Slack-style channels.
- Full threaded-conversation navigation.
- Thread-specific unread state.
- Voice and video calls.
- Server-searchable message content.
- Server-side message previews or attachment transformation.
- Automatic plaintext backup.
- Cross-device encrypted history backup.
- Enterprise SSO, SCIM, legal hold, e-discovery, or compliance certifications.
- Advanced agent behavior and tool-permission policy.
- Federation with third-party messaging networks.
- Anonymous communication or traffic-analysis resistance.
- Guaranteed remote deletion from recipient devices.

### 1.8 Threat Model And Security Boundaries

Threats the design should materially reduce:

- Network interception.
- Unauthorized reading of message content from Cloudflare databases, objects, logs, or backups.
- Theft of a server-side database.
- Unauthorized account login.
- Replayed message submissions.
- Unauthorized group membership changes.
- Accidental plaintext logging.
- Malicious attachment substitution.
- Stolen devices that remain locked.
- Compromised administrator credentials.
- Abuse of invitations, login, upload, and agent endpoints.
- Duplicate messages caused by retries.
- Accidental retention beyond policy.
- Dependency and CI/CD supply-chain compromise.
- Unauthorized use of an old or revoked device.

Threats the MVP cannot fully solve:

- Malware, screen capture, or clipboard capture on an unlocked endpoint.
- A malicious or compromised group member.
- An AI agent runtime that leaks decrypted input.
- An administrator denying service, deleting accounts, changing metadata, or revoking access.
- Cloudflare, Apple, Google, network providers, or ISPs observing some timing, IP, size, and delivery metadata.
- Recipients copying, forwarding, photographing, or retyping messages.
- Traffic analysis.
- Legal or physical coercion.
- Unpatched cryptographic-library vulnerabilities.
- Loss of local history after device reset when no encrypted backup exists.
- Notification previews shown by the OS after local processing.
- Plaintext recovery from recipient-side backups outside this app.

### 1.9 Metadata Reality

Even with correct end-to-end encryption, the backend will normally observe some metadata:

- Account and device identifiers.
- Principal identifiers.
- Conversation identifiers.
- Group membership and role records.
- Message submission time.
- Delivery status and approximate receipt time.
- Ciphertext length.
- Attachment object size.
- IP address and request metadata at the edge.
- Push token and platform.
- Administrative events and abuse signals.

The system should minimize retention, avoid content-derived analytics, separate identifiers where practical, and document remaining metadata honestly. Private-group metadata, sealed-sender-like designs, and stronger anonymity techniques can be evaluated later, but they should not be claimed for the MVP.

### 1.10 End-To-End Encryption Protocol Direction

The combined recommendation updates the previous libsignal-first direction:

- Leading candidate: MLS through a validated Rust implementation, with OpenMLS as the first proof-of-concept candidate.
- Comparison candidate: libsignal, subject to licensing, support, integration, and maintenance review.
- Rejected path: custom cryptography.

Why MLS/OpenMLS should lead Phase 0:

- MLS is a standardized protocol for asynchronous secure groups.
- A direct conversation can be represented as a two-principal conversation whose cryptographic group may contain multiple authorized device clients.
- Direct messages and groups can share one high-level cryptographic model.
- Group membership changes are represented through explicit cryptographic epochs.
- MLS is designed to scale better than naive pairwise fanout for larger groups.
- OpenMLS is Rust-based, aligning with the Tauri security core and agent runtime direction.
- OpenMLS has a more product-friendly starting point than relying on an unsupported external libsignal integration.

Important qualification:

This is not permission to ship without validation. Phase 0 must prove the selected protocol and implementation across iOS, Android, desktop, agent runtime, and potentially web/WASM if a browser client remains in scope.

Phase 0 must validate:

- Mobile builds.
- Desktop builds.
- WebAssembly feasibility if web is retained.
- Persistent state serialization.
- Secure storage-provider integration.
- Offline message and commit delivery.
- New-device enrollment.
- Device removal.
- Member removal.
- Group recovery after interrupted commits.
- Library version upgrades.
- Target group performance.
- License and dependency obligations.
- Interoperability and test-vector behavior.

Why libsignal is no longer the default:

- The official libsignal repository says use outside Signal is unsupported and APIs/bridges may change without notice.
- The repository is AGPL-licensed, which needs legal review before product use.
- It remains technically strong and should be compared, but it should not be assumed to be a stable plug-and-play public SDK.

### 1.11 Cryptographic Identity Model

The backend should distinguish:

- Account: authentication, billing, policy, and administrative entity.
- Principal: messaging identity representing a human or an agent.
- Device: physical client installation or agent-runtime instance.
- Cryptographic client: device-level MLS member and private state holder.

Example human user:

- One account.
- One human principal.
- Phone device.
- Desktop device.
- Each device has its own credentials and protocol state.

Example agent owner:

- One account.
- One human principal.
- One or more agent principals.
- One or more runtime devices for each agent.

Device-level membership supports:

- Revoking one device without deleting the account.
- Transparent device lists.
- Safe multi-device delivery.
- Independent key rotation.
- Agent-runtime replacement.
- Clear delivery eligibility.
- Future device-transfer and encrypted-backup flows.

The authentication service must bind device credentials to account ID, principal ID, device ID, principal type, credential version, creation state, and revocation state.

Clients should eventually display device changes and support verification fingerprints or QR verification for high-assurance relationships.

### 1.12 Password And Passcode Decision

The password/passcode dilemma should be resolved by supporting both, because they solve different problems.

Account password/passkey:

- Authenticates to the cloud service.
- Creates and refreshes sessions.
- Authorizes account management.
- Can be reset by an audited admin or future self-service flow.
- Should prefer passkeys/WebAuthn where available.
- Should support password/passphrase fallback.
- Should allow long passwords and password-manager-generated credentials.
- Should block common and breached passwords.
- Should not require arbitrary composition rules.
- Should not force periodic rotation without evidence of compromise.
- Must be rate-limited and protected against enumeration.
- Must use a password strategy suitable for Cloudflare Workers runtime constraints.

Local app passcode/biometric:

- Unlocks the local app.
- Protects release of a random local database key or wrapping key.
- Protects local message history and local private state while locked.
- Remains device-local and is not sent to the server.
- Can be optional in the smallest pilot and policy-enforced later.
- Can use biometrics as a convenience layer over platform-protected key access.
- Must not be directly derived from the account password.

Reset semantics:

- Admin can reset service authentication, invalidate sessions, revoke devices, and require re-enrollment.
- Admin cannot recover local passcodes, derive local database keys, decrypt historical conversations, or silently add a replacement cryptographic device.
- Forgotten local passcode means destructive local reset and device re-enrollment unless a future encrypted backup/history-transfer design exists.
- A server-side "erase passcode" action can initiate revocation and re-enrollment, but cannot magically alter a secret that exists only on an unreachable local device.
- Remote wipe is best-effort and must not be represented as guaranteed.

### 1.13 Onboarding And Verification

MVP onboarding:

- No public registration page.
- Admin creates an account shell and named invitation.
- Invitation token is high-entropy, single-use, and short-lived.
- Only a hash of the activation token is stored server-side.
- User accepts the invitation and establishes passkey and/or password.
- Initial device creates local cryptographic identity and local storage keys.
- Public device credential and key package are registered.
- Activation token is invalidated.
- User is shown recovery and history-loss behavior before finishing setup.

Email and phone:

- Optional for MVP.
- Stored as contact/recovery attributes if collected.
- Verification status stored separately from identity assurance.
- Admin policy can require email or phone later.
- SMS should not be treated as strong identity proof or preferred admin MFA.
- Recovery changes should trigger notifications and audit events.

### 1.14 Message And Offline Delivery Model

Offline encrypted delivery is mandatory for the MVP. Mobile operating systems suspend applications and network sockets routinely; rejecting messages when a recipient is offline would make the product unreliable.

Recommended lifecycle:

1. Sender client encrypts the application message.
2. Sender submits a versioned opaque envelope.
3. Conversation coordinator authenticates sender device and verifies current membership.
4. Coordinator applies idempotency and replay checks.
5. Coordinator assigns a server sequence for delivery and synchronization.
6. Ciphertext is stored temporarily.
7. Online eligible devices receive realtime pointer events.
8. Offline devices receive mailbox pointers and generic push notifications.
9. Devices fetch and persist ciphertext.
10. Devices acknowledge durable local receipt.
11. Server purges ciphertext after all eligible devices acknowledge or the retention deadline expires.

Initial retention recommendation:

- Pending message ciphertext: 14 days as a pilot policy default, not a hard-coded constant.
- Configurable pilot range: 1 to 30 days.
- Delete earlier when all eligible devices acknowledge.
- Explain that messages may be unavailable to a device offline beyond retention.
- Do not store plaintext or server-generated searchable content.
- Validate all retention defaults against client open frequency, agent uptime, attachment size, number of devices, Cloudflare usage, customer expectations, account inactivity, and privacy/legal needs.

Eligible delivery device:

- Not revoked.
- Member of the relevant conversation epoch.
- Within supported inactivity window.
- Not explicitly excluded from history by policy.

Readable history lives in the local encrypted client database. Server-side temporary ciphertext is a delivery mechanism, not a permanent history archive.

New devices receive future messages by default. Old local history is not automatically restored unless a later encrypted transfer or backup feature is intentionally designed.

### 1.15 Conversation Model

Use a single conversation abstraction with versioned kinds:

- `direct`: two-principal conversation whose cryptographic group may contain multiple authorized device clients.
- `group`: MVP multi-participant room for users and agents.
- `channel`: future specialized conversation kind with distinct semantics.

Groups should be in the MVP because they are core to the agentic workflow idea.

Channels should be deferred until they have meaningful product differences, such as:

- Workspace-level membership inheritance.
- Discoverability.
- Posting restrictions.
- Announcement-only behavior.
- Long-term topic organization.
- Thread-first interaction.
- Distinct retention or moderation policy.

Do not create channels as a visual-only flag on groups.

Replies and threads:

- Reserve optional `reply_to_message_id` in the encrypted payload.
- Support simple quote/reply context if feasible.
- Defer full threads, thread-specific subscriptions, thread-only unread counts, thread retention, and thread membership.

### 1.16 Group Ownership And Permissions

Ownership transfer should be supported. Permanent creator-only ownership will eventually create abandoned or unmanageable groups.

Required safeguards:

- Current owner or authorized emergency administrator initiates transfer.
- Receiving human principal explicitly accepts.
- High-risk reauthentication is required.
- The action is audited.
- The room may never be left without an owner.
- Creator attribution remains immutable historical metadata.
- Agent should not be the sole owner by default.
- Suspended owner triggers explicit succession workflow, not automatic hidden transfer.

Suggested roles:

- Owner: transfer ownership, archive/delete group, appoint/remove admins, configure group policy, invite/remove members, change metadata, manage agent participation, request quota changes.
- Administrator: granular permissions such as invite members, remove members, update group metadata, manage ordinary roles, approve join requests, pin messages or moderation tombstones, manage agent participation, view operational metrics.
- Member: receive messages, send if allowed, attach media if allowed, leave group, view visible membership.
- Agent participant: cryptographic principal that is visibly labeled as an agent and can send/receive under membership and future agent-policy rules.

Every membership mutation must satisfy both:

- Service-level authorization.
- Valid cryptographic membership transition.

Removing a member from service state without updating the cryptographic epoch is incomplete. Updating the epoch without service authorization is also incomplete.

### 1.17 Sidebar Collections

The brainstorm's organizational groups idea should be retained but named Sidebar Collections or Collections.

Collections are:

- Personal to each user.
- Not inherited from room owners.
- Not visible to other participants.
- Not permission-bearing.
- Not a substitute for groups or organizations.
- Manually ordered.
- Collapsible.
- Able to contain direct conversations, groups, and future channels.
- Able to show aggregate unread/activity indicators.

Conversation lists can sort by latest delivered activity. Collection order itself should remain manual.

Recommended MVP storage:

- Store Collections in the local encrypted database.
- Include an All Chats view.
- Include Unsorted or equivalent fallback.
- Optionally sync an encrypted opaque Collection-state blob across the user's devices later.

The server should never interpret Collection names or use them for access control.

### 1.18 Agent Model

Agents are first-class messaging principals with special provisioning and runtime behavior.

Agent properties:

- Principal type `agent`.
- One or more runtime/device credentials.
- Separate cryptographic identity state.
- Human owner.
- Visible agent badge and immutable principal-type indicator.
- Direct-message capability.
- Group-membership capability.
- Independent suspension and revocation state.
- Rate and quota policies.
- No requirement for normal consumer UI.

Creation and ownership:

- Ordinary users cannot create agents directly in the MVP.
- A user can submit an agent request.
- The request endpoint stores requirements and workflow state.
- Provisioning remains administrative and outside the core messaging MVP.
- Requester becomes default business owner after approval.
- Admin can reassign ownership through audited workflow.

Agent runtime contract:

1. Authenticate as a service device.
2. Maintain persistent encrypted cryptographic state.
3. Establish WebSocket or use bounded polling.
4. Receive opaque encrypted message.
5. Persist ciphertext before acknowledgement.
6. Decrypt locally.
7. Validate message type and policy.
8. Pass approved content to the agent application.
9. Produce explicit content type.
10. Encrypt reply.
11. Submit reply with idempotency key.
12. Retain enough state to avoid duplicate side effects.
13. Support pause, revoke, rotate, and re-enroll operations.

The chat backend must not become the agent memory store. It routes encrypted messages and stores agent metadata. The agent runtime decides, under separate policy, what decrypted context it keeps.

Chat membership does not grant tool permissions. Agent tool use, mention-only behavior, autonomous participation, business rules, and memory retention require a later agent-policy subsystem.

### 1.19 Content And Media Storage Decision

The selected content/media model is client-encrypted shared blobs with bounded R2 retention.

Rejected options:

- Persistent plaintext group storage on the server.
- R2 as active message queue or group database.
- Normal operation based on peer-hosted sender devices.

Recommended attachment flow:

1. Sender generates random per-file encryption key and nonce.
2. Sender encrypts file locally with approved AEAD profile.
3. Sender requests short-lived upload authorization.
4. Worker authorizes random opaque object ID.
5. Client uploads ciphertext to private R2 bucket.
6. Client sends E2EE message containing encrypted attachment metadata, object ID, decryption key, nonce/algorithm parameters, integrity data, original filename, media type, plaintext size, optional encrypted thumbnail reference, and expiration class.
7. Recipient authorizes short-lived download.
8. Recipient downloads and decrypts locally.
9. R2 lifecycle and cleanup jobs delete encrypted object after expiry.

Why this is best:

- Works when sender is offline.
- Uploads one encrypted object rather than one full file per recipient.
- Does not expose plaintext to Cloudflare.
- Avoids NAT traversal and TURN infrastructure.
- Works on mobile networks.
- Uses R2 for object storage rather than message coordination.
- Controls cost through retention and quotas.
- Preserves consistent group UX.

Object identity:

- Use random opaque object IDs.
- Do not use plaintext file hashes as R2 object keys because they reveal equality and enable known-file probing.
- If validation is needed, store ciphertext hash and byte length.

Initial attachment retention:

- Ephemeral class: 7 days as a pilot policy default.
- Default class: 30 days as a pilot policy default.
- Extended or pinned class: deferred until billing and policy exist.
- Retention class must be read from policy data and must not be hard-coded into clients or Workers.

Previews:

- Generate thumbnails on sender device.
- Encrypt thumbnails before upload.
- Do not do server-side plaintext image resizing or inspection.
- Treat decrypted files as untrusted on clients.
- Enforce size and permitted-type policies before and after decryption where possible.

Post-expiry behavior:

- Recipients who already downloaded retain local copy.
- Recipients who did not download see an expired attachment state.
- Service does not automatically fetch object from peer devices.
- Re-upload requires a new attachment message.

Attachment access after member removal:

- Default policy: removal immediately blocks new attachment download authorizations from the backend.
- Already downloaded local copies cannot be revoked.
- Already delivered encrypted attachment keys cannot be unlearned by the removed member.
- A short-lived download URL issued before removal may remain usable until expiry unless the implementation supports revocation.
- Possession of an object ID or encrypted message reference is not enough to authorize a new R2 download.
- A more permissive "historical access while member at send epoch" policy is deferred and must be a deliberate room policy decision.

### 1.20 Plain Text And Markdown

Message formatting should be explicit and safe.

Initial content types:

- `text/plain`
- `text/markdown`
- `system/event`
- `attachment/reference`

Rendering policy:

- Plain text is default composer mode.
- Agents may emit Markdown by default.
- Humans may choose Markdown where enabled.
- Raw HTML is disabled.
- Rendered Markdown is sanitized on every client.
- Remote images and tracking pixels are blocked by default.
- Links display destination and use safe navigation behavior.
- Dangerous URL schemes are rejected.
- Code blocks are inert text unless copied by user.
- No message is trusted because it came from an agent.
- Message envelope declares renderer/schema version for future compatibility.

"Agents speak Markdown" is a useful UX idea, not a security rule.

### 1.21 Management Console

The management console is a privileged control plane and should be separated from ordinary chat.

Responsibilities:

- Create and expire invitations.
- Activate, suspend, archive, and restore accounts.
- Reset authentication access.
- Revoke sessions and devices.
- Enforce password, passkey, local-lock, email, phone, and verification policies.
- Manage account and group quotas.
- Approve agent requests.
- Provision, pause, revoke, and reassign agents.
- View group membership and ownership metadata.
- Start emergency ownership-succession workflows.
- View service health, usage, cost-risk indicators, and audit events.
- Initiate deletion workflows.
- Manage environment-level policy.

Prohibited capabilities:

- Display decrypted messages.
- Export plaintext history.
- Derive device keys.
- Recover passcodes.
- Impersonate a user cryptographically.
- Silently add an administrator device to a conversation.
- Suppress visible device-change events.

Privileged access design:

- Mandatory passkey or phishing-resistant MFA.
- Separate administrative roles from ordinary messaging roles.
- Short privileged sessions.
- Reauthentication for destructive operations.
- Least-privileged subroles.
- No routine shared superuser credential.
- Break-glass account stored, isolated, and monitored separately.
- Complete audit trail.
- Alerts on resets, role changes, agent provisioning, mass revocation, and policy changes.

### 1.22 Cloudflare-Only Hosting Constraint

The application backend should be hosted on Cloudflare:

- APIs.
- Realtime coordination.
- Relational metadata.
- Encrypted object storage.
- Background jobs.
- Static web/admin assets.

The constraint cannot literally cover every dependency:

- iOS push requires Apple Push Notification service.
- Android push typically requires Firebase Cloud Messaging or equivalent.
- iOS and Android distribution require platform ecosystems.
- GitHub Actions is external if retained for CI/CD.
- Code-signing authorities and domain registration are external.
- Agent runtimes run in their own environments by design.

Correct interpretation:

- The application backend and control plane are Cloudflare-hosted.
- Platform-required push, distribution, signing, CI/CD, and external agent runtime dependencies are documented.

### 1.23 Pilot Cost Strategy

The goal is zero Cloudflare usage charges at small pilot scale, not permanent guaranteed free operation.

Cost controls required from the first release:

- Maximum active groups owned per user, initially around five.
- Separate limit for group memberships.
- Maximum members per group.
- Maximum active devices per principal.
- Maximum attachment size.
- Daily attachment bytes.
- Offline-message retention.
- Attachment retention class.
- Message rate limits.
- Key-package limits.
- Agent request and agent message quotas.
- WebSocket reconnection backoff.
- No aggressive polling.
- Usage dashboards.
- Alert thresholds below hard limits.
- Feature flags to disable uploads, rich previews, invitations, agents, or extended retention.
- Paid-plan migration runbook.

The request-more button should request a quota increase. Monetization can be layered later without hardcoding payment assumptions into the conversation model.

## 2. Decisions, Deviations, And Practical Constraints

This section records where ideas were accepted, adjusted, or rejected for technical, security, cost, or practical reasons.

- Build a general secure messenger with AI agents as first-class principals. This keeps user-to-user messaging real and avoids creating a narrow AI chat tool.

- Use Tauri 2 and SvelteKit for client delivery, but not as the backend. Tauri is a client shell and local security host; SvelteKit is UI infrastructure. Cloud authority belongs in Cloudflare Workers and Durable Objects.

- Use a Rust client security core for Tauri builds. Sensitive cryptography, local encrypted storage, attachment encryption, and secure-storage integration should not live entirely in browser JavaScript.

- Treat browser/web as lower assurance until validated. Browser code delivery, XSS risk, extensions, storage behavior, and WASM crypto persistence need separate review.

- Update the previous libsignal-first assumption. MLS/OpenMLS should lead Phase 0 because it is a standardized group messaging direction with a Rust implementation and better product integration posture. Libsignal remains a comparison candidate because it is strong but unsupported for external use and needs licensing review.

- Do not implement custom cryptography. Library friction is not a reason to hand-roll Double Ratchet, sender keys, X3DH/PQXDH, MLS, or similar systems.

- Do not reject messages merely because a recipient is offline. Mobile apps are frequently suspended; offline encrypted delivery is required for a credible messenger.

- Use Durable Objects for realtime and stateful coordination. R2 and KV do not provide the ordering, atomic state transitions, and WebSocket coordination needed for chat.

- Do not assume a D1 update and a Durable Object storage update are one distributed transaction. The design needs an explicit mutation protocol with idempotent retries, reconciliation, and a declared source of truth after partial failure.

- Do not use R2 as the active message database. R2 is the right place for encrypted attachment blobs, not room sequencing or delivery acknowledgement.

- Do not store plaintext server-side group history. It breaks the E2EE promise. Store encrypted delivery material only, with retention limits.

- Use hybrid content/media storage. Messages are E2EE envelopes; media is encrypted locally, stored once in R2, and referenced from encrypted messages.

- Do not use peer-hosted sender devices as the normal attachment source. Availability, NAT traversal, battery, background execution, bandwidth, and UX make this unsuitable as the baseline.

- Do not use plaintext content hashes as object keys. They leak equality and support known-file probing. Use random object IDs.

- Keep account password/passkey and app passcode/biometric separate. Password/passkey authenticates to the service; passcode/biometric unlocks local device data.

- Do not let admins recover passcodes or message keys. Admin reset restores account access, not decryptability of old local state.

- Do not derive local database keys directly from account passwords. Use random local keys protected by OS secure storage and optional passcode/biometric.

- Make forgotten local passcode recovery destructive. Re-enrollment is safer and more honest than key escrow.

- Keep email and phone optional for MVP. The schema should support them and policy may require them later.

- Implement groups in MVP, but defer channels. Groups are essential to the agentic workflow. Channels need stronger semantics before becoming a real entity.

- Reserve reply references but defer full threads. This keeps future compatibility without shipping Slack-scale thread complexity.

- Rename organizational groups to Sidebar Collections. They are user-private organization containers, not shared authorization structures.

- Do not inherit Collections from group owners. Each user manages their own sidebar organization.

- Allow ownership transfer with safeguards. Permanent creator-only ownership is impractical, but automatic hidden succession is also unsafe.

- Agents are principals, not fake users. They need distinct identity, visible labels, runtime devices, owner relation, quotas, and revocation.

- Do not treat agent messages as inherently safe. Agent Markdown and attachments must be sanitized and validated like any other input.

- Agent creation stays out of the chat MVP. Include request, review, and placeholder provisioning flows; full agent provisioning and tool policy remain separate work.

- Do not claim literal Cloudflare-only infrastructure. Push providers, app stores, CI/CD, signing, domains, and external agent runtimes are documented dependencies.

- Do not guarantee permanent zero cost. Aim for free pilot operation through quotas, alerts, and retention limits.

- Do not promise guaranteed remote deletion. The service can delete server metadata and encrypted blobs, but cannot prove recipients erased already-decrypted local copies.

- Do not ship sensitive production use until the active-backend/key-substitution position is explicit. The MVP can be honest about passive-server protection while requiring stronger verification for high-risk accounts.

- Do not let CI authority equal release authority. Client updates can bypass E2EE if compromised, so release signing, protected keys, downgrade protection, and minimum secure client versions are security requirements.

- Do not ignore data residency. Cloudflare jurisdiction and location controls, subprocessors, privacy notices, and cross-border transfer obligations must be reviewed before real customer deployment.

## 3. Additions, Updates, And Decisions

- Add a formal threat model before implementation.
- Add Architecture Decision Records for protocol, auth, recovery, storage, push, and retention.
- Use MLS/OpenMLS as the leading protocol candidate in Phase 0.
- Keep libsignal as a comparison track, not the default implementation.
- Add an application-owned protocol abstraction so UI and transport do not depend on concrete protocol types.
- Add device-level cryptographic identity for every human device and agent runtime.
- Add device enrollment, visibility, rotation, revocation, and inactivity policy.
- Add key-package lifecycle and atomic claim requirements.
- Add visible security events for device, key, and membership changes.
- Add verification fingerprints or QR verification as a future high-assurance feature.
- Add lower-assurance classification for browser clients.
- Add random local database keys protected by platform secure storage.
- Add destructive local passcode recovery semantics.
- Add passkeys for users where available.
- Require phishing-resistant MFA/passkey for administrators.
- Add break-glass administrative account and process.
- Add granular administrative roles.
- Add immutable or tamper-evident administrative audit records.
- Add offline encrypted delivery with 14-day initial pending-message retention target.
- Add eligible-device policy so abandoned devices do not block purge forever.
- Add idempotency keys and replay protection.
- Add synchronization cursors and gap recovery.
- Add versioned message envelopes and protocol/application payload versions.
- Add `reply_to_message_id` without full threads.
- Add controlled ownership transfer and succession workflow.
- Add Sidebar Collections as user-private organization state.
- Add optional encrypted sync for Collections later.
- Add client-encrypted R2 attachments with random object IDs.
- Add encrypted thumbnails.
- Add attachment retention classes: 7-day ephemeral, 30-day default.
- Add attachment allocation, completion, authorized download, and cleanup state.
- Add push as wake-up/awareness only, not source of truth.
- Add generic push payloads by default.
- Add agent runtime durable-receipt requirements.
- Add agent idempotency and duplicate-side-effect controls.
- Add distinct agent request lifecycle.
- Add agent pause, revoke, rotate, and re-enroll operations.
- Add privacy-preserving logging requirements.
- Add abuse controls for invitations, login, uploads, groups, devices, agents, and admin APIs.
- Add D1 and Durable Object backup/recovery planning.
- Add D1-Durable Object mutation consistency and reconciliation ADR.
- Add schema and cryptographic-state migration planning.
- Add supply-chain controls, SBOMs, artifact signing, and dependency/license review.
- Add client update signing, release-key protection, downgrade protection, and minimum secure client version requirements.
- Add active-backend/key-substitution threat model decision.
- Add attachment access-after-removal policy.
- Add data residency, privacy jurisdiction, and subprocessor review.
- Add free-tier usage alarms and emergency feature flags.
- Add operational runbooks and incident-response procedures.
- Add acceptance criteria for security, delivery, recovery, and cost.
- Add external security review before sensitive production use.
- Add requirement identifiers in later implementation specifications so code, tests, and acceptance criteria can trace back to the plan.

## 4. Backend Requirements

### 4.1 Backend Architecture Requirements

- The application backend must be hosted on Cloudflare services.
- The backend must be API-first for web, desktop, mobile, admin, and agent clients.
- The backend must never require plaintext message bodies or plaintext media.
- The backend must route opaque encrypted envelopes.
- The backend must expose stable versioned APIs.
- The backend must support local, development, staging, and production environments.
- The backend must have environment-isolated secrets, databases, R2 buckets, Durable Object namespaces, and domains.
- The backend must be deployable through GitHub Actions and Wrangler or equivalent Cloudflare deployment automation.
- D1 migrations must be versioned and controlled.
- Typed request/response contracts must be shared with clients.
- Authentication, authorization, messaging, conversations, attachments, admin, agents, and observability must remain modular.
- One component should own each mutation path to avoid split-brain state.

Suggested monorepo shape:

```text
apps/
  client/                 # shared SvelteKit UI
  client/src-tauri/       # Tauri shell and native commands
  web/                    # browser build and restrictions
  admin/                  # privileged management UI
  agent-daemon/           # agent runtime transport/protocol helper

services/
  api-worker/
  conversation-do/
  mailbox-do/
  key-package-do/
  jobs-worker/
  notification-worker/

packages/
  domain/
  api-contracts/
  message-schema/
  protocol-interface/
  openmls-adapter/
  local-storage/
  secure-storage/
  sync-engine/
  attachment-crypto/
  authorization/
  observability/
  ui-components/
  test-fixtures/

infra/
  wrangler/
  migrations/
  environments/
  scripts/

docs/
  architecture/
  threat-model/
  adr/
  runbooks/
  protocol/
  privacy/
```

Boundary rules:

- UI does not import concrete cryptographic implementation.
- Workers do not import client-private-key code.
- Protocol adapter does not know Svelte components.
- Domain package does not depend on Cloudflare runtime types.
- API contracts come from one schema source.
- Admin code is not bundled into the consumer client.
- Agent business logic is separate from the messaging transport daemon.
- Test fixtures never contain production secrets.

### 4.2 Quality Attributes And Service Objectives

Confidentiality:

- No plaintext message or attachment content reaches the backend.
- No private device key reaches the backend.
- Logs, traces, metrics, and audits exclude plaintext content.
- Environment secrets are separated.
- Admin privilege does not imply decryption privilege.

Integrity:

- Authenticate every state-changing request.
- Validate device and principal authorization.
- Use idempotency keys for retries.
- Detect replayed submissions.
- Authenticate attachment ciphertext.
- Version envelopes and APIs.
- Serialize membership and ownership changes.
- Protect audit records against silent modification.

Availability:

- Support store-and-forward delivery.
- Use hibernating WebSockets and bounded reconnect backoff.
- Provide HTTPS synchronization when realtime is unavailable.
- Avoid designs where an offline sender blocks attachment access.
- Define degraded modes for push, R2, D1, or Durable Object outages.

Scalability:

- Partition by conversation, device mailbox, principal, and account.
- Avoid globally hot keys.
- Limit group fanout in pilot.
- Benchmark cross-Durable-Object calls.
- Scale messages and attachments separately.
- Enforce quotas before growth.

Maintainability:

- Clear service/package boundaries.
- Typed versioned contracts.
- Architecture Decision Records.
- Automated migrations and rollback plans.
- Protocol adapter independent of UI and transport.
- Comprehensive tests and deterministic fixtures.

Privacy:

- Collect only required identifiers and operational metadata.
- Define retention for every data class.
- Separate operational metrics from account identity where practical.
- Never log message bodies, attachment names, keys, tokens, or rendered Markdown.
- Support account deletion while explaining recipient copies cannot be remotely erased.

Initial service objectives should be set before production:

- API availability target.
- P95/P99 message-acceptance latency.
- P95 online delivery-event latency.
- Offline-sync success rate.
- Duplicate-delivery rate.
- Push-dispatch success rate.
- Attachment upload completion rate.
- Maximum acceptable queue age.
- Recovery time objective for control-plane metadata.
- Recovery point objective for account and membership data.

### 4.3 Cloudflare Component Model

Edge API Worker:

- Request routing.
- API version negotiation.
- Authentication and session validation.
- Authorization prechecks.
- Rate limiting.
- Input schema validation.
- Invitation/account/device endpoints.
- Conversation endpoints.
- Attachment authorization.
- Agent request endpoints.
- Admin endpoints.
- Service bindings.
- Response normalization.
- Security headers.
- Correlation IDs.

Conversation Durable Object:

- One logical coordinator per conversation.
- Serializes conversation mutations.
- Maintains current metadata version.
- Validates membership snapshot.
- Sequences opaque messages.
- Enforces idempotency.
- Retains encrypted message envelopes temporarily.
- Retains protocol commit/application ordering.
- Exposes cursor-based synchronization.
- Records acknowledgement state or aggregate references.
- Emits events to device mailboxes.
- Purges expired or acknowledged content.
- Coordinates ownership and role mutations with D1.
- Enforces per-conversation rate and size limits.

Device Mailbox / Session Durable Object:

- One logical mailbox per active device, unless load tests prove a better partition.
- Maintains hibernating WebSocket.
- Holds short pending-event references.
- Coalesces push requests.
- Tracks last-seen sync cursor.
- Tracks current connection generation.
- Rejects stale socket actions.
- Uses pointers to conversation ciphertext rather than duplicating full group messages whenever possible.

Key-Package Coordinator:

- Publishes validated public key packages.
- Enforces maximum inventory.
- Atomically marks packages claimed.
- Prevents reuse.
- Expires old packages.
- Requests replenishment.
- Audits device credential changes.
- Must not use eventually consistent KV as sole authority.

D1 Control-Plane Database:

- Accounts.
- Principals.
- Devices.
- Invitations.
- Authenticators and passkeys.
- Sessions.
- Policies and quotas.
- Conversations.
- Membership and roles.
- Ownership transfers.
- Attachment metadata.
- Push endpoints.
- Agent requests.
- Agent provisioning metadata.
- Audit events.
- Deletion jobs.
- Service configuration.

R2 Object Storage:

- Encrypted attachment ciphertext.
- Encrypted thumbnails.
- Optional encrypted export packages.
- No active conversation state.
- No unencrypted attachments.
- No server-readable message history.
- No authorization only in object metadata.
- No private keys.

Background Jobs Worker and Queues:

- APNs and FCM dispatch.
- Retryable notification work.
- Attachment cleanup.
- Expired invitation cleanup.
- Audit export.
- Aggregate metrics.
- Deletion workflows.
- Webhook delivery to approved agent infrastructure.
- Quota reconciliation.

Jobs must be idempotent. Durable source state must exist outside the Queue when a job cannot be safely lost after queue retention.

Administration Worker / Service:

- Separate hostname or application if practical.
- Separate authorization policy.
- Stricter rate limits.
- Mandatory high-assurance authentication.
- Shorter sessions.
- Enhanced audit and alerting.
- No message-content routes.

### 4.4 Data Ownership And Sources Of Truth

| Data | Authoritative owner | Notes |
| --- | --- | --- |
| Account, status, policies | D1 | Updated through authorized APIs. |
| Invitations | D1 | Store token hashes only. |
| Passkeys/authenticators | D1 | Public credential data or password verifier only. |
| Refresh sessions | D1 or session store | Store token hashes and rotate. |
| Device registration/revocation | D1 | Versioned; changes create security events. |
| Key-package claim state | Durable coordinator plus durable storage | Atomic claim required. |
| Conversation metadata | D1 | Mutations serialized by Conversation DO. |
| Membership and roles | D1 | Runtime snapshot cached by Conversation DO. |
| Ownership transfer | D1 | Explicit state machine. |
| Message ciphertext | Conversation DO storage | Time-bounded. |
| Delivery pointer/cursor | Device Mailbox DO | Reconstructible where possible. |
| Readable history | Client local encrypted DB | Not admin-recoverable. |
| Attachment ciphertext | R2 | Random opaque object key. |
| Attachment lifecycle metadata | D1 | Reconciled with R2 lifecycle/cleanup. |
| Sidebar Collections | Client local DB | Optional encrypted sync later. |
| Push token | D1 | Encrypt token where feasible. |
| Administrative audit | D1 plus optional archive | No plaintext message data. |
| Agent runtime crypto state | Agent environment | Encrypted at rest under separate design. |

Only one path should write a given class of mutation. For example, membership changes should enter through the Conversation Durable Object, which validates and commits the D1 update.

### 4.5 Mutation Consistency Requirements

D1 and Durable Object storage must not be treated as one distributed transaction. Durable Object storage can provide transactional behavior inside a single object instance, but a mutation that also updates D1, mailbox objects, queues, or R2 metadata can still fail partway through.

Every cross-component mutation must have a formal protocol before implementation:

- Assign a unique `mutation_id`.
- Include expected and resulting state versions.
- Use explicit states such as `prepared`, `committed`, `finalized`, `reconciled`, and `failed`.
- Make retries idempotent by `mutation_id`.
- Persist enough intent before side effects so recovery can resume safely.
- Use a durable outbox or reconciliation record for mailbox events, push jobs, cleanup jobs, and D1 read-model updates.
- Declare the source of truth during disagreement.
- Reject stale mutations against old metadata versions.
- Reconcile Conversation DO state, D1 records, mailbox pointers, and audit records periodically.
- Test failure after every meaningful step in the mutation sequence.

Membership, ownership transfer, device revocation, attachment completion, and account deletion must each have a sequence diagram and recovery behavior before production implementation.

### 4.6 Proposed Relational Entities

Core entities:

| Entity | Purpose |
| --- | --- |
| `accounts` | Authentication, policy, display, status, deletion state. |
| `invitations` | Single-use activation and onboarding records. |
| `principals` | Human and agent messaging identities. |
| `devices` | Human device and agent runtime registrations. |
| `authenticators` | Passkey credentials and password verifiers. |
| `sessions` | Refresh/session records with revocation and risk state. |
| `policies` | Account, device, verification, retention, quota, and agent permissions. |
| `conversations` | Direct/group/future-channel metadata. |
| `conversation_members` | Principal membership, role, permissions, status. |
| `conversation_devices` | Device-level cryptographic membership and delivery eligibility. |
| `ownership_transfers` | Explicit transfer lifecycle records. |
| `attachments` | R2 object metadata, ciphertext size/hash, retention, upload state. |
| `push_endpoints` | Device push provider tokens and lifecycle. |
| `agent_requests` | User-submitted request workflow. |
| `audit_events` | Security/admin metadata logs without content. |
| `quota_usage` | Usage counters and policy decisions. |

Data model constraints:

- Public IDs are opaque and non-sequential.
- Internal database IDs should not leak where random public IDs are safer.
- Membership changes create audit events.
- Room/conversation mutations are idempotent.
- Device revocation blocks new delivery and protocol activity.
- Last-owner constraints prevent ownerless groups.
- Agent ownership is explicit.
- Sidebar Collections do not affect permissions.
- Attachment metadata does not require plaintext filename or plaintext hash.
- Audit payloads must not include content, keys, passwords, tokens, or passcodes.

### 4.7 State Machines

Account:

- `invited`
- `active`
- `locked`
- `suspended`
- `pending_deletion`
- `deleted`

Device:

- `pending_enrollment`
- `active`
- `stale`
- `revocation_pending`
- `revoked`

Invitation:

- `created`
- `accepted`
- `expired`
- `revoked`

Conversation membership:

- `invited`
- `active`
- `leaving`
- `removed`
- `banned`

Ownership transfer:

- `proposed`
- `accepted`
- `rejected`
- `expired`
- `cancelled`
- `completed`

Message storage state:

- `accepted`
- `available`
- `partially_acknowledged`
- `fully_acknowledged`
- `expired`
- `purged`

Attachment:

- `allocated`
- `uploading`
- `uploaded`
- `referenced`
- `expired`
- `deleted`
- `quarantined_metadata`

Agent request:

- `submitted`
- `under_review`
- `approved`
- `rejected`
- `provisioning`
- `active`
- `closed`

State transitions require explicit authorization, audit where appropriate, and safe convergence with cryptographic state.

### 4.8 API And Contract Requirements

API principles:

- Versioned base path, such as `/v1`.
- Strict JSON and/or binary schemas.
- Generated client types from a single contract source.
- Request and response size limits.
- Idempotency headers for mutating operations.
- Stable error codes separate from display text.
- Correlation ID on every response.
- Auth scopes and required roles documented per route.
- No secrets in URL query strings.
- Pagination for list endpoints.
- Cursor-based message synchronization.
- Conditional requests or metadata versions for conflicts.
- Backward-compatible additive evolution within a version.
- Deprecation and minimum-client policy.

Conceptual endpoint groups:

- Activation and authentication: accept invitation, register/login passkey, password login/change, refresh, logout, recovery, session listing, session revoke.
- Devices and cryptographic material: register device, list devices, revoke device, publish key packages, claim key packages, rotate credential.
- Principals: get/update principal, controlled directory search, list principal devices.
- Conversations: create direct, create group, list conversations, get/update conversation, invite/remove members, accept membership, update role, transfer ownership, leave, archive.
- Messages and synchronization: send opaque message, sync conversation after cursor, acknowledge, submit receipts, ephemeral typing, account/device sync, realtime WebSocket upgrade.
- Attachments: allocate, complete upload, authorize download, delete.
- Personal settings: get/patch settings, future encrypted Collections blob.
- Agent requests and runtime: submit request, get request, enroll runtime device, pause/resume/revoke agent.
- Administration: create invitations, suspend/restore accounts, require auth reset, revoke devices, patch policies/quotas, review/approve agent requests, create agents, view audit, view usage, start deletion jobs.

Endpoint names are planning placeholders. Final contracts should follow protocol sequence diagrams.

### 4.9 Authentication Requirements

- Single-use invitation activation.
- Passkey/WebAuthn registration and authentication.
- Password fallback with a modern verifier appropriate for Workers runtime constraints.
- Password blocklist and breached-password checks without inappropriate plaintext disclosure.
- Long password support.
- No arbitrary periodic password rotation.
- Login rate limiting by account, IP, device, and risk signal.
- Generic login and recovery errors where useful to reduce account enumeration.
- Short-lived access tokens.
- Rotating refresh tokens stored as hashes.
- Session revocation.
- Device binding.
- CSRF protection when cookies are used.
- Secure, HttpOnly, SameSite cookies for browser sessions where appropriate.
- Token audience, issuer, expiry, and signing-key rotation.
- Separate administrative authentication policy.
- Recovery notifications.
- Complete recovery audit.

Reauthentication required for:

- Password/passkey changes.
- New device enrollment.
- Ownership transfer.
- Admin role changes.
- Agent provisioning.
- Export or deletion actions.
- High-risk policy changes.

### 4.10 Authorization Requirements

Authorization must be centralized as a policy layer.

It evaluates:

- Account status.
- Principal status.
- Device status.
- Session assurance.
- System/admin role.
- Group role.
- Granular permission.
- Conversation membership version.
- Quota state.
- Agent ownership.
- Object ownership.
- Rate-limit state.
- Requested action sensitivity.

Required protections:

- Default deny.
- Object-level authorization on every route.
- No trust in client-supplied role claims without token and database validation.
- Permission tests for every endpoint.
- Server-enforced group membership.
- Cryptographic membership synchronization.
- No insecure direct object references.
- No admin bypass unless explicitly documented and audited.
- Emergency access never grants decryption.

### 4.11 Cryptographic Backend Requirements

Authentication service responsibilities:

- Bind service account, principal, and device identity.
- Issue or validate device credentials.
- Expose current device status.
- Prevent revoked devices from authenticating.
- Generate visible device-change events.
- Support fingerprint verification.
- Sign or authenticate identity assertions according to selected protocol credential model.

Delivery service responsibilities:

- Deliver protocol proposals, commits, welcome messages, and application messages in order.
- Retain required protocol messages through offline window.
- Prevent one-time key-package reuse.
- Protect against replay and duplicate submission.
- Provide gap recovery.
- Preserve opaque byte strings without transformation.
- Enforce size and version limits.
- Avoid inferring plaintext content type.

Protocol abstraction must cover:

- Create device identity.
- Export/import encrypted protocol state.
- Publish key packages.
- Claim peer key package.
- Create direct conversation.
- Create group.
- Add member/device.
- Remove member/device.
- Update local state.
- Encrypt application message.
- Decrypt message.
- Process proposal/commit.
- Generate welcome state.
- Calculate verification fingerprint.
- Rotate/update credential.
- Validate serialized state version.

Key and state storage:

- Private state remains client-side.
- Device state is encrypted at rest.
- Agent runtime state is durably encrypted.
- Public credentials and key packages are validated before storage.
- Key packages have expiry and usage state.
- Secrets are never logged.
- Crash reports exclude memory dumps containing secrets.
- State migrations are versioned and tested.
- Agent state backup requires separate encrypted recovery design.

### 4.12 Message Envelope Requirements

Outer envelope may contain server-readable routing fields:

```json
{
  "version": 1,
  "message_id": "random-id",
  "conversation_id": "opaque-id",
  "sender_device_id": "opaque-id",
  "idempotency_key": "random-id",
  "protocol_type": "mls_application_or_handshake",
  "ciphertext": "binary-or-base64",
  "ciphertext_bytes": 1234,
  "client_created_at": "optional-untrusted-time"
}
```

Encrypted application payload may contain:

```json
{
  "schema_version": 1,
  "content_type": "text/plain",
  "body": "message content",
  "reply_to_message_id": null,
  "attachments": [],
  "client_metadata": {
    "sender_principal_id": "bound-and-verified",
    "created_at": "client-time"
  }
}
```

Requirements:

- Random globally unique message ID.
- Separate idempotency key.
- Maximum envelope and plaintext sizes.
- Protocol type allowlist.
- No server parsing of encrypted application payload.
- Reject duplicate `(sender_device_id, idempotency_key)`.
- Assign server sequence separately from client timestamp.
- Preserve client timestamp as untrusted presentation metadata.
- Verify sender device authorization before accepting.
- Apply replay window.
- Define out-of-order and gap behavior.
- Include cryptographic epoch inside protocol state rather than trusting server field.
- Support binary transport where practical.

Do not include reply/thread hints in the outer server-readable envelope unless a future operational need is explicitly approved. Reply structure should stay inside the encrypted payload by default.

### 4.13 Delivery, Synchronization, And Acknowledgement

Realtime:

- One hibernating WebSocket per active device is preferred.
- Socket authentication is short-lived and renewable.
- Each connection has generation ID.
- Old replaced sockets cannot submit stale actions.
- Events carry minimal pointers and sequencing metadata.
- Clients fetch missing ciphertext through sync endpoints.
- Reconnect uses exponential backoff with jitter.

Synchronization:

- Device maintains per-conversation cursor.
- Account/device sync returns changed conversations, membership events, and mailbox pointers.
- Conversation sync returns ordered opaque envelopes after cursor.
- Cursor expiry is explicit.
- Client can request bounded snapshot after gap.
- Protocol handshake messages required for state must not be omitted.
- Sync is idempotent.

Acknowledgement states must distinguish:

- Accepted by server.
- Durably stored by recipient device.
- Decrypted by recipient device.
- Displayed/read by user.

Read receipts:

- Optional.
- Privacy configurable.
- Prefer E2EE channel where practical.

Purge:

- Purge after all eligible devices durably acknowledge or expiry.
- Use scheduled and opportunistic cleanup.
- Record aggregate metrics without retaining recipient detail longer than needed.
- Verify cleanup through tests and reconciliation jobs.

### 4.14 Presence, Typing, And Ephemeral Signals

Presence and typing are not required for secure message correctness.

If included:

- Default to minimal presence.
- Do not persist long-term.
- Use short expirations.
- Allow users to disable visibility.
- Do not expose precise last-seen times by default.
- Rate limit typing events.
- Never queue typing indicators for offline delivery.
- Treat presence as approximate.
- Never use presence as authorization.

These can be deferred if cost or privacy goals make them unjustified.

### 4.15 Attachment Backend Requirements

Allocation:

- Authenticate uploader.
- Verify conversation membership.
- Check account and conversation quota.
- Generate random attachment ID and object key.
- Select retention prefix/class.
- Return short-lived method-bound upload authorization.
- Record maximum expected ciphertext size and content category.
- Do not require plaintext filename as server metadata.

Upload:

- Direct client-to-R2 upload.
- Private bucket.
- Strict CORS for web client.
- Maximum body size.
- Abort or expire incomplete uploads.
- Validate completion metadata against allocation.
- Store ciphertext hash and byte length.

Download:

- Authenticate requester.
- Verify current conversation access under the MVP default policy.
- Return short-lived download authorization.
- Avoid public bucket URLs.
- Log only attachment ID, result, and coarse operational metadata.
- Rate limit repeated downloads.
- Deny new download authorization immediately after membership removal unless a later explicit historical-access room policy is approved.

Lifecycle:

- Expire by prefix lifecycle rule and application reconciliation.
- Clean unreferenced allocations.
- Allow immediate delete where policy permits.
- Understand deletion does not revoke already downloaded copies.
- Maintain deletion-job status.

Security:

- Per-file random key.
- Unique nonce or chunk nonce.
- Authenticated encryption.
- Chunked encryption for large objects.
- No server-side plaintext previews.
- Safe client rendering.
- Content-type sniffing after decryption.
- File-size verification before memory allocation.
- Optional local malware scanning where available.

### 4.16 Push Notification Requirements

General rule:

- Push is a wake-up and awareness channel, not the source of truth.

Backend requirements:

- Store platform token per device.
- Encrypt tokens at rest if feasible.
- Rotate and invalidate tokens.
- Coalesce notifications.
- Avoid plaintext message content in standard push payloads.
- Avoid sender/group names unless covered by reviewed encrypted-preview design.
- Process provider errors and remove invalid tokens.
- Do not mark a message delivered because push provider accepted it.
- Retain message state independently of push.
- Rate limit push storms.

iOS:

- Silent/background notifications are not guaranteed.
- Baseline should be generic alert plus sync when app runs.
- Encrypted rich notifications require separate Notification Service Extension review.

Android:

- Use data/high-priority messaging conservatively.
- Do not assume unlimited background networking.
- Fetch/decrypt in supported background window or defer to app open.

Privacy:

- APNs and FCM can observe device tokens, timing, application identity, and payload size.
- Encrypt or omit sensitive data.

### 4.17 Agent Backend Requirements

Provisioning:

- Admin creates agent principal.
- Owner relation is explicit.
- Runtime device enrollment is separate from human devices.
- Service credentials and cryptographic credentials are distinct.
- Multiple runtime replicas require safe protocol-state and side-effect coordination.
- Agent status supports active, paused, suspended, and revoked.

Delivery:

- Same E2EE delivery protocol as human devices.
- Runtime persists ciphertext before acknowledgement.
- Runtime tracks message IDs and idempotency keys.
- Retry cannot execute same business action twice.
- Failed processing does not corrupt protocol state.
- Poison messages are isolated.
- Backpressure and max concurrency are configurable.
- Polling fallback must be bounded and quota-aware.

Security:

- Agent secrets live in the agent environment, not the messaging backend.
- Service token is least-privileged.
- Owner cannot extract runtime private keys through UI.
- Tool access is separate from chat membership.
- Logs redact decrypted content unless a separate explicit data-retention decision exists.
- Revocation blocks new cloud delivery and triggers group epoch updates.
- Agent replacement appears as a device-change event.

Placeholder request flow collects:

- Requester.
- Desired agent name.
- Intended use.
- Required conversations.
- Expected message volume.
- Contact for follow-up.
- Optional structured requirements.

It must not imply immediate automatic provisioning.

### 4.18 Management And Administrative Backend Requirements

Suggested admin roles:

- Platform owner.
- Security administrator.
- User administrator.
- Support operator.
- Agent provisioner.
- Billing/quota operator.
- Auditor/read-only.

No role should automatically combine all powers.

High-risk operations require reauthentication and reason:

- Authentication reset.
- Device revocation.
- Admin-role assignment.
- Ownership succession.
- Agent provisioning.
- Mass suspension.
- Retention-policy change.
- Export.
- Deletion.
- Break-glass use.

Audit records include:

- Actor.
- Target.
- Action.
- Timestamp.
- Result.
- Reason.
- Request/correlation ID.
- Prior and new policy version where appropriate.

Audit records never include:

- Passwords.
- Passcodes.
- Refresh tokens.
- Private keys.
- Message plaintext.
- Attachment decryption material.

Support personnel may inspect:

- Account status.
- Device status.
- Delivery error category.
- Quota state.
- Client version.
- Opaque message ID.
- Server sequence.
- Encrypted-byte size.

Support personnel may not inspect message content.

### 4.19 Quota And Policy Engine

Quotas should be data-driven and independently configurable.

Candidate quotas:

- Active accounts.
- Active devices per account.
- Active agent runtimes.
- Groups owned.
- Total group memberships.
- Members per group.
- Messages per minute/day.
- Ciphertext bytes per day.
- Pending offline envelopes.
- Maximum retention.
- Key packages per device.
- Attachment size.
- Attachment bytes/day.
- Retained attachment bytes.
- Agent requests.
- Failed login attempts.
- Invitation creation rate.
- Administrative API rate.

Policy behavior:

- Warn before rejecting where possible.
- Reject before accepting uploads that cannot be retained.
- Expose request-more workflow.
- Preserve core messaging during attachment-quota exhaustion.
- Allow emergency reduction of retention or uploads through feature flag.
- Store policy version applied to decision.
- Audit manual overrides.

### 4.20 Abuse And Rate-Limiting Requirements

Protect:

- Login.
- Activation.
- Recovery.
- Passkey registration.
- Device enrollment.
- Key-package publishing and claiming.
- Message submission.
- Group creation.
- Invitations.
- Membership changes.
- Attachment allocation and download.
- Agent requests.
- Admin operations.

Use layered controls:

- Account.
- Device.
- Principal.
- Conversation.
- IP/network signal.
- Global emergency limit.

Avoid permanent lockout based only on attacker-controlled failures. Privileged abuse signals should alert administrators.

### 4.21 Logging, Metrics, And Tracing

Logging rules:

- Structured JSON.
- No message content.
- No attachment key or original filename.
- No auth token.
- No password/passcode.
- No private key.
- Redact push tokens.
- Hash or pseudonymize identifiers in broad operational logs where practical.
- Separate security audit from debug logs.
- Short debug-log retention.
- Environment-specific verbosity.
- Sampling for high-volume events.

Metrics:

- Requests and errors by route class.
- Authentication failures.
- Active/revoked devices.
- Message accept latency.
- Realtime notification latency.
- Sync lag.
- Pending ciphertext count and age.
- Acknowledgement rate.
- Expired messages.
- WebSocket connections and reconnects.
- Durable Object requests and duration.
- D1 rows read/written.
- R2 objects, bytes, and operations.
- Queue operations and age.
- Attachment upload/download failures.
- Push success/failure.
- Agent processing backlog.
- Quota denials.
- Audit anomalies.

Tracing:

- Use correlation IDs that do not encode user or conversation identity.
- Trace opaque operations without recording ciphertext.
- Diagnostic modes must be tightly controlled.

### 4.22 Data Retention And Deletion

Suggested initial retention:

| Data | Suggested retention |
| --- | --- |
| Pending message ciphertext | Until eligible-device acknowledgement or 14-day pilot policy default. |
| Message delivery pointers | Until acknowledgement plus short operational window. |
| Typing/presence | Seconds or minutes. |
| Default attachment | 30-day pilot policy default. |
| Ephemeral attachment | 7-day pilot policy default. |
| Incomplete upload | Hours. |
| Invitations | Expiry plus limited audit period. |
| Authentication events | Security-defined period. |
| Admin audit | Longer controlled period. |
| Debug logs | Short period. |
| Aggregate metrics | Longer, de-identified where possible. |
| Deleted account control record | Minimal tombstone where needed. |

Account deletion workflow:

1. Suspend new access.
2. Revoke sessions.
3. Revoke devices.
4. Remove future group membership.
5. Trigger cryptographic membership updates.
6. Delete or anonymize profile data.
7. Delete unneeded attachment allocations.
8. Retain only legally or operationally required audit/tombstone fields.
9. Explain that recipient-held copies are not remotely erasable.

Group deletion:

- Service metadata and future access can be removed.
- Already decrypted local copies cannot be proven erased.

Retention values are hypotheses and policy defaults. They must be configurable and validated during pilot planning rather than hard-coded.

### 4.23 Backup And Disaster Recovery

Control-plane backup:

- Use D1 recovery features and tested exports.
- Verify restore procedures.
- Protect backup access separately.
- Maintain schema migration history.
- Avoid plaintext content because none should exist.

Durable Object recovery:

- Document data classes in each object.
- Test object-storage failure and reconstruction paths.
- Keep mailbox pointers reconstructible where possible.
- Protect time-bounded ciphertext under retention policy.
- Define behavior if pending ciphertext is irrecoverably lost.

R2:

- Lifecycle and deletion are intentional.
- Do not back up expired attachments indefinitely.
- If replication is added, preserve encryption and deletion semantics.
- Test orphan cleanup.

Client and agent state:

- Human local history has no server recovery in MVP.
- Agent protocol state requires encrypted operational backup or HA design.
- Future user backup must be separately encrypted and reviewed.

Runbooks:

- Account compromise.
- Admin compromise.
- Device theft.
- Agent credential compromise.
- Protocol-library vulnerability.
- Cloudflare outage.
- Push-provider outage.
- R2 object corruption.
- D1 migration failure.
- Runaway cost.
- Mass revocation.
- Signing-key rotation.

### 4.24 Deployment And Environment Requirements

Environments:

- Local.
- Development.
- Staging.
- Production.

Each environment has separate:

- Cloudflare resources or strong isolation.
- Secrets.
- D1 databases.
- Durable Object namespaces.
- R2 buckets.
- Push credentials.
- Domains.
- Signing keys.
- Audit streams.

Production data must not be copied into development.

Configuration:

- Wrangler-managed nonsecret configuration.
- Cloudflare secret storage for runtime secrets.
- No committed secrets.
- Configuration schema validation at startup/deploy.
- Pinned compatibility dates.
- Feature flags for risky functionality.
- Emergency kill switches for uploads, invitations, agents, rich previews, and extended retention.

Client update and release security:

- Desktop updater artifacts must be signed and verified before installation.
- Mobile releases must use protected store-signing and release controls.
- Release signing keys must be protected separately from normal CI secrets.
- CI build authority and production release authority must be separated.
- Downgrade and rollback protection must prevent clients from returning to known-insecure protocol or storage versions.
- Emergency release revocation must be defined for compromised builds.
- Reproducible or independently verifiable builds should be used where practical.
- Backend APIs must support minimum secure client version enforcement.
- Protocol compatibility must be tested during staggered upgrades.
- Client update compromise is treated as a critical E2EE bypass risk.

Deployment flow:

1. Format and lint.
2. Unit tests.
3. Rust tests.
4. Protocol test vectors.
5. Integration tests.
6. Schema compatibility checks.
7. Dependency and license review.
8. Vulnerability scanning.
9. Build reproducible artifacts.
10. Generate SBOM.
11. Deploy preview.
12. Run smoke tests.
13. Gated staging migration.
14. Gated production migration.
15. Deploy.
16. Verify health.
17. Retain rollback path.

Cryptographic state migrations require special rollback planning because older clients may not understand newer serialized state.

### 4.25 Testing Requirements

Unit tests:

- Policy evaluation.
- Permissions.
- State transitions.
- Retention calculation.
- Quota calculation.
- Envelope validation.
- Idempotency.
- Cursor logic.
- Attachment allocation.
- Audit redaction.
- Token validation.

Cryptographic and protocol tests:

- Official test vectors.
- Direct conversation creation.
- Multi-member group creation.
- Concurrent proposals.
- Add/remove device.
- Add/remove member.
- Offline commits.
- Out-of-order delivery.
- Duplicate delivery.
- State export/import.
- Version migration.
- Corrupted state.
- Invalid ciphertext.
- Credential rotation.
- New device without old history.
- Long offline period.
- Agent-runtime restart.

Integration tests:

- Worker to D1.
- Worker to Conversation DO.
- Conversation DO to Mailbox DO.
- Direct R2 upload.
- Upload completion.
- Signed download.
- Queue retry.
- APNs/FCM error handling.
- Admin reset.
- Ownership transfer.
- Account deletion.

Security tests:

- Authorization matrix.
- IDOR attempts.
- Replay.
- Brute-force and rate-limit behavior.
- Invitation enumeration.
- Token theft and rotation.
- Stale device.
- XSS and Markdown payloads.
- Tauri command abuse.
- CSP validation.
- Malicious attachment metadata.
- Oversized payload.
- Dependency scanning.
- Secrets scanning.
- Admin privilege escalation.

Mobile tests:

- iOS suspension and resume.
- Android process death.
- Poor network.
- Push delay.
- Token rotation.
- Biometric changes.
- Local passcode failure.
- Secure-storage loss.
- Background upload interruption.
- App upgrade during pending protocol state.

Reliability and load tests:

- Expected pilot group size.
- Maximum allowed group size.
- Burst sends.
- Reconnect storms.
- Offline queue at retention limit.
- Attachment quota exhaustion.
- D1 pressure.
- Hot conversation Durable Object.
- Push-provider outage.
- Cleanup backlog.
- Free-tier alarm behavior.

Recovery tests:

- Restore D1.
- Migrate schema.
- Roll back deployment.
- Revoke compromised admin.
- Revoke compromised device.
- Rotate service signing key.
- Recover agent runtime.
- Purge expired R2 objects.
- Reconcile orphan metadata.

### 4.26 Security Review Gates

Gate 1: architecture validation:

- Threat model.
- Active-backend/key-substitution position.
- Data-flow diagrams.
- Trust boundaries.
- Protocol choice ADR.
- Authentication ADR.
- Recovery ADR.
- D1-Durable Object mutation protocol ADR.
- Attachment access-after-removal ADR.
- Data residency and subprocessor review.
- Client update/release security ADR.
- Retention ADR.
- Cloudflare partitioning and cost model.
- Mobile push design.

Gate 2: protocol proof of concept:

- Create direct conversation.
- Create group.
- Add/remove member.
- Add/remove device.
- Send while recipient offline.
- Recover state after app restart.
- Process long message sequence.
- Run on iOS, Android, and desktop.
- Measure state and message sizes.
- Upgrade library version.

Gate 3: internal security review:

- Code review.
- Authorization review.
- Storage and logging review.
- Dependency/license review.
- Tauri capability review.
- Client secure-storage review.
- Abuse review.

Gate 4: external review:

- Independent cryptographic integration assessment.
- Application penetration test.
- Mobile security review.
- Infrastructure/admin-console review.
- Privacy and retention review.

### 4.27 Cost And Capacity Requirements

Before pilot, estimate:

- Active users.
- Devices per user.
- Messages per user/day.
- Group fanout.
- Protocol handshake overhead.
- Average ciphertext size.
- WebSocket connection hours.
- Durable Object cross-calls.
- D1 rows per operation.
- Attachment count and size.
- Download repetitions.
- Notification operations.
- Agent throughput.

Cost acceptance criteria:

- Normal pilot usage stays below defined percentages of free limits.
- Alerts fire before 60%, 80%, and 95%.
- Hard quota behavior is user-safe.
- Message content is not lost before documented retention merely to save cost.
- Attachment uploads can be disabled independently.
- Polling cannot accidentally exhaust Worker requests.
- Paid-plan activation runbook is tested.

Cloudflare limits and prices must be revalidated before launch and before production expansion.

### 4.28 Data Residency, Jurisdiction, And Privacy Operations

Phase 0 must identify where each data class may run, persist, and be logged.

Requirements:

- Record intended jurisdictions for D1, Durable Objects, R2 buckets, logs, metrics, audit records, and backups.
- Decide whether pilot and production require EU, FedRAMP, or other jurisdiction-restricted resources.
- Distinguish jurisdiction restrictions from best-effort location hints.
- Document which metadata can still be logged or processed outside a restricted jurisdiction for billing, debugging, observability, or provider operations.
- Define whether clients can require regional restrictions.
- Maintain a subprocessor list for Cloudflare, Apple, Google/Firebase, GitHub, app stores, code-signing providers, and agent runtime providers.
- Prepare privacy notices and data-processing terms before real customer deployment.
- Record cross-border transfer implications.
- Ensure retention and deletion workflows match privacy commitments.
- Treat data residency as non-blocking for a local/internal prototype but blocking for sensitive customer deployment.

## 5. Frontend High-Level Direction

### 5.1 Shared Client Architecture

- SvelteKit static SPA for shared UI.
- Tauri shell for mobile and desktop.
- Rust native security core for cryptography, local encrypted storage, and attachment processing.
- Shared domain and API contracts.
- Platform adapters for secure storage, biometrics, push, file system, notifications, and lifecycle.
- Browser client behind separate capability and assurance policy.

Suggested frontend package shape:

```text
apps/
  client/
  admin/
  web/

packages/
  api-client/
  crypto-client/
  local-store/
  sync-engine/
  chat-features/
  ui/
```

### 5.2 Mobile Experience

Mobile should feel like a genuine messaging app:

- Fast startup.
- Chat-first navigation.
- Native safe-area handling.
- Platform back behavior.
- Bottom navigation where appropriate.
- Conversation list.
- Direct and group timelines.
- Swipe or long-press reply.
- Attachment picker.
- Local notification integration.
- Clear offline and pending states.
- Accessible typography and touch targets.
- Smooth virtualized message list.
- No desktop three-pane layout compressed onto a phone.

Tauri does not guarantee native feel; each target needs device testing.

### 5.3 Desktop Experience

- Multi-pane conversation layout.
- Keyboard navigation.
- Drag-and-drop attachment support.
- Collections sidebar.
- Account/device security area.
- Group/member administration.
- Optional separate management app for privileged administrators.
- Clear separation between ordinary chat and agent-management tools.

### 5.4 Collections UI

- Fixed manual Collection order.
- Collapsible sections.
- Active/unread indicator on collapsed Collection.
- Recent-activity ordering inside a Collection.
- Drag-and-drop conversation placement.
- All Chats fallback.
- Local encrypted persistence.
- No shared or inherited Collection state.

### 5.5 Agent Distinction

- Immutable agent badge.
- Accessible text label, not color alone.
- Agent owner information where policy permits.
- Separate security/device information.
- Clear pause/unavailable status.
- No visual treatment that implies agent output is automatically trusted.

### 5.6 Message Presentation

- Plain text by default.
- Explicit Markdown rendering where enabled.
- Sanitized output.
- Code block copy action.
- Visible external-link destination.
- Blocked remote images.
- Expired attachment state.
- Consistent pending, sent, delivered, read, failed, and expired states.
- System events for membership and device changes.

### 5.7 Authentication And Recovery UX

- Invitation acceptance.
- Passkey setup.
- Password fallback.
- Local lock setup.
- Plain-language distinction between account password and app passcode.
- Warning that local reset can erase local history.
- Device list and revoke action.
- High-friction ownership transfer confirmation.
- Clear administrator-reset consequences.

### 5.8 Admin UX

- Separate privileged entry point.
- Prefer separate build/deployment artifact for admin UI; if packaged in a desktop shell, privileged modules must be permission-gated and excluded from ordinary consumer bundles.
- Quiet, dense, operational dashboard.
- Priority screens: accounts, devices, policies, quotas, groups, agents, agent requests, audit, health, usage.
- No message timeline.
- No content search.
- Mandatory reason entry for sensitive actions.
- Visible break-glass state.
- Usage and free-tier alarms.

## 6. Delivery Plan

### Phase 0: Architecture And Feasibility

Deliver:

- Formal threat model.
- Architecture Decision Records.
- MLS/OpenMLS cross-platform proof of concept.
- Libsignal comparison and license review.
- Data-flow and sequence diagrams.
- D1 schema draft.
- Durable Object partitioning benchmark.
- Attachment prototype.
- Passkey/password prototype.
- Secure local-storage prototype.
- Notification prototype.
- Cost model.
- Test strategy.

Exit criteria:

- No unresolved blocker for mobile build.
- Offline protocol-state recovery works.
- Group performance is acceptable for target pilot.
- Library upgrade path is understood.
- Recovery semantics are approved.
- Cost projection is approved.

### Phase 1: Identity And Control Plane

- Invitations.
- Accounts.
- Passkey/password authentication.
- Sessions.
- Devices.
- Policies.
- Admin roles.
- Audit.
- CI/CD foundation.

Exit criteria:

- Admin creates account shell and single-use invitation.
- User establishes permanent credential without admin knowing it.
- Device enrollment creates visible device record.
- Revoked session cannot refresh.
- Revoked device cannot authenticate.
- Admin actions produce audit records without secrets.
- CI/CD deploys non-production environment reproducibly.

### Phase 2: Direct Secure Messaging

- Direct conversation.
- Device-level crypto.
- Conversation and Mailbox Durable Objects.
- WebSocket and HTTPS sync.
- Offline retention.
- Acknowledgements.
- Local encrypted history.

Exit criteria:

- Two principals with multiple devices exchange messages through offline periods.
- Duplicate submission does not create duplicate messages.
- Revoked device cannot fetch new envelopes.
- Process restart preserves protocol and sync state.
- Failed sync recovers without reinstall.
- Logs contain no plaintext content or keys.
- Direct conversation semantics remain correct with more than one device per principal.

### Phase 3: Groups And Ownership

- Group creation.
- Roles.
- Invitations.
- Member and device changes.
- Ownership transfer.
- Group quotas.
- Sidebar Collections.

Exit criteria:

- Add/remove member works after offline intervals.
- Removed devices cannot decrypt future epochs.
- Concurrent membership proposals converge or fail safely.
- Ownership invariant survives retries and partial failures.
- Ownership transfer requires acceptance, reauthentication, and audit.
- Group quota enforcement is user-safe.
- Hot-room load stays within pilot limits.

### Phase 4: Attachments And Push

- Client-side attachment encryption.
- R2 upload/download.
- Retention cleanup.
- Mobile push.
- Generic notifications.
- Attachment quotas.

Exit criteria:

- Interrupted upload resumes or expires safely.
- Ciphertext tampering fails closed.
- R2 objects expire according to policy.
- Removed member download behavior matches the selected access policy.
- Push acceptance never counts as message delivery.
- Push payloads contain no plaintext message content.
- Attachment quota exhaustion does not break text messaging.

### Phase 5: Agents

- Agent request flow.
- Agent principal provisioning.
- Agent runtime SDK/daemon.
- Persistent state.
- Idempotent processing.
- Pause/revoke.
- Group participation.

Exit criteria:

- Agent runtime persists ciphertext before acknowledgement.
- Agent restart preserves protocol state.
- Duplicate delivery does not duplicate business side effects.
- Paused agent stops processing but preserves state.
- Revoked agent cannot receive future delivery.
- Agent replacement appears as a visible device/security event.
- Agent logs follow the selected decrypted-content retention policy.

### Phase 6: Hardening And Pilot

- External security review.
- Penetration test.
- Operational runbooks.
- Load and cost testing.
- Privacy documentation.
- Incident response.
- Staged invited pilot.

Exit criteria:

- Internal security gates are complete.
- External review findings are resolved or formally accepted.
- Load, mobile lifecycle, and cost tests meet pilot targets.
- Runbooks are rehearsed.
- Privacy and recovery language is approved.
- Minimum secure client version policy is active.
- Pilot is limited to invited users and documented scope.

### Later Phases

- Encrypted multi-device history transfer.
- Optional encrypted cloud backup.
- Browser client expansion.
- Channels.
- Full threads.
- Richer organization administration.
- Advanced agent policy.
- Private group metadata.
- Paid tiers and billing.

## 7. Primary Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| MLS integration is immature on target platform | Blocks release or creates security faults | Mandatory Phase 0 cross-platform POC and review. |
| Library API or state format changes | Upgrade breakage | Protocol abstraction, pinned versions, migration fixtures. |
| Tauri webview compromise abuses native commands | Key/content exposure | Minimal capabilities, CSP, no remote code, Rust validation, security testing. |
| Admin account compromise | Mass account/device control | Mandatory passkeys/MFA, role separation, alerts, break-glass isolation. |
| Incorrect passcode recovery expectation | User data loss or false security | Explicit destructive semantics and onboarding education. |
| Offline device blocks purge forever | Cost and privacy retention | Eligible-device inactivity cutoff. |
| Conversation DO becomes hot | Latency and limit pressure | Group caps, benchmark, partition/fanout redesign path. |
| Cross-DO fanout is expensive | Free tier exceeded | Pointer-based mailboxes, batching, capacity model. |
| Push is delayed or unavailable | Slow awareness | Durable sync, generic alert, app-open reconciliation. |
| Attachment abuse | Cost exhaustion | Allocation quotas, byte limits, rate limits, cleanup. |
| Malicious decrypted attachment | Endpoint compromise | Safe viewers, type validation, sandboxing, warnings. |
| Agent repeats side effects | Business harm | Durable receipt, idempotency, processing ledger. |
| Agent leaks decrypted content | Privacy loss | Runtime isolation, policy, redacted logs, owner accountability. |
| Server substitutes device keys | Undetected interception | Credential binding, visible changes, fingerprints, future transparency. |
| Free-tier limits change | Outage or charges | Alerts, quotas, paid migration runbook. |
| Web client weakens assurance | Key theft | Separate classification, delayed release, strict CSP and crypto POC. |
| Schema/protocol migration corrupts state | Message loss | Versioned migrations, fixtures, rollback rehearsals. |
| Logs leak metadata or content | Privacy incident | Redaction policy, tests, short retention. |
| Recipient expects remote deletion | Misleading privacy | Explicit local-copy limitation. |
| Multi-device behavior is unclear | Missing or duplicate messages | Formal eligible-device and history policy. |
| Open-source license conflict | Product/legal risk | Early legal and license review. |
| D1 and Durable Object state diverge | Broken membership, delivery, or audit state | Mutation protocol, durable outbox, idempotent retries, reconciliation. |
| Compromised client update | E2EE bypass | Signed updates, protected release keys, minimum secure client version. |
| Data residency mismatch | Customer/privacy blocker | Jurisdiction review, regional resources, subprocessor documentation. |

## 8. Required Architecture Decisions Before Implementation

Approve these ADRs before production coding:

1. MLS/OpenMLS versus alternate reviewed protocol.
2. Device credential and MLS Authentication Service model.
3. Protocol abstraction boundary.
4. Local database encryption implementation.
5. Secure-storage and app-passcode model per platform.
6. Conversation and Mailbox Durable Object partitioning.
7. Key-package coordinator design.
8. Message acknowledgement and eligible-device policy.
9. D1-Durable Object mutation consistency, outbox, and reconciliation.
10. D1 schema and single-writer rules.
11. Active-backend/key-substitution threat-model position.
12. Attachment encryption profile and chunking.
13. Attachment retention classes.
14. Attachment access after membership removal.
15. Passkey and password verifier implementation.
16. Administrator role model and break-glass process.
17. Admin-console packaging boundary.
18. Push-notification privacy profile.
19. Browser-client assurance and release scope.
20. Agent runtime persistence and replication.
21. Collections local-only versus encrypted sync.
22. Client update signing, downgrade protection, and minimum supported version.
23. Client and protocol version support window.
24. Account deletion and audit retention.
25. Data residency, jurisdiction, subprocessors, and privacy notices.
26. Free-tier quotas and paid migration threshold.
27. External security review scope.
28. Privacy notice and user-facing recovery language.

Each ADR should be tracked with an owner, status, decision deadline, blocking phase, accepted alternatives, rejected alternatives, and required test evidence.

## 9. Final Recommendation

Proceed with the project, but treat secure messaging as the core product and agent communication as a first-class extension of that secure messaging model.

The recommended baseline is:

- Tauri 2 plus SvelteKit static SPA for mobile and desktop.
- Rust client security core.
- Cloudflare Workers for APIs.
- Durable Objects for conversations, mailboxes, and atomic coordination.
- D1 for control-plane metadata.
- R2 for client-encrypted attachments.
- Queues for reconstructible background jobs.
- MLS/OpenMLS as the leading protocol candidate after Phase 0 validation.
- Libsignal as a comparison candidate, not an assumed dependency.
- Passkeys/passwords for account authentication.
- Local passcode/biometric for device unlock.
- No administrative message-key recovery.
- Direct messages and groups in MVP.
- Channels and full threads deferred.
- Controlled ownership transfer.
- Private Sidebar Collections.
- Agents as distinct owner-linked principals.
- Temporary encrypted server delivery.
- Local readable history.
- Explicit metadata and endpoint limitations.
- Quotas and observability from the beginning.
- External security review before sensitive production use.

This architecture preserves the core brainstorming ideas while correcting the places where mobile reliability, end-to-end encryption, Cloudflare service behavior, library risk, cost control, and account recovery require stronger decisions.

## 10. References

Platform limits, pricing, library status, and mobile behavior are time-sensitive. Revalidate these before implementation and before production launch.

Standards and cryptographic implementations:

- RFC 9420: The Messaging Layer Security Protocol: https://www.rfc-editor.org/rfc/rfc9420.html
- RFC 9750: The Messaging Layer Security Architecture: https://www.ietf.org/rfc/rfc9750.pdf
- OpenMLS repository: https://github.com/openmls/openmls
- OpenMLS documentation: https://openmls.tech/
- OpenMLS security audit note: https://blog.openmls.tech/
- OpenMLS security assessment PDF: https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf
- libsignal repository: https://github.com/signalapp/libsignal

Authentication and application security:

- NIST SP 800-63B: https://pages.nist.gov/800-63-4/sp800-63b.html
- WebAuthn Level 3: https://www.w3.org/TR/webauthn-3/
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Content Security Policy Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
- OWASP Threat Modeling Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
- OWASP MASVS: https://mas.owasp.org/MASVS/
- OWASP MASVS cryptography checklist: https://mas.owasp.org/checklists/MASVS-CRYPTO/
- Apple Secure Enclave key protection: https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave
- Android Keystore system: https://developer.android.com/privacy-and-security/keystore

Cloudflare platform:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects overview: https://developers.cloudflare.com/durable-objects/
- Durable Objects WebSockets and hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects data location: https://developers.cloudflare.com/durable-objects/reference/data-location/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 Time Travel and backups: https://developers.cloudflare.com/d1/reference/time-travel/
- D1 jurisdiction changelog: https://developers.cloudflare.com/changelog/product/d1/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- R2 object lifecycles: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- R2 data location: https://developers.cloudflare.com/r2/reference/data-location/
- Queues pricing and retention: https://developers.cloudflare.com/queues/platform/pricing/
- Queues delivery guarantees: https://developers.cloudflare.com/queues/reference/delivery-guarantees/

Client platform:

- Tauri 2 documentation: https://v2.tauri.app/
- Tauri frontend configuration: https://v2.tauri.app/start/frontend/
- Tauri capabilities: https://v2.tauri.app/security/capabilities/
- Tauri Content Security Policy: https://v2.tauri.app/security/csp/
- Tauri updater: https://v2.tauri.app/plugin/updater/
- SvelteKit documentation: https://svelte.dev/docs/kit

Mobile notifications:

- Apple background notifications: https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
- Apple Notification Service Extension: https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension
- Firebase Cloud Messaging encryption: https://firebase.google.com/docs/cloud-messaging/encryption
- Firebase Android message priority: https://firebase.google.com/docs/cloud-messaging/android/message-priority
