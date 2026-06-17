Ready-to-Copy: Improved Local iOS Simulator GUI Workflow

This is a cleaned-up, reliability-enhanced version of the workflow from docs/instructions/iOS-simulator-workflow-GUI.md.

**Key finding from actual run (2026-06):**  
`tauri ios dev` itself executes the `beforeDevCommand` (`npm run dev` from tauri.conf.json) and manages the frontend dev server during the build/install. Pre-starting `npm run dev` in `apps/client` causes "Port 1420 is already in use", which makes the beforeDevCommand fail. This in turn breaks the Xcode build phase script (`tauri ios xcode-script`) that communicates back to the Tauri CLI (WebSocket connection refused → panic + build failure).

Additional reliability tweaks:
- Explicitly boot a specific simulator device (iPhone 17 recommended) instead of relying only on `open -a Simulator`.
- Pass the device name as the positional `[DEVICE]` argument to `tauri ios dev` to skip the interactive "Detected iOS simulators" / index prompt from ios-deploy.
- Use a reliable `terminate + launch` pattern for relaunches.
- Free port 1420 before running `tauri ios dev`; that command starts Vite itself through Tauri's `beforeDevCommand`.
- If `.wrangler/local-state` is deleted, uninstall the simulator app before signing in again so the app does not reuse a stale local `deviceId`.
- Start the client dev server **after** the `tauri ios dev --no-watch` build succeeds (for hot-reloading while using the app).

All paths, commands, and credentials stay faithful to the current project state (bundle ID `com.microgentic.voyager`, scheme `voyager_iOS`, dev server on 1420, backend on 8787).

───

Local iOS Simulator GUI Guide (with reliability tweaks)

Prerequisites
• The iOS target is already initialized (the Xcode project exists at `apps/client/src-tauri/gen/apple/voyager.xcodeproj`).
• You have Xcode + iOS simulators installed.
• You will need multiple Terminal windows/tabs. The client dev server timing is different from the original guide (see below).

1. Start the local backend
Open a Terminal and run:

```bash
cd /Users/admin/microgentic/app
npm run dev:backend
```

Leave this window open.

(Optional: For a completely fresh backend first, run this in the same terminal before the command above:)

```bash
cd /Users/admin/microgentic/app
rm -rf .wrangler/local-state
```

When prompted about migrations, press Enter.

Important: deleting `.wrangler/local-state` resets the local D1 database, including the device registry. The iOS app may still have an old `deviceId` saved in simulator storage. If you reset local backend state, also uninstall the simulator app later in step 4 before signing in.

2. Seed demo data
Open a second Terminal window and run:

```bash
cd /Users/admin/microgentic/app
npm run seed
```

Demo credentials:
- Owner: `ada@example.com` / `voyager-demo-pass`
- User: `grace@example.com` / `voyager-demo-pass`

3. Boot the simulator — robustly (critical for the deploy step)
**CRITICAL CLARIFICATION ON THE GUI:**

- Do **NOT** manually launch the Simulator app first by clicking its icon in Launchpad, Spotlight, Dock, Finder, or Applications folder.
- Do **NOT** open it "before the sequence".

Instead, run the Terminal commands below. The sequence itself launches the Simulator GUI for you (see the last line).

A plain `boot` + `open` can leave the device in a transitional state. Tauri will reach "BUILD SUCCEEDED" but then fail the final `simctl install` / deploy with "Unable to lookup in current state: Shutdown" (exactly what happened in the latest attempt).

**Run this exact block in Terminal (it includes opening the GUI at the end):**

```bash
# Clean slate — avoid conflicts with other booted devices (e.g. iPhone 17 Pro Max)
xcrun simctl shutdown all || true

# List if you want to pick a different device
xcrun simctl list devices available

# Boot the exact device we want
xcrun simctl boot "iPhone 17"

# This is the key: blocks until the simulator is fully booted and ready (data migration, system apps, etc.)
xcrun simctl bootstatus "iPhone 17"

# Now open the GUI (this is the command that launches Simulator.app on your Mac)
open -a Simulator
```

Confirm right before the build:

```bash
xcrun simctl list devices booted
```

You should see only (or at least) `iPhone 17 (96A7CB90-3526-4E3F-BED8-7A6F630FF845) (Booted)`.

The `open -a Simulator` line **is** how the visual Simulator app gets opened. It is deliberately placed at the end of the preparation so the device is ready when the GUI appears and when Tauri later tries to install the app.

**Important:** Do **not** run `npm run dev` in `apps/client` yet.  
`tauri ios dev` will start the Vite dev server internally via `beforeDevCommand`.

4. Clear stale simulator app data when needed
Run this if either of these is true:

- You deleted `.wrangler/local-state`.
- The app shows `Device is not enrolled or has been revoked`.

```bash
xcrun simctl terminate booted com.microgentic.voyager || true
xcrun simctl uninstall booted com.microgentic.voyager || true
```

Why this matters: the frontend stores a remembered `deviceId` per email so repeat logins reuse the same enrolled device. After a backend reset, that remembered simulator-side `deviceId` points to a device row that no longer exists, and the backend correctly returns `403 device_not_available`.

5. Ensure port 1420 is free before Tauri builds
Do this immediately before `tauri ios dev`:

```bash
CLIENT_PID="$(lsof -tiTCP:1420 -sTCP:LISTEN || true)"
if [ -n "$CLIENT_PID" ]; then
  kill $CLIENT_PID
fi

while lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; do
  sleep 1
done
```

Do not leave a manually-started `npm run dev` running before the next step. `tauri ios dev` needs to start Vite itself. If port 1420 is already occupied, the build usually fails with:

```text
Error: Port 1420 is already in use
failed to build WebSocket client ... Connection refused
Command PhaseScriptExecution failed with a nonzero exit code
```

6. Build and install Voyager (first time / clean build)
In a terminal, run:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run tauri -- ios dev "iPhone 17" --no-watch
```

- The `"iPhone 17"` is the positional `[DEVICE]` argument — this skips the interactive simulator selection list.
- `--no-watch` performs a one-shot build + install instead of keeping a native watcher attached.
- The first run is slow (Rust compilation for the iOS target + full Xcode build).
- `tauri ios dev` will start its own Vite instance on port 1420 for the duration of the build.
- After it finishes successfully, Voyager will be installed and should appear in the iPhone 17 simulator.

7. (Recommended for development) Start the client dev server for hot-reloading
Only after the command in step 6 succeeds, open another terminal and run:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run dev
```

The already-installed app in the simulator loads its UI from `http://localhost:1420`. Starting Vite now enables live updates while you click around in Simulator.

8. Use Voyager in the Simulator
In the Simulator window:

- Email: `ada@example.com`
- Passphrase: `voyager-demo-pass`
- Tap **Sign in**
- Open **Billing operations**
- Tap the message field
- Type a message
- Tap the send button

9. Relaunch Voyager later without rebuilding (improved)
Clicking the app icon in Simulator often works, but for a reliable relaunch use:

```bash
xcrun simctl terminate booted com.microgentic.voyager || true
xcrun simctl launch booted com.microgentic.voyager
```

───

Using Xcode UI (alternative)
For this path you **should** start the client dev server before building/running (because Xcode's Run does not go through `tauri ios dev`'s beforeDevCommand handling the same way).

Open the project:

```bash
open /Users/admin/microgentic/app/apps/client/src-tauri/gen/apple/voyager.xcodeproj
```

In Xcode:
1. Choose the `voyager_iOS` scheme.
2. Choose an iPhone simulator (e.g. **iPhone 17**).
3. Press the **Run** button.

When Voyager opens in Simulator, sign in with:

```
ada@example.com
voyager-demo-pass
```

You still need `npm run dev:backend` running. The client `npm run dev` is also needed for this path so the WebView has a server to talk to.

───

Critical Reminders
• The backend (`npm run dev:backend` at the root) must stay running the entire time.
• For the main `npm run tauri -- ios dev "iPhone 17" --no-watch` flow: **do not** pre-start `npm run dev` in `apps/client`. Let the tauri command own the dev server during build/install. You can start it manually afterwards for live frontend editing.
• If you reset `.wrangler/local-state`, uninstall the simulator app before logging in again. Otherwise the app may send a stale stored `deviceId` and receive `403 Device is not enrolled or has been revoked`.
• If `tauri ios dev` reports "Port 1420 is already in use", stop the existing Vite process and rerun the Tauri command. Do not select the simulator prompt again while another failed build is still unwinding.
• The simulator must be verifiably Booted (use `bootstatus`) before the tauri deploy step, otherwise you get the "Unable to lookup in current state: Shutdown" error even if the Xcode build succeeds.
• The native shell is built once; all UI/content (SvelteKit) comes from the Vite dev server on localhost:1420.
• If the app shows a blank screen or fails to load content after install: ensure the backend is up, and (if you are doing live development) that `npm run dev` in `apps/client` is also running.
• The Xcode build phase "Build Rust Code" script talks back to the running `tauri ios dev` process. That is why the beforeDevCommand must succeed for the full flow to complete.

───

Troubleshooting: exact recovery commands

Use this block when you are in the same situation as the latest failed run: backend is still running, Simulator is open, `npm run dev` is occupying 1420, and the app may have stale simulator storage.

```bash
# Stop any existing client dev server on 1420.
CLIENT_PID="$(lsof -tiTCP:1420 -sTCP:LISTEN || true)"
if [ -n "$CLIENT_PID" ]; then
  kill $CLIENT_PID
fi

while lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; do
  sleep 1
done

# Clear only the simulator app's local data.
xcrun simctl terminate booted com.microgentic.voyager || true
xcrun simctl uninstall booted com.microgentic.voyager || true

# Rebuild and reinstall. Do not start npm run dev before this command.
cd /Users/admin/microgentic/app/apps/client
npm run tauri -- ios dev "iPhone 17" --no-watch
```

After that succeeds, start Vite for normal UI use:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run dev
```

Then relaunch Voyager if it is not already visible:

```bash
xcrun simctl launch booted com.microgentic.voyager
```

Copy the command blocks above directly into your terminals as needed. The corrected ordering + explicit device argument avoids the port conflict and the interactive prompt that were encountered when following the earlier version of this guide.
