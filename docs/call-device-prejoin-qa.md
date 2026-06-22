# Call Device And Prejoin QA

Status: implementation checklist for browser, desktop, and mobile media permissions.
Date: 2026-06-22

## Capability Review

- Web builds require the static `Permissions-Policy` header to allow `microphone=(self)` and `camera=(self)`.
- Tauri desktop/mobile keeps `capabilities/default.json` limited to core window and opener permissions. Calls use the WebView/browser `navigator.mediaDevices` APIs, not a native Tauri command, so there is no additional Tauri command permission to grant for microphone or camera access.
- macOS/iOS require usage descriptions in generated plist files before the WebView can surface OS camera/microphone prompts.
- Android requires `android.permission.RECORD_AUDIO` and `android.permission.CAMERA` in the generated manifest before the WebView can surface OS camera/microphone prompts.
- Media still needs real-device verification because WebView permission UX differs by platform and OS version.

## Manual QA Checklist

- Start an audio call in a browser with microphone permission unset. Confirm the prejoin sheet opens first, the microphone picker is visible, and denying permission leaves the user out of the call with a visible error.
- Grant microphone permission, refresh devices, and confirm microphone labels appear when the browser exposes them.
- Start and join an audio call using a non-default microphone. Confirm the preference persists after reload and is selected the next time prejoin opens.
- In Chrome or another browser with `HTMLMediaElement.setSinkId`, choose a speaker/output device and confirm remote audio is routed there. Confirm unsupported platforms simply omit the speaker picker.
- Start a video call. Confirm camera is off by default, no camera prompt appears until the preview toggle or in-call camera button is used, and joining with camera off publishes audio only.
- Enable video preview before joining. Confirm a self preview appears, then confirm the call joins with local video enabled.
- Accept an incoming video call. Confirm the same prejoin flow appears before joining.
- While in a video call, switch microphone, speaker, and camera from the active call device panel.
- Background the app or browser tab during a video call. Confirm local camera publishing stops and the call can continue with audio.
- On Tauri desktop, verify macOS and Windows WebView permission prompts and denial recovery.
- On iOS and Android real devices, verify OS-level camera/microphone prompts, device labels where available, camera-off prejoin behavior, and background/screen-lock behavior.
