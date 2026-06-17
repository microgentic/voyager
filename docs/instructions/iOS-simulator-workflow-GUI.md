**Local UI-Only iOS Simulator Guide**
1. Open **Terminal** and start the local backend:

```bash
cd /Users/admin/microgentic/app
npm run dev:backend
```

Leave that Terminal window open.

2. Open a second **Terminal** window and seed demo data:

```bash
cd /Users/admin/microgentic/app
npm run seed
```

3. Make sure the client dev server is not already occupying port 1420 before the iOS build:

```bash
CLIENT_PID="$(lsof -tiTCP:1420 -sTCP:LISTEN || true)"
if [ -n "$CLIENT_PID" ]; then
  kill $CLIENT_PID
fi
```

4. Open **Simulator**:

```bash
open -a Simulator
```

5. Build/install Voyager once:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run tauri -- ios dev "iPhone 17" --no-watch
```

After it finishes, Voyager should appear in the iPhone simulator.

6. Start the client dev server for normal UI use and hot reload:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run dev
```

7. In the Simulator app, use Voyager like a normal phone app:

- Email: `ada@example.com`
- Passphrase: `voyager-demo-pass`
- Tap **Sign in**
- Open **Billing operations**
- Tap the message field
- Type a message
- Tap the send button

8. To relaunch Voyager later without rebuilding, click the app icon in Simulator, or run:

```bash
xcrun simctl launch booted com.microgentic.voyager
```

**Using Xcode UI**
Open the iOS project:

```bash
open /Users/admin/microgentic/app/apps/client/src-tauri/gen/apple/voyager.xcodeproj
```

Then in Xcode:

1. Choose the `voyager_iOS` scheme.
2. Choose an iPhone simulator, such as **iPhone 17**.
3. Press the **Run** button.
4. When Voyager opens in Simulator, sign in with:

```text
ada@example.com
voyager-demo-pass
```

You still need `npm run dev:backend` and `npm run dev` running in Terminal while using the app. For the CLI `tauri ios dev` flow, start `npm run dev` only after the one-shot install succeeds.
