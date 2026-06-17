Below is the exact iOS simulator workflow I used for Voyager.

**1. Start The Backend**
```bash
cd /Users/admin/microgentic/app
npm run dev:backend
```

Leave that terminal running.

If you want a fresh demo backend first:
```bash
cd /Users/admin/microgentic/app
rm -rf .wrangler/local-state
npm run dev:backend
```

When it asks about applying migrations, press `Enter`.

In a second terminal:
```bash
cd /Users/admin/microgentic/app
npm run seed
```

Demo login:
```text
ada@example.com
voyager-demo-pass
```

**2. Keep Port 1420 Free Before The iOS Build**
Do not start `npm run dev` before `tauri ios dev`. The Tauri command runs the configured `beforeDevCommand` and starts Vite on port 1420 during build/install.

If a previous client dev server is still running:

```bash
CLIENT_PID="$(lsof -tiTCP:1420 -sTCP:LISTEN || true)"
if [ -n "$CLIENT_PID" ]; then
  kill $CLIENT_PID
fi

while lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; do
  sleep 1
done
```

After the iOS app is installed, you can start `npm run dev` for hot reload.

The app talks directly to the local Worker:
```text
http://127.0.0.1:8787
```

**3. Boot The iPhone Simulator**
The iPhone 17 simulator currently used here was:

```bash
xcrun simctl boot 96A7CB90-3526-4E3F-BED8-7A6F630FF845 2>/dev/null || true
open -a Simulator
```

Or list available simulators:

```bash
xcrun simctl list devices available
```

Check what is booted:

```bash
xcrun simctl list devices booted
```

**4. Build And Install Voyager On iOS**
From the client app:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run tauri -- ios dev "iPhone 17" --no-watch
```

This builds and installs the app into the booted simulator. The first run can be slow.

After it succeeds, start the client dev server for normal UI use:

```bash
cd /Users/admin/microgentic/app/apps/client
npm run dev
```

If the app is already installed and you only need to relaunch it:

```bash
xcrun simctl terminate booted com.microgentic.voyager || true
xcrun simctl launch booted com.microgentic.voyager
```

**5. Test Through The Simulator UI**
In the Simulator window:

1. Enter:
   ```text
   ada@example.com
   ```
2. Enter:
   ```text
   voyager-demo-pass
   ```
3. Tap **Sign in**.
4. Open **Billing operations**.
5. Tap the message box.
6. Type a test message.
7. Tap the send button.

Expected result: the message appears in the group thread and the backend logs show:

```text
POST /v1/rooms/.../messages 201 Created
```

**6. Take Screenshots From CLI**
```bash
mkdir -p /tmp/voyager-ios

xcrun simctl io booted screenshot /tmp/voyager-ios/login.png
xcrun simctl io booted screenshot /tmp/voyager-ios/chats.png
xcrun simctl io booted screenshot /tmp/voyager-ios/thread.png
```

Open a screenshot:

```bash
open /tmp/voyager-ios/thread.png
```

**7. Verify CORS / API From CLI**
Preflight check:

```bash
curl -i -X OPTIONS http://127.0.0.1:8787/v1/auth/password/login \
  -H 'Origin: http://localhost:1420' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type, authorization'
```

Login check:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/auth/password/login \
  -H 'Origin: http://localhost:1420' \
  -H 'content-type: application/json' \
  --data '{"email":"ada@example.com","password":"voyager-demo-pass","device":{"platform":"ios","label":"CLI iOS test"}}'
```

**8. Verify iOS Device Registration**
```bash
cd /Users/admin/microgentic/app

npx wrangler d1 execute voyager-dev-control \
  --local \
  --persist-to .wrangler/local-state \
  --command "SELECT platform, device_label, client_version, protocol_version FROM devices WHERE platform = 'ios' ORDER BY created_at DESC LIMIT 3"
```

Expected shape:

```text
platform: ios
device_label: Mobile app · iOS
client_version: 0.1.0
protocol_version: opaque-test-1
```

**9. Optional: Use Xcode**
Open the generated project:

```bash
open /Users/admin/microgentic/app/apps/client/src-tauri/gen/apple/voyager.xcodeproj
```

In Xcode:

1. Select the `voyager_iOS` scheme.
2. Select `iPhone 17` as the run destination.
3. Press Run.

For normal development, the CLI path above is simpler and matches how I tested it.
