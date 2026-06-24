# Frontend Handoff — Web + Desktop Client

Status: web + desktop client implementation handoff
Date: 2026-06-07
Related docs:

- `docs/secure-client-agent-communications-master-plan.md` (authoritative plan)
- `docs/backend-contract-handoff.md` (the API this client targets)
- `docs/realtime-messaging-handoff.md` (foreground realtime event hints)
- `docs/mobile-app-requirements.md` (what the mobile build still needs)

## 1. What this is

The Voyager client app, implemented for **web and desktop** from a single
SvelteKit codebase wrapped by Tauri 2. It is a real asynchronous messenger:
direct messages, groups, agent chats, attachments, invitations, collections,
settings, and an agent-request flow — built against the existing Cloudflare
Worker contract, with no backend changes required to run it.

It lives in `apps/client/`, matching the monorepo shape in the master plan
(`apps/client` + `apps/client/src-tauri`). The Worker at the repo root is
untouched.

## 2. Tech stack (and why)

The master plan fixes the core stack (Tauri 2 + SvelteKit, Cloudflare backend).
For the rest of the toolkit:

- **SvelteKit 2 / Svelte 5 (runes)** — shared UI, routing, SPA build for Tauri.
- **`@sveltejs/adapter-static` (SPA, `index.html` fallback)** — one static
  bundle that runs on the web and inside the Tauri WebView. `ssr=false`.
- **Tailwind CSS 4** — design tokens via `@theme`, runtime light/dark through a
  CSS-variable cascade (`.dark`), safe-area utilities. No `tailwind.config.js`.
- **Bits UI** — accessible headless primitives (Dialog, DropdownMenu, Tooltip,
  Switch) under custom messenger styling.
- **TanStack Svelte Virtual** — present as a dependency for large-history
  virtualization (see §5 for the deliberate current tradeoff).
- **marked + DOMPurify** — sanitized Markdown rendering (no raw HTML, no remote
  images, safe links, inert code).
- **`@lucide/svelte`** — icon set (the Svelte 5-native package).
- **Custom components** — bubbles, composer, conversation list, nav rail, tab
  bar, action sheets — for a native messenger identity rather than a web-app feel.

## 3. Architecture / layers

```
src/lib/config.ts          API base resolution (dev proxy vs deployed)
src/lib/platform.ts        Tauri detection + native affordances (openExternal)
src/lib/session.ts         Token + identity + per-email deviceId persistence
src/lib/api/               types.ts (full typed contract), client.ts, errors.ts
src/lib/protocol/codec.ts  MessageCodec seam (OpaqueTestCodec today)
src/lib/stores/*.svelte.ts auth, ui, rooms, messages, sync, principals,
                           invitations, collections, compose, toast
src/lib/utils/             cn, time (UTC-safe), avatar, markdown, password, …
src/lib/components/ui/      Button, Avatar, Modal (sheet/dialog), Menu, …
src/lib/components/nav/     NavRail, TabBar, ConversationList(+Item), SectionHeader
src/lib/components/chat/    RoomHeader, MessageList, MessageBubble, Composer, …
src/lib/components/rooms/   NewConversation, RoomDetails, CollectionPicker
src/routes/(auth)/         login, activate, reset (branded chrome)
src/routes/(app)/          app shell + chats master/detail, invites, agents, settings
```

Boundary rules from the plan are respected: the UI imports no concrete crypto
(only the codec interface); the API client is the single source of contract
types; platform-specific behavior is isolated in `platform.ts` / `src-tauri`.

### Responsive shell

One layout adapts by viewport (`ui.isWide`, ≥ 900px):

- **Desktop** — a slim icon **NavRail** + a fixed conversation-list pane + the
  conversation/detail pane (Telegram/Discord density).
- **Mobile** — a single pane with a bottom **TabBar**; tapping a conversation
  routes to a full-screen thread (tab bar hidden), with a back button. Safe-area
  insets, large touch targets, bottom-sheet modals, momentum scrolling.

### State + sync

Runes-based class stores. `realtime.svelte.ts` mints Messaging Core realtime
tokens with `POST /v1/messaging-core/realtime/token`, opens the returned Core
WebSocket path for lightweight `room.message` hints, and opens
`/v1/calls/realtime` separately for `call.*` lifecycle hints. Messaging hints call
`sync.pokeNow()`; `sync.svelte.ts` still polls `GET /v1/sync` as the
source-of-truth and recovery path, then pulls new messages for the open room.
Sends are optimistic (`sending → sent/failed`, with retry) and reconciled by
`idempotencyKey`. Unread is derived from a per-room last-read sequence; opening
a room acks others' messages as read.

## 4. How it maps to the backend contract

- Auth: `POST /v1/auth/password/login`, `/v1/invitations/accept`,
  `/v1/auth/password/reset/complete`, `/v1/me`, `/v1/auth/password/change`,
  logout, sessions, devices. The returned `device.deviceId` is persisted per
  email and reused on login (no device-quota churn).
- Rooms/messages/attachments/collections/agent-requests/room-invitations and
  ownership transfers use the documented endpoints. Lists honor `nextCursor`.
- The client sends `protocolType: "opaque-test"` and an opaque `ciphertext`
  produced by the codec; the backend stays content-agnostic.

## 5. Key decisions (and honest tradeoffs)

1. **Encryption honesty.** Real E2EE (MLS via the Rust core) is deferred, so the
   shipped codec is `OpaqueTestCodec`: it base64-encodes the application payload
   (master plan §4.12) into `ciphertext`. It is **not** encryption and is named
   to say so. UI copy avoids asserting active E2EE; Settings → About states the
   status plainly. An `MlsCodec` keeps the UI and transport stable, but MLS
   also needs client security-state, persistence, device enrollment,
   key-package lifecycle, and encryption/verification error handling — it is
   not only a `codec.ts` swap.

2. **Message list is a robust scroller, not virtualized — for now.** At pilot
   scale a correct bottom-anchored scroller (day dividers, sender grouping,
   jump-to-latest) is more reliable than a fragile virtualization integration.
   The row model in `MessageList.svelte` is isolated so TanStack Virtual can be
   dropped in for very large histories without touching bubbles or the store.
   (The dependency is installed and ready.)

3. **Dev CORS via proxy.** The Worker has no CORS headers yet, so `vite dev`
   proxies `/v1` + `/health` to the local Worker and the client uses a
   same-origin (empty) API base in dev. Production cross-origin hosting needs
   CORS on the Worker — see §6.

4. **Realtime as hints, not state.** Foreground clients use Durable Object
   WebSockets for near-immediate awareness, but message bodies and durable
   state still come from HTTP sync/list endpoints. Conversation Durable Objects
   coordinate message writes without changing client reads. Polling remains the
   fallback for missed events, sleep, reloads, and offline recovery.

## 6. Known gaps / backend follow-ups

These are intentional and tracked, not oversights:

- **MLS E2EE + Rust security core** (`src-tauri`) — the real encryption, local
  encrypted history DB, and secure-storage unlock.
- **Backward pagination.** `GET /v1/rooms/{id}/messages` only supports an
  `after` cursor, so the client loads forward from the start. A `before` cursor
  would enable lazy history loading for large rooms.
- **Ownership-transfer acceptance.** The client can *propose* a transfer, but
  the backend exposes no "incoming transfers" list for the recipient to accept
  from, so there is no acceptance inbox yet.
- **Room-invitation management for owners.** No endpoint lists/revokes a room's
  pending invitations, so the details panel shows members only.
- **Conversation-list previews** populate after a room is opened or once sync
  delivers pending messages (no "last message per room" list endpoint).

## 7. Verification performed

- `npm run check` (svelte-check) and `npm run build` pass with zero errors.
- Tauri Rust deps resolve (`cargo fetch`) and the desktop shell + icons are set
  up; `npm run tauri dev` launches the same SPA.
- Driven end-to-end in a browser against a seeded local Worker: login, the
  responsive shell (desktop 3-pane and mobile), conversation list with the
  invitation banner and agent badges, the conversation timeline (grouped
  bubbles, day dividers, delivery receipts, plain vs. Markdown rendering), a
  **live optimistic send**, the group room, and the **room details** panel
  (members, Owner/Admin/Agent roles, the agent member, quick actions), in both
  dark and light themes.
- This pass also caught and fixed a real bug: the room page's init effect was
  re-tracking the rooms store, so each sync tick reset `showDetails` and closed
  the details panel — fixed by `untrack`-ing the body so it reacts to `roomId`
  only.

## 8. Running

See the root `README.md` quickstart. In short: `npm run dev:backend` +
`npm run seed`, then `apps/client → npm run dev` (web) or `npm run tauri dev`
(desktop). Demo login: `ada@example.com` / `voyager-demo-pass`.
