# Voyager

Voyager is a private, invitation-only messenger where **AI agents are first-class
participants** alongside people. It behaves like a normal secure messenger
(direct messages, groups, attachments) while treating agents as native
principals you can message, add to rooms, and request.

- **Backend** — a Cloudflare Worker (D1 + R2) that routes opaque message
  envelopes and stores control-plane metadata. It never needs plaintext.
- **Client** — a SvelteKit + Tauri app that runs on the **web** and as a
  **desktop** app today, with iOS/Android planned (see
  [`docs/mobile-app-requirements.md`](docs/mobile-app-requirements.md)).

> **Encryption status (honest):** messages travel as opaque envelopes over
> HTTPS and are gated by server-enforced room membership. Device-to-device
> **end-to-end encryption (MLS) is in development and not yet active.** Treat
> the current build as a pilot. The client isolates this behind a swappable
> message codec — a clean seam — but enabling MLS also requires the client
> security core (cryptographic state, device enrollment, key-package lifecycle,
> error handling), not just a codec swap.

---

## Architecture at a glance

```
apps/client/            SvelteKit SPA (web) wrapped by Tauri (desktop/mobile)
  src/lib/api/          Typed client for the Worker contract
  src/lib/protocol/     Message codec seam (opaque today, MLS later)
  src/lib/stores/       Runes stores: auth, rooms, messages, sync, …
  src/lib/components/    UI primitives + chat / nav / room components
  src/routes/           Auth screens + the app shell and routes
  src-tauri/            Rust shell (home of the future native security core)

src/                    The Cloudflare Worker (backend) — index.ts, backend.ts, db.ts
migrations/             D1 schema migrations
scripts/                Smoke tests, local backend runner, dev seed
docs/                   Master plan, contracts, and handoff notes
```

The client never assumes realtime: it polls `GET /v1/sync` and per-room message
lists. When Durable Object realtime lands it can feed the same stores.

**Tech stack:** Cloudflare Workers · D1 · R2 · SvelteKit 2 / Svelte 5 (runes) ·
Vite 8 · Tailwind CSS 4 · Bits UI · TanStack Virtual · Tauri 2.

---

## Prerequisites

- **Node 22+** and npm
- **Rust** (stable) + platform toolchain — only for the **desktop** app
  (`npm run tauri dev`). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- Wrangler is installed via dependencies; no global install needed.

---

## Quickstart (local development)

You need **two terminals**: one for the backend Worker, one for the client.

### 1. Backend (Worker + demo data)

```bash
npm install              # repo root — installs Worker deps
npm run dev:backend      # applies D1 migrations + runs the Worker on :8787
npm run seed             # in another terminal — seeds demo data (idempotent)
```

`npm run seed` prints the demo credentials:

| Role  | Email             | Passphrase                |
| ----- | ----------------- | ------------------------- |
| Owner | `ada@example.com` | `voyager-demo-pass` |
| User  | `grace@example.com` | `voyager-demo-pass` |

### 2. Client — web

```bash
cd apps/client
npm install
npm run dev              # http://localhost:1420
```

In `vite dev` the client talks to the Worker through a **same-origin proxy**
(`/v1`, `/health` → `127.0.0.1:8787`), so no CORS setup is needed. Sign in with
the demo credentials above.

### 3. Client — desktop (Tauri)

```bash
cd apps/client
npm run tauri dev        # opens the desktop window
```

`tauri dev` also starts the same Vite server on **:1420**, so you can run the
**web and desktop apps side by side** — just open `http://localhost:1420` in a
browser while the desktop window is running.

> The Voyager Dock/app icon appears in the **built** app (`npm run tauri build`,
> then open the `.app`). In `tauri dev` macOS shows the parent terminal's icon —
> a known dev-only limitation (the macOS Dock icon can't be set at runtime).

> Point the client at a different backend from **Settings → About → Advanced**,
> or with `VITE_API_BASE_URL` at build time.

---

## Building

```bash
# Web (static SPA → apps/client/build)
cd apps/client && npm run build

# Desktop bundle (.app/.dmg/.msi/… → src-tauri/target)
cd apps/client && npm run tauri build
```

The web build is a static SPA (`@sveltejs/adapter-static`, SPA fallback) and can
be hosted on Cloudflare Pages or served by the Worker. Hosting it on the **same
origin** as the API avoids CORS; a cross-origin web/desktop deployment requires
CORS headers on the Worker (a tracked backend follow-up).

---

## Testing & CI

```bash
# Backend
npm run check                 # tsc --noEmit (Worker)
npm run smoke:backend:local   # spins up a local Worker + D1/R2 and exercises the API

# Client
npm run client:check          # svelte-check
npm run client:build          # production build
```

GitHub Actions:

- **Deploy Worker** (`.github/workflows/deploy-worker.yml`) — type-check, backend
  smoke, migrate + deploy on `main`.
- **Client CI** (`.github/workflows/client-ci.yml`) — `svelte-check` + build on
  any change under `apps/client/`.

---

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/secure-client-agent-communications-master-plan.md`](docs/secure-client-agent-communications-master-plan.md) | The authoritative product + architecture plan |
| [`docs/backend-contract-handoff.md`](docs/backend-contract-handoff.md) | The backend API contract the client is built against |
| [`docs/frontend-web-desktop-handoff.md`](docs/frontend-web-desktop-handoff.md) | What the web/desktop client implements, decisions, and gaps |
| [`docs/mobile-app-requirements.md`](docs/mobile-app-requirements.md) | What the iOS/Android (Tauri mobile) build still needs |

---

## Security posture (summary)

- The backend stores **opaque** message envelopes and **opaque attachment blobs**;
  it is designed never to require plaintext.
- **Attachments are not yet client-side encrypted.** Files currently upload as
  opaque blobs over HTTPS; authenticated client-side attachment encryption is
  planned with the native security core and is not guaranteed in this build.
- Account **passphrases** authenticate to the service and are **not recoverable**
  by an administrator; they are separate from any future device unlock.
- Admin reset restores **account access only** — it cannot decrypt prior content.
- **MLS end-to-end encryption is not yet active.** The codec seam minimizes
  UI/transport churn, but MLS also needs the client security core; until it
  ships, do not rely on E2EE guarantees.
