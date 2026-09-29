# Packet 3 Android emulator proof (shell-only fixture)

Date: 2026-09-27 America/Chicago. Device: `Medium_Phone_API_36.1`, Android emulator `emulator-5554`, 1080 × 2400 screenshot output. Expo Go opened the retained Expo SDK 57 shell. `npx expo-doctor` passed 17/17; Metro bundled `index.js` (714 modules) with `npx expo start --host lan --port 8081 --android`.

The real guide route was unavailable because the disposable Docker/pgvector service did not start. **These screenshots prove only the Expo shell against a local static fixture, not the Torchiko app route or chat.** The fixture was served with `node proof/fixture-server.cjs` at `127.0.0.1:4175` and mapped with `adb reverse tcp:4175 tcp:4175`. It exposes the same `close-requested` envelope as the guide, without any guide or backend code.

- `emulator-offline-retry.png`: the guide URL refused connection; the shell displayed a centered retry screen, retained native Close, and hid the WebView's raw error page.
- `emulator-native-close.png`: tapping native Close selected Home.
- `emulator-fixture.png`: the local fixture loaded in the Ask WebView with `header=none`.
- `emulator-message-close.png`: tapping the fixture's Request native close button posted `close-requested`, and the shell selected Home.
- `emulator-retained-webview.png`: after the fixture server was stopped, returning to Ask still showed the loaded fixture, proving that tab navigation retained the WebView.

`EXPO_PUBLIC_TORCHIKO_START_ASK` was not proved on a running guide. The temporary `.env.local` used for a reconnect attempt was removed. Neither the Swift nor Kotlin reference snippet was compiled: this Windows host has no `swiftc`, `kotlinc`, `gradle`, or Java executable on `PATH`. The Kotlin AndroidX WebView listener follows the [official AndroidX WebViewCompat API](https://developer.android.com/reference/androidx/webkit/WebViewCompat); partners must compile and device-test it in their own app.

`emulator-expo.png` and `emulator-start-ask.png` are intermediate diagnostics, not passing proof. The latter only shows that Expo Go could not reconnect to its CLI after the temporary environment change.
