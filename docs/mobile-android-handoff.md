# Mobile Android Handoff

Status: Android emulator P0 complete + sideloadable APK
Date: 2026-06-08
Related docs:

- `docs/mobile-ios-handoff.md`
- `docs/frontend-web-desktop-handoff.md`
- `docs/mobile-app-requirements.md`

## 1. What Is Done

- The Tauri Android project is generated at `apps/client/src-tauri/gen/android/`.
- The app builds (Rust → `aarch64-linux-android`) and installs/runs on an Android emulator (Pixel, Android 16, arm64).
- Sign-in works against the local Worker; the mobile chat shell, room threads, grouped bubbles, plain/Markdown rendering, delivery state, and the bottom-tab shell all render natively.
- The **hardware back button** navigates the in-app history (thread → conversation list) and exits at the root — see Implementation Notes.
- Status bar + gesture-nav insets are respected (edge-to-edge `MainActivity` + the shared safe-area CSS).
- The Android device registers with the backend as `platform = android`, label `Mobile app · Android` (shared `platform.ts` logic the iOS pass added).
- Sideloadable **debug and local manual-test release APKs** (arm64) are produced for a physical phone; they target the deployed Worker and connect with working CORS (a deployed-Worker sign-in returns a real auth response, confirming connectivity).

## 2. Implementation Notes

- **Emulator networking.** Android emulators reach the host via `10.0.2.2`, not `127.0.0.1`. `config.ts` now returns `http://10.0.2.2:8787` for Android Tauri dev (desktop/iOS still use `127.0.0.1`). `10.0.2.2:8787` was added to the Tauri CSP `connect-src`.
- **Cleartext.** Tauri's generated Gradle sets the `usesCleartextTraffic` manifest placeholder to `true` for **debug** and `false` for **release**, so emulator/LAN HTTP works in dev while release builds stay HTTPS-only. No manual network-security config was needed.
- **Hardware back.** Tauri's generated `TauriActivity` sets `handleBackNavigation = false` (back is a no-op). `MainActivity` overrides it to `true`, so Wry routes the system back gesture/button to the WebView history (SvelteKit `pushState` entries), giving native thread→list→exit behavior. (This is a customization of the generated project; re-running `tauri android init` would regenerate `MainActivity.kt`.)
- **Launcher icon.** The generated Android project must mirror `src-tauri/icons/android/`. If Android shows the teal/yellow placeholder icon, copy the Voyager `ic_launcher*` PNGs plus `mipmap-anydpi-v26/ic_launcher.xml` and `values/ic_launcher_background.xml` into `src-tauri/gen/android/app/src/main/res/`.
- **Inherited iOS fixes apply on Android too:** 16px touch inputs (no focus-zoom), VisualViewport-bound app shell, tightened composer, narrow-width bubble constraints.
- **Toolchain:** JDK 17 (Temurin), Android SDK at `~/Library/Android/sdk`, **NDK r27.3.13750724**, CMake 3.22.1, `cmdline-tools;latest`, platform `android-36`. Env vars are in `~/.zshrc` (`ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME`, PATH). Rust targets: `aarch64/armv7/i686/x86_64-linux-android`.
- **Binary size:** `[profile.dev] strip = "debuginfo"` in `src-tauri/Cargo.toml` keeps the debug `.so` (and thus the sideload APK) small without affecting release.
- **Manual release signing:** Local release APKs reuse Android's debug signing config only so `npm run tauri -- android build --apk --target aarch64` can be installed on a physical test device. This is not production/store signing.

## 3. Verified Commands

Backend (repo root):

```bash
npm run dev:backend     # local Worker on :8787 (reachable from the emulator at 10.0.2.2:8787)
npm run seed            # demo data — ada@example.com / voyager-demo-pass
```

Emulator (one-time AVD, then build/install via CLI — avoids the Android Studio GUI that `tauri android dev` opens):

```bash
# Create + boot an AVD (in-SDK avdmanager resolves the system image correctly)
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n voyager_pixel \
  -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7 --force
"$ANDROID_HOME/emulator/emulator" -avd voyager_pixel &

# Build a debug APK that points at the LOCAL Worker, then install + launch
cd apps/client
VITE_API_BASE_URL=http://10.0.2.2:8787 npm run tauri -- android build --apk --debug --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n com.microgentic.voyager/com.microgentic.voyager.MainActivity
adb exec-out screencap -p > /tmp/voyager-android.png   # capture
```

> `tauri android dev` opens Android Studio and expects you to press Run. For a headless loop, the `tauri android build --apk` + `adb install` flow above is more reliable.

## 4. Build + install the APK on a physical phone (Samsung)

Build the sideloadable APK (defaults to the **deployed** Worker, so it works on any network):

```bash
cd apps/client
npm run tauri -- android build --apk --debug --target aarch64
# → src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Install on the phone — either path:

- **Cable (adb):** enable **Developer options** (Settings → About phone → tap *Build number* 7×) and **USB debugging**, connect the phone, then `adb install -r app-universal-debug.apk`.
- **No cable:** copy the `.apk` to the phone (USB file transfer, Drive, email…), tap it in **Files**, and allow **"Install unknown apps"** for the installer when prompted.

It is a **debug** APK (debug-signed, installs without a keystore).

Build the local manual-test release APK:

```bash
cd apps/client
npm run tauri -- android build --apk --target aarch64
# → src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

This release APK is signed with the local Android debug key for sideload testing only. A Play Store / production build still needs a protected release keystore (deferred — see §6).

## 5. Giving the phone an account to sign into

The default APK talks to the deployed Worker `https://voyager-api-dev.microgentic-voyager.workers.dev`. To sign in from a physical phone, seed that deployed Worker once with demo accounts, or build a LAN-specific APK that points at a local Worker.

**A. Seed the deployed Worker (works anywhere, recommended).** You have `wrangler` authenticated:

```bash
wrangler secret put BOOTSTRAP_TOKEN        # choose any strong value when prompted
# then seed the deployed Worker with the demo data (reuses the seed script):
BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
  BOOTSTRAP_TOKEN=<the value you just set> npm run seed
```

Then sign in on the phone with any seeded human account, for example
`ada@example.com` / `voyager-demo-pass` or `grace@example.com` /
`voyager-demo-pass`. Agents are seeded as app principals, not password-login
accounts. The expanded seed also includes admin-role accounts listed in the
root `README.md`.

**B. Same-Wi-Fi LAN testing (quick, no deploy).** Run the local seeded Worker and build an APK pointed at this Mac's LAN IP (currently `172.20.22.123`), allowing that origin in the CSP:

```bash
npm run dev:backend   # + npm run seed, in the repo root
cd apps/client
VITE_API_BASE_URL=http://172.20.22.123:8787 \
  npm run tauri -- android build --apk --debug --target aarch64 \
  -c '{"app":{"security":{"csp":"default-src '"'"'self'"'"'; img-src '"'"'self'"'"' data: blob: asset: http://asset.localhost; media-src '"'"'self'"'"' blob: asset: http://asset.localhost; font-src '"'"'self'"'"' data:; style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; script-src '"'"'self'"'"'; connect-src '"'"'self'"'"' ipc: http://ipc.localhost https://voyager-api-dev.microgentic-voyager.workers.dev http://localhost:8787 http://127.0.0.1:8787 http://10.0.2.2:8787 http://172.20.22.123:8787"}}}'
```

Keep the phone on the same Wi-Fi as the Mac; sign in with the demo credentials. (LAN HTTP is allowed because debug builds permit cleartext. The Worker's CORS already allows the Android `http://tauri.localhost` origin.)

## 6. Remaining Mobile Work

- External dependencies remain deferred: FCM push, Play Store, **production release signing/keystore**, billing, hosted AI runtimes, encrypted cloud backups, production updater.
- Native security work remains future scope: MLS/OpenMLS, local encrypted history, secure storage, biometric unlock, device-bound proof.
- Native polish remains future scope: swipe-back gesture, pull-to-refresh, haptics, deep links, share sheets, camera/file picker, and virtualized long-history timelines.
