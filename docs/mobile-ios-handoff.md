# Mobile iOS Handoff

Status: iOS simulator P0 complete
Date: 2026-06-07
Related docs:

- `docs/frontend-web-desktop-handoff.md`
- `docs/mobile-app-requirements.md`

## 1. What Is Done

- The Tauri iOS project is generated at `apps/client/src-tauri/gen/apple/voyager.xcodeproj`.
- The app builds and installs on the iPhone 17 simulator.
- The Voyager login screen renders natively in the simulator with the notch/status area respected.
- The simulator can sign in to the local backend with the seeded demo account.
- The mobile chat list renders the bottom-tab shell, search, room-invitation banner, human rooms, and agent rooms.
- The group thread renders seeded messages, grouped bubbles, markdown/plain text, sender avatars, and delivery state.
- The composer works on iOS: focus, keyboard accessory positioning, typing, sending, and post-send sync were verified.
- The iOS device now registers with the backend as `platform = ios` and label `Mobile app · iOS`.

## 2. Implementation Notes

- Worker CORS was added so Tauri/mobile clients can call the Worker directly when they are not using same-origin hosting.
- Browser dev still uses the Vite proxy by default.
- Tauri dev clients now default to `http://127.0.0.1:8787` in development. The iOS Simulator path exposed that WebKit + Vite proxy can forward JSON POST requests with an empty body, so direct local Worker access is more reliable for native dev.
- The composer was tightened for phone widths: primary attach/send controls remain visible, the markdown toggle is hidden on phone-width composer rows, and larger screens retain it.
- Message bubbles and composer internals now use stricter narrow-width constraints to avoid horizontal overflow.
- iOS WebView zoom guard: WebKit zoomed and panned the whole page when focused inputs computed below 16px. The symptom was a clipped right edge after sign-in or composer focus, temporarily corrected by double-tapping empty space. The global coarse-pointer input rule now uses `font-size: 16px !important` so Tailwind utilities cannot override it, and the document uses `touch-action: manipulation` to avoid double-tap zoom. Keep future mobile inputs/textareas at 16px or larger, or explicitly verify they do not trigger iOS focus zoom.
- iOS composer focus-scroll guard: after the zoom fix, focusing the composer could still make the room header slide under the status bar because WebKit renders focused inputs against a shifted visual viewport. The root layout now binds VisualViewport measurements to CSS variables, and the authenticated app shell uses those variables for its fixed top/left/width/height. `html`/`body` remain height-locked with `overflow: hidden`; scrolling must stay inside app panes such as the message list and conversation list.
- Simulator keyboard note: the small bar with up/down arrows and a checkmark is the default iOS/WKWebView input accessory, not Voyager UI. It wasted vertical space in the composer, so the Tauri window now sets `disableInputAccessoryView: true`. Use Simulator `I/O > Keyboard > Toggle Software Keyboard` or press `Cmd+K` when a full software keyboard is needed for manual testing.

## 3. Verified Commands

From the repo root:

```bash
npm run dev:backend
npm run seed
```

From `apps/client`:

```bash
npm run tauri -- ios dev "iPhone 17" --no-watch
npm run dev
```

For the CLI `tauri ios dev` flow, keep port 1420 free until the install command finishes, then start `npm run dev` for hot reload.

Additional checks performed:

```bash
npm run check
npm run build
npm run tauri -- info
xcrun simctl launch booted com.microgentic.voyager
xcrun simctl io booted screenshot /tmp/voyager-ios/chats.png
xcrun simctl io booted screenshot /tmp/voyager-ios/thread-sent.png
```

## 4. Remaining Mobile Work

- Android setup is still blocked on the Android Studio/JDK/SDK/NDK/emulator toolchain.
- External dependencies remain deferred: APNs/FCM push, store builds, production signing, billing, hosted AI runtimes, encrypted cloud backups, and production updater.
- Native security work remains future scope: MLS/OpenMLS, local encrypted history, secure storage, biometric unlock, and device-bound proof.
- Native mobile polish remains future scope: swipe-back, pull-to-refresh, haptics, deep links, share sheets, camera/file picker, and virtualized long-history timelines.
