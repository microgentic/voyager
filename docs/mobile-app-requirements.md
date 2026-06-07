# Mobile App Requirements (iOS + Android)

Status: planning note for the mobile build
Date: 2026-06-07
Related: `docs/frontend-web-desktop-handoff.md`, the master plan, and the
backend contract handoff.

The mobile apps are the **same** SvelteKit client packaged with **Tauri 2**
(`apps/client` + `apps/client/src-tauri`). This documents what carries over
untouched versus what is genuinely mobile-specific work.

## 1. What already carries over (built for mobile from day one)

- **Mobile-first shell.** The responsive layout already renders a single-pane,
  bottom-tab-bar experience below 900px: full-screen conversation threads with a
  back button, bottom-sheet modals/action sheets, large touch targets, momentum
  scrolling, `tap-highlight` suppression, and disabled input zoom.
- **Safe areas.** `env(safe-area-inset-*)` tokens (`--sat/--sab/--sal/--sar`) and
  `pt-safe`/`pb-safe` utilities are wired through headers, tab bar, composer, and
  modals. `viewport-fit=cover` is set.
- **Theme + tokens.** Light/dark via CSS variables, `theme-color` metas, pre-paint
  theme application.
- **All product features.** Auth, conversations, groups, agents, attachments,
  invitations, collections, settings, and the runes stores + API client + codec
  are platform-agnostic and reused as-is.

So the mobile effort is **packaging + native integration + polish**, not a UI
rewrite.

## 2. Tauri mobile setup

- Initialize targets: `npm run tauri android init`, `npm run tauri ios init`
  (icons are already generated for both — see `src-tauri/icons/android` & `ios`).
- Toolchains: **Xcode + CocoaPods** (iOS), **Android Studio / SDK + NDK** and a
  JDK (Android). Rust targets: `aarch64-apple-ios`, `aarch64-linux-android`, etc.
- Dev: `npm run tauri ios dev` / `npm run tauri android dev` (device or
  simulator/emulator). The same Vite dev server + proxy is used in dev.
- The `tauri.conf.json` CSP `connect-src` must include the production API origin
  (and, in production, the API must allow the app origin — see §6).

## 3. Native plugins / capabilities to add

| Need | Plugin / approach |
| --- | --- |
| Push notifications | APNs (iOS) + FCM (Android). Requires the **deferred backend push** work (`push_endpoints`, APNs/FCM dispatch). A best-effort wake-up/awareness hint only — never the source of truth; generic/encrypted-safe payloads. |
| Secure storage | `tauri-plugin-stronghold` or Keychain/Keystore via a native command — to wrap the local DB key / unlock secret (master plan §1.12, §5.4). |
| Biometric unlock | `tauri-plugin-biometric` (Face ID / Touch ID / Android BiometricPrompt) gating release of the local key. |
| Local notifications | `tauri-plugin-notification` for in-app/local alerts. |
| Haptics | `tauri-plugin-haptics` for send/long-press feedback (native feel). |
| Status/nav bar | Per-theme status-bar style + Android navigation-bar color; edge-to-edge. |
| File/image/camera | `tauri-plugin-dialog` / `fs` + camera for attachment capture & picking. |
| Share sheet | Share-in (receive files/links) and share-out. |
| Deep links | `tauri-plugin-deep-link` to route `voyager://activate?token=…` and reset links into the existing `/activate` and `/reset` screens. |
| Clipboard | `tauri-plugin-clipboard-manager` (copy code blocks, tokens). |
| Network status | Detect offline to pause polling and show state. |

> Plugin names above are **implementation candidates** — validate each on both
> iOS and Android before committing to it.

## 4. Behavior differences to handle

- **Background execution + delivery.** Mobile OSes suspend the app and its
  sockets/timers, so the polling `sync` loop won't run in the background. Treat
  **push as a best-effort wake-up / awareness hint — not the source of truth and
  not guaranteed.** Attempt a background wake through push, but always recover
  through the durable mailbox + sync-on-resume path (the backend is
  store-and-forward; an immediate sync is already wired to `visibilitychange`).
- **Keyboard.** Use `visualViewport` to keep the composer above the keyboard;
  ensure the message list stays pinned to the latest on keyboard open.
- **Gestures.** Add edge **swipe-back**, **pull-to-refresh** on lists,
  **long-press** to open the message/room action sheet, and optional swipe
  actions on conversation rows. Suppress the browser's default overscroll/refresh.
- **Virtualization matters here.** On constrained devices, switch the message
  timeline to **TanStack Virtual** (the row model is already isolated in
  `MessageList.svelte`) and cap decoded-attachment memory / object URLs.

## 5. Security core (shared with desktop, critical on mobile)

- Implement the **Rust client security core** in `src-tauri` (MLS/OpenMLS): device
  identity, key packages, group epochs, message encrypt/decrypt, exposed to the
  web layer as `#[tauri::command]`s behind the existing `MessageCodec` interface.
- **Local encrypted history DB** with the key wrapped by OS secure storage and
  optionally gated by biometric/passcode unlock. Forgotten-passcode recovery is
  destructive by design (master plan §1.12).
- Per-platform **device enrollment** and revocation that locks local sync.

## 6. Distribution & CI/CD

- **Signing:** Apple Developer account + provisioning/certs (notarization for any
  sideload); Android keystore.
- **Stores:** App Store + Play Store metadata, privacy labels, age rating. **Do
  not claim end-to-end encryption in store listings until MLS is active** (the
  bundle description has already been softened accordingly).
- **CI:** macOS runners for iOS builds, signing secrets in CI, optional fastlane.
  Reuse the minimum-secure-client-version / signed-update requirements from the
  master plan.

## 7. Suggested phasing

1. **P0 — Run on device.** `tauri ios/android init`, build, sign, launch the
   existing UI; verify safe areas, keyboard, scrolling, deep links.
2. **P1 — Native feel.** Swipe-back, pull-to-refresh, long-press action sheets,
   haptics, status-bar theming, virtualized timeline.
3. **P2 — Delivery.** Push provider integration (with the backend push work) +
   background wake/sync.
4. **P3 — Security core.** MLS + local encrypted DB + biometric unlock + device
   enrollment.
5. **P4 — Ship.** Store builds, signing, privacy review, phased rollout.
